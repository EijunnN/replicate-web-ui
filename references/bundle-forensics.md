# Bundle forensics

How to get from "a page with 50 minified chunks" to "the source of the component I'm
replicating, with its data and animation parameters".

## Contents

1. Find the right code
2. Chunk formats
3. Following imports
4. Server-rendered parts
5. Recognizing libraries and systems
6. Library versions
7. Reading minified code without getting lost

## 1. Find the right code

Search by **copy the user can see**: section titles, empty-state text, labels,
tooltip strings. Numbers work too when they are distinctive (`92500`, `"Aug"`).

```bash
node bundle-modules.mjs --dir capture --out modules --grep "Sales by hour" --grep "No Team Members" --deps
```

One chunk frequently holds the whole feature (the dashboard's sidebar, header,
cards and charts were all in one 50 KB chunk). Read that module file end to end
before extracting more; it tells you which pieces are local and which are imported.

On a React Server Components page (Next.js App Router), start one step earlier:

```bash
node rsc-refs.mjs capture/000-document-<page>
```

The HTML streams the RSC payload in `self.__next_f.push([1,"…"])` strings; its
`NN:I[moduleId,[chunks],"Export"]` lines are exactly the client components the page
mounts, with the chunk each lives in. That turns "which of these 200 modules matter"
into a list of five or six, and the rest of the payload holds the props the server
passed them — often the page's data, already in order.

Icons are worth a special mention: icon packages compile to one tiny module per icon,
holding the icon name and its exact path data (`(0, factory)("brain-circuit", [["path",
{ d: "M12 5a3 3..." }], …])`). Reading those modules is faster and more precise than
opening every menu in a browser to collect the rendered markup.

Strings not found in any module are server-rendered (see section 4) or live in a
lazy chunk that loads only after an interaction. For the latter, open the overlay or
switch the tab in a Playwright session with `capture.mjs`-style response logging, or
simply rerun `capture.mjs` after adding a click.

## 2. Chunk formats

**Turbopack** (Next.js 15+/16):

```js
(globalThis.TURBOPACK || (globalThis.TURBOPACK = [])).push([
  document.currentScript, 859588, (e) => { ... }, 93204, (e) => { ... }, ...
]);
```

Numbers are module ids; the function after them is the factory. Inside a factory:
`e.i(843476)` imports a module, `e.A(103673)` imports lazily, `e.s([...])` declares
exports as `["ExportName", () => local, ...]`. `(0, t.jsx)("div", {...})` is JSX.

**webpack** (Next.js ≤14, CRA, many others):

```js
(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([[123], { 4567: function (e, t, n) { ... } }]);
```

`n(890)` is `__webpack_require__`; `n.d(t, { Foo: () => x })` declares exports.

`bundle-modules.mjs` evaluates each chunk in a `vm` sandbox with a fake
`TURBOPACK` array and `self`, then reads the registered factories. Runtime chunks
throw on DOM access; registration has usually happened by then, so errors are
ignored.

**ESM bundles** (Vite, Rollup, Astro, SvelteKit) cannot be evaluated this way
(`import` statements). The script greps them raw and writes the whole file
beautified; search inside it by the same strings.

## 3. Following imports

`--deps` writes each hit's direct imports and prints the ids. Most imports are
framework or utility modules (React's jsx runtime, `cn`, icon wrappers); open the ones
whose exports matter to the look: `Delta`, `DashboardCard`, `FunnelChart`, a `Button`
with its `cva` variants. `--id 920904,84153 --deps` pulls specific ones.

Keep a short map as you go (id → export → what it renders). It saves re-reading.

## 4. Server-rendered parts

With React Server Components (`stack.json` → `reactServerComponents: true`),
server-only components never reach the client as code. Their output is in the
rendered DOM (and serialized in `self.__next_f` payloads inside the HTML).
In the dashboard case the KPI cards, traffic sources, quick actions and the page
layout existed only as DOM. Use `dom-dump.mjs`: it gives the final classes, the
structure, and, through collapsed-sibling counts, data such as "7 columns of
3,4,5,5,6,4,4 segments with the 5th highlighted".

## 5. Recognizing libraries and systems

| Clue in DOM/bundle | Meaning | What to extract |
|---|---|---|
| `data-slot="…"` everywhere | shadcn/ui components | the slot tree tells you which primitive each element is |
| `cn-button-variant-outline`, body class `style-nova` | shadcn "style" system: component rules live in CSS | `css-rules.mjs --match "cn-(button|…)" --scope style-nova` |
| `data-radix-*`, `data-state`, `data-side` | Radix primitives (popover, menu, dialog) | offsets, alignment, animation classes |
| `cmdk-root`, `cmdk-item` | cmdk command palette | fuzzy scoring + sorting behavior (see architecture doc) |
| `.recharts-*` | recharts | chart props, custom `shape`, margins, version |
| `.visx-group`, `visx-pattern-line` | visx (d3 underneath) | pie/arc settings, patterns |
| `lucide lucide-name` classes | lucide icons | `icons.mjs` |
| `IconPlaceholder` with `lucide:`/`tabler:` props | multi-icon-library wrapper; the active set is decided at runtime | check which set the DOM rendered |
| `motion.*`, `useSpring`, `animate(` | motion / framer-motion | spring stiffness/damping, durations, easing arrays |

## 6. Library versions

Rendering can differ between minor versions of the same library. When a pixel diff
points at something computed (bar widths, tick positions, label placement, arc
paths, search ranking):

1. Find the computation in the original bundle. Grep a stable token nearby
   (`barCategoryGap`, `padAngle`) and read the minified expression, e.g.
   `y>1&&(y>>=0)`.
2. Find the unminified file in the package (`node_modules/<pkg>/es6/...`) and the
   corresponding expression in your installed version (`Math.round(originalSize)`).
3. `fingerprint-version.mjs --pkg <pkg> --file <path> --needle "<expression>"`, adding
   a second `--needle` for a feature the original also has (e.g. `niceTicks`) to
   narrow the range.
4. Pin the exact version and check the app resolves it (see verification doc).

## 7. Reading minified code without getting lost

- Beautify first (the scripts do). Rename nothing; annotate in your notes instead.
- Constants appear as `72e3`, `864e5`, `.52`, `!0` (true), `!1` (false), `void 0`.
- `(0, a.cn)("…", cond && "…", e)` is `cn(...)`; the last argument is usually the
  caller's `className`, so the final class list depends on the caller. Confirm with
  the DOM.
- Default props hide in destructuring: `({ layers: d = 3, gap: N = 4, staggerDelay: C = .12 })`.
  Callers override only some; record both.
- Animation parameters often sit in a shared module (`DEFAULT_CHART_ENTER_TRANSITION =
  { type: "tween", duration: 1.1, ease: [.85, 0, .15, 1] }`). Grep the export name.
- Some strings look odd because a template renamed words in bulk (a variant name
  mangled by a find-and-replace). They are not meaningful; don't copy the oddity into
  logic that matters.
