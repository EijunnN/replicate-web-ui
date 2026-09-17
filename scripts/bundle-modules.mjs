// Splits captured Turbopack / webpack chunks into individual modules so you can read
// one component at a time instead of a 600 KB minified file.
//
//   node bundle-modules.mjs --dir capture --out modules --grep "Store conversion" --grep "Quick actions"
//   node bundle-modules.mjs --dir capture --out modules --id 920904,84153 [--deps]
//   node bundle-modules.mjs --dir capture --out modules --index        (list every module id + size)
//
// --grep  writes every module whose source contains the text (UI copy is the best needle).
// --id    writes those module ids. --deps also writes the modules they import, one level deep.
// Files that are not Turbopack/webpack chunks (Vite/Rollup ESM, plain bundles) are grepped
// raw and written beautified whole, so the same command still finds the code.
import vm from "node:vm";
import beautify from "js-beautify";
import { ensureDir, fs, list, need, parseArgs, path } from "./lib.mjs";

const args = parseArgs();
need(args, "dir", "out");
const out = ensureDir(args.out);
const pretty = (code) => beautify.js(code, { indent_size: 2 });

const modules = new Map(); // id -> { file, bundler, src }
const loose = []; // files that did not register modules

for (const file of fs.readdirSync(args.dir).filter((name) => /script/.test(name) || name.endsWith(".js"))) {
  const code = fs.readFileSync(path.join(args.dir, file), "utf8");
  const sandbox = { TURBOPACK: [], console: { log() {}, warn() {}, error() {} } };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  let registered = 0;
  try {
    vm.runInNewContext(code, sandbox, { timeout: 3000 });
  } catch {
    // Runtime chunks touch the DOM; module registration usually happens before that.
  }
  // Turbopack: TURBOPACK.push([currentScript, id, id?, factory, id, factory, ...])
  for (const entry of sandbox.TURBOPACK ?? []) {
    if (!Array.isArray(entry)) continue;
    let ids = [];
    for (const item of entry.slice(1)) {
      if (typeof item === "number" || typeof item === "string") ids.push(item);
      else if (typeof item === "function") {
        for (const id of ids) modules.set(String(id), { file, bundler: "turbopack", src: item.toString() });
        registered += ids.length;
        ids = [];
      }
    }
  }
  // webpack: (self.webpackChunkX ||= []).push([[chunkIds], { moduleId: factory }, runtime?])
  for (const key of Object.keys(sandbox).filter((name) => name.startsWith("webpackChunk"))) {
    for (const entry of sandbox[key] ?? []) {
      const factories = Array.isArray(entry) ? entry[1] : null;
      if (!factories || typeof factories !== "object") continue;
      for (const [id, factory] of Object.entries(factories)) {
        if (typeof factory !== "function") continue;
        modules.set(String(id), { file, bundler: "webpack", src: factory.toString() });
        registered++;
      }
    }
  }
  if (!registered) loose.push({ file, code });
}

const importsOf = (src) => [
  ...new Set([...src.matchAll(/\b[a-z]\.(?:i|r|A)\((\d+)\)/g), ...src.matchAll(/\b[a-z]\((\d{2,})\)/g)].map((m) => m[1])),
];

function write(id, reason) {
  const mod = modules.get(id);
  if (!mod) {
    console.log(`missing  ${id}`);
    return [];
  }
  const target = path.join(out, `${id}.js`);
  fs.writeFileSync(target, pretty(mod.src));
  const deps = importsOf(mod.src).filter((dep) => modules.has(dep));
  console.log(`${reason.padEnd(8)} ${id.padEnd(8)} ${mod.file}  ${mod.src.length}b  imports: ${deps.join(", ") || "-"}`);
  return deps;
}

if (args.index) {
  const rows = [...modules.entries()].map(([id, mod]) => `${id}\t${mod.bundler}\t${mod.file}\t${mod.src.length}`);
  fs.writeFileSync(path.join(out, "_index.tsv"), rows.join("\n"));
  console.log(`${modules.size} modules indexed -> ${path.join(out, "_index.tsv")}; ${loose.length} non-modular files`);
}

const written = new Set();
for (const needle of list(args.grep)) {
  const hits = [...modules.entries()].filter(([, mod]) => mod.src.includes(needle));
  console.log(`\n"${needle}": ${hits.length} module(s)`);
  for (const [id] of hits) {
    if (written.has(id)) continue;
    written.add(id);
    const deps = write(id, "grep");
    if (args.deps) for (const dep of deps) if (!written.has(dep)) written.add(dep), write(dep, "dep");
  }
  for (const { file, code } of loose.filter((entry) => entry.code.includes(needle))) {
    const target = path.join(out, `${file}.pretty.js`);
    if (!fs.existsSync(target)) fs.writeFileSync(target, pretty(code));
    console.log(`raw      ${file} (not modular) -> ${target}`);
  }
}

for (const id of list(args.id).flatMap((value) => String(value).split(","))) {
  if (written.has(id)) continue;
  written.add(id);
  const deps = write(id, "id");
  if (args.deps) for (const dep of deps) if (!written.has(dep)) written.add(dep), write(dep, "dep");
}

if (!args.index && !args.grep && !args.id) {
  console.log(`${modules.size} modules found in ${new Set([...modules.values()].map((m) => m.file)).size} chunks; ${loose.length} non-modular files. Use --grep, --id or --index.`);
}
