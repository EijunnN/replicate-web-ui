// The page around the block, original vs replica: what <html> and <body> paint and pass down
// by inheritance, and whether the replica threw while mounting. Everything inside a block
// inherits these, so one wrong value here is a difference on every element, and it is the
// harness's fault, not the component's. In the first beUI batch four of eight harness defects
// lived here (a page surface ten levels too dark, an unquoted `--font-sans`, a
// `font-synthesis-weight` the original never sets, a missing `overflow-x: clip`), each found
// by an agent hours in, after verdicts had already been reached against it.
//
//   node page-env.mjs --config replica.config.mjs [--dark] [--json result.json]
//
// Run it first, against the empty harness, before porting anything (`verify --only env`).
// Reads original, replica, prep, replicaPrep, viewport, wait and `ignorePageProps` (a regex
// of `html.<prop>` / `body.<prop>` keys you proved do not reach the block) from the config.
// An uncaught exception on the replica fails the check; console errors are listed, because
// a missing favicon is one too.
import { canonicalValue, finish, launch, loadConfig, need, openPage, parseArgs, path } from "./lib.mjs";

const args = parseArgs();
need(args, "config");
const config = await loadConfig(args.config);
const dark = !!args.dark;
const ignore = config.ignorePageProps ? new RegExp(config.ignorePageProps) : null;

// Painted by the page, or inherited by every text node of the block.
const PROPS = [
  "background-color",
  "background-image",
  "color",
  "color-scheme",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "font-feature-settings",
  "font-variation-settings",
  "font-synthesis-weight",
  "font-optical-sizing",
  "text-rendering",
  "-webkit-font-smoothing",
  "-webkit-text-size-adjust",
  "overflow-x",
  "overflow-y",
  "cursor",
];

// next/font hashes its family names per build (`__Geist_3a0388`): the family is the same.
const family = (value) => value.replace(/'?__([A-Za-z0-9]+?)(_Fallback)?_[0-9a-f]{5,8}'?/g, "$1$2");

async function read(browser, url, isReplica) {
  const viewport = config.viewport ?? { width: 1440, height: 900 };
  const prep = [config.prep, isReplica ? config.replicaPrep : undefined].filter(Boolean).join(";") || undefined;
  const { page, errors } = await openPage(browser, url, { width: viewport.width, height: viewport.height, wait: config.wait ?? 2500, dark, prep, still: false });
  // openPage only forces dark; a page whose default is dark needs light forced the same way.
  if (!dark) {
    await page.emulateMedia({ colorScheme: "light" });
    await page.evaluate(() => {
      const html = document.documentElement;
      html.classList.remove("dark");
      html.classList.add("light");
      html.style.colorScheme = "light";
    });
    await page.waitForTimeout(300);
  }
  const values = await page.evaluate((props) => {
    const out = {};
    for (const [label, el] of [["html", document.documentElement], ["body", document.body]]) {
      const style = getComputedStyle(el);
      for (const prop of props) out[`${label}.${prop}`] = style.getPropertyValue(prop).trim();
    }
    return out;
  }, PROPS);
  await page.close();
  return { values, errors };
}

const browser = await launch();
const original = await read(browser, config.original, false);
const replica = await read(browser, config.replica, true);
await browser.close();
const items = [];
for (const key of Object.keys(original.values)) {
  if (ignore?.test(key)) continue;
  const [a, b] = [original.values[key], replica.values[key]].map((value) => canonicalValue(key.endsWith("font-family") ? family(value) : value));
  if (a === b) continue;
  items.push({ name: `${key}: ${original.values[key] || "(empty)"} | ${replica.values[key] || "(empty)"}`, ok: false });
}
const thrown = replica.errors.filter((error) => error.startsWith("pageerror"));
for (const error of thrown) items.push({ name: `replica ${error}`, ok: false });
const logged = replica.errors.filter((error) => !error.startsWith("pageerror") && !original.errors.includes(error));

for (const item of items) console.log(item.name);
if (logged.length) console.log(`\nreplica console errors (not failing; read them):\n  ${logged.join("\n  ")}`);
if (ignore) console.log(`ignored: ${config.ignorePageProps}`);
console.log(items.length ? `\n${items.length} difference(s) in the page around the block (${dark ? "dark" : "light"})` : `\npage around the block matches (${dark ? "dark" : "light"})`);
// One passing item keeps the report's "n/n ok" honest about what was compared.
if (!items.length) items.push({ name: `${Object.keys(original.values).length} html/body properties`, ok: true });
finish(args, { check: dark ? "env-dark" : "env", ok: !items.some((item) => !item.ok), items });
