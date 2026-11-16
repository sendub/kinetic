// The screens over the stage (old driver steps 20, 22-28, 31, 42, 47): the
// mid-flow key help, bookmarks (`b`, their cards on the branch map — `m`,
// docs/plan.md Phase 35, which retired the `t` list — restore from a card,
// delete with its ×), reload resume, the settings on the Esc screen and
// their persistence (including a reload the instant after a change), the
// empty-manifest folder, "Reset progress", and a save surviving a content
// update (a prequel inserted before everything, an item deleted). Each
// part opens its own fresh profile, so no part leans on another's storage.

import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_SETTINGS } from "../../src/machine/types.ts";
import { BROWSER_WORDING } from "../../src/render/wording.ts";
import {
  audioDemoDir,
  CONFIG_CLOSED,
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
  INSTALL_PILL_LOG,
  item,
  MAP_CARDS_LOADED,
  MAP_CLOSED,
  MAP_OPEN,
  MAP_READY,
  manifest,
  mapOpen,
  onWebKit,
  openSettings,
  PAGE_STATE,
  PAINT_SIG,
  pressA,
  pressB,
  pressC,
  pressE,
  pressEnter,
  pressEscape,
  pressEscapeSeen,
  pressKey,
  pressM,
  pressNavKey,
  pressSpace,
  pressT,
  pressTab,
  pressU,
  READ_CONFIG_OVERLAY,
  READ_CONFIG_RECTS,
  READ_CONFIRM_OVERLAY,
  READ_HELP,
  READ_KEY_GRID,
  READ_MAP_CARDS,
  READ_MAP_VIEW,
  readBookmarks,
  readPills,
  readSignature,
  SIGNATURE,
  sampleSignatures,
  sleep,
  soundFolder,
  spaceTo,
  transitions,
  WHEEL_GAP_MS,
  wheel,
  wheelNotch,
} from "./harness.mjs";

export const title =
  "help, bookmarks on the map, resume, config, empty folder, reset";

// Player UI strings. render/help.ts imports modules by extensionless paths
// node cannot resolve, so these two are restated. The speed readout is
// written out as the reader sees it (Phase 43 item 12: the per-character
// figure in parentheses), not taken from config.ts, so a change to its
// format fails here too.
const HELP_TITLE = "Keys";
const HELP_HINT = "Esc or Space closes";
// The main interaction keys, one row each (Phase 18, "Key help
// simplified"): no reset-box keys; Enter only with a decision's arrows.
// No T row: the bookmarks are on the branch map (Phase 35). Left and
// Right, a video's views (Phase 49), are one row of two caps after Space.
const HELP_KEYS = [
  "Space",
  "← →",
  "wheel",
  "E",
  "U",
  "Tab",
  "A",
  "H",
  "B",
  "M",
  "Esc",
  "1-9 0 ↑↓ Enter",
];
// A game with sound (docs/plan.md Phase 47 item 7) adds V, "sound on /
// off", with the other mode keys.
const HELP_KEYS_SOUND = [
  ...HELP_KEYS.slice(0, HELP_KEYS.indexOf("H") + 1),
  "V",
  ...HELP_KEYS.slice(HELP_KEYS.indexOf("H") + 1),
];
// The settings' lines (READ_CONFIG_OVERLAY `lines`): a game with sound
// has a Sound row under Play all routes, in its group.
const CONFIG_LINES = [
  "Auto-forward speed",
  "# When Tab skips",
  "  Skip unseen content too",
  "  Play videos in full",
  "Play all routes",
  "# Progress · saved automatically",
  "  Export progress",
  "  Import progress",
  "  Reset progress",
  "# Game window",
  "  Display",
  "  Exit the game",
];
const CONFIG_LINES_SOUND = [
  ...CONFIG_LINES.slice(0, CONFIG_LINES.indexOf("Play all routes") + 1),
  "Sound",
  ...CONFIG_LINES.slice(CONFIG_LINES.indexOf("Play all routes") + 1),
];
// fixtures/audio-demo is built, not committed (.gitignore).
const AUDIO_BUILD_HINT =
  "fixtures/audio-demo is missing: build it with .venv/bin/python fixtures/build_audio_demo.py";
/** False, with the build hint as evidence, when the audio demo is missing. */
function audioBuilt({ check, folders }) {
  if (folders.audioDemo) return true;
  check("fixtures/audio-demo is built", false, AUDIO_BUILD_HINT);
  return false;
}
const EMPTY_NOTICE = "No content yet — this folder has an empty manifest.";
const MS_PER_CHAR = DEFAULT_SETTINGS.msPerChar;
const MIN_HOLD = DEFAULT_SETTINGS.minHoldMs;
const SPEED_1X = "1.00x (~60 ms/char)";
const SPEED_2X = "2.00x (~30 ms/char)";
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

// The bookmarks live on the branch map (docs/plan.md Phase 35: one card
// per bookmark on the story line; the `t` list is gone). `m` opens it;
// the cards are read once placed, or with `loaded` once every card's
// picture is in too.
async function openMap(page, cdp, { loaded = false } = {}) {
  await pressM(cdp);
  const ready = await waitFor(page, loaded ? MAP_CARDS_LOADED : MAP_READY);
  return { ready, map: await page.evaluate(READ_MAP_CARDS) };
}

/** `m` again closes the map; true once it is down. */
async function closeMap(page, cdp) {
  if (!(await mapOpen(page))) return true;
  await pressM(cdp);
  return waitFor(page, MAP_CLOSED);
}

// A reader's pick: a press and release on the card without moving (a drag
// would pan the map instead).
const clickCard = (cdp, card) => clickCenter(cdp, card.rect);

const centreOf = (r) => [
  Math.round((r.left + r.right) / 2),
  Math.round((r.top + r.bottom) / 2),
];
const mouseTo = (cdp, [x, y]) =>
  cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });

// A card's × shows only while the pointer is over the card (index.html
// `.bm-card:hover .bm-del`), so the pointer moves onto the card, then onto
// the ×, and clicks it there.
async function clickCardDelete(cdp, card) {
  await mouseTo(cdp, centreOf(card.rect));
  await sleep(60);
  await mouseTo(cdp, centreOf(card.deleteRect));
  await sleep(60);
  const [x, y] = centreOf(card.deleteRect);
  await clickAt(cdp, x, y);
}

/** The map's F: switches between Full size and Fit (the whole tree). */
const pressF = (cdp) => pressKey(cdp, "f", "KeyF", 70, "f");

/**
 * A short Escape while fullscreen (docs/plan.md Phase 43): the player locks
 * Escape once fullscreen (Keyboard Lock, Chromium), so the key reaches the
 * page, which opens the Esc screen, and fullscreen stays; holding Escape is
 * what leaves. One more Escape closes the screen again. Returns what
 * happened; `wasFullscreen: false` means the page was windowed (WebKit,
 * whose web view has element fullscreen off).
 */
async function escapeInFullscreen(page, cdp) {
  const before = await page.evaluate(PAGE_STATE);
  if (before.fullscreenElement === null) {
    return { wasFullscreen: false, ok: true };
  }
  const seen = await pressEscapeSeen(page, cdp);
  const opened = seen && (await waitFor(page, HELP_OPEN, 2000));
  const stayed = (await page.evaluate(PAGE_STATE)).fullscreenElement !== null;
  const closed = await escapeUntil(page, cdp, HELP_CLOSED);
  return { wasFullscreen: true, seen, opened, stayed, ok: closed };
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
  // Every gesture made while windowed asks again (Phase 43), so Space asks
  // a second time only if the page was no longer fullscreen when it came
  // (as in WebKit, whose web view has element fullscreen off).
  const space = closed.firstKeys.find((k) => k.key === " ");
  check(
    "first load: Space then closes the help without advancing; it asks for fullscreen again only if the page was not fullscreen",
    closed.helpOpen === false &&
      closed.stageHidden === false &&
      closed.text === start.text &&
      space !== undefined &&
      closed.fsAttempts === (space.fullscreen ? 1 : 2),
    closed,
  );
}

// Old step 20: Escape opens the key help mid-flow.
async function helpMidFlow({ check, open }) {
  const { page, cdp } = await open("help", { closeHelp: true });
  // Escape closed the first-load help and never asks for fullscreen; `c`
  // (no key) is a gesture that does. The lock follows the request.
  await pressC(cdp);
  await waitFor(page, () => document.fullscreenElement !== null, 2000);
  await sleep(150);
  const fs = await escapeInFullscreen(page, cdp);
  check(
    "a short Escape while fullscreen reaches the game (Keyboard Lock): it opens the Esc screen and fullscreen stays",
    fs.wasFullscreen ? fs.seen && fs.opened && fs.stayed && fs.ok : "PARTIAL",
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
    "Escape opens the help mid-flow: a black screen over the same item",
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
    "the help lists only the main keys, one row each (no c), and its hint reads Esc or Space closes",
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

  // The Esc screen holds the settings too (Phase 26), shown with the keys:
  // since Phase 40 beside them from 700px wide (the keys one per row in a
  // sidebar), so the whole screen fits a short window, and under them on
  // a narrower one, where the keys fill across before going down. `c` is
  // no key: it changes nothing, on the screen or (below) behind it. (A
  // click on the M row swaps the screen for the branch map: escToMap.)
  const onScreen = await page.evaluate(READ_CONFIG_OVERLAY);
  const grid = await page.evaluate(READ_KEY_GRID);
  const wide = page.viewport();
  await page.setViewport({ width: 600, height: 900, deviceScaleFactor: 1 });
  await sleep(150);
  const narrowSettings = await page.evaluate(READ_CONFIG_OVERLAY);
  const narrowGrid = await page.evaluate(READ_KEY_GRID);
  if (wide !== null) await page.setViewport(wide);
  await sleep(150);
  check(
    "the Esc screen shows the settings beside the keys from 700px wide (one key per row) and under them at 600px, where the keys fill across before going down",
    onScreen.hidden === false &&
      (wide?.width ?? 0) >= 700 &&
      onScreen.besideKeys === true &&
      grid.columns === 1 &&
      grid.scrollWidth <= grid.clientWidth &&
      narrowSettings.belowKeys === true &&
      narrowGrid.columns >= 2 &&
      narrowGrid.acrossFirst === true &&
      narrowGrid.scrollWidth <= narrowGrid.clientWidth,
    {
      wide,
      besideKeys: onScreen.besideKeys,
      grid,
      belowKeys: narrowSettings.belowKeys,
      narrowGrid,
    },
  );
  await pressC(cdp);
  await sleep(150);
  const afterC = {
    help: await helpOpen(page),
    config: await configOpen(page),
    map: await mapOpen(page),
    text: (await page.evaluate(PAGE_STATE)).text,
  };
  check(
    "c changes nothing on the Esc screen",
    afterC.help === true &&
      afterC.config === true &&
      afterC.map === false &&
      afterC.text === item("text-speech").text,
    { afterC },
  );

  // Space closes the screen even with a settings button focused (a click
  // focuses it): the keymap's Space wins, the button does not flip.
  await clickCenter(cdp, CONFIG_CONTROL.skip);
  // WebKit on macOS, like Safari, does not focus a button on click: focus
  // it as the keyboard would, so Space still meets a focused button.
  if (onWebKit)
    await page.evaluate(
      (s) => document.querySelector(s).focus(),
      CONFIG_CONTROL.skip,
    );
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

// The Esc screen hands over to the branch map: a click on the screen's M
// entry (the one clickable row; `m` over the screen does the same, a case
// branchmap.scenario owns) closes the Esc screen and opens the map in its
// place (no frame with neither up), the story staying paused, and the next
// Escape goes back to the game, as closing the Esc screen would (the menu
// pause lifts), not back to the Esc screen. A bookmark picked from that
// map lands as usual. KINETIC_ESC_M_SHOTS names a folder for a screenshot
// of the hovered M entry.
async function escToMap({ check, open }) {
  const { page, cdp } = await open("esc-m", { closeHelp: true });
  const NEITHER = () =>
    (document.getElementById("help")?.hidden ?? true) &&
    (document.getElementById("branchmap")?.hidden ?? true);
  const SCREENS = () => ({
    help: !(document.getElementById("help")?.hidden ?? true),
    map: !(document.getElementById("branchmap")?.hidden ?? true),
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
      const map = document.getElementById("branchmap");
      if ((help?.hidden ?? true) && (map?.hidden ?? true)) {
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
  const M_ROW = "#help button.help-row";

  // One bookmark, at text-speech; read on to text-thought.
  await spaceTo(page, cdp, "text-speech");
  await pressB(cdp);
  await waitFor(page, FLASH_SHOWN);
  await spaceTo(page, cdp, "text-thought");
  const at = item("text-thought").text;
  const hold = holdMs("text-thought");

  // A click on the M entry, auto-forward on: the map replaces the screen,
  // and the machine stays paused under it.
  await pressA(cdp);
  await pressEscape(cdp);
  const helpUp = await waitFor(page, HELP_OPEN, 2000);
  await page.evaluate(ARM_GAP_PROBE);
  await clickCenter(cdp, M_ROW);
  const mapUp = await waitFor(page, MAP_OPEN, 2000);
  await sleep(100);
  const gap = await readGap();
  const swapped = await page.evaluate(SCREENS);
  await sleep(hold + 300);
  const stillHere = await page.evaluate(SCREENS);
  check(
    "clicking the M entry swaps the Esc screen for the branch map (no frame with neither up), the story paused under it",
    helpUp &&
      mapUp &&
      gap === 0 &&
      swapped.help === false &&
      swapped.map === true &&
      stillHere.map === true &&
      stillHere.text === at,
    { helpUp, mapUp, gap, swapped, stillHere: stillHere.text, hold },
  );

  // Escape from that map goes back to the game, not to the Esc screen;
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
    "Escape from that map returns to the game (no Esc screen), and auto-forward resumes",
    back &&
      game.help === false &&
      game.map === false &&
      game.stageHidden === false &&
      game.text === at &&
      movedOn,
    { back, game, movedOn },
  );

  // The M entry is the screen's one control: it lights up under the
  // pointer (Phase 40: the row's fill lights and its key cap turns gold).
  await escapeUntil(page, cdp, HELP_OPEN);
  // The "Auto-forward off" pill fades first, for a clean screenshot.
  await waitFor(page, () => document.getElementById("flash") === null);
  const LOOK = (sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    const cap = el.querySelector(".help-cap");
    return {
      key: el.querySelector(".help-key")?.textContent ?? "",
      rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      cursor: getComputedStyle(el).cursor,
      fill: getComputedStyle(el).backgroundColor,
      cap: cap === null ? null : getComputedStyle(cap).backgroundColor,
      buttons: document.querySelectorAll("#help button.help-row").length,
    };
  };
  // The pointer is still where the earlier click left it, on the row:
  // off to a bare corner first, so the row is read unhovered.
  await mouseTo(cdp, [4, 4]);
  await sleep(150);
  const plain = await page.evaluate(LOOK, M_ROW);
  if (plain !== null) {
    await mouseTo(cdp, centreOf(plain.rect));
    await sleep(150);
  }
  const hovered = await page.evaluate(LOOK, M_ROW);
  const shots = process.env.KINETIC_ESC_M_SHOTS;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, "esc-m-hover.png") });
  }
  check(
    "only the M entry is clickable, and it looks it: pointer cursor, the row and its cap lit on hover",
    plain !== null &&
      hovered !== null &&
      plain.key === "M" &&
      plain.buttons === 1 &&
      plain.cursor === "pointer" &&
      hovered.fill !== plain.fill &&
      hovered.cap !== plain.cap,
    { plain, hovered },
  );

  // Picking a bookmark from the map the Esc screen opened lands on it.
  await clickCenter(cdp, M_ROW);
  await waitFor(page, MAP_READY);
  const { cards } = await page.evaluate(READ_MAP_CARDS);
  if (cards?.[0] !== undefined) await clickCard(cdp, cards[0]);
  const closed = await waitFor(page, NEITHER, 3000);
  const landed = await waitForItem(page, "text-speech", 3000);
  const final = await page.evaluate(SCREENS);
  check(
    "a bookmark's card picked on the map the M entry opened lands on its item, both screens closed",
    cards?.length === 1 &&
      cards[0].itemId === "text-speech" &&
      closed &&
      landed &&
      final.help === false &&
      final.map === false &&
      final.stageHidden === false,
    { cards: cards?.map((c) => c.itemId), closed, landed, final },
  );
}

// Old steps 22-25: bookmarks, and their cards on the branch map (docs/plan.md
// Phase 35, which retired the `t` list).
async function bookmarks({ check, open }) {
  const { page, cdp } = await open("bookmarks", { closeHelp: true });

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

  // The map opens at Full size (a fresh profile; docs/plan.md Phase 41),
  // centred on "you are here", the newer card: both cards in its view.
  const first = await openMap(page, cdp, { loaded: true });
  const firstView = await page.evaluate(READ_MAP_VIEW);
  const cards = first.map.cards ?? [];
  const view = first.map.viewRect;
  const inView = (r) =>
    view !== null &&
    r.left >= view.left - 1 &&
    r.right <= view.right + 1 &&
    r.top >= view.top - 1 &&
    r.bottom <= view.bottom + 1;
  check(
    "m opens the map at Full size with one card per bookmark in story order, in view, each showing its picture and timestamp, the newer one marked newest",
    first.ready &&
      firstView.view === "full" &&
      firstView.scale === 1 &&
      cards.length === 2 &&
      cards[0].itemIndex === older &&
      cards[1].itemIndex === newer &&
      cards.map((c) => c.id).join() === stored.map((b) => b.id).join() &&
      cards[0].newest === false &&
      cards[1].newest === true &&
      cards.every(
        (c) =>
          !c.deleted &&
          inView(c.rect) &&
          c.picResolved &&
          (c.picSrcHead?.startsWith("data:") === true ||
            /\.(?:jpg|jpeg|png|webp|gif)$/i.test(c.picSrcHead ?? "")) &&
          TIME_RE.test(c.time),
      ),
    {
      ready: first.ready,
      cards: cards.map((c) => [c.itemIndex, c.time, c.newest, c.picSrcHead]),
      rects: cards.map((c) => c.rect),
      view,
    },
  );

  const sigBefore = await readSignature(page);
  await pressSpace(cdp);
  await pressTab(cdp);
  await wheelNotch(cdp, true);
  await sleep(WHEEL_GAP_MS);
  const sigAfter = await readSignature(page);
  const still = await page.evaluate(READ_MAP_CARDS);
  check(
    "while the map is open the timeline is suspended: space, tab and the wheel move nothing",
    sigAfter === sigBefore &&
      still.hidden === false &&
      still.cards.length === 2,
    { sigBefore, sigAfter },
  );
  // The wheel was the map's (this map is shorter than the view, so it
  // stayed put); its F switches to Fit, both cards in view.
  await pressF(cdp);
  await sleep(150);

  // Click the OLDER card: the map closes on that item. The wheel walks the
  // story around the landing (docs/plan.md Phase 27): a notch back shows
  // the item before it (video-chain-2), not the screen the click left, and
  // `e` goes to the furthest point read, chain-still-3.
  const reread = await page.evaluate(READ_MAP_CARDS);
  const olderCard = (reread.cards ?? []).find((c) => c.itemIndex === older);
  if (olderCard !== undefined) await clickCard(cdp, olderCard);
  const mapClosed = await waitFor(page, MAP_CLOSED);
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
    "clicking the older card continues from that item; the wheel walks the story around it (back: video-chain-2); e from the landing goes to the furthest read, chain-still-3",
    olderCard !== undefined &&
      mapClosed &&
      landedId === "video-chain-3" &&
      landed.video?.visible === true &&
      landed.imgVisible === false &&
      beforeJump === "video-chain-2" &&
      backOnLanding === "video-chain-3" &&
      atFurthest,
    {
      clicked: olderCard?.itemIndex,
      landedId,
      video: landed.video?.visible,
      beforeJump,
      backOnLanding,
      atFurthest,
    },
  );

  // Ways out: one Escape (the game's in fullscreen too: Keyboard Lock,
  // Phase 43), and m again.
  const reopened = await openMap(page, cdp);
  const fullscreen = await page.evaluate(
    () => document.fullscreenElement !== null,
  );
  await pressEscape(cdp);
  await sleep(80);
  const afterEscape = await mapOpen(page);
  await openMap(page, cdp);
  await pressM(cdp);
  await sleep(80);
  const afterM = await mapOpen(page);
  check(
    "m reopens the map with both cards; one Escape (fullscreen or not) and m again each close it",
    reopened.ready &&
      reopened.map.cards?.length === 2 &&
      afterEscape === false &&
      afterM === false,
    {
      reopened: reopened.map.cards?.length,
      fullscreen,
      afterEscape,
      afterM,
    },
  );

  // A card's × deletes that bookmark, storage included, without opening
  // it: the card stays as a ghost while the map is open, and the next open
  // reads the list again, without it.
  const sigBeforeDelete = await readSignature(page);
  const idBeforeDelete = await currentItemId(page);
  const two = await openMap(page, cdp);
  const victim = (two.map.cards ?? []).find((c) => c.itemIndex === older);
  if (victim !== undefined) await clickCardDelete(cdp, victim);
  let storedAfter = await readBookmarks(page);
  for (let tries = 0; tries < 60 && storedAfter.length !== 1; tries += 1) {
    await sleep(50);
    storedAfter = await readBookmarks(page);
  }
  const afterDelete = await page.evaluate(READ_MAP_CARDS);
  const sigAfterDelete = await readSignature(page);
  const idAfterDelete = await currentItemId(page);
  const ghost = (afterDelete.cards ?? []).find((c) => c.id === victim?.id);
  const kept = (afterDelete.cards ?? []).find((c) => c.itemIndex === newer);
  check(
    "a card's × deletes that bookmark without opening it: the map stays open with the card a ghost, storage drops the row, reading untouched",
    two.map.cards?.length === 2 &&
      two.map.cards.every((c) => c.deleteDrawn) &&
      victim !== undefined &&
      afterDelete.hidden === false &&
      ghost?.deleted === true &&
      kept?.deleted === false &&
      storedAfter.length === 1 &&
      storedAfter[0].itemIndex === newer &&
      idAfterDelete === idBeforeDelete &&
      sigAfterDelete === sigBeforeDelete,
    {
      cards: (afterDelete.cards ?? []).map((c) => [c.itemIndex, c.deleted]),
      stored: storedAfter.map((b) => b.itemIndex),
      idBeforeDelete,
      idAfterDelete,
      sigBeforeDelete,
      sigAfterDelete,
    },
  );
  const closedAfterDelete = await closeMap(page, cdp);
  const third = await openMap(page, cdp);
  check(
    "reopened after the delete, the map shows only the other bookmark's card",
    closedAfterDelete &&
      third.ready &&
      third.map.cards?.length === 1 &&
      third.map.cards[0].itemIndex === newer &&
      third.map.cards[0].deleted === false,
    {
      closedAfterDelete,
      cards: (third.map.cards ?? []).map((c) => [c.itemIndex, c.deleted]),
    },
  );
  await closeMap(page, cdp);
  await page.reload();
  await waitFor(
    page,
    () =>
      (document.getElementById("visual-image")?.getAttribute("src") ?? "") !==
        "" || document.getElementById("visual-video") !== null,
  );
  await sleep(300);
  const reloaded = await openMap(page, cdp);
  check(
    "after a reload the deleted bookmark stays deleted and the other stays on the map",
    reloaded.ready &&
      reloaded.map.cards?.length === 1 &&
      reloaded.map.cards[0].itemIndex === newer,
    { cards: (reloaded.map.cards ?? []).map((c) => c.itemIndex) },
  );
  await closeMap(page, cdp);
}

// Many bookmarks on the map (Phase 26's grid of the `t` screen, before
// Phase 35): eight bookmarks draw eight cards in story order, all in view
// at Fit; a card's × deletes it with the map open and reading untouched,
// and a click on another continues from its item. KINETIC_MAPCARDS_SHOTS
// names a folder for a screenshot at 1280x720.
async function manyBookmarks({ check, open }) {
  const { page, cdp } = await open("many-bookmarks", { closeHelp: true });
  const shots = process.env.KINETIC_MAPCARDS_SHOTS;
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
  const storyOrder = stored.map((b) => b.itemIndex).sort((a, b) => a - b);
  await waitFor(page, () => document.getElementById("flash") === null); // a clean screenshot

  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await sleep(100);
  const wide = await openMap(page, cdp, { loaded: true });
  const cards = wide.map.cards ?? [];
  const view = wide.map.viewRect;
  const inView = (r) =>
    view !== null &&
    r.left >= view.left - 1 &&
    r.right <= view.right + 1 &&
    r.top >= view.top - 1 &&
    r.bottom <= view.bottom + 1;
  if (shots) {
    await page.screenshot({ path: join(shots, "map-cards-1280x720.png") });
  }
  check(
    "m at 1280x720 with eight bookmarks draws eight cards in story order at Full size, every picture in, all inside the map's view, only the latest marked newest",
    stored.length === 8 &&
      wide.map.scale === 1 &&
      wide.ready &&
      cards.length === 8 &&
      cards.map((c) => c.itemIndex).join() === storyOrder.join() &&
      cards.every((c) => c.picResolved && inView(c.rect)) &&
      cards.filter((c) => c.newest).length === 1 &&
      cards.find((c) => c.newest)?.id === stored[7].id,
    {
      taken,
      cards: cards.map((c) => [c.itemIndex, c.newest, c.picResolved]),
      storyOrder,
      offView: cards.filter((c) => !inView(c.rect)).map((c) => c.rect),
      view,
      scale: wide.map.scale,
    },
  );

  // The × deletes without continuing; a card click continues. The newest
  // card's ×, then a click on the card of the bookmark before it.
  const sigBefore = await readSignature(page);
  const newest = cards.find((c) => c.newest);
  if (newest !== undefined) await clickCardDelete(cdp, newest);
  let storedAfter = await readBookmarks(page);
  for (let tries = 0; tries < 60 && storedAfter.length !== 7; tries += 1) {
    await sleep(50);
    storedAfter = await readBookmarks(page);
  }
  const afterDelete = await page.evaluate(READ_MAP_CARDS);
  const sigAfter = await readSignature(page);
  const pick = (afterDelete.cards ?? []).find((c) => c.id === stored[6].id);
  if (pick !== undefined) await clickCard(cdp, pick);
  const closed = await waitFor(page, MAP_CLOSED);
  const landed = await currentItemId(page);
  check(
    "with eight cards, a card's × deletes it (map open, reading untouched) and a click on another closes the map on its item",
    newest !== undefined &&
      afterDelete.hidden === false &&
      (afterDelete.cards ?? []).find((c) => c.id === newest.id)?.deleted ===
        true &&
      (afterDelete.cards ?? []).filter((c) => !c.deleted).length === 7 &&
      storedAfter.length === 7 &&
      !storedAfter.some((b) => b.id === newest.id) &&
      sigAfter === sigBefore &&
      pick !== undefined &&
      closed &&
      landed === stored[6].itemId,
    {
      cards: (afterDelete.cards ?? []).map((c) => [c.itemIndex, c.deleted]),
      stored: storedAfter.length,
      landed,
      want: stored[6].itemId,
    },
  );
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
}

// The bookmark-screen speed item (docs/progress.md), on the branch map
// since Phase 35: with many bookmarks saved in the format players before
// it wrote — rows carrying a heavy route context and a 480 px JPEG capture
// each, and no list cache — `m` shows the map at once, the cards follow,
// and every captured picture fills in. The rows are copies of a real `b`
// row, written straight into IndexedDB as an older build left them.
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

// Page side: time from the `m` keydown to the map showing in a frame, to
// its cards, and to every card's captured picture.
const ARM_SPEED_CLOCK = () => {
  window.__bmSpeed = { t0: null };
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "m" || window.__bmSpeed.t0 !== null) return;
      const clock = window.__bmSpeed;
      clock.t0 = performance.now();
      const tick = () => {
        const now = performance.now() - clock.t0;
        const panel = document.getElementById("branchmap");
        if (clock.visibleMs === undefined && panel && !panel.hidden) {
          clock.visibleMs = now;
        }
        const cards = panel?.querySelectorAll(".bm-card") ?? [];
        if (clock.cardsMs === undefined && cards.length > 0) {
          clock.cardsMs = now;
        }
        const loaded = [...cards].filter((card) => {
          const img = card.querySelector(".bm-thumb > img.bm-pic");
          return (
            img?.complete === true &&
            img.naturalWidth > 0 &&
            (img.getAttribute("src") ?? "").startsWith("data:image/jpeg")
          );
        }).length;
        if (cards.length > 0 && loaded === cards.length) {
          clock.allPicturesMs = now;
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
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await spaceTo(page, cdp, "chain-still-3");
  await pressB(cdp);
  for (let tries = 0; tries < 40; tries += 1) {
    if ((await readBookmarks(page)).length === 1) break;
    await sleep(50);
  }
  const seeded = await page.evaluate(SEED_OLD_ROWS, SPEED_ROWS);
  // A fresh page load over the old rows; the map is opened at once,
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
    await pressM(cdp);
    const filled = await waitFor(
      page,
      () => window.__bmSpeed.allPicturesMs !== undefined,
      15000,
    );
    const clock = await page.evaluate(() => window.__bmSpeed);
    const map = await page.evaluate(READ_MAP_CARDS);
    const closed = await closeMap(page, cdp);
    return { filled, clock, map, closed };
  };
  const cold = await timeOpen();
  const warm = await timeOpen();
  // Every card shows its stored capture; all sixty sit on one screen's
  // stretch, so story order there is oldest first.
  const cardsOk = (map) =>
    map.cards?.length === SPEED_ROWS &&
    map.cards.every(
      (c) =>
        c.picTag === "IMG" &&
        c.picResolved &&
        c.picSrcHead.startsWith("data:image/jpeg"),
    ) &&
    map.cards.every((c, i, all) => i === 0 || all[i - 1].time <= c.time);
  const ms = ({ clock }) => ({
    visible: Math.round(clock.visibleMs ?? -1),
    cards: Math.round(clock.cardsMs ?? -1),
    allPictures: Math.round(clock.allPicturesMs ?? -1),
  });
  check(
    `with ${SPEED_ROWS} bookmarks in the old stored format, m shows the map within ${SPEED_VISIBLE_MS} ms, then a card for each, oldest first, every captured picture filled in — the first open and a second`,
    cold.filled &&
      warm.filled &&
      cold.closed &&
      warm.closed &&
      cold.clock.visibleMs <= SPEED_VISIBLE_MS &&
      warm.clock.visibleMs <= SPEED_VISIBLE_MS &&
      cardsOk(cold.map) &&
      cardsOk(warm.map),
    { seeded, cold: ms(cold), warm: ms(warm), cards: cold.map.cards?.length },
  );

  // The old rows still restore: from a few items back, a click lands on
  // the bookmarked item. Sixty cards on one screen's stretch run over many
  // bands; the map's N (Newest bookmark) scrolls Full size to the newest
  // (to the middle of the view, as near as the map's ends allow), where a
  // reader clicks it.
  await wheel(cdp, true, 3);
  const before = await currentItemId(page);
  const again = await openMap(page, cdp);
  await pressKey(cdp, "n", "KeyN", 78, "n");
  // Two frames: the scroll N asked for is painted.
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  const centred = await waitFor(page, () => {
    const card = document.querySelector("#branchmap .bm-card.bm-newest");
    const view = document
      .querySelector("#branchmap .map-view")
      .getBoundingClientRect();
    if (card === null) return false;
    const r = card.getBoundingClientRect();
    return r.width >= 270 && r.top >= view.top && r.bottom <= view.bottom;
  });
  const newest = (await page.evaluate(READ_MAP_CARDS)).cards?.find(
    (c) => c.newest,
  );
  if (newest !== undefined) await clickCard(cdp, newest);
  const closed = await waitFor(page, MAP_CLOSED);
  const landed = await waitForItem(page, seeded.itemId, 3000);
  check(
    "a card from those old rows still continues from its item",
    before !== seeded.itemId &&
      again.ready &&
      centred &&
      newest !== undefined &&
      closed &&
      landed,
    { before, centred, closed, landed, want: seeded.itemId },
  );
  await closeMap(page, cdp);
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
  const shown = await openMap(page, cdp);
  const cards = shown.map.cards ?? [];
  if (cards.length > 0) await clickCard(cdp, cards[cards.length - 1]);
  const mapClosed = await waitFor(page, MAP_CLOSED);
  const afterCard = await currentItemId(page);
  check(
    "b then an immediate reload resumes on the bookmarked item, help closed, and its card on the map agrees",
    walked &&
      flashed &&
      painted &&
      resumedId === target.id &&
      resumed.helpOpen === false &&
      resumed.stageHidden === false &&
      stored.length === 1 &&
      stored[0].itemIndex === target.index &&
      shown.ready &&
      cards.length === 1 &&
      cards[0].itemIndex === target.index &&
      mapClosed &&
      afterCard === target.id,
    {
      resumedId,
      help: resumed.helpOpen,
      stored,
      cards: cards.length,
      afterCard,
    },
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

  // Not the seen edge either: the bookmark's card lands on text-narration
  // while 0..11 stay seen; a reload resumes there.
  const again = await openMap(page, cdp);
  if ((again.map.cards ?? []).length > 0) {
    await clickCard(cdp, again.map.cards[0]);
  }
  await waitFor(page, MAP_CLOSED);
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
    "c opens nothing; Escape opens the Esc screen with the settings showing the defaults, the speed readout reading 1.00x (~60 ms/char)",
    cInert &&
      opened &&
      (await helpOpen(page)) &&
      (first.belowKeys === true || first.besideKeys === true) &&
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
  // start a skip (Phase 19, "Settings screen clarity"). Since Phase 40
  // they are one inset group under their own heading, with Play all routes
  // a group of its own after them; every shown row label and heading
  // starts on one edge (the Progress rows' labels are hidden: their
  // buttons name themselves), and the switches line up in one column at
  // the rows' right end. Phase 43 item 12: no note or message lines are
  // left (the notes are "?" tips, the notices the pill), Progress's heading
  // says saving is automatic, and Play all routes is one line like the
  // skip switches (its note behind its "?").
  const shownLefts = first.labelLefts.filter((left) => left > 0);
  const [, skipRow, videoRow, playRow] = first.rowRects;
  const heightOf = (r) => r.bottom - r.top;
  check(
    "the config screen groups the skip options under When Tab skips and export, import, reset under 'Progress · saved automatically', labels and headings on one edge, the skip options one group apart from Play all routes, the switches in one column, Play all routes one line as tall as a skip switch's row, and no note or message lines",
    JSON.stringify(first.lines) === JSON.stringify(CONFIG_LINES) &&
      first.noMessageLine &&
      shownLefts.length === 4 &&
      new Set(shownLefts).size === 1 &&
      first.headingTextLefts.length === 3 &&
      first.headingTextLefts.every((left) => left === shownLefts[0]) &&
      Math.abs(videoRow.top - skipRow.bottom) < 1 &&
      playRow.top - videoRow.bottom >= 8 &&
      Math.abs(first.skipRect.right - first.playRect.right) < 1 &&
      Math.abs(heightOf(playRow) - heightOf(skipRow)) < 1 &&
      first.hint === HELP_HINT,
    first,
  );

  // Export, Import and Reset share one line straight under the Progress
  // heading (Phase 40; its note line went in Phase 43 item 12).
  check(
    "Export, Import and Reset sit on one line straight under the Progress heading",
    Math.abs(first.importRect.top - first.exportRect.top) < 1 &&
      Math.abs(first.resetRect.top - first.exportRect.top) < 1,
    { buttons: [first.exportRect, first.importRect, first.resetRect] },
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
  // The page went fullscreen on the first Space, and a short Escape there
  // is the game's (Keyboard Lock, Phase 43): it closes the screen at once
  // and fullscreen stays. WebKit's web view has element fullscreen off, so
  // there the page is windowed and only the closing is seen: PARTIAL.
  const wasFullscreen = (await page.evaluate(PAGE_STATE)).fullscreenElement;
  const seen = await pressEscapeSeen(page, cdp);
  const closedAtOnce = await waitFor(page, CONFIG_CLOSED, 2000);
  const stayed = (await page.evaluate(PAGE_STATE)).fullscreenElement !== null;
  const closed = await closeSettings(page, cdp);
  check(
    "four + clicks show 2.00x (~30 ms/char); one short Escape closes the settings, in fullscreen too, which stays",
    fast.speedValue === SPEED_2X &&
      fast.skipPressed === "true" &&
      seen &&
      closedAtOnce &&
      closed &&
      (wasFullscreen !== null ? stayed : "PARTIAL"),
    {
      speed: fast.speedValue,
      wasFullscreen,
      seen,
      closedAtOnce,
      stayed,
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

// The Esc screen's two columns (docs/plan.md Phase 43 item 12) as the
// reader sees them: each column's width; where the Keys card and the
// Settings content end (the content's last child, not #config's box,
// which its grid area may stretch); each key row's height; each settings
// group's box, with its children's offsets from its top; the skip options'
// rows; and the rects of the speed cell and its parts and of the Game
// window row.
const READ_ESC_COLUMNS = () => {
  const rect = (el) => {
    if (el === null || el === undefined) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };
  const config = document.getElementById("config");
  const keys = document.querySelector("#help .help-list");
  const kids = [...config.children].filter((el) => el.checkVisibility());
  const speedRow = document.querySelector(".config-speed");
  const speedCs = getComputedStyle(speedRow);
  // The first option under a heading: Skip unseen content too.
  const skipRow = document.querySelector(
    ".config-section + .config-row.config-option",
  );
  return {
    keysWidth: keys.getBoundingClientRect().width,
    configWidth: config.getBoundingClientRect().width,
    keysBottom: keys.getBoundingClientRect().bottom,
    settingsBottom: Math.max(
      ...kids.map((el) => el.getBoundingClientRect().bottom),
    ),
    keysTop: keys.getBoundingClientRect().top,
    configTop: config.getBoundingClientRect().top,
    rowHeights: [...keys.querySelectorAll(".help-row")].map(
      (el) => el.getBoundingClientRect().height,
    ),
    groups: [...config.querySelectorAll(":scope > .config-group")].map(
      (group) => {
        const g = group.getBoundingClientRect();
        return {
          top: g.top,
          bottom: g.bottom,
          kids: [...group.children].map(
            (el) => el.getBoundingClientRect().top - g.top,
          ),
        };
      },
    ),
    skip: rect(skipRow),
    video: rect(skipRow?.nextElementSibling),
    speed: {
      row: rect(speedRow),
      padLeft: Number.parseFloat(speedCs.paddingLeft),
      padRight: Number.parseFloat(speedCs.paddingRight),
      radius: Number.parseFloat(speedCs.borderBottomLeftRadius),
      label: rect(speedRow.querySelector(".config-label")),
      value: rect(speedRow.querySelector(".config-speed-value")),
      down: rect(speedRow.querySelector('[data-config-action="speed-down"]')),
      slider: rect(speedRow.querySelector(".config-slider")),
      up: rect(speedRow.querySelector('[data-config-action="speed-up"]')),
    },
    fullscreen: rect(
      document.querySelector('[data-config-action="display-fullscreen"]'),
    ),
    windowHalf: rect(
      document.querySelector('[data-config-action="display-window"]'),
    ),
    exit: rect(document.querySelector('[data-config-action="exit-game"]')),
  };
};

// One column made taller than the other: a block of `px` added to the end
// of the Settings section (`"settings"`, as a system font with wider text,
// Segoe UI on Windows, makes it) or of the Keys card (`"keys"`); 0 takes
// it away.
const PAD_COLUMN = ([which, px]) => {
  document.getElementById("esc-test-pad")?.remove();
  if (px === 0) return;
  const pad = document.createElement("div");
  pad.id = "esc-test-pad";
  pad.style.height = `${px}px`;
  const column =
    which === "keys"
      ? document.querySelector("#help .help-list")
      : document.getElementById("config");
  column.append(pad);
};

// Stretching off (`true`) or back on: each column at the start of its grid
// area, its natural height, so neither the Keys card's rows nor the
// Settings' group gaps take up any difference.
const NATURAL_COLUMNS = (on) => {
  document.getElementById("esc-test-natural")?.remove();
  if (!on) return;
  const style = document.createElement("style");
  style.id = "esc-test-natural";
  style.textContent =
    "#help > .help-list, #help > #config { align-self: start !important; }";
  document.head.append(style);
};

// The gaps between consecutive settings groups beyond their own padding
// (the auto margins that take up a shorter column's spare height).
const groupGaps = (c) =>
  c.groups.slice(1).map((g, i) => g.top - c.groups[i].bottom);

/**
 * The Esc screen's layout (docs/plan.md Phase 43 item 12): from 700 px the
 * two columns are the same width; their natural heights are within 20 px
 * and they end level; a taller settings section stretches the Keys card,
 * its rows sharing the extra height, and a taller Keys card stretches the
 * settings, its group gaps sharing it; the − slider + row spans the speed
 * cell; the Game window row has Fullscreen | Window at its start and Exit
 * at its end.
 */
async function escLayoutOn({ check: record, open }, { folder, session, tag }) {
  const { page, cdp } = await open(session, { folder, closeHelp: true });
  // The audio demo's checks carry its name, so the two runs read apart.
  const check = (name, ok, evidence) =>
    record(tag === "" ? name : `${name} (${tag})`, ok, evidence);
  await openSettings(page, cdp);
  const at = async (width, height) => {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await sleep(150);
    return page.evaluate(READ_ESC_COLUMNS);
  };
  const BALANCED = [
    [1920, 1080],
    [1280, 720],
    [800, 600],
  ];

  // Same widths: one width rule for both columns, so the Keys card and the
  // Settings section are within 1 px of each other's width (700 px wide
  // too, the narrowest two-column window).
  const widths = [];
  for (const [width, height] of [...BALANCED, [700, 900]]) {
    const c = await at(width, height);
    widths.push({
      size: `${width}x${height}`,
      keys: c.keysWidth,
      settings: c.configWidth,
    });
  }
  check(
    "the Keys card and the Settings section are the same width, within 1 px (1920x1080, 1280x720, 800x600, 700x900)",
    widths.every((w) => Math.abs(w.keys - w.settings) <= 1),
    widths,
  );

  // Balanced heights: with stretching off, the two columns' natural
  // bottoms are within 20 px, so stretching only takes up a small
  // remainder; with it on they end level within 2 px.
  const heights = [];
  for (const [width, height] of BALANCED) {
    await at(width, height);
    await page.evaluate(NATURAL_COLUMNS, true);
    const natural = await page.evaluate(READ_ESC_COLUMNS);
    await page.evaluate(NATURAL_COLUMNS, false);
    const stretched = await page.evaluate(READ_ESC_COLUMNS);
    heights.push({
      size: `${width}x${height}`,
      natural: [natural.keysBottom, natural.settingsBottom],
      stretched: [stretched.keysBottom, stretched.settingsBottom],
      ok:
        Math.abs(natural.keysBottom - natural.settingsBottom) <= 20 &&
        Math.abs(stretched.keysBottom - stretched.settingsBottom) <= 2,
    });
  }
  check(
    "the columns' natural heights (stretching off) end within 20 px of each other, and with stretching on the Keys card and the Settings content end level within 2 px (1920x1080, 1280x720, 800x600)",
    heights.every((h) => h.ok),
    heights,
  );

  // A taller settings section (Windows' wider font, simulated with 120 px
  // more at its end): the Keys card stretches to its end, every key row
  // taking the same share of the extra height (within 1 px).
  const wide = await at(1920, 1080);
  await page.evaluate(PAD_COLUMN, ["settings", 120]);
  await sleep(100);
  const padded = await page.evaluate(READ_ESC_COLUMNS);
  await page.evaluate(PAD_COLUMN, ["settings", 0]);
  const grown = padded.rowHeights.map((h, i) => h - wide.rowHeights[i]);
  check(
    "a taller settings section (120 px more) stretches the Keys card to its end, the key rows sharing the extra height evenly (1920x1080)",
    Math.abs(padded.keysBottom - padded.settingsBottom) <= 1 &&
      padded.keysBottom - padded.keysTop - (wide.keysBottom - wide.keysTop) >
        100 &&
      Math.max(...grown) - Math.min(...grown) <= 1 &&
      Math.min(...grown) > 0,
    {
      wide: [wide.keysTop, wide.keysBottom, wide.settingsBottom],
      padded: [padded.keysTop, padded.keysBottom, padded.settingsBottom],
      grown,
    },
  );

  // A taller Keys card (120 px more at its end, as a longer key list or a
  // wider font in the Keys rows would make it): the settings stretch to
  // its end, the four gaps between groups sharing the extra height evenly
  // (within 1 px), and nothing inside a group moves (each child's offset
  // from its group's top within 0.5 px, the skip options' rows still
  // touching). The speed cell's top stays level with the Keys card's.
  await page.evaluate(NATURAL_COLUMNS, true);
  const unstretched = await page.evaluate(READ_ESC_COLUMNS);
  await page.evaluate(NATURAL_COLUMNS, false);
  await page.evaluate(PAD_COLUMN, ["keys", 120]);
  await sleep(100);
  const tall = await page.evaluate(READ_ESC_COLUMNS);
  await page.evaluate(PAD_COLUMN, ["keys", 0]);
  const gaps = groupGaps(tall);
  const moved = tall.groups.flatMap((g, i) =>
    g.kids.map((top, k) => Math.abs(top - unstretched.groups[i].kids[k])),
  );
  check(
    "a taller Keys card (120 px more) stretches the settings to its end, the four gaps between groups sharing the extra height evenly and nothing inside a group moving; the speed cell's top stays level with the card's (1920x1080)",
    Math.abs(tall.keysBottom - tall.settingsBottom) <= 1 &&
      gaps.length === 4 &&
      Math.max(...gaps) - Math.min(...gaps) <= 1 &&
      Math.min(...gaps) > 25 &&
      Math.max(...moved) <= 0.5 &&
      Math.abs(tall.video.top - tall.skip.bottom) < 1 &&
      Math.abs(tall.speed.row.top - tall.keysTop) <= 0.5,
    {
      tall: [tall.keysTop, tall.keysBottom, tall.settingsBottom],
      gaps,
      moved: Math.max(...moved),
      skipRows: [tall.skip.bottom, tall.video.top],
      tops: [tall.speed.row.top, tall.keysTop],
    },
  );

  // Stacked under 700 px neither column stretches: the Keys card keeps its
  // height with the settings padded (the sheet, centred in the window, may
  // move as a whole), and the settings' group gaps stay at nothing beyond
  // their padding with the Keys card padded.
  const narrow = await at(600, 900);
  await page.evaluate(PAD_COLUMN, ["settings", 120]);
  await sleep(100);
  const narrowSettings = await page.evaluate(READ_ESC_COLUMNS);
  await page.evaluate(PAD_COLUMN, ["keys", 120]);
  await sleep(100);
  const narrowKeys = await page.evaluate(READ_ESC_COLUMNS);
  await page.evaluate(PAD_COLUMN, ["keys", 0]);
  check(
    "stacked under 700 px neither column stretches: the settings below the Keys card, the card's height unchanged by taller settings, the settings' group gaps unchanged by a taller card (600x900)",
    narrow.configTop > narrow.keysBottom &&
      Math.abs(
        narrowSettings.keysBottom -
          narrowSettings.keysTop -
          (narrow.keysBottom - narrow.keysTop),
      ) <= 0.5 &&
      groupGaps(narrowKeys).every((gap) => Math.abs(gap) <= 0.5),
    {
      keys: [
        [narrow.keysTop, narrow.keysBottom],
        [narrowSettings.keysTop, narrowSettings.keysBottom],
      ],
      gaps: groupGaps(narrowKeys),
    },
  );

  // The speed cell: − on its left padding edge, + on its right, the
  // slider filling the space between, the readout's right edge on +'s and
  // never over the label (it takes a line of its own when both cannot
  // share one, as at 700 px wide), and the cell's rounded bottom back.
  const spans = [];
  for (const [width, height] of [...BALANCED, [700, 900]]) {
    const { speed: sp } = await at(width, height);
    spans.push({
      size: `${width}x${height}`,
      ok:
        Math.abs(sp.down.left - (sp.row.left + sp.padLeft)) <= 0.5 &&
        Math.abs(sp.up.right - (sp.row.right - sp.padRight)) <= 0.5 &&
        sp.slider.left >= sp.down.right &&
        sp.slider.right <= sp.up.left &&
        sp.up.left - sp.slider.right < 20 &&
        sp.slider.left - sp.down.right < 20 &&
        Math.abs(sp.value.right - sp.up.right) <= 0.5 &&
        (sp.value.left >= sp.label.right ||
          sp.value.top >= sp.label.bottom - 0.5) &&
        sp.radius > 0,
      sp,
    });
  }
  check(
    "the - slider + row spans the speed cell: - on its left padding edge, + on its right, the slider between; the readout ends on +'s edge and never overlaps the label; the cell's bottom is rounded (1920x1080, 1280x720, 800x600, 700x900)",
    spans.every((sp) => sp.ok),
    spans,
  );

  // Game window: one line, Fullscreen | Window at its start and Exit at
  // its end, flush with the column's outer edges where the cards (the
  // speed cell) start and end.
  const rows = [];
  for (const [width, height] of [...BALANCED, [700, 900]]) {
    const c = await at(width, height);
    rows.push({
      size: `${width}x${height}`,
      ok:
        Math.abs(c.fullscreen.left - c.speed.row.left) <= 1 &&
        Math.abs(c.exit.right - c.speed.row.right) <= 1 &&
        Math.abs(c.windowHalf.top - c.fullscreen.top) <= 0.5 &&
        Math.abs(c.exit.top - c.fullscreen.top) <= 0.5 &&
        c.exit.left > c.windowHalf.right,
      c: {
        fullscreen: c.fullscreen,
        exit: c.exit,
        card: c.speed.row,
      },
    });
  }
  check(
    "Game window is one line: Fullscreen's left edge on the cards' left edge, Exit's right edge on the cards' right edge (1920x1080, 1280x720, 800x600, 700x900)",
    rows.every((r) => r.ok),
    rows,
  );
  return { page, cdp, check };
}

const escLayout = (args) =>
  escLayoutOn(args, { folder: demoDir, session: "esc-layout", tag: "" });

/**
 * The same layout for a game with sound (docs/plan.md Phase 47 item 7):
 * its Keys card has the `v` row and its settings the Sound row, and the
 * columns still balance and the whole screen still fits.
 */
async function escLayoutAudio(args) {
  if (!audioBuilt(args)) return;
  const { page, check } = await escLayoutOn(args, {
    folder: audioDemoDir,
    session: "esc-layout-audio",
    tag: "audio demo",
  });
  await checkEscFits(page, check, HELP_KEYS_SOUND);
}

/**
 * The Esc screen at its smallest promised sizes (Phase 28; Reset in view
 * at 800x600, Phases 31, 35): with `keys` (the key rows' labels) as its
 * key rows, it fits without any scroll at 1280x720, 700x900 and 800x600,
 * and nothing in it scrolls across. Leaves the viewport as it found it.
 */
async function checkEscFits(page, check, keys) {
  const viewport = page.viewport();
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
  await sleep(150);
  const small = await page.evaluate((selector) => {
    const reset = document.querySelector(selector)?.getBoundingClientRect();
    const help = document.getElementById("help");
    return {
      bottom: reset?.bottom ?? Number.POSITIVE_INFINITY,
      height: innerHeight,
      scrolled: (help?.scrollTop ?? 0) + document.scrollingElement.scrollTop,
      rows: document.querySelectorAll("#help .help-row").length,
    };
  }, CONFIG_CONTROL.reset);
  check(
    `at 800x600 the Esc screen's ${keys.length} key rows leave Reset in view without scrolling`,
    small.rows === keys.length &&
      small.bottom <= small.height &&
      small.scrolled === 0,
    small,
  );
  // The whole Esc screen fits without any scroll at every size Phase 28
  // promised (1280x720, 700x900, 800x600), and nothing in it ever
  // scrolls across: the screen's content is no taller or wider than the
  // screen, the page itself does not scroll, Reset is in the window.
  const fits = [];
  for (const [width, height] of [
    [1280, 720],
    [700, 900],
    [800, 600],
  ]) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await sleep(150);
    fits.push(
      await page.evaluate(
        (selector, size) => {
          const help = document.getElementById("help");
          const reset = document
            .querySelector(selector)
            ?.getBoundingClientRect();
          return {
            size,
            down: help.scrollHeight - help.clientHeight,
            across: help.scrollWidth - help.clientWidth,
            page:
              document.scrollingElement.scrollHeight -
              document.scrollingElement.clientHeight,
            resetBottom: reset?.bottom ?? Number.POSITIVE_INFINITY,
            height: innerHeight,
          };
        },
        CONFIG_CONTROL.reset,
        `${width}x${height}`,
      ),
    );
  }
  check(
    "the whole Esc screen fits without scrolling at 1280x720, 700x900 and 800x600, Reset in view, nothing scrolling across",
    fits.every(
      (f) =>
        f.down <= 0 &&
        f.across <= 0 &&
        f.page <= 0 &&
        f.resetBottom <= f.height,
    ),
    fits,
  );
  if (viewport !== null) await page.setViewport(viewport);
  await sleep(150);
}

// One "?" tip as the reader sees it, read one animation frame after the
// hover, focus or click that changes it: its state, whether the tip shows,
// its text and the button's description, its box against the settings
// column and the window, and whether the "?" has keyboard focus.
const READ_TIP = async (key) => {
  const framed = await Promise.race([
    new Promise((r) => requestAnimationFrame(() => r(true))),
    new Promise((r) => setTimeout(() => r(false), 500)),
  ]);
  const button = document.querySelector(`[data-config-action="tip-${key}"]`);
  const body = button.parentElement.querySelector(".config-tip-text");
  const described = document.getElementById(
    button.getAttribute("aria-describedby") ?? "",
  );
  const r = body.getBoundingClientRect();
  const col = document.getElementById("config").getBoundingClientRect();
  const b = button.getBoundingClientRect();
  return {
    framed,
    state: button.parentElement.getAttribute("data-tip"),
    shown: getComputedStyle(body).visibility === "visible",
    text: body.textContent,
    described: described?.textContent ?? null,
    role: body.getAttribute("role"),
    name: button.getAttribute("aria-label"),
    title: button.getAttribute("title"),
    tag: button.tagName,
    focusVisible: button.matches(":focus-visible"),
    inside:
      r.left >= col.left - 0.5 &&
      r.right <= col.right + 0.5 &&
      r.top >= b.bottom &&
      r.bottom <= col.bottom + 0.5 &&
      r.bottom <= innerHeight,
    box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
    centre: { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 },
  };
};

const TIPS = [
  [
    "speed",
    "Also times play-all's choice countdown.",
    "About auto-forward speed",
  ],
  [
    "play-all",
    "When on, choices pick themselves on a countdown.",
    "About play all routes",
  ],
  ["progress", BROWSER_WORDING.progressTip, "About progress"],
];

const tipShows = (t, text, name) =>
  t.framed &&
  t.shown &&
  t.text === text &&
  t.described === text &&
  t.role === "tooltip" &&
  t.name === name &&
  t.title === null &&
  t.tag === "BUTTON" &&
  t.inside;

async function hover(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
  });
}

// The "?" glyph's ink against its ring's centre, in a screenshot (device
// scale 1): the ring's box from the layout; the ground read at the box's
// corners (outside the ring); each pixel's share of the glyph's colour over
// that ground, within the ring's inner edge so the ring itself is left
// out; the ink box's edges to a fraction of a pixel (an edge column's or
// row's share); its centre's offset from the ring's centre in CSS pixels.
const GLYPH_OFFSET = async (png, box) => {
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const x0 = Math.floor(box.left);
  const y0 = Math.floor(box.top);
  const x1 = Math.ceil(box.right);
  const y1 = Math.ceil(box.bottom);
  const { data, width } = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  const lum = (x, y) => {
    const i = ((y - y0) * width + (x - x0)) * 4;
    return data[i] + data[i + 1] + data[i + 2];
  };
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  // The ring is 1.25 px wide; a pixel more keeps its antialiasing out.
  const inner = (box.right - box.left) / 2 - 2.25;
  const inside = (x, y) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= inner;
  const corners = [
    lum(x0, y0),
    lum(x1 - 1, y0),
    lum(x0, y1 - 1),
    lum(x1 - 1, y1 - 1),
  ].sort((a, b) => a - b);
  const ground = (corners[1] + corners[2]) / 2;
  let peak = ground;
  for (let y = y0; y < y1; y += 1)
    for (let x = x0; x < x1; x += 1)
      if (inside(x, y)) peak = Math.max(peak, lum(x, y));
  const cols = new Map();
  const rows = new Map();
  for (let y = y0; y < y1; y += 1)
    for (let x = x0; x < x1; x += 1) {
      const c = inside(x, y)
        ? Math.max(0, Math.min(1, (lum(x, y) - ground) / (peak - ground)))
        : 0;
      cols.set(x, Math.max(cols.get(x) ?? 0, c));
      rows.set(y, Math.max(rows.get(y) ?? 0, c));
    }
  const edges = (m) => {
    const inked = [...m.keys()].filter((k) => m.get(k) > 0.1);
    const a = Math.min(...inked);
    const b = Math.max(...inked);
    return [a + (1 - m.get(a)), b + m.get(b)];
  };
  const [left, right] = edges(cols);
  const [top, bottom] = edges(rows);
  return {
    dx: (left + right) / 2 - cx,
    dy: (top + bottom) / 2 - cy,
    ink: { left, right, top, bottom },
    contrast: peak - ground,
  };
};

// The first capital of the text a "?" follows (its label or heading) and
// the ring, as layout boxes: the screenshot they are read with gives the
// ink.
const READ_RING_LINE = (key) => {
  const box = (r) => ({
    left: r.left,
    right: r.right,
    top: r.top,
    bottom: r.bottom,
  });
  const button = document.querySelector(`[data-config-action="tip-${key}"]`);
  const line = button.closest(".config-label, .config-section");
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null && !/[A-Z]/.test(node.data)) node = walker.nextNode();
  const at = node.data.search(/[A-Z]/);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + 1);
  return {
    letter: node.data[at],
    letterBox: box(range.getBoundingClientRect()),
    ring: box(button.getBoundingClientRect()),
  };
};

// A box's ink in a screenshot (device scale 1), top to bottom: the ground
// read at the box's corners, each row's strongest pixel as a share of the
// box's peak over that ground, and the ink's top and bottom edges to a
// fraction of a pixel (an edge row's share), as GLYPH_OFFSET reads edges.
// Over a capital with no descender, the bottom edge is the baseline and
// the top its cap height.
const INK_ROWS = async (png, box) => {
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const x0 = Math.floor(box.left);
  const y0 = Math.floor(box.top);
  const x1 = Math.ceil(box.right);
  const y1 = Math.ceil(box.bottom);
  const { data, width } = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  const lum = (x, y) => {
    const i = ((y - y0) * width + (x - x0)) * 4;
    return data[i] + data[i + 1] + data[i + 2];
  };
  const corners = [
    lum(x0, y0),
    lum(x1 - 1, y0),
    lum(x0, y1 - 1),
    lum(x1 - 1, y1 - 1),
  ].sort((a, b) => a - b);
  const ground = (corners[1] + corners[2]) / 2;
  let peak = ground;
  for (let y = y0; y < y1; y += 1)
    for (let x = x0; x < x1; x += 1) peak = Math.max(peak, lum(x, y));
  const rows = new Map();
  for (let y = y0; y < y1; y += 1) {
    let share = 0;
    for (let x = x0; x < x1; x += 1)
      share = Math.max(share, (lum(x, y) - ground) / (peak - ground));
    rows.set(y, Math.max(0, Math.min(1, share)));
  }
  const inked = [...rows.keys()].filter((y) => rows.get(y) > 0.1);
  const a = Math.min(...inked);
  const b = Math.max(...inked);
  return {
    top: a + (1 - rows.get(a)),
    bottom: b + rows.get(b),
    contrast: peak - ground,
  };
};

// One ring against its text, from a screenshot: the capital's baseline and
// cap height (its ink), the ring's painted top and bottom (its stroke's ink
// in a strip across each, at its centre column, clear of the glyph), and
// the ring's centre's offset from half the cap height above the baseline
// (positive: lower). The layout centre comes along for the record.
async function ringOnCap(page, png, key) {
  const { letter, letterBox, ring } = await page.evaluate(READ_RING_LINE, key);
  const cap = await page.evaluate(INK_ROWS, png, letterBox);
  const cx = (ring.left + ring.right) / 2;
  const strip = (top, bottom) => ({
    left: cx - 1.5,
    right: cx + 1.5,
    top,
    bottom,
  });
  const ringTop = await page.evaluate(
    INK_ROWS,
    png,
    strip(ring.top - 1.5, ring.top + 1.5),
  );
  const ringBottom = await page.evaluate(
    INK_ROWS,
    png,
    strip(ring.bottom - 1.5, ring.bottom + 1.5),
  );
  const capMid = (cap.top + cap.bottom) / 2;
  const ringMid = (ringTop.top + ringBottom.bottom) / 2;
  return {
    key,
    letter,
    baseline: cap.bottom,
    capHeight: cap.bottom - cap.top,
    ring: ringBottom.bottom - ringTop.top,
    offset: ringMid - capMid,
    layoutOffset: (ring.top + ring.bottom) / 2 - capMid,
    contrast: Math.min(cap.contrast, ringTop.contrast, ringBottom.contrast),
  };
}

/**
 * The "?" tips (docs/plan.md Phase 43 item 12): each shows its tip (the
 * note it replaced) on keyboard focus and on hover, inside the settings
 * column; a click pins it open and a second click shuts it, without
 * closing the screen, asking for fullscreen or changing a setting; Space
 * and Escape with a "?" focused still close the screen; the glyph's ink is
 * centred on its ring within 1 px; each ring's centre is within 1 px of
 * half its text's cap height above the baseline, and the ring is 1.3 to
 * 1.7 cap heights across.
 */
async function escTips({ check, open }) {
  const { page, cdp } = await open("esc-tips", { closeHelp: true });
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await openSettings(page, cdp);

  // Keyboard focus: Tab is the skip key (render/keys.ts), so it never
  // walks onto the "?"; each is focused from script right after the
  // Escape that opened the screen, which both engines take as keyboard
  // focus (:focus-visible).
  const focused = [];
  for (const [key, text, name] of TIPS) {
    await page.evaluate(
      (k) => document.querySelector(`[data-config-action="tip-${k}"]`).focus(),
      key,
    );
    const t = await page.evaluate(READ_TIP, key);
    focused.push({ key, ok: t.focusVisible && tipShows(t, text, name), t });
  }
  await page.evaluate(() => document.activeElement?.blur());
  check(
    "keyboard focus on each ? (a button named About …, no title) shows its tip, the moved note, inside the settings column",
    focused.every((f) => f.ok),
    focused,
  );

  // Hover, at two widths (the narrow column at 700 px too).
  const hovered = [];
  for (const [width, height] of [
    [1280, 720],
    [700, 900],
  ]) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await sleep(150);
    for (const [key, text, name] of TIPS) {
      const { centre } = await page.evaluate(READ_TIP, key);
      await hover(cdp, centre.x, centre.y);
      const t = await page.evaluate(READ_TIP, key);
      await hover(cdp, 5, 5);
      const away = await page.evaluate(READ_TIP, key);
      hovered.push({
        size: `${width}x${height}`,
        key,
        ok: tipShows(t, text, name) && !away.shown,
        t,
        away: away.shown,
      });
    }
  }
  check(
    "hovering each ? shows its tip within a frame, inside the settings column, and moving off hides it (1280x720, 700x900)",
    hovered.every((h) => h.ok),
    hovered,
  );

  // A click pins it open (it stays with the pointer gone), a second click
  // shuts it even under the pointer; the screen stays open, nothing asks
  // for fullscreen, no setting moves. One tip at a time.
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await sleep(150);
  const before = await page.evaluate(READ_CONFIG_OVERLAY);
  const asked = (await page.evaluate(PAGE_STATE)).fsAttempts;
  const speedTip = '[data-config-action="tip-speed"]';
  await clickCenter(cdp, speedTip);
  await hover(cdp, 5, 5);
  const pinned = await page.evaluate(READ_TIP, "speed");
  const { centre } = pinned;
  await clickCenter(cdp, speedTip);
  const shut = await page.evaluate(READ_TIP, "speed");
  await hover(cdp, 5, 5);
  await hover(cdp, centre.x, centre.y);
  const rearmed = await page.evaluate(READ_TIP, "speed");
  await hover(cdp, 5, 5);
  await clickCenter(cdp, speedTip);
  await clickCenter(cdp, '[data-config-action="tip-progress"]');
  await hover(cdp, 5, 5);
  const one = [
    await page.evaluate(READ_TIP, "speed"),
    await page.evaluate(READ_TIP, "progress"),
  ];
  const after = await page.evaluate(READ_CONFIG_OVERLAY);
  const askedAfter = (await page.evaluate(PAGE_STATE)).fsAttempts;
  const settingsOf = (c) => [c.speedValue, c.skipPressed, c.playPressed];
  check(
    "a click on a ? pins its tip open, a second click shuts it under the pointer (hover shows it again once the pointer has left); one tip at a time; the screen stays open, no fullscreen asked, no setting changed",
    pinned.state === "open" &&
      pinned.shown &&
      shut.state === "shut" &&
      !shut.shown &&
      rearmed.shown &&
      !one[0].shown &&
      one[1].shown &&
      (await configOpen(page)) &&
      askedAfter === asked &&
      JSON.stringify(settingsOf(after)) === JSON.stringify(settingsOf(before)),
    {
      pinned: [pinned.state, pinned.shown],
      shut: [shut.state, shut.shown],
      rearmed: rearmed.shown,
      one: one.map((t) => [t.state, t.shown]),
      asked: [asked, askedAfter],
      settings: [settingsOf(before), settingsOf(after)],
    },
  );

  // The glyph is drawn on its ring's own box, so its ink sits on the
  // ring's centre whatever the system font: within 1 px, every "?", at two
  // sizes (the label's ring is 17 px at 1080 px tall, 14 px at 600; the
  // Progress heading's 14 and 12). The same screenshots give each ring
  // against its text (ringOnCap).
  const glyphs = [];
  const rings = [];
  await closeSettings(page, cdp);
  for (const [width, height] of [
    [1920, 1080],
    [800, 600],
  ]) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await openSettings(page, cdp); // reopened: every tip idle
    // The idle rings: the "?" the click test left focused may keep focus
    // across the close (Chrome clears focus from a hidden element in a
    // later task, which a quick reopen can beat), and the Escape pressed
    // then lights its focus ring, whose gold reaches the ring box's
    // corners, where the ground is read.
    await page.evaluate(() => document.activeElement?.blur());
    await hover(cdp, 5, 5);
    await sleep(200);
    const png = await page.screenshot({ encoding: "base64" });
    for (const [key] of TIPS) {
      const box = await page.evaluate((k) => {
        const r = document
          .querySelector(`[data-config-action="tip-${k}"]`)
          .getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }, key);
      const g = await page.evaluate(GLYPH_OFFSET, png, box);
      glyphs.push({ size: `${width}x${height}`, key, box, ...g });
      rings.push({
        size: `${width}x${height}`,
        ...(await ringOnCap(page, png, key)),
      });
    }
    await closeSettings(page, cdp);
  }
  check(
    "each ?'s glyph is centred in its ring: its ink box's centre within 1 px of the ring's centre, across and down (1920x1080, 800x600)",
    glyphs.every(
      (g) => Math.abs(g.dx) <= 1 && Math.abs(g.dy) <= 1 && g.contrast > 150,
    ),
    glyphs,
  );
  // Each ring sits in its line as an SF Symbol does in text: its painted
  // centre within 1 px of half the cap height above the baseline, both
  // read from the text's first capital's ink in the same screenshot; and
  // sized from the text, 1.3 to 1.7 cap heights across, so the Progress
  // heading's ring is as much smaller as its text.
  check(
    "each ? ring's centre is within 1 px of half its text's cap height above the baseline (the ink of the label's or heading's first capital), and the ring is 1.3 to 1.7 cap heights across (1920x1080, 800x600)",
    rings.length === 2 * TIPS.length &&
      rings.every(
        (r) =>
          Math.abs(r.offset) <= 1 &&
          r.ring >= 1.3 * r.capHeight &&
          r.ring <= 1.7 * r.capHeight &&
          r.contrast > 60,
      ),
    rings,
  );

  // Space and Escape keep closing the screen with a "?" focused: the
  // keymap takes them first, so the "?" is not pressed.
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await openSettings(page, cdp);
  await page.evaluate((s) => document.querySelector(s).focus(), speedTip);
  await pressSpace(cdp);
  const spaceClosed = await waitFor(page, HELP_CLOSED, 2000);
  await openSettings(page, cdp);
  const idle = await page.evaluate(READ_TIP, "speed");
  await page.evaluate((s) => document.querySelector(s).focus(), speedTip);
  await pressEscape(cdp);
  const escapeClosed = await waitFor(page, HELP_CLOSED, 2000);
  check(
    "Space and Escape with a ? focused close the screen, and the ? is not pressed",
    spaceClosed && idle.state === "idle" && escapeClosed,
    { spaceClosed, idle: idle.state, escapeClosed },
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
  // `t` is no key since the bookmarks moved onto the map (Phase 35).
  await pressT(cdp);
  await sleep(150);
  const afterT = await page.evaluate(PAGE_STATE);
  const shown = await openMap(page, cdp);
  await pressEscape(cdp);
  await sleep(80);
  const closed = (await mapOpen(page)) === false;
  check(
    "t opens nothing there; m opens the branch map with no bookmark cards, and Escape closes it",
    helpClosed &&
      afterT.mapOpen === false &&
      afterT.helpOpen === false &&
      shown.ready &&
      (shown.map.cards ?? []).length === 0 &&
      closed,
    {
      helpClosed,
      afterT: { map: afterT.mapOpen, help: afterT.helpOpen },
      ready: shown.ready,
      cards: shown.map.cards?.length,
      closed,
    },
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
  // At 800x600 the whole Esc screen fits: Reset is on screen without a
  // scroll (Phase 31: the decision keys share one row; Phase 35 dropped
  // the T row, 11 rows in all).
  await checkEscFits(page, check, HELP_KEYS);
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
  const kept = await openMap(page, cdp);
  const keptClosed = await closeMap(page, cdp);
  await openSettings(page, cdp);
  const keptCfg = await page.evaluate(READ_CONFIG_OVERLAY);
  check(
    "cancel kept everything: the reload resumes on the item, the bookmark's card is on the map, 2.00x and play-all off are still there",
    resumedId === target.id &&
      resumed.helpOpen === false &&
      kept.ready &&
      (kept.map.cards ?? []).length === 1 &&
      kept.map.cards[0].itemIndex === target.index &&
      keptClosed &&
      keptCfg.speedValue === SPEED_2X &&
      keptCfg.playPressed === "false",
    {
      resumedId,
      help: resumed.helpOpen,
      cards: (kept.map.cards ?? []).map((c) => c.itemIndex),
      speed: keptCfg.speedValue,
      play: keptCfg.playPressed,
    },
  );

  // Confirm: the app's own wipe + reload is a first-ever boot.
  await clickCenter(cdp, CONFIG_CONTROL.reset);
  await waitFor(page, CONFIRM_OPEN);
  const box2 = await page.evaluate(READ_CONFIRM_OVERLAY);
  // The wipe is async and ends in a reload: wait for that page, not the
  // old one's Esc screen still up behind the box (as progress does).
  await Promise.all([
    page
      .waitForNavigation({ waitUntil: "load", timeout: 8000 })
      .catch(() => {}),
    clickCenter(cdp, CONFIRM_CONTROL.confirm),
  ]);
  const bootHelp = await waitFor(page, HELP_OPEN, 6000);
  await sleep(400);
  const boot = await page.evaluate(PAGE_STATE);
  const bootId = await currentItemId(page);
  await pressEscape(cdp);
  await waitFor(page, HELP_CLOSED);
  const map = await openMap(page, cdp);
  const mapClosed = await closeMap(page, cdp);
  await openSettings(page, cdp);
  const fresh = await page.evaluate(READ_CONFIG_OVERLAY);
  await closeSettings(page, cdp);
  check(
    "confirming is a true first-ever boot: help up, first item, no bookmark cards on the map, 1.00x, skip-all off and play-all back on",
    box2.hidden === false &&
      bootHelp &&
      boot.helpOpen === true &&
      boot.stageHidden === true &&
      bootId === item("intro-title").id &&
      map.ready &&
      (map.map.cards ?? []).length === 0 &&
      mapClosed &&
      fresh.speedValue === SPEED_1X &&
      fresh.skipPressed === "false" &&
      fresh.playPressed === "true",
    {
      bootHelp,
      bootId,
      stage: boot.stageHidden,
      cards: map.map.cards?.length,
      speed: fresh.speedValue,
      play: fresh.playPressed,
    },
  );
}

// The reading-state record as IndexedDB holds it (src/storage/idb.ts),
// and the ids in the story's seen records (docs/plan.md Phase 46): `{
// record, seen }`.
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
    const store = db.transaction("state", "readonly").objectStore("state");
    const read = (req) =>
      new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const record = await read(store.get(content));
    const seenRecords = await read(
      store.getAll(IDBKeyRange.bound(["seen", content], ["seen", content, []])),
    );
    return { record: record ?? null, seen: seenRecords.flat() };
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

  const walked1 = await spaceTo(page, cdp, "video-chain-3");
  await pressB(cdp);
  const flashed = await waitFor(page, FLASH_SHOWN);
  const walked2 = await spaceTo(page, cdp, "chain-still-3");
  await sleep(300);
  const { record, seen } = await page.evaluate(READ_STATE);
  check(
    "the save names items by id, not position (the seen ids in their own records)",
    walked1 &&
      flashed &&
      walked2 &&
      record?.ctx?.lastShown === "chain-still-3" &&
      Array.isArray(record?.ctx?.visited) &&
      record.ctx.visited.length === 0 &&
      seen.includes("intro-title") &&
      seen.includes("chain-still-3") &&
      seen.every((id) => typeof id === "string") &&
      !("frontier" in (record ?? {})),
    {
      walked1,
      flashed,
      walked2,
      ctx: record?.ctx,
      seen,
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
  const notice = await page.evaluate(READ_NOTICE);
  check(
    "the resume shows the quiet earlier-unseen notice (the prequel is unseen)",
    notice.shown &&
      notice.text === "Earlier content you haven't seen - press u.",
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

  const shown = await openMap(page, cdp);
  const cards = shown.map.cards ?? [];
  if (cards.length > 0) await clickCard(cdp, cards[0]);
  await waitFor(page, MAP_CLOSED);
  await sleep(300);
  const restoredId = await currentItemId(page);
  check(
    "the bookmark still names video-chain-3 at its new place, and its card on the map restores there",
    shown.ready &&
      cards.length === 1 &&
      cards[0].itemIndex === newIndex("video-chain-3") &&
      cards[0].itemId === "video-chain-3" &&
      restoredId === "video-chain-3",
    {
      cards: cards.map((c) => [c.itemIndex, c.itemId]),
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

// Phase 46, item 1: the seen set lives in records of its own, not in the
// state record, and a save carries only what was newly seen. Items a
// content update inserts INTO content already read still count as unseen,
// as before: read the whole demo (play-all), step back one screen, insert
// two items between two read screens, reload. The resume notice shows,
// the end card one screen on counts them and offers u (the notice yields
// to the end card, so it is read off the story's end), u lands on the
// first, and skip from a bookmark before them stops short of the one still
// unseen.
const READ_END = () => {
  const card = document.getElementById("end-card");
  const hint = card?.querySelector(".end-card-hint");
  return {
    shown: card !== null && !card.hidden,
    title: card?.querySelector(".end-card-title")?.textContent ?? null,
    hint: hint && !hint.hidden ? hint.textContent : null,
  };
};
const READ_NOTICE = () => {
  const n = document.getElementById("notice");
  return { shown: n !== null && !n.hidden, text: n?.textContent ?? null };
};

async function insertedContent({ check, open }) {
  const folder = join(dirname(demoDir), "demo-insert");
  rmSync(folder, { recursive: true, force: true });
  cpSync(demoDir, folder, { recursive: true });
  const { page, cdp } = await open("insert", { closeHelp: true, folder });

  const walked1 = await spaceTo(page, cdp, "text-speech");
  await pressB(cdp);
  const flashed = await waitFor(page, FLASH_SHOWN);
  const walked2 = await spaceTo(page, cdp, "after-end", 80);
  await sleep(300);
  const before = await page.evaluate(READ_END);
  await wheel(cdp, true, 1);
  await sleep(300);
  const steppedBack = await currentItemId(page);
  const { record, seen } = await page.evaluate(READ_STATE);
  check(
    "read through: the end card says everything has been seen; the state record holds the place, every seen id sits in the seen records",
    walked1 &&
      flashed &&
      walked2 &&
      before.shown &&
      before.title === "You have seen everything." &&
      steppedBack === "after-start" &&
      record?.ctx?.lastShown === "after-start" &&
      Array.isArray(record?.ctx?.visited) &&
      record.ctx.visited.length === 0 &&
      manifest.items.every((it) => seen.includes(it.id)),
    {
      walked1,
      flashed,
      walked2,
      before,
      steppedBack,
      ctx: record?.ctx,
      seen: seen.length,
    },
  );

  // The update: two items between text-narration and text-bare, both read.
  const updated = JSON.parse(
    readFileSync(join(folder, "manifest.json"), "utf8"),
  );
  const inserted = [
    {
      id: "inserted-1",
      type: "image",
      file: "branch-title.jpg",
      text: "Inserted one: a content update added this inside read content.",
    },
    {
      id: "inserted-2",
      type: "image",
      file: "after-start.jpg",
      text: "Inserted two: also added by the update, also unseen.",
    },
  ];
  updated.items.splice(
    updated.items.findIndex((it) => it.id === "text-bare"),
    0,
    ...inserted,
  );
  const json = JSON.stringify(updated, null, 2);
  writeFileSync(join(folder, "manifest.json"), `${json}\n`);
  writeFileSync(
    join(folder, "manifest.js"),
    `window.KINETIC_MANIFEST = ${json};\n`,
  );
  // The inserted ids are not in the harness's demo manifest: by text.
  const insertedId = async () => {
    const text = (await page.evaluate(PAGE_STATE)).text;
    return inserted.find((it) => it.text === text)?.id ?? null;
  };

  await page.reload();
  await waitFor(
    page,
    () =>
      (document.getElementById("visual-image")?.getAttribute("src") ?? "") !==
      "",
  );
  await sleep(500);
  const resumedId = await currentItemId(page);
  const notice = await page.evaluate(READ_NOTICE);
  check(
    "after the update the reload resumes on after-start and the resume notice shows",
    resumedId === "after-start" &&
      notice.shown &&
      notice.text === "Earlier content you haven't seen - press u.",
    { resumedId, notice },
  );
  await pressSpace(cdp);
  await sleep(300);
  const endId = await currentItemId(page);
  const after = await page.evaluate(READ_END);
  check(
    "one screen on, at the story's end, the end card counts the unseen content and offers u",
    endId === "after-end" &&
      after.shown &&
      after.title === "Some content is still unseen." &&
      after.hint === "Press u for the next one.",
    { endId, after },
  );

  await pressU(cdp);
  await sleep(300);
  const uId = await insertedId();
  check("u lands on the first inserted item", uId === "inserted-1", { uId });

  // Back to the bookmark on text-speech (its card on the map), then Tab:
  // the burst reads on through inserted-1, now seen, and stops on it, short
  // of inserted-2; Space shows inserted-2.
  const shown = await openMap(page, cdp);
  const cards = shown.map.cards ?? [];
  if (cards.length > 0) await clickCard(cdp, cards[0]);
  await waitFor(page, MAP_CLOSED);
  await sleep(300);
  const restoredId = await currentItemId(page);
  await pressTab(cdp);
  const passed = new Set();
  for (let t = 0; t < 30; t += 1) {
    await sleep(50);
    passed.add((await insertedId()) ?? (await currentItemId(page)));
  }
  await sleep(500);
  const stopId = await insertedId();
  await pressSpace(cdp);
  await sleep(300);
  const nextId = await insertedId();
  check(
    "skip from the bookmark stops on inserted-1, short of inserted-2 (still unseen); Space then shows inserted-2",
    cards.length === 1 &&
      restoredId === "text-speech" &&
      stopId === "inserted-1" &&
      !passed.has("inserted-2") &&
      !passed.has("text-bare") &&
      nextId === "inserted-2",
    { cards: cards.length, restoredId, stopId, passed: [...passed], nextId },
  );
}

// ---- Sound controls on the Esc screen (docs/plan.md Phase 47 item 7) ----

/** `v`: sound on or off (render/keys.ts). */
const pressV = (cdp) => pressKey(cdp, "v", "KeyV", 86, "v");
/** Shift+Tab, sent like every key here: no native key code. */
async function pressShiftTab(cdp) {
  for (const type of ["keyDown", "keyUp"])
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
      modifiers: 8,
    });
}

const VOLUMES_BUTTON = '[data-config-action="volumes"]';
const VOLUMES_OPEN = () => {
  const sheet = document.getElementById("volumes");
  return sheet !== null && !sheet.hidden;
};

// The Volumes sheet as the reader sees it: open or not, its title, each
// row's label, readout and slider value, its content's centre against the
// window's, where keyboard focus is (a control's `data-config-action`,
// else the focused element's tag) and whether that is inside the sheet,
// and whether the Esc screen is still up under it.
const READ_VOLUMES = () => {
  const sheet = document.getElementById("volumes");
  const help = document.getElementById("help");
  const active = document.activeElement;
  const focus =
    active?.getAttribute?.("data-config-action") ?? active?.tagName ?? null;
  const helpUp = help !== null && !help.hidden;
  if (sheet === null || sheet.hidden) return { open: false, focus, helpUp };
  const boxes = [...sheet.children].map((el) => el.getBoundingClientRect());
  const left = Math.min(...boxes.map((b) => b.left));
  const right = Math.max(...boxes.map((b) => b.right));
  const top = Math.min(...boxes.map((b) => b.top));
  const bottom = Math.max(...boxes.map((b) => b.bottom));
  return {
    open: true,
    helpUp,
    focus,
    focusInside: sheet.contains(active),
    title: sheet.querySelector(".volumes-title")?.textContent ?? null,
    rows: [...sheet.querySelectorAll(".volume-row")].map((row) => ({
      label: row.querySelector(".config-label")?.textContent ?? null,
      value: row.querySelector(".config-value")?.textContent ?? null,
      slider: row.querySelector("input")?.value ?? null,
    })),
    offCentre: [
      Math.round((left + right) / 2 - innerWidth / 2),
      Math.round((top + bottom) / 2 - innerHeight / 2),
    ],
    inWindow:
      left >= 0 && top >= 0 && right <= innerWidth && bottom <= innerHeight,
  };
};

/**
 * A game with sound: the Keys card's `v` row and the settings' Sound row
 * (its switch, then Volumes...), and the Volumes sheet over the Esc screen:
 * centred, focus kept inside, its keys, and Esc, Done or a click outside
 * closing the sheet alone.
 */
async function soundScreen(args) {
  if (!audioBuilt(args)) return;
  const { check, open } = args;
  const { page, cdp } = await open("sound-screen", {
    folder: audioDemoDir,
    closeHelp: true,
  });
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await openSettings(page, cdp);
  const help = await page.evaluate(READ_HELP);
  const cfg = await page.evaluate(READ_CONFIG_OVERLAY);
  const row = await page.evaluate(() => {
    const r = (el) => el?.getBoundingClientRect().toJSON() ?? null;
    const sound = document.querySelector('[data-config-action="sound"]');
    return {
      sound: r(sound),
      label: sound?.textContent ?? null,
      pressed: sound?.getAttribute("aria-pressed") ?? null,
      volumes: r(document.querySelector('[data-config-action="volumes"]')),
      volumesText:
        document.querySelector('[data-config-action="volumes"]')?.textContent ??
        null,
      row: r(sound?.parentElement),
      play: r(document.querySelector(".config-play-all")?.parentElement),
    };
  });
  const vRow = help.rows.find((r) => r.key === "V");
  check(
    "a game with sound: the Keys card has V, sound on / off, after H; Settings has a Sound row in Play all routes' group, Volumes… then its switch (On), the switch under Play all routes'",
    JSON.stringify(help.rows.map((r) => r.key)) ===
      JSON.stringify(HELP_KEYS_SOUND) &&
      vRow?.desc === "sound on / off" &&
      JSON.stringify(cfg.lines) === JSON.stringify(CONFIG_LINES_SOUND) &&
      row.label === "On" &&
      row.pressed === "true" &&
      row.volumesText === "Volumes…" &&
      Math.abs(row.sound.right - cfg.playRect.right) < 1 &&
      Math.abs(row.row.top - row.play.bottom) < 1 &&
      row.volumes.right < row.sound.left &&
      Math.abs(
        (row.volumes.top + row.volumes.bottom) / 2 -
          (row.sound.top + row.sound.bottom) / 2,
      ) < 1,
    { keys: help.rows.map((r) => r.key), vRow, lines: cfg.lines, row },
  );

  // Volumes... opens the sheet, focus on its first slider.
  await clickCenter(cdp, VOLUMES_BUTTON);
  const opened = await waitFor(page, VOLUMES_OPEN, 2000);
  const sheet = await page.evaluate(READ_VOLUMES);
  check(
    "Volumes… opens a sheet centred over the Esc screen: Volumes, with Music, Effects and Voice each at 100%, focus on the Music slider",
    opened &&
      sheet.helpUp &&
      sheet.title === "Volumes" &&
      JSON.stringify(sheet.rows.map((r) => [r.label, r.value])) ===
        JSON.stringify([
          ["Music", "100%"],
          ["Effects", "100%"],
          ["Voice", "100%"],
        ]) &&
      sheet.focus === "volume-music-slider" &&
      Math.abs(sheet.offCentre[0]) <= 2 &&
      Math.abs(sheet.offCentre[1]) <= 2 &&
      sheet.inWindow,
    sheet,
  );

  // The keyboard: the arrows step the focused slider, Tab and Shift+Tab
  // move through the sheet's controls and wrap, Enter presses a button.
  await pressNavKey(cdp, "ArrowLeft", 37);
  const stepped = await page.evaluate(READ_VOLUMES);
  await pressTab(cdp);
  const onPlus = (await page.evaluate(READ_VOLUMES)).focus;
  await pressEnter(cdp);
  const pressed = await page.evaluate(READ_VOLUMES);
  const tour = [];
  for (let n = 0; n < 8; n += 1) {
    await pressTab(cdp);
    const now = await page.evaluate(READ_VOLUMES);
    tour.push(now.focusInside ? now.focus : `outside:${now.focus}`);
  }
  await pressShiftTab(cdp);
  const back = await page.evaluate(READ_VOLUMES);
  check(
    "the sheet works from the keyboard: ← steps Music to 90%, Tab reaches its + and Enter steps it back to 100%; Tab cycles through the sheet's controls to Done and wraps, Shift+Tab wraps back, focus never leaving the sheet",
    stepped.rows[0].value === "90%" &&
      stepped.rows[0].slider === "0.9" &&
      onPlus === "volume-music-up" &&
      pressed.rows[0].value === "100%" &&
      JSON.stringify(tour) ===
        JSON.stringify([
          "volume-effects-down",
          "volume-effects-slider",
          "volume-effects-up",
          "volume-voice-down",
          "volume-voice-slider",
          "volume-voice-up",
          "volumes-done",
          "volume-music-down",
        ]) &&
      back.focus === "volumes-done" &&
      back.focusInside,
    { stepped: stepped.rows[0], onPlus, pressed: pressed.rows[0], tour, back },
  );

  // Space and m do nothing under the sheet; Escape closes it alone.
  await pressSpace(cdp);
  await pressM(cdp);
  await sleep(200);
  const underKeys = await page.evaluate(READ_VOLUMES);
  const mapUp = await mapOpen(page);
  await pressEscape(cdp);
  await sleep(200);
  const escaped = await page.evaluate(READ_VOLUMES);
  check(
    "under the sheet Space and m do nothing; Escape closes the sheet alone, the Esc screen staying up with focus back on Volumes…",
    underKeys.open &&
      underKeys.helpUp &&
      !mapUp &&
      !escaped.open &&
      escaped.helpUp &&
      escaped.focus === "volumes",
    { underKeys: underKeys.open, mapUp, escaped },
  );

  // Done, and a click outside the sheet (as on the reset box), close it.
  await clickCenter(cdp, VOLUMES_BUTTON);
  await waitFor(page, VOLUMES_OPEN, 2000);
  await clickCenter(cdp, '[data-config-action="volumes-done"]');
  await sleep(150);
  const done = await page.evaluate(READ_VOLUMES);
  await clickCenter(cdp, VOLUMES_BUTTON);
  await waitFor(page, VOLUMES_OPEN, 2000);
  await clickAt(cdp, 8, 8);
  await sleep(150);
  const outside = await page.evaluate(READ_VOLUMES);
  await pressEscape(cdp);
  const closedScreen = await waitFor(page, HELP_CLOSED, 2000);
  check(
    "Done and a click outside the sheet each close it, the Esc screen staying up; Escape then closes the Esc screen",
    !done.open &&
      done.helpUp &&
      !outside.open &&
      outside.helpUp &&
      closedScreen,
    { done, outside, closedScreen },
  );
}

/**
 * The drag that ended outside the sheet (docs/plan.md Phase 52 item 11):
 * a press on the Music slider, dragged left, then right past the slider's
 * end and out of the sheet, released on the scrim, leaves the sheet open
 * (the click after a drag lands on the scrim, but the press did not start
 * there); a press and release on the scrim still close it. The same on
 * the reset box: a press on its Cancel button released on the backdrop
 * leaves it open.
 */
async function volumesDrag(args) {
  if (!audioBuilt(args)) return;
  const { check, open } = args;
  const { page, cdp } = await open("volumes-drag", {
    folder: audioDemoDir,
    closeHelp: true,
  });
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await openSettings(page, cdp);
  await clickCenter(cdp, VOLUMES_BUTTON);
  await waitFor(page, VOLUMES_OPEN, 2000);
  const geo = await page.evaluate(() => {
    const s = document
      .querySelector('[data-config-action="volume-music-slider"]')
      .getBoundingClientRect();
    const sheet = document
      .querySelector(".volumes-sheet")
      .getBoundingClientRect();
    return {
      left: s.left,
      right: s.right,
      y: s.top + s.height / 2,
      sheetRight: sheet.right,
    };
  });
  const move = (x, y, type = "mouseMoved") =>
    cdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  const mid = (geo.left + geo.right) / 2;
  await move(geo.right - 4, geo.y, "mousePressed");
  await move(mid, geo.y);
  await move(geo.left + 10, geo.y);
  await sleep(50);
  const low = await page.evaluate(READ_VOLUMES);
  await move(geo.right + 10, geo.y);
  await move(geo.sheetRight + 60, geo.y);
  await move(geo.sheetRight + 60, geo.y, "mouseReleased");
  await sleep(200);
  const after = await page.evaluate(READ_VOLUMES);
  check(
    "a drag of the Music slider that ends outside the sheet leaves the sheet open, Music back at 100%",
    low.rows[0].value !== "100%" &&
      after.open === true &&
      after.rows[0].value === "100%",
    { low: low.rows?.[0], after },
  );
  await clickAt(cdp, 8, 8);
  await sleep(150);
  const outside = await page.evaluate(READ_VOLUMES);
  check(
    "a press and release on the scrim still close the sheet",
    outside.open === false && outside.helpUp === true,
    outside,
  );

  // The reset box: a press on Cancel released on the backdrop keeps it.
  await clickCenter(cdp, CONFIG_CONTROL.reset);
  await waitFor(page, CONFIRM_OPEN);
  const cancel = await page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, CONFIRM_CONTROL.cancel);
  await move(cancel.x, cancel.y, "mousePressed");
  await move(8, 8);
  await move(8, 8, "mouseReleased");
  await sleep(150);
  const kept = await page.evaluate(CONFIRM_OPEN);
  await clickAt(cdp, 8, 8);
  await sleep(150);
  const closed = (await page.evaluate(CONFIRM_OPEN)) === false;
  check(
    "a press on the reset box's Cancel released on the backdrop leaves the box open; a press and release on the backdrop close it",
    kept === true && closed,
    { kept, closed },
  );
}

/**
 * A game without audio (fixtures/demo): its Esc screen has neither the `v`
 * row nor the Sound row, and `v` does nothing anywhere: no pill, no
 * change, no audio element.
 */
async function silentGame({ check, open }) {
  const { page, cdp } = await open("silent-game", { closeHelp: true });
  await spaceTo(page, cdp, "text-narration");
  await page.evaluate(INSTALL_PILL_LOG);
  const before = await page.evaluate(SIGNATURE);
  await pressV(cdp);
  await sleep(400);
  const after = await page.evaluate(SIGNATURE);
  await openSettings(page, cdp);
  const help = await page.evaluate(READ_HELP);
  const cfg = await page.evaluate(READ_CONFIG_OVERLAY);
  const screenBefore = await page.evaluate(READ_CONFIG_RECTS);
  await pressV(cdp);
  await sleep(400);
  const screenAfter = await page.evaluate(READ_CONFIG_RECTS);
  const page_ = await page.evaluate(() => ({
    hook: document.getElementById("audio") !== null,
    audio: document.querySelectorAll("audio").length,
    soundControls: document.querySelectorAll(
      '[data-config-action="sound"], [data-config-action="volumes"], #volumes',
    ).length,
  }));
  const pills = await readPills(page);
  check(
    "a game without audio: v shows no pill and changes nothing, over the story or the Esc screen; there is no audio element, and the Esc screen has no V row and no Sound row",
    after === before &&
      pills.length === 0 &&
      JSON.stringify(screenAfter) === JSON.stringify(screenBefore) &&
      !page_.hook &&
      page_.audio === 0 &&
      page_.soundControls === 0 &&
      JSON.stringify(help.rows.map((r) => r.key)) ===
        JSON.stringify(HELP_KEYS) &&
      JSON.stringify(cfg.lines) === JSON.stringify(CONFIG_LINES),
    { before, after, pills, page: page_, keys: help.rows.map((r) => r.key) },
  );
}

/**
 * The sound controls follow the sound a game has (docs/plan.md Phase 52
 * item 10): the Keys card's V row, the settings' Sound row (with Volumes…)
 * and `v` exist for a game with music, effects or recorded voice lines, and
 * not for one whose tracks no item names.
 */
async function soundByContent(args) {
  if (!audioBuilt(args)) return;
  const { check, open } = args;
  for (const [name, keep, controls] of [
    ["none", [], false],
    ["effects", ["effects"], true],
    ["voice", ["voice"], true],
  ]) {
    const { page, cdp } = await open(`sound-by-${name}`, {
      folder: soundFolder(`by-${name}`, keep),
      closeHelp: true,
    });
    await openSettings(page, cdp);
    const help = await page.evaluate(READ_HELP);
    const cfg = await page.evaluate(READ_CONFIG_OVERLAY);
    const volumes = await page.evaluate(
      () => document.querySelector('[data-config-action="volumes"]') !== null,
    );
    await closeSettings(page, cdp);
    await page.evaluate(INSTALL_PILL_LOG);
    await pressV(cdp);
    await sleep(300);
    const pills = await readPills(page);
    check(
      controls
        ? `a game with only ${name} sound: the Keys card has V, the settings have a Sound row with Volumes…, and v shows its pill`
        : "a game whose tracks no item names: the Keys card has no V, the settings no Sound row and no Volumes…, and v shows nothing",
      JSON.stringify(help.rows.map((r) => r.key)) ===
        JSON.stringify(controls ? HELP_KEYS_SOUND : HELP_KEYS) &&
        JSON.stringify(cfg.lines) ===
          JSON.stringify(controls ? CONFIG_LINES_SOUND : CONFIG_LINES) &&
        volumes === controls &&
        pills.length > 0 === controls,
      { keys: help.rows.map((r) => r.key), lines: cfg.lines, volumes, pills },
    );
  }
}

// Phase 52 item 15: a game app's player never names a browser. The same
// Progress help, Import button and import box read the browser's words in
// a tab and the app's with a host. The wording table is
// src/render/wording.ts; its unit test holds every text.
const BROWSER_PROGRESS_TIP =
  "Saved in this browser as you read. Export and Import carry it to another browser.";
const APP_PROGRESS_TIP =
  "Saved as you read. Export and Import carry it to another device.";
const BROWSER_IMPORT_ARIA =
  "Import progress from a file, replacing this browser's";
const APP_IMPORT_ARIA =
  "Import progress from a file, replacing the progress saved here";

/** Export through the page's own button (the file captured, not saved), then pick it as Import's file. */
async function pickExportedFile(page) {
  await page.evaluate(async () => {
    const urls = [];
    const make = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      urls.push(blob);
      return make(blob);
    };
    // The export's temporary link is not followed: nothing is downloaded.
    const clickLink = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = () => {};
    document.querySelector('[data-config-action="export-progress"]').click();
    for (let i = 0; i < 50 && urls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    HTMLAnchorElement.prototype.click = clickLink;
    URL.createObjectURL = make;
    const input = document.querySelector('[data-config-action="import-file"]');
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([urls[0]], "progress.json", { type: "application/json" }),
    );
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function readProgressWords(page) {
  return page.evaluate(() => ({
    tip: document.getElementById("config-tip-progress")?.textContent ?? null,
    aria:
      document
        .querySelector('[data-config-action="import-progress"]')
        ?.getAttribute("aria-label") ?? null,
  }));
}

async function appWording({ check, open }) {
  for (const app of [false, true]) {
    const label = app ? "with a game-app host" : "in a browser tab";
    const { page, cdp } = await open(app ? "wording-app" : "wording-tab", {
      closeHelp: true,
      ...(app ? { host: { kind: "mac-app", display: "fullscreen" } } : {}),
    });
    await openSettings(page, cdp);
    const words = await readProgressWords(page);
    check(
      app
        ? `${label}: the Progress help and the Import button say no browser`
        : `${label}: the Progress help and the Import button keep today's words`,
      app
        ? words.tip === APP_PROGRESS_TIP &&
            words.aria === APP_IMPORT_ARIA &&
            !/browser/i.test(`${words.tip} ${words.aria}`)
        : words.tip === BROWSER_PROGRESS_TIP &&
            words.aria === BROWSER_IMPORT_ARIA,
      words,
    );
    await pickExportedFile(page);
    const asked = await waitFor(page, () => {
      const box = document.getElementById("confirm");
      return box !== null && !box.hidden;
    });
    const box = await page.evaluate(READ_CONFIRM_OVERLAY);
    const title = manifest.title;
    check(
      app
        ? `${label}: the import box says no browser`
        : `${label}: the import box keeps today's words`,
      asked &&
        (app
          ? box.message ===
              `Replace the progress saved here for ${title} with the imported file?` &&
            !/browser/i.test(box.message)
          : box.message ===
            `Replace this browser's progress for ${title} with the imported file?`),
      { asked, message: box.message },
    );
  }
}

// Independent parts (each opens its own browser); the runner runs them
// side by side and prints their checks in this order. A part that throws
// gets a FAIL "<part> completed" and the others still run.
export const parts = [
  helpFirstLoadClick,
  helpMidFlow,
  escToMap,
  bookmarks,
  manyBookmarks,
  bookmarkSpeed,
  resume,
  config,
  escLayout,
  escLayoutAudio,
  soundScreen,
  volumesDrag,
  soundByContent,
  silentGame,
  escTips,
  settingsImmediateReload,
  emptyFolder,
  reset,
  contentUpdate,
  insertedContent,
  appWording,
];
