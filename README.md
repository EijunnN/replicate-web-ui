# replicate-web-ui

An agent skill for rebuilding a live web page's UI and UX so it matches the original
pixel for pixel, and proving it with diffs instead of "looks the same to me".

[skills.sh](https://www.skills.sh/eijunnn/replicate-web-ui/replicate-web-ui) · built for [Claude Code](https://claude.com/claude-code)

## Why

Ask an agent to make a page "look exactly like this URL" and you usually get something
close: the layout is right, but a hover turns text dark instead of keeping it gray, a
popover sits a pixel off, chart bars are one pixel wider, the mobile menu has the wrong
background. Screenshots don't show those differences, and the agent declares success.

This skill changes the method. The agent reads what the browser actually receives, ports
it, and keeps checking until every difference is zero or has a named cause.

## Install

With the [skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add EijunnN/replicate-web-ui -g
```

Update it later with `npx skills update`. Or install manually:

```bash
git clone https://github.com/EijunnN/replicate-web-ui ~/.claude/skills/replicate-web-ui
```

## Use

The skill triggers on requests like:

- "Make our dashboard look and behave exactly like https://staging.example.com/dashboard"
- "Port this landing page from the old site to our Next.js app, it has to be identical"
- "The replica we built isn't faithful to the original, fix it"
- "Here's the reference URL and here's localhost:3000, make them match"

## How it works

1. **Recon**: full-page capture, every JS/CSS response, a fingerprint of the stack
   (bundler, React Server Components, Radix, shadcn, recharts, cmdk…).
2. **Map**: list every part, including the app shell, overlays, shortcuts, the mobile
   layout and dark mode; note the *install units* (two install commands on a gallery page
   are two components) and the module graph, which are the original's own component
   boundaries; then probe what the original *does* — what animates on its own,
   what hover changes, and what the keyboard does to every control — before writing code.
3. **Extract**: split minified Turbopack/webpack chunks into modules and find them by
   visible text; dump the rendered DOM for final class lists and server-rendered parts;
   pull design-system rules and hover states from the CSSOM; read tokens in light and
   dark; copy exact icon markup; pin library versions whose math affects pixels.
4. **Build**: port data, formulas and animation parameters as they are; scope the
   original's tokens so the host theme can't leak in. Then make it reusable: one deliverable
   per install unit, one component per module of the original's graph, pages as compositions
   of exported sections with their copy as props — refactored *under verification*, so
   splitting it cannot move a pixel.
5. **Verify** with one command and one config (`verify.mjs`) until the verdict is PASS or
   every difference is explained:
   - full-page pixel diffs at 1440, 1280, 1024, 800 and 390px, on both sides of each
     breakpoint, plus dark mode; every diff is also read at a threshold of 4, where a dense
     faint cell (a surface, a glow) fails and sparse edge antialiasing is only counted;
   - for a block inside someone else's page, an element diff that puts the replica at the
     original's exact document position, so both rasterize on the same tiles;
   - an element-by-element diff of boxes, fonts and colors;
   - an interaction matrix (hovers, menus, dialogs, search, charts, toggles, mobile) that
     also flags actions that did nothing, so a missed hover can't pass as "0 px";
   - a diff of *every computed property of every element* in each of those states, which
     is the only check that sees a missing `cursor: pointer`, an easing curve the host
     theme redefined, or the color a portaled menu inherits from the host page.
6. **Deliver**: what was checked, the results, and every residual difference with its
   cause.

The checks are meant to be rerun after every fix, so they cache the original, run in
parallel and wait adaptively. `verify.mjs --changed` reruns only what failed and can end at
"LOOP CLEAN", never at "PASS"; a full pass says PASS, and `--final` recaptures the original
and is the one to deliver on. The report is about thirty lines with the computed
differences grouped by cause; the full output of each check goes to a log.

The rework was validated with a mutation test: six known bugs injected into a passing
replica (a missing `cursor: pointer`, a default `--ease-out`, a hover at /80 instead of /90,
a surface six levels lighter, a wrong avatar seed, a missing full stop). All six turned the
verdict to FAIL, and no single check caught them all.

## What's inside

| Path | Purpose |
|---|---|
| `SKILL.md` | Ground rules and the six-phase workflow |
| `references/bundle-forensics.md` | Finding code in chunks, server-rendered parts, library fingerprints |
| `references/replica-architecture.md` | Scoped tokens, CSS layer precedence, app shells inside a block, floating layers, container queries |
| `references/verification.md` | Investigating diffs, choosing states, false passes and false failures |
| `scripts/` | Playwright tools, listed below |

| Script | What it does |
|---|---|
| `setup.mjs` | Prepares a workspace that is kept between sessions and prints its path |
| **`verify.mjs`** | **The whole verification from one `replica.config.mjs`: runs the checks below, short report, verdict, exit code** |
| `capture.mjs` | Full-page screenshot, all JS/CSS/HTML responses, stack fingerprint, "settled?" check |
| `bundle-modules.mjs` | Splits Turbopack/webpack chunks into modules, finds them by text, follows imports |
| `behaviour-probe.mjs` | What the original does on its own, on hover and on the keyboard, before you build |
| `rsc-refs.mjs` | Which client components a React Server Components page mounts, and where they live |
| `dom-dump.mjs` | Readable rendered DOM of a region, optionally after opening overlays |
| `css-rules.mjs` | CSS rules from the live CSSOM by selector or by declaration, with @layer/@media context |
| `tokens.mjs` | Custom properties and typography, light and dark |
| `icons.mjs` | Exact icon markup and the classes each icon carries |
| `measure.mjs` | Boxes and computed styles, original vs replica, after actions |
| `compare.mjs` | Full-page pixel diff at several widths |
| `element-diff.mjs` | Pixel diff of one element per page (component inside a bigger page); cached, parallel, position-aligned, with its own "did anything happen" check |
| `dom-diff.mjs` | Per-element box/font/color diff with normalized colors |
| `computed-diff.mjs` | Every computed property of every element, per state — what pixels can't show |
| `theme-leak.mjs` | Theme scales (`--ease-*`, `--radius-*`, `--text-*`) the host redefines under the block |
| `states.mjs` | Interaction matrix with "did anything happen" checks (`replica.config.example.mjs` to start) |
| `png-tools.mjs` | PNG diff and zoomed side-by-side crops |
| `fingerprint-version.mjs` | Which npm versions of a library contain a code fingerprint |

## Running the scripts yourself

Node 18+. `setup.mjs` keeps a workspace between sessions (`~/.cache/replicate-web-ui`, or
`--dir`) and prints its path; it installs once and afterwards only refreshes the scripts:

```bash
WS=$(node ~/.claude/skills/replicate-web-ui/scripts/setup.mjs)
node "$WS/capture.mjs" --url https://example.com --out capture
cp "$WS/replica.config.example.mjs" replica.config.mjs     # set the URLs and the checks
node "$WS/verify.mjs" --config replica.config.mjs          # full pass
node "$WS/verify.mjs" --config replica.config.mjs --changed  # after each fix: only what failed
node "$WS/verify.mjs" --config replica.config.mjs --final    # before delivering: original recaptured
```

It installs Chromium with `PLAYWRIGHT_SKIP_BROWSER_GC=1`: without it, `playwright install`
deletes browser builds that other projects on the machine may still use. Every script
still runs on its own and prints its usage in its header comment.

## Good uses

- Matching a production page while migrating it to a new stack or design system.
- Rebuilding your own UI when the original source is lost or unmaintainable.
- Turning a prototype or staging build into a component library, pixel for pixel.
- Studying how a well-crafted interface is put together.

## Responsible use

Reading a page's client code to study or reproduce its interface is common practice, but
the code, design and assets still belong to their authors. Check the license and terms of
anything you replicate, especially commercial templates, before reusing or redistributing
the result.
