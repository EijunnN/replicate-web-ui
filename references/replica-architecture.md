# Building the replica

Patterns that made a Tailwind v4 + React replica render identically to a shadcn-based
original, inside a host site with its own theme. Most apply to any stack.

## Contents

1. Port, don't reinterpret
2. Classes: from design-system CSS to utilities
3. Tokens: scope the palette to the block
4. Icons, fonts, radii
5. App shells inside a block
6. Floating layers
7. Responsive: container queries and a full-page route
8. Behavior details that are easy to get wrong
9. Dependencies

## 1. Port, don't reinterpret

- Copy data arrays, generators and formulas exactly: date math (UTC vs local noon),
  `Math.round` vs `floor`, `% 43 === 0` spikes, the order of sorting.
- Copy animation parameters exactly: spring stiffness/damping per ring, tween
  duration and cubic-bezier, stagger delays, which values animate on mount vs hover.
- Copy text exactly, including the original's typos.
- When the original uses a library for rendering (recharts, d3-shape arcs, cmdk
  scoring), use the same library or a verbatim port. Hand-drawn approximations were
  the main reason the first replica of the dashboard was "not faithful".

## 2. Classes: from design-system CSS to utilities

The rendered DOM gives the final class list. Two kinds of classes appear:

- **Utilities** (`flex h-8 gap-1.5 text-muted-foreground`): copy as they are.
- **System classes** defined in CSS (`cn-button cn-button-variant-outline
  cn-button-size-default`): expand them into utilities using `css-rules.mjs` output.

Precedence is the subtle part. The system rules sit in `@layer base`; utilities sit in
`@layer utilities` and always win, regardless of specificity or order. So:

- `.cn-item-group:has([data-size=sm]) { gap: 10px }` + utility `gap-0` → gap is 0.
- `.cn-item-size-sm { padding: 10px 12px }` + utilities `gap-1.5 px-0` → padding-inline 0.
- `.cn-sidebar-menu-button:hover { color: accent-foreground }` + utility
  `text-muted-foreground` → hovered text stays muted; only the background changes.
  When you expand, **drop** the base declarations a utility overrides (don't add
  `hover:text-…`).

Other expansions worth knowing:

- `svg:not([class*='size-'])` rules become `[&_svg:not([class*='size-'])]:size-4`.
- `:where([data-state="on"])` → `data-[state=on]:`.
- `data-active:` in Tailwind matches the attribute's presence, so `data-active="false"`
  still matches. Render the attribute only when true, or use `data-[active=true]:`.
- Values printed as `padding-top: ;` by the CSSOM came from `var()` shorthands; read
  the real value with `measure.mjs` (a command input wrapper turned out to be
  `p-1 pb-0`, a 4px offset).

## 3. Tokens: scope the palette to the block

The host app's theme differs in small ways (muted-foreground 50% vs 55.6%, border
91% vs 92.2%, a purple ring, `font-feature-settings`). Scope the original's tokens to
the block root so nothing leaks, in both spellings, because hosts compile utilities
differently: shadcn's `@theme inline` emits `var(--background)`, a plain `@theme`
emits `var(--color-background)`.

```css
@layer base {
  [data-slot="my-block"] {
    --background: oklch(1 0 0);
    --muted-foreground: oklch(0.556 0 0);
    /* … every token the block uses, from tokens.mjs … */
    --color-background: var(--background);
    --color-muted-foreground: var(--muted-foreground);
    font-feature-settings: normal;
  }
  .dark [data-slot="my-block"] { --background: oklch(0.145 0 0); /* … */ }
  [data-slot="my-block"] *, [data-slot="my-block"] ::before, [data-slot="my-block"] ::after {
    border-color: var(--border); /* shadcn base rule, so plain `border` matches */
  }
}
```

- Register only utilities that may not exist in the host (`bg-chart-2`) with `@theme`.
  Don't register global names like `--color-primary`: that overrides the host app.
  For those, use arbitrary values (`bg-(--primary)`, `border-(--input)/30`).
- Include tokens used only by variants: the mobile sidebar sheet used `--sidebar`
  (0.985) while the desktop rail used `--background`.

## 4. Icons, fonts, radii

- Paste icon markup from `icons.mjs`; don't import a newer icon package version whose
  paths changed. Keep `width/height=24` attributes like lucide does.
- Match the font family and weight axis the original loads; check `fontsLoaded` in
  `stack.json`.
- Write radii in px (`rounded-[10px]`, `rounded-[8px]`): `rounded-lg` means 8px in
  default Tailwind and 10px in a shadcn theme.

## 5. App shells inside a block

When the original is a full app (fixed sidebar, window scroll, sticky header) and the
replica must live inside a page:

```
root  relative isolate flex size-full overflow-hidden @container   ← fills its parent
├─ sidebar rail   w-12 gap element + absolute inset-y-0 container (w-12 ↔ w-64 on hover)
├─ main           relative flex-1 overflow-y-auto   ← the scroll container
│  ├─ header      sticky top-0 z-40
│  └─ content
├─ sidebar overlay  absolute inset-0 z-40 (after main!)
└─ portal target for dialogs/sheets (the root itself)
```

- **Stacking:** the overlay and the sticky header both have `z-40`; the later element
  in the DOM wins. Put the overlay after `main`, or the header stays undimmed.
- **Hover-expand rail:** attach `onMouseEnter/Leave` to the wrapper that contains both
  the gap element and the absolute container; mouseenter ignores child boundaries.
- **The block needs a height.** Document it (`h-svh` for a page) and give the docs demo
  a fixed height similar to the original viewport (900px).

## 6. Floating layers

- **Dialogs, sheets:** portal into the block root and position `absolute inset-0`, so
  they cover the block (a fixed element inside the sticky header would only cover the
  header). Fall back to `document.body` + `fixed` when rendered outside the root.
- **Popovers and menus:** `absolute top-full right-0` inside a `relative flex`
  wrapper. `flex`, not block: a block wrapper around an `inline-flex` trigger adds a
  line box and shifts the trigger ~1px.
- **Offsets:** floating-ui/Radix round to device pixels. A 28px trigger centered in a
  55px header ends at 41.5; with `sideOffset 4` Radix renders at 46, so use
  `mt-[4.5px]`, not `mt-1`.
- **Animations:** Radix/tw-animate `enter` is opacity 0 + scale .95 (+ translate-y -8px
  for `side=bottom`) over 150ms (menus/dialogs often 100ms). Reproduce durations; exit
  usually has no translate.
- **Dismissal:** outside pointerdown and Escape; menus move focus with arrows and
  return it to the trigger.

## 7. Responsive: container queries and a full-page route

The original's breakpoints are viewport-based. A docs preview is narrower than the
viewport, so viewport breakpoints put a desktop layout in an 750px box (cramped), and a
faithful copy of the viewport logic would show mobile inside a desktop page. Use
container queries on the block root with the same pixel thresholds:

| original | container |
|---|---|
| `md:` (48rem) | `@3xl:` |
| `lg:` (64rem) | `@5xl:` |
| `xl:` (80rem) | `@7xl:` |
| `sm:` (40rem) | `@min-[40rem]:` |

Put `@container` on the root that spans the full width (sidebar included) so a
full-page render hits the same breakpoints as the original viewport.

Then add a full-page route for the block (e.g. `/view/<collection>/<slug>` rendering
the block in `h-svh`) and an "Open in new tab" link from the docs. Tell the user why
the preview shows the mobile layout.

## 8. Behavior details that are easy to get wrong

- **cmdk search** scores with command-score (word jumps, skipped chars,
  transpositions): "se" matches Storage, Sales, Customers, Secrets, Databases,
  Queues. Items sort by score *inside* each group; groups keep their order (cmdk's
  group sort silently fails because it queries by id). First item is selected after
  each keystroke; arrows loop. Port the scoring function rather than using `includes`.
- **Global shortcuts** (`/` opens search): ignore events from inputs/contenteditable
  and `preventDefault`, or the slash lands in the newly focused input.
- **Recharts `shape`** receives `x, y, width, height, index, payload, value`; custom
  segmented bars derive counts from `height`. Hover readouts via `onMouseMove` use
  `activeTooltipIndex` (recharts 3 has no `activePayload`). A `<Tooltip>` with
  `contentStyle={{ display: "none" }}` keeps the cursor rectangle and hides the box.
- **Mount animations** driven by a motion value (`animate(progress, 1, transition)`)
  render nothing on the server; that's fine and matches the original.
- **SVG pattern ids** must be unique per instance (`useId`), or two blocks on a page
  share fills.

## 9. Dependencies

- Add the libraries the original uses for rendering (e.g. `d3-shape` for arcs with
  `cornerRadius`/`padAngle`; its default `digits(3)` matches visx paths).
- Pin versions whose math affects pixels.
- After changing dependencies in a monorepo, confirm what the consuming app resolves
  (`node -p "require.resolve('pkg/package.json', { paths: [<package dir>] })"`). A
  package with its own lockfile and hoisted `node_modules` (left by an earlier
  standalone install) ignores workspace changes; remove those artifacts and reinstall
  from the root, and tell the user you did.
- A running dev server picks up rebuilt `dist/` output, but check the result with a
  diff, not an assumption.
