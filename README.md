# replicate-web-ui

A [Claude Code](https://claude.com/claude-code) skill for rebuilding a live web page's
UI and UX so it matches the original pixel for pixel, and proving it.

Instead of eyeballing screenshots, the agent reads what the browser actually receives
(minified JS chunks, CSSOM rules, the rendered DOM, computed tokens, icon markup), ports
it, and verifies the result with full-page pixel diffs at several widths, per-element
diffs and an interaction-state matrix (hovers, menus, dialogs, charts, mobile, dark
mode) until every difference is zero or has a named cause.

## Install

```bash
git clone https://github.com/EijunnN/replicate-web-ui ~/.claude/skills/replicate-web-ui
```

Claude Code picks it up automatically. It triggers when you ask for a page or
component to look and behave exactly like a URL, to clone or port a site's UI from
its client JS, or when an earlier replica "doesn't match".

## What's inside

| Path | Purpose |
|---|---|
| `SKILL.md` | Ground rules and the six-phase workflow: recon, map, extract, build, verify, deliver |
| `references/bundle-forensics.md` | Finding code in Turbopack/webpack chunks, server-rendered parts, library versions |
| `references/replica-architecture.md` | Scoped tokens, CSS layer precedence, app shells inside a block, floating layers, container queries |
| `references/verification.md` | Investigating diffs, choosing states, false passes and false failures |
| `scripts/` | Playwright tools: `capture`, `bundle-modules`, `dom-dump`, `css-rules`, `tokens`, `icons`, `measure`, `compare`, `dom-diff`, `states`, `png-tools`, `fingerprint-version` |

The scripts need Node 18+ and run from a scratch workspace:

```bash
cp -r ~/.claude/skills/replicate-web-ui/scripts/. ./replica-workspace
cd replica-workspace && npm install && PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install chromium
node capture.mjs --url https://example.com --out capture
```

Keep `PLAYWRIGHT_SKIP_BROWSER_GC=1`: without it, `playwright install` deletes browser
builds that other projects on the machine may still use.

## Responsible use

Reading a page's client code to study or reproduce its interface is common practice,
but the code, design and assets still belong to their authors. Check the license and
terms of anything you replicate, especially commercial templates, before reusing or
redistributing the result.
