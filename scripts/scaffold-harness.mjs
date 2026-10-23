// Writes a replica harness for a site: a Vite + React app that renders your packages from
// their *source* inside the original page's own structure, so the first `verify` compares the
// component and not a different page around it. What it copies from the original, verbatim:
//   · the <html> and <body> attributes, and the viewport meta;
//   · the ancestors of `--root`, from <body> down, with their attributes (siblings dropped);
//   · every CSS rule that matches <html>, <body> or one of those ancestors, in light and with
//     the dark class on, inside its @media / @supports / @layer / @container wrappers, plus
//     @property and @layer order statements (src/original.css). Class rules are guarded so
//     they style the ancestors only, never the unit, whose own classes the harness compiles;
//     global rules (`*`, `html`, `body`, element selectors) reach the unit as on the original;
//   · every @font-face rule, with its font files downloaded from the site (src/fonts.css):
//     the same family from npm is a different build, and every glyph differs;
//   · for a Tailwind v4 original, the theme variables of its `@layer theme`, re-registered in
//     `@theme` so the harness generates the same utilities;
//   · cross-origin stylesheets (Google Fonts…) as <link> tags, as the original loads them.
// Then it wires `--unit`s (one line each in src/units.tsx), resolves `<scope>/<name>` to
// `<packages>/<name>/src`, and pins every third-party dependency those packages reach to the
// version installed beside them.
//
//   node scaffold-harness.mjs --original https://site/page --root 'section[aria-label="X"]'
//        --out tools/replicate/<site>/harness --packages packages/<collection> --scope @<scope>
//        --unit messenger=@scope/messenger[:Messenger] [--unit …] [--css @scope/tokens/styles.css]
//        [--port 5791] [--dark-class dark] [--width 1440] [--wait 2500] [--no-tailwind] [--force]
//
// It refuses to write into a folder that has files unless --force. Afterwards:
//   cd <out> && bun install && bun run build && bun run preview
//   node verify.mjs --config <page>/replica.config.mjs --only env,env-dark     ← must pass first
// What it cannot know is printed as warnings: an ancestor that lays out siblings it dropped (a
// grid column next to a sidebar), or a theme registered with `@theme inline` (not in the CSSOM).
import crypto from "node:crypto";
import { ensureDir, fs, launch, list, need, openPage, parseArgs, path } from "./lib.mjs";

const args = parseArgs();
need(args, "original", "root", "out", "packages", "scope");
const out = path.resolve(args.out);
const packagesDir = path.resolve(args.packages);
const scope = String(args.scope).replace(/\/$/, "");
const port = Number(args.port ?? 5791);
const darkClass = args["dark-class"] ?? "dark";
const tailwind = !args["no-tailwind"];
if (fs.existsSync(out) && fs.readdirSync(out).length && !args.force) {
  console.error(`${out} is not empty: pass --force to write over it.`);
  process.exit(1);
}
if (!fs.existsSync(packagesDir)) {
  console.error(`--packages ${packagesDir} does not exist.`);
  process.exit(1);
}

const pascal = (name) => name.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
const units = list(args.unit).map((spec) => {
  const match = /^([\w-]+)=(@[\w-]+\/[\w-]+)(?::(\w+))?$/.exec(spec);
  if (!match) throw new Error(`--unit ${spec}: write name=@scope/package[:Export]`);
  const [, name, pkg, exported] = match;
  return { name, pkg, exported: exported ?? pascal(pkg.split("/")[1]) };
});

// ── Read the original ─────────────────────────────────────────────────────────────────
const browser = await launch();
const { page } = await openPage(browser, args.original, { width: Number(args.width ?? 1440), height: 900, wait: Number(args.wait ?? 2500) });
const captured = await page.evaluate(
  ({ rootSelector, darkClass }) => {
    const target = document.querySelector(rootSelector);
    if (!target) return { error: `--root ${rootSelector} matches nothing on the original` };
    const html = document.documentElement;
    const chain = [];
    for (let el = target.parentElement; el && el !== document.body && el !== html; el = el.parentElement) chain.unshift(el);
    const attrsOf = (el) => [...el.attributes].filter((a) => !/^on/i.test(a.name)).map((a) => [a.name, a.value]);
    const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${[...el.classList].slice(0, 4).map((c) => `.${c}`).join("")}`;

    // The ancestors whose layout depends on siblings the harness will not have.
    const warnings = [];
    for (const el of [...chain, target]) {
      const parent = el.parentElement;
      const display = getComputedStyle(parent).display;
      const others = [...parent.children].filter(
        (c) => c !== el && !["SCRIPT", "STYLE", "TEMPLATE", "LINK", "NOSCRIPT"].includes(c.tagName) && getComputedStyle(c).display !== "none" && getComputedStyle(c).position !== "fixed" && getComputedStyle(c).position !== "absolute",
      );
      if (others.length && /flex|grid/.test(display))
        warnings.push(`${describe(parent)} is ${display} with ${others.length} other child(ren) the harness drops; ${describe(el)} is ${Math.round(el.getBoundingClientRect().width * 100) / 100}px wide and at x ${Math.round(el.getBoundingClientRect().x * 100) / 100} here`);
    }

    // Top-level commas only: `:is(a, b), c` is two selectors, not three.
    const split = (text) => {
      const parts = [];
      let depth = 0;
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") depth--;
        else if (ch === "," && depth === 0) {
          parts.push(text.slice(start, i));
          start = i + 1;
        }
      }
      parts.push(text.slice(start));
      return parts.map((part) => part.trim()).filter(Boolean);
    };
    const PSEUDO_ELEMENT = /::?(before|after|first-line|first-letter|selection|placeholder|marker|backdrop|file-selector-button|-webkit-[\w-]+|-moz-[\w-]+)(\([^)]*\))?/g;
    const subjects = [html, document.body, ...chain];
    const matchesNow = (selectorText) =>
      split(selectorText).some((selector) => {
        const plain = selector.replace(PSEUDO_ELEMENT, "").trim() || "*";
        try {
          return subjects.some((el) => el.matches(plain));
        } catch {
          return false;
        }
      });
    // A rule counts when it matches in light or with the dark class on: a palette under `.dark`
    // is part of the page. Rules under a media query are kept whatever the query says now.
    const hadDark = html.classList.contains(darkClass);
    const matches = (selectorText) => {
      html.classList.remove(darkClass);
      const light = matchesNow(selectorText);
      html.classList.add(darkClass);
      const dark = matchesNow(selectorText);
      if (!hadDark) html.classList.remove(darkClass);
      return light || dark;
    };
    // A class rule copied for an ancestor (`.w-full`, `.flex`) would also reach the unit, whose
    // own classes the harness compiles, and win by coming later: a copied `.w-full` beat the
    // messenger's `@3xl:w-72`. Those rules are kept off the unit with a zero-specificity guard.
    // Rules without a class, attribute or id in their subject (`*`, `html`, `body`, `button`,
    // `:root`) are the site's global base, and reach the unit as they do on the original.
    const PSEUDO_TAIL = /((?<!\\)::?(?:before|after|first-line|first-letter|selection|placeholder|marker|backdrop|file-selector-button|-webkit-[\w-]+|-moz-[\w-]+)(?:\([^)]*\))?)+$/;
    const GUARD = ":where(:not([data-unit-parent] *))";
    const guard = (selector) => {
      const tail = PSEUDO_TAIL.exec(selector)?.[0] ?? "";
      const head = selector.slice(0, selector.length - tail.length);
      let depth = 0;
      let start = 0;
      for (let i = 0; i < head.length; i++) {
        const ch = head[i];
        if (ch === "\\") i++;
        else if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") depth--;
        else if (depth === 0 && /[\s>+~]/.test(ch)) start = i + 1;
      }
      return /[.[#]/.test(head.slice(start)) ? `${head}${GUARD}${tail}` : selector;
    };
    const guarded = (rule) => (rule.cssRules?.length ? rule.cssText : `${split(rule.selectorText).map(guard).join(", ")} { ${rule.style.cssText} }`);
    const absolute = (css, base) =>
      css.replace(/url\((['"]?)([^'")]+)\1\)/g, (all, quote, ref) => (/^(data:|#)/.test(ref) ? all : `url(${quote}${new URL(ref, base).href}${quote})`));
    const fonts = [];
    const theme = [];
    const crossOrigin = [];
    const head = (rule) => rule.cssText.slice(0, rule.cssText.indexOf("{")).trim();
    const walk = (rules, base, layer) => {
      let text = "";
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          if (!matches(rule.selectorText)) continue;
          text += `${absolute(guarded(rule), base)}\n`;
          if (layer === "theme" && /(^|,)\s*:root\b/.test(rule.selectorText))
            for (const property of rule.style) if (property.startsWith("--")) theme.push([property, rule.style.getPropertyValue(property).trim()]);
        } else if (rule instanceof CSSFontFaceRule) fonts.push({ css: rule.cssText, base });
        else if (rule instanceof CSSImportRule) {
          try {
            text += walk(rule.styleSheet.cssRules, rule.styleSheet.href ?? base, layer);
          } catch {
            crossOrigin.push(new URL(rule.href, base).href);
          }
        } else if ((typeof CSSPropertyRule !== "undefined" && rule instanceof CSSPropertyRule) || (typeof CSSLayerStatementRule !== "undefined" && rule instanceof CSSLayerStatementRule)) {
          text += `${rule.cssText}\n`;
        } else if (rule.cssRules && !(rule instanceof CSSKeyframesRule)) {
          const inner = walk(rule.cssRules, base, typeof CSSLayerBlockRule !== "undefined" && rule instanceof CSSLayerBlockRule ? rule.name : layer);
          if (inner) text += `${head(rule)} {\n${inner}}\n`;
        }
      }
      return text;
    };
    let css = "";
    for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])]) {
      if (sheet.disabled) continue;
      try {
        css += walk(sheet.cssRules, sheet.href ?? location.href, null);
      } catch {
        if (sheet.href) crossOrigin.push(sheet.href);
      }
    }
    return {
      html: attrsOf(html),
      body: attrsOf(document.body),
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "width=device-width, initial-scale=1",
      ancestors: chain.map((el, index) => ({ tag: el.tagName.toLowerCase(), attrs: [...attrsOf(el), ...(index === chain.length - 1 ? [["data-unit-parent", ""]] : [])] })),
      css,
      fonts,
      theme,
      crossOrigin: [...new Set(crossOrigin)],
      warnings,
      title: document.title,
    };
  },
  { rootSelector: args.root, darkClass },
);
await browser.close();
if (captured.error) {
  console.error(captured.error);
  process.exit(1);
}

// ── Fonts: the site's own files ───────────────────────────────────────────────────────
ensureDir(path.join(out, "src", "fonts"));
const downloaded = new Map();
async function download(url) {
  if (downloaded.has(url)) return downloaded.get(url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`font ${url} answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const base = path.basename(new URL(url).pathname).replace(/[^\w.-]/g, "_") || "font";
  const taken = [...downloaded.values()].includes(`./fonts/${base}`);
  const name = taken ? `${crypto.createHash("sha1").update(url).digest("hex").slice(0, 8)}-${base}` : base;
  fs.writeFileSync(path.join(out, "src", "fonts", name), bytes);
  downloaded.set(url, `./fonts/${name}`);
  return `./fonts/${name}`;
}
let fontsCss = `/* ${args.original}'s @font-face rules, verbatim, with its own font files. */\n`;
for (const { css, base } of captured.fonts) {
  let rule = css;
  for (const match of css.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
    if (match[2].startsWith("data:")) continue;
    rule = rule.replace(match[0], `url(${await download(new URL(match[2], base).href)})`);
  }
  fontsCss += `${rule}\n`;
}

// ── Dependencies: what the units reach, at the versions installed beside the packages ─
const deps = {};
const visited = new Set();
function collect(pkg) {
  if (visited.has(pkg)) return;
  visited.add(pkg);
  const dir = path.join(packagesDir, pkg.slice(scope.length + 1));
  const manifestFile = path.join(dir, "package.json");
  if (!fs.existsSync(manifestFile)) throw new Error(`${pkg}: no ${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  for (const [name, range] of Object.entries({ ...manifest.peerDependencies, ...manifest.dependencies })) {
    if (name.startsWith(`${scope}/`)) {
      collect(name);
      continue;
    }
    if (String(range).startsWith("workspace:")) continue;
    const installed = path.join(dir, "node_modules", name, "package.json");
    deps[name] = fs.existsSync(installed) ? JSON.parse(fs.readFileSync(installed, "utf8")).version : range;
  }
}
for (const unit of units) collect(unit.pkg);
deps.react ??= "^19";
deps["react-dom"] ??= deps.react;
const installedVersion = (name, fallback) => {
  for (const dir of fs.readdirSync(packagesDir)) {
    const file = path.join(packagesDir, dir, "node_modules", name, "package.json");
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")).version;
  }
  return fallback;
};
const tailwindVersion = installedVersion("tailwindcss", "^4");

// ── Write ─────────────────────────────────────────────────────────────────────────────
const date = new Date().toISOString().slice(0, 10);
const relPackages = path.relative(out, packagesDir).split(path.sep).join("/");
const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
const write = (file, text) => {
  ensureDir(path.dirname(path.join(out, file)));
  fs.writeFileSync(path.join(out, file), text);
};
const attr = (pairs) => pairs.map(([name, value]) => (value === "" ? ` ${name}` : ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`)).join("");
const host = new URL(args.original).host;

write(
  "package.json",
  `${JSON.stringify(
    {
      name: `${host.replace(/[^\w]+/g, "-")}-replica-harness`,
      private: true,
      type: "module",
      scripts: { dev: `vite --port ${port - 1} --strictPort`, build: "vite build", preview: `node serve.mjs ${port}` },
      dependencies: sorted(deps),
      devDependencies: sorted({ "@vitejs/plugin-react": "^5", vite: "^7", ...(tailwind ? { "@tailwindcss/vite": tailwindVersion, tailwindcss: tailwindVersion } : {}) }),
    },
    null,
    2,
  )}\n`,
);

write(
  "vite.config.ts",
  `// Replica harness for ${args.original}: renders ${scope}/* packages from their *source* inside
// the original's page structure (src/chain.json). \`?c=<unit>\` picks the unit (src/units.tsx).
// Generated by replicate-web-ui's scaffold-harness.mjs on ${date}; edit freely.
import fs from "node:fs";
import path from "node:path";
${tailwind ? 'import tailwindcss from "@tailwindcss/vite";\n' : ""}import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const packages = path.resolve(__dirname, ${JSON.stringify(relPackages)});
const scope = ${JSON.stringify(scope)};

/** \`${scope}/<name>\` → <packages>/<name>/src/index.(tsx|ts|jsx|js), so a fix shows without rebuilding dist. */
function fromSource(): Plugin {
  return {
    name: "packages-from-source",
    enforce: "pre",
    resolveId(id) {
      const match = new RegExp(\`^\${scope}/([\\\\w-]+)$\`).exec(id);
      if (!match) return null;
      const src = path.join(packages, match[1], "src");
      for (const file of ["index.tsx", "index.ts", "index.jsx", "index.js"]) if (fs.existsSync(path.join(src, file))) return path.join(src, file);
      return null;
    },
  };
}

export default defineConfig({
  plugins: [fromSource(), react()${tailwind ? ", tailwindcss()" : ""}],
  resolve: {
    // \`${scope}/<name>/<file>\` (a stylesheet, a subpath) → <packages>/<name>/src/<file>.
    alias: [{ find: new RegExp(\`^\${scope}/([\\\\w-]+)/(.+)$\`), replacement: \`\${packages}/$1/src/$2\` }],
    // Workspaces that do not hoist give each package its own node_modules, or none. Resolve every
    // third-party import from the harness's install, one copy each (two Reacts break hooks).
    dedupe: Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).dependencies),
  },
  server: { fs: { allow: [packages, __dirname] } },
});
`,
);

write(
  "index.html",
  `<!doctype html>
<!-- ${args.original}'s <html> and <body> attributes, verbatim (scaffold-harness.mjs, ${date}). -->
<html${attr(captured.html)}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="${captured.viewport}" />
    <title>${host} replica harness</title>
${captured.crossOrigin.map((href) => `    <link rel="stylesheet" href="${href}" />\n`).join("")}  </head>
  <body${attr(captured.body)}>
    <div id="root" style="display: contents"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
);

write("src/chain.json", `${JSON.stringify({ original: args.original, root: args.root, captured: date, ancestors: captured.ancestors }, null, 2)}\n`);

write(
  "src/main.tsx",
  `// The original's ancestors of \`${args.root.replace(/\*\//g, "*\\/")}\`, from <body> down, rebuilt from src/chain.json
// with their attributes verbatim (siblings dropped). The innermost one carries data-unit-parent.
import { createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import chain from "./chain.json";
import { UNITS } from "./units";

type Ancestor = { tag: string; attrs: [string, string][] };
const RENAMED: Record<string, string> = { class: "className", for: "htmlFor", tabindex: "tabIndex", readonly: "readOnly", contenteditable: "contentEditable", spellcheck: "spellCheck", autocomplete: "autoComplete" };
const BOOLEAN = new Set(["hidden", "inert"]);
const camel = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function props(attrs: [string, string][]) {
  const out: Record<string, unknown> = {};
  for (const [name, value] of attrs) {
    if (name === "style") {
      const style: Record<string, string> = {};
      for (const declaration of value.split(";")) {
        const colon = declaration.indexOf(":");
        if (colon < 0) continue;
        const key = declaration.slice(0, colon).trim();
        style[key.startsWith("--") ? key : camel(key)] = declaration.slice(colon + 1).trim();
      }
      out.style = style;
    } else out[RENAMED[name] ?? name] = BOOLEAN.has(name) ? true : value;
  }
  return out;
}

const name = new URLSearchParams(location.search).get("c") ?? "";
const render = UNITS[name];
const unit: ReactNode = render ? (
  render()
) : (
  <p>
    Unknown unit <code>{name || "(none)"}</code>. Known: {Object.keys(UNITS).join(", ")}
  </p>
);
const tree = (chain.ancestors as Ancestor[]).reduceRight<ReactNode>((child, node) => createElement(node.tag, props(node.attrs), child), unit);
createRoot(document.getElementById("root")!).render(tree);
`,
);

write(
  "src/units.tsx",
  `// The units this harness can show, by \`?c=\` name. One line per install unit; add a page's
// units here when you replicate it.
${units.map((unit) => `import { ${unit.exported} } from "${unit.pkg}";\n`).join("")}import type { ReactNode } from "react";

export const UNITS: Record<string, () => ReactNode> = {
${units.map((unit) => `  ${/^[a-z_$][\w$]*$/i.test(unit.name) ? unit.name : JSON.stringify(unit.name)}: () => <${unit.exported} />,\n`).join("")}};
`,
);

const THEME_NAMESPACE = /^--(color|font|text|font-weight|tracking|leading|breakpoint|container|spacing|radius|shadow|inset-shadow|drop-shadow|blur|perspective|aspect|ease|animate|default)(-|$)/;
// Tailwind emits only the theme variables a site uses, so the original's theme can lack a name your
// packages use (`text-muted-foreground` on a site that only used `text-fg-muted`): no utility,
// and the text falls back to the inherited colour. The token stylesheets passed with --css name
// them (`--color-muted-foreground: var(--muted-foreground)`), so they are registered too; where
// both declare a name, the original's value wins.
const cssFile = (spec) => {
  const match = new RegExp(`^${scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([\\w-]+)/(.+)$`).exec(spec);
  const file = match ? path.join(packagesDir, match[1], "src", match[2]) : path.resolve(spec);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
};
const tokenTheme = list(args.css).flatMap((spec) =>
  [...cssFile(spec).matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)].map((match) => [match[1], match[2].trim()]),
);
const themeVars = [
  ...new Map([...tokenTheme, ...captured.theme].filter(([name]) => THEME_NAMESPACE.test(name) && !name.startsWith("--tw-"))).entries(),
];
write(
  "src/styles.css",
  `/* Replica harness for ${args.original}. Generated by scaffold-harness.mjs on ${date}; edit freely. */
${tailwind ? '@import "tailwindcss";\n' : ""}${list(args.css).map((spec) => `@import "${spec}";\n`).join("")}@import "./fonts.css";
@import "./original.css";
${
  tailwind
    ? `
/* Every ${scope} package's classes, from source. */
@source "${path.posix.join(path.relative(path.join(out, "src"), packagesDir).split(path.sep).join("/"))}";

@custom-variant dark (&:where(.${darkClass}, .${darkClass} *));
${
  themeVars.length
    ? `
/* The original's Tailwind theme (its \`@layer theme\`) and the names your token stylesheets
   declare, registered so the same utilities exist here. */
@theme {
${themeVars.map(([name, value]) => `  ${name}: ${value};\n`).join("")}}
`
    : `
/* The original exposed no Tailwind theme variables (plain CSS, or \`@theme inline\`): register the
   names your packages' classes use here, e.g. --color-background: var(--background); */
`
}`
    : ""
}`,
);
write("src/fonts.css", fontsCss);
write(
  "src/original.css",
  `/* Every rule of ${args.original} that matches <html>, <body> or an ancestor of the unit, verbatim,
   inside its original wrappers (scaffold-harness.mjs, ${date}). Regenerate rather than edit. */
${captured.css}`,
);

write(
  "serve.mjs",
  `// Serves the harness's production build (dist/). A plain static server: \`vite preview\` on
// Windows answered some requests seconds late and dropped others, which reads as a crash, and
// stopping it from a tool can leave its Node child holding the port.
//   node serve.mjs [port]      default ${port}, bound to 127.0.0.1
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const port = Number(process.argv[2] ?? ${port});
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif" };

http
  .createServer((request, response) => {
    const url = decodeURIComponent((request.url ?? "/").split("?")[0]);
    let file = path.join(dist, url);
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, "index.html");
    response.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(response);
  })
  .listen(port, "127.0.0.1", () => console.log(\`harness on http://127.0.0.1:\${port}/?c=<unit>\`));
`,
);
write(".gitignore", "node_modules/\ndist/\n");

// ── Report ────────────────────────────────────────────────────────────────────────────
const lines = [
  `harness written to ${out}`,
  `  ${captured.ancestors.length} ancestors of ${args.root}, ${captured.css.split("\n").filter(Boolean).length} lines of original CSS, ${captured.fonts.length} @font-face rules (${downloaded.size} files), ${themeVars.length} theme variables, ${captured.crossOrigin.length} cross-origin stylesheets`,
  `  units: ${units.map((unit) => `${unit.name} → ${unit.pkg}`).join(", ") || "(none: add them to src/units.tsx)"}`,
  `  dependencies: ${Object.entries(sorted(deps)).map(([name, version]) => `${name}@${version}`).join(", ")}`,
];
for (const warning of captured.warnings) lines.push(`  ⚠ ${warning}`);
if (tailwind && !themeVars.length) lines.push("  ⚠ no Tailwind theme variables on the original: register the ones your packages use in src/styles.css");
lines.push(
  "",
  "next:",
  `  cd ${out} && bun install && bun run build && bun run preview`,
  `  node verify.mjs --config <page>/replica.config.mjs --only env,env-dark     (replica: http://127.0.0.1:${port}/?c=<unit>)`,
);
console.log(lines.join("\n"));
