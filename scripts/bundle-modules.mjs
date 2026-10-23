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
  // A chunk that throws before it registers (or wraps its push in something the sandbox does
  // not provide) still holds `,<id>,e=>{…}` factories: cut them out by a balanced-brace scan.
  if (!registered && /TURBOPACK|webpackChunk/.test(code)) {
    for (const [id, src] of scanFactories(code)) {
      if (!modules.has(id)) modules.set(id, { file, bundler: "scanned", src });
      registered++;
    }
  }
  if (!registered) loose.push({ file, code });
}

/** Factories after a numeric id, found textually. Honours strings, templates, regexes and comments. */
function scanFactories(code) {
  const found = [];
  const head = /[,[](\d{2,8}),(?=\(?\s*[A-Za-z_$][\w$]*\s*(?:,[^)]*\))?\s*=>|function\b)/g;
  let match;
  while ((match = head.exec(code))) {
    const from = match.index + match[0].length;
    const end = closingBrace(code, code.indexOf("{", from));
    if (end < 0) continue;
    found.push([match[1], code.slice(from, end + 1)]);
    head.lastIndex = end + 1;
  }
  return found;
}

function closingBrace(code, start) {
  if (start < 0) return -1;
  let depth = 0;
  let prev = "";
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(code, i);
      prev = c;
      continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      i = code.indexOf("*/", i + 2) + 1;
      if (i <= 0) return -1;
      continue;
    }
    // A slash after an operator or an opening bracket starts a regex literal, not a division.
    if (c === "/" && /[=(,:[!&|?{};+\-*%~^]/.test(prev)) {
      for (i++; i < code.length && code[i] !== "/"; i++) {
        if (code[i] === "\\") i++;
        else if (code[i] === "[") while (++i < code.length && code[i] !== "]") if (code[i] === "\\") i++;
      }
      prev = "/";
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
    if (!/\s/.test(c)) prev = c;
  }
  return -1;
}

function skipString(code, start) {
  const quote = code[start];
  for (let i = start + 1; i < code.length; i++) {
    if (code[i] === "\\") i++;
    else if (code[i] === quote) return i;
    else if (quote === "`" && code[i] === "$" && code[i + 1] === "{") {
      let depth = 1;
      for (i += 2; i < code.length && depth; i++) {
        if (code[i] === "{") depth++;
        else if (code[i] === "}") depth--;
        else if (code[i] === '"' || code[i] === "'" || code[i] === "`") i = skipString(code, i);
      }
      i--;
    }
  }
  return code.length;
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
