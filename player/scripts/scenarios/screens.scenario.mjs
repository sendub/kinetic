// The screens over the stage (old driver steps 20, 22-28, 31, 42, 47): the
// mid-flow key help, bookmarks (`b`, the `t` list, restore from a row),
// reload resume, the settings on the Esc screen and their persistence
// (including a reload the instant after a change), the empty-manifest
// folder, "Reset progress", and a save surviving a content update (a
// prequel inserted before everything, an item deleted). Each part opens
// its own fresh profile, so no part leans on another's storage.

import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_SETTINGS } from "../../src/machine/types.ts";
import { speedLabel } from "../../src/render/config.ts";
import { EARLIER_UNSEEN_NOTICE } from "../../src/render/endcard.ts";
import {
  CONFIG_CONTROL,
  CONFIRM_CONTROL,
  CONFIRM_OPEN,
  clickAt,
  clickCenter,
  closeSettings,
  configOpen,
  currentItemId,
  demoDir,
  emptyDir,
  escapeUntil,
  HELP_CLOSED,
  HELP_OPEN,
  helpOpen,
  item,
  manifest,
  OVERLAY_CLOSED,
  OVERLAY_OPEN,
  OVERLAY_VISIBLE,
  openSettings,
  PAGE_STATE,
  PAINT_SIG,
  panelOpen,
  pressA,
  pressB,
  pressC,
  pressE,
  pressEnter,
  pressEscape,
  pressEscapeSeen,
  pressSpace,
  pressT,
  pressTab,
  pressU,
  READ_BOOKMARK_OVERLAY,
  READ_CONFIG_OVERLAY,
  READ_CONFIRM_OVERLAY,
  READ_HELP,
  READ_KEY_GRID,
  readBookmarks,
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
const HELP_TITLE = "Keys";
const HELP_HINT = "Esc or Space closes; click a setting to change it";
// The main interaction keys, one row each (Phase 18, "Key help
// simplified"): no reset-box keys; Enter only with a decision's arrows.
const HELP_KEYS = [
  "Space",
  "wheel",
  "E",
  "U",
  "Tab",
  "A",
  "H",
  "B",
  "T",
  "M",
  "Esc",
  "1-9 / 0",
  "↑ ↓ Enter",
];
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
 * Headless Chrome drops fullscreen on its own soon after, and an Escape sent
 * before that reaches the page (it opens the Esc screen) instead of being
 * kept; that Escape is then undone with one more, and `kept: false` says the
 * browser's keeping could not be observed. Returns what happened, so callers
 * can assert the windowed state that follows; `wasFullscreen: false` means
 * headless never entered it (or had already left).
 */
async function leaveFullscreen(page, cdp) {
  const before = await page.evaluate(PAGE_STATE);
  if (before.fullscreenElement === null) {
    return { wasFullscreen: false, ok: true, before };
  }
  const kept = !(await pressEscapeSeen(page, cdp));
  if (!kept) await escapeUntil(page, cdp, HELP_CLOSED);
  await page
    .waitForFunction(() => document.fullscreenElement === null, {
      timeout: 5000,
    })
    .catch(() => {});
  const after = await page.evaluate(PAGE_STATE);
  return {
    wasFullscreen: true,
    kept,
    ok: after.fullscreenElement === null && after.helpOpen === false,
    before,
    after,
  };
}

// Phase 24: on the first load a click does not close the help (its
// keys do). The click is still the page's first gesture, so it makes the
// one fullscreen request; Space then closes the help, consumed, no advance.
async function helpFirstLoadClick({ check, open }) {
  const { page, cdp } = await open("help-first-click");
  const start = await page.evaluate(PAGE_STATE);
  await clickAt(cdp, 400, 400);
  await sleep(300);
  const clicked = await page.evaluate(PAGE_STATE);
  check(
    "first load: a click leaves the key help up over the first item (it only makes the fullscreen request)",
    start.helpOpen === true &&
      clicked.helpOpen === true &&
      clicked.stageHidden === true &&
      clicked.text === start.text &&
      clicked.fsAttempts === 1,
    { start, clicked },
  );
  await pressSpace(cdp);
  await sleep(150);
  const closed = await page.evaluate(PAGE_STATE);
  check(
    "first load: Space then closes the help without advancing, no second fullscreen request",
    closed.helpOpen === false &&
      closed.stageHidden === false &&
      closed.text === start.text &&
      closed.fsAttempts === 1,
    closed,
  );
}

// Old step 20: Escape opens the key help mid-flow.
async function helpMidFlow({ check, open }) {
  const { page, cdp } = await open("help", { closeHelp: true });
  const fs = await leaveFullscreen(page, cdp);
  check(
    "the first Escape while fullscreen is the browser's: it leaves fullscreen and opens nothing",
    fs.ok ? (fs.wasFullscreen && fs.kept ? true : "PARTIAL") : false,
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

  check(
    "the help is headed by the game's name (the manifest title), which also names the page",
    typeof manifest.title === "string" &&
      help.game === manifest.title &&
      help.gameFirst === true &&
      help.pageTitle === manifest.title,
    {
      game: help.game,
      first: help.gameFirst,
      pageTitle: help.pageTitle,
      expected: manifest.title,
    },
  );

  check(
    "the help lists only the main keys, one row each (no c), and its hint reads Esc or Space closes; click a setting to change it",
    JSON.stringify(help.rows.map((r) => r.key)) === JSON.stringify(HELP_KEYS) &&
      help.rows.every((r) => r.desc.length > 0 && r.desc.length <= 56) &&
      help.hint === HELP_HINT,
    { keys: help.rows.map((r) => r.key), hint: help.hint },
  );

  await pressEnter(cdp);
  await sleep(150);
  const afterEnter = await page.evaluate(PAGE_STATE);
  check(
    "Enter does nothing on the help screen: it stays open over the same item",
    afterEnter.helpOpen === true &&
      afterEnter.stageHidden === true &&
      afterEnter.text === item("text-speech").text,
    { help: afterEnter.helpOpen, text: afterEnter.text },
  );

  // The Esc screen holds the settings too (Phase 26): under the key grid,
  // shown with it. `c` is no key: it changes nothing, on the screen or
  // (below) behind it. (`t` swaps the screen for the bookmark list:
  // escToBookmarks.)
  const onScreen = await page.evaluate(READ_CONFIG_OVERLAY);
  const grid = await page.evaluate(READ_KEY_GRID);
  check(
    "the Esc screen shows the settings under the keys, and the keys fill across before going down",
    onScreen.hidden === false &&
      onScreen.belowKeys === true &&
      grid.columns >= 2 &&
      grid.acrossFirst === true &&
      grid.scrollWidth <= grid.clientWidth,
    { belowKeys: onScreen.belowKeys, grid },
  );
  await pressC(cdp);
  await sleep(150);
  const afterC = {
    help: await helpOpen(page),
    config: await configOpen(page),
    list: await panelOpen(page),
    text: (await page.evaluate(PAGE_STATE)).text,
  };
  check(
    "c changes nothing on the Esc screen",
    afterC.help === true &&
      afterC.config === true &&
      afterC.list === false &&
      afterC.text === item("text-speech").text,
    { afterC },
  );

  // Space closes the screen even with a settings button focused (a click
  // focuses it): the keymap's Space wins, the button does not flip.
  await clickCenter(cdp, CONFIG_CONTROL.skip);
  const flipped = await page.evaluate(READ_CONFIG_OVERLAY);
  const focused = await page.evaluate(
    () => document.activeElement?.className ?? "",
  );
  await pressSpace(cdp);
  const spaceClosed = await waitFor(page, HELP_CLOSED, 2000);
  const afterSpace = await page.evaluate(PAGE_STATE);
  const reopened = await openSettings(page, cdp);
  const kept = await page.evaluate(READ_CONFIG_OVERLAY);
  await clickCenter(cdp, CONFIG_CONTROL.skip); // back to Off for the rest
  check(
    "Space with a settings button focused closes the screen without pressing it (no advance)",
    flipped.skipPressed === "true" &&
      focused.includes("config-skip-all") &&
      spaceClosed &&
      afterSpace.text === item("text-speech").text &&
      reopened &&
      kept.skipPressed === "true",
    {
      flipped: flipped.skipPressed,
      focused,
      spaceClosed,
      kept: kept.skipPressed,
    },
  );
  const helpBack = await helpOpen(page);
  const back = await page.evaluate(PAGE_STATE);
  check(
    "Escape reopens the Esc screen over the same item",
    helpBack && back.text === item("text-speech").text,
    { helpBack, text: back.text },
  );

  // Auto-forward is on; 3.2 s behind the help must show no move.
  const samples = transitions(await sampleSignatures(page, 3200, 120));
  check(
    "behind the help the machine is paused: no item moves with auto-forward on",
    samples.length === 1 && samples[0][1].includes(item("text-speech").text),
    samples.map(([, sig]) => sig),
  );

  // A click never closes the help (docs/plan.md Phase 24): one on the
  // panel's top edge and one mid-screen both leave it up, nothing moving.
  // (Mid-screen is the key grid: the settings below it are controls.)
  await clickAt(cdp, 400, 40);
  await clickCenter(cdp, (await page.evaluate(READ_KEY_GRID)).rect);
  await sleep(300);
  const clicked = await page.evaluate(PAGE_STATE);
  check(
    "a click does not close the help: it stays up over the same item",
    clicked.helpOpen === true &&
      clicked.stageHidden === true &&
      clicked.text === item("text-speech").text,
    { help: clicked.helpOpen, text: clicked.text },
  );

  await pressSpace(cdp); // its key closes it
  const closedAt = Date.now();
  const closed = await page.evaluate(PAGE_STATE);
  const advanced = await waitForItem(page, "text-thought", hold + 1500);
  const advancedMs = Date.now() - closedAt;
  check(
    "Space closes the help on the same item, and its hold re-arms fresh from the close",
    closed.helpOpen === false &&
      closed.stageHidden === false &&
      closed.text === item("text-speech").text &&
      advanced &&
      advancedMs > hold - 500,
    { closed: closed.helpOpen, advanced, advancedMs, fullHold: hold },
  );
}

// The Esc screen hands over to the `t` list: `t`, or a click on the
// screen's T entry, closes the Esc screen and opens the bookmark list in
// its place (no frame with neither up), and the next Escape goes back to
// the game, as closing the Esc screen would (the menu pause lifts), not
// back to the Esc screen. A bookmark picked from that list lands as
// usual. KINETIC_ESC_T_SHOTS names a folder for a screenshot of the
// hovered T entry.
async function escToBookmarks({ check, open }) {
  const { page, cdp } = await open("esc-t", { closeHelp: true });
  await leaveFullscreen(page, cdp);
  const NEITHER = () =>
    (document.getElementById("help")?.hidden ?? true) &&
    (document.getElementById("bookmarks")?.hidden ?? true);
  const SCREENS = () => ({
    help: !(document.getElementById("help")?.hidden ?? true),
    list: !(document.getElementById("bookmarks")?.hidden ?? true),
    stageHidden: (() => {
      const stage = document.getElementById("stage");
      return stage === null ? null : getComputedStyle(stage).display === "none";
    })(),
    text: document.getElementById("overlay-text")?.textContent ?? "",
  });
  // Counts animation frames in which neither screen is up while armed:
  // the game showing through between the two.
  const ARM_GAP_PROBE = () => {
    window.__gapFrames = 0;
    window.__gapArmed = true;
    const tick = () => {
      if (!window.__gapArmed) return;
      const help = document.getElementById("help");
      const list = document.getElementById("bookmarks");
      if ((help?.hidden ?? true) && (list?.hidden ?? true)) {
        window.__gapFrames += 1;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const readGap = () =>
    page.evaluate(() => {
      window.__gapArmed = false;
      return window.__gapFrames;
    });

  // One bookmark, at text-speech; read on to text-thought.
  await spaceTo(page, cdp, "text-speech");
  await pressB(cdp);
  await waitFor(page, FLASH_SHOWN);
  await spaceTo(page, cdp, "text-thought");
  const at = item("text-thought").text;
  const hold = holdMs("text-thought");

  // `t` over the Esc screen, auto-forward on: the list replaces the
  // screen, and the machine stays paused under it.
  await pressA(cdp);
  await pressEscape(cdp);
  const helpUp = await waitFor(page, HELP_OPEN, 2000);
  await page.evaluate(ARM_GAP_PROBE);
  await pressT(cdp);
  const listUp = await waitFor(page, OVERLAY_VISIBLE, 2000);
  await sleep(100);
  const gap = await readGap();
  const swapped = await page.evaluate(SCREENS);
  await sleep(hold + 300);
  const stillHere = await page.evaluate(SCREENS);
  check(
    "t on the Esc screen swaps it for the bookmark list (no frame with neither up), the story paused under it",
    helpUp &&
      listUp &&
      gap === 0 &&
      swapped.help === false &&
      swapped.list === true &&
      stillHere.list === true &&
      stillHere.text === at,
    { helpUp, listUp, gap, swapped, stillHere: stillHere.text, hold },
  );

  // Escape from that list goes back to the game, not to the Esc screen;
  // the pause lifts, so auto-forward moves on after a fresh hold.
  const back = await escapeUntil(page, cdp, NEITHER);
  const game = await page.evaluate(SCREENS);
  const movedOn = await waitFor(
    page,
    (t) => document.getElementById("overlay-text")?.textContent !== t,
    hold + 1500,
    at,
  );
  await pressA(cdp); // auto-forward off for the rest
  check(
    "Escape from that list returns to the game (no Esc screen), and auto-forward resumes",
    back &&
      game.help === false &&
      game.list === false &&
      game.stageHidden === false &&
      game.text === at &&
      movedOn,
    { back, game, movedOn },
  );

  // The T entry is a control: it lights up under the pointer, and a
  // click does what `t` does.
  await escapeUntil(page, cdp, HELP_OPEN);
  // The "Auto-forward off" pill fades first, for a clean screenshot.
  await waitFor(page, () => document.getElementById("flash") === null);
  const T_ROW = "#help button.help-row";
  const LOOK = (sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    const cap = el.querySelector(".help-cap");
    return {
      key: el.querySelector(".help-key")?.textContent ?? "",
      rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      cursor: getComputedStyle(el).cursor,
      rule: getComputedStyle(el).borderTopColor,
      cap: cap === null ? null : getComputedStyle(cap).borderTopColor,
      buttons: document.querySelectorAll("#help button.help-row").length,
    };
  };
  const plain = await page.evaluate(LOOK, T_ROW);
  if (plain !== null) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round((plain.rect.left + plain.rect.right) / 2),
      y: Math.round((plain.rect.top + plain.rect.bottom) / 2),
    });
    await sleep(150);
  }
  const hovered = await page.evaluate(LOOK, T_ROW);
  const shots = process.env.KINETIC_ESC_T_SHOTS;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, "esc-t-hover.png") });
  }
  check(
    "only the T and M entries are clickable, and T looks it: pointer cursor, its rule and caps lit on hover",
    plain !== null &&
      hovered !== null &&
      plain.key === "T" &&
      plain.buttons === 2 &&
      plain.cursor === "pointer" &&
      hovered.rule !== plain.rule &&
      hovered.cap !== plain.cap,
    { plain, hovered },
  );

  await page.evaluate(ARM_GAP_PROBE);
  await clickCenter(cdp, T_ROW);
  const clickUp = await waitFor(page, OVERLAY_VISIBLE, 2000);
  await sleep(100);
  const clickGap = await readGap();
  const clickSwap = await page.evaluate(SCREENS);
  const clickBack = await escapeUntil(page, cdp, NEITHER);
  const clickGame = await page.evaluate(SCREENS);
  check(
    "clicking the T entry swaps the Esc screen for the list, and Escape then returns to the game",
    clickUp &&
      clickGap === 0 &&
      clickSwap.help === false &&
      clickSwap.list === true &&
      clickBack &&
      clickGame.help === false &&
      clickGame.list === false &&
      clickGame.stageHidden === false,
    { clickUp, clickGap, clickSwap, clickBack, clickGame },
  );

  // Picking a bookmark from the list the Esc screen opened lands on it.
  await escapeUntil(page, cdp, HELP_OPEN);
  await clickCenter(cdp, T_ROW);
  await waitFor(page, OVERLAY_OPEN);
  const list = await page.evaluate(READ_BOOKMARK_OVERLAY);
  if (list.entries?.[0] !== undefined) {
    await rowCenterClick(cdp, list.entries[0]);
  }
  const closed = await waitFor(page, NEITHER, 3000);
  const landed = await waitForItem(page, "text-speech", 3000);
  const final = await page.evaluate(SCREENS);
  check(
    "a bookmark picked from that list lands on its item, both screens closed",
    list.entries?.length === 1 &&
      closed &&
      landed &&
      final.help === false &&
      final.list === false &&
      final.stageHidden === false,
    { entries: list.entries?.length, closed, landed, final },
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
  const stored = await readBookmarks(page);
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

  // A narrow, short viewport: one grid column (Phase 26), so the two
  // cards stack and genuinely overflow the list.
  await page.setViewport({ width: 400, height: 420, deviceScaleFactor: 1 });
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

  // Click the OLDER row: the list closes on that item. The wheel walks the
  // story around the landing (docs/plan.md Phase 27): a notch back shows
  // the item before it (video-chain-2), not the screen the click left, and
  // `e` goes to the furthest point read, chain-still-3.
  const reread = await page.evaluate(READ_BOOKMARK_OVERLAY);
  await rowCenterClick(cdp, reread.entries[0]);
  const listClosed = await waitFor(page, OVERLAY_CLOSED);
  const landed = await page.evaluate(PAGE_STATE);
  const landedId = await currentItemId(page);
  await wheelNotch(cdp, true);
  await sleep(WHEEL_GAP_MS);
  const beforeJump = await currentItemId(page);
  await wheelNotch(cdp, false); // forward: the landing again
  await sleep(WHEEL_GAP_MS);
  const backOnLanding = await currentItemId(page);
  await pressE(cdp);
  const atFurthest = await waitForItem(page, "chain-still-3", 3000);
  check(
    "clicking the older row continues from that item; the wheel walks the story around it (back: video-chain-2); e from the landing goes to the furthest read, chain-still-3",
    listClosed &&
      landedId === "video-chain-3" &&
      landed.video?.visible === true &&
      landed.imgVisible === false &&
      beforeJump === "video-chain-2" &&
      backOnLanding === "video-chain-3" &&
      atFurthest,
    {
      landedId,
      video: landed.video?.visible,
      beforeJump,
      backOnLanding,
      atFurthest,
    },
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

  // Phase 18, "Delete a bookmark": each thumbnail's top-right "x" deletes
  // that row (storage included) without opening it; the list re-renders.
  const sigBeforeDelete = await readSignature(page);
  const idBeforeDelete = await currentItemId(page);
  await pressT(cdp);
  await waitFor(page, OVERLAY_OPEN);
  const two = await page.evaluate(READ_BOOKMARK_OVERLAY);
  const x = two.entries?.[0]?.deleteRect ?? null;
  const box = two.entries?.[0]?.thumbBoxRect ?? null;
  const inCorner =
    x !== null &&
    box !== null &&
    x.right <= box.right + 1 &&
    x.right >= box.right - 8 &&
    x.top >= box.top - 1 &&
    x.top <= box.top + 8;
  if (x !== null) await clickCenter(cdp, x);
  const oneLeft = await waitFor(
    page,
    () => document.querySelectorAll(".bookmark-entry").length === 1,
    3000,
  );
  const afterDelete = await page.evaluate(READ_BOOKMARK_OVERLAY);
  const storedAfter = await readBookmarks(page);
  const sigAfterDelete = await readSignature(page);
  const idAfterDelete = await currentItemId(page);
  check(
    "a thumbnail's x (top-right corner) deletes that bookmark without opening it: the list re-renders with the other row, storage agrees",
    two.entries?.length === 2 &&
      two.entries.every((e) => e.deleteText === "×") &&
      inCorner &&
      oneLeft &&
      afterDelete.hidden === false &&
      afterDelete.entries.length === 1 &&
      afterDelete.entries[0].itemIndex === newer &&
      storedAfter.length === 1 &&
      storedAfter[0].itemIndex === newer &&
      idAfterDelete === idBeforeDelete &&
      sigAfterDelete === sigBeforeDelete,
    {
      x,
      box,
      inCorner,
      rows: (afterDelete.entries ?? []).map((e) => e.itemIndex),
      stored: storedAfter.map((b) => b.itemIndex),
      idBeforeDelete,
      idAfterDelete,
    },
  );
  await pressT(cdp);
  await page.reload();
  await waitFor(
    page,
    () =>
      (document.getElementById("visual-image")?.getAttribute("src") ?? "") !==
        "" || document.getElementById("visual-video") !== null,
  );
  await sleep(300);
  await pressT(cdp);
  await waitFor(page, OVERLAY_OPEN);
  const reloaded = await page.evaluate(READ_BOOKMARK_OVERLAY);
  check(
    "after a reload the deleted bookmark stays deleted: t lists only the other row",
    reloaded.hidden === false &&
      reloaded.entries.length === 1 &&
      reloaded.entries[0].itemIndex === newer,
    { rows: (reloaded.entries ?? []).map((e) => e.itemIndex) },
  );
}

// Phase 26, "Bigger bookmark thumbnails in a grid": eight bookmarks fill
// a grid of large cards across, then down (oldest top-left, newest last),
// opened scrolled so the newest card is in view; × and a click still
// delete and continue. KINETIC_BMGRID_SHOTS names a folder for screenshots
// at 1280x720 and 700x900.
const GRID_THUMB_MIN_WIDTH = 240; // the old one-column rows drew ~102 px

const gridLayout = (list) => {
  const entries = list.entries ?? [];
  const rects = entries.map((e) => e.rect);
  const lefts = new Set(rects.map((r) => Math.round(r.left)));
  const readingOrder = rects
    .map((r, i) => ({ i, top: Math.round(r.top), left: Math.round(r.left) }))
    .sort((a, b) => a.top - b.top || a.left - b.left)
    .map((r) => r.i);
  const thumbs = entries.map((e) => e.thumbRect);
  const newest = rects[rects.length - 1];
  return {
    columns: lefts.size,
    acrossFirst:
      rects.length > 1 &&
      Math.round(rects[1].top) === Math.round(rects[0].top) &&
      rects[1].left > rects[0].left,
    readingOrderIsDomOrder: readingOrder.every((v, i) => v === i),
    thumbWidths: thumbs.map((t) => Math.round(t.right - t.left)),
    thumbAspects: thumbs.map(
      (t) => Math.round(((t.right - t.left) / (t.bottom - t.top)) * 100) / 100,
    ),
    scrolledToNewest:
      list.scrollTop >=
        Math.max(0, list.scrollHeight - list.clientHeight) - 1 &&
      newest !== undefined &&
      newest.top >= list.listRect.top - 1 &&
      newest.bottom <= list.listRect.bottom + 1,
    noSideScroll: list.scrollWidth <= list.clientWidth,
  };
};

async function bookmarkGrid({ check, open }) {
  const { page, cdp } = await open("bookmark-grid", { closeHelp: true });
  await leaveFullscreen(page, cdp);
  const shots = process.env.KINETIC_BMGRID_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });

  // Eight bookmarks, newest-read first: chain-still-3 then one notch back
  // each time, so storage (oldest first) runs item 11 down to item 4.
  await spaceTo(page, cdp, "chain-still-3");
  const taken = [];
  for (let n = 1; n <= 8; n += 1) {
    taken.push(await currentItemId(page));
    await pressB(cdp);
    for (let tries = 0; tries < 40; tries += 1) {
      if ((await readBookmarks(page)).length === n) break;
      await sleep(50);
    }
    if (n < 8) await wheel(cdp, true, 1);
  }
  const stored = await readBookmarks(page);
  const storedOrder = stored.map((b) => b.itemIndex);
  await waitFor(page, () => document.getElementById("flash") === null); // a clean screenshot

  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await sleep(100);
  await pressT(cdp);
  await waitFor(page, OVERLAY_OPEN);
  await waitFor(page, () =>
    [...document.querySelectorAll("img.bookmark-thumb")].every(
      (img) => img.complete && img.naturalWidth > 0,
    ),
  );
  const wide = await page.evaluate(READ_BOOKMARK_OVERLAY);
  const wideGrid = gridLayout(wide);
  if (shots) {
    await page.screenshot({ path: join(shots, "bookmarks-1280x720.png") });
  }
  check(
    "t at 1280x720 lays eight bookmarks out as a grid of large cards: several columns, across before down, oldest first, scrolled to show the newest, no sideways scroll",
    stored.length === 8 &&
      wide.entries?.length === 8 &&
      wide.entries.every((e, i) => e.itemIndex === storedOrder[i]) &&
      wideGrid.columns >= 3 &&
      wideGrid.acrossFirst &&
      wideGrid.readingOrderIsDomOrder &&
      wideGrid.thumbWidths.every((w) => w >= GRID_THUMB_MIN_WIDTH) &&
      wideGrid.thumbAspects.every((a) => Math.abs(a - 16 / 9) < 0.05) &&
      wideGrid.scrolledToNewest &&
      wideGrid.noSideScroll,
    { taken, storedOrder, ...wideGrid },
  );

  // The × still deletes without continuing; a card click still continues.
  // The newest card's × — the one in view, the list being scrolled to it.
  const sigBefore = await readSignature(page);
  await clickCenter(cdp, wide.entries[7].deleteRect);
  const sevenLeft = await waitFor(
    page,
    () => document.querySelectorAll(".bookmark-entry").length === 7,
    3000,
  );
  const afterDelete = await page.evaluate(READ_BOOKMARK_OVERLAY);
  const storedAfter = await readBookmarks(page);
  const sigAfter = await readSignature(page);
  const pick = afterDelete.entries?.[afterDelete.entries.length - 1];
  if (pick !== undefined) await clickCenter(cdp, pick.thumbRect);
  const closed = await waitFor(page, OVERLAY_CLOSED);
  const landed = await currentItemId(page);
  check(
    "in the grid a card's × deletes it, panel open and reading untouched; clicking a card closes the list on its item",
    sevenLeft &&
      afterDelete.hidden === false &&
      afterDelete.entries.map((e) => e.itemIndex).join() ===
        storedOrder.slice(0, 7).join() &&
      storedAfter.length === 7 &&
      sigAfter === sigBefore &&
      closed &&
      landed === stored[6].itemId,
    {
      rows: (afterDelete.entries ?? []).map((e) => e.itemIndex),
      stored: storedAfter.length,
      landed,
      want: stored[6].itemId,
    },
  );

  await page.setViewport({ width: 700, height: 900, deviceScaleFactor: 1 });
  await sleep(100);
  await pressT(cdp);
  await waitFor(page, OVERLAY_OPEN);
  await sleep(100);
  const tall = await page.evaluate(READ_BOOKMARK_OVERLAY);
  const tallGrid = gridLayout(tall);
  if (shots) {
    await page.screenshot({ path: join(shots, "bookmarks-700x900.png") });
  }
  check(
    "t at 700x900 still fills across first (two columns), large thumbnails, scrolled to the newest, no sideways scroll",
    tall.entries?.length === 7 &&
      tallGrid.columns >= 2 &&
      tallGrid.acrossFirst &&
      tallGrid.readingOrderIsDomOrder &&
      tallGrid.thumbWidths.every((w) => w >= GRID_THUMB_MIN_WIDTH) &&
      tallGrid.scrolledToNewest &&
      tallGrid.noSideScroll,
    tallGrid,
  );
  await pressT(cdp);
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
}

// The bookmark-screen speed item (docs/progress.md): with many bookmarks
// saved in the format players before it wrote — rows carrying a heavy route
// context and a 480 px JPEG capture each, and no list cache — `t` shows
// the panel at once, the cards follow, and every captured thumbnail fills
// in. The rows are copies of a real `b` row, written straight into
// IndexedDB as an older build left them.
const SPEED_ROWS = 60;
const SPEED_VISIBLE_MS = 300;

const SEED_OLD_ROWS = async (count) => {
  const open = () =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open("kinetic", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const db = await open();
  const [base] = await new Promise((resolve) => {
    const request = db
      .transaction("bookmarks")
      .objectStore("bookmarks")
      .getAll();
    request.onsuccess = () => resolve(request.result);
  });
  // Photo-like 480x270 captures at the player's JPEG quality, each
  // distinct, so every one is a separate decode.
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 270;
  const g = canvas.getContext("2d");
  const thumbs = [];
  for (let n = 0; n < count; n += 1) {
    g.fillStyle = `hsl(${(n * 37) % 360}, 50%, 40%)`;
    g.fillRect(0, 0, 480, 270);
    for (let k = 0; k < 30; k += 1) {
      g.fillStyle = `hsla(${(n * 11 + k * 53) % 360}, 60%, 60%, 0.5)`;
      g.fillRect((k * 97) % 480, (k * 61) % 270, 40 + (k % 5) * 12, 30);
    }
    g.fillStyle = "#fff";
    g.font = "24px sans-serif";
    g.fillText(`bookmark ${n}`, 20, 240);
    thumbs.push(canvas.toDataURL("image/jpeg", 0.8));
  }
  // A long read's context: thousands of seen ids.
  const visited = [...base.ctx.visited];
  for (let k = 0; k < 5000; k += 1) visited.push(`seen-${k}-padding-id`);
  const tx = db.transaction("bookmarks", "readwrite");
  const store = tx.objectStore("bookmarks");
  store.clear();
  for (let n = 0; n < count; n += 1) {
    const { seq: _seq, ...row } = base;
    store.add({
      ...row,
      id: `seeded-${n}`,
      timestampMs: base.timestampMs - (count - n) * 60000,
      ctx: { ...base.ctx, visited },
      thumbDataUrl: thumbs[n],
    });
  }
  await new Promise((resolve) => {
    tx.oncomplete = resolve;
  });
  db.close();
  return { itemId: base.itemId, thumbBytes: thumbs[0].length };
};

// Page side: time from the `t` keydown to the panel showing in a frame,
// to its cards, and to every card's captured picture.
const ARM_SPEED_CLOCK = () => {
  window.__bmSpeed = { t0: null };
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "t" || window.__bmSpeed.t0 !== null) return;
      const clock = window.__bmSpeed;
      clock.t0 = performance.now();
      const tick = () => {
        const now = performance.now() - clock.t0;
        const panel = document.getElementById("bookmarks");
        if (clock.visibleMs === undefined && panel && !panel.hidden) {
          clock.visibleMs = now;
        }
        const cards = document.querySelectorAll(".bookmark-entry");
        if (clock.rowsMs === undefined && cards.length > 0) clock.rowsMs = now;
        const loaded = [...cards].filter((card) => {
          const img = card.querySelector("img.bookmark-thumb");
          return (
            img?.complete === true &&
            img.naturalWidth > 0 &&
            img.getAttribute("src").startsWith("data:image/jpeg")
          );
        }).length;
        if (cards.length > 0 && loaded === cards.length) {
          clock.allThumbsMs = now;
          return;
        }
        if (now < 20000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    true,
  );
};

async function bookmarkSpeed({ check, open }) {
  const { page, cdp } = await open("bookmark-speed", { closeHelp: true });
  await leaveFullscreen(page, cdp);
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await spaceTo(page, cdp, "chain-still-3");
  await pressB(cdp);
  for (let tries = 0; tries < 40; tries += 1) {
    if ((await readBookmarks(page)).length === 1) break;
    await sleep(50);
  }
  const seeded = await page.evaluate(SEED_OLD_ROWS, SPEED_ROWS);
  // A fresh page load over the old rows; the list is opened at once,
  // before anything could have read them ahead.
  await page.reload();
  await waitFor(
    page,
    () =>
      (document.getElementById("visual-image")?.getAttribute("src") ?? "") !==
        "" || document.getElementById("visual-video") !== null,
  );
  const timeOpen = async () => {
    await page.evaluate(ARM_SPEED_CLOCK);
    await pressT(cdp);
    const filled = await waitFor(
      page,
      () => window.__bmSpeed.allThumbsMs !== undefined,
      15000,
    );
    const clock = await page.evaluate(() => window.__bmSpeed);
    const list = await page.evaluate(READ_BOOKMARK_OVERLAY);
    await pressT(cdp);
    await waitFor(page, OVERLAY_CLOSED);
    return { filled, clock, list };
  };
  const cold = await timeOpen();
  const warm = await timeOpen();
  const rowsOk = (list) =>
    list.entries?.length === SPEED_ROWS &&
    list.entries.every(
      (e) => e.thumbResolved && e.thumbSrcHead.startsWith("data:image/jpeg"),
    ) &&
    list.entries.every((e, i, all) => i === 0 || all[i - 1].time <= e.time) &&
    list.scrollTop >= list.scrollHeight - list.clientHeight - 1;
  const ms = ({ clock }) => ({
    visible: Math.round(clock.visibleMs ?? -1),
    rows: Math.round(clock.rowsMs ?? -1),
    allThumbs: Math.round(clock.allThumbsMs ?? -1),
  });
  check(
    `with ${SPEED_ROWS} bookmarks in the old stored format, t shows the panel within ${SPEED_VISIBLE_MS} ms and every captured thumbnail fills in, oldest first, scrolled to the newest — the first open and a second`,
    cold.filled &&
      warm.filled &&
      cold.clock.visibleMs <= SPEED_VISIBLE_MS &&
      warm.clock.visibleMs <= SPEED_VISIBLE_MS &&
      rowsOk(cold.list) &&
      rowsOk(warm.list),
    { seeded, cold: ms(cold), warm: ms(warm), rows: cold.list.entries?.length },
  );

  // The old rows still restore: from a few items back, a click lands on
  // the bookmarked item.
  await wheel(cdp, true, 3);
  const before = await currentItemId(page);
  await pressT(cdp);
  await waitFor(page, OVERLAY_OPEN);
  const list = await page.evaluate(READ_BOOKMARK_OVERLAY);
  await clickCenter(cdp, list.entries[SPEED_ROWS - 1].thumbRect);
  const closed = await waitFor(page, OVERLAY_CLOSED);
  const landed = await waitForItem(page, seeded.itemId, 3000);
  check(
    "a card from those old rows still continues from its item",
    before !== seeded.itemId && closed && landed,
    { before, closed, landed, want: seeded.itemId },
  );
  const visibleNow = await page.evaluate(OVERLAY_VISIBLE);
  if (visibleNow) await pressT(cdp);
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
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
  const stored = await readBookmarks(page);
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

  // Read on to chain-still-3, walk back onto the bare chain-still, reload:
  // the position persists, so the page comes back on the walked-to screen,
  // and `e` returns to the furthest point read (docs/plan.md Phase 27).
  await spaceTo(page, cdp, "chain-still-3");
  const readSig = await page.evaluate(PAINT_SIG);
  await wheel(cdp, true, 2);
  const scrubbedTo = await currentItemId(page);
  const scrubSig = await page.evaluate(PAINT_SIG);
  await sleep(300);
  await page.reload();
  await sleep(700);
  const after = await page.evaluate(PAGE_STATE);
  const sigResumed = await page.evaluate(PAINT_SIG);
  await sleep(1800); // past every floor hold: a manual resume holds still
  const sigHeld = await page.evaluate(PAINT_SIG);
  await pressE(cdp);
  await sleep(300);
  const endSig = await page.evaluate(PAINT_SIG);

  // Not the seen edge either: the bookmark row lands on text-narration
  // while 0..11 stay seen; a reload resumes there.
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
    "reload resumes on the screen it left (a walked-back one too; e then returns to the furthest read), and on a bookmark landing; the seen help stays closed",
    scrubbedTo === "chain-still" &&
      sigResumed === scrubSig &&
      sigHeld === scrubSig &&
      endSig === readSig &&
      after.helpOpen === false &&
      after.stageHidden === false &&
      restored === target.id &&
      resumedBehind === target.id,
    {
      scrubbedTo,
      scrubSig,
      readSig,
      sigResumed,
      sigHeld,
      endSig,
      help: after.helpOpen,
      restored,
      resumedBehind,
    },
  );
}

// Old steps 27-28: the settings (on the Esc screen since Phase 26), live
// settings, persistence.
async function config({ check, open }) {
  const { page, cdp } = await open("config", { closeHelp: true });
  await spaceTo(page, cdp, "text-narration");

  // `c` is no key (Phase 26): behind the story it opens nothing.
  await pressC(cdp);
  await sleep(150);
  const cInert = !(await configOpen(page)) && !(await helpOpen(page));
  const opened = await openSettings(page, cdp);
  const first = await page.evaluate(READ_CONFIG_OVERLAY);
  check(
    "c opens nothing; Escape opens the Esc screen with the settings showing the defaults",
    cInert &&
      opened &&
      (await helpOpen(page)) &&
      first.belowKeys === true &&
      first.title === "Settings" &&
      first.speedValue === SPEED_1X &&
      first.skipPressed === "false" &&
      first.skipLabel === "Off" &&
      // Play all routes is on by default (docs/plan.md Phase 24).
      first.playPressed === "true" &&
      first.playLabel === "On",
    first,
  );

  // The skip settings read as options of how Tab skips, not switches that
  // start a skip: indented under their own heading, every control in one
  // column (Phase 19, "Settings screen clarity").
  const [outerLeft, optionLeft] = [first.labelLefts[0], first.labelLefts[1]];
  check(
    "the config screen groups the skip options under When Tab skips and export, import, reset under Progress, indented, controls in one column, with a note on play all routes",
    JSON.stringify(first.lines) ===
      JSON.stringify([
        "Auto-forward speed",
        "# When Tab skips",
        "  Skip unseen content too",
        "  Play videos in full",
        "Play all routes",
        "# Progress",
        "  ~ saved in this browser automatically; export or import only to switch browser",
        "  Export progress",
        "  Import progress",
        "  Reset progress",
      ]) &&
      optionLeft > outerLeft &&
      first.labelLefts[2] === optionLeft &&
      first.labelLefts[3] === outerLeft &&
      new Set(first.controlLefts).size === 1 &&
      first.playNote === "when on, choices pick themselves after a countdown" &&
      first.hint === HELP_HINT,
    first,
  );

  // The Progress note (Phase 22): one line, indented with the options,
  // between the heading and Export.
  const noteRect = first.progressNoteRect;
  check(
    "the Progress note sits on one line under its heading, aligned with the Progress options, above Export",
    noteRect !== null &&
      noteRect.bottom - noteRect.top < 2 * first.progressNoteFontPx &&
      Math.round(noteRect.left) === first.labelLefts[4] &&
      noteRect.bottom <= first.exportRect.top,
    { noteRect, fontPx: first.progressNoteFontPx, lefts: first.labelLefts },
  );

  // The speed row is named for auto-forward (Phase 24), and a note under
  // it says it also times play-all's choice countdown: one line, indented
  // with the options, between the speed row and the When Tab skips heading.
  const speedNote = first.speedNoteRect;
  check(
    "the speed row reads Auto-forward speed with a one-line note under it, indented with the options",
    first.lines[0] === "Auto-forward speed" &&
      first.speedNote === "also times play-all's choice countdown" &&
      speedNote !== null &&
      speedNote.bottom - speedNote.top < 2 * first.speedNoteFontPx &&
      Math.round(speedNote.left) === first.labelLefts[1] &&
      speedNote.top >= first.speedValueRect.bottom &&
      speedNote.bottom <= first.skipHeadingRect.top &&
      first.speedValueRect.bottom - first.speedValueRect.top <
        2 * first.speedNoteFontPx &&
      speedNote.right <= first.viewportWidth,
    {
      speedNote,
      fontPx: first.speedNoteFontPx,
      value: first.speedValueRect,
      heading: first.skipHeadingRect,
      lefts: first.labelLefts,
      vw: first.viewportWidth,
    },
  );

  // (Space is the screen's closing key, checked in helpMidFlow.)
  const sigBefore = await page.evaluate(SIGNATURE);
  await pressTab(cdp);
  await pressE(cdp);
  await wheelNotch(cdp, true);
  await sleep(WHEEL_GAP_MS);
  const sigAfter = await page.evaluate(SIGNATURE);
  check(
    "while the settings are open the timeline is suspended: tab, e and the wheel move nothing",
    sigAfter === sigBefore && (await configOpen(page)),
    { sigBefore, sigAfter },
  );

  await clickCenter(cdp, CONFIG_CONTROL.skip);
  await clickCenter(cdp, CONFIG_CONTROL.play);
  const toggled = await page.evaluate(READ_CONFIG_OVERLAY);
  // A click outside the controls (backdrop) leaves it open (Phase 24);
  // only Escape or Space close it.
  await clickCenter(cdp, CONFIG_CONTROL.title);
  await clickAt(cdp, 10, 10);
  await sleep(150);
  const openAfterBackdrop = await configOpen(page);
  const afterBackdrop = await page.evaluate(READ_CONFIG_OVERLAY);
  const closedByFirstC = await closeSettings(page, cdp);
  await openSettings(page, cdp);
  const again = await page.evaluate(READ_CONFIG_OVERLAY);
  // Play-all flips both ways, then stays Off: the reload below proves a
  // saved Off outlives the On default.
  await clickCenter(cdp, CONFIG_CONTROL.play);
  const playOn = await page.evaluate(READ_CONFIG_OVERLAY);
  await clickCenter(cdp, CONFIG_CONTROL.play);
  const playOff = await page.evaluate(READ_CONFIG_OVERLAY);
  const closedByC = await closeSettings(page, cdp);
  check(
    "the switches flip skip-all on and play-all off; a backdrop click leaves it open and changes nothing, Escape closes and reopens with them so, play-all flips back and forth, Escape closes",
    toggled.skipPressed === "true" &&
      toggled.skipLabel === "On" &&
      toggled.playPressed === "false" &&
      toggled.playLabel === "Off" &&
      openAfterBackdrop &&
      afterBackdrop.skipPressed === "true" &&
      afterBackdrop.playPressed === "false" &&
      closedByFirstC &&
      again.skipPressed === "true" &&
      again.playPressed === "false" &&
      playOn.playPressed === "true" &&
      playOn.playLabel === "On" &&
      playOff.playPressed === "false" &&
      closedByC,
    {
      toggled,
      openAfterBackdrop,
      closedByFirstC,
      again,
      playOn: playOn.playPressed,
      playOff: playOff.playPressed,
      closedByC,
    },
  );

  // Four + clicks: 1.00x -> 2.00x, shown live in the open panel.
  await openSettings(page, cdp);
  for (let i = 0; i < 4; i += 1) {
    await clickCenter(cdp, CONFIG_CONTROL.speedUp);
  }
  const fast = await page.evaluate(READ_CONFIG_OVERLAY);
  // The page went fullscreen on the first gesture: Chrome keeps the first
  // Escape, so the panel stays open and the second Escape closes it.
  // Headless Chrome may instead hand that Escape to the page (it drops
  // fullscreen on its own), which closes the panel at once: PARTIAL, the
  // keeping was not observable.
  const wasFullscreen = (await page.evaluate(PAGE_STATE)).fullscreenElement;
  const kept = !(await pressEscapeSeen(page, cdp));
  const afterFirstEsc = await configOpen(page);
  const windowed = await page
    .waitForFunction(() => document.fullscreenElement === null, {
      timeout: 5000,
    })
    .then(
      () => true,
      () => false,
    );
  const closed = await closeSettings(page, cdp);
  check(
    "four + clicks show 2.00x; Escape closes config (the first one leaves fullscreen when fullscreen)",
    fast.speedValue === SPEED_2X &&
      fast.skipPressed === "true" &&
      windowed &&
      closed &&
      (wasFullscreen !== null && kept ? afterFirstEsc === true : "PARTIAL"),
    {
      speed: fast.speedValue,
      wasFullscreen,
      kept,
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
  await openSettings(page, cdp);
  const persisted = await page.evaluate(READ_CONFIG_OVERLAY);
  check(
    "2.00x, skip-all on and play-all off survive a reload, which resumes on the same item",
    sigResumed === sig &&
      persisted.speedValue === SPEED_2X &&
      persisted.skipPressed === "true" &&
      persisted.playPressed === "false",
    { sig, sigResumed, persisted },
  );
}

// Phase 18, "Settings survive an immediate reload": a speed change then a
// reload with NO pause (the old fire-and-forget write came back at 1.00x
// in 4 of 6 runs). Three rounds, each reloading the instant the last click
// lands, so one run samples the race three times.
async function settingsImmediateReload({ check, open }) {
  const { page, cdp } = await open("settings-reload", { closeHelp: true });
  await spaceTo(page, cdp, "text-narration");
  const rounds = [
    { clicks: 4, button: "speedUp", expect: SPEED_2X },
    { clicks: 4, button: "speedDown", expect: SPEED_1X },
    { clicks: 4, button: "speedUp", expect: SPEED_2X },
  ];
  const results = [];
  for (const round of rounds) {
    await openSettings(page, cdp);
    let shown = null;
    for (let i = 0; i < round.clicks; i += 1) {
      await clickCenter(cdp, CONFIG_CONTROL[round.button]);
    }
    shown = (await page.evaluate(READ_CONFIG_OVERLAY)).speedValue;
    const t0 = Date.now();
    await page.reload(); // no wait: the reader reloads straight away
    const reloadIssuedMs = Date.now() - t0;
    await waitFor(page, () => document.getElementById("stage") !== null);
    await sleep(300);
    await openSettings(page, cdp);
    const after = (await page.evaluate(READ_CONFIG_OVERLAY)).speedValue;
    await closeSettings(page, cdp);
    results.push({ want: round.expect, shown, after, reloadIssuedMs });
  }
  check(
    "a speed change survives a reload issued the instant after the last click (3 rounds)",
    results.every((r) => r.shown === r.want && r.after === r.want),
    results,
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
  const untitled = await page.evaluate(READ_HELP);
  check(
    "a manifest without a title: the help has no heading and the page keeps its own title",
    untitled.hidden === false &&
      untitled.game === null &&
      untitled.title === HELP_TITLE &&
      untitled.pageTitle === "Kinetic",
    { game: untitled.game, title: untitled.title, page: untitled.pageTitle },
  );
  await pressEscape(cdp);
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
  // A non-default speed and play-all off, so the reset has settings to
  // put back.
  await openSettings(page, cdp);
  for (let i = 0; i < 4; i += 1) {
    await clickCenter(cdp, CONFIG_CONTROL.speedUp);
  }
  await clickCenter(cdp, CONFIG_CONTROL.play);
  const cfg = await page.evaluate(READ_CONFIG_OVERLAY);
  await clickCenter(cdp, CONFIG_CONTROL.reset);
  const box = await page.evaluate(READ_CONFIRM_OVERLAY);
  // The box blocks the screen's keys (Phase 26): Space does nothing under
  // it, and Escape cancels the box alone, leaving the Esc screen up.
  await pressSpace(cdp);
  await sleep(150);
  const underSpace = {
    box: await page.evaluate(CONFIRM_OPEN),
    screen: await configOpen(page),
  };
  await pressEscape(cdp);
  await sleep(150);
  const underEscape = {
    box: await page.evaluate(CONFIRM_OPEN),
    screen: await configOpen(page),
  };
  check(
    "the reset box blocks the Esc screen's keys: Space does nothing, Escape cancels the box alone",
    underSpace.box === true &&
      underSpace.screen === true &&
      underEscape.box === false &&
      underEscape.screen === true,
    { underSpace, underEscape },
  );
  await clickCenter(cdp, CONFIG_CONTROL.reset);
  await waitFor(page, CONFIRM_OPEN);
  await clickCenter(cdp, CONFIRM_CONTROL.cancel);
  const boxClosed = (await page.evaluate(CONFIRM_OPEN)) === false;
  check(
    "the Reset progress row opens a confirm box; Cancel closes it",
    walked &&
      flashed &&
      cfg.speedValue === SPEED_2X &&
      cfg.playPressed === "false" &&
      box.hidden === false &&
      box.title === "Reset progress" &&
      box.resetLabel === "Reset" &&
      box.cancelLabel === "Cancel" &&
      boxClosed,
    { walked, flashed, speed: cfg.speedValue, box, boxClosed },
  );

  // Cancel kept everything: a reload resumes there with the row and speed.
  // No pause before it: settings writes survive an immediate reload
  // (Phase 18; settingsImmediateReload samples that race directly).
  await page.reload();
  await sleep(700);
  const resumed = await page.evaluate(PAGE_STATE);
  const resumedId = await currentItemId(page);
  await pressT(cdp);
  await waitFor(page, OVERLAY_OPEN);
  const kept = await page.evaluate(READ_BOOKMARK_OVERLAY);
  await pressT(cdp);
  await openSettings(page, cdp);
  const keptCfg = await page.evaluate(READ_CONFIG_OVERLAY);
  check(
    "cancel kept everything: the reload resumes on the item, the row, 2.00x and play-all off are still there",
    resumedId === target.id &&
      resumed.helpOpen === false &&
      (kept.entries ?? []).length === 1 &&
      kept.entries[0].itemIndex === target.index &&
      keptCfg.speedValue === SPEED_2X &&
      keptCfg.playPressed === "false",
    {
      resumedId,
      help: resumed.helpOpen,
      rows: (kept.entries ?? []).map((e) => e.itemIndex),
      speed: keptCfg.speedValue,
      play: keptCfg.playPressed,
    },
  );

  // Confirm: the app's own wipe + reload is a first-ever boot.
  await clickCenter(cdp, CONFIG_CONTROL.reset);
  await waitFor(page, CONFIRM_OPEN);
  const box2 = await page.evaluate(READ_CONFIRM_OVERLAY);
  await clickCenter(cdp, CONFIRM_CONTROL.confirm);
  const bootHelp = await waitFor(page, HELP_OPEN, 6000);
  await sleep(400);
  const boot = await page.evaluate(PAGE_STATE);
  const bootId = await currentItemId(page);
  await pressEscape(cdp);
  await waitFor(page, HELP_CLOSED);
  await pressT(cdp);
  await waitFor(page, OVERLAY_OPEN);
  const list = await page.evaluate(READ_BOOKMARK_OVERLAY);
  await pressT(cdp);
  await openSettings(page, cdp);
  const fresh = await page.evaluate(READ_CONFIG_OVERLAY);
  await closeSettings(page, cdp);
  check(
    "confirming is a true first-ever boot: help up, first item, empty list, 1.00x, skip-all off and play-all back on",
    box2.hidden === false &&
      bootHelp &&
      boot.helpOpen === true &&
      boot.stageHidden === true &&
      bootId === item("intro-title").id &&
      (list.entries ?? []).length === 0 &&
      list.emptyText === EMPTY_MESSAGE &&
      fresh.speedValue === SPEED_1X &&
      fresh.skipPressed === "false" &&
      fresh.playPressed === "true",
    {
      bootHelp,
      bootId,
      stage: boot.stageHidden,
      emptyText: list.emptyText,
      speed: fresh.speedValue,
      play: fresh.playPressed,
    },
  );
}

// The reading-state record as IndexedDB holds it (src/storage/idb.ts).
const READ_STATE = async () => {
  // The player's storage key (src/storage/idb.ts storageKeys): the
  // manifest's story ID when it has a valid one, else the folder URL.
  const story = window.KINETIC_MANIFEST?.storyId;
  const content =
    typeof story === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(story)
      ? `story:${story}`
      : new URL(".", document.baseURI).href;
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open("kinetic", 1);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const req = db
        .transaction("state", "readonly")
        .objectStore("state")
        .get(content);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
};

// Phase 18, "Saves keyed by id, not position": read part of the demo,
// bookmark, then UPDATE the folder's content in place — two prequel items
// inserted before everything and `text-bare` deleted, so every later item
// moves — and reload. The save names items by id, so the resume, the
// bookmark and the seen set still point at the same content.
async function contentUpdate({ check, open }) {
  // A private copy of the demo: the update rewrites its manifest, and the
  // save is keyed by its story ID, so the copy is reloaded in place.
  const folder = join(dirname(demoDir), "demo-update");
  rmSync(folder, { recursive: true, force: true });
  cpSync(demoDir, folder, { recursive: true });
  const { page, cdp } = await open("update", { closeHelp: true, folder });
  await leaveFullscreen(page, cdp);

  const walked1 = await spaceTo(page, cdp, "video-chain-3");
  await pressB(cdp);
  const flashed = await waitFor(page, FLASH_SHOWN);
  const walked2 = await spaceTo(page, cdp, "chain-still-3");
  await sleep(300);
  const record = await page.evaluate(READ_STATE);
  check(
    "the save names items by id, not position",
    walked1 &&
      flashed &&
      walked2 &&
      record?.ctx?.lastShown === "chain-still-3" &&
      Array.isArray(record?.ctx?.visited) &&
      record.ctx.visited.includes("intro-title") &&
      record.ctx.visited.every((id) => typeof id === "string") &&
      !("frontier" in (record ?? {})),
    {
      walked1,
      flashed,
      walked2,
      ctx: record?.ctx,
    },
  );

  // The content update: prequel items reusing the demo's own media files.
  const updated = JSON.parse(
    readFileSync(join(folder, "manifest.json"), "utf8"),
  );
  const prequel = [
    {
      id: "prequel-1",
      type: "image",
      file: "branch-title.jpg",
      text: "Prequel one: a content update added this before the story.",
    },
    {
      id: "prequel-2",
      type: "image",
      file: "after-start.jpg",
      text: "Prequel two: everything after it moved two places on.",
    },
  ];
  updated.items = [
    ...prequel,
    ...updated.items.filter((it) => it.id !== "text-bare"),
  ];
  const json = JSON.stringify(updated, null, 2);
  writeFileSync(join(folder, "manifest.json"), `${json}\n`);
  writeFileSync(
    join(folder, "manifest.js"),
    `window.KINETIC_MANIFEST = ${json};\n`,
  );
  const newIndex = (id) => updated.items.findIndex((it) => it.id === id);

  await page.reload();
  await waitFor(
    page,
    () =>
      (document.getElementById("visual-image")?.getAttribute("src") ?? "") !==
      "",
  );
  await sleep(500);
  const resumedId = await currentItemId(page);
  const resumed = await page.evaluate(PAGE_STATE);
  check(
    "after the update a reload resumes on the same item (chain-still-3, moved from 11 to 12), help closed",
    resumedId === "chain-still-3" && resumed.helpOpen === false,
    { resumedId, help: resumed.helpOpen, nowAt: newIndex("chain-still-3") },
  );
  const READ_NOTICE = () => {
    const n = document.getElementById("notice");
    return { shown: n !== null && !n.hidden, text: n?.textContent ?? null };
  };
  const notice = await page.evaluate(READ_NOTICE);
  check(
    "the resume shows the quiet earlier-unseen notice (the prequel is unseen)",
    notice.shown && notice.text === EARLIER_UNSEEN_NOTICE,
    notice,
  );

  // The seen set moved with the ids: rolled back three screens, Tab runs
  // through the seen items and stops ON chain-still-3, the last seen one —
  // not a place early (where the old positions would end) and never into
  // video-loops.
  await wheel(cdp, true, 3);
  const rolledTo = await currentItemId(page);
  await pressTab(cdp);
  const seenIds = new Set();
  for (let t = 0; t < 30; t += 1) {
    await sleep(50);
    seenIds.add(await currentItemId(page));
  }
  await sleep(500);
  const stopId = await currentItemId(page);
  check(
    "the seen set followed the ids: Tab skip stops on chain-still-3, the last seen item",
    rolledTo === "video-chain-3" &&
      stopId === "chain-still-3" &&
      !seenIds.has("video-loops"),
    { rolledTo, stopId, passed: [...seenIds] },
  );

  await pressT(cdp);
  const listOpen = await waitFor(page, OVERLAY_OPEN);
  const list = await page.evaluate(READ_BOOKMARK_OVERLAY);
  const rows = list.entries ?? [];
  if (rows.length > 0) await rowCenterClick(cdp, rows[0]);
  await waitFor(page, OVERLAY_CLOSED);
  await sleep(300);
  const restoredId = await currentItemId(page);
  check(
    "the bookmark still names video-chain-3 at its new place, and its row restores there",
    listOpen &&
      rows.length === 1 &&
      rows[0].itemIndex === newIndex("video-chain-3") &&
      rows[0].label.includes("video-chain-3") &&
      restoredId === "video-chain-3",
    {
      rows: rows.map((r) => [r.itemIndex, r.label]),
      expected: newIndex("video-chain-3"),
      restoredId,
    },
  );

  // `u` from the reading position goes back to the unseen prequel (the
  // story's own continuation is Space's), and reading on joins the story.
  const noticeGone = !(await page.evaluate(READ_NOTICE)).shown;
  await spaceTo(page, cdp, "chain-still-3");
  // The prequel ids are not in the harness's demo manifest: match by text.
  const prequelId = async () => {
    const text = (await page.evaluate(PAGE_STATE)).text;
    return prequel.find((it) => it.text === text)?.id ?? null;
  };
  await pressU(cdp);
  await sleep(300);
  const uId = await prequelId();
  await pressSpace(cdp);
  await sleep(200);
  const next1 = await prequelId();
  await pressSpace(cdp);
  await sleep(200);
  const next2 = await currentItemId(page);
  check(
    "u from chain-still-3 lands on the unseen prequel-1; Space reads prequel-2 then the old start (the notice went at the first key)",
    noticeGone &&
      uId === "prequel-1" &&
      next1 === "prequel-2" &&
      next2 === updated.items[2].id,
    { noticeGone, uId, next1, next2 },
  );
}

export default async function (ctx) {
  for (const part of [
    helpFirstLoadClick,
    helpMidFlow,
    escToBookmarks,
    bookmarks,
    bookmarkGrid,
    bookmarkSpeed,
    resume,
    config,
    settingsImmediateReload,
    emptyFolder,
    reset,
    contentUpdate,
  ]) {
    try {
      await part(ctx);
    } catch (error) {
      ctx.check(`${part.name} completed`, false, String(error?.stack ?? error));
    }
  }
}
