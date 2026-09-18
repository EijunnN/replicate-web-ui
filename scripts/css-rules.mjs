// Pulls CSS rules out of the live CSSOM (all stylesheets, including @layer, @media,
// @supports and nested rules), filtered by a selector regex. Use it for design-system
// classes that are defined in CSS rather than as utilities, e.g. shadcn "style-nova"
// `.cn-button-variant-outline`, or for hover/focus states you cannot see in the DOM.
//
//   node css-rules.mjs --url URL --match "cn-(button|toggle)" --out rules.css [--scope "\.style-nova"]
//   node css-rules.mjs --url URL --decl "cursor: pointer|font-synthesis" --out base.css
//
// `--decl` searches declarations instead of selectors. Use it when a computed value has no
// obvious owner: it is how the host page's own base layer shows up (`button:not(:disabled)
// { cursor: pointer }`, `body { font-synthesis-weight: none }`) — rules the block inherits
// on the original page and has to carry itself inside a replica.
//
// Output lines are prefixed with their context (@layer base, @media ...), which tells you
// precedence: anything in @layer base loses to any Tailwind utility on the same element.
// Caveat: Chrome serializes some shorthand values built from var() as empty
// ("padding-top: ;"). When you see that, read the computed value with measure.mjs.
import { fs, launch, need, openPage, parseArgs } from "./lib.mjs";

const args = parseArgs();
need(args, "url", "out");
if (!args.match && !args.decl) {
  console.error("pass --match <selector regex> or --decl <declaration regex>");
  process.exit(1);
}
const browser = await launch();
const { page } = await openPage(browser, args.url, { wait: 1500 });

const rules = await page.evaluate(
  ({ match, scope, decl }) => {
    const pattern = match ? new RegExp(match) : null;
    const declPattern = decl ? new RegExp(decl) : null;
    const scopePattern = scope ? new RegExp(scope) : null;
    const out = [];
    const walk = (ruleList, context, parentSelector) => {
      for (const rule of ruleList) {
        if (rule.selectorText !== undefined) {
          const selector = parentSelector ? rule.selectorText.replace(/&/g, parentSelector) : rule.selectorText;
          const body = rule.style.cssText;
          const matches = (!pattern || pattern.test(selector)) && (!declPattern || declPattern.test(body));
          if (matches && (!scopePattern || scopePattern.test(selector) || scopePattern.test(context))) {
            if (body) out.push(`${context}${selector} { ${body} }`);
          }
          if (rule.cssRules?.length) walk(rule.cssRules, context, selector);
        } else if (rule.cssRules) {
          const label = rule.conditionText
            ? `@${rule.constructor.name.replace("CSS", "").replace("Rule", "").toLowerCase()} ${rule.conditionText} `
            : rule.name !== undefined
              ? `@layer ${rule.name} `
              : "";
          walk(rule.cssRules, context + label, parentSelector);
        } else if (rule.name && rule.cssText?.startsWith("@keyframes") && pattern?.test(rule.name)) {
          out.push(rule.cssText);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules, "", "");
      } catch {
        out.push(`/* cross-origin stylesheet skipped: ${sheet.href} */`);
      }
    }
    return out;
  },
  { match: args.match, scope: args.scope, decl: args.decl },
);

await browser.close();
fs.writeFileSync(args.out, rules.join("\n"));
console.log(`${rules.length} rules -> ${args.out}`);
