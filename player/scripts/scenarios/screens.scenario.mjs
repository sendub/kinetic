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
  HELP_CLOSED,
  HELP_OPEN,
  helpOpen,
  item,
  manifest,
  OVERLAY_CLOSED,
  OVERLAY_OPEN,
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
// simplified"): no Enter, no reset-box keys.
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
  "Esc",
  "1-9 / 0",
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
  // shown with it. `t` opens nothing behind it, and `c` is no key: it
  // changes nothing, on the screen or (below) behind it.
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
  await pressT(cdp);
  await sleep(150);
  const afterT = {
    help: await helpOpen(page),
    config: await configOpen(page),
    list: await panelOpen(page),
  };
  await pressC(cdp);
  await sleep(150);
  const afterC = {
    help: await helpOpen(page),
    config: await configOpen(page),
    list: await panelOpen(page),
    text: (await page.evaluate(PAGE_STATE)).text,
  };
  check(
    "t opens nothing behind the Esc screen, and c changes nothing on it",
    afterT.help === true &&
      afterT.config === true &&
      afterT.list === false &&
      afterC.help === true &&
      afterC.config === true &&
      afterC.list === false &&
      afterC.text === item("text-speech").text,
    { afterT, afterC },
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
    bookmarks,
    bookmarkGrid,
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
