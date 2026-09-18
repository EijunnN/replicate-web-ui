// Pixel diff of one element on each page, for a component that lives inside a larger
// page (a component gallery, a docs preview) where the two pages around it differ.
// Screenshots the element itself, so only its own box is compared, and reports a size
// mismatch instead of diffing boxes of different sizes.
//
//   node element-diff.mjs --config replica.config.mjs [--only menu,panel] [--refresh] [--jobs 4] [--json result.json]
//
// It is built to be rerun after every fix, so it is fast by design:
//   - the original's screenshots are cached in `cache/` and reused (`--refresh` to redo);
//   - cases run in parallel (`--jobs`, default 4);
//   - cases that only look (no `run`) share one page per theme and viewport;
//   - the wait is adaptive: it captures as soon as nothing has moved for 300ms.
// A rerun that only changed the replica costs about half of the first pass.
//
// The cases live under `elements` in replica.config.mjs (its fields override the top-level
// ones); a config with top-level `cases` works too. A case with a `run` is also shot
// before the action when its element already exists: an action that changed nothing on
// either page is flagged instead of passing as "0 px" (`noEffect: true` to acknowledge).
// Exit code 1 when a case differs.
//
// Config: { original, replica, selector, out, threshold, viewport, wait, dark, prep,
//           replicaPrep, alignPhase = true, alignPosition = true, phaseAnchor, hideChrome = true,
//           matchWidth, widthAnchor, replicaSelector, replicaIndex,
//           scope, cases: [{ name, selector?, index?, replicaSelector?, replicaIndex?, dark?, viewport?, prep?, run(page) }] }
//
// `matchWidth: true` caps the replica's wrapper at the width the original's element has
// at that viewport, which is what makes a full-width section comparable with the same
// section inside a narrower documentation column. `widthAnchor` picks the element to cap
// (default: the target's parent).
//
// Pick selectors that hug their content (a row of triggers, a menu panel, a section):
// their size then does not depend on the page around them. What the element's own box
// leaves out still has to be checked another way — an arrow that sits outside the panel,
// and the panel's position relative to its trigger: measure both boxes on each page and
// compare the offset between them, not the absolute coordinates.
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import {
  alignPhase,
  alignPosition,
  diffOk,
  diffPngs,
  ensureDir,
  finish,
  formatDiff,
  fs,
  hidePageChrome,
  launch,
  matchesOnly,
  need,
  parseArgs,
  path,
  phaseOf,
  readPng,
  setDark,
  setLight,
  settle,
} from "./lib.mjs";

const args = parseArgs();
need(args, "config");
const raw = (await import(pathToFileURL(path.resolve(args.config)).href)).default;
const config = { ...raw, ...(raw.elements ?? {}) };
const out = ensureDir(args.out ?? (raw.elements ? path.join(raw.out ?? ".", "elements") : config.out ?? "elements"));
const cacheDir = ensureDir(path.join(out, "cache"));
const threshold = Number(args.threshold ?? config.threshold ?? 40);
const jobs = Number(args.jobs ?? config.jobs ?? 4);
const wantsPhase = config.alignPhase !== false;
const hideChrome = config.hideChrome !== false;

/** Byte-level "did anything change": same size and no pixel over the faint threshold. */
const sameImage = (fileA, fileB) => {
  const result = diffPngs(fileA, fileB, null, { threshold });
  return !result.sizeMismatch && !result.strictCount;
};

// The same element can need another selector or another index on the replica's page (a
// block that is second on a gallery page and alone on its own route): `replicaSelector` and
// `replicaIndex`, on the config or on a case. The original is captured first, then the replica.
let side = "original";
const replicaOnly = (value) => (side === "replica" ? value : undefined);
const selectorOf = (testCase) =>
  replicaOnly(testCase.replicaSelector) ?? testCase.selector ?? replicaOnly(config.replicaSelector) ?? config.selector;
const indexOf = (testCase) => replicaOnly(testCase.replicaIndex ?? config.replicaIndex) ?? testCase.index ?? 0;
const blockSelector = () => (side === "replica" ? config.replicaSelector : undefined) ?? config.selector;
const viewportOf = (testCase) => testCase.viewport ?? config.viewport ?? { width: 1440, height: 900 };
const themeOf = (testCase) => (testCase.dark ?? config.dark ? "dark" : "light");

const cacheKey = (testCase) =>
  crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        url: config.original,
        name: testCase.name,
        selector: testCase.selector ?? config.selector,
        index: testCase.index ?? 0,
        theme: themeOf(testCase),
        viewport: viewportOf(testCase),
        prep: [config.prep, testCase.prep].filter(Boolean).join(";"),
        run: testCase.run?.toString(),
      }),
    )
    .digest("hex")
    .slice(0, 12);

/**
 * Gives the replica's element the original's width and document position. It runs before a
 * case's action whenever the element already exists: moving the page after a hover takes
 * the element out from under the pointer, and the replica then shows no hover at all.
 */
async function place(page, testCase, target, targetWidth) {
  const selector = selectorOf(testCase);
  const index = indexOf(testCase);
  const element = page.locator(selector).nth(index);
  if (!(await element.count())) return false;
  if (targetWidth) {
    await page.evaluate(
      ([selector, index, width, anchor]) => {
        const el = document.querySelectorAll(selector)[index];
        const wrapper = anchor ? (el?.closest(anchor) ?? document.querySelector(anchor)) : el?.parentElement;
        if (!wrapper) return;
        wrapper.style.maxWidth = `${width}px`;
        wrapper.style.marginInline = "auto";
      },
      [selector, index, targetWidth, config.widthAnchor ?? null],
    );
  }
  if (wantsPhase && target) {
    await settle(page, { scope: config.scope ?? selector });
    // Same document coordinates when the cache has them, the same sub-pixel phase otherwise.
    if (target.docY !== undefined && config.alignPosition !== false) {
      await alignPosition(page, selector, index, { x: target.docX, y: target.docY }, config.phaseAnchor);
    } else await alignPhase(page, selector, index, target.phase, config.phaseAnchor);
    await page.waitForTimeout(60);
  }
  return true;
}

async function restingBox(page, testCase) {
  return page.evaluate(
    ([selector, index]) => {
      const rect = document.querySelectorAll(selector)[index]?.getBoundingClientRect();
      if (!rect) return null;
      return { docX: rect.x + window.scrollX, docY: rect.y + window.scrollY, phase: rect.y - Math.floor(rect.y) };
    },
    [selectorOf(testCase), indexOf(testCase)],
  );
}

/** Screenshot one element once the page is still. */
async function shoot(page, testCase, file) {
  const selector = selectorOf(testCase);
  const index = indexOf(testCase);
  const element = page.locator(selector).nth(index);
  await element.scrollIntoViewIfNeeded();
  await settle(page, { scope: config.scope ?? selector });
  const box = await element.boundingBox();
  await element.screenshot({ path: file });
  const scroll = await page.evaluate(() => [window.scrollX, window.scrollY]);
  // What matchWidth has to reproduce is the width of the block, not of the part a case looks
  // at: a case with its own selector (a card, a row of panels) still lives in the full block.
  const blockWidth = await page.evaluate(
    ([selector, index, block]) => {
      const el = document.querySelectorAll(selector)[index];
      return ((block && el?.closest(block)) || el)?.getBoundingClientRect().width ?? null;
    },
    [selector, index, blockSelector() ?? null],
  );
  return { ...box, phase: phaseOf(box), docX: box.x + scroll[0], docY: box.y + scroll[1], blockWidth };
}

/** One page for a group of cases: same side, same theme, same viewport. */
async function runGroup(side, group, phases, widths) {
  const url = side === "original" ? config.original : config.replica;
  const page = await browser.newPage({ viewport: group.viewport });
  await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
  if (group.theme === "dark") await setDark(page);
  else await setLight(page);
  const prep = [config.prep, group.prep, side === "replica" ? config.replicaPrep : undefined].filter(Boolean);
  for (const script of prep) await page.evaluate(script);
  if (hideChrome) await hidePageChrome(page, blockSelector());
  if (config.wait) await page.waitForTimeout(Number(config.wait));
  const results = [];
  for (const testCase of group.cases) {
    const file = path.join(out, `${side}-${testCase.name}.png`);
    // Where the element is before the action: a hover that scales it moves its box, and the
    // replica has to be placed by the resting box, not by the hovered one.
    const resting = testCase.run ? await restingBox(page, testCase) : null;
    const cached = phases?.[testCase.name];
    const target = cached && testCase.run && cached.resting ? { ...cached, ...cached.resting } : cached;
    const placed = side === "replica" && (await place(page, testCase, target, widths?.[testCase.name]));
    let before = null;
    if (testCase.run && !testCase.noEffect) {
      const target = page.locator(selectorOf(testCase)).nth(indexOf(testCase));
      if (await target.count()) {
        before = file.replace(/\.png$/, "-before.png");
        await target.scrollIntoViewIfNeeded();
        await settle(page, { scope: config.scope ?? selectorOf(testCase) });
        await target.screenshot({ path: before }).catch(() => (before = null));
      }
    }
    if (testCase.run) await testCase.run(page);
    // An element that only exists after the action (a menu panel) is placed now.
    if (side === "replica" && !placed) await place(page, testCase, target, widths?.[testCase.name]);
    const box = await shoot(page, testCase, file);
    results.push({ testCase, file, box: { ...box, resting }, before });
  }
  await page.close();
  return results;
}

/** Cases that change the page get their own group; the rest share one. */
function groupCases(list) {
  const groups = [];
  const shared = new Map();
  for (const testCase of list) {
    const viewport = viewportOf(testCase);
    const theme = themeOf(testCase);
    if (testCase.run) {
      groups.push({ theme, viewport, prep: testCase.prep, cases: [testCase] });
      continue;
    }
    const key = `${theme}-${viewport.width}x${viewport.height}-${testCase.prep ?? ""}`;
    if (!shared.has(key)) {
      const group = { theme, viewport, prep: testCase.prep, cases: [] };
      shared.set(key, group);
      groups.push(group);
    }
    shared.get(key).cases.push(testCase);
  }
  return groups;
}

async function pool(tasks, size) {
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, tasks.length) }, async () => {
      while (cursor < tasks.length) {
        const index = cursor++;
        results[index] = await tasks[index]();
      }
    }),
  );
  return results;
}

const selected = config.cases.filter((testCase) => matchesOnly(args.only, testCase.name));
const browser = await launch();

// The original does not change while you iterate on the replica: shoot it once.
const missing = selected.filter((testCase) => args.refresh || !fs.existsSync(path.join(cacheDir, `${cacheKey(testCase)}.png`)));
if (missing.length) {
  const shots = (await pool(groupCases(missing).map((group) => () => runGroup("original", group)), jobs)).flat();
  for (const { testCase, file, box, before } of shots) {
    fs.copyFileSync(file, path.join(cacheDir, `${cacheKey(testCase)}.png`));
    // Did the action change the element on the original? null: it only exists afterwards.
    const effect = before ? !sameImage(before, file) : null;
    fs.writeFileSync(path.join(cacheDir, `${cacheKey(testCase)}.json`), JSON.stringify({ ...box, effect }));
  }
  console.log(`original: ${shots.length} captured, ${selected.length - missing.length} from cache`);
} else {
  console.log(`original: all ${selected.length} from cache`);
}

const originalBoxOf = (testCase) => JSON.parse(fs.readFileSync(path.join(cacheDir, `${cacheKey(testCase)}.json`), "utf8"));
side = "replica";
const replicaShots = (
  await pool(
    groupCases(selected).map((group) => {
      const phases = Object.fromEntries(group.cases.map((testCase) => [testCase.name, originalBoxOf(testCase)]));
      const widths = config.matchWidth
        ? Object.fromEntries(group.cases.map((testCase) => [testCase.name, Math.round(originalBoxOf(testCase).blockWidth ?? originalBoxOf(testCase).width)]))
        : undefined;
      return () => runGroup("replica", group, phases, widths);
    }),
    jobs,
  )
).flat();
await browser.close();

let failures = 0;
const items = [];
for (const { testCase, file, box, before } of replicaShots) {
  const originalFile = path.join(cacheDir, `${cacheKey(testCase)}.png`);
  const originalBox = originalBoxOf(testCase);
  const size = (b) => `${Math.round(b.width * 10) / 10}x${Math.round(b.height * 10) / 10}`;
  if (size(originalBox) !== size(box)) {
    console.log(`${testCase.name.padEnd(24)} size ${size(originalBox)} vs ${size(box)}  ⚠ different box`);
    items.push({ name: testCase.name, ok: false, note: `box ${size(originalBox)} vs ${size(box)}` });
    failures++;
    continue;
  }
  // A box whose height ends on a half pixel rasterizes one row taller on one side;
  // compare the common area instead of calling that a difference.
  const [left, right] = [readPng(originalFile), readPng(file)];
  const width = Math.min(left.width, right.width);
  const height = Math.min(left.height, right.height);
  const crop = (png, target) => {
    if (png.width === width && png.height === height) return null;
    const cropped = new PNG({ width, height });
    PNG.bitblt(png, cropped, 0, 0, width, height, 0, 0);
    fs.writeFileSync(target, PNG.sync.write(cropped));
    return target;
  };
  const leftFile = crop(left, path.join(out, `crop-original-${testCase.name}.png`)) ?? originalFile;
  const rightFile = crop(right, path.join(out, `crop-replica-${testCase.name}.png`)) ?? file;
  const result = diffPngs(leftFile, rightFile, path.join(out, `diff-${testCase.name}.png`), { threshold });
  const replicaEffect = before ? !sameImage(before, file) : null;
  let warning;
  if (originalBox.effect === false && replicaEffect === false) warning = "action changed nothing on either page — check the action";
  else if (originalBox.effect !== replicaEffect && originalBox.effect !== undefined)
    warning = `action effect differs: original ${originalBox.effect}, replica ${replicaEffect} (null = element only exists after the action)`;
  // A diff taken at two different sub-pixel phases measures the pages, not the component.
  const phaseGap = Math.abs(originalBox.phase - box.phase);
  if (result.count + result.strictCount && Math.min(phaseGap, 1 - phaseGap) > 0.02)
    warning = [warning, `phase not aligned: original ${originalBox.phase.toFixed(3)}, replica ${box.phase.toFixed(3)}`].filter(Boolean).join("; ");
  console.log(`${formatDiff(testCase.name, result)}  (${size(box)})${warning ? `  ⚠ ${warning}` : ""}`);
  const ok = diffOk(result) && !warning;
  items.push({
    name: testCase.name,
    ok,
    count: result.count,
    faint: result.strictCount,
    note: warning,
    cells: (result.count ? result.hotCells : result.denseCells).slice(0, 4),
    sparse: result.count || result.denseCells.length ? undefined : result.strictCount,
    diff: path.join(out, `diff-${testCase.name}.png`),
  });
  if (!ok) failures++;
}
console.log(failures ? `${failures} case(s) differ` : "all cases match");
finish(args, { check: "elements", ok: !failures, items });
