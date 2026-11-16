// Long choice lists (docs/progress.md, "long choice lists"): a decision
// with 13 routes at the default 800x600 viewport. The panel fits the
// window (title, hint and play-all status visible, the rows scrolling
// inside the list), the 13th row can be scrolled into view by the wheel
// over the list and clicked, the keyboard reaches it with ArrowDown and
// picks it with Enter, and a wheel walk back onto the screen scrolls its
// highlighted route into view. The wheel over the overflowing list scrolls
// it and walks nothing; elsewhere on the screen it walks as before.
//
// The content is its own small folder, built here from the demo's images:
// the demo fixture keeps its two-route decisions, which every other
// scenario counts on. Screenshots land in .tmp/choice-overflow/.
//
// The route pill never covers a choice screen (docs/progress.md): route 13
// is one item long, so the decision re-opens while its "Route: …" pill
// still shows; the pill goes as the choice opens. Its screenshot lands in
// .tmp/flash-choice/. The pill's first message is queued on a 0 ms timer
// and holds only until the next key, so a sampled read can land before it
// shows (and a Space sent then re-opens the choice, which rightly drops it
// unshown): a page-side recorder (PILL_RECORDER) logs every pill and choice
// change instead, and the check waits for the pill before the Space.

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CHOICE_OPEN,
  clickCenter,
  demoDir,
  pressEnter,
  pressKey,
  pressSpace,
  repoRoot,
  sleep,
  WHEEL_GAP_MS,
  WHEEL_PX,
} from "./harness.mjs";

export const title =
  "a 13-route decision at 800x600: fits, scrolls, clicks and keys reach every row";

const ROUTES = 13;
const folder = join(dirname(demoDir), "demo-choicelist");
const shots = join(repoRoot, ".tmp", "choice-overflow");
const flashShots = join(repoRoot, ".tmp", "flash-choice");

const LEAD_TEXT =
  "A long decision comes next: thirteen routes in a small window.";
const DECIDE_TEXT = "Thirteen routes: more than the digits 1-9 reach.";
const routeText = (n) => `Route ${n} ran: the reader picked it.`;
const PROMPT = "Which of the thirteen routes?";

/** The 13-route manifest, on the demo's own images. */
function buildFolder() {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  cpSync(demoDir, folder, { recursive: true });
  const routes = Array.from({ length: ROUTES }, (_, i) => i + 1);
  const manifest = {
    schemaVersion: 1,
    storyId: "kinetic-choicelist",
    title: "Kinetic long choice",
    width: 960,
    height: 540,
    items: [
      { id: "lead", type: "image", file: "intro-title.jpg", text: LEAD_TEXT },
      {
        id: "decide",
        type: "image",
        file: "branch-decide.jpg",
        text: DECIDE_TEXT,
      },
      ...routes.map((n) => ({
        id: `r${n}`,
        type: "image",
        file: "route1-start.jpg",
        text: routeText(n),
      })),
    ],
    branches: [
      {
        id: "wide",
        after: "decide",
        prompt: PROMPT,
        routes: routes.map((n) => ({
          id: `route${n}`,
          label: `Route ${n}: a label as long as a real game's menu line`,
          start: `r${n}`,
          end: `r${n}`,
        })),
      },
    ],
  };
  const json = JSON.stringify(manifest, null, 2);
  writeFileSync(join(folder, "manifest.json"), json);
  writeFileSync(
    join(folder, "manifest.js"),
    `window.KINETIC_MANIFEST = ${json};\n`,
  );
}

// The panel as laid out: boxes of the title, status, hint, list and rows.
const READ_LAYOUT = () => {
  const box = (el) => {
    if (el === null || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  const list = document.querySelector(".choice-list");
  const panel = document.getElementById("choice");
  return {
    open: panel !== null && !panel.hidden,
    vw: window.innerWidth,
    vh: window.innerHeight,
    title: box(document.querySelector(".choice-title")),
    auto: box(document.querySelector(".choice-auto")),
    hint: box(document.querySelector(".choice-hint")),
    hintText: document.querySelector(".choice-hint")?.textContent ?? null,
    list: box(list),
    scrollTop: list?.scrollTop ?? 0,
    overflows: list !== null && list.scrollHeight > list.clientHeight,
    rows: Array.from(document.querySelectorAll(".choice-row")).map((el) => ({
      idx: el.getAttribute("data-choice-idx"),
      cursor: el.classList.contains("choice-cursor"),
      next: el.classList.contains("choice-next"),
      rect: box(el),
    })),
    text: document.getElementById("overlay-text")?.textContent ?? "",
    // the #flash pill while it is on screen (not yet faded out)
    flash: (() => {
      const pill = document.getElementById("flash");
      return pill === null || pill.style.opacity === "0" ? null : box(pill);
    })(),
  };
};

const inViewport = (r, l) =>
  r !== null &&
  r.top >= 0 &&
  r.left >= 0 &&
  r.bottom <= l.vh &&
  r.right <= l.vw;
const inside = (r, outer) =>
  r !== null &&
  outer !== null &&
  r.top >= outer.top - 0.5 &&
  r.bottom <= outer.bottom + 0.5;
/** A row is reachable: inside the list's visible box and the viewport. */
const rowShown = (l, idx) => {
  const row = l.rows.find((r) => r.idx === String(idx));
  return (
    row !== undefined && inside(row.rect, l.list) && inViewport(row.rect, l)
  );
};
const overlaps = (a, b) =>
  a !== null &&
  b !== null &&
  a.left < b.right &&
  b.left < a.right &&
  a.top < b.bottom &&
  b.top < a.bottom;
/** The panel's boxes the #flash pill overlaps: title, hint, shown rows. */
const pillCovers = (l) =>
  [
    ["title", l.title],
    ["hint", l.hint],
    ["auto", l.auto],
    ...l.rows
      .filter((r) => inside(r.rect, l.list))
      .map((r) => [`row ${r.idx}`, r.rect]),
  ]
    .filter(([, r]) => overlaps(l.flash, r))
    .map(([name]) => name);

/** The fixed parts sit in the window, apart from the list, in order. */
const panelFits = (l) =>
  inViewport(l.title, l) &&
  inViewport(l.hint, l) &&
  inViewport(l.list, l) &&
  (l.auto === null || inViewport(l.auto, l)) &&
  l.title.bottom <= l.hint.top &&
  l.hint.bottom <= l.list.top;

const layout = (page) => page.evaluate(READ_LAYOUT);

// Page-side log of the #flash pill and the choice panel: each mutation
// batch (run before the next paint) records what changed, with
// performance.now(), and flags a batch that ends with the choice open and
// a pill still on it. `window.__pillLog` is read back by the check.
const PILL_RECORDER = () => {
  const log = { events: [], covered: [] };
  window.__pillLog = log;
  const now = () => Math.round(performance.now());
  const pill = () => {
    const el = document.getElementById("flash");
    return el === null || el.style.opacity === "0" ? null : el;
  };
  const choiceOpen = () => document.getElementById("choice")?.hidden === false;
  let wasPill = pill() !== null;
  let wasOpen = choiceOpen();
  new MutationObserver(() => {
    const isPill = pill() !== null;
    const isOpen = choiceOpen();
    if (isPill !== wasPill)
      log.events.push([now(), isPill ? "pill" : "no-pill"]);
    if (isOpen !== wasOpen)
      log.events.push([now(), isOpen ? "open" : "closed"]);
    if (isPill && isOpen) log.covered.push(now());
    wasPill = isPill;
    wasOpen = isOpen;
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["style", "hidden"],
  });
};
const PILL_SHOWN = () => document.getElementById("flash") !== null;
const pressDown = (cdp) => pressKey(cdp, "ArrowDown", "ArrowDown", 40, "");

const wheelAt = async (cdp, x, y, up) => {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: Math.round(x),
    y: Math.round(y),
    deltaX: 0,
    deltaY: up ? -WHEEL_PX : WHEEL_PX,
  });
  await sleep(WHEEL_GAP_MS + 80); // the smooth scroll settles too
};

async function waitFor(page, fn, arg, timeout = 3000) {
  try {
    await page.waitForFunction(fn, { timeout }, arg);
    return true;
  } catch {
    return false;
  }
}
const ON_TEXT = (t) =>
  (document.getElementById("overlay-text")?.textContent ?? "") === t;

/** From the lead, Space onto `decide` and Space again fires the decision. */
async function fireDecision(page, cdp) {
  await pressSpace(cdp);
  const onDecide = await waitFor(page, ON_TEXT, DECIDE_TEXT);
  await pressSpace(cdp);
  const opened = await waitFor(page, CHOICE_OPEN);
  await sleep(150);
  return onDecide && opened;
}

export default async function ({ check, open }) {
  buildFolder();
  mkdirSync(shots, { recursive: true });
  mkdirSync(flashShots, { recursive: true });
  const last = ROUTES - 1;

  // ------------------------------------------------------------------
  // Session "manual": play-all off; mouse, keyboard and wheel.
  // ------------------------------------------------------------------
  {
    const { page, cdp } = await open("manual", {
      closeHelp: true,
      manualChoices: true,
      folder,
    });
    const fired = await fireDecision(page, cdp);
    const l0 = await layout(page);
    await page.screenshot({ path: join(shots, "choice-800x600.png") });
    check(
      "at 800x600 the 13-route panel fits the window: title and hint shown above a list that scrolls its rows",
      fired &&
        l0.vw === 800 &&
        l0.vh === 600 &&
        l0.rows.length === ROUTES &&
        panelFits(l0) &&
        l0.overflows &&
        l0.hintText === "1-9, arrows and Enter, or click picks a route" &&
        rowShown(l0, 0) &&
        !rowShown(l0, last),
      { fired, l0: { ...l0, rows: l0.rows.length } },
    );

    // Mouse: the wheel over the list scrolls it (no walk) until the 13th
    // row shows; a click on it picks it.
    const center = (r) => [(r.left + r.right) / 2, (r.top + r.bottom) / 2];
    let l = l0;
    for (let i = 0; i < 12 && !rowShown(l, last); i += 1) {
      await wheelAt(cdp, ...center(l.list), false);
      l = await layout(page);
    }
    check(
      "the wheel over the overflowing list scrolls it to the 13th row and walks nothing",
      l.open && l.scrollTop > 0 && rowShown(l, last) && l.text === DECIDE_TEXT,
      { scrollTop: l.scrollTop, text: l.text, open: l.open },
    );
    const row13 = l.rows.find((r) => r.idx === String(last));
    await page.evaluate(PILL_RECORDER);
    await clickCenter(cdp, row13.rect);
    const clicked = await waitFor(page, ON_TEXT, routeText(ROUTES));
    // The route pill is queued as the route starts: wait for it (it holds
    // for ROUTE_PILL_MS) so the Space below lands while it shows.
    const pillShown = await waitFor(page, PILL_SHOWN);
    const afterClick = await layout(page);
    check(
      "a click on the 13th row picks route 13",
      clicked && !afterClick.open,
      { text: afterClick.text, open: afterClick.open },
    );

    // Keyboard: the route ends, the decision re-opens at the top; 13
    // ArrowDowns move the cursor to the 13th row, scrolled into view, and
    // Enter picks it.
    await pressSpace(cdp);
    const reopened = await waitFor(page, CHOICE_OPEN);
    await sleep(150);
    const r0 = await layout(page);
    const pillLog = await page.evaluate(() => window.__pillLog);
    await page.screenshot({ path: join(flashShots, "reopen-800x600.png") });
    const seq = pillLog.events.map(([, e]) => e).join(",");
    check(
      "the route pill showing as a short route re-opens the decision goes with it: nothing covers the title, hint or rows",
      pillShown &&
        afterClick.flash !== null &&
        reopened &&
        // shown after the pick closed the choice, gone by its re-open
        seq === "closed,pill,no-pill,open" &&
        pillLog.covered.length === 0 &&
        r0.flash === null &&
        pillCovers(r0).length === 0,
      {
        pillShown,
        pillBefore: afterClick.flash,
        pillAfter: r0.flash,
        covers: pillCovers(r0),
        pillLog,
      },
    );
    for (let i = 0; i < ROUTES; i += 1) await pressDown(cdp);
    await sleep(150);
    const k = await layout(page);
    await page.screenshot({ path: join(shots, "cursor-800x600.png") });
    const cursorRows = k.rows.filter((r) => r.cursor).map((r) => r.idx);
    check(
      "a re-opened decision starts at the top; 13 ArrowDowns put the cursor on the 13th row, in view",
      reopened &&
        r0.scrollTop === 0 &&
        r0.rows.every((r) => !r.cursor) &&
        JSON.stringify(cursorRows) === JSON.stringify([String(last)]) &&
        rowShown(k, last),
      { reopened, top: r0.scrollTop, cursorRows, scrollTop: k.scrollTop },
    );
    await pressEnter(cdp);
    const keyed = await waitFor(page, ON_TEXT, routeText(ROUTES));
    const afterEnter = await layout(page);
    check("Enter picks the cursor's row: route 13", keyed && !afterEnter.open, {
      text: afterEnter.text,
      open: afterEnter.open,
    });

    // The wheel walks back onto the choice screen (no list under the
    // pointer while route 13 shows): its highlighted route, row 13, is
    // scrolled into view.
    await wheelAt(cdp, 400, 300, true);
    const walked = await waitFor(page, CHOICE_OPEN);
    await sleep(150);
    const w = await layout(page);
    await page.screenshot({ path: join(shots, "walk-800x600.png") });
    const nextRows = w.rows.filter((r) => r.next).map((r) => r.idx);
    check(
      "a wheel walk back onto the screen highlights route 13 and scrolls it into view",
      walked &&
        JSON.stringify(nextRows) === JSON.stringify([String(last)]) &&
        w.scrollTop > 0 &&
        rowShown(w, last),
      { walked, nextRows, scrollTop: w.scrollTop },
    );

    // Over the list the wheel scrolls; over the title it walks on back.
    await wheelAt(cdp, ...center(w.list), true);
    const s = await layout(page);
    await wheelAt(cdp, ...center(s.title), true);
    const backed = await waitFor(page, ON_TEXT, DECIDE_TEXT);
    const b = await layout(page);
    check(
      "on the walked screen the wheel over the list scrolls it; over the title it walks back to the decision's item",
      s.open &&
        s.scrollTop < w.scrollTop &&
        s.text === w.text &&
        backed &&
        !b.open,
      { listScroll: [w.scrollTop, s.scrollTop], text: b.text, open: b.open },
    );
  }

  // ------------------------------------------------------------------
  // Session "playall": the countdown's status line and bar stay shown
  // with the long list, and the next pick is in view.
  // ------------------------------------------------------------------
  {
    const { page, cdp } = await open("playall", { closeHelp: true, folder });
    const fired = await fireDecision(page, cdp);
    const l = await layout(page);
    await page.screenshot({ path: join(shots, "playall-800x600.png") });
    const next = l.rows.find((r) => r.next);
    check(
      "under play-all the status line and bar show with the 13 rows, the panel fits, and the next pick is in view",
      fired &&
        l.auto !== null &&
        panelFits(l) &&
        l.overflows &&
        next !== undefined &&
        rowShown(l, Number(next.idx)),
      { fired, auto: l.auto, next: next?.idx, hint: l.hintText },
    );
  }
}
