// The screens over the stage (old driver steps 20, 22-28, 31, 42, 47): the
// mid-flow key help, bookmarks (`b`, the `t` list, restore from a row),
// reload resume, the `c` config screen and its settings' persistence, the
// empty-manifest folder, and "Reset progress". Each part opens its own
// fresh profile, so no part leans on another's storage.

import { DEFAULT_SETTINGS } from "../../src/machine/types.ts";
import { speedLabel } from "../../src/render/config.ts";
import {
  CONFIG_OPEN,
  CONFIRM_OPEN,
  clickAt,
  clickCenter,
  configOpen,
  currentItemId,
  emptyDir,
  HELP_CLOSED,
  HELP_OPEN,
  helpOpen,
  item,
  OVERLAY_CLOSED,
  OVERLAY_OPEN,
  PAGE_STATE,
  PAINT_SIG,
  panelOpen,
  pressA,
  pressB,
  pressC,
  pressE,
  pressEnter,
  pressEscape,
  pressSpace,
  pressT,
  pressTab,
  READ_BOOKMARK_OVERLAY,
  READ_BOOKMARKS,
  READ_CONFIG_OVERLAY,
  READ_CONFIRM_OVERLAY,
  READ_HELP,
  readSignature,
  SIGNATURE,
  sampleSignatures,
  sleep,
  spaceTo,
  transitions,
  WHEEL_GAP_MS,
  wheel,
  wheelNotch,
} from "./harness.mjs";

export const title = "help, bookmarks, resume, config, empty folder, reset";

// Player UI strings. render/help.ts and render/bookmarks.ts import modules
// by extensionless paths node cannot resolve, so these two are restated;
// the speed readout comes from config.ts itself.
const HELP_TITLE = "Key help";
const EMPTY_MESSAGE = "No bookmarks yet — press b";
const EMPTY_NOTICE = "No content yet — this folder has an empty manifest.";
const MS_PER_CHAR = DEFAULT_SETTINGS.msPerChar;
const MIN_HOLD = DEFAULT_SETTINGS.minHoldMs;
const SPEED_1X = speedLabel(1, MS_PER_CHAR);
const SPEED_2X = speedLabel(2, MS_PER_CHAR);
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const FLASH_SHOWN = () =>
  (document.getElementById("flash")?.textContent ?? "") === "Bookmarked";

const holdMs = (id, speed = 1) =>
  Math.max(MIN_HOLD, (item(id).text.length * MS_PER_CHAR) / speed);

const waitFor = async (page, fn, timeout = 5000, arg = undefined) => {
  try {
    await page.waitForFunction(fn, { timeout }, arg);
    return true;
  } catch {
    return false;
  }
};

const waitForItem = (page, id, timeout) =>
  waitFor(
    page,
    (t) => document.getElementById("overlay-text")?.textContent === t,
    timeout,
    item(id).text,
  );

const rowCenterClick = (cdp, row) => clickCenter(cdp, row.rect);

/**
 * The first gesture requests fullscreen. When the browser granted it, Chrome
 * keeps the first Escape for leaving fullscreen and the page never sees it.
 * Returns what one Escape did, so callers can assert the windowed state that
 * follows; `wasFullscreen: false` means headless never entered it.
 */
async function leaveFullscreen(page, cdp) {
  const before = await page.evaluate(PAGE_STATE);
  if (before.fullscreenElement === null) {
    return { wasFullscreen: false, ok: true, before };
  }
  await pressEscape(cdp);
  await sleep(150);
  const after = await page.evaluate(PAGE_STATE);
  return {
    wasFullscreen: true,
    ok: after.fullscreenElement === null && after.helpOpen === false,
    before,
    after,
  };
}

// Old step 20: Escape opens the key help mid-flow.
async function helpMidFlow({ check, open }) {
  const { page, cdp } = await open("help", { closeHelp: true });
  const fs = await leaveFullscreen(page, cdp);
  check(
    "the first Escape while fullscreen is the browser's: it leaves fullscreen and opens nothing",
    fs.ok ? (fs.wasFullscreen ? true : "PARTIAL") : false,
    fs,
  );

  // Auto-forward on, so an unpaused machine WOULD advance behind the help.
  await spaceTo(page, cdp, "text-speech");
  const hold = holdMs("text-speech");
  await pressA(cdp);
  await sleep(hold - 1400); // most of the hold spent; ~1.4 s left
  await pressEscape(cdp);
  const opened = await waitFor(page, HELP_OPEN, 2000);
  const s = await page.evaluate(PAGE_STATE);
  const help = await page.evaluate(READ_HELP);
  const imgBox = await page.evaluate(
    () =>
      document.getElementById("visual-image")?.getBoundingClientRect().width ??
      -1,
  );
  check(
    "windowed Escape opens the help mid-flow: a black screen over the same item",
    opened &&
      s.stageHidden === true &&
      imgBox === 0 &&
      s.text === item("text-speech").text &&
      help.title === HELP_TITLE &&
      help.coversViewport === true,
    { s, imgBox, title: help.title, covers: help.coversViewport },
  );

  await pressC(cdp);
  await pressT(cdp);
  const blocked = {
    help: await helpOpen(page),
    config: await configOpen(page),
    list: await panelOpen(page),
  };
  check(
    "c and t open nothing behind the help: one screen at a time",
    blocked.help === true && blocked.config === false && blocked.list === false,
    blocked,
  );

  // The armed hold had ~1.4 s left; 3.2 s behind the help must show no move.
  const samples = transitions(await sampleSignatures(page, 3200, 120));
  check(
    "behind the help the machine is paused: no item moves with auto-forward on",
    samples.length === 1 && samples[0][1].includes(item("text-speech").text),
    samples.map(([, sig]) => sig),
  );

  await clickAt(cdp, 400, 40); // a click anywhere closes
  const closedAt = Date.now();
  const closed = await page.evaluate(PAGE_STATE);
  const advanced = await waitForItem(page, "text-thought", hold + 1500);
  const advancedMs = Date.now() - closedAt;
  check(
    "a click closes the help on the same item, and its hold re-arms fresh from the close",
    closed.helpOpen === false &&
      closed.stageHidden === false &&
      closed.text === item("text-speech").text &&
      advanced &&
      advancedMs > hold - 500,
    { closed: closed.helpOpen, advanced, advancedMs, fullHold: hold },
  );
}

// Old steps 22-25: bookmarks and the `t` list.
async function bookmarks({ check, open }) {
  const { page, cdp } = await open("bookmarks", { closeHelp: true });
  const fs = await leaveFullscreen(page, cdp);

  // Seen 0..11, then bookmark item 8 and item 11 (three notches apart).
  const walked = await spaceTo(page, cdp, "chain-still-3");
  await wheel(cdp, true, 3);
  const atOlder = await currentItemId(page);
  await pressB(cdp);
  const flash1 = await waitFor(page, FLASH_SHOWN);
  await wheel(cdp, false, 3);
  const atNewer = await currentItemId(page);
  await pressB(cdp);
  const flash2 = await waitFor(page, FLASH_SHOWN);
  const stored = await page.evaluate(READ_BOOKMARKS);
  await sleep(1700); // the pill shows ~900 ms, then fades within ~450 ms
  const flashGone = await page.evaluate(
    () => document.getElementById("flash") === null,
  );
  const older = item("video-chain-3").index;
  const newer = item("chain-still-3").index;
  check(
    "b appends bookmarks at two items, in order, each with a flash that fades",
    walked &&
      atOlder === "video-chain-3" &&
      atNewer === "chain-still-3" &&
      flash1 &&
      flash2 &&
      stored.length === 2 &&
      stored[0].itemIndex === older &&
      stored[1].itemIndex === newer &&
      stored.every((b) => b.timestampMs > 0 && b.id.length > 0) &&
      flashGone,
    { atOlder, atNewer, flash1, flash2, stored, flashGone },
  );

  // A short viewport so two rows genuinely overflow the list.
  await page.setViewport({ width: 800, height: 180, deviceScaleFactor: 1 });
  await pressT(cdp);
  const listOpened = await waitFor(page, OVERLAY_OPEN);
  const list = await page.evaluate(READ_BOOKMARK_OVERLAY);
  const entries = list.entries ?? [];
  const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
  const newest = entries[entries.length - 1];
  const newestVisible =
    newest !== undefined &&
    newest.rect.top >= list.listRect.top - 1 &&
    newest.rect.bottom <= list.listRect.bottom + 1;
  check(
    "t opens the list oldest first, scrolled so the newest row is visible",
    listOpened &&
      list.title === "Bookmarks" &&
      entries.length === 2 &&
      entries[0].itemIndex === older &&
      entries[1].itemIndex === newer &&
      maxScroll > 0 &&
      list.scrollTop >= maxScroll - 1 &&
      newestVisible &&
      entries.every(
        (e) =>
          e.thumbResolved &&
          (e.thumbSrcHead?.startsWith("data:") === true ||
            /\.(?:jpg|jpeg|png|webp|gif)$/i.test(e.thumbSrcHead ?? "")) &&
          TIME_RE.test(e.time),
      ),
    {
      entries: entries.map((e) => [e.itemIndex, e.time, e.thumbSrcHead]),
      scrollTop: list.scrollTop,
      maxScroll,
      newestVisible,
    },
  );

  const sigBefore = await readSignature(page);
  await pressSpace(cdp);
  await pressTab(cdp);
  await wheelNotch(cdp, true);
  await sleep(WHEEL_GAP_MS);
  const sigAfter = await readSignature(page);
  const still = await page.evaluate(READ_BOOKMARK_OVERLAY);
  check(
    "while the list is open the timeline is suspended: space, tab and the wheel move nothing",
    sigAfter === sigBefore &&
      still.hidden === false &&
      still.entries.length === 2,
    { sigBefore, sigAfter },
  );
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
  await sleep(100);

  // Click the OLDER row: the list closes on that item; `e` then resumes at
  // the first unseen item, proving the restore left the frontier alone.
  const reread = await page.evaluate(READ_BOOKMARK_OVERLAY);
  await rowCenterClick(cdp, reread.entries[0]);
  const listClosed = await waitFor(page, OVERLAY_CLOSED);
  const landed = await page.evaluate(PAGE_STATE);
  const landedId = await currentItemId(page);
  await pressE(cdp);
  const atFrontier = await waitFor(
    page,
    (poster) =>
      document.getElementById("visual-video")?.getAttribute("poster") ===
      poster,
    5000,
    item("video-loops").poster,
  );
  const frontierId = await currentItemId(page);
  check(
    "clicking the older row continues from that item; e then resumes at the unchanged frontier",
    listClosed &&
      landedId === "video-chain-3" &&
      landed.video?.visible === true &&
      landed.imgVisible === false &&
      atFrontier &&
      frontierId === "video-loops",
    { landedId, video: landed.video?.visible, frontierId },
  );

  // Ways out: backdrop click, a windowed Escape, and t again.
  await pressT(cdp);
  await waitFor(page, OVERLAY_OPEN);
  const reopened = await page.evaluate(READ_BOOKMARK_OVERLAY);
  await clickCenter(cdp, reopened.titleRect);
  const afterBackdrop = await panelOpen(page);
  await pressT(cdp);
  await waitFor(page, OVERLAY_OPEN);
  await pressEscape(cdp);
  await sleep(80);
  const afterEscape = await panelOpen(page);
  const windowed = await page.evaluate(
    () => document.fullscreenElement === null,
  );
  await pressT(cdp);
  await waitFor(page, OVERLAY_OPEN);
  await pressT(cdp);
  const afterT = await panelOpen(page);
  check(
    "t reopens the list; a backdrop click, one windowed Escape and t again each close it",
    fs.ok &&
      reopened.entries.length === 2 &&
      afterBackdrop === false &&
      afterEscape === false &&
      windowed &&
      afterT === false,
    {
      fs: fs.wasFullscreen,
      reopened: reopened.entries.length,
      afterBackdrop,
      afterEscape,
      windowed,
      afterT,
    },
  );
}

// Old steps 42 and 26: durable bookmark + reload, then resume where read.
async function resume({ check, open }) {
  const { page, cdp } = await open("resume", { closeHelp: true });
  const target = item("text-narration");

  // b, then a reload the instant the pill shows: nothing in between.
  const walked = await spaceTo(page, cdp, target.id);
  await pressB(cdp);
  const flashed = await waitFor(page, FLASH_SHOWN);
  await page.reload();
  const painted = await waitFor(
    page,
    () =>
      (document.getElementById("visual-image")?.getAttribute("src") ?? "") !==
      "",
  );
  const resumed = await page.evaluate(PAGE_STATE);
  const resumedId = await currentItemId(page);
  const stored = await page.evaluate(READ_BOOKMARKS);
  await pressT(cdp);
  const listOpen = await waitFor(page, OVERLAY_OPEN);
  const list = await page.evaluate(READ_BOOKMARK_OVERLAY);
  const rows = list.entries ?? [];
  if (rows.length > 0) await rowCenterClick(cdp, rows[rows.length - 1]);
  const listClosed = await waitFor(page, OVERLAY_CLOSED);
  const afterRow = await currentItemId(page);
  check(
    "b then an immediate reload resumes on the bookmarked item, help closed, and its t row agrees",
    walked &&
      flashed &&
      painted &&
      resumedId === target.id &&
      resumed.helpOpen === false &&
      resumed.stageHidden === false &&
      stored.length === 1 &&
      stored[0].itemIndex === target.index &&
      listOpen &&
      rows.length === 1 &&
      rows[0].itemIndex === target.index &&
      listClosed &&
      afterRow === target.id,
    { resumedId, help: resumed.helpOpen, stored, rows: rows.length, afterRow },
  );

  // Read on to chain-still-3 (the reading position), wheel back onto the
  // bare chain-still, reload: wheel scrubbing does not move the reading
  // position (Phase 18), so the page comes back on the item last READ.
  await spaceTo(page, cdp, "chain-still-3");
  const readSig = await page.evaluate(PAINT_SIG);
  await wheel(cdp, true, 2);
  const scrubbedTo = await currentItemId(page);
  await sleep(300);
  await page.reload();
  await sleep(700);
  const after = await page.evaluate(PAGE_STATE);
  const sigResumed = await page.evaluate(PAINT_SIG);
  await sleep(1800); // past every floor hold: a manual resume holds still
  const sigHeld = await page.evaluate(PAINT_SIG);

  // Not the seen edge either: the bookmark row puts the reading position
  // back on text-narration while 0..11 stay seen; a reload resumes there.
  await pressT(cdp);
  await waitFor(page, OVERLAY_OPEN);
  const again = await page.evaluate(READ_BOOKMARK_OVERLAY);
  if ((again.entries ?? []).length > 0) {
    await rowCenterClick(cdp, again.entries[0]);
  }
  await waitFor(page, OVERLAY_CLOSED);
  const restored = await currentItemId(page);
  await sleep(300);
  await page.reload();
  await sleep(700);
  const resumedBehind = await currentItemId(page);
  check(
    "reload resumes on the item last read (not a wheel-scrubbed one, not the seen edge); the seen help stays closed",
    scrubbedTo === "chain-still" &&
      sigResumed === readSig &&
      sigHeld === readSig &&
      after.helpOpen === false &&
      after.stageHidden === false &&
      restored === target.id &&
      resumedBehind === target.id,
    {
      scrubbedTo,
      readSig,
      sigResumed,
      sigHeld,
      help: after.helpOpen,
      restored,
      resumedBehind,
    },
  );
}

// Old steps 27-28: the config screen, live settings, persistence.
async function config({ check, open }) {
  const { page, cdp } = await open("config", { closeHelp: true });
  await spaceTo(page, cdp, "text-narration");

  await pressC(cdp);
  const opened = await waitFor(page, CONFIG_OPEN);
  const first = await page.evaluate(READ_CONFIG_OVERLAY);
  check(
    "c opens the config screen showing the defaults",
    opened &&
      first.title === "Config" &&
      first.speedValue === SPEED_1X &&
      first.skipPressed === "false" &&
      first.skipLabel === "Off" &&
      first.playPressed === "false" &&
      first.playLabel === "Off",
    first,
  );

  const sigBefore = await page.evaluate(SIGNATURE);
  await pressSpace(cdp);
  await pressTab(cdp);
  await pressE(cdp);
  await wheelNotch(cdp, true);
  await sleep(WHEEL_GAP_MS);
  const sigAfter = await page.evaluate(SIGNATURE);
  check(
    "while config is open the timeline is suspended: space, tab, e and the wheel move nothing",
    sigAfter === sigBefore && (await configOpen(page)),
    { sigBefore, sigAfter },
  );

  await clickCenter(cdp, first.skipRect);
  await clickCenter(cdp, first.playRect);
  const toggled = await page.evaluate(READ_CONFIG_OVERLAY);
  await clickCenter(cdp, toggled.titleRect);
  const closedByBackdrop = (await configOpen(page)) === false;
  await pressC(cdp);
  await waitFor(page, CONFIG_OPEN);
  const again = await page.evaluate(READ_CONFIG_OVERLAY);
  await clickCenter(cdp, again.playRect); // play-all back to its default
  const playOff = await page.evaluate(READ_CONFIG_OVERLAY);
  await pressC(cdp);
  const closedByC = (await configOpen(page)) === false;
  check(
    "the switches flip skip-all and play-all on; backdrop closes, c reopens with them on, c closes",
    toggled.skipPressed === "true" &&
      toggled.skipLabel === "On" &&
      toggled.playPressed === "true" &&
      toggled.playLabel === "On" &&
      closedByBackdrop &&
      again.skipPressed === "true" &&
      again.playPressed === "true" &&
      playOff.playPressed === "false" &&
      closedByC,
    {
      toggled,
      closedByBackdrop,
      again,
      playOff: playOff.playPressed,
      closedByC,
    },
  );

  // Four + clicks: 1.00x -> 2.00x, shown live in the open panel.
  await pressC(cdp);
  await waitFor(page, CONFIG_OPEN);
  for (let i = 0; i < 4; i += 1) {
    const r = await page.evaluate(READ_CONFIG_OVERLAY);
    await clickCenter(cdp, r.speedUpRect);
  }
  const fast = await page.evaluate(READ_CONFIG_OVERLAY);
  // The page went fullscreen on the first gesture: Chrome keeps the first
  // Escape, so the panel stays open and the second Escape closes it.
  const wasFullscreen = (await page.evaluate(PAGE_STATE)).fullscreenElement;
  await pressEscape(cdp);
  await sleep(80);
  const afterFirstEsc = await configOpen(page);
  const windowed = await page.evaluate(
    () => document.fullscreenElement === null,
  );
  if (afterFirstEsc) await pressEscape(cdp);
  await sleep(80);
  const closed = (await configOpen(page)) === false;
  check(
    "four + clicks show 2.00x; Escape closes config (the first one leaves fullscreen when fullscreen)",
    fast.speedValue === SPEED_2X &&
      fast.skipPressed === "true" &&
      windowed &&
      closed &&
      (wasFullscreen !== null ? afterFirstEsc === true : "PARTIAL"),
    {
      speed: fast.speedValue,
      wasFullscreen,
      afterFirstEsc,
      windowed,
      closed,
    },
  );

  // Live: auto-forward on, wheel back onto text-thought; its hold is the
  // 2.00x allowance, not the 1.00x one.
  const fastHold = holdMs("text-thought", 2);
  const slowHold = holdMs("text-thought", 1);
  await pressA(cdp);
  await wheelNotch(cdp, true);
  const armedAt = Date.now();
  const onThought = await waitForItem(page, "text-thought", 1000);
  const moved = await waitForItem(page, "text-narration", slowHold + 1000);
  const liveMs = Date.now() - armedAt;
  await pressA(cdp); // auto-forward off: the walk holds for the reload
  await sleep(200);
  const sig = await page.evaluate(PAINT_SIG);
  check(
    "2.00x applies live: the next hold is the 2.00x allowance",
    onThought &&
      moved &&
      liveMs > fastHold - 400 &&
      liveMs < (fastHold + slowHold) / 2,
    { liveMs, fastHold, slowHold },
  );

  await page.reload();
  await sleep(700);
  const sigResumed = await page.evaluate(PAINT_SIG);
  await pressC(cdp);
  await waitFor(page, CONFIG_OPEN);
  const persisted = await page.evaluate(READ_CONFIG_OVERLAY);
  check(
    "2.00x and skip-all survive a reload, which resumes on the same item",
    sigResumed === sig &&
      persisted.speedValue === SPEED_2X &&
      persisted.skipPressed === "true" &&
      persisted.playPressed === "false",
    { sig, sigResumed, persisted },
  );
}

// Old step 31: the empty-manifest folder.
async function emptyFolder({ check, open }) {
  const { page, cdp } = await open("empty", { folder: emptyDir });
  await waitFor(
    page,
    () => (document.getElementById("empty-state")?.textContent ?? "") !== "",
  );
  const s = await page.evaluate(PAGE_STATE);
  check(
    "an empty-manifest folder shows the empty state under its own first-load help",
    s.emptyState === EMPTY_NOTICE &&
      s.imgSrc === null &&
      s.overlayHidden === true &&
      s.helpOpen === true &&
      s.stageHidden === true,
    s,
  );
  await pressEnter(cdp);
  const helpClosed = await waitFor(page, HELP_CLOSED);
  const fs = await leaveFullscreen(page, cdp);
  await pressT(cdp);
  const listOpen = await waitFor(page, OVERLAY_OPEN);
  const list = await page.evaluate(READ_BOOKMARK_OVERLAY);
  await pressEscape(cdp);
  await sleep(80);
  const closed = (await panelOpen(page)) === false;
  check(
    "t there says no bookmarks yet, and Escape closes it",
    helpClosed &&
      fs.ok &&
      listOpen &&
      (list.entries ?? []).length === 0 &&
      list.emptyText === EMPTY_MESSAGE &&
      closed,
    { helpClosed, fs: fs.wasFullscreen, emptyText: list.emptyText, closed },
  );
}

// Old step 47: Reset progress.
async function reset({ check, open }) {
  const { page, cdp } = await open("reset", { closeHelp: true });
  const target = item("video-chain");
  const walked = await spaceTo(page, cdp, target.id);
  await pressB(cdp);
  const flashed = await waitFor(page, FLASH_SHOWN);
  // A non-default speed, so the reset has a setting to put back.
  await pressC(cdp);
  await waitFor(page, CONFIG_OPEN);
  for (let i = 0; i < 4; i += 1) {
    const r = await page.evaluate(READ_CONFIG_OVERLAY);
    await clickCenter(cdp, r.speedUpRect);
  }
  const cfg = await page.evaluate(READ_CONFIG_OVERLAY);
  await clickCenter(cdp, cfg.resetRect);
  const box = await page.evaluate(READ_CONFIRM_OVERLAY);
  await clickCenter(cdp, box.cancelRect);
  const boxClosed = (await page.evaluate(CONFIRM_OPEN)) === false;
  check(
    "the Reset progress row opens a confirm box; Cancel closes it",
    walked &&
      flashed &&
      cfg.speedValue === SPEED_2X &&
      box.hidden === false &&
      box.title === "Reset progress" &&
      box.resetLabel === "Reset" &&
      box.cancelLabel === "Cancel" &&
      boxClosed,
    { walked, flashed, speed: cfg.speedValue, box, boxClosed },
  );

  // Cancel kept everything: a reload resumes there with the row and speed.
  // A reader's pause before the reload: a settings write still in flight
  // when the page goes is lost (OBSERVED, reported separately), and this
  // check is about Cancel, not that race.
  await sleep(500);
  await page.reload();
  await sleep(700);
  const resumed = await page.evaluate(PAGE_STATE);
  const resumedId = await currentItemId(page);
  await pressT(cdp);
  await waitFor(page, OVERLAY_OPEN);
  const kept = await page.evaluate(READ_BOOKMARK_OVERLAY);
  await pressT(cdp);
  await pressC(cdp);
  await waitFor(page, CONFIG_OPEN);
  const keptCfg = await page.evaluate(READ_CONFIG_OVERLAY);
  check(
    "cancel kept everything: the reload resumes on the item, the row and 2.00x are still there",
    resumedId === target.id &&
      resumed.helpOpen === false &&
      (kept.entries ?? []).length === 1 &&
      kept.entries[0].itemIndex === target.index &&
      keptCfg.speedValue === SPEED_2X,
    {
      resumedId,
      help: resumed.helpOpen,
      rows: (kept.entries ?? []).map((e) => e.itemIndex),
      speed: keptCfg.speedValue,
    },
  );

  // Confirm: the app's own wipe + reload is a first-ever boot.
  await clickCenter(cdp, keptCfg.resetRect);
  const box2 = await page.evaluate(READ_CONFIRM_OVERLAY);
  await clickCenter(cdp, box2.resetRect);
  const bootHelp = await waitFor(page, HELP_OPEN, 6000);
  await sleep(400);
  const boot = await page.evaluate(PAGE_STATE);
  const bootId = await currentItemId(page);
  await pressEnter(cdp);
  await waitFor(page, HELP_CLOSED);
  await pressT(cdp);
  await waitFor(page, OVERLAY_OPEN);
  const list = await page.evaluate(READ_BOOKMARK_OVERLAY);
  await pressT(cdp);
  await pressC(cdp);
  await waitFor(page, CONFIG_OPEN);
  const fresh = await page.evaluate(READ_CONFIG_OVERLAY);
  await pressC(cdp);
  check(
    "confirming is a true first-ever boot: help up, first item, empty list, 1.00x and switches off",
    box2.hidden === false &&
      bootHelp &&
      boot.helpOpen === true &&
      boot.stageHidden === true &&
      bootId === item("intro-title").id &&
      (list.entries ?? []).length === 0 &&
      list.emptyText === EMPTY_MESSAGE &&
      fresh.speedValue === SPEED_1X &&
      fresh.skipPressed === "false" &&
      fresh.playPressed === "false",
    {
      bootHelp,
      bootId,
      stage: boot.stageHidden,
      emptyText: list.emptyText,
      speed: fresh.speedValue,
    },
  );
}

export default async function (ctx) {
  for (const part of [
    helpMidFlow,
    bookmarks,
    resume,
    config,
    emptyFolder,
    reset,
  ]) {
    try {
      await part(ctx);
    } catch (error) {
      ctx.check(`${part.name} completed`, false, String(error?.stack ?? error));
    }
  }
}
