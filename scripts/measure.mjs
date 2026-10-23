// Boxes, computed values, custom properties and attributes of the elements a selector
// matches, on the original and the replica side by side, after the same actions, at one
// moment or over time. Use it to settle any question about two pages instead of writing a
// one-off Playwright script: in the first beUI batch agents wrote more than twenty of those
// (box-probe, cmp, chain, hover-probe, sample-motion, loop-compare…), each a few turns.
//
//   node measure.mjs --config replica.config.mjs --selector "article button" [options]
//   node measure.mjs --url URL [--replica URL2] --selector "kbd" [options]
//
// With --config the URLs, viewport, wait, prep / replicaPrep and the block roots come from
// the config (originalRoot / replicaRoot, else elements.selector / replicaSelector), and
// --state runs a state's or an element case's own `run`, so you probe exactly what verify
// compares. Every flag overrides the config.
//
// What to read
//   --props a,b      computed properties (default: a box set); presets: text, layers, motion, all-box
//   --vars --x,--y   custom properties, resolved on each element
//   --attrs a,b      attributes (style, aria-label, data-state…)
//   --text           the element's text (a label that swaps to "Copied", a ticker's digits)
//   --ancestors      the chain from each match up to the root, with --props (default: layers),
//                    for "what promotes this to a layer" or "which wrapper is 1px wider"
//   --limit N        matches per page (default 5); --all includes display:none matches
// Where
//   --selector S / --replica-selector S   matched inside the root (or the document)
//   --root S / --replica-root S [--root-index N]   boxes are relative to it, to 4 decimals
//   --width --height --dark --light --wait --prep --replica-prep
// Actions, run in the order given (repeatable):
//   --state NAME   --click S   --hover S   --fill "S=>text"   --press Key   --pause ms
// Time
//   --at 0,60,200,600         read at these ms after the actions (a press, a copy-to-clipboard swap)
//   --sample 4000 [--every 0] sample the first match's transform/opacity for 4s (every frame by
//                             default) and describe it: range per channel, period, the shape
//                             of one cycle at ten points. Compares loops without freezing them.
//
// Output: per match, one line when both pages agree ("="), else only the values that differ.
import fs from "node:fs";
import { launch, list, loadConfig, openPage, parseArgs, path, setLight, sleep } from "./lib.mjs";

const args = parseArgs();
const config = args.config ? await loadConfig(args.config) : {};
const elements = config.elements ?? {};
const originalUrl = args.url ?? config.original;
const replicaUrl = args.replica ?? (args.config ? config.replica : undefined);
if (!originalUrl || !(args.selector || args.sample)) {
  console.error("usage: measure.mjs (--config FILE | --url URL [--replica URL]) --selector S [options]; see the header");
  process.exit(1);
}

const PRESETS = {
  box: "width,height,color,background-color,font-size,font-weight,line-height,padding,margin,border-radius,gap",
  text: "font-family,font-size,font-weight,line-height,letter-spacing,font-feature-settings,font-variation-settings,text-rendering,-webkit-font-smoothing,font-synthesis-weight,color",
  layers: "will-change,transform,opacity,filter,backdrop-filter,isolation,contain,mix-blend-mode,position,z-index,overflow,mask-image,clip-path,translate,scale,rotate",
  motion: "transform,opacity,filter,translate,scale,rotate,transition-property,transition-duration,transition-timing-function,transition-delay,animation-name,animation-duration",
  "all-box": "display,position,width,height,padding,margin,border-width,border-radius,box-sizing,min-width,max-width,flex,align-self,justify-self",
};
const expand = (spec, fallback) =>
  String(spec ?? fallback)
    .split(",")
    .flatMap((name) => (PRESETS[name.trim()] ?? name.trim()).split(","))
    .filter(Boolean);
const props = expand(args.props, args.ancestors ? "layers" : "box");
const vars = list(args.vars).flatMap((value) => String(value).split(",")).filter(Boolean);
const attrs = list(args.attrs).flatMap((value) => String(value).split(",")).filter(Boolean);
const limit = Number(args.limit ?? 5);
const times = args.at ? String(args.at).split(",").map(Number) : [null];

// Actions keep the order they were typed in.
const argv = process.argv.slice(2);
const actions = [];
for (let i = 0; i < argv.length; i++) {
  const [flag, inline] = argv[i].split(/=(.*)/s);
  const kind = flag.replace(/^--/, "");
  if (!["state", "click", "hover", "fill", "press", "pause"].includes(kind)) continue;
  actions.push({ kind, value: inline ?? argv[++i] });
}
const stateOf = (name) =>
  (config.states ?? []).find((state) => state.name === name) ?? (elements.cases ?? config.cases ?? []).find((testCase) => testCase.name === name);
for (const action of actions.filter((a) => a.kind === "state")) {
  if (!stateOf(action.value)) {
    console.error(`no state or case named "${action.value}" in ${args.config ?? "(no --config)"}`);
    process.exit(1);
  }
}
// A state brings its own viewport, theme and prep, as it does in verify.
const firstState = actions.find((a) => a.kind === "state") && stateOf(actions.find((a) => a.kind === "state").value);

async function open(browser, url, isReplica) {
  const viewport = { ...(config.viewport ?? {}), ...(elements.viewport ?? {}), ...(firstState?.viewport ?? {}) };
  const dark = args.light ? false : !!(args.dark || firstState?.dark || (firstState === undefined && (elements.dark ?? config.dark)));
  const prep = [
    args.prep ?? (elements.prep ?? config.prep),
    firstState?.prep,
    isReplica ? (args["replica-prep"] ?? elements.replicaPrep ?? config.replicaPrep) : undefined,
  ]
    .filter(Boolean)
    .join(";");
  const opened = await openPage(browser, url, {
    width: Number(args.width ?? viewport.width ?? 1440),
    height: Number(args.height ?? viewport.height ?? 900),
    wait: Number(args.wait ?? config.wait ?? 2500),
    fullHeight: firstState?.fullHeight ?? false,
    dark,
    prep: prep || undefined,
  });
  if (args.light) await setLight(opened.page);
  return opened;
}

async function act(page) {
  for (const [i, { kind, value }] of actions.entries()) {
    // With --at / --sample the clock starts when the last action fires: no wait after it.
    const settleAfter = i < actions.length - 1 || !(args.at || args.sample);
    if (kind === "state") await stateOf(value).run?.(page);
    else if (kind === "pause") await sleep(Number(value));
    else if (kind === "press") await page.keyboard.press(value);
    else {
      const [selector, text] = kind === "fill" ? value.split("=>") : [value];
      // Page-wide, like a state's own locators: the target can be a portal outside the root.
      const target = page.locator(selector).first();
      await target.scrollIntoViewIfNeeded();
      if (kind === "click") await target.click();
      if (kind === "hover") await target.hover();
      if (kind === "fill") await target.fill(text ?? "");
      if (settleAfter) await sleep(Number(args["action-wait"] ?? 600));
    }
  }
}

function rootOf(isReplica) {
  if (isReplica) {
    const selector = args["replica-root"] ?? args.root ?? config.replicaRoot ?? elements.replicaSelector ?? elements.selector;
    return { selector, index: Number(args["replica-root-index"] ?? args["root-index"] ?? (args["replica-root"] || args.root || config.replicaRoot ? 0 : elements.replicaIndex ?? 0)) };
  }
  const selector = args.root ?? config.originalRoot ?? elements.selector;
  return { selector, index: Number(args["root-index"] ?? 0) };
}

const read = (page, isReplica) =>
  page.evaluate(
    ({ root, selector, props, vars, attrs, text, limit, all, ancestors }) => {
      const base = root.selector ? document.querySelectorAll(root.selector)[root.index] : null;
      if (root.selector && !base) return { error: `root not found: ${root.selector} [${root.index}]` };
      const origin = base ? base.getBoundingClientRect() : { x: 0, y: 0 };
      const fmt = (n) => String(Math.round(n * 10000) / 10000);
      const label = (el) =>
        `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${(el.getAttribute("class") ?? "")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 4)
          .map((c) => `.${c}`)
          .join("")}`;
      const describe = (el) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const row = { box: `${fmt(box.x - origin.x)},${fmt(box.y - origin.y)} ${fmt(box.width)}x${fmt(box.height)}` };
        for (const p of props) row[p] = style.getPropertyValue(p).trim();
        for (const v of vars) row[v] = style.getPropertyValue(v).trim() || "(unset)";
        for (const a of attrs) row[`@${a}`] = el.getAttribute(a) ?? "(none)";
        if (text) row["@text"] = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
        return row;
      };
      const matches = [...(base ?? document).querySelectorAll(selector)].filter((el) => all || el.getClientRects().length > 0).slice(0, limit);
      return {
        rows: matches.map((el) => {
          if (!ancestors) return { label: label(el), values: describe(el) };
          const chain = [];
          for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
            chain.push({ label: label(n), values: describe(n) });
            if (n === base) break;
          }
          return { label: label(el), chain };
        }),
      };
    },
    { root: rootOf(isReplica), selector: isReplica ? (args["replica-selector"] ?? args.selector) : args.selector, props, vars, attrs, text: !!args.text, limit, all: !!args.all, ancestors: !!args.ancestors },
  );

/** Samples one element's transform and opacity for `ms`, every frame or every `every` ms. */
const sample = (page, isReplica) =>
  page.evaluate(
    async ({ root, selector, ms, every }) => {
      const base = root.selector ? document.querySelectorAll(root.selector)[root.index] : document;
      const el = selector ? base?.querySelector(selector) : base;
      if (!el) return { error: "no match" };
      const rows = [];
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        const style = getComputedStyle(el);
        const m = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
        rows.push([performance.now() - t0, m.m41, m.m42, Math.hypot(m.a, m.b), Math.atan2(m.b, m.a) * (180 / Math.PI), Number(style.opacity)]);
        await new Promise((resolve) => (every ? setTimeout(resolve, every) : requestAnimationFrame(resolve)));
      }
      return { rows };
    },
    { root: rootOf(isReplica), selector: isReplica ? (args["replica-selector"] ?? args.selector) : args.selector, ms: Number(args.sample), every: Number(args.every ?? 0) },
  );

const CHANNELS = ["x", "y", "scale", "rotate", "opacity"];
/** Range, period (from upward mean crossings) and one cycle at ten points, per moving channel. */
function describeMotion(rows) {
  const out = {};
  CHANNELS.forEach((name, k) => {
    const values = rows.map((row) => row[k + 1]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max - min < (name === "opacity" || name === "scale" ? 0.005 : 0.05)) return;
    const mean = (min + max) / 2;
    const ups = [];
    for (let i = 1; i < rows.length; i++) if (values[i - 1] < mean && values[i] >= mean) ups.push(rows[i][0]);
    const periods = ups.slice(1).map((t, i) => t - ups[i]);
    const period = periods.length ? periods.reduce((a, b) => a + b, 0) / periods.length : null;
    const at = (t) => values[rows.reduce((best, row, i) => (Math.abs(row[0] - t) < Math.abs(rows[best][0] - t) ? i : best), 0)];
    out[name] = {
      range: `${min.toFixed(3)} … ${max.toFixed(3)}`,
      period: period ? `${Math.round(period)}ms (${periods.length} cycles)` : "no full cycle — sample longer",
      shape: period ? Array.from({ length: 10 }, (_, i) => Number(at(ups[0] + (i / 10) * period).toFixed(2))) : [],
    };
  });
  return out;
}

const browser = await launch();
const sides = [["original", originalUrl, false], ...(replicaUrl ? [["replica", replicaUrl, true]] : [])];
// One page at a time: two pages animating at once share the CPU and skew every timing read.
const results = [];
for (const [name, url, isReplica] of sides) {
  results.push(
    await (async () => {
    const { page, errors } = await open(browser, url, isReplica);
    await act(page);
    if (args.sample) {
      const motion = await sample(page, isReplica);
      await page.close();
      return { name, errors, motion };
    }
    const snapshots = [];
    let elapsed = 0;
    for (const t of times) {
      if (t !== null) await sleep(Math.max(0, t - elapsed)), (elapsed = Math.max(elapsed, t));
      snapshots.push(await read(page, isReplica));
    }
    await page.close();
    return { name, errors, snapshots };
    })(),
  );
}
await browser.close();

for (const { name, errors } of results) {
  const thrown = errors.filter((error) => error.startsWith("pageerror"));
  if (thrown.length) console.log(`${name}: ${thrown.join(" | ")}`);
}

if (args.sample) {
  const [a, b] = results.map((r) => (r.motion.error ? r.motion : describeMotion(r.motion.rows)));
  for (const name of new Set([...Object.keys(a), ...Object.keys(b ?? {})])) {
    if (name === "error") continue;
    console.log(`\n${name}`);
    console.log(`  original ${JSON.stringify(a[name] ?? "(still)")}`);
    if (b) console.log(`  replica  ${JSON.stringify(b[name] ?? "(still)")}`);
    if (a[name]?.shape?.length && b?.[name]?.shape?.length) {
      const delta = a[name].shape.map((v, i) => Number(Math.abs(v - b[name].shape[i]).toFixed(2)));
      console.log(`  |Δ| per tenth of a cycle ${JSON.stringify(delta)}  max ${Math.max(...delta)}`);
    }
  }
  if (a.error || b?.error) console.log(`\n${a.error ? `original: ${a.error}` : ""} ${b?.error ? `replica: ${b.error}` : ""}`);
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(results.map((r) => ({ name: r.name, rows: r.motion.rows })), null, 1));
  process.exit(0);
}

const diffLine = (prefix, a, b, brief) => {
  if (!b) return [`${prefix} ${JSON.stringify(a)}`];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const differing = keys.filter((key) => a[key] !== b[key]);
  if (!differing.length) return [`= ${prefix}${brief ? `  ${a.box}` : ` ${JSON.stringify(a)}`}`];
  return [`≠ ${prefix}`, ...differing.map((key) => `    ${key.padEnd(26)} ${a[key] ?? "(absent)"}  |  ${b[key] ?? "(absent)"}`)];
};

times.forEach((t, ti) => {
  if (t !== null) console.log(`\n── t = ${t}ms after the actions`);
  const [a, b] = results.map((r) => r.snapshots[ti]);
  for (const [name, snapshot] of [["original", a], ["replica", b]]) if (snapshot?.error) console.log(`${name}: ${snapshot.error}`);
  if (a.error || b?.error) return;
  if (b && a.rows.length !== b.rows.length) console.log(`COUNT original ${a.rows.length} | replica ${b.rows.length}`);
  a.rows.forEach((row, i) => {
    const other = b?.rows[i];
    if (!row.chain) {
      for (const line of diffLine(`#${i} ${row.label}${other && other.label !== row.label ? ` | ${other.label}` : ""}`, row.values, other?.values)) console.log(line);
      return;
    }
    console.log(`#${i} ${row.label}: element → root`);
    row.chain.forEach((link, depth) => {
      const peer = other?.chain?.[depth];
      for (const line of diffLine(`  ${depth} ${link.label}${peer && peer.label !== link.label ? ` | ${peer.label}` : ""}`, link.values, peer?.values, true)) console.log(`  ${line}`);
    });
    if (other?.chain && other.chain.length !== row.chain.length) console.log(`  depth original ${row.chain.length} | replica ${other.chain.length}`);
  });
  if (!a.rows.length) console.log("no match on original");
});
