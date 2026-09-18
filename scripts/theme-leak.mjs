// Theme scales the block's utilities resolve against, original vs replica. A host that
// defines its own `--ease-out`, `--radius-*`, `--spacing` or `--text-*` in `@theme`
// silently changes `ease-out`, `rounded-md` or `text-sm` *inside* the block: same class
// list, different value, and screenshots only catch it if that state is on screen.
//
//   node theme-leak.mjs --original URL --replica URL [--original-root "body>div"]
//        [--replica-root "[data-slot=block]"] [--all] [--width 1440] [--dark]
//
// Reads every custom property declared anywhere in each page's CSSOM, then resolves it
// on the block root of that page. By default it only prints Tailwind theme namespaces;
// `--all` prints every property, including the block's own tokens.
//
// "(unset)" means the property is not declared on that page: harmless when the block does
// not use the utility, a real leak when it does. Fix by redeclaring the scale on the
// block root (see references/replica-architecture.md).
import { launch, need, openPage, parseArgs } from "./lib.mjs";

const args = parseArgs();
need(args, "original", "replica");
const namespaces =
  /^--(ease|animate|radius|shadow|inset-shadow|drop-shadow|text|font|font-weight|spacing|tracking|leading|blur|breakpoint|container|default|perspective|aspect)/;
const browser = await launch();

const read = async (url, rootSelector) => {
  const { page } = await openPage(browser, url, { width: Number(args.width ?? 1440), height: 900, wait: Number(args.wait ?? 2500), dark: !!args.dark });
  const values = await page.evaluate((rootSelector) => {
    const names = new Set();
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.style) for (let i = 0; i < rule.style.length; i++) if (rule.style[i].startsWith("--")) names.add(rule.style[i]);
        if (rule.cssRules) walk(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch {}
    }
    const root = (rootSelector && document.querySelector(rootSelector)) || document.body;
    const style = getComputedStyle(root);
    return Object.fromEntries([...names].map((name) => [name, style.getPropertyValue(name).trim()]));
  }, rootSelector);
  await page.close();
  return values;
};

const original = await read(args.original, args["original-root"]);
const replica = await read(args.replica, args["replica-root"]);
await browser.close();

// Whitespace inside a value is not significant here: Chrome serializes a token the same
// way on both pages except for spacing after commas.
const same = (a, b) => (a ?? "").replace(/\s+/g, "") === (b ?? "").replace(/\s+/g, "");
let leaks = 0;
for (const name of Object.keys(original).sort()) {
  if (!args.all && !namespaces.test(name)) continue;
  if (same(original[name], replica[name])) continue;
  leaks++;
  console.log(`${name}\n  original: ${original[name] || "(empty)"}\n  replica:  ${replica[name] ?? "(unset)"}`);
}
console.log(leaks ? `\n${leaks} differing token(s)` : "\nno differing tokens");
