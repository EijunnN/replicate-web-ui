// Interaction matrix: runs the same actions on original and replica, screenshots both
// and diffs them. Also diffs each state against the untouched page, so a state that did
// nothing on either side (wrong coordinates, hover that never fired) is flagged instead
// of passing as a false "0 px".
//
//   node states.mjs --config states.config.mjs [--only sidebar] [--out states]
//
// The config is an ES module; copy states.example.mjs and edit it. States with
// `static: true` (dark mode, a viewport size) skip the "did the action do anything" check.
// `prep` (both pages) and `replicaPrep` run after load, e.g. to freeze an infinite slider.
import { pathToFileURL } from "node:url";
import { diffPngs, ensureDir, formatDiff, launch, need, openPage, parseArgs, path } from "./lib.mjs";

const args = parseArgs();
need(args, "config");
const config = (await import(pathToFileURL(path.resolve(args.config)).href)).default;
const out = ensureDir(args.out ?? config.out ?? "states");
const threshold = Number(config.threshold ?? 40);
const browser = await launch();

async function shoot(url, state, file, withAction, isReplica) {
  const viewport = state.viewport ?? config.viewport ?? { width: 1440, height: 900 };
  const { page } = await openPage(browser, url, {
    width: viewport.width,
    height: viewport.height,
    fullHeight: state.fullHeight ?? false,
    wait: config.wait ?? 3000,
    dark: !!state.dark,
    prep: [config.prep, isReplica ? config.replicaPrep : undefined].filter(Boolean).join(";") || undefined,
  });
  await page.mouse.move(state.restX ?? viewport.width / 2, state.restY ?? 5);
  if (withAction && state.run) await state.run(page);
  await page.screenshot({ path: file });
  await page.close();
}

let failures = 0;
for (const state of config.states) {
  if (args.only && !state.name.startsWith(args.only)) continue;
  const shots = {};
  for (const [side, url, isReplica] of [["original", config.original, false], ["replica", config.replica, true]]) {
    shots[side] = path.join(out, `${side}-${state.name}.png`);
    shots[`${side}Base`] = path.join(out, `${side}-${state.name}-base.png`);
    if (!state.static) await shoot(url, state, shots[`${side}Base`], false, isReplica);
    await shoot(url, state, shots[side], true, isReplica);
  }
  const result = diffPngs(shots.original, shots.replica, path.join(out, `diff-${state.name}.png`), { threshold });
  const originalEffect = state.static ? 0 : diffPngs(shots.originalBase, shots.original, null, { threshold }).count;
  const replicaEffect = state.static ? 0 : diffPngs(shots.replicaBase, shots.replica, null, { threshold }).count;
  let line = formatDiff(state.name, result);
  if (state.static) {
    // A static state (dark mode, a viewport) has nothing to trigger.
  } else if (!originalEffect && !replicaEffect) line += "  ⚠ action changed nothing on either page — check the action";
  else if (!originalEffect || !replicaEffect) line += `  ⚠ action only had an effect on the ${originalEffect ? "original" : "replica"}`;
  if (result.count) failures++;
  console.log(line);
}
await browser.close();
console.log(failures ? `${failures} state(s) differ` : "all states match");
