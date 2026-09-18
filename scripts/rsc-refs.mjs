// Which client components a React Server Components page mounts, and in which chunk each
// one lives. The RSC payload is streamed inside `self.__next_f.push([1,"..."])` string
// chunks in the HTML; its `NN:I[moduleId,[chunks],"Export"]` lines are the client
// references. Use it to turn "which of these 200 modules build this page" into a short
// list before grepping with bundle-modules.mjs.
//
//   node rsc-refs.mjs <capture/000-document-page | https://example.com/page> [payload.txt]
//
// The joined payload is written to payload.txt (default rsc.txt): it also contains the
// props the server passed to each client component, which is often the page's data.
import { fs } from "./lib.mjs";

const [, , source, out = "rsc.txt"] = process.argv;
if (!source) {
  console.error("usage: node rsc-refs.mjs <html-file|url> [payload.txt]");
  process.exit(1);
}

const html = /^https?:\/\//.test(source) ? await (await fetch(source)).text() : fs.readFileSync(source, "utf8");
const parts = [];
for (const match of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) parts.push(JSON.parse(match[1]));
const payload = parts.join("");
fs.writeFileSync(out, payload);

const refs = [...payload.matchAll(/^([0-9a-f]+):I\[(\d+),\[([^\]]*)\],"([^"]*)"/gm)];
// A route's references usually share one long chunk list: print each list once, as a
// numbered set, instead of forty file names on every line.
const sets = new Map();
for (const [, id, moduleId, chunks, exportName] of refs) {
  const files = [...chunks.matchAll(/"([^"]+.js)"/g)].map((m) => m[1]);
  const key = files.join(", ");
  if (files.length > 2 && !sets.has(key)) sets.set(key, sets.size + 1);
  const where = !files.length ? "" : files.length > 2 ? `  [chunk set #${sets.get(key)}, ${files.length} files]` : `  [${key}]`;
  console.log(`$L${id} -> module ${moduleId} export ${exportName || "(default)"}${where}`);
}
for (const [key, number] of sets) console.log(`chunk set #${number}: ${key}`);
console.log(`${refs.length} client reference(s); payload -> ${out} (${payload.length} chars)`);
