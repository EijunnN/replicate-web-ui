// Reads the design tokens (CSS custom properties) as computed on <body>, in light and in
// dark, plus the typography settings that silently change glyphs.
//
//   node tokens.mjs --url URL --out tokens.json [--dark-class dark] [--light-class light] [--include "^--(color|chart|radius)"]
//
// Names come from every declaration in the CSSOM that starts with "--" (Tailwind's
// internal --tw-* and Radix --radix-* are skipped). Values are the computed ones, so
// var() chains are already resolved.
import { fs, launch, need, openPage, parseArgs, setDark } from "./lib.mjs";

const args = parseArgs();
need(args, "url", "out");
const browser = await launch();
const { page } = await openPage(browser, args.url, { wait: 1500 });

const names = await page.evaluate((include) => {
  const found = new Set();
  const filter = include ? new RegExp(include) : null;
  const walk = (ruleList) => {
    for (const rule of ruleList) {
      if (rule.style) for (const prop of rule.style) if (prop.startsWith("--")) found.add(prop);
      if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {}
  }
  for (const prop of document.documentElement.style) if (prop.startsWith("--")) found.add(prop);
  return [...found].filter((name) => !/^--(tw|radix)-/.test(name) && (!filter || filter.test(name))).sort();
}, args.include);

const read = () =>
  page.evaluate((names) => {
    const cs = getComputedStyle(document.body);
    const values = {};
    for (const name of names) {
      const value = cs.getPropertyValue(name).trim();
      if (value) values[name] = value;
    }
    return {
      values,
      typography: {
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontFeatureSettings: cs.fontFeatureSettings,
        letterSpacing: cs.letterSpacing,
        webkitFontSmoothing: cs.webkitFontSmoothing,
      },
      htmlClass: document.documentElement.className,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
    };
  }, names);

const light = await read();
await setDark(page, args["dark-class"] ?? "dark", args["light-class"] ?? "light");
await page.waitForTimeout(400);
const dark = await read();
await browser.close();

const changedInDark = Object.fromEntries(Object.entries(dark.values).filter(([name, value]) => light.values[name] !== value));
fs.writeFileSync(args.out, JSON.stringify({ light, dark: { ...dark, values: changedInDark } }, null, 2));
console.log(`${Object.keys(light.values).length} tokens (light), ${Object.keys(changedInDark).length} change in dark -> ${args.out}`);
console.log(`typography ${JSON.stringify(light.typography)}`);
