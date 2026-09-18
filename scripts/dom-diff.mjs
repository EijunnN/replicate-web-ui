// Element-level diff: for every element with its own text (plus svgs, buttons, inputs,
// images) compares box, font and colors between original and replica, matched by text
// and order. Colors are normalized to RGBA through a canvas, because one build may
// serialize oklch() and another lab() for the same color.
//
//   node dom-diff.mjs --original URL --replica URL [--width 1440] [--tolerance 0.6]
//        [--original-root main] [--replica-root "[data-slot=app]"] [--limit 80]
//        [--out dom] [--refresh] [--json result.json]
//
// The original's rows are cached in <out>/cache until `--refresh`. Exit code 1 on any mismatch.
//
// "COUNT" lines mean an element exists a different number of times (missing sr-only
// text, an extra wrapper svg); fix those first because they shift the matching.
import { cacheKey, ensureDir, finish, fs, launch, need, openPage, parseArgs, path } from "./lib.mjs";

const args = parseArgs();
need(args, "original", "replica");
const width = Number(args.width ?? 1440);
const tolerance = Number(args.tolerance ?? 0.6);
const limit = Number(args.limit ?? 80);
const browser = await launch();

const collect = (rootSelector) => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (value) => {
    if (!value || value === "rgba(0, 0, 0, 0)" || value === "transparent") return "transparent";
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].join(",");
  };
  const root = (rootSelector && document.querySelector(rootSelector)) || document.body;
  const rows = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const el = walker.currentNode;
    const tag = el.tagName.toLowerCase();
    if (el.closest("svg") && tag !== "svg") continue;
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
    const structural = ["svg", "button", "input", "img", "kbd"].includes(tag) || el.getAttribute("data-slot") === "card";
    if (!text && !structural) continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const cs = getComputedStyle(el);
    rows.push({
      key: (text || `${tag}${el.getAttribute("aria-label") ? `:${el.getAttribute("aria-label")}` : ""}`).slice(0, 40),
      x: box.x, y: box.y, w: box.width, h: box.height,
      font: `${cs.fontSize}/${cs.lineHeight} ${cs.fontWeight} ${cs.letterSpacing}`,
      color: rgba(cs.color),
      background: rgba(cs.backgroundColor),
      border: `${cs.borderTopWidth} ${rgba(cs.borderTopColor)} r${cs.borderTopLeftRadius}`,
    });
  }
  return rows;
};

const cacheDir = ensureDir(path.join(args.out ?? "dom", "cache"));
const cached = path.join(cacheDir, `${cacheKey({ url: args.original, width, root: args["original-root"] ?? "" })}.json`);
let a;
let originalHeight;
if (!args.refresh && fs.existsSync(cached)) {
  ({ rows: a, height: originalHeight } = JSON.parse(fs.readFileSync(cached, "utf8")));
} else {
  const original = await openPage(browser, args.original, { width, fullHeight: true, wait: 3000 });
  a = await original.page.evaluate(collect, args["original-root"]);
  originalHeight = original.height;
  await original.page.close();
  fs.writeFileSync(cached, JSON.stringify({ rows: a, height: originalHeight }));
}
const replica = await openPage(browser, args.replica, { width, fullHeight: originalHeight, wait: 3000 });
const b = await replica.page.evaluate(collect, args["replica-root"]);
await browser.close();

const group = (rows) => rows.reduce((map, row) => map.set(row.key, [...(map.get(row.key) ?? []), row]), new Map());
const A = group(a);
const B = group(b);
const lines = [];
for (const [key, rowsA] of A) {
  const rowsB = B.get(key) ?? [];
  if (rowsA.length !== rowsB.length) lines.push(`COUNT ${JSON.stringify(key)} original=${rowsA.length} replica=${rowsB.length}`);
  rowsA.forEach((ra, index) => {
    const rb = rowsB[index];
    if (!rb) return;
    const diffs = [];
    for (const p of ["x", "y", "w", "h"]) if (Math.abs(ra[p] - rb[p]) > tolerance) diffs.push(`${p} ${ra[p].toFixed(1)}→${rb[p].toFixed(1)}`);
    for (const p of ["font", "color", "background", "border"]) if (ra[p] !== rb[p]) diffs.push(`${p} ${ra[p]}→${rb[p]}`);
    if (diffs.length) lines.push(`${JSON.stringify(key)}#${index}  ${diffs.join("  ")}`);
  });
}
for (const [key, rowsB] of B) if (!A.has(key)) lines.push(`EXTRA ${JSON.stringify(key)} ×${rowsB.length}`);
lines.slice(0, limit).forEach((line) => console.log(line));
if (lines.length > limit) console.log(`… ${lines.length - limit} more`);
console.log(`elements original ${a.length}, replica ${b.length}, mismatches ${lines.length}`);
finish(args, { check: "dom", ok: !lines.length, items: lines.map((line) => ({ name: line.slice(0, 160), ok: false })) });
