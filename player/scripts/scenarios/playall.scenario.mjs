// Play all routes (docs/plan.md Phase 18, "Play all routes shows the
// choice"): with `Play all routes` on, every decision's #choice still shows,
// with a status line and a draining bar counting down for the screen's
// reading time plus comprehension time per row (never under
// AUTO_PICK_MIN_MS, docs/plan.md Phase 20). The row it will pick is marked
// from the countdown's start; then it lights up as picked for
// AUTO_PICK_SHOW_MS and the route starts. The shortest unplayed
// route goes first, the continuing route last. A re-offer says which route
// just ended. Space takes the pick at once; a digit picks another route;
// `c` over the choice freezes the countdown. Inside a skip-all burst there
// is no countdown, only the highlight, and one Tab carries the whole story.

import {
  branch,
  CONFIG_OPEN,
  clickCenter,
  closeSettings,
  currentItemId,
  HELP_OPEN,
  item,
  openSettings,
  pressA,
  pressC,
  pressDigit,
  pressSpace,
  pressTab,
  READ_CONFIG_OVERLAY,
  sleep,
  wheel,
} from "./harness.mjs";

export const title = "play all routes: on-screen auto-picks, countdown, skip";

const AUTO_PICK_MIN_MS = 2500; // machine.ts
const AUTO_PICK_SHOW_MS = 700; // machine.ts
const MS_PER_CHAR = 60; // DEFAULT_SETTINGS at reading speed 1.00x
const CHOICE_BASE_MS = 1500; // machine/choicetext.ts
const CHOICE_PER_ROW_MS = 1000; // machine/choicetext.ts
const ROUTE_PILL_MS = 1600; // render/app.ts
const TOLERANCE_MS = 500;

const outer = branch("outer");
const nested = branch("nested");
const routeLabel = (b, id) => b.routes.find((r) => r.id === id).label;
/**
 * The countdown for a choice screen, written out longhand: every word it
 * draws (prompt, status line with its "Back in time" lead, each route label
 * and the `seen` marker on the route that just ended) at MS_PER_CHAR, plus
 * the comprehension time for its rows. Neither demo decision draws the
 * return row under play-all (the continuing route goes last).
 */
const countdownMs = (b, backFrom) => {
  const back =
    backFrom === undefined
      ? ""
      : `Back in time: “${routeLabel(b, backFrom)}” is done. `;
  const rows = b.routes.map((r) =>
    r.id === backFrom ? `${r.label} seen` : r.label,
  );
  const screen = [b.prompt, `${back}Play all routes picks in 0 s`, ...rows];
  return Math.max(
    AUTO_PICK_MIN_MS,
    [...screen.join(" ")].length * MS_PER_CHAR +
      CHOICE_BASE_MS +
      CHOICE_PER_ROW_MS * rows.length,
  );
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
      next:
        choice?.querySelector("[data-choice-next] .choice-label")
          ?.textContent ?? null,
      // every word #choice draws (prompt, status with its seconds, hint,
      // rows), so the pick can be shown to change none of them (Phase 24)
      words: choice !== null && !choice.hidden ? choice.textContent : null,
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
    next:
      c.querySelector("[data-choice-next] .choice-label")?.textContent ?? null,
    nextLook: (() => {
      const row = c.querySelector("[data-choice-next]");
      const plain = c.querySelector(
        ".choice-row:not([data-choice-next]):not([data-choice-picked])",
      );
      if (row === null || plain === null) return null;
      const a = getComputedStyle(row);
      const b = getComputedStyle(plain);
      return {
        differs:
          a.borderColor !== b.borderColor ||
          a.backgroundColor !== b.backgroundColor ||
          a.boxShadow !== b.boxShadow,
      };
    })(),
    seen: Array.from(c.querySelectorAll(".choice-row")).map(
      (row) => row.querySelector(".choice-seen") !== null,
    ),
  };
};

const readTimeline = (page) => page.evaluate(() => window.__timeline);
const pageNow = (page) => page.evaluate(() => performance.now());

/**
 * Turn the Esc screen's switches on (Phase 26) (play-all always; skip-all when asked). Play all
 * routes is on by default (docs/plan.md Phase 24), so its switch is only
 * clicked if a fresh profile somehow shows it off.
 */
async function configure(page, cdp, { skipAll }) {
  await openSettings(page, cdp);
  const cfg = await page.evaluate(READ_CONFIG_OVERLAY);
  if (skipAll) await clickCenter(cdp, cfg.skipRect);
  if (cfg.playPressed !== "true") await clickCenter(cdp, cfg.playRect);
  const after = await page.evaluate(READ_CONFIG_OVERLAY);
  await closeSettings(page, cdp); // its key closes it (a click never does)
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

/**
 * The words #choice drew across a span's picked phase (Phase 24): the
 * countdown's last frame, then every frame from the pick until the choice
 * hid. A clean pick has one distinct text there.
 */
function pickedPhaseWords(span) {
  const lit = span === undefined ? null : pickedAt(span);
  if (lit === null) return null;
  const last = span.entries.filter((e) => e.t < lit).at(-1);
  const during = span.entries.filter((e) => e.t >= lit);
  return {
    last: last?.words ?? null,
    during: [...new Set(during.map((e) => e.words))],
  };
}
const wordsFrozen = (w) =>
  w !== null &&
  w.last !== null &&
  w.during.length === 1 &&
  w.during[0] === w.last;

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
            new Set(sp.entries.map((e) => e.words)).size === 1,
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
    check(
      "from the countdown's start the row play-all will pick (Route 2) is marked, and looks different from the others",
      first.next === r2 && first.nextLook?.differs === true,
      { next: first.next, nextLook: first.nextLook },
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
    const beforeLit1 = span1
      ? span1.entries.filter((e) => lit1 === null || e.t < lit1)
      : [];
    check(
      "the next-pick mark is on Route 2 from the choice's first frame until it lights up as picked",
      beforeLit1.length > 0 && beforeLit1.every((e) => e.next === r2),
      beforeLit1.map(({ t, next, picked }) => ({ t, next, picked })),
    );
    check(
      "it counts down for every word on the screen plus comprehension time, lights up the shortest route (Route 2), then enters it",
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
    const frozen1 = pickedPhaseWords(span1);
    check(
      "the pick changes only the row highlight: #choice's words (status, seconds, hint, rows) stay as the countdown's last frame left them until the choice hides",
      wordsFrozen(frozen1),
      frozen1,
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
      "the re-offer leads with the jump back, Route 2 marked seen, Route 1 marked as the next pick",
      re.open &&
        re.status.startsWith(
          `Back in time: “${r2}” is done. Play all routes picks in`,
        ) &&
        re.seen[0] === false &&
        re.seen[1] === true &&
        re.next === r1 &&
        re.picked === null,
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
    const frozen2 = pickedPhaseWords(spans[0]);
    check(
      "on the re-offer too, the pick changes no word on #choice (the Back-in-time line and seconds stay)",
      wordsFrozen(frozen2),
      frozen2,
    );
    check(
      "its countdown includes the Back-in-time line and the seen marker; then Route 1 starts with only its route pill",
      onRoute1 &&
        lit2 !== null &&
        Math.abs(lit2 - spans[0].shownAt - countdownMs(outer, "route2")) <=
          TOLERANCE_MS &&
        pillSpans(tl.filter((e) => e.t >= spans[0].hiddenAt))
          .map((p) => p.text)
          .join("|") === `Route: ${r1}`,
      {
        lit: lit2 === null ? null : lit2 - spans[0].shownAt,
        expected: countdownMs(outer, "route2"),
      },
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
          `Back in time: “${routeLabel(nested, "nest-b")}” is done.`,
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

  // ---- 3. The Esc screen's settings work over a choice; `c` is gone -----
  {
    const { page, cdp } = await open("menu", { closeHelp: true });
    await configure(page, cdp, { skipAll: false });
    await walkTo(page, cdp, "branch-decide");
    await pressSpace(cdp); // the choice, counting down
    await sleep(300);
    const cfgUp = await openSettings(page, cdp);
    await sleep(countdownMs(outer) + AUTO_PICK_SHOW_MS + 500);
    const frozen = await page.evaluate(READ_AUTO);
    await pressDigit(cdp, "2"); // inert behind the screen
    await sleep(200);
    const stillChoice = (await page.evaluate(READ_AUTO)).open;
    await closeSettings(page, cdp);
    await sleep(200);
    const resumed = await page.evaluate(READ_AUTO);
    const entered = await waitFor(
      page,
      "route2-start",
      countdownMs(outer) + 3000,
    );
    check(
      "Esc opens the settings over a counting-down choice; the countdown is frozen behind it and digits are inert",
      cfgUp && frozen.open && frozen.picked === null && stillChoice,
      { cfgUp, frozen },
    );
    check(
      "closing the Esc screen restarts the countdown, which then picks",
      resumed.open && resumed.picked === null && entered,
      { resumed, entered },
    );

    // `c` is no key (Phase 26): on the Esc screen it changes nothing.
    const helpUp = await openSettings(page, cdp);
    await pressC(cdp);
    await sleep(200);
    const stillUp =
      (await page.evaluate(HELP_OPEN)) && (await page.evaluate(CONFIG_OPEN));
    check(
      "c does nothing on the Esc screen: keys and settings stay up",
      helpUp && stillUp,
      { helpUp, stillUp },
    );
  }

  // ---- 4. Rolling back restores the routes (docs/plan.md Phase 22) -----
  // The user's steps: play-all on, every route played to the end, the
  // wheel back to before the first decision, then forward again — with
  // Space, and with auto-forward. The repeat shows the choice with its
  // countdown and plays every route again in the same order; the rows keep
  // their seen marks.
  {
    const { page, cdp } = await open("rewind", { closeHelp: true });
    await configure(page, cdp, { skipAll: false });
    const where = async () => {
      const c = await page.evaluate(READ_AUTO);
      const id = await currentItemId(page);
      return c.open ? `${id}?` : id;
    };
    /** Space (taking each pick at once) to after-end, logging each screen. */
    const spaceToEnd = async () => {
      const path = [];
      for (let press = 0; press < 80; press += 1) {
        const at = await where();
        if (path[path.length - 1] !== at) path.push(at);
        if (at === "after-end") break;
        await pressSpace(cdp);
        await sleep(150);
      }
      return path;
    };
    /** Wheel back until branch-lead, the item before the decision's own. */
    const rollBack = async () => {
      for (let notch = 0; notch < 20; notch += 1) {
        await wheel(cdp, true, 1);
        if ((await where()) === "branch-lead") return true;
      }
      return false;
    };
    const first = await spaceToEnd();
    const fromDecide = (path) => path.slice(path.indexOf("branch-decide"));
    const back = await rollBack();
    await pressSpace(cdp); // branch-lead -> branch-decide
    await sleep(150);
    await pressSpace(cdp); // fires the outer decision
    await sleep(300);
    const fired = await page.evaluate(READ_AUTO);
    check(
      "rolled back before the first decision after play-all finished: Space fires the choice again, counting down, routes still marked seen",
      back &&
        fired.open &&
        fired.prompt === outer.prompt &&
        fired.autoShown &&
        /Play all routes picks in \d+ s$/.test(fired.status) &&
        fired.next === routeLabel(outer, "route2") &&
        fired.seen[0] === true &&
        fired.seen[1] === true,
      { back, fired },
    );
    const again = await spaceToEnd();
    check(
      "the repeat plays every route again, exactly as the first run did",
      JSON.stringify(fromDecide(["branch-decide", ...again])) ===
        JSON.stringify(fromDecide(first)),
      { first: fromDecide(first), again },
    );

    // The same with auto-forward instead of Space.
    const backAgain = await rollBack();
    await pressA(cdp);
    let counting = false;
    let pickedRoute2 = false;
    const start = Date.now();
    while (Date.now() - start < 40000) {
      const c = await page.evaluate(READ_AUTO);
      if (c.open && c.autoShown && c.prompt === outer.prompt) counting = true;
      if ((await currentItemId(page)) === "route2-start") {
        pickedRoute2 = true;
        break;
      }
      await sleep(100);
    }
    check(
      "with auto-forward instead: the choice counts down again and play-all enters Route 2 first",
      backAgain && counting && pickedRoute2,
      { backAgain, counting, pickedRoute2 },
    );
  }
}
