// Menus pause the timeline (docs/plan.md Phase 18): opening the Esc
// screen (keys and settings, Phase 26) or the branch map (`m`, which holds
// the bookmarks since Phase 35) freezes a running auto-forward hold or
// skip burst and holds a playing video in place; closing the screen
// resumes exactly what was running (a fresh auto hold, or the burst
// carrying on). A bookmark card click on the map that jumps away does not
// resume the old burst. A panel's pause is no stop: skip shows no pill for
// it (docs/plan.md Phase 43). Over a choice, the panels keep `a` and Tab:
// pressed over the Esc screen or the map they do nothing, as before. Each
// part starts a fresh browser.

import {
  CHOICE_OPEN,
  clickCenter,
  closeSettings,
  currentItemId,
  INSTALL_PILL_LOG,
  item,
  MAP_CLOSED,
  MAP_OPEN,
  MAP_READY,
  ON_TEXT,
  openSettings,
  pressA,
  pressB,
  pressDigit,
  pressM,
  pressSpace,
  pressTab,
  READ_MAP_CARDS,
  readPills,
  sleep,
  spaceTo,
  waitVideoPlaying,
  wheel,
} from "./harness.mjs";

export const title = "menus pause auto-forward, skip and video";

const MS_PER_CHAR = 60; // DEFAULT_SETTINGS reading speed 1.00x
const MIN_HOLD_MS = 1500; // DEFAULT_SETTINGS minHoldMs
const textHold = (it) =>
  Math.max(MIN_HOLD_MS, [...(it.text ?? "")].length * MS_PER_CHAR);

async function wheelBackTo(page, cdp, id, max = 40) {
  for (let i = 0; i < max; i += 1) {
    if ((await currentItemId(page)) === id) return true;
    await wheel(cdp, true, 1);
  }
  return (await currentItemId(page)) === id;
}

async function autoForward({ check, open }) {
  const { page, cdp } = await open("auto", { closeHelp: true });
  await pressSpace(cdp); // text-speech
  const here = item("text-speech");
  const next = item("text-thought");
  const holdMs = textHold(here);
  const on = (await currentItemId(page)) === here.id;
  await pressA(cdp); // auto on: the hold is armed from now
  await sleep(500);
  await openSettings(page, cdp);
  await sleep(holdMs + 800); // the hold would have fired behind the screen
  const heldBehind = (await currentItemId(page)) === here.id;
  await closeSettings(page, cdp); // close: a FRESH hold starts now
  const closedAt = Date.now();
  let advancedAt = -1;
  try {
    await page.waitForFunction(ON_TEXT, { timeout: holdMs + 3000 }, next.text);
    advancedAt = Date.now();
  } catch {}
  const afterClose = advancedAt < 0 ? -1 : advancedAt - closedAt;
  check(
    "the Esc screen pauses auto-forward; closing it re-arms a fresh hold, then auto goes on",
    on &&
      heldBehind &&
      afterClose >= holdMs * 0.8 &&
      afterClose <= holdMs + 1500,
    { on, heldBehind, holdMs, afterCloseMs: afterClose },
  );
}

async function skipBurst({ check, open }) {
  const { page, cdp } = await open("skip", { closeHelp: true });
  // A long seen run, so a ~25 ms-per-picture burst is still running when
  // the map opens.
  const reached = await spaceTo(page, cdp, "floor-3");
  const back = await wheelBackTo(page, cdp, "intro-title");
  await page.evaluate(INSTALL_PILL_LOG);
  await pressTab(cdp);
  await sleep(60);
  await pressM(cdp);
  await page.waitForFunction(MAP_OPEN, { timeout: 2000 });
  const frozenAt = await currentItemId(page);
  await sleep(800);
  const stillAt = await currentItemId(page);
  const frozen =
    frozenAt === stillAt &&
    frozenAt !== "floor-3" &&
    item(frozenAt).index > item("intro-title").index;
  await pressM(cdp); // close: the burst carries on to the last seen item
  await page.waitForFunction(MAP_CLOSED, { timeout: 2000 });
  let resumed = false;
  try {
    await page.waitForFunction(
      ON_TEXT,
      { timeout: 3000 },
      item("floor-3").text,
    );
    resumed = true;
  } catch {}
  const captionShown = await page.evaluate(
    () => document.getElementById("overlay")?.hidden === false,
  );
  check(
    "the branch map pauses a skip burst mid-run; closing it lets the burst finish on the last seen item",
    reached && back && frozen && resumed && captionShown,
    { reached, back, frozenAt, stillAt, resumed, captionShown },
  );
  await sleep(200);
  const pills = (await readPills(page)).filter((t) => t.startsWith("Skip "));
  check(
    'the map\'s pause is no stop: the burst shows "Skip on" and, when it ends, "Skip off" only',
    resumed && pills.join("|") === "Skip on|Skip off",
    pills,
  );
}

async function videoHold({ check, open }) {
  const { page, cdp } = await open("video", { closeHelp: true });
  const reached = await spaceTo(page, cdp, "video-chain");
  let playing = true;
  try {
    await waitVideoPlaying(page);
  } catch {
    playing = false;
  }
  const readVideo = () =>
    page.evaluate(() => {
      const v = document.getElementById("visual-video");
      return v === null ? null : { paused: v.paused, t: v.currentTime };
    });
  await openSettings(page, cdp);
  await sleep(150);
  const a = await readVideo();
  await sleep(600);
  const b = await readVideo();
  await closeSettings(page, cdp);
  await sleep(500);
  const c = await readVideo();
  check(
    "the Esc screen holds a playing video in place; closing it plays on",
    reached &&
      playing &&
      a?.paused === true &&
      b?.paused === true &&
      a.t === b.t &&
      c?.paused === false &&
      c.t > b.t,
    { reached, playing, open1: a, open2: b, closed: c },
  );
}

async function bookmarkJump({ check, open }) {
  const { page, cdp } = await open("jump", { closeHelp: true });
  await pressSpace(cdp); // text-speech
  const target = item("text-speech");
  await pressB(cdp);
  await sleep(400); // the bookmark commits
  const reached = await spaceTo(page, cdp, "floor-3");
  const back = await wheelBackTo(page, cdp, "intro-title");
  await pressTab(cdp);
  await sleep(60);
  await pressM(cdp);
  await page.waitForFunction(MAP_READY, { timeout: 2000 });
  const { cards = [] } = await page.evaluate(READ_MAP_CARDS);
  const rect = cards.find((c) => c.itemId === target.id)?.rect ?? null;
  if (rect !== null) await clickCenter(cdp, rect);
  await sleep(150);
  const landed = await currentItemId(page);
  await sleep(1000); // manual mode: nothing moves, no burst resumed
  const stayed = await currentItemId(page);
  const captionShown = await page.evaluate(
    () => document.getElementById("overlay")?.hidden === false,
  );
  check(
    "a bookmark card click on the map during a paused burst jumps there and the burst does not resume",
    reached &&
      back &&
      rect !== null &&
      landed === target.id &&
      stayed === target.id &&
      captionShown,
    { reached, back, card: rect !== null, landed, stayed, captionShown },
  );
}

// Over a choice, the Esc screen and the map keep `a` and Tab (docs/plan.md
// Phase 43 changes them on the choice screen itself, not over a panel):
// pressed there they show no pill and set no mode, so the route picked
// after waits in manual.
async function choicePanelKeys({ check, open }) {
  const { page, cdp } = await open("choice-panels", {
    closeHelp: true,
    manualChoices: true,
  });
  const reached = await spaceTo(page, cdp, "branch-decide");
  await pressSpace(cdp); // the outer decision
  await page.waitForFunction(CHOICE_OPEN, { timeout: 2000 });
  await page.evaluate(INSTALL_PILL_LOG);
  await openSettings(page, cdp);
  await pressA(cdp);
  await pressTab(cdp);
  await closeSettings(page, cdp);
  await pressM(cdp);
  await page.waitForFunction(MAP_OPEN, { timeout: 2000 });
  await pressA(cdp);
  await pressTab(cdp);
  await pressM(cdp);
  await page.waitForFunction(MAP_CLOSED, { timeout: 2000 });
  const choiceStill = await page.evaluate(CHOICE_OPEN);
  await sleep(300);
  const pillsBehind = await readPills(page);
  await pressDigit(cdp, "2");
  await sleep(150);
  const picked = await currentItemId(page);
  await sleep(textHold(item("route2-start")) + 1000);
  const waited = await currentItemId(page);
  check(
    "over a choice, a and Tab pressed on the Esc screen or the map do nothing: no pill, and the route picked after waits",
    reached &&
      choiceStill &&
      pillsBehind.length === 0 &&
      picked === "route2-start" &&
      waited === "route2-start",
    { reached, choiceStill, pills: pillsBehind, picked, waited },
  );
}

// Independent parts (each opens its own browser); the runner runs them
// side by side and prints their checks in this order.
export const parts = [
  autoForward,
  skipBurst,
  videoHold,
  bookmarkJump,
  choicePanelKeys,
];
