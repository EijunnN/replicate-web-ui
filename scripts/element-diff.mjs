// Pixel diff of one element on each page, for a component that lives inside a larger
// page (a component gallery, a docs preview) where the two pages around it differ.
// Screenshots the element itself, so only its own box is compared, and reports a size
// mismatch instead of diffing boxes of different sizes.
//
//   node element-diff.mjs --config element.config.mjs [--only menu]
//
// Config: { original, replica, selector, out, threshold, viewport, wait, dark, prep,
//           replicaPrep, cases: [{ name, selector?, dark?, viewport?, prep?, run(page) }] }
//
// Pick selectors that hug their content (a row of triggers, a menu panel): their size
// then does not depend on the page around them. What the element's own box leaves out
// still has to be checked another way — an arrow that sits outside the panel, and the
// panel's position relative to its trigger: measure both boxes on each page and compare
// the offset between them, not the absolute coordinates.
import { pathToFileURL } from "node:url";
import { diffPngs, ensureDir, formatDiff, launch, need, openPage, parseArgs, path } from "./lib.mjs";

const args = parseArgs();
need(args, "config");
const config = (await import(pathToFileURL(path.resolve(args.config)).href)).default;
const out = ensureDir(args.out ?? config.out ?? "elements");
const threshold = Number(config.threshold ?? 40);
const browser = await launch();

async function shoot(url, testCase, file, isReplica) {
  const viewport = testCase.viewport ?? config.viewport ?? { width: 1440, height: 900 };
  const { page } = await openPage(browser, url, {
    width: viewport.width,
    height: viewport.height,
    wait: config.wait ?? 3000,
    dark: testCase.dark ?? config.dark ?? false,
    prep: [config.prep, testCase.prep, isReplica ? config.replicaPrep : undefined].filter(Boolean).join(";") || undefined,
  });
  await page.mouse.move(viewport.width / 2, viewport.height - 4);
  if (testCase.run) await testCase.run(page);
  const locator = page.locator(testCase.selector ?? config.selector).first();
  let box = null;
  try {
    box = await locator.boundingBox({ timeout: 5000 });
    await locator.screenshot({ path: file });
  } catch {
    box = null; // element never appeared: reported as "missing", not a crash
  }
  await page.close();
  return box;
}

let failures = 0;
for (const testCase of config.cases) {
  if (args.only && !testCase.name.startsWith(args.only)) continue;
  const originalShot = path.join(out, `original-${testCase.name}.png`);
  const replicaShot = path.join(out, `replica-${testCase.name}.png`);
  const originalBox = await shoot(config.original, testCase, originalShot, false);
  const replicaBox = await shoot(config.replica, testCase, replicaShot, true);
  const sizes = [originalBox, replicaBox].map((b) => (b ? `${Math.round(b.width * 10) / 10}x${Math.round(b.height * 10) / 10}` : "(missing)"));
  if (sizes[0] !== sizes[1]) {
    console.log(`${testCase.name.padEnd(24)} size ${sizes[0]} vs ${sizes[1]}  ⚠ different box`);
    failures++;
    continue;
  }
  const result = diffPngs(originalShot, replicaShot, path.join(out, `diff-${testCase.name}.png`), { threshold });
  console.log(`${formatDiff(testCase.name, result)}  (${sizes[0]})`);
  if (result.count) failures++;
}
await browser.close();
console.log(failures ? `${failures} case(s) differ` : "all cases match");
