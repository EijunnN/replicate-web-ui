// One command for the whole verification: runs every check the config asks for, writes
// the full output of each to <out>/logs, and prints a short report with a verdict.
// The checks are the same scripts you can run by hand; this only runs them, reads their
// results and decides what is left to look at.
//
//   node verify.mjs --config replica.config.mjs            full pass (original from cache)
//   node verify.mjs --config replica.config.mjs --changed  only what failed last time
//   node verify.mjs --config replica.config.mjs --final    full pass, original recaptured
//   node verify.mjs --config replica.config.mjs --final --resume   finish a --final that was cut short
//        [--only states,computed] [--jobs 4] [--refresh] [--no-preflight]
//   node verify.mjs --config replica.config.mjs --self     the replica against itself: its noise floor
//
// Which checks run (override with `checks: [...]` in the config):
//   page: {...}      → compare (light, and dark when page.dark), dom, states
//   elements: {...}  → elements
//   states: [...]    → computed (and states, when `page` is set)
//   always           → env, theme (and env-dark, theme-dark when anything is checked in dark)
//
// The loop is `--changed` after every fix: seconds, because the original is cached and
// only the failing cases rerun. It can end at "LOOP CLEAN", never at "PASS": a fix in one
// place moves another (a dependency pin, a wrapper), so only a full pass can say PASS, and
// only `--final`, which recaptures the original, is the one you deliver on.
// `--self` points the original at the replica (its URL, selectors, roots and prep) and runs the
// pixel and computed checks: whatever differs there is the page differing from itself (an
// unsettled spring, composited text, a loop), to freeze before any diff against the original
// means anything. It writes to <out>/self and never touches the real report.
// `--resume` (with --final or a full pass) keeps the checks an interrupted run of the same mode
// already passed, when nothing they depend on changed: the replica's served files, the config,
// these scripts and the clock (see "Fingerprint"). Everything else reruns in full.
//
// Before any check, a preflight asks the replica's server (and the original's, when it is
// about to be recaptured) for the page six times in a row and, for a local server, which
// processes listen on its port. A server that drops or stalls a request, or two processes on
// one port (an orphaned dev server keeps answering part of the requests), fails right there,
// with the reason, instead of surfacing as diffs that look like the replica's fault.
// `--no-preflight` skips it (and with it --resume, which needs its fingerprint).
// Exit code 0 on PASS / LOOP CLEAN / a clean noise floor, 1 otherwise.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clockSetting, ensureDir, fs, loadConfig, need, parseArgs, path } from "./lib.mjs";

const args = parseArgs();
need(args, "config");
const here = path.dirname(fileURLToPath(import.meta.url));
let configPath = path.resolve(args.config);
if (args.self) configPath = writeSelfConfig(configPath);
// loadConfig puts the config's clock in the environment, which every check inherits.
const config = await loadConfig(configPath);
const out = ensureDir(config.out ?? "verify");
const logs = ensureDir(path.join(out, "logs"));
const reportFile = path.join(out, "report.json");
const previous = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : null;
// The self test's "original" is the replica, which changes between runs: never from cache.
const refresh = args.refresh || args.final || args.self;
const mode = args.self ? "self" : args.final ? "final" : args.changed ? "changed" : "full";
if (args.resume && (args.changed || args.only)) {
  console.error("--resume completes an interrupted full or --final run; --changed and --only already rerun only part of one.");
  process.exit(1);
}

// ── Preflight ─────────────────────────────────────────────────────────────────────────
const isLocal = (url) => ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(new URL(url).hostname);

/** The processes listening on a local port, as "pid name" strings, or null when the OS will not say. */
function listeners(port) {
  try {
    if (process.platform === "win32") {
      const script = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { "$_ " + (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName }`;
      return execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 20000 }).split(/\r?\n/).filter(Boolean);
    }
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout: 20000 }).split("\n").filter(Boolean);
    return [...new Set(pids)].map((pid) => `${pid} ${execFileSync("ps", ["-o", "comm=", "-p", pid], { encoding: "utf8" }).trim()}`);
  } catch {
    return null;
  }
}

/**
 * One GET with node:http and `autoSelectFamily: false`. On a busy Windows machine, connections to
 * a healthy 127.0.0.1 server failed with ETIMEDOUT after ~315ms, through fetch and through plain
 * node:http alike: the signature of Node's 250ms per-attempt family-selection timeout, which a
 * browser does not have. Here only a real error or 20s of silence fails.
 */
function fetchTimed(url, redirects = 3) {
  const started = Date.now();
  const { protocol } = new URL(url);
  return new Promise((resolve) => {
    const done = (result) => resolve({ ms: Date.now() - started, ...result });
    import(protocol === "https:" ? "node:https" : "node:http").then(({ get }) => {
      const request = get(url, { autoSelectFamily: false, headers: { "cache-control": "no-cache", "user-agent": "Mozilla/5.0 replicate-web-ui preflight" } }, (response) => {
        const { statusCode = 0, headers } = response;
        if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
          response.resume();
          fetchTimed(new URL(headers.location, url).href, redirects - 1).then((result) => resolve({ ...result, ms: Date.now() - started }));
          return;
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => done({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, body: Buffer.concat(chunks), type: headers["content-type"] ?? "" }));
        response.on("error", (error) => done({ ok: false, status: error.code ?? String(error) }));
      });
      request.setTimeout(20000, () => request.destroy(Object.assign(new Error("no answer in 20s"), { code: "TIMEOUT" })));
      request.on("error", (error) => done({ ok: false, status: error.code ?? String(error) }));
    });
  });
}

/**
 * Every same-origin script and stylesheet the page reaches: the tags in the HTML, then the
 * static and dynamic imports inside each script, so a lazy chunk or a dev server's untouched
 * entry still changes the fingerprint when a module deep in the tree does.
 */
async function servedFiles(pageUrl, html) {
  const origin = new URL(pageUrl).origin;
  const seen = new Map();
  const queue = [];
  const enqueue = (ref, base) => {
    if (!ref || /^(data|blob|javascript):/.test(ref)) return;
    const url = new URL(ref, base);
    if (url.origin !== origin) return;
    const key = url.href.split("#")[0];
    if (!seen.has(key) && seen.size < 600) {
      seen.set(key, null);
      queue.push(key);
    }
  };
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi)) {
    if (/<link/i.test(match[0]) && !/rel=["']?(stylesheet|modulepreload|preload)/i.test(match[0])) continue;
    enqueue(match[1], pageUrl);
  }
  while (queue.length) {
    const url = queue.shift();
    const response = await fetchTimed(url);
    seen.set(url, response);
    if (!response.ok || !/javascript|ecmascript/.test(response.type)) continue;
    const source = response.body.toString("utf8");
    for (const match of source.matchAll(/(?:\bimport\s*\(?|\bfrom)\s*["'`]([^"'`]+\.(?:m?js|jsx?|tsx?|css)(?:\?[^"'`]*)?)["'`]/g)) enqueue(match[1], url);
  }
  return seen;
}

async function probe(url, { strictTiming }) {
  const problems = [];
  const notes = [];
  const runs = [];
  for (let i = 0; i < 6; i++) runs.push(await fetchTimed(url));
  for (const run of runs) if (!run.ok) problems.push(`request answered ${run.status} after ${run.ms}ms`);
  const times = runs.map((run) => run.ms).sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  // A healthy server answers the same page in about the same time. One that answers in 20ms and
  // then in 8s is dropping requests on the floor: the 5481 orphan did exactly this.
  if (strictTiming && times.at(-1) > 3000 && times.at(-1) > median * 5) problems.push(`answers erratically: ${times.join(", ")} ms for the same page`);
  notes.push(`${url}  6 requests, ${times[0]}–${times.at(-1)} ms`);
  const { port, protocol } = new URL(url);
  if (isLocal(url)) {
    const owners = listeners(port || (protocol === "https:" ? 443 : 80));
    if (owners === null) notes.push("  (could not read which process listens on the port)");
    else if (owners.length > 1) problems.push(`${owners.length} processes listen on port ${port}: ${owners.join(", ")} — one is probably a server left over from an earlier run; stop the one you did not just start`);
    else if (owners.length) notes.push(`  port ${port}: pid ${owners[0]}`);
  }
  const page = runs.find((run) => run.ok);
  let files = new Map();
  if (page) {
    files = await servedFiles(url, page.body.toString("utf8"));
    const broken = [...files].filter(([, response]) => !response?.ok);
    for (const [file, response] of broken.slice(0, 5)) problems.push(`${file} answered ${response?.status ?? "nothing"}`);
    notes.push(`  ${files.size} scripts and stylesheets reachable`);
  }
  // The page plus everything it loads, by content: the replica's half of the fingerprint.
  const hash = crypto.createHash("sha1");
  hash.update(page?.body ?? "");
  for (const [file, response] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(file).update(response?.body ?? "");
  return { problems, notes, hash: hash.digest("hex").slice(0, 16) };
}

let replicaHash = null;
if (!args["no-preflight"]) {
  const targets = [[config.replica, true], ...(refresh && !args.self ? [[config.original, false]] : [])];
  const failures = [];
  for (const [url, strictTiming] of targets) {
    let result = await probe(url, { strictTiming: strictTiming && isLocal(url) });
    if (result.problems.length) {
      // Once more after a pause: right after a run closes its browsers, a loaded machine can stall
      // one connection (2 runs in 24 on the fixture). A broken server fails again; a stall does not.
      // The first failure stays in the output either way.
      for (const problem of result.problems) process.stderr.write(`· first probe: ${problem} — probing again\n`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      result = await probe(url, { strictTiming: strictTiming && isLocal(url) });
    }
    for (const note of result.notes) process.stderr.write(`· ${note}\n`);
    failures.push(...result.problems.map((problem) => `${url}: ${problem}`));
    if (url === config.replica) replicaHash = result.hash;
  }
  if (failures.length) {
    console.log([...failures.map((failure) => `PREFLIGHT ${failure}`), "", "VERDICT: PREFLIGHT FAILED — fix the server before reading any diff (no check ran)"].join("\n"));
    process.exit(1);
  }
}

// ── Fingerprint ───────────────────────────────────────────────────────────────────────
// What a check's result depends on besides the original: the replica as served, the config as
// written, the checking scripts, and the clock. `--resume` keeps a result only when all four match.
const fingerprint = replicaHash && {
  replica: replicaHash,
  config: crypto.createHash("sha1").update(fs.readFileSync(path.resolve(args.config))).digest("hex").slice(0, 16),
  scripts: crypto
    .createHash("sha1")
    .update(fs.readdirSync(here).filter((file) => file.endsWith(".mjs")).sort().map((file) => fs.readFileSync(path.join(here, file), "utf8")).join("\0"))
    .digest("hex")
    .slice(0, 16),
  clock: clockSetting(),
};
// A recaptured original older than this is not "the original" any more: sites change under us.
const RESUME_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * A config whose original is the replica: same URL, selectors, indexes, roots, and the
 * replica's prep on both sides. Written beside the real one so its relative imports resolve.
 */
function writeSelfConfig(file) {
  const target = path.join(path.dirname(file), `.self.${path.basename(file)}`);
  const source = `import base from ${JSON.stringify(pathToFileURL(file).href)};
const join = (...parts) => parts.filter(Boolean).join(";") || undefined;
const mirror = (level, parent = {}) => level && {
  ...level,
  originalRoot: level.replicaRoot ?? level.originalRoot,
  selector: level.replicaSelector ?? level.selector,
  // A case without its own index is the original's first match and the replica's replicaIndex.
  index: level.replicaIndex ?? parent.replicaIndex ?? level.index,
  prep: join(level.prep ?? parent.prep, level.replicaPrep ?? parent.replicaPrep),
  replicaPrep: undefined,
};
const top = mirror(base);
export default {
  ...top,
  original: base.replica,
  out: (base.out ?? "verify") + "/self",
  elements: base.elements && { ...mirror(base.elements, base), cases: base.elements.cases?.map((c) => mirror(c, { replicaIndex: base.elements.replicaIndex })) },
  cases: base.cases?.map((c) => mirror(c, {})),
  states: base.states?.map((s) => mirror(s, {})),
};
`;
  fs.writeFileSync(target, source);
  return target;
}

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
    "env",
    anyDark && "env-dark",
    "theme",
    anyDark && "theme-dark",
  ].filter((check) => check && (!args.self || /^(compare|elements|states|computed)/.test(check)));

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
  dom: () => ["dom-diff.mjs", [...urls, "--out", path.join(out, "dom"), ...roots, ...flag("width", config.viewport?.width), "--limit", "400", ...flag("prep", config.prep), ...flag("replica-prep", config.replicaPrep)]],
  elements: () => ["element-diff.mjs", ["--config", configPath, "--out", path.join(out, "elements")]],
  states: () => ["states.mjs", ["--config", configPath, "--out", path.join(out, "states")]],
  computed: () => ["computed-diff.mjs", ["--config", configPath, "--out", path.join(out, "computed")]],
  env: () => ["page-env.mjs", ["--config", configPath]],
  "env-dark": () => ["page-env.mjs", ["--config", configPath, "--dark"]],
  theme: () => ["theme-leak.mjs", [...urls, ...roots, ...flag("ignore", config.ignoreTokens), ...flag("tokens", config.tokens)]],
  "theme-dark": () => ["theme-leak.mjs", [...urls, ...roots, ...flag("ignore", config.ignoreTokens), ...flag("tokens", config.tokens), "--dark"]],
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

const report = { mode, at: new Date().toISOString(), fingerprint, complete: false, checks: [] };
const results = new Map();
// Written after every check, not only at the end: a run cut short (a closed session, a killed
// terminal) leaves what it finished, which is what --resume picks up.
const saveReport = () => {
  report.checks = wanted.map((check) => results.get(check)).filter(Boolean);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
};

/** A previous result --resume may keep: same mode, same fingerprint, passed whole, recent enough. */
function resumable(check) {
  if (!args.resume || !fingerprint || previous?.mode !== mode) return null;
  if (JSON.stringify(previous.fingerprint) !== JSON.stringify(fingerprint)) return null;
  const before = previous.checks.find((entry) => entry.check === check);
  if (!before || !before.ok || before.crashed || before.partial || before.carried || !before.items.every((item) => item.ok)) return null;
  const ranAt = before.ranAt ?? previous.at;
  return Date.now() - Date.parse(ranAt) <= RESUME_MAX_AGE_MS ? { ...before, ranAt, resumed: true } : null;
}
// Checks that read values, not pixels, run beside the screenshot checks instead of after them.
// Screenshot checks stay one at a time, as before: they wait for stillness, and two of them
// animating at once on a loaded machine is a source of noise nobody should have to rule out.
const valueChecks = new Set(["env", "env-dark", "theme", "theme-dark", "dom"]);
const runOne = async (check) => {
  if (args.only && !String(args.only).split(",").includes(check)) return null;
  const kept = resumable(check);
  if (kept) return kept;
  const before = previous?.checks.find((entry) => entry.check === check);
  let extra = [];
  if (args.changed && before && !before.crashed) {
    if (before.ok) return { ...before, carried: true };
    const failing = before.items.filter((item) => !item.ok).map((item) => item.name);
    if (selectable[check] && failing.length) {
      // compare names its items "1440" / "1440-dark"; the flag wants the bare widths.
      const names = selectable[check] === "widths" ? failing.map((name) => name.replace(/-dark$/, "")) : failing;
      extra = [`--${selectable[check]}`, names.join(",")];
    }
  }
  process.stderr.write(`· ${check}…\n`);
  const result = { ...(await run(check, extra)), ranAt: new Date().toISOString() };
  if (extra.length && before) {
    // Items that passed last time were not rerun: keep them, marked as carried over.
    const fresh = new Map(result.items.map((item) => [item.name, item]));
    result.items = before.items.map((item) => fresh.get(item.name) ?? { ...item, carried: true });
    result.ok = result.items.every((item) => item.ok);
    result.partial = true;
  }
  return result;
};
const record = (check, result) => {
  if (!result) return;
  results.set(check, result);
  saveReport();
};
// One value check at a time beside the screenshot checks: more browsers than that at once made a
// local server reset connections, and a crash reads as a failure.
const valueRuns = (async () => {
  for (const check of wanted.filter((check) => valueChecks.has(check))) record(check, await runOne(check));
})();
for (const check of wanted.filter((check) => !valueChecks.has(check))) record(check, await runOne(check));
await valueRuns;
// Report in the declared order, whatever finished first.
report.complete = true;
saveReport();

// ── Report ────────────────────────────────────────────────────────────────────────────
const lines = [];
const full = !args.changed && !args.only && report.checks.every((entry) => !entry.carried && !entry.partial);
for (const entry of report.checks) {
  const failing = entry.items.filter((item) => !item.ok);
  const status = entry.crashed ? "ERROR" : entry.ok && !failing.length ? "ok" : "FAIL";
  const scope = entry.carried
    ? "carried over, not rerun"
    : entry.resumed
      ? `${entry.items.length}/${entry.items.length} ok, resumed: passed at ${entry.ranAt.slice(11, 16)} UTC on the same replica, config and scripts`
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
const resumedCount = report.checks.filter((entry) => entry.resumed).length;
const resumedNote = resumedCount ? `; ${resumedCount} check(s) resumed from an earlier run of the same replica` : "";
const verdict = args.self
  ? clean
    ? "NOISE FLOOR CLEAN — the replica matches itself, so a difference against the original is real"
    : "NOISE FLOOR — the replica differs from itself in the items above: freeze them in prep before trusting a diff"
  : !clean
  ? "FAIL"
  : args.final && full
    ? `PASS (final: every check, original recaptured${resumedNote})`
    : full
      ? `PASS on a cached original — run --final before delivering${resumedNote}`
      : "LOOP CLEAN — not a pass: run the full verification (no --changed / --only)";
lines.push("", `VERDICT: ${verdict}`, `details: ${logs}  ·  images: ${out}/<check>/diff-*.png`);
fs.writeFileSync(path.join(out, "summary.txt"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
process.exitCode = clean ? 0 : 1;
