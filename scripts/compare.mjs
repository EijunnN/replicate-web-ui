// Full-page pixel diff between the original and the replica at several widths.
// The viewport is grown to the original's full height for both pages, so fixed
// sidebars, sticky headers and h-svh app shells line up without scrolling.
//
//   node compare.mjs --original URL --replica URL --out cmp [--widths 1440,1280,1024,800,390]
//        [--wait 3500] [--threshold 40] [--dark] [--prep "<js for both pages>"] [--replica-prep "<js>"]
//        [--refresh] [--json result.json]
//
// --prep runs on both pages after load. Use it to freeze what never settles, e.g. an
// infinite slider: --prep "document.head.insertAdjacentHTML('beforeend','<style>.marquee{transform:none!important}</style>')"
//
// The original's screenshots are cached in <out>/cache and reused until `--refresh`.
// Prints diff pixels per width plus the hottest 40px cells ("x,y:px"), and "faint": the
// same screenshots at a threshold of 4, which is where a near-white surface or a missing
// glow shows up. Open cmp/diff-<w>.png (differences in red) and use png-tools.mjs pair to
// zoom a cell. Exit code 1 when any width differs.
import { cacheKey, diffOk, diffPngs, ensureDir, finish, formatDiff, fs, launch, need, openPage, parseArgs, path } from "./lib.mjs";

const args = parseArgs();
need(args, "original", "replica", "out");
const out = ensureDir(args.out);
const cacheDir = ensureDir(path.join(out, "cache"));
const widths = String(args.widths ?? "1440,1280,1024,800,390").split(",").map(Number);
const wait = Number(args.wait ?? 3500);
const dark = !!args.dark;
const suffix = dark ? "-dark" : "";
const browser = await launch();
const items = [];

for (const width of widths) {
  const originalShot = path.join(out, `original-${width}${suffix}.png`);
  const key = cacheKey({ url: args.original, width, dark, wait, prep: args.prep ?? "" });
  const cachedShot = path.join(cacheDir, `${key}.png`);
  const cachedMeta = path.join(cacheDir, `${key}.json`);
  let originalHeight;
  if (!args.refresh && fs.existsSync(cachedShot) && fs.existsSync(cachedMeta)) {
    fs.copyFileSync(cachedShot, originalShot);
    originalHeight = JSON.parse(fs.readFileSync(cachedMeta, "utf8")).height;
  } else {
    const original = await openPage(browser, args.original, { width, fullHeight: true, wait, dark, prep: args.prep });
    await original.page.screenshot({ path: originalShot });
    await original.page.close();
    originalHeight = original.height;
    fs.copyFileSync(originalShot, cachedShot);
    fs.writeFileSync(cachedMeta, JSON.stringify({ height: originalHeight }));
  }

  const replicaPrep = [args.prep, args["replica-prep"]].filter(Boolean).join(";\n");
  const replica = await openPage(browser, args.replica, { width, fullHeight: originalHeight, wait, dark, prep: replicaPrep || undefined });
  const replicaHeight = await replica.page.evaluate(() => document.documentElement.scrollHeight);
  const replicaShot = path.join(out, `replica-${width}${suffix}.png`);
  await replica.page.screenshot({ path: replicaShot });
  await replica.page.close();

  const diffFile = path.join(out, `diff-${width}${suffix}.png`);
  const result = diffPngs(originalShot, replicaShot, diffFile, { threshold: Number(args.threshold ?? 40) });
  console.log(formatDiff(`${width}px${suffix}`, result));
  const heightNote = replicaHeight !== originalHeight ? `document height original ${originalHeight} vs replica ${replicaHeight}` : null;
  if (heightNote) console.log(`  note: ${heightNote}`);
  items.push({
    name: `${width}${suffix}`,
    ok: diffOk(result) && !heightNote,
    count: result.count,
    faint: result.strictCount,
    note: [result.sizeMismatch && `size ${result.sizeMismatch}`, heightNote].filter(Boolean).join("; ") || undefined,
    cells: (result.count ? result.hotCells : result.denseCells).slice(0, 4),
    sparse: result.count || result.denseCells.length ? undefined : result.strictCount,
    diff: diffFile,
  });
}
await browser.close();
finish(args, { check: dark ? "compare-dark" : "compare", ok: items.every((item) => item.ok), items });
