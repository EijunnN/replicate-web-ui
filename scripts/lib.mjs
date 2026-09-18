// Shared helpers for the replicate-web-ui scripts.
// Run every script from a workspace that has `playwright`, `pngjs` and `js-beautify`
// installed (see SKILL.md, "Workspace"); Node resolves imports next to the script file.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";

/** `--key value` / `--key=value` / `--flag` / repeated keys become arrays. Positional args land in `_`. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    // `--key=value` is the only way to pass a value that itself starts with "--"
    // (`--decl="--foreground:"`): as a separate token it would read as the next flag.
    const equals = token.indexOf("=");
    const key = equals > -1 ? token.slice(2, equals) : token.slice(2);
    const next = argv[i + 1];
    const value = equals > -1 ? token.slice(equals + 1) : next === undefined || next.startsWith("--") ? true : (i++, next);
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

/** `--only a,b`: a case runs when its name starts with any of the prefixes. */
export const matchesOnly = (only, name) =>
  !only || only === true || String(only).split(",").some((prefix) => name.startsWith(prefix.trim()));

/**
 * Key for something captured from the original. Everything that shapes the capture goes
 * in (URL, viewport, theme, prep, the action's source), so a changed input is a cache
 * miss, never a stale hit. The original does not change while you iterate on the replica.
 */
export const cacheKey = (parts) =>
  crypto
    .createHash("sha1")
    .update(JSON.stringify(parts, (_, value) => (typeof value === "function" ? value.toString() : value)))
    .digest("hex")
    .slice(0, 12);

/** Runs `tasks` (functions returning promises) `size` at a time, results in order. */
export async function pool(tasks, size) {
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(size, tasks.length)) }, async () => {
      while (cursor < tasks.length) {
        const index = cursor++;
        results[index] = await tasks[index]();
      }
    }),
  );
  return results;
}

/**
 * Ends a check: writes the result verify.mjs collects (`--json file`) and sets the exit
 * code, 0 when nothing differs and 1 when something does. A crash leaves no JSON behind,
 * which is how verify.mjs tells "differs" from "did not run".
 */
export function finish(args, result) {
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
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

/**
 * Shifts an element by `delta` px with margin, to match the original's phase. `anchor`
 * (a selector matched with closest()) moves an ancestor instead: when the original sits in
 * a bordered or clipped frame, that frame carries the fraction, and moving only the block
 * inside an integer-aligned frame still paints it one row off.
 */
export async function alignPhase(page, selector, index, targetPhase, anchor) {
  return page.evaluate(
    ([selector, index, targetPhase, anchor]) => {
      const el = document.querySelectorAll(selector)[index];
      if (!el) return null;
      const moved = (anchor && el.closest(anchor)) || el;
      const top = el.getBoundingClientRect().top;
      const delta = targetPhase - (top - Math.floor(top));
      const margin = Number.parseFloat(getComputedStyle(moved).marginTop) || 0;
      moved.style.marginTop = `${margin + delta}px`;
      const after = el.getBoundingClientRect().top;
      return after - Math.floor(after);
    },
    [selector, index, targetPhase, anchor ?? null],
  );
}

/**
 * Puts an element at the same document coordinates the original's element has. Matching
 * the sub-pixel phase is not always enough: Chromium rasterizes in tiles laid out from the
 * document origin, and an SVG image or a curve that falls on a different part of a tile
 * antialiases differently. A replica diffed against *itself* 396px lower showed 16 px over
 * the threshold and 420 faint ones, all on image edges. Same coordinates, same raster.
 * Moves `anchor` (closest ancestor) when given, with margin and `left`, never a transform.
 */
export async function alignPosition(page, selector, index, target, anchor) {
  return page.evaluate(
    ([selector, index, target, anchor]) => {
      const el = document.querySelectorAll(selector)[index];
      if (!el) return null;
      const moved = (anchor && el.closest(anchor)) || el;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(moved);
      if (style.position === "static") moved.style.position = "relative";
      moved.style.marginTop = `${(Number.parseFloat(style.marginTop) || 0) + target.y - (rect.y + window.scrollY)}px`;
      moved.style.left = `${(Number.parseFloat(style.left) || 0) + target.x - (rect.x + window.scrollX)}px`;
      const after = el.getBoundingClientRect();
      return { x: after.x + window.scrollX, y: after.y + window.scrollY };
    },
    [selector, index, target, anchor ?? null],
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
export async function openPage(browser, url, { width = 1440, height = 900, fullHeight = false, wait = 3500, dark = false, prep, still = true } = {}) {
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
  // `wait` covers animations that start late; this covers the ones that are still going. A
  // slow spring captured at a fixed delay made a page differ from itself by hundreds of pixels.
  // Something that never stops costs the 9s limit on every open: freeze it in `prep`.
  if (still) await settle(page);
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
/** Share of a cell's pixels that must differ faintly for the cell to count as a surface. */
const FAINT_DENSITY = 0.1;

export function diffPngs(fileA, fileB, outFile, { threshold = 40, cell = 40, strict = 4 } = {}) {
  const a = readPng(fileA);
  const b = readPng(fileB);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const out = new PNG({ width, height });
  const cells = new Map();
  const strictCells = new Map();
  let count = 0;
  let strictCount = 0;
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
      if (delta > strict) {
        strictCount++;
        const key = `${Math.floor(x / cell) * cell},${Math.floor(y / cell) * cell}`;
        strictCells.set(key, (strictCells.get(key) ?? 0) + 1);
      }
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
  const hottest = (map) =>
    [...map.entries()]
      .sort((p, q) => q[1] - p[1])
      .slice(0, 12)
      .map(([key, px]) => `${key}:${px}`);
  const hotCells = hottest(cells);
  return {
    count,
    // Same screenshots at a threshold of `strict`: a 0.985 vs 1.0 surface, a hover fill or
    // a soft glow sits under the default threshold and passes at "0 px" while missing.
    strictCount,
    strictCells: hottest(strictCells),
    // Faint pixels come in two kinds. Edge antialiasing is sparse: a few pixels along a curve
    // or a glyph, a handful per cell. A surface, a gradient or a glow is dense: it fills the
    // cells it touches. Only dense cells fail a diff; a thin faint line (a border a few levels
    // off) is sparse too, and that one is computed-diff's to catch, not the pixels'.
    denseCells: hottest(new Map([...strictCells].filter(([, px]) => px >= cell * cell * FAINT_DENSITY))),
    width,
    height,
    sizeMismatch: a.width !== b.width || a.height !== b.height ? `${a.width}x${a.height} vs ${b.width}x${b.height}` : null,
    hotCells,
  };
}

/** A diff passes when nothing crosses the threshold, no cell is densely faint, and the sizes match. */
export const diffOk = (result) => !result.count && !result.denseCells.length && !result.sizeMismatch;

export function formatDiff(label, result) {
  const size = result.sizeMismatch ? `  SIZE ${result.sizeMismatch}` : "";
  const cells = result.count
    ? `  hot cells (x,y:px) ${result.hotCells.join(" ")}`
    : result.denseCells.length
      ? `  DENSE faint cells (x,y:px) ${result.denseCells.slice(0, 6).join(" ")}`
      : result.strictCount
        ? `  sparse (edge antialiasing), densest ${result.strictCells[0]}`
        : "";
  return `${label.padEnd(24)} diff px ${String(result.count).padStart(7)}  faint ${String(result.strictCount ?? 0).padStart(6)}${size}${cells}`;
}

export const slug = (text) => text.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

export { fs, path };
