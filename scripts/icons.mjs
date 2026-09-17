// Collects the exact icon markup a page renders. Icon sets change paths between
// versions (lucide's shopping-cart did), so copy what the page shows, not your memory.
//
//   node icons.mjs --url URL --out icons.json [--selector "svg.lucide"] [--click "[aria-label='Open notifications']"]...
//
// Each --click opens something (menus, dialogs) so their icons are collected too;
// Escape is pressed after each one.
import { fs, launch, list, need, openPage, parseArgs, sleep } from "./lib.mjs";

const args = parseArgs();
need(args, "url", "out");
const selector = args.selector ?? "svg.lucide";
const browser = await launch();
const { page } = await openPage(browser, args.url, { wait: 2000 });
const icons = {};

const grab = async () =>
  Object.assign(
    icons,
    await page.evaluate((selector) => {
      const found = {};
      document.querySelectorAll(selector).forEach((svg) => {
        const name = [...svg.classList].find((c) => c.startsWith("lucide-")) ?? svg.getAttribute("data-icon") ?? svg.getAttribute("aria-label") ?? `svg-${Object.keys(found).length}`;
        const extra = [...svg.classList].filter((c) => c !== "lucide" && c !== name);
        const entry = (found[name] ??= {
          viewBox: svg.getAttribute("viewBox"),
          fill: svg.getAttribute("fill"),
          strokeWidth: svg.getAttribute("stroke-width"),
          markup: svg.innerHTML,
          classVariants: [],
        });
        const variant = extra.join(" ");
        if (variant && !entry.classVariants.includes(variant)) entry.classVariants.push(variant);
      });
      return found;
    }, selector),
  );

await grab();
for (const target of list(args.click)) {
  await page.locator(target).first().click();
  await sleep(700);
  await grab();
  await page.keyboard.press("Escape");
  await sleep(400);
}
await browser.close();
fs.writeFileSync(args.out, JSON.stringify(icons, null, 2));
console.log(`${Object.keys(icons).length} icons -> ${args.out}`);
for (const [name, icon] of Object.entries(icons)) if (icon.classVariants.length) console.log(`  ${name}: ${icon.classVariants.join(" | ")}`);
