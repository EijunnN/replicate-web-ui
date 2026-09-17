// Small PNG helpers for investigating a diff.
//
//   node png-tools.mjs diff a.png b.png out.png [--threshold 40]
//   node png-tools.mjs pair a.png b.png x y w h out.png [--scale 3]   (side by side, nearest-neighbour zoom)
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
} else {
  console.log("usage: png-tools.mjs diff a b out | pair a b x y w h out [--scale 3]");
}
