// Menus pause the timeline (docs/plan.md Phase 18): opening the Esc
// screen (keys and settings, Phase 26) or `t`
// freezes a running auto-forward hold or skip burst and holds a playing
// video in place; closing the screen resumes exactly what was running (a
// fresh auto hold, or the burst carrying on). A bookmark click that jumps
// away does not resume the old burst. Each part starts a fresh browser.

import {
  clickCenter,
  closeSettings,
  currentItemId,
  item,
  ON_TEXT,
  OVERLAY_OPEN,
  openSettings,
  pressA,
  pressB,
  pressSpace,
  pressT,
  pressTab,
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
  // `t` opens.
  const reached = await spaceTo(page, cdp, "floor-3");
  const back = await wheelBackTo(page, cdp, "intro-title");
  await pressTab(cdp);
  await sleep(60);
  await pressT(cdp);
  await page.waitForFunction(OVERLAY_OPEN, { timeout: 2000 });
  const frozenAt = await currentItemId(page);
  await sleep(800);
  const stillAt = await currentItemId(page);
  const frozen =
    frozenAt === stillAt &&
    frozenAt !== "floor-3" &&
    item(frozenAt).index > item("intro-title").index;
  await pressT(cdp); // close: the burst carries on to the last seen item
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
    "t pauses a skip burst mid-run; closing it lets the burst finish on the last seen item",
    reached && back && frozen && resumed && captionShown,
    { reached, back, frozenAt, stillAt, resumed, captionShown },
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
  await pressT(cdp);
  await page.waitForFunction(OVERLAY_OPEN, { timeout: 2000 });
  const rect = await page.evaluate((id) => {
    const entry = document.querySelector(
      `.bookmark-entry[data-item-id="${id}"] .bookmark-meta`,
    );
    if (entry === null) return null;
    const r = entry.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  }, target.id);
  if (rect !== null) await clickCenter(cdp, rect);
  await sleep(150);
  const landed = await currentItemId(page);
  await sleep(1000); // manual mode: nothing moves, no burst resumed
  const stayed = await currentItemId(page);
  const captionShown = await page.evaluate(
    () => document.getElementById("overlay")?.hidden === false,
  );
  check(
    "a bookmark click during a paused burst jumps there and the burst does not resume",
    reached &&
      back &&
      rect !== null &&
      landed === target.id &&
      stayed === target.id &&
      captionShown,
    { reached, back, entry: rect !== null, landed, stayed, captionShown },
  );
}

export default async function (ctx) {
  await autoForward(ctx);
  await skipBurst(ctx);
  await videoHold(ctx);
  await bookmarkJump(ctx);
}
