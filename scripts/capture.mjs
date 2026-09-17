// Recon pass: full-page screenshot, every script/stylesheet/document the page loads,
// the rendered DOM, and a quick fingerprint of the stack.
//
//   node capture.mjs --url https://example.com/page --out capture [--width 1440] [--wait 3500]
import { diffPngs, ensureDir, fs, launch, need, openPage, parseArgs, path, sleep } from "./lib.mjs";

const args = parseArgs();
need(args, "url", "out");
const out = ensureDir(args.out);
const width = Number(args.width ?? 1440);
const wait = Number(args.wait ?? 3500);

const browser = await launch();
const page = await browser.newPage({ viewport: { width, height: 900 } });
const resources = [];
const pending = [];
page.on("response", (response) => {
  const type = response.request().resourceType();
  if (!["script", "stylesheet", "document", "fetch", "xhr"].includes(type)) return;
  pending.push(
    response
      .body()
      .then((body) => {
        const url = response.url();
        const base = path.basename(new URL(url).pathname).slice(0, 80).replace(/[^\w.-]/g, "_") || "index";
        const name = `${String(resources.length).padStart(3, "0")}-${type}-${base}`;
        fs.writeFileSync(path.join(out, name), body);
        const text = type === "script" || type === "stylesheet" ? body.toString("utf8") : "";
        const sourceMap = (text.match(/[#@] sourceMappingURL=([^\s*]+)/) ?? [])[1] ?? null;
        resources.push({ type, url, file: name, bytes: body.length, sourceMap });
      })
      .catch(() => {}),
  );
});

await page.goto(args.url, { waitUntil: "networkidle", timeout: 120000 });
const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
await page.setViewportSize({ width, height: fullHeight });
await sleep(wait);
await page.screenshot({ path: path.join(out, `shot-${width}.png`) });

// Charts and entry animations often need longer than networkidle; a second shot shows whether it settled.
await sleep(1500);
await page.screenshot({ path: path.join(out, `shot-${width}-later.png`) });
const settle = diffPngs(path.join(out, `shot-${width}.png`), path.join(out, `shot-${width}-later.png`), null);

fs.writeFileSync(path.join(out, "dom.html"), await page.content());
const stack = await page.evaluate(() => {
  const w = window;
  const html = document.documentElement;
  return {
    title: document.title,
    htmlClass: html.className,
    htmlStyle: html.getAttribute("style"),
    bodyClass: document.body.className,
    bodyFont: getComputedStyle(document.body).fontFamily,
    fontFeatureSettings: getComputedStyle(document.body).fontFeatureSettings,
    fontsLoaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => `${f.family} ${f.weight}`),
    bundler: {
      turbopack: Array.isArray(w.TURBOPACK) || !!document.querySelector('script[src*="turbopack"]'),
      webpackChunks: Object.keys(w).filter((key) => key.startsWith("webpackChunk")),
      viteModules: !!document.querySelector('script[type="module"][src*="/assets/"]'),
    },
    framework: {
      next: !!w.next || !!document.getElementById("__NEXT_DATA__") || !!w.__next_f,
      reactServerComponents: !!w.__next_f,
      nuxt: !!w.__NUXT__,
      svelteKit: !!document.querySelector("[data-sveltekit-preload-data]"),
    },
    hints: {
      radix: !!document.querySelector("[data-radix-collection-item], [data-radix-popper-content-wrapper], [data-state]"),
      shadcnSlots: [...new Set([...document.querySelectorAll("[data-slot]")].map((n) => n.getAttribute("data-slot")))].slice(0, 60),
      designSystemClasses: [...new Set([...document.querySelectorAll("[class*='cn-']")].flatMap((n) => [...n.classList].filter((c) => c.startsWith("cn-"))))].slice(0, 40),
      lucideIcons: document.querySelectorAll("svg.lucide").length,
      recharts: !!document.querySelector(".recharts-wrapper"),
      cmdk: !!document.querySelector("[cmdk-root]"),
      visx: !!document.querySelector(".visx-group"),
    },
    iframes: [...document.querySelectorAll("iframe")].map((f) => f.src),
    fullHeight: document.documentElement.scrollHeight,
  };
});
await Promise.all(pending);
await browser.close();

resources.sort((a, b) => a.file.localeCompare(b.file));
fs.writeFileSync(path.join(out, "resources.json"), JSON.stringify(resources, null, 2));
fs.writeFileSync(path.join(out, "stack.json"), JSON.stringify(stack, null, 2));

console.log(`screenshot  ${path.join(out, `shot-${width}.png`)} (${width}x${fullHeight})`);
console.log(`settled     ${settle.count === 0 ? "yes" : `NO — ${settle.count}px still changing after +1.5s, wait longer before comparing`}`);
console.log(`resources   ${resources.length} (${resources.filter((r) => r.type === "script").length} scripts, ${resources.filter((r) => r.type === "stylesheet").length} stylesheets)`);
const maps = resources.filter((r) => r.sourceMap);
if (maps.length) console.log(`sourcemaps  ${maps.length} files reference one — try fetching them before reading minified code`);
console.log(`stack       ${JSON.stringify({ bundler: stack.bundler, framework: stack.framework })}`);
console.log(`hints       ${JSON.stringify(stack.hints)}`);
