// Story ID (docs/plan.md Phase 21): progress follows the story, not the
// folder. A copy of the demo whose manifest predates `storyId` keeps its
// progress by folder URL as before; once its manifest gains the demo's
// `storyId` the next load carries that progress over to the story; then the
// folder is moved to a new path, renamed, and opened there: the reading
// position and the bookmark (its card on the branch map, docs/plan.md
// Phase 35) are still there.

import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  currentItemId,
  demoDir,
  item,
  MAP_READY,
  manifest,
  PAGE_STATE,
  pressB,
  pressM,
  READ_MAP_CARDS,
  readBookmarks,
  sleep,
  spaceTo,
} from "./harness.mjs";

export const title =
  "story ID: progress survives moving or renaming the folder";

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

/** The raw `state` record under `key` (null when absent). */
const READ_STATE_AT = async (key) => {
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
        .get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
};

const FOLDER_URL = () => new URL(".", document.baseURI).href;

function writeManifest(folder, value) {
  const text = JSON.stringify(value, null, 2);
  writeFileSync(join(folder, "manifest.json"), `${text}\n`);
  writeFileSync(
    join(folder, "manifest.js"),
    `window.KINETIC_MANIFEST = ${text};\n`,
  );
}

export default async function ({ check, open }) {
  const root = dirname(demoDir);
  const oldFolder = join(root, "storyid-shelf", "dawn");
  const movedFolder = join(root, "storyid-archive", "dawn-renamed");
  rmSync(join(root, "storyid-shelf"), { recursive: true, force: true });
  rmSync(join(root, "storyid-archive"), { recursive: true, force: true });
  cpSync(demoDir, oldFolder, { recursive: true });
  const demoManifest = JSON.parse(
    readFileSync(join(demoDir, "manifest.json"), "utf8"),
  );
  const { storyId, ...legacyManifest } = demoManifest;
  writeManifest(oldFolder, legacyManifest);

  const marked = item("text-narration");
  const reached = item("text-bare");
  const { page, cdp } = await open("move", {
    closeHelp: true,
    folder: oldFolder,
  });

  // 1. A manifest without storyId: progress is kept by the folder URL.
  const walked1 = await spaceTo(page, cdp, marked.id);
  await pressB(cdp);
  const flashed = await waitFor(page, FLASH_SHOWN);
  const walked2 = await spaceTo(page, cdp, reached.id);
  await sleep(300);
  const oldUrl = await page.evaluate(FOLDER_URL);
  const legacyRecord = await page.evaluate(READ_STATE_AT, oldUrl);
  await page.reload();
  const painted1 = await waitFor(page, PAINTED);
  const legacyResume = await currentItemId(page);
  const legacyMarks = await readBookmarks(page);
  check(
    "a manifest without storyId still resumes and lists its bookmark, keyed by the folder URL",
    storyId === manifest.storyId &&
      typeof storyId === "string" &&
      walked1 &&
      flashed &&
      walked2 &&
      legacyRecord?.ctx?.lastShown === reached.id &&
      painted1 &&
      legacyResume === reached.id &&
      legacyMarks.length === 1 &&
      legacyMarks[0].itemId === marked.id,
    {
      storyId,
      legacyRecord: legacyRecord?.ctx?.lastShown,
      legacyResume,
      legacyMarks,
    },
  );

  // 2. The folder is re-converted: its manifest now names the story. The
  // next load carries the folder's progress over to the story ID.
  writeManifest(oldFolder, demoManifest);
  await page.reload();
  const painted2 = await waitFor(page, PAINTED);
  const carriedResume = await currentItemId(page);
  const carriedMarks = await readBookmarks(page);
  const storyRecord = await page.evaluate(READ_STATE_AT, `story:${storyId}`);
  const leftUnderUrl = await page.evaluate(READ_STATE_AT, oldUrl);
  check(
    "the first load with a storyId carries the folder's progress and bookmark over to the story",
    painted2 &&
      carriedResume === reached.id &&
      carriedMarks.length === 1 &&
      carriedMarks[0].itemId === marked.id &&
      storyRecord?.ctx?.lastShown === reached.id &&
      leftUnderUrl === null,
    {
      carriedResume,
      carriedMarks,
      storyRecord: storyRecord?.ctx?.lastShown,
      leftUnderUrl,
    },
  );

  // 3. Move and rename the folder, open it at its new path. The page
  // leaves first: a preload still running against the deleted folder
  // would be a console error, not a finding.
  await page.goto("about:blank");
  cpSync(oldFolder, movedFolder, { recursive: true });
  rmSync(join(root, "storyid-shelf"), { recursive: true, force: true });
  await page.goto(pathToFileURL(join(movedFolder, "index.html")).href);
  const painted3 = await waitFor(page, PAINTED);
  const movedState = await page.evaluate(PAGE_STATE);
  const movedResume = await currentItemId(page);
  const movedUrl = await page.evaluate(FOLDER_URL);
  await pressM(cdp);
  const mapReady = await waitFor(page, MAP_READY);
  const { cards = [] } = await page.evaluate(READ_MAP_CARDS);
  check(
    "after moving and renaming the folder it resumes where the reader was, help closed, and m shows the bookmark's card on the map",
    painted3 &&
      movedUrl !== oldUrl &&
      movedResume === reached.id &&
      movedState.helpOpen === false &&
      mapReady &&
      cards.length === 1 &&
      cards[0].itemId === marked.id &&
      cards[0].itemIndex === marked.index,
    {
      movedUrl,
      movedResume,
      help: movedState.helpOpen,
      mapReady,
      cards: cards.map((c) => [c.itemId, c.itemIndex]),
    },
  );
}
