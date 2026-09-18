// One config for every check. Copy it next to your work as replica.config.mjs, set the URLs,
// keep the sections that apply, then:   node verify.mjs --config replica.config.mjs
//
//   page      the replica is a whole page            → compare (+ dark), dom, states
//   elements  the block lives inside someone's page  → element-diff
//   states    interaction matrix                     → computed-diff (and states.mjs with `page`)
//
// Prefer semantic locators (aria-label, role, text) over coordinates: they survive layout
// differences and fail loudly when the replica lacks the control.
const BLOCK = '[data-slot="block"]';

const hover = (locate) => async (page) => {
  const target = locate(page);
  await target.scrollIntoViewIfNeeded();
  await target.hover();
  await page.waitForTimeout(900); // springs and transitions; settle() then waits for stillness
};

export default {
  original: "https://example.com/dashboard",
  replica: "http://localhost:3000/view/dashboard", // a production build: a dev server serializes CSS its own way
  out: "verify",
  viewport: { width: 1440, height: 900 },
  wait: 3000, // entry animations (charts, springs) must finish before acting
  threshold: 40,

  // Runs on both pages after load. Freeze what never settles, then verify that motion on its own:
  //   an infinite CSS animation      .marquee{animation:none!important;transform:none!important}
  //   a time-driven canvas           canvas{visibility:hidden!important}
  //   a state-driven loop (motion)   .log *{opacity:1!important;transform:none!important}   inline styles lose to !important
  // prep: `document.head.insertAdjacentHTML('beforeend','<style>…</style>')`,
  // replicaPrep: "document.querySelector('#banner')?.remove()",
  // replicaPrep is also where the replica gets the original's surroundings when it lives on its
  // own route: the gallery's frame (a data-frame div with its radius and a 1px ring), its column
  // width, its page colour on <body>. See references/verification.md, "The harness is part of…".

  // computed-diff: where each block starts, and host chrome that has no counterpart.
  // originalRoot: "body > div.min-h-screen",
  // replicaRoot: BLOCK,
  // ignoreElements: "noscript, section[aria-label*='Notifications']",
  // ignoreProps: "^(will-change)$",
  // ignoreTokens: "^--font", // theme-leak: next/font hashes its family names

  // ── A whole page ─────────────────────────────────────────────────────────────────────
  page: {
    widths: [1440, 1280, 1024, 1023, 800, 768, 767, 390], // both sides of every breakpoint
    dark: true,
  },

  // ── A block inside someone else's page ───────────────────────────────────────────────
  // elements: {
  //   selector: BLOCK,            // the block on both pages; a case may carry its own selector
  //   matchWidth: true,           // cap the replica at the width the original's block has
  //   widthAnchor: "[data-frame]",// what to cap (closest ancestor; default: the block's parent)
  //   phaseAnchor: "[data-frame]",// what to move when aligning position (default: the block)
  //   replicaIndex: 0,            // the block is second on the original's gallery page, alone on its own route
  //   // replicaSelector: "[data-slot=block]",   // when the two pages need different selectors (also per case)
  //   dark: true,
  //   viewport: { width: 1440, height: 7000 }, // tall: every whileInView reveal fires without scrolling
  //   // Pixels only — text in a composited layer rasterizes at that layer's origin, which the
  //   // page around the block decides. computed-diff still compares the real values.
  //   // prep: `…<style>[class*=will-change]{will-change:auto!important}[class*=backdrop-blur]{backdrop-filter:none!important}</style>…`,
  //   cases: [
  //     { name: "rest" },
  //     { name: "rest-light", dark: false },
  //     { name: "rest-390", viewport: { width: 390, height: 9000 } },
  //     { name: "card-hover", selector: `${BLOCK} .card`, index: 1, run: hover((page) => page.locator(`${BLOCK} .card`).nth(1)) },
  //     { name: "menu-open", selector: "[role=menu]", run: async (page) => { await page.getByLabel("Open account menu").click(); await page.waitForTimeout(600); } },
  //   ],
  // },

  // ── Interaction matrix ───────────────────────────────────────────────────────────────
  // static: nothing to trigger (a theme, a width). noEffect: an action you confirmed changes nothing.
  // A state may carry its own originalRoot / replicaRoot when the page holds several blocks.
  states: [
    { name: "sidebar-hover", run: async (page) => { await page.mouse.move(20, 300, { steps: 4 }); await page.waitForTimeout(900); } },
    { name: "notifications", run: async (page) => { await page.getByLabel("Open notifications").click(); await page.waitForTimeout(800); } },
    { name: "account-menu-item-hover", run: async (page) => { await page.getByLabel("Open account menu").click(); await page.waitForTimeout(600); await page.getByRole("menuitem", { name: "Settings" }).hover(); await page.waitForTimeout(400); } },
    { name: "search-filtered", run: async (page) => { await page.getByLabel("Open search").click(); await page.waitForTimeout(500); await page.keyboard.type("se"); await page.keyboard.press("ArrowDown"); await page.waitForTimeout(400); } },
    { name: "search-empty", run: async (page) => { await page.getByLabel("Open search").click(); await page.waitForTimeout(500); await page.keyboard.type("zzz"); await page.waitForTimeout(400); } },
    { name: "shortcut-slash", run: async (page) => { await page.keyboard.press("/"); await page.waitForTimeout(700); } },
    { name: "chart-hover", run: async (page) => { await page.mouse.move(530, 600, { steps: 4 }); await page.waitForTimeout(900); } },
    { name: "range-toggle", run: async (page) => { await page.getByRole("radio", { name: "3M" }).click(); await page.waitForTimeout(1500); } },
    { name: "lower-section-hover", fullHeight: true, run: async (page) => { await page.mouse.move(320, 1000, { steps: 4 }); await page.waitForTimeout(1200); } },
    { name: "mobile-menu", viewport: { width: 390, height: 844 }, run: async (page) => { await page.getByRole("button", { name: "Toggle Sidebar" }).click(); await page.waitForTimeout(900); } },
    { name: "dark", dark: true, fullHeight: true, static: true },
    // A page whose theme is a class on <html> ignores prefers-color-scheme: force it.
    // { name: "light", static: true, prep: 'document.documentElement.classList.remove("dark");document.documentElement.classList.add("light");document.documentElement.style.colorScheme="light"' },
  ],
};
