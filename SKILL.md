---
name: replicate-web-ui
description: Rebuild a live web page's UI and UX so it matches the original pixel for pixel, by reading what the browser actually receives (minified JS chunks, CSSOM rules, rendered DOM, computed tokens, icon markup) and proving the result with screenshot diffs, element diffs and an interaction-state matrix. Use it whenever the user wants a component, block, dashboard or page to look and behave "igual", "identical" or "exactly like" a URL, asks to clone, port or reverse-engineer a site's UI from its client JS, says an earlier replica "no es fiel" or "doesn't match", or pastes a reference URL next to a local one and wants them to match, even if they never say "pixel-perfect".
---

# Replicate a web UI from its live bundle

Everything that makes a page look and feel the way it does ships to the browser:
the client JS holds the data, formulas and animation parameters; the CSSOM holds the
design-system rules and hover/focus states; the rendered DOM holds the final class
lists (after tailwind-merge/cva) and every server-rendered part; computed styles hold
the tokens. A faithful replica comes from reading those, not from eyeballing a
screenshot or recalling how a library "usually" looks. And it is only done when a
diff says so: agents that stop at "looks the same" miss 1px shifts, a wrong bar
width, a hover that turns text dark instead of keeping it gray.

## Ground rules

- **The page is the source of truth.** Use only the sources the user allows. If they
  say "only the page", don't read the vendor's registry JSON, published source, docs,
  or notes that describe the original; don't even use them to double-check.
- **Paid templates:** if the original is a commercial kit, mention the licensing risk
  once, then follow the user's decision.
- **Copy, don't improve.** Keep the original's data, copy (even typos such as
  "last last 30 days"), spacing and quirks unless the user asks otherwise. Improvements
  belong in a separate, explicit step.
- It is a long task: tell the user in a line what you are doing between phases.

## Workspace

Node resolves imports next to the script file, so copy the scripts into a scratch
workspace (use the session scratchpad) and install there:

```bash
WS="<scratchpad>/replica"; mkdir -p "$WS"
cp -r ~/.claude/skills/replicate-web-ui/scripts/. "$WS"
cd "$WS" && npm install && PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install chromium
```

Keep `PLAYWRIGHT_SKIP_BROWSER_GC=1`. The browser cache (`ms-playwright`) is shared by
every project on the machine, and a plain `playwright install` deletes the browser
builds it believes are unused. Once it wiped four Chromium, Firefox and WebKit builds
that other projects needed, and they had to be downloaded again. Without network,
pin the playwright version that matches a folder already in `ms-playwright`
(chromium-1181 ↔ 1.54, 1200 ↔ 1.57; the `browsers.json` of `playwright-core@<version>`
on unpkg lists the revisions). Every script prints its usage in its header comment.

| Script | Use it to |
|---|---|
| `capture.mjs` | Full-page screenshot, all JS/CSS/HTML responses, stack fingerprint, "settled?" check |
| `bundle-modules.mjs` | Split Turbopack/webpack chunks into modules; find them by visible text; follow imports |
| `rsc-refs.mjs` | Which client components an RSC page mounts, and their module ids |
| `behaviour-probe.mjs` | What the original does on its own, on hover and on the keyboard, before you build |
| `dom-dump.mjs` | Readable rendered DOM of a region, optionally after opening overlays |
| `css-rules.mjs` | CSS rules from the live CSSOM by selector regex (`--match`) or by declaration (`--decl`) |
| `tokens.mjs` | Custom properties and typography, light and dark |
| `icons.mjs` | Exact icon markup and the extra classes each icon carries |
| `measure.mjs` | Boxes and computed styles for a selector, original vs replica, after actions |
| `compare.mjs` | Full-page pixel diff at several widths |
| `element-diff.mjs` | Pixel diff of one element per page (component inside a bigger page); cached, parallel |
| `dom-diff.mjs` | Per-element box/font/color diff with normalized colors |
| `computed-diff.mjs` | *Every* computed property of every element, per state — sees what pixels cannot |
| `theme-leak.mjs` | Theme scales (`--ease-*`, `--radius-*`, `--text-*`) the host redefines under the block |
| `states.mjs` + `states.example.mjs` | Interaction matrix: same actions on both pages, diffed, with "did anything happen" checks |
| `png-tools.mjs` | Diff two PNGs; zoomed side-by-side crop of a hot cell |
| `fingerprint-version.mjs` | Which npm versions of a library contain a code fingerprint |

## Workflow

### 1. Recon

```bash
node capture.mjs --url <original> --out capture
```

Look at `capture/shot-1440.png` and `stack.json`. If the capture says the page had
not settled, raise `--wait`: charts and entry animations keep moving after
`networkidle` (the first shot of a dashboard showed every bar flat). If scripts
reference public sourcemaps, fetch them first; readable sources beat minified code.

### 2. Map the page

Write down the parts before extracting anything: the app shell (sidebar, header),
each section, every overlay (menus, popovers, dialogs, sheets), keyboard shortcuts,
responsive variants (below `md` a sidebar usually becomes a sheet) and dark mode.
Unrequested parts are easy to miss: if the page shows a shell around the content,
the shell is part of "igual". When unsure what a region does, hover and click it in a
headless Playwright session and screenshot.

Then find out what it *does*, before writing any code:

```bash
node behaviour-probe.mjs --url <original> --scope "<region>" [--dark]
```

It lists what animates on its own and, per control, what hover changes and what Enter,
Space and the arrows do. Twenty seconds here is worth an hour later: one dropdown
replica was finished and diffing at 0 px before anyone noticed Enter did not open the
original's menu. Write down every "(no effect)" too — that is behaviour to reproduce.

### 3. Extract, part by part

- **Which modules to read at all** (on a React Server Components page) →
  `rsc-refs.mjs <capture/html/page.html>`: the streamed payload names every client
  component the page mounts, so you grep a handful of modules instead of hundreds.
- **Logic, data, animation** → `bundle-modules.mjs --grep "<text visible in that part>" --deps`.
  Text found in no module means that part is server-rendered: use the DOM instead.
  Read `references/bundle-forensics.md` for chunk formats, import following and
  library fingerprints.
- **Structure and classes** → `dom-dump.mjs --selector <region>`; open overlays first
  with `--click`. The dump keeps icon classes and collapses repeated siblings with
  counts ("×32 … ×22"), which often *is* the data.
- **Rules not visible as utilities** (design-system classes like `.cn-button-*`,
  hover/focus/active, keyframes) → `css-rules.mjs --match … --scope …`.
- **Tokens and typography** → `tokens.mjs`. Note `font-feature-settings`: a host that
  sets `"cv11","ss01"` changes Geist's glyphs.
- **Icons** → `icons.mjs`, opening menus with `--click` so their icons are included.
- **Anything ambiguous** (an icon with no size class, an offset, a value the CSSOM
  printed as empty) → `measure.mjs`. Measure, don't guess.
- **Rendering math that depends on a library version** (bar widths, tick rounding,
  arc paths, fuzzy search) → grep the minified expression in the original, then
  `fingerprint-version.mjs` and pin that exact version.

### 4. Build

Port the code; don't reinterpret it. Read `references/replica-architecture.md` before
writing: it covers scoping tokens so the host theme cannot leak, translating
design-system classes into utilities without breaking layer precedence, containing an
app shell (sidebar overlay, portals, sticky header) inside a block, container queries
instead of viewport breakpoints, and giving the user a full-page route.

### 5. Verify until the diffs are zero or explained

For a whole page, diff the pages. For a component that lives inside someone else's
page, diff the elements (`element-diff.mjs`): the chrome around it will never match,
and it is not what you are replicating. That script is built for the loop you are
about to run many times — it caches the original (which never changes while you fix
the replica), runs cases in parallel, shares a page between cases that only look, and
captures as soon as the page stops moving. Twelve cases across three sections, two
themes and two widths take about 8 seconds on a rerun.

```bash
node compare.mjs      --original <url> --replica <url> --out cmp --widths 1440,1280,1024,800,390
node compare.mjs      --original <url> --replica <url> --out cmp --widths 1440 --dark
node compare.mjs      --original <url> --replica <url> --out cmp --widths 1440 --dark --threshold 4
node dom-diff.mjs     --original <url> --replica <url>
node theme-leak.mjs   --original <url> --replica <url> --replica-root '[data-slot="block"]'
cp states.example.mjs states.config.mjs   # edit URLs and actions
node states.mjs       --config states.config.mjs
node computed-diff.mjs --config states.config.mjs
```

Diff the widths on *both* sides of each breakpoint (1024 and 1023, 768 and 767): a
container query that is off by the width of a padding only shows at the edge.

`computed-diff.mjs` is what turns "the screenshots match" into "nothing differs".
Pixels cannot see a `cursor`, an easing curve, a transition duration, a color that only
appears on hover, or a 0.1px box. Run it at rest, with every overlay open, in dark mode
and at mobile width; it is normal for the first run to print host chrome as a count
mismatch, which `ignoreElements` removes.

For every non-zero result: zoom the hot cell with `png-tools.mjs pair`, then
`measure.mjs` the element on both pages, then read the relevant source or library
code, fix, rebuild and rerun *all* checks (a dependency pin can move other things).
`references/verification.md` has the investigation playbook and the traps that
produced false passes and false failures.

A residual difference is acceptable only when you can name its cause and it is not a
design difference: a race inside the original (a throttled `mousemove` landing after
`mouseleave`), hover that the browser did not recompute under a stationary pointer,
antialiasing on a layer that was just animated. Prove that last one instead of assuming
it: if forcing a repaint clears it, if it moves to the *original* on another run, and if
the computed styles are identical, it is Chromium's raster cache, not your CSS.

### 6. Deliver

Tell the user, in their language:

- where to see it, including a full-page URL: a docs preview narrower than the
  original's `md` breakpoint shows the mobile layout, which reads as "the sidebar
  doesn't expand";
- what was checked (widths, number of states, dark, mobile) and the result;
- every residual difference with its cause;
- side effects: version pins, files you removed or rewrote, new routes.

## Lessons that cost the most time

- **Hover color vs utility color.** In shadcn "style-*" systems the component rules
  live in `@layer base`; any utility on the element wins. A `text-muted-foreground`
  utility on a sidebar item beats the base rule's hover color, so hovered items stay
  gray while only the background changes. Reproduce the precedence, not just the
  declarations.
- **Library math.** recharts 3.9+ rounds bar width, 3.8 floors it: 19px vs 18px at
  1280 wide, invisible at 1440. Pin the version the original ships.
- **Stale local installs.** A package with its own `node_modules`/lockfile inside a
  workspace kept resolving the old version after `bun add`. Check the version the
  *app* resolves, not the one in `package.json`.
- **Diff thresholds hide surfaces and glows.** A 0.985 vs 1.0 background is 5 levels
  apart and passes a threshold of 40; so did a missing dark-mode text glow. Rerun with
  `--threshold 4` and measure computed backgrounds, gradients and shadows in both themes.
- **The user's browser is not a clean browser.** A difference the user sees but the
  scripts don't can come from preferences the original saved in their browser (a
  design-system style made the same buttons 40px instead of 36px). Get their DevTools
  measurements, find the storage keys in the bundle, load them and measure again.
- **`theme()` bakes in the host's light value.** Rewrite `theme(--color-x/.4)` in
  arbitrary values as `--theme(...)`, or the dark variant uses the light color.
- **False "0 px".** A hover at the wrong coordinates does nothing on both pages and
  diffs clean. `states.mjs` flags actions with no visible effect; still crop one or
  two states to see the effect with your own eyes. When an action legitimately changes
  nothing (a trigger whose hover background a utility cancels, a page too short to
  scroll), confirm it by reading the computed value, then say so in the report.
- **The host page's base layer is part of the block.** The original inherits rules that
  belong to its page, not to the component: `button:not(:disabled) { cursor: pointer }`,
  `body { font-synthesis-weight: none; text-rendering: optimizeLegibility }`. No
  screenshot shows a cursor. Find them with `css-rules.mjs --decl` and re-declare them
  scoped to the block root.
- **The host theme redefines Tailwind's scales.** A project that sets `--ease-out` or
  `--radius-lg` in its own `@theme` changes what `ease-out` and `rounded-md` mean inside
  your block: same classes, different animation curve and corners. `theme-leak.mjs`
  lists them; redeclare the scales on the block root.
- **A portal leaves the block's scope.** An overlay portaled to `<body>` stops
  inheriting the root's `color`, `font-*` and tokens, and picks up the host's instead —
  visible only in dark mode, where the two foregrounds differ. Give the portal wrapper
  the same classes and `data-slot` as the root.
- **A page that is dark by default ignores "light".** Emulating `prefers-color-scheme`
  does nothing when the theme is a class on `<html>`. Force it in `prep` on both pages:
  remove `dark`, add `light`, set `style.colorScheme`.
- **Write tokens the way the original declares them.** Reading `--foreground` back from
  the browser gives you a converted value (`lab(3.04863% 0 0)`), and re-declaring that
  converts it again: `#0b0b0b` came back as rgb(10,10,10) instead of rgb(11,11,11).
  Find the declaration (`css-rules.mjs --decl "--foreground:"`) and copy it verbatim.
- **The trigger is not the component.** A dropdown replica matched pixel for pixel and
  still behaved differently: the original's trigger was a motion button whose press
  gesture dispatches a synthetic `pointerdown` for keyboard presses, and the menu
  toggles on `pointerdown` as well as on Enter — so the first Enter opened and closed
  it, and Space was what opened the menu. Test the keyboard on every control and
  reproduce the mechanism you find, not the one you assume.
- **Text antialiasing depends on the page, not the component.** The same text rendered
  grayscale in the original and with subpixel colour fringes in the replica, because
  their page composited that region. It is hundreds of "different" pixels and nothing
  to fix: count colour-fringed pixels in each screenshot to identify it, then force the
  same mode on both (e.g. `will-change: transform` on the shared ancestor) and diff again.
- **Sub-pixel phase is not a design difference, but it reads as one.** The same section
  sat at y.5625 on the original's page and at a whole pixel on the replica's. Every glyph
  and every curve inside rasterized differently: 20 000 differing pixels with a replica
  whose boxes matched to 0.001px. Align the phase (`element-diff.mjs` does it: it records
  the original's fraction and shifts the replica by the difference). An outer `transform`
  does not fix it — it moves the element but not the phase of the layers inside it, and
  it changes how curves rasterize, so if you use one, use it on both sides.
- **Fixed page chrome lands in element screenshots.** A site's floating navbar paints over
  the component you are capturing, and every diff starts with a red band that has nothing
  to do with your replica. Hide `position: fixed`/`sticky` elements outside the target
  first (`hidePageChrome`).
- **Icons are in the bundle, not only in the DOM.** Icon packages ship as one tiny module
  per icon holding its exact path data; reading them is faster and more precise than
  opening menus in a browser to collect markup.
- **Infinite animations make every diff noise.** Freeze them on both pages with
  `--prep` / `config.prep` (a CSS override that pins the moving element), then verify
  the motion separately: measure the transform over time and compare speed, direction
  and the hover speed change.
- **Viewport vs container.** The user viewed the replica inside a 748px docs preview
  and concluded the hover sidebar was missing. Use container queries in the block and
  provide a full-page route.
