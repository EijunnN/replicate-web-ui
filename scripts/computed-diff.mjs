// Every computed CSS property of every element, original vs replica, in each state of
// the states config. This is the check that sees what screenshots cannot: a missing
// `cursor: pointer`, an easing curve the host theme redefined, the text color a portaled
// layer inherits from the host body, a transition duration, a 0.1px box shift.
//
//   node computed-diff.mjs --config replica.config.mjs [--only mobile,dark] [--props "cursor|ease"]
//        [--jobs 4] [--refresh] [--out computed] [--json result.json]
//
// It reads the same config as states.mjs (original, replica, prep, replicaPrep, wait,
// viewport, states[]). The original's trees are cached in <out>/cache (`--refresh` to
// redo) and states run `--jobs` at a time. Exit code 1 when any state differs.
// Extra fields it understands:
//
//   originalRoot / replicaRoot : selector of the block root on each page (default "body").
//                                A state can carry its own pair, for a page with several blocks.
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
import { cacheKey, ensureDir, finish, fs, launch, matchesOnly, need, openPage, parseArgs, path, pool, settle } from "./lib.mjs";

const args = parseArgs();
need(args, "config");
const config = (await import(pathToFileURL(path.resolve(args.config)).href)).default;
const propFilter = args.props ? new RegExp(args.props) : null;
const out = ensureDir(args.out ?? path.join(config.out ?? ".", "computed"));
const cacheDir = ensureDir(path.join(out, "cache"));
const jobs = Number(args.jobs ?? config.jobs ?? 4);
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
      const root = document.querySelector(rootSelector) ?? document.body;
      const origin = root.getBoundingClientRect();
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
        // Relative to the block root: the two pages place the block differently, and an
        // absolute box would report that page offset on every single element.
        values["@box"] = box.width || box.height
          ? [box.x - origin.x, box.y - origin.y, box.width, box.height].map((n) => Math.round(n * 10) / 10).join(",")
          : "(no box)"; // <style>, <script> and other elements that never lay out
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

async function runState(state) {
  const trees = [];
  for (const [url, root, isReplica] of [
    [config.original, state.originalRoot ?? config.originalRoot ?? "body", false],
    [config.replica, state.replicaRoot ?? config.replicaRoot ?? "body", true],
  ]) {
    const cached = path.join(
      cacheDir,
      `${cacheKey({ url, root, state, viewport: state.viewport ?? config.viewport, wait: config.wait ?? 3000, prep: config.prep ?? "", ignoreElements: config.ignoreElements ?? "", ignoreProps: config.ignoreProps ?? "" })}.json`,
    );
    if (!isReplica && !args.refresh && fs.existsSync(cached)) {
      trees.push(JSON.parse(fs.readFileSync(cached, "utf8")));
      continue;
    }
    const viewport = state.viewport ?? config.viewport ?? { width: 1440, height: 900 };
    const { page } = await openPage(browser, url, {
      width: viewport.width,
      height: viewport.height,
      fullHeight: state.fullHeight ?? false,
      wait: config.wait ?? 3000,
      dark: !!state.dark,
      prep: [config.prep, state.prep, isReplica ? config.replicaPrep : undefined].filter(Boolean).join(";") || undefined,
    });
    await page.mouse.move(state.restX ?? viewport.width / 2, state.restY ?? 5);
    if (state.run) await state.run(page);
    // A looping or late animation caught mid-flight reads as a page of differences.
    await settle(page, { scope: root });
    trees.push(await collect(page, root, config.ignoreElements, config.ignoreProps));
    await page.close();
    if (!isReplica) fs.writeFileSync(cached, JSON.stringify(trees[0]));
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

  return { state, compared, structural, groups: [...groups].map(([signature, elements]) => ({ signature, elements })) };
}

const selected = config.states.filter((state) => matchesOnly(args.only, state.name));
const results = await pool(selected.map((state) => () => runState(state)), jobs);
await browser.close();

let failures = 0;
const items = results.map(({ state, compared, structural, groups }) => {
  console.log(`\n=== ${state.name}: ${compared} elements compared`);
  for (const line of structural) console.log(`  ⚠ ${line}`);
  for (const { signature, elements } of groups) {
    console.log(`  ×${elements.length} ${elements.slice(0, 3).join(" ; ")}\n     ${signature}`);
  }
  const ok = !groups.length && !structural.length;
  if (!ok) failures++;
  return {
    name: state.name,
    ok,
    compared,
    structural,
    groups: groups.map(({ signature, elements }) => ({ signature, count: elements.length, first: elements[0] })),
  };
});
console.log(failures ? `\n${failures} state(s) differ` : "\nall states match");
finish(args, { check: "computed", ok: !failures, items });
