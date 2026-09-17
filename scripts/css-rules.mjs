// Pulls CSS rules out of the live CSSOM (all stylesheets, including @layer, @media,
// @supports and nested rules), filtered by a selector regex. Use it for design-system
// classes that are defined in CSS rather than as utilities, e.g. shadcn "style-nova"
// `.cn-button-variant-outline`, or for hover/focus states you cannot see in the DOM.
//
//   node css-rules.mjs --url URL --match "cn-(button|toggle)" --out rules.css [--scope "\.style-nova"]
//
// Output lines are prefixed with their context (@layer base, @media ...), which tells you
// precedence: anything in @layer base loses to any Tailwind utility on the same element.
// Caveat: Chrome serializes some shorthand values built from var() as empty
// ("padding-top: ;"). When you see that, read the computed value with measure.mjs.
import { fs, launch, need, openPage, parseArgs } from "./lib.mjs";

const args = parseArgs();
need(args, "url", "match", "out");
const browser = await launch();
const { page } = await openPage(browser, args.url, { wait: 1500 });

const rules = await page.evaluate(
  ({ match, scope }) => {
    const pattern = new RegExp(match);
    const scopePattern = scope ? new RegExp(scope) : null;
    const out = [];
    const walk = (ruleList, context, parentSelector) => {
      for (const rule of ruleList) {
        if (rule.selectorText !== undefined) {
          const selector = parentSelector ? rule.selectorText.replace(/&/g, parentSelector) : rule.selectorText;
          if (pattern.test(selector) && (!scopePattern || scopePattern.test(selector) || scopePattern.test(context))) {
            const body = rule.style.cssText;
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
        } else if (rule.name && rule.cssText?.startsWith("@keyframes") && pattern.test(rule.name)) {
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
  { match: args.match, scope: args.scope },
);

await browser.close();
fs.writeFileSync(args.out, rules.join("\n"));
console.log(`${rules.length} rules -> ${args.out}`);
