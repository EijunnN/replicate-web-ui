// Interaction matrix: runs the same actions on original and replica, screenshots both
// and diffs them. Also diffs each state against the untouched page, so a state that did
// nothing on either side (wrong coordinates, hover that never fired) is flagged instead
// of passing as a false "0 px".
//
//   node states.mjs --config replica.config.mjs [--only sidebar,search] [--out states]
//        [--jobs 4] [--refresh] [--json result.json]
//
// The config is an ES module; copy replica.config.example.mjs and edit it. States with
// `static: true` (dark mode, a viewport size) skip the "did the action do anything" check;
// a state whose action legitimately changes nothing says so with `noEffect: true`, after
// you confirmed it by reading the computed value. `prep` (both pages), `replicaPrep` and a
// per-state `prep` run after load, e.g. to freeze an infinite slider or to force the light
// theme on a page whose default is dark.
//
// Built to be rerun after every fix: the original's screenshots are cached in <out>/cache
// (`--refresh` to redo) and states run `--jobs` at a time. Exit code 1 when a state
// differs or an action had no visible effect.
import { pathToFileURL } from "node:url";
import { cacheKey, diffOk, diffPngs, ensureDir, finish, formatDiff, fs, launch, matchesOnly, need, openPage, parseArgs, path, pool, settle } from "./lib.mjs";

const args = parseArgs();
need(args, "config");
const config = (await import(pathToFileURL(path.resolve(args.config)).href)).default;
const out = ensureDir(args.out ?? path.join(config.out ?? ".", "states"));
const cacheDir = ensureDir(path.join(out, "cache"));
const threshold = Number(config.threshold ?? 40);
const jobs = Number(args.jobs ?? config.jobs ?? 4);
const browser = await launch();

const viewportOf = (state) => state.viewport ?? config.viewport ?? { width: 1440, height: 900 };

async function shoot(url, state, file, withAction, isReplica) {
  const viewport = viewportOf(state);
  const { page } = await openPage(browser, url, {
    width: viewport.width,
    height: viewport.height,
    fullHeight: state.fullHeight ?? false,
    wait: config.wait ?? 3000,
    dark: !!state.dark,
    prep: [config.prep, state.prep, isReplica ? config.replicaPrep : undefined].filter(Boolean).join(";") || undefined,
  });
  await page.mouse.move(state.restX ?? viewport.width / 2, state.restY ?? 5);
  if (withAction && state.run) await state.run(page);
  if (config.settle !== false) await settle(page);
  await page.screenshot({ path: file });
  await page.close();
}

/** The original's two screenshots of a state, from the cache when nothing about it changed. */
async function originalShots(state, shots) {
  const key = cacheKey({ url: config.original, state, viewport: viewportOf(state), wait: config.wait ?? 3000, prep: config.prep ?? "" });
  const cached = { shot: path.join(cacheDir, `${key}.png`), base: path.join(cacheDir, `${key}-base.png`) };
  const complete = fs.existsSync(cached.shot) && (state.static || fs.existsSync(cached.base));
  if (!args.refresh && complete) {
    fs.copyFileSync(cached.shot, shots.original);
    if (!state.static) fs.copyFileSync(cached.base, shots.originalBase);
    return true;
  }
  if (!state.static) await shoot(config.original, state, shots.originalBase, false, false);
  await shoot(config.original, state, shots.original, true, false);
  fs.copyFileSync(shots.original, cached.shot);
  if (!state.static) fs.copyFileSync(shots.originalBase, cached.base);
  return false;
}

async function runState(state) {
  const shots = {};
  for (const side of ["original", "replica"]) {
    shots[side] = path.join(out, `${side}-${state.name}.png`);
    shots[`${side}Base`] = path.join(out, `${side}-${state.name}-base.png`);
  }
  const fromCache = await originalShots(state, shots);
  if (!state.static) await shoot(config.replica, state, shots.replicaBase, false, true);
  await shoot(config.replica, state, shots.replica, true, true);

  const diffFile = path.join(out, `diff-${state.name}.png`);
  const result = diffPngs(shots.original, shots.replica, diffFile, { threshold });
  const originalEffect = state.static ? 0 : diffPngs(shots.originalBase, shots.original, null, { threshold }).count;
  const replicaEffect = state.static ? 0 : diffPngs(shots.replicaBase, shots.replica, null, { threshold }).count;
  let warning;
  if (state.static || state.noEffect) {
    // A static state (dark mode, a viewport) has nothing to trigger; `noEffect` is an
    // action you already confirmed changes nothing.
  } else if (!originalEffect && !replicaEffect) warning = "action changed nothing on either page — check the action";
  else if (!originalEffect || !replicaEffect) warning = `action only had an effect on the ${originalEffect ? "original" : "replica"}`;
  return { state, result, warning, diffFile, fromCache };
}

const selected = config.states.filter((state) => matchesOnly(args.only, state.name));
const results = await pool(selected.map((state) => () => runState(state)), jobs);
await browser.close();

const items = results.map(({ state, result, warning, diffFile }) => {
  console.log(`${formatDiff(state.name, result)}${warning ? `  ⚠ ${warning}` : ""}`);
  return {
    name: state.name,
    ok: diffOk(result) && !warning,
    count: result.count,
    faint: result.strictCount,
    note: [result.sizeMismatch && `size ${result.sizeMismatch}`, warning].filter(Boolean).join("; ") || undefined,
    cells: (result.count ? result.hotCells : result.denseCells).slice(0, 4),
    sparse: result.count || result.denseCells.length ? undefined : result.strictCount,
    diff: diffFile,
  };
});
const failures = items.filter((item) => !item.ok).length;
console.log(`original: ${results.filter((r) => r.fromCache).length}/${results.length} from cache`);
console.log(failures ? `${failures} state(s) differ` : "all states match");
finish(args, { check: "states", ok: !failures, items });
