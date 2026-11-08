// Decisions and routes (old driver steps 34-39 and 46, rewritten for the
// Phase 18 rules and the Phase 27 timeline): the outer decision firing on
// the forward press from branch-decide, the ending route and its re-offer,
// the nested decision inside the continuing route, the continuing route's
// end running straight into the aftermath, reload inside branch content,
// `e` going to the furthest point read, the wheel walking the story along
// the last picks through each choice screen (the walk's route highlighted;
// a pick from one is real), the end card, and `u` reaching the next unseen
// content (an unplayed route, the nested 1b).
// The "Return to main route" row (numbered 0, with its "0 returns" hint) is
// drawn only once
// that decision's CONTINUING route has been completed at least once.
// Tab and `a` on a choice screen (docs/plan.md Phase 43) show their pill
// over it and move nothing; after the pick the mode set runs the route.

import { CHOICE_HINT, CONTINUE_HINT } from "../../src/render/choice.ts";
import { ALL_SEEN_TEXT } from "../../src/render/endcard.ts";
import {
  branch,
  CHOICE_OPEN,
  CONTINUE_LABEL,
  currentItemId,
  INSTALL_BRANCH_LOG,
  INSTALL_PILL_LOG,
  item,
  PAGE_STATE,
  PAINT_SIG,
  pressA,
  pressDigit,
  pressE,
  pressEnter,
  pressSpace,
  pressTab,
  pressU,
  READ_CHOICE,
  readBranchLog,
  readPills,
  sleep,
  spaceTo,
  wheel,
} from "./harness.mjs";

export const title =
  "decisions, routes, return rows, e, wheel, the end card and u";

const outer = branch("outer");
const nested = branch("nested");
const routeOf = (b, id) => b.routes.find((r) => r.id === id);
const route1 = routeOf(outer, "route1");
const route2 = routeOf(outer, "route2");
const nestA = routeOf(nested, "nest-a");
const nestB = routeOf(nested, "nest-b");

// The choice panel's hint line, the end card and the resume notice, as
// drawn.
const READ_HINTS = () => {
  const card = document.getElementById("end-card");
  const hint = card?.querySelector(".end-card-hint");
  const notice = document.getElementById("notice");
  return {
    choiceHint: document.querySelector(".choice-hint")?.textContent ?? null,
    endingShown: card !== null && !card.hidden,
    endingText: card?.querySelector(".end-card-title")?.textContent ?? null,
    endingKey: hint && !hint.hidden ? hint.textContent : null,
    noticeShown: notice !== null && !notice.hidden,
  };
};
const U_HINT = "Press u for the next one.";

const readChoice = (page) => page.evaluate(READ_CHOICE);
const readHints = (page) => page.evaluate(READ_HINTS);

/** Polls until the overlay is open (or shut); true when it got there. */
async function waitChoice(page, open, timeout = 3000) {
  const until = Date.now() + timeout;
  for (;;) {
    const c = await readChoice(page);
    if ((c.hidden === false) === open) return true;
    if (Date.now() > until) return false;
    await sleep(40);
  }
}

/** Polls until the screen shows item `id`; true when it did. */
async function waitOn(page, id, timeout = 3000) {
  const until = Date.now() + timeout;
  for (;;) {
    if ((await currentItemId(page)) === id) return true;
    if (Date.now() > until) return false;
    await sleep(40);
  }
}

/**
 * The overlay is exactly decision `b`: its prompt, its routes numbered
 * 1..n in manifest order with `seen` marks per `seenIds`, and the return
 * row (numbered 0, with the 0 hint) iff `withReturn`.
 */
function choiceIs(c, hints, b, seenIds, withReturn) {
  if (c.hidden !== false || c.prompt !== b.prompt) return false;
  const routes = c.rows.filter((r) => !r.isContinue);
  const ret = c.rows.filter((r) => r.isContinue);
  const routesOk =
    routes.length === b.routes.length &&
    b.routes.every(
      (r, i) =>
        routes[i].idx === String(i) &&
        routes[i].number === String(i + 1) &&
        routes[i].label === r.label &&
        routes[i].seen === (seenIds.includes(r.id) ? "seen" : null),
    );
  const returnOk = withReturn
    ? ret.length === 1 &&
      c.rows[c.rows.length - 1].isContinue &&
      ret[0].label === CONTINUE_LABEL &&
      ret[0].number === "0" &&
      hints.choiceHint === CHOICE_HINT + CONTINUE_HINT
    : ret.length === 0 && hints.choiceHint === CHOICE_HINT;
  return routesOk && returnOk;
}

/**
 * A screen as the walk tests name it: the item id, plus `+choice>N` on a
 * choice screen, N the highlighted row's number (the route the walk takes;
 * empty when none is).
 */
function screenLabel(s) {
  if (s.choice.hidden !== false) return s.id;
  const next = s.choice.rows.find((row) => row.next);
  return `${s.id}+choice>${next?.number ?? ""}`;
}

/** Snapshot of the overlay + hints for evidence and `choiceIs`. */
async function snap(page) {
  return {
    id: await currentItemId(page),
    choice: await readChoice(page),
    hints: await readHints(page),
  };
}

const logHas = (log, needle) => log.some((l) => l.includes(needle));

// Independent parts (each opens its own browser); the runner runs them
// side by side and prints their checks in this order.
export const parts = [
  walkSession,
  resumeSession,
  unseenSession,
  wheelSession,
  skipSession,
  rewindManualSession,
  choiceModesSession,
];

// ------------------------------------------------------------------
// Session "walk": first fire, Route 2 (ending) first, then Route 1 with
// 1b before 1a, the continuing end into the aftermath, then the scroll
// back from the end with everything seen.
// ------------------------------------------------------------------
async function walkSession({ check, open }) {
  const { page, cdp } = await open("walk", {
    closeHelp: true,
    manualChoices: true,
  });

  // 34. The forward press ONTO branch-decide shows it; the next forward
  // press fires the decision instead of moving.
  const reached = await spaceTo(page, cdp, outer.after);
  const arrival = await snap(page);
  await pressSpace(cdp);
  const fired = await waitChoice(page, true);
  const s34 = await snap(page);
  const sig = await page.evaluate(PAINT_SIG);
  await sleep(1500);
  const held = await snap(page);
  const sigHeld = await page.evaluate(PAINT_SIG);
  check(
    "34. the forward press from branch-decide opens #choice (prompt + 2 routes, no seen marks); the item does not advance",
    reached &&
      arrival.choice.hidden === true &&
      fired &&
      s34.id === outer.after &&
      choiceIs(s34.choice, s34.hints, outer, [], false) &&
      held.choice.hidden === false &&
      sig === sigHeld,
    { arrival, s34, sigSame: sig === sigHeld },
  );
  check(
    "34. a first fire draws no Return row and no 0 hint",
    s34.choice.rows?.every((r) => !r.isContinue) &&
      s34.hints.choiceHint === CHOICE_HINT,
    s34,
  );

  // 35. Route 2 (the ending route) plays; Route 1 is never painted; past
  // its end the decision re-opens with Route 2 marked seen and NO Return
  // row, since Route 1 (the continuing route) was never completed.
  await page.evaluate(INSTALL_BRANCH_LOG);
  await pressDigit(cdp, "2");
  const closed35 = await waitChoice(page, false);
  const start2 = await snap(page);
  const start2State = await page.evaluate(PAGE_STATE);
  await pressSpace(cdp);
  const onEnd2 = await waitOn(page, route2.end);
  const end2 = await snap(page);
  await pressSpace(cdp);
  const reopen35 = await waitChoice(page, true);
  const s35 = await snap(page);
  const log35 = await readBranchLog(page);
  const route1Items = [
    "route1-start",
    "route1-nest",
    "nest-continue",
    "nest-return",
    "route1-end",
  ];
  const route1Shown = route1Items.filter(
    (id) =>
      logHas(log35, item(id).text) ||
      (item(id).file && logHas(log35, item(id).file)),
  );
  check(
    "35. digit 2 plays Route 2 (route2-start, route2-end); no Route 1 item is ever shown",
    closed35 &&
      start2.id === route2.start &&
      start2State.imgSrc === item(route2.start).file &&
      onEnd2 &&
      route1Shown.length === 0,
    { start2, end2: end2.id, route1Shown, log35 },
  );
  check(
    "35. past route2-end the outer decision re-opens: Route 2 seen, Route 1 unmarked, NO Return row (Route 1 never completed)",
    reopen35 && choiceIs(s35.choice, s35.hints, outer, ["route2"], false),
    s35,
  );
  check(
    "end card on route2-end counts Route 1 + nested 1a/1b and the aftermath, offering u",
    end2.id === route2.end &&
      end2.hints.endingShown === true &&
      end2.hints.endingText === "3 routes and other content still unseen." &&
      end2.hints.endingKey === U_HINT &&
      start2.hints.endingShown === false,
    { start2: start2.hints, end2: end2.hints },
  );

  // 36. Route 1: the nested decision fires on the forward press from
  // route1-nest. 1b (return) re-opens it with 1b seen and NO Return row;
  // 1a then completes and rejoins at route1-end with no overlay.
  await page.evaluate(INSTALL_BRANCH_LOG);
  await pressDigit(cdp, "1");
  const closed36 = await waitChoice(page, false);
  const start1 = await currentItemId(page);
  await pressSpace(cdp);
  const onNest = await waitOn(page, nested.after);
  const nestArrivalShut = (await readChoice(page)).hidden === true;
  await pressSpace(cdp);
  const nestFired = await waitChoice(page, true);
  const nest1 = await snap(page);
  await pressDigit(cdp, "2"); // 1b
  const onB =
    (await waitChoice(page, false)) && (await waitOn(page, nestB.start));
  await pressSpace(cdp);
  const nestReopen = await waitChoice(page, true);
  const nest2 = await snap(page);
  check(
    "36. digit 1 enters Route 1; the forward press from route1-nest fires the nested decision (2 routes, no Return row)",
    closed36 &&
      start1 === route1.start &&
      onNest &&
      nestArrivalShut &&
      nestFired &&
      nest1.id === nested.after &&
      choiceIs(nest1.choice, nest1.hints, nested, [], false),
    { start1, nest1 },
  );
  check(
    "36. 1b (return) plays and re-opens the nested decision with 1b seen and NO Return row (1a never completed)",
    onB &&
      nestReopen &&
      choiceIs(nest2.choice, nest2.hints, nested, ["nest-b"], false),
    nest2,
  );

  await pressDigit(cdp, "1"); // 1a
  const onA =
    (await waitChoice(page, false)) && (await waitOn(page, nestA.start));
  // Logged from 1a's own item on: the rejoin must be the very next screen.
  await page.evaluate(INSTALL_BRANCH_LOG);
  await pressSpace(cdp);
  const rejoined = await waitOn(page, nested.continueAt);
  const rejoin = await snap(page);
  const logA = await readBranchLog(page);
  check(
    "36. 1a plays and its end rejoins Route 1 at route1-end with no overlay between",
    onA &&
      rejoined &&
      rejoin.choice.hidden === true &&
      logA.length === 2 &&
      logA[0].includes(item(nestA.start).text) &&
      logA[1].includes(item(nested.continueAt).text) &&
      !logHas(logA, "choice-open"),
    { rejoin, logA },
  );

  // The nested decision's continuing route is now complete: walking back
  // to its choice screen on route1-nest shows it with the Return row (the
  // rule as it stands now), and 0 answers it onto route1-end (Enter is
  // no key: pressed first, it changes nothing).
  const path = [];
  let arrivedNest = null;
  for (let i = 0; i < 6; i += 1) {
    await wheel(cdp, true, 1);
    await sleep(80);
    const s = await snap(page);
    path.push(`${s.id}${s.choice.hidden === false ? "+choice" : ""}`);
    if (s.id === nested.after) {
      arrivedNest = s;
      break;
    }
  }
  check(
    "36. after 1a completes, walking back to route1-nest's choice screen shows both marks AND the Return row (numbered 0) + 0 hint",
    arrivedNest !== null &&
      choiceIs(
        arrivedNest.choice,
        arrivedNest.hints,
        nested,
        ["nest-a", "nest-b"],
        true,
      ),
    { path, arrivedNest },
  );
  await pressEnter(cdp);
  await sleep(300);
  const afterEnter = await snap(page);
  check(
    "Enter does nothing on a choice screen with the Return row: still open, same item",
    afterEnter.id === nested.after &&
      afterEnter.choice.hidden === false &&
      choiceIs(
        afterEnter.choice,
        afterEnter.hints,
        nested,
        ["nest-a", "nest-b"],
        true,
      ),
    afterEnter,
  );
  await pressDigit(cdp, "0");
  const zeroBack =
    (await waitChoice(page, false)) && (await waitOn(page, nested.continueAt));
  check(
    "0 picks the Return row: the nested decision is answered onto route1-end",
    zeroBack,
    await snap(page),
  );

  // 37. route1-end is the continuing route's end: one press goes straight
  // into after-start, no overlay; the aftermath plays once.
  await page.evaluate(INSTALL_BRANCH_LOG);
  await pressSpace(cdp);
  const onAfter = await waitOn(page, outer.continueAt);
  await sleep(300);
  const after = await snap(page);
  const afterState = await page.evaluate(PAGE_STATE);
  const log37 = await readBranchLog(page);
  check(
    "37. off route1-end straight into after-start (continueAt): no overlay, painted once",
    onAfter &&
      after.choice.hidden === true &&
      afterState.imgSrc === item(outer.continueAt).file &&
      !logHas(log37, "choice-open") &&
      log37.filter((l) => l.includes(item(outer.continueAt).file)).length === 1,
    { after, log37 },
  );

  // Everything has been seen now: the card says so, with no u line.
  await pressSpace(cdp);
  const onEnd = await waitOn(page, "after-end");
  await sleep(200);
  const end = await snap(page);
  check(
    "end card on after-end says everything has been seen once every item has been",
    onEnd &&
      end.hints.endingShown === true &&
      end.hints.endingText === ALL_SEEN_TEXT &&
      end.hints.endingKey === null,
    end,
  );

  // Scroll back from the end: the story order along the last picks
  // (Route 1, then 1a), every choice screen on that path a step with the
  // walk's route highlighted, the current marks and the Return row (each
  // continuing route is done). Route 2 and 1b, picked earlier, are off
  // the path.
  const back = [];
  const views = {};
  for (let i = 0; i < 16; i += 1) {
    await wheel(cdp, true, 1);
    await sleep(80);
    const s = await snap(page);
    const label = screenLabel(s);
    back.push(label);
    if (s.choice.hidden === false && views[label] === undefined)
      views[label] = s;
    if (label === outer.after) break;
  }
  const expectBack = [
    outer.continueAt,
    nested.continueAt,
    nestA.start,
    `${nested.after}+choice>1`,
    nested.after,
    route1.start,
    `${outer.after}+choice>1`,
    outer.after,
  ];
  const viewIs = (label, b, seenIds) =>
    views[label] !== undefined &&
    choiceIs(views[label].choice, views[label].hints, b, seenIds, true);
  check(
    "scrolling back from after-end walks the story along the last picks, choice screens highlighting the route with both marks and the Return row",
    back.join() === expectBack.join() &&
      viewIs(`${nested.after}+choice>1`, nested, ["nest-a", "nest-b"]) &&
      viewIs(`${outer.after}+choice>1`, outer, ["route1", "route2"]),
    { back, views },
  );
}

// ------------------------------------------------------------------
// Session "resume": Route 2, then Route 1 via 1a only — 1b is the one
// unseen span. Ending hint at after-end, the wheel stepping over the
// unplayed span, e resuming, reload inside branch content, and `e`.
// ------------------------------------------------------------------
async function resumeSession({ check, open }) {
  const { page, cdp } = await open("resume", {
    closeHelp: true,
    manualChoices: true,
  });
  await spaceTo(page, cdp, outer.after);
  await pressSpace(cdp);
  await waitChoice(page, true);
  await pressDigit(cdp, "2");
  await waitOn(page, route2.start);
  await pressSpace(cdp);
  await waitOn(page, route2.end);
  await pressSpace(cdp);
  await waitChoice(page, true);
  await pressDigit(cdp, "1");
  await waitOn(page, route1.start);
  await pressSpace(cdp);
  await waitOn(page, nested.after);
  await pressSpace(cdp);
  await waitChoice(page, true);
  await pressDigit(cdp, "1"); // 1a
  await waitOn(page, nestA.start);
  await pressSpace(cdp);
  await waitOn(page, nested.continueAt);
  await pressSpace(cdp);
  await waitOn(page, outer.continueAt);
  await pressSpace(cdp);
  const atEnd = await waitOn(page, "after-end");
  await sleep(200);
  const end = await snap(page);
  check(
    "end card on after-end counts the one unseen route (1b) and offers u",
    atEnd &&
      end.hints.endingShown === true &&
      end.hints.endingText === "1 route still unseen." &&
      end.hints.endingKey === U_HINT,
    end,
  );

  // The timeline check (docs/plan.md Phase 27): after Route 2 then
  // Route 1, the scroll back from the aftermath walks the story along the
  // LAST pick — Route 1's items with its nested choice screen (1a
  // highlighted), then the first choice screen with Route 1 highlighted,
  // then the decision picture — never Route 2 (picked before) or the
  // unplayed 1b, and it never halts on a choice screen.
  const back = [];
  const views = {};
  for (let i = 0; i < 14; i += 1) {
    await wheel(cdp, true, 1);
    await sleep(80);
    const s = await snap(page);
    const label = screenLabel(s);
    back.push(label);
    if (s.choice.hidden === false && views[label] === undefined)
      views[label] = s;
    if (label === outer.after) break;
  }
  const expectBack = [
    outer.continueAt,
    nested.continueAt,
    nestA.start,
    `${nested.after}+choice>1`,
    nested.after,
    route1.start,
    `${outer.after}+choice>1`,
    outer.after,
  ];
  const viewOf = (label) => views[label] ?? { choice: {}, hints: {} };
  const nestView = viewOf(`${nested.after}+choice>1`);
  const firstView = viewOf(`${outer.after}+choice>1`);
  check(
    "after Route 2 then Route 1, scrolling back from the aftermath follows the last pick: Route 1's items, the nested and first choice screens (route highlighted), then the decision picture",
    back.join() === expectBack.join() &&
      !back.some((e) => e.startsWith(nestB.start) || e.startsWith("route2")),
    { back, expectBack },
  );
  check(
    "the walked choice screens carry the current marks and Return rows (nested: 1a seen; outer: both seen)",
    choiceIs(nestView.choice, nestView.hints, nested, ["nest-a"], true) &&
      choiceIs(
        firstView.choice,
        firstView.hints,
        outer,
        ["route1", "route2"],
        true,
      ),
    { nestView, firstView },
  );

  // Forward again from the decision picture: the same screens in order,
  // the choice screens highlighting the route about to be taken.
  const fwd = [];
  for (let i = 0; i < expectBack.length; i += 1) {
    await wheel(cdp, false, 1);
    await sleep(80);
    fwd.push(screenLabel(await snap(page)));
  }
  check(
    "the wheel forward walks the same screens back to the furthest point (after-end) and stops there",
    fwd.join() === [...expectBack.slice(0, -1).reverse(), "after-end"].join(),
    { fwd },
  );

  // Walk back again, then `e` returns to the furthest point read.
  await wheel(cdp, true, 3);
  await sleep(80);
  await pressE(cdp);
  const resumed =
    (await waitOn(page, "after-end")) && (await waitChoice(page, false));
  check(
    "e from a walked-back point returns to the furthest point read (after-end)",
    resumed,
    await snap(page),
  );

  // 38. Reload resumes on after-end; no decision fires on load.
  await sleep(400);
  const sig = await page.evaluate(PAINT_SIG);
  await page.reload();
  await sleep(700);
  const r = await page.evaluate(PAGE_STATE);
  const rSnap = await snap(page);
  const sigResumed = await page.evaluate(PAINT_SIG);
  await sleep(1500);
  const sigHeld = await page.evaluate(PAINT_SIG);
  const rHeld = await readChoice(page);
  check(
    "38. reload resumes inside branch content on the last-read item (after-end); no decision re-fires on load",
    rSnap.id === "after-end" &&
      sigResumed === sig &&
      sigHeld === sig &&
      rSnap.choice.hidden === true &&
      rHeld.hidden === true &&
      r.helpOpen === false &&
      r.stageHidden === false,
    { rSnap, sig, sigResumed, sigHeld },
  );
  check(
    "end card is restored with the reload; no resume notice (the only unseen route was declined)",
    rSnap.hints.endingShown === true &&
      rSnap.hints.endingText === "1 route still unseen." &&
      rSnap.hints.noticeShown === false,
    rSnap.hints,
  );

  // The last picks came back with the reload: the wheel still walks
  // back along them, and `e` returns to the furthest point.
  await wheel(cdp, true, 2);
  await sleep(120);
  const rolled = await currentItemId(page);
  await pressE(cdp);
  const reEnd = await waitOn(page, "after-end");
  check(
    "after the reload the wheel walks back along the saved last picks (route1-end) and e returns to after-end",
    rolled === nested.continueAt && reEnd,
    { rolled, reEnd },
  );

  // 39. `e` at the furthest point stays put: it never jumps to the
  // never-taken 1b, and the hint keeps saying content is unseen.
  const endSig = await page.evaluate(PAINT_SIG);
  await pressE(cdp);
  await sleep(400);
  const endSigHeld = await page.evaluate(PAINT_SIG);
  const stayed = await snap(page);
  check(
    "39. e at the furthest point stays put (no jump to the unseen 1b), the end card still showing",
    stayed.id === "after-end" &&
      endSig === endSigHeld &&
      stayed.hints.endingShown === true &&
      stayed.hints.endingText === "1 route still unseen.",
    { stayed, endSig, endSigHeld },
  );

  // Reach 1b the reader's way: walk back to the nested choice screen and
  // pick it (a real pick), return, and read to the end.
  let nestScreen = false;
  for (let i = 0; i < 8 && !nestScreen; i += 1) {
    await wheel(cdp, true, 1);
    await sleep(80);
    const s = await snap(page);
    nestScreen = s.id === nested.after && s.choice.hidden === false;
  }
  await pressDigit(cdp, "2"); // 1b
  const onB =
    (await waitChoice(page, false)) && (await waitOn(page, nestB.start));
  await pressSpace(cdp);
  const bReoffer = await waitChoice(page, true);
  await pressDigit(cdp, "0"); // the Return row: 1a completed long ago
  const backOnRoute1 =
    (await waitChoice(page, false)) && (await waitOn(page, nested.continueAt));
  await pressSpace(cdp);
  await waitOn(page, outer.continueAt);
  await pressSpace(cdp);
  const onEnding = await waitOn(page, "after-end");
  await sleep(200);
  const ending = await snap(page);
  check(
    "39. a pick of 1b from the walked nested screen plays it; Return and Space read on to after-end",
    nestScreen && onB && bReoffer && backOnRoute1 && onEnding,
    { nestScreen, onB, bReoffer, backOnRoute1, ending },
  );
  check(
    "end card on after-end says everything has been seen",
    onEnding && ending.hints.endingText === ALL_SEEN_TEXT,
    ending.hints,
  );
}

// ------------------------------------------------------------------
// Session "unseen": `u` (docs/plan.md Phase 18). From Route 2's ending it
// enters the unplayed Route 1 as if picked (a forward press continues
// inside it, firing the nested decision); from the aftermath it enters
// the nested 1b with both frames open; once all is seen the card says
// so and `u` does nothing.
// ------------------------------------------------------------------
async function unseenSession({ check, open }) {
  const { page, cdp } = await open("unseen", {
    closeHelp: true,
    manualChoices: true,
  });
  await spaceTo(page, cdp, outer.after);
  await pressSpace(cdp);
  await waitChoice(page, true);
  await pressDigit(cdp, "2");
  await waitOn(page, route2.start);
  await pressSpace(cdp);
  await waitOn(page, route2.end);
  await pressU(cdp);
  const inRoute1 = await waitOn(page, route1.start);
  const r1 = await snap(page);
  await pressSpace(cdp);
  await waitOn(page, nested.after);
  await pressSpace(cdp);
  const nestFired = await waitChoice(page, true);
  const nest = await snap(page);
  check(
    "u on route2-end lands on route1-start as if picked: Space reads on and fires the nested decision",
    inRoute1 &&
      r1.choice.hidden === true &&
      r1.hints.endingShown === false &&
      nestFired &&
      choiceIs(nest.choice, nest.hints, nested, [], false),
    { r1, nest },
  );

  await pressDigit(cdp, "1"); // 1a
  await waitOn(page, nestA.start);
  await pressSpace(cdp);
  await waitOn(page, nested.continueAt);
  await pressSpace(cdp);
  await waitOn(page, outer.continueAt);
  await pressSpace(cdp);
  const atEnd = await waitOn(page, "after-end");
  await sleep(200);
  const end = await snap(page);
  await pressU(cdp);
  const inB = await waitOn(page, nestB.start);
  await pressSpace(cdp);
  const reoffer = await waitChoice(page, true);
  const re = await snap(page);
  check(
    "u on after-end lands on the nested 1b inside Route 1; its end re-offers the nested decision (1a, 1b seen, Return row)",
    atEnd &&
      end.hints.endingText === "1 route still unseen." &&
      inB &&
      reoffer &&
      choiceIs(re.choice, re.hints, nested, ["nest-a", "nest-b"], true),
    { end, re },
  );

  await pressDigit(cdp, "0");
  await waitOn(page, nested.continueAt);
  await pressSpace(cdp);
  await waitOn(page, outer.continueAt);
  await pressSpace(cdp);
  const final = (await waitOn(page, "after-end")) && (await snap(page));
  await sleep(200);
  const sig = await page.evaluate(PAINT_SIG);
  await pressU(cdp);
  await sleep(400);
  const stayed = await snap(page);
  check(
    "with everything seen the end card says so (no u line) and u does nothing",
    final !== false &&
      final.hints.endingText === ALL_SEEN_TEXT &&
      final.hints.endingKey === null &&
      stayed.id === "after-end" &&
      (await page.evaluate(PAINT_SIG)) === sig,
    { final, stayed },
  );
}

// ------------------------------------------------------------------
// Session "wheel": a notch leaves a fired choice for the screen before
// it; with no route read past it a notch forward stays there (the walk
// shows only seen screens) and Space fires it again; a pick enters the
// route (old 46); a notch leaves the route-end re-offer for the route's
// last item, the walk passes through the choice screen with the route
// highlighted both ways, the ending stops it, and Space re-offers.
// ------------------------------------------------------------------
async function wheelSession({ check, open }) {
  const { page, cdp } = await open("wheel", {
    closeHelp: true,
    manualChoices: true,
  });
  await spaceTo(page, cdp, outer.after);
  await pressSpace(cdp);
  const fired = await waitChoice(page, true);
  await wheel(cdp, true, 1);
  await sleep(80);
  const off = await snap(page);
  check(
    "a wheel notch leaves a fired choice for the screen before it (bare branch-decide)",
    fired && off.choice.hidden === true && off.id === outer.after,
    off,
  );

  await wheel(cdp, false, 1);
  await sleep(80);
  const stay = await snap(page);
  check(
    "46. with no route read, a wheel notch forward stays on bare branch-decide",
    stay.id === outer.after && stay.choice.hidden === true,
    stay,
  );
  await pressSpace(cdp);
  const arrival = (await waitChoice(page, true)) && (await snap(page));
  check(
    "46. Space fires the choice again (2 routes, unmarked, no Return row, nothing highlighted)",
    arrival !== false &&
      arrival.id === outer.after &&
      choiceIs(arrival.choice, arrival.hints, outer, [], false) &&
      screenLabel(arrival) === `${outer.after}+choice>`,
    arrival,
  );
  await pressDigit(cdp, "2");
  const entered =
    (await waitChoice(page, false)) && (await waitOn(page, route2.start));
  check(
    "46. a pick enters the route (route2-start)",
    entered,
    await snap(page),
  );

  await pressSpace(cdp);
  await waitOn(page, route2.end);
  await pressSpace(cdp);
  const reoffer = await waitChoice(page, true);
  const reSnap = await snap(page);
  await wheel(cdp, true, 1);
  await sleep(80);
  const reOff = await snap(page);
  check(
    "a wheel notch leaves the route-end re-offer for the route's last item (route2-end)",
    reoffer &&
      choiceIs(reSnap.choice, reSnap.hints, outer, ["route2"], false) &&
      reOff.choice.hidden === true &&
      reOff.id === route2.end,
    { reSnap, reOff },
  );
  // Through the choice screen and back: never halting, Route 2 lit both
  // ways; forward, the ending's last item stops the walk.
  const through = [];
  for (const back of [true, true, true, false, false, false, false]) {
    await wheel(cdp, back, 1);
    await sleep(80);
    through.push(screenLabel(await snap(page)));
  }
  check(
    "the wheel passes through the choice screen both ways with Route 2 highlighted; route2-end, an ending, stops it",
    through.join() ===
      [
        route2.start,
        `${outer.after}+choice>2`,
        outer.after,
        `${outer.after}+choice>2`,
        route2.start,
        route2.end,
        route2.end,
      ].join(),
    { through },
  );
  await pressSpace(cdp);
  const reoffered = await waitChoice(page, true);
  const reAgain = await snap(page);
  check(
    "Space from route2-end re-offers, exactly as before",
    reoffered &&
      reAgain.id === route2.end &&
      choiceIs(reAgain.choice, reAgain.hints, outer, ["route2"], false),
    reAgain,
  );
}

// ------------------------------------------------------------------
// Session "skip": old step 46's tab-skip half under the Phase 18 skip
// rule — a burst through seen content stops ON the last seen item (here
// the unanswered decision's own item) without revealing a route; the
// next press fires the decision, and the pick resumes MANUAL reading.
// ------------------------------------------------------------------
async function skipSession({ check, open }) {
  const { page, cdp } = await open("skip", {
    closeHelp: true,
    manualChoices: true,
  });
  await spaceTo(page, cdp, "branch-decide");
  await wheel(cdp, true, 3); // back into seen content before the lead-in
  await sleep(80);
  const from = await currentItemId(page);
  await pressTab(cdp);
  await sleep(1500); // the burst runs and stops
  const stopped = await currentItemId(page);
  const choiceDuringSkip = await page.evaluate(CHOICE_OPEN);
  await pressSpace(cdp);
  let fired = false;
  try {
    await page.waitForFunction(CHOICE_OPEN, { timeout: 2000 });
    fired = true;
  } catch {}
  await pressDigit(cdp, "2");
  await sleep(150);
  const picked = await currentItemId(page);
  await sleep(1200); // manual: nothing moves on its own after the pick
  const still = await currentItemId(page);
  check(
    "a tab-skip burst stops ON the unanswered decision's item (no route revealed); Space fires it; the pick resumes manual",
    stopped === "branch-decide" &&
      !choiceDuringSkip &&
      fired &&
      picked === "route2-start" &&
      still === "route2-start",
    { from, stopped, choiceDuringSkip, fired, picked, still },
  );
}

// ---- Rolling back restores the routes (docs/plan.md Phase 22), manual ----
// One route read (Route 2), then the wheel back to before the decision:
// reading on fires the choice again with Route 2 still marked seen, and
// the unseen Route 1 can be picked.
async function rewindManualSession({ check, open }) {
  const { page, cdp } = await open("rewind-manual", {
    closeHelp: true,
    manualChoices: true,
  });
  await spaceTo(page, cdp, "branch-decide");
  await pressSpace(cdp); // fires the outer decision
  await page.waitForFunction(CHOICE_OPEN, { timeout: 2000 });
  await pressDigit(cdp, "2"); // Route 2
  await spaceTo(page, cdp, "route2-end");
  await pressSpace(cdp); // off its end: the re-offer
  await page.waitForFunction(CHOICE_OPEN, { timeout: 2000 });
  let back = null;
  for (let notch = 0; notch < 10; notch += 1) {
    await wheel(cdp, true, 1);
    back = await currentItemId(page);
    if (back === "branch-lead") break;
  }
  await spaceTo(page, cdp, "branch-decide");
  await pressSpace(cdp); // the decision fires again
  let fired = true;
  try {
    await page.waitForFunction(CHOICE_OPEN, { timeout: 2000 });
  } catch {
    fired = false;
  }
  const choice = await page.evaluate(READ_CHOICE);
  const marks = (choice.rows ?? [])
    .filter((row) => !row.isContinue)
    .map((row) => row.seen !== null);
  await pressDigit(cdp, "1"); // the unseen route
  await sleep(200);
  const picked = await currentItemId(page);
  check(
    "manual rewind before the decision: it fires again, Route 2 still marked seen, Route 1 unseen and pickable",
    back === "branch-lead" &&
      fired &&
      marks.length === 2 &&
      marks[0] === false &&
      marks[1] === true &&
      picked === "route1-start",
    { back, fired, marks, picked },
  );
}

// ---- Tab and `a` on a choice screen (docs/plan.md Phase 43), manual ----
// Each key shows its pill over the open choice and moves nothing; the pick
// is the answer. Skip set on a choice runs after the pick through a route
// already read, and turns off with its pill when the route is unseen;
// auto-forward set there runs the route after the pick.
async function choiceModesSession({ check, open }) {
  const { page, cdp } = await open("choice-modes", {
    closeHelp: true,
    manualChoices: true,
  });
  const PILL_OVER_CHOICE = (text) =>
    document.getElementById("flash")?.textContent === text &&
    document.getElementById("choice")?.hidden === false;
  const pillOverChoice = async (text) => {
    try {
      await page.waitForFunction(PILL_OVER_CHOICE, { timeout: 2000 }, text);
      return true;
    } catch {
      return false;
    }
  };
  const modePills = async () =>
    (await readPills(page)).filter(
      (t) => t.startsWith("Skip ") || t.startsWith("Auto-forward "),
    );

  // First fire, nothing read past it: Tab arms skip, route 2 is unseen.
  await spaceTo(page, cdp, "branch-decide");
  await pressSpace(cdp);
  const fired = await waitChoice(page, true);
  await page.evaluate(INSTALL_PILL_LOG);
  await pressTab(cdp);
  const onShown = await pillOverChoice("Skip on");
  await sleep(600);
  const stayed =
    (await page.evaluate(CHOICE_OPEN)) &&
    (await currentItemId(page)) === "branch-decide";
  await pressDigit(cdp, "2");
  const picked = await waitOn(page, "route2-start");
  await sleep(800); // manual and no burst: the route waits
  const waited = (await currentItemId(page)) === "route2-start";
  const unseenPills = await modePills();
  check(
    'Tab on a choice shows "Skip on" over it and moves nothing; picking an unseen route shows "Skip off" and the route waits',
    fired &&
      onShown &&
      stayed &&
      picked &&
      waited &&
      unseenPills.join("|") === "Skip on|Skip off",
    { fired, onShown, stayed, picked, waited, pills: unseenPills },
  );

  // The re-offer after route 2: Tab, then route 2 again, read this time.
  await pressSpace(cdp); // route2-end
  await waitOn(page, "route2-end");
  await pressSpace(cdp); // off the ending: the decision re-offers
  const reoffered = await waitChoice(page, true);
  await page.evaluate(INSTALL_PILL_LOG);
  await page.evaluate(INSTALL_BRANCH_LOG);
  await pressTab(cdp);
  const armedShown = await pillOverChoice("Skip on");
  await sleep(500);
  const stillOpen = await page.evaluate(CHOICE_OPEN);
  await pressDigit(cdp, "2");
  const ran = await waitOn(page, "route2-end", 1500); // no key pressed
  await sleep(300);
  const log = await readBranchLog(page);
  const startShown = logHas(log, item("route2-start").file);
  const seenPills = await modePills();
  check(
    'Tab on a re-offer, then the route already read: skip runs it to its last seen item, "Skip on" then "Skip off"',
    reoffered &&
      armedShown &&
      stillOpen &&
      ran &&
      startShown &&
      seenPills.join("|") === "Skip on|Skip off",
    { reoffered, armedShown, stillOpen, ran, startShown, pills: seenPills },
  );

  // `a` on the next re-offer: its pill, nothing moves, then the route
  // auto-forwards after the pick.
  await pressSpace(cdp); // off route2-end again
  const again = await waitChoice(page, true);
  await page.evaluate(INSTALL_PILL_LOG);
  await pressA(cdp);
  const autoShown = await pillOverChoice("Auto-forward on");
  await sleep(1800); // past any item's minimum hold: the choice waits
  const autoStayed =
    (await page.evaluate(CHOICE_OPEN)) &&
    (await currentItemId(page)) === "route2-end";
  await pressDigit(cdp, "2");
  const autoPicked = await waitOn(page, "route2-start");
  const hold = Math.max(1500, [...item("route2-start").text].length * 60);
  const autoRan = await waitOn(page, "route2-end", hold + 2500);
  const autoPills = await modePills();
  check(
    'a on a choice shows "Auto-forward on" over it and moves nothing; after the pick the route auto-forwards',
    again &&
      autoShown &&
      autoStayed &&
      autoPicked &&
      autoRan &&
      autoPills.join("|") === "Auto-forward on",
    { again, autoShown, autoStayed, autoPicked, autoRan, pills: autoPills },
  );
}
