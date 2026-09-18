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
   layout and dark mode.
3. **Extract**: split minified Turbopack/webpack chunks into modules and find them by
   visible text; dump the rendered DOM for final class lists and server-rendered parts;
   pull design-system rules and hover states from the CSSOM; read tokens in light and
   dark; copy exact icon markup; pin library versions whose math affects pixels.
4. **Build**: port data, formulas and animation parameters as they are; scope the
   original's tokens so the host theme can't leak in.
5. **Verify** until the diffs are zero or explained:
   - full-page pixel diffs at 1440, 1280, 1024, 800 and 390px, on both sides of each
     breakpoint, plus dark mode and a stricter threshold for glows and near-white surfaces;
   - an element-by-element diff of boxes, fonts and colors;
   - an interaction matrix (hovers, menus, dialogs, search, charts, toggles, mobile) that
     also flags actions that did nothing, so a missed hover can't pass as "0 px";
   - a diff of *every computed property of every element* in each of those states, which
     is the only check that sees a missing `cursor: pointer`, an easing curve the host
     theme redefined, or the color a portaled menu inherits from the host page.
6. **Deliver**: what was checked, the results, and every residual difference with its
   cause.

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
| `capture.mjs` | Full-page screenshot, all JS/CSS/HTML responses, stack fingerprint, "settled?" check |
| `bundle-modules.mjs` | Splits Turbopack/webpack chunks into modules, finds them by text, follows imports |
| `rsc-refs.mjs` | Which client components a React Server Components page mounts, and where they live |
| `dom-dump.mjs` | Readable rendered DOM of a region, optionally after opening overlays |
| `css-rules.mjs` | CSS rules from the live CSSOM by selector or by declaration, with @layer/@media context |
| `tokens.mjs` | Custom properties and typography, light and dark |
| `icons.mjs` | Exact icon markup and the classes each icon carries |
| `measure.mjs` | Boxes and computed styles, original vs replica, after actions |
| `compare.mjs` | Full-page pixel diff at several widths |
| `element-diff.mjs` | Pixel diff of one element per page, for a component inside a bigger page |
| `dom-diff.mjs` | Per-element box/font/color diff with normalized colors |
| `computed-diff.mjs` | Every computed property of every element, per state — what pixels can't show |
| `theme-leak.mjs` | Theme scales (`--ease-*`, `--radius-*`, `--text-*`) the host redefines under the block |
| `states.mjs` | Interaction matrix with "did anything happen" checks (`states.example.mjs` to start) |
| `png-tools.mjs` | PNG diff and zoomed side-by-side crops |
| `fingerprint-version.mjs` | Which npm versions of a library contain a code fingerprint |

## Running the scripts yourself

Node 18+. The agent copies the scripts into a scratch workspace; you can do the same:

```bash
cp -r ~/.claude/skills/replicate-web-ui/scripts/. ./replica-workspace
cd replica-workspace && npm install && PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install chromium

node capture.mjs --url https://example.com --out capture
node compare.mjs --original https://example.com --replica http://localhost:3000 --out cmp
```

Keep `PLAYWRIGHT_SKIP_BROWSER_GC=1`: without it, `playwright install` deletes browser
builds that other projects on the machine may still use.

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
