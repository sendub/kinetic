// Play all routes (docs/plan.md Phase 18, "Play all routes shows the
// choice"): with `Play all routes` on, every decision's #choice still shows,
// with a status line and a draining bar counting down for the screen's
// reading time (never under AUTO_PICK_MIN_MS); then the picked row lights
// up for AUTO_PICK_SHOW_MS and the route starts. The shortest unplayed
// route goes first, the continuing route last. A re-offer says which route
// just ended. Space takes the pick at once; a digit picks another route;
// `c` over the choice freezes the countdown. Inside a skip-all burst there
// is no countdown, only the highlight, and one Tab carries the whole story.

import {
  branch,
  CONFIG_OPEN,
  clickCenter,
  currentItemId,
  item,
  pressC,
  pressDigit,
  pressSpace,
  pressTab,
  READ_CONFIG_OVERLAY,
  sleep,
} from "./harness.mjs";

export const title = "play all routes: on-screen auto-picks, countdown, skip";

const AUTO_PICK_MIN_MS = 2500; // machine.ts
const AUTO_PICK_SHOW_MS = 700; // machine.ts
const MS_PER_CHAR = 60; // DEFAULT_SETTINGS at reading speed 1.00x
const ROUTE_PILL_MS = 1600; // render/app.ts
const TOLERANCE_MS = 500;

const outer = branch("outer");
const nested = branch("nested");
const routeLabel = (b, id) => b.routes.find((r) => r.id === id).label;
/** The countdown the machine sizes for a choice screen's words. */
const countdownMs = (b, backFrom) => {
  const words = [b.prompt, ...b.routes.map((r) => r.label)];
  if (backFrom !== undefined) words.push(routeLabel(b, backFrom));
  return Math.max(AUTO_PICK_MIN_MS, [...words.join(" ")].length * MS_PER_CHAR);
};

// A page-side timeline: every visible change (#choice up/down and its
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
    const flash = document.getElementById("flash");
    const hint = document.getElementById("end-card");
    const choice = document.getElementById("choice");
    const img = document.getElementById("visual-image");
    const snap = {
      flash: flash ? flash.textContent : null,
      flashOpaque: flash ? flash.style.opacity !== "0" : null,
      hint: hint !== null && !hint.hidden,
      text: document.getElementById("overlay-text")?.textContent ?? "",
      img: img ? (img.getAttribute("src") ?? "") : "",
      choice: choice !== null && !choice.hidden,
      prompt:
        choice !== null && !choice.hidden
          ? (choice.querySelector(".choice-title")?.textContent ?? "")
          : null,
      // the status line without its ticking seconds, so a tick is no change
      status:
        choice !== null && !choice.hidden
          ? (choice
              .querySelector(".choice-auto:not([hidden]) .choice-auto-text")
              ?.textContent?.replace(/\d+ s$/, "N s") ?? null)
          : null,
      picked:
        choice?.querySelector("[data-choice-picked] .choice-label")
          ?.textContent ?? null,
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

const READ_AUTO = () => {
  const c = document.getElementById("choice");
  if (c === null || c.hidden) return { open: false };
  const auto = c.querySelector(".choice-auto");
  return {
    open: true,
    prompt: c.querySelector(".choice-title")?.textContent ?? "",
    hint: c.querySelector(".choice-hint")?.textContent ?? "",
    autoShown: auto !== null && !auto.hidden,
    status: c.querySelector(".choice-auto-text")?.textContent ?? "",
    barWidth: c.querySelector(".choice-auto-fill")?.getBoundingClientRect()
      .width,
    picked:
      c.querySelector("[data-choice-picked] .choice-label")?.textContent ??
      null,
    seen: Array.from(c.querySelectorAll(".choice-row")).map(
      (row) => row.querySelector(".choice-seen") !== null,
    ),
  };
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

/** Each #choice up/down span: {prompt, shownAt, hiddenAt, ms, entries}. */
function choiceSpans(timeline) {
  const spans = [];
  let open = null;
  for (const e of timeline) {
    if (e.choice && open === null)
      open = { prompt: e.prompt, shownAt: e.t, entries: [] };
    if (open !== null && e.choice) open.entries.push(e);
    if (!e.choice && open !== null) {
      spans.push({ ...open, hiddenAt: e.t, ms: e.t - open.shownAt });
      open = null;
    }
  }
  if (open !== null) spans.push({ ...open, hiddenAt: null, ms: null });
  return spans;
}

/** When the picked row first lit up inside a span, or null. */
const pickedAt = (span) =>
  span.entries.find((e) => e.picked !== null)?.t ?? null;

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
  // ---- 1. play-all + skip-all: one Tab, highlights only ----------------
  {
    const { page, cdp } = await open("burst", { closeHelp: true });
    const { after, closed } = await configure(page, cdp, { skipAll: true });
    await page.evaluate(INSTALL_TIMELINE);
    await pressTab(cdp);
    const endText = item("after-end").text;
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
      ["text", "route2-start"],
      ["text", "route2-end"],
      ["text", "route1-start"],
      ["text", "route1-nest"],
      ["text", "nest-return"],
      ["text", "nest-continue"],
      ["text", "route1-end"],
      ["text", "after-start"],
      ["text", "after-end"],
    ];
    const idx = markers.map(([kind, id]) =>
      kind === "img" ? firstImgIndex(tl, id) : firstIndex(tl, id),
    );
    const orderOk =
      idx.every((i) => i >= 0) &&
      idx.every((i, k) => k === 0 || i > idx[k - 1]);
    const spans = choiceSpans(tl);
    check(
      "skip-all + play-all set in c before the walk (both switches on, screen closed)",
      after.skipPressed === "true" && after.playPressed === "true" && closed,
      after,
    );
    check(
      "one Tab plays every route once, continuing route last at each decision, then the aftermath",
      reached && orderOk,
      {
        reached,
        order: markers.map(([, id], i) => `${id}@${idx[i]}`).join(" "),
      },
    );
    check(
      "the burst shows each choice four times over (outer, its re-offer, nested, its re-offer), picked at once with no countdown",
      spans.length === 4 &&
        [outer, outer, nested, nested].every(
          (b, i) => spans[i].prompt === b.prompt,
        ) &&
        spans.every(
          (sp) =>
            sp.ms !== null &&
            Math.abs(sp.ms - AUTO_PICK_SHOW_MS) <= TOLERANCE_MS &&
            sp.entries.every((e) => e.picked !== null) &&
            !sp.entries.some((e) => e.status?.includes("picks in")),
        ),
      spans.map(({ prompt, ms, entries }) => ({
        prompt,
        ms,
        entries: entries.length,
      })),
    );
    check(
      "no ending hint at any play-all route ending in the burst",
      !tl.some((e) => e.hint && e.text !== endText),
      tl.filter((e) => e.hint),
    );
  }

  // ---- 2. Manual walk: countdown, highlight, re-offer, Space, digit ----
  {
    const { page, cdp } = await open("manual", { closeHelp: true });
    const { after, closed } = await configure(page, cdp, { skipAll: false });
    const atDecide = await walkTo(page, cdp, "branch-decide");
    await page.evaluate(INSTALL_TIMELINE);
    const r1 = routeLabel(outer, "route1");
    const r2 = routeLabel(outer, "route2");

    // The outer decision fires: the choice counts down, nothing picked yet.
    await pressSpace(cdp);
    await sleep(400);
    const first = await page.evaluate(READ_AUTO);
    check(
      "play-all on (c); the decision shows its choice counting down, with Space offered and nothing picked yet",
      after.playPressed === "true" &&
        closed &&
        atDecide &&
        first.open &&
        first.prompt === outer.prompt &&
        first.autoShown &&
        /^Play all routes picks in \d+ s$/.test(first.status) &&
        first.hint.includes("Space picks now") &&
        first.barWidth > 0 &&
        first.picked === null,
      first,
    );
    const onRoute2 = await waitFor(
      page,
      "route2-start",
      countdownMs(outer) + 3000,
    );
    await sleep(ROUTE_PILL_MS + 600);
    let tl = await readTimeline(page);
    let spans = choiceSpans(tl);
    const span1 = spans[0];
    const lit1 = span1 ? pickedAt(span1) : null;
    check(
      "it counts down for the screen's reading time, lights up the shortest route (Route 2), then enters it",
      onRoute2 &&
        spans.length === 1 &&
        lit1 !== null &&
        Math.abs(lit1 - span1.shownAt - countdownMs(outer)) <= TOLERANCE_MS &&
        span1.entries.find((e) => e.picked !== null)?.picked === r2 &&
        Math.abs(span1.hiddenAt - lit1 - AUTO_PICK_SHOW_MS) <= TOLERANCE_MS,
      {
        countdown: lit1 === null ? null : lit1 - span1.shownAt,
        expected: countdownMs(outer),
        show: lit1 === null ? null : span1.hiddenAt - lit1,
      },
    );
    const firstPills = pillSpans(tl);
    check(
      "the pick shows only the route pill",
      firstPills.length === 1 && firstPills[0].text === `Route: ${r2}`,
      firstPills,
    );

    // Route 2's ending: no end card while play-all carries on.
    await pressSpace(cdp);
    const onEnd = await waitFor(page, "route2-end");
    await sleep(800);
    tl = await readTimeline(page);
    const atEnd = tl.slice(firstIndex(tl, "route2-end"));
    check(
      "no ending hint at a play-all route ending",
      onEnd && atEnd.length > 0 && !atEnd.some((e) => e.hint),
      atEnd,
    );

    // The re-offer says which route ended and marks it seen.
    const tReoffer = await pageNow(page);
    await pressSpace(cdp);
    await sleep(400);
    const re = await page.evaluate(READ_AUTO);
    check(
      "the re-offer leads with the jump back, Route 2 marked seen",
      re.open &&
        re.status.startsWith(
          `Back in time: ${r2} done. Play all routes picks in`,
        ) &&
        re.seen[0] === false &&
        re.seen[1] === true,
      re,
    );
    const onRoute1 = await waitFor(
      page,
      "route1-start",
      countdownMs(outer, "route2") + 3000,
    );
    await sleep(ROUTE_PILL_MS + 600);
    tl = await readTimeline(page);
    spans = choiceSpans(tl.filter((e) => e.t >= tReoffer));
    const lit2 = spans[0] ? pickedAt(spans[0]) : null;
    check(
      "its countdown includes the ended route's name; then Route 1 starts with only its route pill",
      onRoute1 &&
        lit2 !== null &&
        Math.abs(lit2 - spans[0].shownAt - countdownMs(outer, "route2")) <=
          TOLERANCE_MS &&
        pillSpans(tl.filter((e) => e.t >= spans[0].hiddenAt))
          .map((p) => p.text)
          .join("|") === `Route: ${r1}`,
      { lit: lit2 === null ? null : lit2 - spans[0].shownAt },
    );

    // Nested decision: Space takes the pick at once, without also stepping.
    await pressSpace(cdp);
    const onNest = await waitFor(page, "route1-nest");
    await pressSpace(cdp); // fires the nested choice
    await sleep(300);
    const nestOpen = (await page.evaluate(READ_AUTO)).open;
    await pressSpace(cdp); // take it now
    const onReturn = await waitFor(page, "nest-return", 800);
    await sleep(400);
    check(
      "Space during the countdown takes the pick at once (1b, the shortest) and does not also step",
      onNest &&
        nestOpen &&
        onReturn &&
        (await currentItemId(page)) === "nest-return",
      { onNest, nestOpen, onReturn },
    );

    // Its re-offer: a digit picks instead of waiting.
    await pressSpace(cdp);
    await sleep(300);
    const nre = await page.evaluate(READ_AUTO);
    await pressDigit(cdp, "1");
    const onContinue = await waitFor(page, "nest-continue", 800);
    check(
      "the nested re-offer names 1b; a digit picks 1a at once",
      nre.open &&
        nre.status.startsWith(
          `Back in time: ${routeLabel(nested, "nest-b")} done.`,
        ) &&
        onContinue,
      nre,
    );

    // The continuing route's end joins with no choice.
    await pressSpace(cdp);
    const onR1End = await waitFor(page, "route1-end");
    const tEnd = await pageNow(page);
    await pressSpace(cdp);
    const onAfter = await waitFor(page, "after-start");
    await sleep(600);
    tl = await readTimeline(page);
    check(
      "the continuing route's end joins its continueAt with no choice",
      onR1End &&
        onAfter &&
        !tl.some((e) => e.t >= tEnd && e.choice) &&
        (await currentItemId(page)) === "after-start",
      { onR1End, onAfter },
    );
  }
}
