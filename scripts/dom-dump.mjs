// Dumps the rendered DOM of a region in a readable form. The rendered DOM is the best
// source for class names: it shows the final list after tailwind-merge/cva, including
// server-rendered parts that never ship as client JS.
//
//   node dom-dump.mjs --url URL --out main.html [--selector main] [--width 1440] [--wait 3000]
//        [--click "[aria-label='Open search']"] [--hover ".sidebar"] [--type "zzz"] [--key Escape]
//
// Actions run in the order given (repeat the flags), so overlays can be opened first.
// Compaction keeps meaning while cutting noise:
//   - lucide icons become <icon:name class="extra classes"> (the extra classes matter: size, color)
//   - SVGs with many nodes keep their attributes but drop children (<!-- 931 nodes -->)
//   - runs of 6+ siblings with the same class and inner structure keep two samples plus
//     a count, so "32 segments, 22 filled" reads as two runs and differing items survive.
import beautify from "js-beautify";
import { fs, launch, need, openPage, parseArgs, sleep } from "./lib.mjs";

const args = parseArgs();
need(args, "url", "out");
const browser = await launch();
const { page } = await openPage(browser, args.url, { width: Number(args.width ?? 1440), wait: Number(args.wait ?? 3000) });

// Replay actions in argv order.
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const value = argv[i + 1];
  if (argv[i] === "--click") await page.locator(value).first().click();
  else if (argv[i] === "--hover") await page.locator(value).first().hover();
  else if (argv[i] === "--type") await page.keyboard.type(value);
  else if (argv[i] === "--key") await page.keyboard.press(value);
  else continue;
  await sleep(700);
}

const html = await page.evaluate((selector) => {
  const roots = [...document.querySelectorAll(selector)];
  return roots
    .map((root) => {
      const clone = root.cloneNode(true);
      clone.querySelectorAll("svg").forEach((svg) => {
        const lucide = [...svg.classList].find((c) => c.startsWith("lucide-"));
        if (lucide) {
          const extra = [...svg.classList].filter((c) => c !== "lucide" && c !== lucide).join(" ");
          const marker = document.createElement(`Icon:${lucide.slice(7)}`);
          if (extra) marker.setAttribute("class", extra);
          for (const attr of ["data-icon", "data-slot", "aria-hidden"]) if (svg.hasAttribute(attr)) marker.setAttribute(attr, svg.getAttribute(attr));
          svg.replaceWith(marker);
          return;
        }
        const nodes = svg.querySelectorAll("*").length;
        if (nodes > 40) svg.innerHTML = `<!-- ${nodes} nodes -->`;
      });
      const collapse = (element) => {
        const children = [...element.children];
        let start = 0;
        while (start < children.length) {
          // Same tag, attributes and inner structure. Per-item attributes (labels,
          // inline styles, ids) are ignored, so 168 heatmap cells collapse while
          // sparkline columns with different segment counts and SVG paths with
          // different `d` stay separate.
          const perItem = /^(id|title|style|tabindex|aria-[\w-]+|data-state)$/;
          const signature = (node) =>
            `${node.tagName}|${[...node.attributes].filter((a) => !perItem.test(a.name)).map((a) => `${a.name}=${a.value}`).join(" ")}|${node.innerHTML.replace(/\s(id|title|style|tabindex|aria-[\w-]+|data-state)="[^"]*"/g, "")}`;
          let end = start;
          while (end + 1 < children.length && signature(children[end + 1]) === signature(children[start])) end++;
          const run = end - start + 1;
          if (run >= 6) {
            for (let k = start + 2; k <= end; k++) children[k].remove();
            children[start + 1].after(document.createComment(` ×${run} total like the previous (${run - 2} removed) `));
          }
          start = end + 1;
        }
        [...element.children].forEach(collapse);
      };
      collapse(clone);
      return clone.outerHTML;
    })
    .join("\n\n");
}, args.selector ?? "body");

await browser.close();
const cleaned = html.replace(/ (hugeicons|phosphor|remixicon|tabler|lucide)="[^"]*"/g, "");
fs.writeFileSync(args.out, beautify.html(cleaned, { indent_size: 2, wrap_line_length: 0, unformatted: ["svg"] }));
console.log(`${args.out}: ${cleaned.length} chars from "${args.selector ?? "body"}"`);
