// Box and computed styles for every element matching a selector, on one or two pages.
// Use it to settle an ambiguous value instead of guessing (an icon without a size class,
// a padding the CSSOM serialized as empty, a popover offset).
//
//   node measure.mjs --url URL --selector "[data-slot=item-actions] svg" [--props color,padding-top] [--limit 5]
//   node measure.mjs --url URL --replica URL2 --selector "kbd"        (prints both, side by side)
//   node measure.mjs --url URL --width 390 --height 844 --click "text=Toggle Sidebar" --selector "a[href='#/sales']"
// --click / --hover run before measuring (repeatable, in order), to measure open overlays.
// Only rendered elements are listed; pass --all to include display:none matches.
import { launch, need, openPage, parseArgs, sleep } from "./lib.mjs";

const args = parseArgs();
need(args, "url", "selector");
const props = String(args.props ?? "width,height,color,background-color,font-size,font-weight,line-height,padding,margin,border-radius,gap").split(",");
const limit = Number(args.limit ?? 5);
const browser = await launch();

async function measure(url) {
  const { page } = await openPage(browser, url, { width: Number(args.width ?? 1440), height: Number(args.height ?? 900), wait: Number(args.wait ?? 2500) });
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--click") await page.locator(argv[i + 1]).first().click();
    else if (argv[i] === "--hover") await page.locator(argv[i + 1]).first().hover();
    else continue;
    await sleep(Number(args["action-wait"] ?? 900));
  }
  const rows = await page.evaluate(
    ({ selector, props, limit, all }) =>
      [...document.querySelectorAll(selector)]
        // Hidden duplicates (a desktop rail behind a mobile sheet) would otherwise come first.
        .filter((el) => all || el.getClientRects().length > 0)
        .slice(0, limit)
        .map((el) => {
        const box = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          box: [box.x, box.y, box.width, box.height].map((v) => Math.round(v * 10) / 10).join(" "),
          class: (el.getAttribute("class") ?? "").slice(0, 160),
          ...Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)])),
        };
      }),
    { selector: args.selector, props, limit, all: !!args.all },
  );
  await page.close();
  return rows;
}

const original = await measure(args.url);
const replica = args.replica ? await measure(args.replica) : null;
await browser.close();
original.forEach((row, index) => {
  console.log(`#${index} original ${JSON.stringify(row)}`);
  if (replica?.[index]) console.log(`#${index} replica  ${JSON.stringify(replica[index])}`);
});
if (!original.length) console.log("no match on original");
