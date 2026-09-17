# Verification playbook

The replica is finished when three independent checks agree, or every remaining
difference has a named cause that is not a design difference.

## Contents

1. The three checks
2. Choosing states
3. Investigating a difference
4. Traps: false passes
5. Traps: false failures
6. Reporting

## 1. The three checks

**Pixels, whole page, several widths** (`compare.mjs`). Both pages get the viewport
of the original's full height, so nothing scrolls and fixed/sticky elements line up.
Use at least the widths around each breakpoint the original has: 1440, 1280, 1024,
800, 390. Run `--dark` too. Differences at one width only usually mean rounding
(e.g. a library computing a bar width), not structure.

**Elements** (`dom-diff.mjs`). Catches what pixels hide: a font-weight on an svg, an
extra wrapper, colors that differ by a few levels. Colors are normalized through a
canvas because builds serialize the same color as `oklch()` or `lab()`. `COUNT`
lines shift the matching for everything after them; fix or explain those first.
Expected leftovers: `sr-only` text you render differently, whitespace that collapses
visually ("5.64K  orders" vs "5.64K orders"), aria-labels you added.

**States** (`states.mjs`). The same actions on both pages, diffed. Each state is also
compared with the untouched page, and a state whose action changed nothing is flagged.
That catches coordinates that miss their target, which otherwise pass as "0 px".

## 2. Choosing states

Cover every behavior the user could notice:

- shell: sidebar hover-expand, collapsible group opened, item hover, mobile sheet;
- header: each popover/menu open, a menu item hovered, "mark all read"-style actions;
- search/command: open, filtered with arrow navigation, empty result, shortcut key;
- every chart: hover a point, switch ranges/toggles, hover legend-linked parts;
- lists and grids: row hover (bars that grow), cell click/selection;
- buttons: hover and press;
- lower sections with `fullHeight: true` so they are in view without scrolling;
- dark mode and a narrow viewport as `static` states.

Prefer semantic locators (`getByLabel`, `getByRole`) where both pages expose them;
use coordinates only for hover positions inside charts and rails, and wait for springs
and transitions (600–1500ms) before the screenshot.

## 3. Investigating a difference

1. **See it.** `png-tools.mjs pair original.png replica.png x y w h out.png --scale 3`
   around the hot cell. Most issues are obvious zoomed: a 1px vertical shift, text
   that turned dark on hover, a missing inner padding.
2. **Measure it.** `measure.mjs --url … --replica … --selector … [--click …]` on the
   element on both pages. Boxes identical but pixels different → color, antialiasing
   or a sub-pixel position. Boxes different → layout.
3. **Read the cause.** DOM classes (`dom-dump.mjs`), CSS rules (`css-rules.mjs`), SVG
   attributes (evaluate `getAttribute` on the rects), or the library source.
4. **Fix, rebuild, rerun everything.** A fix in one place (a dependency pin, a wrapper
   change) can move another.

Examples from the dashboard replica, each found this way:

| Symptom | Real cause | Fix |
|---|---|---|
| Header bell 1px higher | Block wrapper around an `inline-flex` button added a line box | `relative flex` wrapper |
| Popover 0.5px off | Radix rounds 45.5 → 46 | `mt-[4.5px]` |
| Sidebar hover text dark | Hover color came from a base-layer rule a utility overrides | Drop `hover:text-*` |
| Search input 4px higher | CSSOM printed `padding-top: ;` for `p-1` | Add `p-1 pb-0` wrapper |
| Search results differ | cmdk fuzzy scoring and per-group sort | Port command-score |
| Bars subtly different at 1280 only | recharts 3.10 rounds bar width, original 3.8 floors | Pin 3.8.1 |
| Pin had no effect | Package had its own lockfile and hoisted node_modules | Remove, reinstall from root |
| Mobile sheet slightly gray on original | Sheet uses `--sidebar`, not `--background` | Scope `--sidebar`, `bg-sidebar` |

## 4. Traps: false passes

- **Threshold blindness.** The pixel threshold (40) ignores antialiasing noise, and
  with it near-white surface differences (0.985 vs 1.0 is 5 levels), hover fills
  (white → 0.97) and soft effects: a 25px text glow at 40% alpha in dark mode passed at
  0 px while it was missing. When compare and states are clean, run them again with
  `--threshold 4`, and read the computed values that pixels barely show:
  `background-color`, `background-image`, `text-shadow`, `box-shadow`, `filter`, in
  light *and* dark, at rest *and* hovered.
- **Actions that did nothing.** A hover at a coordinate with no target gives 0 px on
  both. Trust `states.mjs` warnings and crop a couple of states to see the effect.
- **Unsettled animations.** Two pages captured mid-animation can match by accident or
  differ randomly. `capture.mjs` reports whether the page settled; wait past chart
  entry tweens (≈1.1s plus stagger) and springs.
- **Scroll position.** A replica that scrolls an inner container while the original
  scrolls the window can line up at the top and diverge below. Full-height viewports
  avoid it; `compare.mjs` notes document height mismatches.

## 5. Traps: false failures

- **Dev overlays** (`nextjs-portal`, Vite's error overlay) appear only on the replica.
  The scripts remove them; check a manual screenshot too.
- **Races inside the original.** recharts throttles `mousemove` to animation frames;
  when a pointer crosses a chart quickly, a late move event re-sets the hover readout
  after `mouseleave`, so the original's headline sticks. A path that crosses a chart
  on the way to another target reproduces it randomly. Move the pointer around charts
  (or accept and document it); don't replicate the race.
- **Hover under a stationary pointer.** When a sheet slides in under the cursor, one
  page may paint the hover and the other not until the mouse moves. Move the mouse a
  pixel before the screenshot if it matters.
- **Antialiasing on animated layers.** Text inside something that just finished a
  transform animation can rasterize differently. Identical boxes and colors in
  `measure.mjs` confirm it is not a design difference.
- **Color serialization.** `oklch(0.145 0 0)` vs `lab(2.75 0 0)` is the same color;
  compare normalized values (`dom-diff.mjs` does).

## 6. Reporting

State what you ran and what it showed, with numbers: widths × result, number of
states and how many matched, dark and mobile, element mismatches left and why. List
residual differences with causes, and every side effect (dependency pins, removed
artifacts, new routes). If something could not be verified (an animation mid-flight,
a behavior behind auth), say so.
