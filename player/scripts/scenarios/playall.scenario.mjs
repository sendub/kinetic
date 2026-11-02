// Play all routes (old driver step 40, plus docs/plan.md Phase 18): with
// `Play all routes` on, every decision auto-picks the first not-yet-played
// route in manifest order, the continuing route last, and `#choice` never
// surfaces. Each route-END re-selection (the journey jumping back to the
// decision for another route) holds a black `#interstitial` for
// INTERSTITIAL_MS naming the decision, the route just finished and the route
// now starting; a press ends it early. The route pill after it is the route
// alone (no "Back to try another route"), held ROUTE_PILL_MS, and the
// `e` ending hint never shows at a play-all route ending.

import { BACK_JUMP_MESSAGE } from "../../src/render/routes.ts";
import {
  branch,
  CONFIG_OPEN,
  clickCenter,
  currentItemId,
  item,
  pressC,
  pressSpace,
  pressTab,
  READ_CONFIG_OVERLAY,
  sleep,
} from "./harness.mjs";

export const title = "play all routes: auto-picks, interstitials, pills";

const INTERSTITIAL_MS = 2500; // machine.ts
const ROUTE_PILL_MS = 1600; // render/app.ts
const HOLD_TOLERANCE_MS = 400;

const outer = branch("outer");
const nested = branch("nested");
const routeLabel = (b, id) => b.routes.find((r) => r.id === id).label;

// A page-side timeline: every visible change (interstitial up/down and its
// rows, the #flash pill text and opacity, the ending hint, the caption, the
// painted image, #choice) recorded once with a performance.now() stamp, so
// holds are measured from the page's own clock, not the driver's polling.
const INSTALL_TIMELINE = () => {
  window.__timeline = [];
  if (window.__timelineObs) window.__timelineObs.disconnect();
  let last = "";
  let lastSnap = null;
  // Skip paces by pictures (docs/plan.md Phase 18): a burst walks its
  // `text` lines in zero time inside one task, so the observer's callback
  // sees only the final DOM. Each line the renderer wrote is still in the
  // mutation records (the Text node it put in #overlay-text keeps its
  // data), so those are logged first, as hidden-caption entries.
  const lines = (records) => {
    for (const record of records ?? []) {
      if (record.target?.id !== "overlay-text") continue;
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.TEXT_NODE || lastSnap === null) continue;
        if (node.data === lastSnap.text) continue;
        lastSnap = { ...lastSnap, text: node.data };
        last = JSON.stringify(lastSnap);
        window.__timeline.push({ t: performance.now(), ...lastSnap });
      }
    }
  };
  const probe = (records) => {
    lines(records);
    const inter = document.getElementById("interstitial");
    const flash = document.getElementById("flash");
    const hint = document.getElementById("end-card");
    const choice = document.getElementById("choice");
    const img = document.getElementById("visual-image");
    const snap = {
      inter: inter !== null && !inter.hidden,
      interPrompt: inter?.querySelector(".interstitial-prompt")?.textContent,
      flash: flash ? flash.textContent : null,
      flashOpaque: flash ? flash.style.opacity !== "0" : null,
      hint: hint !== null && !hint.hidden,
      text: document.getElementById("overlay-text")?.textContent ?? "",
      img: img ? (img.getAttribute("src") ?? "") : "",
      choice: choice !== null && !choice.hidden,
    };
    const key = JSON.stringify(snap);
    if (key === last) return;
    last = key;
    lastSnap = snap;
    window.__timeline.push({ t: performance.now(), ...snap });
  };
  window.__timelineObs = new MutationObserver(probe);
  window.__timelineObs.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "hidden", "style"],
    characterData: true,
  });
  probe();
};

const READ_INTERSTITIAL = () => {
  const panel = document.getElementById("interstitial");
  if (panel === null || panel.hidden) return { shown: false };
  const r = panel.getBoundingClientRect();
  return {
    shown: true,
    background: getComputedStyle(panel).backgroundColor,
    coversViewport:
      Math.abs(r.width - window.innerWidth) <= 1 &&
      Math.abs(r.height - window.innerHeight) <= 1,
    title: panel.querySelector(".interstitial-title")?.textContent ?? null,
    context: panel.querySelector(".interstitial-context")?.textContent ?? null,
    prompt: panel.querySelector(".interstitial-prompt")?.textContent ?? null,
    rows: Array.from(panel.querySelectorAll(".interstitial-row")).map((el) => ({
      label: el.querySelector(".interstitial-label")?.textContent ?? "",
      status: el.querySelector(".interstitial-status")?.textContent ?? "",
      now: el.classList.contains("interstitial-now"),
    })),
    choiceOpen: (() => {
      const c = document.getElementById("choice");
      return c !== null && !c.hidden;
    })(),
    hint: (() => {
      const h = document.getElementById("end-card");
      return h !== null && !h.hidden;
    })(),
  };
};

const INTER_SHOWN = () => {
  const p = document.getElementById("interstitial");
  return p !== null && !p.hidden;
};

const INTER_HIDDEN = () => {
  const p = document.getElementById("interstitial");
  return p === null || p.hidden;
};

const readTimeline = (page) => page.evaluate(() => window.__timeline);
const pageNow = (page) => page.evaluate(() => performance.now());

/** Turn the `c` switches on (play-all always; skip-all when asked). */
async function configure(page, cdp, { skipAll }) {
  await pressC(cdp);
  await page.waitForFunction(CONFIG_OPEN, { timeout: 5000 });
  const cfg = await page.evaluate(READ_CONFIG_OVERLAY);
  if (skipAll) await clickCenter(cdp, cfg.skipRect);
  await clickCenter(cdp, cfg.playRect);
  const after = await page.evaluate(READ_CONFIG_OVERLAY);
  await clickCenter(cdp, after.titleRect); // the backdrop closes the screen
  await sleep(150);
  const closed = !(await page.evaluate(CONFIG_OPEN));
  return { after, closed };
}

/** Space until the screen shows `id`; tolerant of media holds. */
async function walkTo(page, cdp, id, timeoutMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await currentItemId(page)) === id) return true;
    await pressSpace(cdp);
    await sleep(120);
  }
  return (await currentItemId(page)) === id;
}

/** Wait until the screen shows `id` (no input). */
async function waitFor(page, id, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await currentItemId(page)) === id) return true;
    await sleep(40);
  }
  return false;
}

/** Each #interstitial up/down span in the timeline: {shownAt, hiddenAt}. */
function interstitialSpans(timeline) {
  const spans = [];
  let open = null;
  for (const e of timeline) {
    if (e.inter && open === null)
      open = { shownAt: e.t, prompt: e.interPrompt };
    if (!e.inter && open !== null) {
      spans.push({ ...open, hiddenAt: e.t, ms: e.t - open.shownAt });
      open = null;
    }
  }
  if (open !== null) spans.push({ ...open, hiddenAt: null, ms: null });
  return spans;
}

/** Each #flash pill: its text, when it showed and when its fade began. */
function pillSpans(timeline) {
  const spans = [];
  let open = null;
  for (const e of timeline) {
    if (open !== null && (e.flash !== open.text || e.flashOpaque !== true)) {
      open.fadeAt = e.t;
      open.ms = e.t - open.shownAt;
      spans.push(open);
      open = null;
    }
    if (open === null && e.flash !== null && e.flashOpaque === true) {
      const prev = spans[spans.length - 1];
      // the same pill fading out is not a new pill
      if (!(prev && prev.text === e.flash && prev.fadeAt === e.t)) {
        open = { text: e.flash, shownAt: e.t };
      }
    }
  }
  if (open !== null) spans.push({ ...open, fadeAt: null, ms: null });
  return spans;
}

const firstIndex = (timeline, id) =>
  timeline.findIndex((e) => e.text === item(id).text && item(id).text !== "");
const firstImgIndex = (timeline, id) =>
  timeline.findIndex((e) => e.img === item(id).file);

export default async function ({ check, open }) {
  // ---- 1. Old step 40: play-all + skip-all burst, fresh slate ----------
  {
    const { page, cdp } = await open("burst", { closeHelp: true });
    const { after, closed } = await configure(page, cdp, { skipAll: true });
    await page.evaluate(INSTALL_TIMELINE);
    await pressTab(cdp);
    // One Tab carries the whole story: an elapsed interstitial resumes the
    // skip burst (play-all + skip-all is the no-interaction path).
    const endText = item("after-end").text;
    const tabs = 1;
    let reached = false;
    const start = Date.now();
    while (Date.now() - start < 40000) {
      const tl = await readTimeline(page);
      if (tl[tl.length - 1].text === endText) {
        reached = true;
        break;
      }
      await sleep(50);
    }
    await sleep(600); // a trailing overlay or stray advance would still show
    const tl = await readTimeline(page);
    const markers = [
      ["img", "branch-decide"],
      ["text", "route2-start"], // the alternate before the continuing route
      ["text", "route2-end"],
      ["text", "route1-start"],
      ["text", "route1-nest"],
      ["text", "nest-return"], // the inner return route before nest-a
      ["text", "nest-continue"],
      ["text", "route1-end"],
      ["text", "after-start"], // the aftermath follows every route
      ["text", "after-end"],
    ];
    const idx = markers.map(([kind, id]) =>
      kind === "img" ? firstImgIndex(tl, id) : firstIndex(tl, id),
    );
    const orderOk =
      idx.every((i) => i >= 0) &&
      idx.every((i, k) => k === 0 || i > idx[k - 1]);
    const noChoice = !tl.some((e) => e.choice);
    const spans = interstitialSpans(tl);
    check(
      "skip-all + play-all set in c before the walk (both switches on, screen closed)",
      after.skipPressed === "true" && after.playPressed === "true" && closed,
      after,
    );
    check(
      "the burst plays every route once, continuing route last at each decision, then the aftermath, on ONE Tab press",
      reached && orderOk,
      {
        reached,
        order: markers.map(([, id], i) => `${id}@${idx[i]}`).join(" "),
        tabs,
      },
    );
    check("#choice never surfaces during the play-all burst", noChoice, {
      samples: tl.length,
    });
    check(
      "the burst holds exactly two interstitials: the outer decision, then the nested one",
      spans.length === 2 &&
        spans[0].prompt === outer.prompt &&
        spans[1].prompt === nested.prompt,
      { spans, tabsNeeded: tabs },
    );
    check(
      "no ending hint at any play-all route ending in the burst",
      !tl.some((e) => e.hint && e.text !== endText),
      tl.filter((e) => e.hint),
    );
  }

  // ---- 2. Manual Space walk: interstitial content, hold, pills ---------
  {
    const { page, cdp } = await open("manual", { closeHelp: true });
    const { after, closed } = await configure(page, cdp, { skipAll: false });
    const atDecide = await walkTo(page, cdp, "branch-decide");
    await page.evaluate(INSTALL_TIMELINE);

    // First pick at the outer decision: route2, no interstitial, no choice.
    await pressSpace(cdp);
    const onRoute2 = await waitFor(page, "route2-start");
    await sleep(ROUTE_PILL_MS + 600);
    let tl = await readTimeline(page);
    const firstPills = pillSpans(tl);
    check(
      "play-all on (c); the first pick at a decision enters the first non-continuing route with no interstitial and no choice",
      after.playPressed === "true" &&
        closed &&
        atDecide &&
        onRoute2 &&
        interstitialSpans(tl).length === 0 &&
        !tl.some((e) => e.choice),
      { atDecide, onRoute2, timeline: tl.length },
    );
    check(
      "the first pick shows only the route pill, held ~1.6 s",
      firstPills.length === 1 &&
        firstPills[0].text === `Route: ${routeLabel(outer, "route2")}` &&
        Math.abs(firstPills[0].ms - ROUTE_PILL_MS) <= HOLD_TOLERANCE_MS,
      firstPills,
    );

    // The ending: no `e` hint while play-all will carry on.
    await pressSpace(cdp);
    const onEnd = await waitFor(page, "route2-end");
    await sleep(1200);
    tl = await readTimeline(page);
    const atEnd = tl.slice(firstIndex(tl, "route2-end"));
    check(
      "no ending hint at a play-all route ending",
      onEnd && atEnd.length > 0 && !atEnd.some((e) => e.hint),
      atEnd,
    );

    // The route end: the interstitial, held ~2.5 s by itself.
    await pressSpace(cdp);
    let interUp = true;
    try {
      await page.waitForFunction(INTER_SHOWN, { timeout: 2000 });
    } catch {
      interUp = false;
    }
    const view = await page.evaluate(READ_INTERSTITIAL);
    const leadText = item("branch-lead").text;
    const r1 = routeLabel(outer, "route1");
    const r2 = routeLabel(outer, "route2");
    const rowsOk =
      view.rows?.length === 2 &&
      view.rows[0].label === r1 &&
      view.rows[0].status === "now playing" &&
      view.rows[0].now === true &&
      view.rows[1].label === r2 &&
      view.rows[1].status === "just finished" &&
      view.rows[1].now === false;
    check(
      "a route end re-selection shows a black interstitial: prompt, context, finished and now-playing routes",
      interUp &&
        view.coversViewport &&
        view.background === "rgb(0, 0, 0)" &&
        view.prompt === outer.prompt &&
        view.context === `“${leadText}”` &&
        rowsOk &&
        view.choiceOpen === false,
      view,
    );
    check(
      "no ending hint during the interstitial",
      interUp && view.hint === false,
      view,
    );
    try {
      await page.waitForFunction(INTER_HIDDEN, {
        timeout: INTERSTITIAL_MS + 2000,
      });
    } catch {
      /* the span check below reports it */
    }
    const onRoute1 = await waitFor(page, "route1-start");
    await sleep(ROUTE_PILL_MS + 2600); // long enough for a queued second pill
    tl = await readTimeline(page);
    const spans = interstitialSpans(tl);
    check(
      "the interstitial holds ~2.5 s, then route 1 starts on its first item",
      spans.length === 1 &&
        spans[0].ms !== null &&
        Math.abs(spans[0].ms - INTERSTITIAL_MS) <= HOLD_TOLERANCE_MS &&
        onRoute1,
      { spans, onRoute1 },
    );
    const afterInter = pillSpans(
      tl.filter((e) => spans[0] && e.t >= spans[0].hiddenAt),
    );
    check(
      'after the interstitial the pill is "Route: <label>" only (no back pill), held ~1.6 s',
      afterInter.length === 1 &&
        afterInter[0].text === `Route: ${r1}` &&
        Math.abs(afterInter[0].ms - ROUTE_PILL_MS) <= HOLD_TOLERANCE_MS &&
        !tl.some((e) => e.flash === BACK_JUMP_MESSAGE),
      afterInter,
    );

    // Nested decision: first pick nest-b (no interstitial), its return end
    // brings the interstitial; Space ends it early.
    await pressSpace(cdp);
    const onNest = await waitFor(page, "route1-nest");
    const tNest = await pageNow(page);
    await pressSpace(cdp);
    const onReturn = await waitFor(page, "nest-return");
    await sleep(300);
    tl = await readTimeline(page);
    const nestFirst = interstitialSpans(tl.filter((e) => e.t >= tNest));
    check(
      "the nested decision's first pick is its return route, with no interstitial",
      onNest && onReturn && nestFirst.length === 0,
      { onNest, onReturn, nestFirst },
    );
    await pressSpace(cdp);
    let nestUp = true;
    try {
      await page.waitForFunction(INTER_SHOWN, { timeout: 2000 });
    } catch {
      nestUp = false;
    }
    const nview = await page.evaluate(READ_INTERSTITIAL);
    const na = routeLabel(nested, "nest-a");
    const nb = routeLabel(nested, "nest-b");
    check(
      "the return route's end shows the nested interstitial: 1b just finished, 1a now playing",
      nestUp &&
        nview.prompt === nested.prompt &&
        nview.rows?.length === 2 &&
        nview.rows[0].label === na &&
        nview.rows[0].status === "now playing" &&
        nview.rows[0].now === true &&
        nview.rows[1].label === nb &&
        nview.rows[1].status === "just finished",
      nview,
    );
    await sleep(500);
    const tPress = await pageNow(page);
    await pressSpace(cdp);
    const onContinue = await waitFor(page, "nest-continue", 1500);
    await sleep(400);
    // the press is consumed by the hold: it does not also step past 1a
    const stillOnContinue = (await currentItemId(page)) === "nest-continue";
    tl = await readTimeline(page);
    const nspans = interstitialSpans(tl.filter((e) => e.t >= tNest));
    const earlyMs =
      nspans[0]?.hiddenAt != null ? nspans[0].hiddenAt - tPress : null;
    check(
      "Space during the interstitial ends it early and enters the route on its first item",
      nspans.length === 1 &&
        earlyMs !== null &&
        earlyMs >= 0 &&
        earlyMs < 300 &&
        nspans[0].ms < INTERSTITIAL_MS - 1000 &&
        onContinue &&
        stillOnContinue,
      { nspans, earlyMs, onContinue, stillOnContinue },
    );

    // The continuing route's end joins the aftermath with no interstitial.
    await pressSpace(cdp);
    const onR1End = await waitFor(page, "route1-end");
    const tEnd = await pageNow(page);
    await pressSpace(cdp);
    const onAfter = await waitFor(page, "after-start");
    await sleep(INTERSTITIAL_MS + 300);
    tl = await readTimeline(page);
    const tail = tl.filter((e) => e.t >= tEnd);
    check(
      "the continuing route's end joins its continueAt with no interstitial",
      onR1End &&
        onAfter &&
        interstitialSpans(tail).length === 0 &&
        (await currentItemId(page)) === "after-start",
      { onR1End, onAfter, tail: tail.length },
    );
    check(
      "#choice never surfaced in the manual play-all walk",
      !tl.some((e) => e.choice),
    );
  }
}
