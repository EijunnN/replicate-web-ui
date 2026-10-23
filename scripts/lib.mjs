// Shared helpers for the replicate-web-ui scripts.
// Run every script from a workspace that has `playwright`, `pngjs` and `js-beautify`
// installed (see SKILL.md, "Workspace"); Node resolves imports next to the script file.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
    .update(JSON.stringify([parts, clockSetting()], (_, value) => (typeof value === "function" ? value.toString() : value)))
    .digest("hex")
    .slice(0, 12);

/**
 * The page clock. Every page gets a `Date` that starts at the same fixed instant when its
 * document starts and runs at real speed from there, so whatever the page prints from the
 * clock ("9:41 AM", "2 min ago", today's date) is the same on both sides instead of differing
 * by the minutes between a cached original and a fresh replica. Only `Date` changes: timers,
 * requestAnimationFrame and performance.now stay real, so animations run as a visitor sees
 * them. The start sits on a whole minute, which gives a page a minute before a printed "h:mm"
 * can tick. `clock: "<ISO instant>"` in the config (or REPLICA_CLOCK) picks another start;
 * `clock: false` (REPLICA_CLOCK=off) keeps the real clock, for a page that reads the time
 * from its server and would otherwise disagree with itself.
 */
export const DEFAULT_CLOCK = "2026-01-15T09:41:00Z";
export const clockSetting = () => process.env.REPLICA_CLOCK || DEFAULT_CLOCK;

function installClock(start) {
  const Real = Date;
  const realNow = Real.now.bind(Real);
  const offset = start - realNow();
  const now = () => realNow() + offset;
  globalThis.Date = new Proxy(Real, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [now()], newTarget === globalThis.Date ? target : newTarget),
    apply: () => new Real(now()).toString(),
    get: (target, key) => (key === "now" ? now : Reflect.get(target, key)),
  });
}

/** Imports a replica config and applies the settings that live outside any one script (the clock). */
export async function loadConfig(file) {
  const config = (await import(pathToFileURL(path.resolve(file)).href)).default;
  if (config.clock !== undefined) process.env.REPLICA_CLOCK = config.clock === false ? "off" : String(config.clock);
  return config;
}

/**
 * Nodes a framework puts in the page by itself, with no counterpart in a replica of one
 * component: `framework: "next"` in the config adds them to `ignoreElements`. Only selectors
 * seen on a real site are here; add a framework when you have verified its nodes.
 */
export const FRAMEWORK_NODES = {
  // Seen on pro.beui.dev (Next.js 15+, 2026-10-23): the route announcer, the dev overlay's
  // host, and React's hidden streaming containers left at the end of <body>.
  next: "next-route-announcer, nextjs-portal, body > div[hidden]",
};

export function ignoredElements(config) {
  const presets = list(config.framework).map((name) => {
    if (!FRAMEWORK_NODES[name]) throw new Error(`framework "${name}" has no node list (known: ${Object.keys(FRAMEWORK_NODES).join(", ")})`);
    return FRAMEWORK_NODES[name];
  });
  return [config.ignoreElements, ...presets].filter(Boolean).join(", ") || undefined;
}

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
    const browser = await chromium.launch();
    const clock = clockSetting();
    if (clock !== "off") {
      const start = Date.parse(clock);
      if (Number.isNaN(start)) throw new Error(`clock "${clock}" is not a date: use an ISO instant or false`);
      // Every page any script opens goes through here, so no script can forget the clock.
      const newPage = browser.newPage.bind(browser);
      browser.newPage = async (options) => {
        const page = await newPage(options);
        await page.addInitScript(installClock, start);
        return page;
      };
    }
    return browser;
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

/** Requests that can change what the page paints, from any origin. */
const RENDERING = new Set(["document", "stylesheet", "script", "image", "font", "media"]);

/**
 * Navigates and waits until the network is idle (nothing in flight for 500ms), retrying once on
 * a network error (a local server that reset or refused a connection under load). A page that
 * loads and differs is never retried: only the transport.
 * Idle has one exception: a cross-origin request that cannot paint (a fetch, a beacon, a ping)
 * and has been in flight for 5s. pro.beui.dev's analytics (collect.tracwell.app) left such
 * requests open forever, and Playwright's own `networkidle` then passed or timed out by luck.
 * Everything same-origin, and every stylesheet, script, image and font from anywhere, still counts.
 */
export async function goto(page, url) {
  const inflight = new Map();
  const onRequest = (request) => inflight.set(request, Date.now());
  const onDone = (request) => inflight.delete(request);
  page.on("request", onRequest);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);
  try {
    try {
      await page.goto(url, { waitUntil: "load", timeout: 120000 });
    } catch (error) {
      if (!/net::ERR_(CONNECTION_(RESET|REFUSED|CLOSED|ABORTED)|EMPTY_RESPONSE)/.test(String(error))) throw error;
      await sleep(1500);
      inflight.clear();
      await page.goto(url, { waitUntil: "load", timeout: 120000 });
    }
    const origin = new URL(page.url()).origin;
    const stuckBeacon = (request, since) =>
      !RENDERING.has(request.resourceType()) && new URL(request.url()).origin !== origin && Date.now() - since > 5000;
    const deadline = Date.now() + 120000;
    let quietSince = null;
    for (;;) {
      const busy = [...inflight].filter(([request, since]) => !stuckBeacon(request, since));
      if (busy.length) quietSince = null;
      else if ((quietSince ??= Date.now()) <= Date.now() - 500) break;
      if (Date.now() > deadline) throw new Error(`${url}: the network never went idle; still loading ${busy.slice(0, 5).map(([request]) => request.url()).join(", ")}`);
      await sleep(50);
    }
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onDone);
    page.off("requestfailed", onDone);
  }
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
  // Uncaught exceptions and console errors, so a replica that renders blank or half-mounted
  // says why instead of diffing as one big red block.
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${String(error.message ?? error).slice(0, 300)}`));
  page.on("console", (message) => message.type() === "error" && errors.push(`console: ${message.text().slice(0, 300)}`));
  await goto(page, url);
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
  return { page, height: pageHeight, errors };
}

/**
 * The same equivalence for a declared value everywhere a check compares one verbatim: Chrome
 * spaces a value differently per page, and builds print the same number differently (`.2` and
 * `0.2`, `150ms` and `.15s`, `calc(2.25 / 1.875)` folded into `1.2` by one minifier only).
 */
export const canonicalValue = (value) =>
  (value ?? "")
    .replace(/\s+/g, "")
    .replace(/calc\(([\d.]+)\/([\d.]+)\)/g, (_, a, b) => String(Number((a / b).toFixed(4))))
    .replace(/(\d*\.?\d+)ms\b/g, (_, ms) => `${Number((ms / 1000).toFixed(4))}s`)
    .replace(/(^|[^\d.])0+(?=\.\d)/g, "$1");

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
