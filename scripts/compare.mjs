// Full-page pixel diff between the original and the replica at several widths.
// The viewport is grown to the original's full height for both pages, so fixed
// sidebars, sticky headers and h-svh app shells line up without scrolling.
//
//   node compare.mjs --original URL --replica URL --out cmp [--widths 1440,1280,1024,800,390]
//        [--wait 3500] [--threshold 40] [--dark] [--prep "<js for both pages>"] [--replica-prep "<js>"]
//
// --prep runs on both pages after load. Use it to freeze what never settles, e.g. an
// infinite slider: --prep "document.head.insertAdjacentHTML('beforeend','<style>.marquee{transform:none!important}</style>')"
//
// Prints diff pixels per width plus the hottest 40px cells ("x,y:px"). Open
// cmp/diff-<w>.png (differences in red) and use png-tools.mjs pair to zoom a cell.
import { diffPngs, ensureDir, formatDiff, launch, need, openPage, parseArgs, path } from "./lib.mjs";

const args = parseArgs();
need(args, "original", "replica", "out");
const out = ensureDir(args.out);
const widths = String(args.widths ?? "1440,1280,1024,800,390").split(",").map(Number);
const wait = Number(args.wait ?? 3500);
const dark = !!args.dark;
const suffix = dark ? "-dark" : "";
const browser = await launch();

for (const width of widths) {
  const original = await openPage(browser, args.original, { width, fullHeight: true, wait, dark, prep: args.prep });
  const originalShot = path.join(out, `original-${width}${suffix}.png`);
  await original.page.screenshot({ path: originalShot });
  await original.page.close();

  const replicaPrep = [args.prep, args["replica-prep"]].filter(Boolean).join(";\n");
  const replica = await openPage(browser, args.replica, { width, fullHeight: original.height, wait, dark, prep: replicaPrep || undefined });
  const replicaHeight = await replica.page.evaluate(() => document.documentElement.scrollHeight);
  const replicaShot = path.join(out, `replica-${width}${suffix}.png`);
  await replica.page.screenshot({ path: replicaShot });
  await replica.page.close();

  const result = diffPngs(originalShot, replicaShot, path.join(out, `diff-${width}${suffix}.png`), { threshold: Number(args.threshold ?? 40) });
  console.log(formatDiff(`${width}px${suffix}`, result));
  if (replicaHeight !== original.height) console.log(`  note: document height original ${original.height} vs replica ${replicaHeight}`);
}
await browser.close();
