// Export / import progress (docs/plan.md Phase 21): progress read in one
// browser moves to another. The first browser reads a few items, bookmarks
// one, sets 2.00x, and exports from the `c` screen: a real download of
// `<storyId>-progress.json`. A second, fresh browser profile opens the same
// folder: another story's file is refused in the panel and changes
// nothing; the real file asks to confirm, replaces this browser's progress
// and reloads onto the same item, with the bookmark and the speed. From
// there saving is automatic again: one more item and a reload resume there.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_SETTINGS } from "../../src/machine/types.ts";
import { speedLabel } from "../../src/render/config.ts";
import {
  CONFIG_OPEN,
  CONFIRM_OPEN,
  clickCenter,
  currentItemId,
  demoDir,
  item,
  manifest,
  OVERLAY_OPEN,
  PAGE_STATE,
  pressB,
  pressC,
  pressSpace,
  pressT,
  READ_BOOKMARK_OVERLAY,
  READ_CONFIG_OVERLAY,
  READ_CONFIRM_OVERLAY,
  readBookmarks,
  sleep,
  spaceTo,
} from "./harness.mjs";

export const title =
  "export / import progress: move a reader's progress to a fresh browser";

const SPEED_2X = speedLabel(2, DEFAULT_SETTINGS.msPerChar);
const FLASH_SHOWN = () =>
  (document.getElementById("flash")?.textContent ?? "") === "Bookmarked";
const PAINTED = () =>
  (document.getElementById("visual-image")?.getAttribute("src") ?? "") !== "";

const waitFor = async (page, fn, timeout = 5000) => {
  try {
    await page.waitForFunction(fn, { timeout });
    return true;
  } catch {
    return false;
  }
};

/** Polls for a finished download (Chrome writes `.crdownload` first). */
async function waitForFile(path, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (existsSync(path)) return true;
    await sleep(100);
  }
  return false;
}

/** Click Import in the open `c` panel and answer the picker with `path`. */
async function importFile(page, cdp, path) {
  const cfg = await page.evaluate(READ_CONFIG_OVERLAY);
  const [chooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 5000 }),
    clickCenter(cdp, cfg.importRect),
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
  await pressC(a.cdp);
  await waitFor(a.page, CONFIG_OPEN);
  for (let i = 0; i < 4; i += 1) {
    const r = await a.page.evaluate(READ_CONFIG_OVERLAY);
    await clickCenter(a.cdp, r.speedUpRect);
  }
  const cfgA = await a.page.evaluate(READ_CONFIG_OVERLAY);
  await clickCenter(a.cdp, cfgA.exportRect);
  const exportedPath = join(downloads, fileName);
  const downloaded = await waitForFile(exportedPath);
  await sleep(200);
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
      afterExport.hidden === false &&
      afterExport.message === `Exported ${fileName}.`,
    {
      downloaded,
      kind: file?.kind,
      storyId: file?.storyId,
      lastShown: file?.state?.ctx?.lastShown,
      speed: file?.state?.settings?.readingSpeed,
      marks: file?.bookmarks?.map((b) => b.itemId),
      message: afterExport.message,
    },
  );

  // 2. A fresh browser on the same folder, at the first item.
  const b = await open("target", { closeHelp: true });
  const startId = await currentItemId(b.page);
  await pressC(b.cdp);
  await waitFor(b.page, CONFIG_OPEN);

  // Another story's file is refused in the panel; nothing changes.
  const wrongPath = join(downloads, "other-tale-progress.json");
  writeFileSync(
    wrongPath,
    JSON.stringify({ ...file, storyId: "other-tale", title: "Other Tale" }),
  );
  await importFile(b.page, b.cdp, wrongPath);
  await waitFor(
    b.page,
    () => !(document.querySelector(".config-message")?.hidden ?? true),
  );
  const refused = await b.page.evaluate(READ_CONFIG_OVERLAY);
  const boxAfterWrong = await b.page.evaluate(CONFIRM_OPEN);
  const marksAfterWrong = await readBookmarks(b.page);
  check(
    "another story's file is refused in the panel, naming it; no box, nothing stored",
    startId === item("intro-title").id &&
      refused.hidden === false &&
      refused.message ===
        `That file holds progress for "Other Tale", not "${manifest.title}".` &&
      boxAfterWrong === false &&
      marksAfterWrong.length === 0,
    { startId, message: refused.message, boxAfterWrong, marksAfterWrong },
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
    clickCenter(b.cdp, box.resetRect),
  ]);
  const painted = await waitFor(b.page, PAINTED);
  await sleep(400);
  const resumed = await b.page.evaluate(PAGE_STATE);
  const resumedId = await currentItemId(b.page);
  await pressT(b.cdp);
  await waitFor(b.page, OVERLAY_OPEN);
  const list = await b.page.evaluate(READ_BOOKMARK_OVERLAY);
  await pressT(b.cdp);
  await pressC(b.cdp);
  await waitFor(b.page, CONFIG_OPEN);
  const cfgB = await b.page.evaluate(READ_CONFIG_OVERLAY);
  await pressC(b.cdp);
  const rows = list.entries ?? [];
  check(
    "the real file asks to confirm, then reloads onto the same item with the bookmark and 2.00x, help closed",
    asked &&
      box.title === "Import progress" &&
      box.message ===
        `Replace this browser's progress for ${manifest.title} with the imported file?` &&
      box.resetLabel === "Import" &&
      reloaded &&
      painted &&
      resumedId === reached.id &&
      resumed.helpOpen === false &&
      rows.length === 1 &&
      rows[0].itemIndex === marked.index &&
      cfgB.speedValue === SPEED_2X,
    {
      box,
      reloaded,
      resumedId,
      help: resumed.helpOpen,
      rows: rows.map((r) => r.itemIndex),
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
