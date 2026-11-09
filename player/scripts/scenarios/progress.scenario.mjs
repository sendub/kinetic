// Export / import progress (docs/plan.md Phase 21): progress read in one
// browser moves to another. The first browser reads a few items, bookmarks
// one, sets 2.00x, and exports from the Esc screen's settings: a real download of
// `<storyId>-progress.json`. A second, fresh browser profile opens the same
// folder: another story's file is refused and changes nothing; the real
// file asks to confirm, replaces this browser's progress and reloads onto
// the same item, with the bookmark (its card on the branch map,
// docs/plan.md Phase 35) and the speed. From there saving is automatic
// again: one more item and a reload resume there.
//
// Export's confirmation and an Import refusal are the `#flash` pill over
// the Esc screen (docs/plan.md Phase 43 item 12): "Progress exported" with
// no file name, a refusal held longer than a mode pill, and nothing on the
// screen moving when either shows.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EXPORT_DONE_NOTICE } from "../../src/render/config.ts";
import {
  CONFIG_CONTROL,
  CONFIRM_CONTROL,
  CONFIRM_OPEN,
  clickCenter,
  closeSettings,
  currentItemId,
  demoDir,
  item,
  MAP_CLOSED,
  MAP_READY,
  manifest,
  openSettings,
  PAGE_STATE,
  pressB,
  pressM,
  pressSpace,
  READ_CONFIG_OVERLAY,
  READ_CONFIG_RECTS,
  READ_CONFIRM_OVERLAY,
  READ_MAP_CARDS,
  READ_PILL,
  readBookmarks,
  sleep,
  spaceTo,
} from "./harness.mjs";

export const title =
  "export / import progress: move a reader's progress to a fresh browser";

// The readout as the reader sees it at 2.00x (Phase 43 item 12).
const SPEED_2X = "2.00x (~30 ms/char)";
// A mode pill's hold (render/app.ts ROUTE_PILL_MS, restated: app.ts imports
// modules by extensionless paths node cannot resolve).
const ROUTE_PILL_MS = 1600;
const FLASH_SHOWN = () =>
  (document.getElementById("flash")?.textContent ?? "") === "Bookmarked";
const PAINTED = () =>
  (document.getElementById("visual-image")?.getAttribute("src") ?? "") !== "";

const waitFor = async (page, fn, timeout = 5000, arg = undefined) => {
  try {
    await page.waitForFunction(fn, { timeout }, arg);
    return true;
  } catch {
    return false;
  }
};
/** Waits for the `#flash` pill to say `text`; true once it does. */
const pillSays = (page, text) =>
  waitFor(
    page,
    (t) => document.getElementById("flash")?.textContent === t,
    5000,
    text,
  );

/** Polls for a finished download (Chrome writes `.crdownload` first). */
async function waitForFile(path, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (existsSync(path)) return true;
    await sleep(100);
  }
  return false;
}

/** Click Import in the open Esc screen's settings and answer the picker with `path`. */
async function importFile(page, cdp, path) {
  const [chooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 5000 }),
    clickCenter(cdp, CONFIG_CONTROL.importProgress),
  ]);
  await chooser.accept([path]);
}

export default async function ({ check, open }) {
  const storyId = manifest.storyId;
  const fileName = `${storyId}-progress.json`;
  // Absolute: Chrome never completes a download into a relative path (the
  // scenario root may be relative, KINETIC_SCENARIO_ROOT=../.tmp/…).
  const downloads = resolve(dirname(demoDir), "downloads-progress");
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(downloads, { recursive: true });

  const marked = item("text-narration");
  const reached = item("text-bare");

  // 1. The first browser: read, bookmark, 2.00x, export.
  const a = await open("source", { closeHelp: true });
  const browserCdp = await a.browser.target().createCDPSession();
  await browserCdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloads,
  });
  const walked1 = await spaceTo(a.page, a.cdp, marked.id);
  await pressB(a.cdp);
  const flashed = await waitFor(a.page, FLASH_SHOWN);
  const walked2 = await spaceTo(a.page, a.cdp, reached.id);
  await openSettings(a.page, a.cdp);
  for (let i = 0; i < 4; i += 1) {
    await clickCenter(a.cdp, CONFIG_CONTROL.speedUp);
  }
  const cfgA = await a.page.evaluate(READ_CONFIG_OVERLAY);
  const rowsBefore = await a.page.evaluate(READ_CONFIG_RECTS);
  await clickCenter(a.cdp, CONFIG_CONTROL.exportProgress);
  const exportedPath = join(downloads, fileName);
  const downloaded = await waitForFile(exportedPath);
  const pillShown = await pillSays(a.page, EXPORT_DONE_NOTICE);
  const pill = await a.page.evaluate(READ_PILL);
  const rowsAfter = await a.page.evaluate(READ_CONFIG_RECTS);
  const afterExport = await a.page.evaluate(READ_CONFIG_OVERLAY);
  let file = null;
  try {
    file = JSON.parse(readFileSync(exportedPath, "utf8"));
  } catch {}
  check(
    `Export progress downloads ${fileName} holding the position, settings, help flag and the bookmark`,
    walked1 &&
      flashed &&
      walked2 &&
      cfgA.speedValue === SPEED_2X &&
      downloaded &&
      file?.kind === "kinetic-progress" &&
      file?.version === 1 &&
      file?.storyId === storyId &&
      file?.title === manifest.title &&
      file?.state?.ctx?.lastShown === reached.id &&
      file?.state?.settings?.readingSpeed === 2 &&
      file?.state?.helpSeen === true &&
      file?.bookmarks?.length === 1 &&
      file.bookmarks[0].itemId === marked.id &&
      afterExport.hidden === false,
    {
      downloaded,
      kind: file?.kind,
      storyId: file?.storyId,
      lastShown: file?.state?.ctx?.lastShown,
      speed: file?.state?.settings?.readingSpeed,
      marks: file?.bookmarks?.map((b) => b.itemId),
    },
  );
  // The confirmation is the pill, above the open Esc screen and solid
  // there, naming no file (the browser or app may rename it); the screen
  // has no message line, so every settings row stays where it was.
  check(
    'Export says "Progress exported" in the pill, solid above the open Esc screen, and moves nothing: every settings row keeps its place',
    pillShown &&
      pill?.text === "Progress exported" &&
      pill.shown &&
      pill.helpOpen &&
      pill.z > pill.helpZ &&
      pill.background === "rgb(30, 30, 35)" &&
      pill.inWindow &&
      afterExport.noMessageLine &&
      rowsAfter.length === rowsBefore.length &&
      JSON.stringify(rowsAfter) === JSON.stringify(rowsBefore),
    { pill, rowsBefore, rowsAfter },
  );

  // 2. A fresh browser on the same folder, at the first item.
  const b = await open("target", { closeHelp: true });
  const startId = await currentItemId(b.page);
  await openSettings(b.page, b.cdp);

  // Another story's file is refused in the pill; nothing changes, on the
  // screen or in storage. The refusal holds longer than a mode pill
  // (ROUTE_PILL_MS, then a fade): still fully shown 600 ms past that hold.
  const wrongPath = join(downloads, "other-tale-progress.json");
  writeFileSync(
    wrongPath,
    JSON.stringify({ ...file, storyId: "other-tale", title: "Other Tale" }),
  );
  const refusal = `That file holds progress for "Other Tale", not "${manifest.title}".`;
  const rowsBeforeWrong = await b.page.evaluate(READ_CONFIG_RECTS);
  await importFile(b.page, b.cdp, wrongPath);
  const refusedShown = await pillSays(b.page, refusal);
  const shownAt = Date.now();
  const refused = await b.page.evaluate(READ_CONFIG_OVERLAY);
  const rowsAfterWrong = await b.page.evaluate(READ_CONFIG_RECTS);
  const boxAfterWrong = await b.page.evaluate(CONFIRM_OPEN);
  const marksAfterWrong = await readBookmarks(b.page);
  await sleep(Math.max(0, ROUTE_PILL_MS + 600 - (Date.now() - shownAt)));
  const held = await b.page.evaluate(READ_PILL);
  const heldMs = Date.now() - shownAt;
  check(
    "another story's file is refused in the pill, naming it, held longer than a mode pill; nothing on the screen moves; no box, nothing stored",
    startId === item("intro-title").id &&
      refusedShown &&
      refused.hidden === false &&
      held?.text === refusal &&
      held.shown &&
      heldMs >= ROUTE_PILL_MS + 600 &&
      JSON.stringify(rowsAfterWrong) === JSON.stringify(rowsBeforeWrong) &&
      boxAfterWrong === false &&
      marksAfterWrong.length === 0,
    { startId, refusedShown, held, heldMs, boxAfterWrong, marksAfterWrong },
  );

  // The real file: the box asks, Import replaces and reloads.
  await importFile(b.page, b.cdp, exportedPath);
  const asked = await waitFor(b.page, CONFIRM_OPEN);
  const box = await b.page.evaluate(READ_CONFIRM_OVERLAY);
  const [reloaded] = await Promise.all([
    b.page
      .waitForNavigation({ waitUntil: "load", timeout: 8000 })
      .then(() => true)
      .catch(() => false),
    clickCenter(b.cdp, CONFIRM_CONTROL.confirm),
  ]);
  const painted = await waitFor(b.page, PAINTED);
  await sleep(400);
  const resumed = await b.page.evaluate(PAGE_STATE);
  const resumedId = await currentItemId(b.page);
  await pressM(b.cdp);
  const mapReady = await waitFor(b.page, MAP_READY);
  const { cards = [] } = await b.page.evaluate(READ_MAP_CARDS);
  await pressM(b.cdp);
  const mapClosed = await waitFor(b.page, MAP_CLOSED);
  await openSettings(b.page, b.cdp);
  const cfgB = await b.page.evaluate(READ_CONFIG_OVERLAY);
  await closeSettings(b.page, b.cdp);
  check(
    "the real file asks to confirm, then reloads onto the same item with the bookmark (its card on the map) and 2.00x, help closed",
    asked &&
      box.title === "Import progress" &&
      box.message ===
        `Replace this browser's progress for ${manifest.title} with the imported file?` &&
      box.resetLabel === "Import" &&
      reloaded &&
      painted &&
      resumedId === reached.id &&
      resumed.helpOpen === false &&
      mapReady &&
      cards.length === 1 &&
      cards[0].itemIndex === marked.index &&
      mapClosed &&
      cfgB.speedValue === SPEED_2X,
    {
      box,
      reloaded,
      resumedId,
      help: resumed.helpOpen,
      mapReady,
      cards: cards.map((c) => c.itemIndex),
      mapClosed,
      speed: cfgB.speedValue,
    },
  );

  // 3. Saving is automatic again: one more item, a reload resumes there.
  await pressSpace(b.cdp);
  await sleep(300);
  const nextId = await currentItemId(b.page);
  await b.page.reload();
  await waitFor(b.page, PAINTED);
  await sleep(400);
  const againId = await currentItemId(b.page);
  check(
    "after the import, progress saves automatically: the next item survives a reload",
    nextId !== null && nextId !== reached.id && againId === nextId,
    { nextId, againId },
  );
}
