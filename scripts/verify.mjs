// One command for the whole verification: runs every check the config asks for, writes
// the full output of each to <out>/logs, and prints a short report with a verdict.
// The checks are the same scripts you can run by hand; this only runs them, reads their
// results and decides what is left to look at.
//
//   node verify.mjs --config replica.config.mjs            full pass (original from cache)
//   node verify.mjs --config replica.config.mjs --changed  only what failed last time
//   node verify.mjs --config replica.config.mjs --final    full pass, original recaptured
//        [--only states,computed] [--jobs 4] [--refresh]
//
// Which checks run (override with `checks: [...]` in the config):
//   page: {...}      → compare (light, and dark when page.dark), dom, states
//   elements: {...}  → elements
//   states: [...]    → computed (and states, when `page` is set)
//   always           → theme (and theme-dark when anything is checked in dark)
//
// The loop is `--changed` after every fix: seconds, because the original is cached and
// only the failing cases rerun. It can end at "LOOP CLEAN", never at "PASS": a fix in one
// place moves another (a dependency pin, a wrapper), so only a full pass can say PASS, and
// only `--final`, which recaptures the original, is the one you deliver on.
// Exit code 0 on PASS / LOOP CLEAN, 1 otherwise.
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureDir, fs, need, parseArgs, path } from "./lib.mjs";

const args = parseArgs();
need(args, "config");
const configPath = path.resolve(args.config);
const config = (await import(pathToFileURL(configPath).href)).default;
const here = path.dirname(fileURLToPath(import.meta.url));
const out = ensureDir(config.out ?? "verify");
const logs = ensureDir(path.join(out, "logs"));
const reportFile = path.join(out, "report.json");
const previous = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : null;
const refresh = args.refresh || args.final;

const anyDark =
  !!config.page?.dark ||
  !!config.dark ||
  (config.states ?? []).some((state) => state.dark) ||
  !!config.elements?.dark ||
  (config.elements?.cases ?? []).some((testCase) => testCase.dark);

const wanted =
  config.checks ??
  [
    config.page && "compare",
    config.page?.dark && "compare-dark",
    config.page && "dom",
    config.elements && "elements",
    config.page && config.states?.length && "states",
    config.states?.length && "computed",
    "theme",
    anyDark && "theme-dark",
  ].filter(Boolean);

const flag = (name, value) =>
  value === undefined || value === null || value === false ? [] : value === true ? [`--${name}`] : [`--${name}`, String(value)];
const roots = [...flag("original-root", config.originalRoot), ...flag("replica-root", config.replicaRoot)];
const urls = ["--original", config.original, "--replica", config.replica];
const compareArgs = (dark) => [
  ...urls,
  "--out",
  path.join(out, "compare"),
  ...flag("widths", (config.page?.widths ?? [1440, 1280, 1024, 800, 390]).join(",")),
  ...flag("wait", config.page?.wait ?? config.wait),
  ...flag("threshold", config.threshold),
  ...flag("prep", config.prep),
  ...flag("replica-prep", config.replicaPrep),
  ...flag("dark", dark),
];
const commands = {
  compare: () => ["compare.mjs", compareArgs(false)],
  "compare-dark": () => ["compare.mjs", compareArgs(true)],
  dom: () => ["dom-diff.mjs", [...urls, "--out", path.join(out, "dom"), ...roots, ...flag("width", config.viewport?.width), "--limit", "400"]],
  elements: () => ["element-diff.mjs", ["--config", configPath, "--out", path.join(out, "elements")]],
  states: () => ["states.mjs", ["--config", configPath, "--out", path.join(out, "states")]],
  computed: () => ["computed-diff.mjs", ["--config", configPath, "--out", path.join(out, "computed")]],
  theme: () => ["theme-leak.mjs", [...urls, ...roots, ...flag("ignore", config.ignoreTokens)]],
  "theme-dark": () => ["theme-leak.mjs", [...urls, ...roots, ...flag("ignore", config.ignoreTokens), "--dark"]],
};
// Checks whose items can be rerun one by one, and the flag that selects them.
const selectable = { elements: "only", states: "only", computed: "only", compare: "widths", "compare-dark": "widths" };

function run(check, extra) {
  const [script, scriptArgs] = commands[check]();
  const json = path.join(logs, `${check}.json`);
  fs.rmSync(json, { force: true });
  const all = [path.join(here, script), ...scriptArgs, ...extra, ...flag("refresh", refresh), ...flag("jobs", args.jobs), "--json", json];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, all, { stdio: ["ignore", "pipe", "pipe"] });
    const log = fs.createWriteStream(path.join(logs, `${check}.log`));
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.on("close", () => {
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      if (!fs.existsSync(json)) resolve({ check, ok: false, crashed: true, items: [], seconds });
      else resolve({ ...JSON.parse(fs.readFileSync(json, "utf8")), check, seconds });
    });
  });
}

const report = { mode: args.final ? "final" : args.changed ? "changed" : "full", at: new Date().toISOString(), checks: [] };
for (const check of wanted) {
  if (args.only && !String(args.only).split(",").includes(check)) continue;
  const before = previous?.checks.find((entry) => entry.check === check);
  let extra = [];
  if (args.changed && before && !before.crashed) {
    if (before.ok) {
      report.checks.push({ ...before, carried: true });
      continue;
    }
    const failing = before.items.filter((item) => !item.ok).map((item) => item.name);
    if (selectable[check] && failing.length) {
      // compare names its items "1440" / "1440-dark"; the flag wants the bare widths.
      const names = selectable[check] === "widths" ? failing.map((name) => name.replace(/-dark$/, "")) : failing;
      extra = [`--${selectable[check]}`, names.join(",")];
    }
  }
  process.stderr.write(`· ${check}…\n`);
  const result = await run(check, extra);
  if (extra.length && before) {
    // Items that passed last time were not rerun: keep them, marked as carried over.
    const fresh = new Map(result.items.map((item) => [item.name, item]));
    result.items = before.items.map((item) => fresh.get(item.name) ?? { ...item, carried: true });
    result.ok = result.items.every((item) => item.ok);
    result.partial = true;
  }
  report.checks.push(result);
}
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

// ── Report ────────────────────────────────────────────────────────────────────────────
const lines = [];
const full = !args.changed && !args.only && report.checks.every((entry) => !entry.carried && !entry.partial);
for (const entry of report.checks) {
  const failing = entry.items.filter((item) => !item.ok);
  const status = entry.crashed ? "ERROR" : entry.ok && !failing.length ? "ok" : "FAIL";
  const scope = entry.carried
    ? "carried over, not rerun"
    : `${entry.items.length - failing.length}/${entry.items.length} ok, ${entry.seconds}s${entry.partial ? ", failing items only" : ""}`;
  const crash = `did not finish — read ${path.join(logs, `${entry.check}.log`)}`;
  lines.push(`${status.padEnd(5)} ${entry.check.padEnd(13)} ${entry.crashed ? crash : scope}`);
  if (entry.check === "computed") {
    // One cause shows up in every state and on many elements: list each once.
    const causes = new Map();
    const causeOf = (key, first) => causes.get(key) ?? causes.set(key, { count: 0, states: [], first }).get(key);
    for (const item of failing) {
      for (const line of item.structural ?? []) {
        const cause = causeOf(line, "");
        cause.count = 1;
        cause.states.push(item.name);
      }
      for (const group of item.groups ?? []) {
        const cause = causeOf(group.signature, group.first);
        cause.count = Math.max(cause.count, group.count);
        cause.states.push(item.name);
      }
    }
    const sorted = [...causes].sort((p, q) => q[1].states.length * q[1].count - p[1].states.length * p[1].count);
    for (const [signature, cause] of sorted.slice(0, 8)) {
      const properties = signature.split("\n").map((line) => line.trim());
      const where = `${cause.states.slice(0, 4).join(", ")}${cause.states.length > 4 ? ", …" : ""}`;
      lines.push(`        ×${cause.count} in ${cause.states.length} state(s) [${where}]${cause.first ? `  e.g. ${cause.first.slice(0, 90)}` : ""}`);
      for (const property of properties.slice(0, 4)) lines.push(`          ${property.slice(0, 170)}`);
      if (properties.length > 4) lines.push(`          … ${properties.length - 4} more properties`);
    }
    if (sorted.length > 8) lines.push(`        … ${sorted.length - 8} more causes in ${path.join(logs, "computed.log")}`);
    continue;
  }
  const sparse = entry.items.reduce((sum, item) => sum + (item.sparse ?? 0), 0);
  if (sparse) {
    const guard = wanted.includes("computed") ? "" : " — no computed check in this config, so nothing else would catch a thin faint line";
    lines.push(`        ${sparse} faint px in passing items, all sparse (edge antialiasing)${guard}`);
  }
  for (const item of failing.slice(0, 6)) {
    const numbers = item.count !== undefined ? `  ${item.count} px, ${item.faint} faint` : "";
    const cells = item.cells?.length ? `  cells ${item.cells.join(" ")}` : "";
    lines.push(`        ${item.carried ? "(carried) " : ""}${item.name}${numbers}${item.note ? `  ⚠ ${item.note}` : ""}${cells}`);
  }
  if (failing.length > 6) lines.push(`        … ${failing.length - 6} more in ${path.join(logs, `${entry.check}.log`)}`);
}
const clean = report.checks.length > 0 && report.checks.every((entry) => entry.ok && !entry.crashed && entry.items.every((item) => item.ok));
const verdict = !clean
  ? "FAIL"
  : args.final && full
    ? "PASS (final: every check, original recaptured)"
    : full
      ? "PASS on a cached original — run --final before delivering"
      : "LOOP CLEAN — not a pass: run the full verification (no --changed / --only)";
lines.push("", `VERDICT: ${verdict}`, `details: ${logs}  ·  images: ${out}/<check>/diff-*.png`);
fs.writeFileSync(path.join(out, "summary.txt"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
process.exitCode = clean ? 0 : 1;
