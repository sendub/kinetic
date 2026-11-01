// Decisions and routes (old driver steps 34-39 and 46, rewritten for the
// Phase 18 rules and the history rollback spec): the outer decision firing
// on the forward press from branch-decide, the ending route and its
// re-offer, the nested decision inside the continuing route, the continuing
// route's end running straight into the aftermath, reload inside branch
// content, `e` going to the end of the history, the wheel replaying choice
// screens (a pick from one is real), the scroll back from the end showing
// every screen in the order it was seen, and the ending hint.
// The "Return to main route" row (and its Enter hint) is drawn only once
// that decision's CONTINUING route has been completed at least once.

import { CHOICE_HINT, CONTINUE_HINT } from "../../src/render/choice.ts";
import {
  branch,
  CHOICE_OPEN,
  CONTINUE_LABEL,
  currentItemId,
  INSTALL_BRANCH_LOG,
  item,
  PAGE_STATE,
  PAINT_SIG,
  pressDigit,
  pressE,
  pressEnter,
  pressSpace,
  pressTab,
  READ_CHOICE,
  readBranchLog,
  sleep,
  spaceTo,
  wheel,
} from "./harness.mjs";

export const title =
  "decisions, routes, return rows, e, wheel and the ending hint";

const outer = branch("outer");
const nested = branch("nested");
const routeOf = (b, id) => b.routes.find((r) => r.id === id);
const route1 = routeOf(outer, "route1");
const route2 = routeOf(outer, "route2");
const nestA = routeOf(nested, "nest-a");
const nestB = routeOf(nested, "nest-b");

// The choice panel's hint line and the standing ending hint, as drawn.
const READ_HINTS = () => {
  const hint = document.getElementById("ending-hint");
  return {
    choiceHint: document.querySelector(".choice-hint")?.textContent ?? null,
    endingShown: hint !== null && !hint.hidden,
    endingText: hint?.textContent ?? null,
  };
};

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
 * row (with the Enter hint) iff `withReturn`.
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
      hints.choiceHint === CHOICE_HINT + CONTINUE_HINT
    : ret.length === 0 && hints.choiceHint === CHOICE_HINT;
  return routesOk && returnOk;
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

export default async function ({ check, open }) {
  // ------------------------------------------------------------------
  // Session "walk": first fire, Route 2 (ending) first, then Route 1 with
  // 1b before 1a, the continuing end into the aftermath, then the scroll
  // back from the end with everything seen.
  // ------------------------------------------------------------------
  {
    const { page, cdp } = await open("walk", { closeHelp: true });

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
      "34. a first fire draws no Return row and no Enter hint",
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
      "ending hint shows on route2-end while content is still unseen",
      end2.id === route2.end &&
        end2.hints.endingShown === true &&
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

    // The nested decision's continuing route is now complete: rolling back
    // to its first screen on route1-nest replays it with the Return row (the
    // rule as it stands now), and Enter answers it onto route1-end.
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
      "36. after 1a completes, rolling back to route1-nest's choice screen shows both marks AND the Return row + Enter hint",
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
    const enterBack =
      (await waitChoice(page, false)) &&
      (await waitOn(page, nested.continueAt));
    check(
      "Enter on the Return row answers the nested decision onto route1-end",
      enterBack,
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
        log37.filter((l) => l.includes(item(outer.continueAt).file)).length ===
          1,
      { after, log37 },
    );

    // Everything has been seen now: no hint on the final ending.
    await pressSpace(cdp);
    const onEnd = await waitOn(page, "after-end");
    await sleep(200);
    const end = await snap(page);
    check(
      "ending hint is absent on after-end once every item has been seen",
      onEnd && end.hints.endingShown === false,
      end,
    );

    // Scroll back from the end: exactly the screens seen going forward,
    // newest first. Enter on the replayed nested screen forked the record
    // there, so the nested 1b/1a detour is gone; every choice screen shows
    // the current marks and the Return row (each continuing route is done).
    const back = [];
    const views = {};
    for (let i = 0; i < 16; i += 1) {
      await wheel(cdp, true, 1);
      await sleep(80);
      const s = await snap(page);
      const label = `${s.id}${s.choice.hidden === false ? "+choice" : ""}`;
      back.push(label);
      if (s.choice.hidden === false && views[label] === undefined)
        views[label] = s;
      if (label === outer.after) break;
    }
    const expectBack = [
      outer.continueAt,
      nested.continueAt,
      `${nested.after}+choice`,
      nested.after,
      route1.start,
      `${route2.end}+choice`,
      route2.end,
      route2.start,
      `${outer.after}+choice`,
      outer.after,
    ];
    const viewIs = (label, b, seenIds) =>
      views[label] !== undefined &&
      choiceIs(views[label].choice, views[label].hints, b, seenIds, true);
    check(
      "scrolling back from after-end replays every screen in reading order, choice screens with both marks and the Return row",
      back.join() === expectBack.join() &&
        viewIs(`${nested.after}+choice`, nested, ["nest-a", "nest-b"]) &&
        viewIs(`${route2.end}+choice`, outer, ["route1", "route2"]) &&
        viewIs(`${outer.after}+choice`, outer, ["route1", "route2"]),
      { back, views },
    );
  }

  // ------------------------------------------------------------------
  // Session "resume": Route 2, then Route 1 via 1a only — 1b is the one
  // unseen span. Ending hint at after-end, the wheel stepping over the
  // unplayed span, e resuming, reload inside branch content, and `e`.
  // ------------------------------------------------------------------
  {
    const { page, cdp } = await open("resume", { closeHelp: true });
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
      "ending hint shows on after-end while 1b is still unseen",
      atEnd && end.hints.endingShown === true,
      end,
    );

    // The required rollback check (docs/plan.md, History rollback spec):
    // after Route 2 then Route 1, the scroll back from the aftermath shows
    // Route 1's items (its nested choice screen included), then the
    // re-offered choice screen, then Route 2's items, then the first choice
    // screen, then the decision picture — and never the unplayed 1b.
    const back = [];
    const views = {};
    for (let i = 0; i < 14; i += 1) {
      await wheel(cdp, true, 1);
      await sleep(80);
      const s = await snap(page);
      const label = `${s.id}${s.choice.hidden === false ? "+choice" : ""}`;
      back.push(label);
      if (s.choice.hidden === false && views[label] === undefined)
        views[label] = s;
      if (label === outer.after) break;
    }
    const expectBack = [
      outer.continueAt,
      nested.continueAt,
      nestA.start,
      `${nested.after}+choice`,
      nested.after,
      route1.start,
      `${route2.end}+choice`,
      route2.end,
      route2.start,
      `${outer.after}+choice`,
      outer.after,
    ];
    const viewOf = (label) => views[label] ?? { choice: {}, hints: {} };
    const nestView = viewOf(`${nested.after}+choice`);
    const reView = viewOf(`${route2.end}+choice`);
    const firstView = viewOf(`${outer.after}+choice`);
    check(
      "after Route 2 then Route 1, scrolling back from the aftermath shows Route 1's items, the re-offered choice screen, Route 2's items, the first choice screen, then the decision picture",
      back.join() === expectBack.join() &&
        !back.some((e) => e.startsWith(nestB.start)),
      { back, expectBack },
    );
    check(
      "the replayed choice screens carry the current marks and Return rows (nested: 1a seen; outer: both seen)",
      choiceIs(nestView.choice, nestView.hints, nested, ["nest-a"], true) &&
        choiceIs(
          reView.choice,
          reView.hints,
          outer,
          ["route1", "route2"],
          true,
        ) &&
        choiceIs(
          firstView.choice,
          firstView.hints,
          outer,
          ["route1", "route2"],
          true,
        ),
      { nestView, reView, firstView },
    );

    // Forward again from the decision picture: the same screens in order.
    const fwd = [];
    for (let i = 0; i < expectBack.length - 1; i += 1) {
      await wheel(cdp, false, 1);
      await sleep(80);
      const s = await snap(page);
      fwd.push(`${s.id}${s.choice.hidden === false ? "+choice" : ""}`);
    }
    check(
      "the wheel forward replays the same screens back to the aftermath",
      fwd.join() === expectBack.slice(0, -1).reverse().join(),
      { fwd },
    );

    // Roll back again, then `e` returns to the end of the history.
    await wheel(cdp, true, 3);
    await sleep(80);
    await pressE(cdp);
    const resumed =
      (await waitOn(page, "after-end")) && (await waitChoice(page, false));
    check(
      "e from a rolled-back point returns to the end of the history (after-end)",
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
      "ending hint is restored with the reload while 1b is still unseen",
      rSnap.hints.endingShown === true,
      rSnap.hints,
    );

    // The history came back with the reload: the wheel still rolls back
    // through it, and `e` returns to its end.
    await wheel(cdp, true, 2);
    await sleep(120);
    const rolled = await currentItemId(page);
    await pressE(cdp);
    const reEnd = await waitOn(page, "after-end");
    check(
      "after the reload the wheel rolls back through the saved history (route1-end) and e returns to after-end",
      rolled === nested.continueAt && reEnd,
      { rolled, reEnd },
    );

    // 39. `e` at the end of the history stays put: it no longer jumps to the
    // never-taken 1b, and the hint keeps saying content is unseen.
    const endSig = await page.evaluate(PAINT_SIG);
    await pressE(cdp);
    await sleep(400);
    const endSigHeld = await page.evaluate(PAINT_SIG);
    const stayed = await snap(page);
    check(
      "39. e at the end of the history stays put (no jump to the unseen 1b), the hint still showing",
      stayed.id === "after-end" &&
        endSig === endSigHeld &&
        stayed.hints.endingShown === true &&
        stayed.hints.endingText === "Some content is still unseen.",
      { stayed, endSig, endSigHeld },
    );

    // Reach 1b the reader's way: roll back to the nested choice screen and
    // pick it (a real pick: the record forks), return, and read to the end.
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
    await pressEnter(cdp); // the Return row: 1a completed long ago
    const backOnRoute1 =
      (await waitChoice(page, false)) &&
      (await waitOn(page, nested.continueAt));
    await pressSpace(cdp);
    await waitOn(page, outer.continueAt);
    await pressSpace(cdp);
    const onEnding = await waitOn(page, "after-end");
    await sleep(200);
    const ending = await snap(page);
    check(
      "39. a pick of 1b from the replayed nested screen plays it; Return and Space read on to after-end",
      nestScreen && onB && bReoffer && backOnRoute1 && onEnding,
      { nestScreen, onB, bReoffer, backOnRoute1, ending },
    );
    check(
      "ending hint is gone on after-end once everything has been seen",
      onEnding && ending.hints.endingShown === false,
      ending.hints,
    );
  }

  // ------------------------------------------------------------------
  // Session "wheel": a notch leaves a fired choice for the screen before
  // it; a notch forward replays the choice screen and a pick from it enters
  // the route (old 46); a notch leaves the route-end re-offer for the
  // route's last item, and Space from there replays the re-offer.
  // ------------------------------------------------------------------
  {
    const { page, cdp } = await open("wheel", { closeHelp: true });
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
    const arrival = await snap(page);
    check(
      "46. a wheel notch forward replays the choice screen on branch-decide (2 routes, unmarked, no Return row)",
      arrival.id === outer.after &&
        choiceIs(arrival.choice, arrival.hints, outer, [], false),
      arrival,
    );
    await pressDigit(cdp, "2");
    const entered =
      (await waitChoice(page, false)) && (await waitOn(page, route2.start));
    check(
      "46. a pick from the replayed screen enters the route (route2-start)",
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
    await pressSpace(cdp);
    const replayed = await waitChoice(page, true);
    const reAgain = await snap(page);
    check(
      "Space from route2-end replays the re-offer, exactly as before",
      replayed &&
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
  {
    const { page, cdp } = await open("skip", { closeHelp: true });
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
}
