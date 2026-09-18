// Copy to states.config.mjs next to the scripts, set the URLs and adapt the actions.
// Prefer semantic locators (aria-label, text) over coordinates: they survive layout
// differences and fail loudly when the replica lacks the control.
// `fullHeight: true` makes the viewport as tall as the page, for states below the fold.
// computed-diff.mjs reads the same file, and uses the *Root / ignore* fields below.
export default {
  original: "https://example.com/dashboard",
  replica: "http://localhost:3000/view/dashboard",
  out: "states",
  viewport: { width: 1440, height: 900 },
  wait: 3000, // entry animations (charts, springs) must finish before acting
  threshold: 40,
  // computed-diff.mjs only: where each block starts, and host chrome with no counterpart.
  // originalRoot: "body > div.min-h-screen",
  // replicaRoot: '[data-slot="dashboard"] > div',
  // ignoreElements: "noscript, section[aria-label*='Notifications']",
  // prep: "document.head.insertAdjacentHTML('beforeend','<style>.marquee{transform:none!important}</style>')", // both pages
  // replicaPrep: "document.querySelector('#banner')?.remove()",
  states: [
    { name: "sidebar-hover", run: async (page) => { await page.mouse.move(20, 300, { steps: 4 }); await page.waitForTimeout(900); } },
    { name: "notifications", run: async (page) => { await page.getByLabel("Open notifications").click(); await page.waitForTimeout(800); } },
    { name: "account-menu-item-hover", run: async (page) => { await page.getByLabel("Open account menu").click(); await page.waitForTimeout(600); await page.getByRole("menuitem", { name: "Settings" }).hover(); await page.waitForTimeout(400); } },
    { name: "search-open", run: async (page) => { await page.getByLabel("Open search").click(); await page.waitForTimeout(700); } },
    { name: "search-filtered", run: async (page) => { await page.getByLabel("Open search").click(); await page.waitForTimeout(500); await page.keyboard.type("se"); await page.keyboard.press("ArrowDown"); await page.waitForTimeout(400); } },
    { name: "search-empty", run: async (page) => { await page.getByLabel("Open search").click(); await page.waitForTimeout(500); await page.keyboard.type("zzz"); await page.waitForTimeout(400); } },
    { name: "shortcut-slash", run: async (page) => { await page.keyboard.press("/"); await page.waitForTimeout(700); } },
    { name: "chart-hover", run: async (page) => { await page.mouse.move(530, 600, { steps: 4 }); await page.waitForTimeout(900); } },
    { name: "range-toggle", run: async (page) => { await page.getByRole("radio", { name: "3M" }).click(); await page.waitForTimeout(1500); } },
    { name: "lower-section-hover", fullHeight: true, run: async (page) => { await page.mouse.move(320, 1000, { steps: 4 }); await page.waitForTimeout(1200); } },
    { name: "mobile-menu", viewport: { width: 390, height: 844 }, run: async (page) => { await page.getByRole("button", { name: "Toggle Sidebar" }).click(); await page.waitForTimeout(900); } },
    { name: "dark", dark: true, fullHeight: true, static: true },
    // A page whose theme is a class on <html> ignores prefers-color-scheme: force it.
    // { name: "light", prep: 'document.documentElement.classList.remove("dark");document.documentElement.classList.add("light");document.documentElement.style.colorScheme="light"', static: true },
  ],
};
