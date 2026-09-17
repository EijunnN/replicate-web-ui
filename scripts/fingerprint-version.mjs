// Finds which published versions of a library contain a code fingerprint, so you can pin
// the exact version the original ships. Grep the original bundle for a distinctive
// expression first (minified: `y>1&&(y>>=0)`), then look for its unminified form here.
//
//   node fingerprint-version.mjs --pkg recharts --file es6/state/selectors/combiners/combineAllBarPositions.js
//        --needle "originalSize >>= 0" [--needle "niceTicks"] [--from 3.0.0] [--to 3.99.0]
//
// Every --needle must be present for a version to match. Files that do not exist in a
// version print "no file" (the module may have moved; try another path).
import { execSync } from "node:child_process";
import { list, need, parseArgs } from "./lib.mjs";

const args = parseArgs();
need(args, "pkg", "file", "needle");
const parse = (version) => version.split(/[.-]/).slice(0, 3).map(Number);
const compare = (a, b) => {
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};
const versions = JSON.parse(execSync(`npm view ${args.pkg} versions --json`, { encoding: "utf8" }))
  .filter((version) => !/-/.test(version))
  .filter((version) => (!args.from || compare(version, args.from) >= 0) && (!args.to || compare(version, args.to) <= 0));
const needles = list(args.needle);

for (const version of versions) {
  const response = await fetch(`https://unpkg.com/${args.pkg}@${version}/${args.file}`);
  if (!response.ok) {
    console.log(`${version.padEnd(10)} no file`);
    continue;
  }
  const source = await response.text();
  const hits = needles.map((needle) => source.includes(needle));
  console.log(`${version.padEnd(10)} ${hits.every(Boolean) ? "MATCH" : "     "}  ${needles.map((needle, i) => `${hits[i] ? "+" : "-"}${JSON.stringify(needle)}`).join("  ")}`);
}
