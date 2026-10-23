// Small PNG helpers for investigating a diff.
//
//   node png-tools.mjs diff a.png b.png out.png [--threshold 40]
//   node png-tools.mjs pair a.png b.png x y w h out.png [--scale 3]   (side by side, nearest-neighbour zoom)
//   node png-tools.mjs top a.png b.png [n]          the n strongest differing pixels, with both colours
//   node png-tools.mjs at a.png b.png x y [x y …]   both colours at those pixels
//   node png-tools.mjs fringe a.png [b.png …] [--region x,y,w,h]   colour-fringed px (LCD subpixel text)
//
// "pair" is how sub-pixel problems become visible: a 1px shift, a stroke that is
// 18 vs 19px wide, a hover color that stayed gray on one side.
import { PNG } from "pngjs";
import { diffPngs, formatDiff, fs, parseArgs, readPng } from "./lib.mjs";

const args = parseArgs();
const [command, ...rest] = args._;

if (command === "diff") {
  const [a, b, out] = rest;
  console.log(formatDiff("diff", diffPngs(a, b, out, { threshold: Number(args.threshold ?? 40) })));
} else if (command === "pair") {
  const [a, b, x, y, w, h, out] = rest;
  const scale = Number(args.scale ?? 3);
  const [left, top, width, height] = [x, y, w, h].map(Number);
  const sources = [readPng(a), readPng(b)];
  const gap = 4;
  const result = new PNG({ width: (width * 2 + gap) * scale, height: height * scale });
  result.data.fill(255);
  sources.forEach((source, column) => {
    for (let yy = 0; yy < height * scale; yy++) {
      for (let xx = 0; xx < width * scale; xx++) {
        const sx = left + Math.floor(xx / scale);
        const sy = top + Math.floor(yy / scale);
        if (sx >= source.width || sy >= source.height) continue;
        const from = (source.width * sy + sx) << 2;
        const to = (result.width * yy + xx + column * (width + gap) * scale) << 2;
        source.data.copy(result.data, to, from, from + 4);
      }
    }
  });
  for (let yy = 0; yy < result.height; yy++) {
    for (let xx = width * scale; xx < (width + gap) * scale; xx++) {
      const to = (result.width * yy + xx) << 2;
      result.data[to] = 255;
      result.data[to + 1] = result.data[to + 2] = 0;
    }
  }
  fs.writeFileSync(out, PNG.sync.write(result));
  console.log(`${out}: left = ${a}, right = ${b}`);
} else if (command === "top" || command === "at") {
  const [a, b, ...numbers] = rest;
  const [left, right] = [readPng(a), readPng(b)];
  const color = (png, x, y) => {
    const i = (png.width * y + x) << 2;
    return [...png.data.subarray(i, i + 4)].join(",");
  };
  if (left.width !== right.width || left.height !== right.height) console.log(`size ${left.width}x${left.height} vs ${right.width}x${right.height}`);
  if (command === "at") {
    for (let i = 0; i + 1 < numbers.length; i += 2) {
      const [x, y] = [Number(numbers[i]), Number(numbers[i + 1])];
      console.log(`(${x},${y})  a ${color(left, x, y)}   b ${color(right, x, y)}`);
    }
  } else {
    const rows = [];
    for (let y = 0; y < Math.min(left.height, right.height); y++) {
      for (let x = 0; x < Math.min(left.width, right.width); x++) {
        const i = (left.width * y + x) << 2;
        const j = (right.width * y + x) << 2;
        const delta = Math.max(...[0, 1, 2].map((k) => Math.abs(left.data[i + k] - right.data[j + k])));
        if (delta) rows.push([delta, x, y]);
      }
    }
    rows.sort((p, q) => q[0] - p[0]);
    console.log(`${rows.length} differing px`);
    for (const [delta, x, y] of rows.slice(0, Number(numbers[0] ?? 12))) console.log(`Δ${String(delta).padStart(3)} (${x},${y})  a ${color(left, x, y)}  b ${color(right, x, y)}`);
  }
} else if (command === "fringe") {
  // Grayscale-antialiased text has R≈G≈B on a neutral page; LCD (subpixel) text has coloured
  // edges. One side with fringes and one without is a compositing difference, not a design one.
  const [x0, y0, w0, h0] = args.region ? String(args.region).split(",").map(Number) : [];
  for (const file of rest) {
    const png = readPng(file);
    const [x1, y1] = [x0 ?? 0, y0 ?? 0];
    const [x2, y2] = [Math.min(png.width, x1 + (w0 ?? png.width)), Math.min(png.height, y1 + (h0 ?? png.height))];
    let count = 0;
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const i = (png.width * y + x) << 2;
        if (Math.max(Math.abs(png.data[i] - png.data[i + 1]), Math.abs(png.data[i + 1] - png.data[i + 2])) > 12) count++;
      }
    }
    console.log(`${file}: ${count} colour-fringed px in ${x2 - x1}x${y2 - y1}`);
  }
} else {
  console.log("usage: png-tools.mjs diff a b out | pair a b x y w h out [--scale 3] | top a b [n] | at a b x y… | fringe a… [--region x,y,w,h]");
}
