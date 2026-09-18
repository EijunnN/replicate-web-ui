// Shared helpers for the replicate-web-ui scripts.
// Run every script from a workspace that has `playwright`, `pngjs` and `js-beautify`
// installed (see SKILL.md, "Workspace"); Node resolves imports next to the script file.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";

/** `--key value` / `--flag` / repeated keys become arrays. Positional args land in `_`. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith("--") ? true : (i++, next);
    if (key in out) out[key] = [].concat(out[key], value);
    else out[key] = value;
  }
  return out;
}

export const list = (value) => (value === undefined ? [] : [].concat(value));

export function need(args, ...keys) {
  const missing = keys.filter((key) => args[key] === undefined);
  if (missing.length) {
    console.error(`Missing --${missing.join(", --")}`);
    process.exit(1);
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function launch() {
  try {
    return await chromium.launch();
  } catch (error) {
    if (String(error).includes("Executable doesn't exist")) {
      console.error(
        "Playwright's browser build is missing. Run `PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install chromium`\n" +
          "(without the variable, install deletes browser builds other projects still use), or install the\n" +
          "playwright version that matches a folder already in ms-playwright (chromium-1181 ↔ 1.54, 1200 ↔ 1.57).",
      );
    }
    throw error;
  }
}

/**
 * Waits until the page stops moving instead of sleeping a fixed amount: entry springs,
 * fonts and late images all settle here, and a page that is already still returns in a
 * frame or two. `scope` narrows the sampling to the region that matters.
 */
export async function settle(page, { quiet = 300, limit = 9000, scope = "body" } = {}) {
  await page.evaluate(
    async ([quiet, limit, scope]) => {
      await document.fonts?.ready;
      const sample = () =>
        [...document.querySelectorAll(`${scope}, ${scope} *`)]
          .slice(0, 400)
          .map((el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)},${cs.opacity},${cs.filter},${cs.transform}`;
          })
          .join("|");
      const start = performance.now();
      let last = sample();
      let stableSince = performance.now();
      while (performance.now() - stableSince < quiet && performance.now() - start < limit) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = sample();
        if (now !== last) {
          last = now;
          stableSince = performance.now();
        }
      }
    },
    [quiet, limit, scope],
  );
}

/** Forces light on a page whose theme is a class on <html>: `dark: false` is not enough. */
export async function setLight(page, lightClass = "light", darkClass = "dark") {
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(
    ([light, dark]) => {
      const html = document.documentElement;
      html.classList.remove(dark);
      html.classList.add(light);
      html.style.colorScheme = "light";
    },
    [lightClass, darkClass],
  );
}

/**
 * Hides the host page's fixed and sticky chrome. An element screenshot captures whatever
 * is painted over the element, so a site's floating navbar lands on top of the component
 * you are comparing and every diff starts with a red band.
 */
export async function hidePageChrome(page, keepInside) {
  await page.evaluate((keepInside) => {
    for (const el of document.querySelectorAll("body *")) {
      const position = getComputedStyle(el).position;
      if (position !== "fixed" && position !== "sticky") continue;
      if (keepInside && el.closest(keepInside)) continue;
      el.style.visibility = "hidden";
    }
  }, keepInside ?? null);
}

/**
 * Reads the sub-pixel phase of an element: where its top edge sits between two device
 * pixels. Two pages place the same component at different fractions, and half a pixel of
 * phase re-rasterizes every glyph and curve inside it.
 */
export const phaseOf = (box) => box.y - Math.floor(box.y);

/** Shifts an element by `delta` px with margin, to match the original's phase. */
export async function alignPhase(page, selector, index, targetPhase) {
  return page.evaluate(
    ([selector, index, targetPhase]) => {
      const el = document.querySelectorAll(selector)[index];
      if (!el) return null;
      const top = el.getBoundingClientRect().top;
      const delta = targetPhase - (top - Math.floor(top));
      const margin = Number.parseFloat(getComputedStyle(el).marginTop) || 0;
      el.style.marginTop = `${margin + delta}px`;
      const after = el.getBoundingClientRect().top;
      return after - Math.floor(after);
    },
    [selector, index, targetPhase],
  );
}

/** Dev-only overlays that would pollute screenshots of a local replica. */
const DEV_OVERLAYS = ["nextjs-portal", "vite-error-overlay", "astro-dev-toolbar", "#webpack-dev-server-client-overlay"];

export async function removeDevOverlays(page) {
  await page.evaluate((selectors) => {
    for (const selector of selectors) document.querySelectorAll(selector).forEach((node) => node.remove());
  }, DEV_OVERLAYS);
}

/** Forces a class-based dark theme and the dark media query at the same time. */
export async function setDark(page, darkClass = "dark", lightClass = "light") {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(
    ([dark, light]) => {
      const html = document.documentElement;
      html.classList.remove(light);
      html.classList.add(dark);
      html.style.colorScheme = "dark";
    },
    [darkClass, lightClass],
  );
}

/**
 * Opens `url` at `width`, optionally grows the viewport to the page's full height so
 * nothing scrolls (fixed sidebars, sticky headers and h-svh shells then line up
 * between original and replica), and waits for entry animations to finish.
 */
export async function openPage(browser, url, { width = 1440, height = 900, fullHeight = false, wait = 3500, dark = false, prep } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
  if (dark) await setDark(page);
  await removeDevOverlays(page);
  if (prep) await page.evaluate(prep);
  let pageHeight = height;
  if (fullHeight) {
    pageHeight = typeof fullHeight === "number" ? fullHeight : await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width, height: pageHeight });
  }
  await sleep(wait);
  await removeDevOverlays(page);
  return { page, height: pageHeight };
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const readPng = (file) => PNG.sync.read(fs.readFileSync(file));

/**
 * Counts pixels whose strongest channel differs by more than `threshold` (0–255),
 * buckets them into `cell`-sized squares and writes a dimmed image with the
 * differences in red. Antialiasing noise stays under the default threshold.
 */
export function diffPngs(fileA, fileB, outFile, { threshold = 40, cell = 40 } = {}) {
  const a = readPng(fileA);
  const b = readPng(fileB);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const out = new PNG({ width, height });
  const cells = new Map();
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ia = (a.width * y + x) << 2;
      const ib = (b.width * y + x) << 2;
      const io = (width * y + x) << 2;
      const delta = Math.max(
        Math.abs(a.data[ia] - b.data[ib]),
        Math.abs(a.data[ia + 1] - b.data[ib + 1]),
        Math.abs(a.data[ia + 2] - b.data[ib + 2]),
      );
      if (delta > threshold) {
        count++;
        const key = `${Math.floor(x / cell) * cell},${Math.floor(y / cell) * cell}`;
        cells.set(key, (cells.get(key) ?? 0) + 1);
        out.data[io] = 255;
        out.data[io + 1] = 0;
        out.data[io + 2] = 0;
      } else {
        const gray = (a.data[ia] + a.data[ia + 1] + a.data[ia + 2]) / 3;
        out.data[io] = out.data[io + 1] = out.data[io + 2] = 200 + gray * 0.2;
      }
      out.data[io + 3] = 255;
    }
  }
  if (outFile) fs.writeFileSync(outFile, PNG.sync.write(out));
  const hotCells = [...cells.entries()]
    .sort((p, q) => q[1] - p[1])
    .slice(0, 12)
    .map(([key, px]) => `${key}:${px}`);
  return {
    count,
    width,
    height,
    sizeMismatch: a.width !== b.width || a.height !== b.height ? `${a.width}x${a.height} vs ${b.width}x${b.height}` : null,
    hotCells,
  };
}

export function formatDiff(label, result) {
  const size = result.sizeMismatch ? `  SIZE ${result.sizeMismatch}` : "";
  const cells = result.count ? `  hot cells (x,y:px) ${result.hotCells.join(" ")}` : "";
  return `${label.padEnd(24)} diff px ${String(result.count).padStart(7)}${size}${cells}`;
}

export const slug = (text) => text.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

export { fs, path };
