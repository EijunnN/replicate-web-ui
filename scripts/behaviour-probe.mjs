// What the original *does*, before you build anything: what moves on its own, what every
// control does on hover, and what the keyboard does to it. Run this in the mapping phase.
//
//   node behaviour-probe.mjs --url URL [--scope "main"] [--dark] [--limit 24] [--wait 3000]
//
// Finding this early is the difference between one build and two. A dropdown replica was
// finished and diffing at 0 px before anyone noticed that Enter did not open the original's
// menu: its trigger was a motion button whose press gesture dispatches a synthetic
// pointerdown, and the menu toggles on pointerdown too, so the first Enter opened and
// closed it. Two minutes here would have saved rebuilding the trigger afterwards.
//
// Reads, per control: the computed properties hover changes, and whether Enter, Space and
// the arrows open something, close something, or do nothing. "(no effect)" on a control
// that looks interactive is itself a finding — reproduce that too.
import { launch, openPage, need, parseArgs } from "./lib.mjs";

const args = parseArgs();
need(args, "url");
const scope = args.scope ?? "body";
const limit = Number(args.limit ?? 24);
const browser = await launch();
const { page } = await openPage(browser, args.url, {
  width: Number(args.width ?? 1440),
  height: Number(args.height ?? 1000),
  wait: Number(args.wait ?? 3000),
  dark: !!args.dark,
});

const WATCHED = [
  "backgroundColor",
  "color",
  "borderColor",
  "boxShadow",
  "transform",
  "opacity",
  "filter",
  "textDecorationLine",
  "letterSpacing",
  "backdropFilter",
  "cursor",
];

console.log("### what runs on its own");
const running = await page.evaluate((scope) => {
  const out = new Set();
  for (const el of document.querySelectorAll(`${scope}, ${scope} *`)) {
    for (const animation of el.getAnimations?.() ?? []) {
      if (animation.playState !== "running") continue;
      const timing = animation.effect?.getTiming?.() ?? {};
      out.add(
        `${el.tagName.toLowerCase()}.${(el.getAttribute("class") || "").slice(0, 40)} :: ${animation.animationName ?? "js"} ${timing.duration}ms ×${timing.iterations} ${timing.easing ?? ""}`,
      );
    }
  }
  return [...out];
}, scope);
console.log(running.length ? running.slice(0, 20).map((line) => `   ${line}`).join("\n") : "   (nothing; the page is settled)");

const controls = await page.evaluate(
  ([scope, limit]) => {
    const root = document.querySelector(scope) ?? document.body;
    const elements = [...root.querySelectorAll("button, a[href], [role='button'], [tabindex]:not([tabindex='-1']), summary")];
    return elements.slice(0, limit).map((el, index) => {
      el.dataset.probeId = String(index);
      return { id: index, tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().slice(0, 30), label: el.getAttribute("aria-label") ?? "" };
    });
  },
  [scope, limit],
);

const snapshot = () =>
  page.evaluate(() => ({
    nodes: document.querySelectorAll("*").length,
    open: [...document.querySelectorAll("[data-state='open'], [aria-expanded='true'], dialog[open]")].length,
    focus: document.activeElement?.textContent?.trim().slice(0, 24) ?? document.activeElement?.tagName,
  }));

const styleOf = (id) =>
  page.evaluate(
    ([id, watched]) => {
      const el = document.querySelector(`[data-probe-id="${id}"]`);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return Object.fromEntries(watched.map((property) => [property, cs[property]]));
    },
    [id, WATCHED],
  );

console.log("\n### hover and keyboard, per control");
for (const control of controls) {
  const locator = page.locator(`[data-probe-id="${control.id}"]`);
  if (!(await locator.isVisible().catch(() => false))) continue;
  await page.mouse.move(2, 2);
  await page.waitForTimeout(120);
  const before = await styleOf(control.id);
  const beforeState = await snapshot();
  await locator.hover({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(350);
  const after = await styleOf(control.id);
  const afterState = await snapshot();
  const changed = before && after ? WATCHED.filter((property) => before[property] !== after[property]) : [];
  const hover = changed.length
    ? changed.map((property) => `${property}: ${before[property]} → ${after[property]}`).join(", ")
    : "(no effect)";
  const opened = afterState.open - beforeState.open;

  await page.mouse.move(2, 2);
  await page.waitForTimeout(120);
  const keys = [];
  for (const key of ["Enter", "Space", "ArrowDown"]) {
    const base = await snapshot();
    await locator.focus({ timeout: 2000 }).catch(() => {});
    await page.keyboard.press(key === "Space" ? " " : key).catch(() => {});
    await page.waitForTimeout(450);
    const now = await snapshot();
    const delta = now.open - base.open;
    const moved = now.focus !== base.focus;
    keys.push(`${key}=${delta > 0 ? "opens" : delta < 0 ? "closes" : moved ? "moves focus" : "nothing"}`);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
  }
  const name = control.label || control.text || control.tag;
  console.log(`  <${control.tag}> "${name}"`);
  console.log(`     hover: ${hover}${opened > 0 ? "  (opens an overlay)" : ""}`);
  console.log(`     keys : ${keys.join("  ")}`);
}
await browser.close();
