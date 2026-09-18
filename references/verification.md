# Verification playbook

The replica is finished when four independent checks agree, or every remaining
difference has a named cause that is not a design difference.

## Contents

1. The four checks
2. Choosing states
3. Investigating a difference
4. Traps: false passes
5. Traps: false failures
6. Keeping the loop fast
7. Reporting

## 1. The four checks

**Pixels, whole page, several widths** (`compare.mjs`). Both pages get the viewport
of the original's full height, so nothing scrolls and fixed/sticky elements line up.
Use at least the widths around each breakpoint the original has: 1440, 1280, 1024,
800, 390. Run `--dark` too. Differences at one width only usually mean rounding
(e.g. a library computing a bar width), not structure.

**A component, not a page** (`element-diff.mjs`). When the original lives inside a
gallery or docs page, the page around it is not part of the replica: screenshot the
component's own elements on both sides instead (a row of triggers, each open panel).
Three settings make that comparison honest: `hideChrome` (on by default) hides the host's
fixed navbar so it stops painting over the capture, `matchWidth` caps the replica's
wrapper at the width the original's element has at that viewport (a full-width section
against the same section in a narrower docs column), and `alignPhase` (on by default)
matches the sub-pixel offset the two pages leave the element at.
Two things the element's box leaves out, check separately: anything painted outside it
(a popover arrow sits above the panel) and where it sits relative to the control that
opened it — measure both boxes on each page and compare the offset, not the coordinates.

**Elements** (`dom-diff.mjs`). Catches what pixels hide: a font-weight on an svg, an
extra wrapper, colors that differ by a few levels. Colors are normalized through a
canvas because builds serialize the same color as `oklch()` or `lab()`. `COUNT`
lines shift the matching for everything after them; fix or explain those first.
Expected leftovers: `sr-only` text you render differently, whitespace that collapses
visually ("5.64K  orders" vs "5.64K orders"), aria-labels you added.

**States** (`states.mjs`). The same actions on both pages, diffed. Each state is also
compared with the untouched page, and a state whose action changed nothing is flagged.
That catches coordinates that miss their target, which otherwise pass as "0 px".

**Computed styles** (`computed-diff.mjs`). Every computed property of every element,
in each state of the same config. This is the only check that sees properties with no
pixels: `cursor`, an easing curve or duration, `font-synthesis`, a hover color on an
element the pointer is not on, a 0.1px box. On a finished-looking hero it still found
three real differences — missing `cursor: pointer` from the host page's base layer, an
`--ease-out` the host theme redefined, and a portaled menu inheriting the host's dark
foreground — none of which any screenshot could show. Run it at rest, with each overlay
open, in dark, and at mobile width.

When it reports a count mismatch, align the trees before reading the diffs: set
`originalRoot`/`replicaRoot` to each block's root, and put host chrome that has no
counterpart (`noscript`, a toaster region, analytics nodes) in `ignoreElements`.
A single extra element shifts every index after it and turns the report into noise.

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
- **Infinite animations never settle.** A marquee, a spinner or a pulsing dot makes
  every diff a lottery. Freeze both pages with `prep` (`compare.mjs --prep`,
  `config.prep`) — a `<style>` that pins the moving element (`transform: none
  !important`, `animation: none !important`) — and then verify the motion on its own:
  sample the transform over a few seconds on both pages and compare speed, direction,
  and how hovering changes it. A frozen slider that matches pixel for pixel can still
  run at the wrong speed.
- **Breakpoint edges.** Diff at the breakpoint and one pixel below it. A container that
  carries padding shifts every query by that padding, and only the edge width shows it.
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
  `measure.mjs` confirm it is not a design difference. One header that morphs on scroll
  left a glyph a third of a pixel off after the spring settled, in the *same* 36 pixels
  on every run — deterministic enough to look like a bug. Three things proved it was
  Chromium's raster cache: `computed-diff.mjs` found no property difference anywhere in
  the header, forcing a repaint (toggle a style, wait a frame) made the difference
  vanish, and on the production build it moved to the original instead. Before claiming
  a raster artifact, run those three; before assuming a real bug, remember that a
  repeatable pixel count is not proof of one.
- **Preferences saved in the user's browser.** The scripts use a clean browser, so
  they see the original's defaults. The user's browser may carry saved site settings
  (a design-system style, font, radius, density, theme, locale, an A/B flag) in
  `localStorage` or cookies. A template gallery rendered the same block with 40px
  buttons for the user (style "vega" saved) and 36px for the scripts (default "nova");
  every diff was 0 px and the user was still right about what they saw. When the user
  reports a difference you cannot reproduce: ask for DevTools numbers (box size of the
  element, viewport, zoom), check the site's storage keys in its bundle (search for
  `persist`, `localStorage`, `document.cookie`), then set those values in Playwright
  (`localStorage.setItem` before a reload, or `context.addCookies`) and measure again.
  Replicate the default unless the user asks for their variant, and tell them which one
  the replica follows.
- **Antialiasing mode from the page around it.** The same text can rasterize grayscale
  on one page and with subpixel colour fringes on the other, because an ancestor of one
  of them is composited. It looks like hundreds of differing pixels along every glyph.
  Count colour-fringed pixels (`max(|r-g|,|g-b|) > 12`) in each screenshot: if only one
  side has them, it is the page, not the component. Force the same mode on both in
  `prep` (e.g. `will-change: transform` on the shared ancestor) and diff again.
- **What shows through a transparent corner.** Four blue-ish pixels at the bottom-left
  of a rounded panel were the *original page's* content behind the corner, outside the
  border radius. Geometry, radius and colors were identical. Read the pixel values
  before assuming antialiasing: a hue that exists nowhere in the component is a
  give-away that you are seeing the background through it.
- **Sub-pixel phase.** Identical boxes, identical colors, and yet every glyph differs.
  The two pages leave the component at different fractional offsets, and a composited
  layer rasterizes at its own phase: on one section that was 20 000 pixels of "difference"
  over a replica measured identical to 0.001px. `element-diff.mjs` aligns it; if you are
  diffing by hand, shift the replica by `originalTop - floor(originalTop)` minus its own
  fraction, using margin (which moves the element) rather than a transform (which moves
  the element but not the phase of the layers inside it).
- **Color serialization.** `oklch(0.145 0 0)` vs `lab(2.75 0 0)` is the same color;
  compare normalized values (`dom-diff.mjs` does).

## 6. Keeping the loop fast

You will run these checks after every fix, so the loop's cost decides how many fixes you
dare to make. Four things pay for themselves immediately, and `element-diff.mjs` does all
four: cache the original (it does not change while you edit the replica), run the cases in
parallel, share one page between cases that only look at the page, and wait adaptively —
capture as soon as nothing has moved for 300ms instead of sleeping three seconds. A
verification pass that took five minutes takes under ten seconds, which is the difference
between checking once and checking after every change.

## 7. Reporting

State what you ran and what it showed, with numbers: widths × result, number of
states and how many matched, dark and mobile, element mismatches left and why. List
residual differences with causes, and every side effect (dependency pins, removed
artifacts, new routes). If something could not be verified (an animation mid-flight,
a behavior behind auth), say so.
