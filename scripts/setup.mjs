// Prepares the workspace the other scripts run from and prints its path. Node resolves
// imports next to the script file, so the scripts are copied beside their node_modules;
// the workspace is kept between sessions, so this installs once and afterwards only
// refreshes the scripts (under a second).
//
//   node ~/.claude/skills/replicate-web-ui/scripts/setup.mjs [--dir <workspace>]
//
// Default workspace: $REPLICA_WS, or ~/.cache/replicate-web-ui. Configs and outputs belong
// to the task, not here: keep them in the session scratchpad and pass absolute paths.
// Uses Node built-ins only, because it runs before anything is installed.
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dirFlag = process.argv.indexOf("--dir");
const workspace = path.resolve(
  dirFlag > -1 ? process.argv[dirFlag + 1] : process.env.REPLICA_WS ?? path.join(os.homedir(), ".cache", "replicate-web-ui"),
);
fs.mkdirSync(workspace, { recursive: true });

for (const file of fs.readdirSync(here)) {
  if (/\.(mjs|json)$/.test(file) && file !== "package-lock.json") fs.copyFileSync(path.join(here, file), path.join(workspace, file));
}

const manifest = fs.readFileSync(path.join(here, "package.json"));
const stamp = path.join(workspace, ".installed");
const wanted = crypto.createHash("sha1").update(manifest).digest("hex");
const installed = fs.existsSync(stamp) ? fs.readFileSync(stamp, "utf8") : "";
if (installed !== wanted || !fs.existsSync(path.join(workspace, "node_modules", "playwright"))) {
  console.error("installing dependencies…");
  execSync("npm install --no-audit --no-fund", { cwd: workspace, stdio: ["ignore", 2, 2] });
  fs.writeFileSync(stamp, wanted);
}

// PLAYWRIGHT_SKIP_BROWSER_GC: the browser cache (ms-playwright) is shared by every project
// on the machine, and a plain `playwright install` deletes the builds it believes unused.
const probe = "import('playwright').then(({ chromium }) => console.log(chromium.executablePath()))";
const executable = execSync(`node -e "${probe}"`, { cwd: workspace, encoding: "utf8" }).trim();
if (!fs.existsSync(executable)) {
  console.error("installing chromium…");
  execSync("npx playwright install chromium", {
    cwd: workspace,
    stdio: ["ignore", 2, 2],
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: "1" },
  });
}
console.log(workspace);
