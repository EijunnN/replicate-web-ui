// Every computed CSS property of every element, original vs replica, in each state of
// the states config. This is the check that sees what screenshots cannot: a missing
// `cursor: pointer`, an easing curve the host theme redefined, the text color a portaled
// layer inherits from the host body, a transition duration, a 0.1px box shift.
//
//   node computed-diff.mjs --config states.config.mjs [--only mobile] [--props "cursor|ease"]
//
// It reuses states.config.mjs (original, replica, prep, replicaPrep, wait, viewport,
// states[]). Extra fields it understands:
//
//   originalRoot / replicaRoot : selector of the block root on each page (default "body").
//   ignoreElements             : selector whose matches (and subtrees) are dropped on both
//                                pages, for host chrome that has no counterpart, e.g.
//                                "noscript, [data-sonner-toaster], #analytics".
//   ignoreProps                : regex of property names to skip.
//
// The two trees are walked in parallel, so an element that exists on one side only is
// reported where it is instead of shifting everything after it. Elements with
// `display: contents` are unwrapped (a portal token-scope wrapper is one), and
// body-level siblings of the root are appended so portaled overlays are compared too.
// Colors are normalized through a canvas, so oklch/lab/rgb spellings of the same color
// compare equal; `font-family` is skipped because hashed next/font names never match.
import { pathToFileURL } from "node:url";
import { launch, need, openPage, parseArgs, path } from "./lib.mjs";

const args = parseArgs();
need(args, "config");
const config = (await import(pathToFileURL(path.resolve(args.config)).href)).default;
const propFilter = args.props ? new RegExp(args.props) : null;
const browser = await launch();

const collect = (page, rootSelector, ignoreElements, ignoreProps) =>
  page.evaluate(
    ({ rootSelector, ignoreElements, ignoreProps }) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const colorPattern = /(?:oklch|oklab|lab|lch|hwb|hsla?|rgba?|color)\([^()]*(?:\([^()]*\)[^()]*)*\)/g;
      const normalize = (value) =>
        value.replace(colorPattern, (color) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = "#000";
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          return `rgba(${[...ctx.getImageData(0, 0, 1, 1).data].join(",")})`;
        });
      const skipProp = new RegExp(ignoreProps || "^$");
      const read = (el) => {
        const style = getComputedStyle(el);
        const values = {};
        for (let i = 0; i < style.length; i++) {
          const property = style[i];
          if (property.startsWith("--") || /^(font-family|d|view-transition-name)$/.test(property)) continue;
          if (skipProp.test(property)) continue;
          values[property] = normalize(style.getPropertyValue(property));
        }
        const box = el.getBoundingClientRect();
        values["@box"] = [box.x, box.y, box.width, box.height].map((n) => Math.round(n * 10) / 10).join(",");
        const slot = el.getAttribute("data-slot");
        const text = el.childElementCount ? "" : (el.textContent || "").trim().slice(0, 20);
        return {
          tag: el.tagName.toLowerCase(),
          label: `${el.tagName.toLowerCase()}${slot ? `[${slot}]` : ""}.${(el.getAttribute("class") || "").slice(0, 32)}${text ? ` "${text}"` : ""}`,
          values,
        };
      };
      // `display: contents` elements have no box of their own; keep their children.
      const childrenOf = (el) =>
        [...el.children].flatMap((child) =>
          ignoreElements && child.matches(ignoreElements)
            ? []
            : getComputedStyle(child).display === "contents"
              ? childrenOf(child)
              : [child],
        );
      const build = (el) => ({ ...read(el), children: childrenOf(el).map(build) });
      const root = document.querySelector(rootSelector) ?? document.body;
      const trees = [build(root)];
      for (const sibling of document.body.children) {
        if (sibling === root || sibling.contains(root) || root.contains(sibling)) continue;
        if (/^(SCRIPT|NOSCRIPT|STYLE|LINK|TEMPLATE|NEXT-ROUTE-ANNOUNCER|NEXTJS-PORTAL)$/.test(sibling.tagName)) continue;
        if (ignoreElements && sibling.matches(ignoreElements)) continue;
        if (getComputedStyle(sibling).display === "contents") trees.push(...childrenOf(sibling).map(build));
        else trees.push(build(sibling));
      }
      return trees;
    },
    { rootSelector, ignoreElements, ignoreProps },
  );

let failures = 0;
for (const state of config.states) {
  if (args.only && !state.name.startsWith(args.only)) continue;
  const trees = [];
  for (const [url, root, isReplica] of [
    [config.original, config.originalRoot ?? "body", false],
    [config.replica, config.replicaRoot ?? "body", true],
  ]) {
    const viewport = state.viewport ?? config.viewport ?? { width: 1440, height: 900 };
    const { page } = await openPage(browser, url, {
      width: viewport.width,
      height: viewport.height,
      fullHeight: state.fullHeight ?? false,
      wait: config.wait ?? 3000,
      dark: !!state.dark,
      prep: [config.prep, isReplica ? config.replicaPrep : undefined].filter(Boolean).join(";") || undefined,
    });
    await page.mouse.move(state.restX ?? viewport.width / 2, state.restY ?? 5);
    if (state.run) await state.run(page);
    trees.push(await collect(page, root, config.ignoreElements, config.ignoreProps));
    await page.close();
  }

  const groups = new Map();
  const structural = [];
  let compared = 0;
  const walk = (a, b, path) => {
    if (!a || !b) {
      structural.push(`${path}: only on the ${a ? "original" : "replica"} — ${(a ?? b).label}`);
      return;
    }
    if (a.tag !== b.tag) {
      structural.push(`${path}: <${a.tag}> vs <${b.tag}> — ${a.label}  /  ${b.label}`);
      return;
    }
    compared++;
    const differing = Object.keys(a.values).filter(
      (key) => a.values[key] !== b.values[key] && (!propFilter || propFilter.test(key)),
    );
    if (differing.length) {
      const signature = differing.map((key) => `${key}: ${a.values[key]}  |  ${b.values[key]}`).join("\n     ");
      const entry = groups.get(signature) ?? groups.set(signature, []).get(signature);
      entry.push(`${path} ${a.label}${a.label === b.label ? "" : `  /  ${b.label}`}`);
    }
    const count = Math.max(a.children.length, b.children.length);
    for (let i = 0; i < count; i++) walk(a.children[i], b.children[i], `${path}>${(a.children[i] ?? b.children[i]).tag}:${i}`);
  };
  const [original, replica] = trees;
  const roots = Math.max(original.length, replica.length);
  for (let i = 0; i < roots; i++) walk(original[i], replica[i], (original[i] ?? replica[i]).tag);

  console.log(`\n=== ${state.name}: ${compared} elements compared`);
  for (const line of structural) console.log(`  ⚠ ${line}`);
  for (const [signature, elements] of groups) {
    console.log(`  ×${elements.length} ${elements.slice(0, 3).join(" ; ")}\n     ${signature}`);
  }
  if (groups.size || structural.length) failures++;
}
await browser.close();
console.log(failures ? `\n${failures} state(s) differ` : "\nall states match");
