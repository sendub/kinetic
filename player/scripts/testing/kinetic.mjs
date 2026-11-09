// Testing a built Kinetic game folder with no window on screen (CREATE.md,
// "Testing your game"). A creator's own script imports this file by its
// absolute path:
//
//   import { openGame } from "/path/to/kinetic/player/scripts/testing/kinetic.mjs";
//   const game = await openGame("my-game", { playAll: false });
//   await game.spaceUntil((now) => now.choice !== null);
//   await game.pickRoute(1);
//   await game.close();
//
// It plays the folder's own index.html and app.js, so it tests what ships,
// in the hidden WebKit driver (the engine of the macOS app and Safari) or
// in headless Chrome (Chrome, and the Windows app's WebView2). Neither shows a
// window. check-game.mjs beside it is a small example in use.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { platform } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DriverBuildError, ensureDriver } from "../webkit/build.mjs";
import {
  CHOICE_CLOSED,
  closeBrowser,
  collectErrors,
  dismissHelp,
  indexItems,
  keyFor,
  launchBrowser,
  lookupItems,
  MAP_OPEN,
  PAGE_STATE,
  pressEscapeSeen,
  pressNamed,
  READ_CHOICE,
  setPlayAll,
  sleep,
} from "./core.mjs";

const scratch = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".tmp",
);

/** What each engine stands for, as openGame reports its choice. */
export const ENGINE_NAMES = {
  webkit: "WebKit (the macOS app and Safari)",
  chrome: "Chrome (Chrome and the Windows app)",
};

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
// How long the player may take to start after the page loads.
const START_MS = 10000;
// Between two presses of one press() or spaceUntil(), as a quick reader.
const PRESS_GAP_MS = 90;
// spaceUntil gives up once Space has changed nothing this many times.
const STUCK_PRESSES = 5;

/**
 * The engine openGame runs: "webkit" or "chrome" as asked; "auto" is
 * WebKit on macOS when its driver builds, else Chrome, and `log` gets one
 * line saying which. `system` stands in for the platform and the driver
 * build in the unit tests.
 */
export function chooseEngine(
  engine,
  log,
  system = { platform: platform(), ensureDriver },
) {
  if (engine === "webkit" || engine === "chrome") return engine;
  if (engine !== "auto") {
    throw new Error(
      `openGame: engine must be "webkit", "chrome" or "auto", not ${JSON.stringify(engine)}`,
    );
  }
  let reason = "WebKit needs macOS";
  if (system.platform === "darwin") {
    try {
      system.ensureDriver();
      log?.(`openGame: testing on ${ENGINE_NAMES.webkit}`);
      return "webkit";
    } catch (error) {
      if (!(error instanceof DriverBuildError)) throw error;
      reason = error.message;
    }
  }
  log?.(`openGame: testing on ${ENGINE_NAMES.chrome}. ${reason}`);
  return "chrome";
}

/**
 * Narrows `hits`, the items a screen's line or picture matched (several
 * when a game repeats one), to those whose speaker is the one shown and
 * whose own picture (if they have one) is painted. A filter that would
 * leave none is skipped.
 */
export function narrowItems(items, hits, { speaker, files }) {
  let left = hits;
  const bySpeaker = left.filter((i) => (items[i].speaker ?? "") === speaker);
  if (bySpeaker.length > 0) left = bySpeaker;
  const byPicture = left.filter((i) => {
    const own = picturesOf(items[i]);
    return own.length === 0 || own.some((file) => files.includes(file));
  });
  if (byPicture.length > 0) left = byPicture;
  return left;
}

const picturesOf = (it) =>
  [it.file, it.poster, ...(Array.isArray(it.frames) ? it.frames : [])].filter(
    (file) => typeof file === "string",
  );

/** The hit at or after `lastIndex` (reading moves forward), else the first. */
export const nearestAfter = (hits, lastIndex) =>
  hits.find((i) => i >= lastIndex) ?? hits[0];

/**
 * Which manifest item a screen is, and how that was found (current()'s
 * `foundBy`): `now` is what current() read from the page (READ_NOW).
 * - "player": the stage's `data-item`, the id the player itself puts on
 *   the page (a folder built with a current player);
 * - "screen": a folder with an older player, whose screen (its line, else
 *   its picture) only one item makes, after narrowItems;
 * - "saved place": several items make it, and the player's saved place is
 *   one of them;
 * - "guess": several items make it and the saved place is none of them;
 *   the nearest at or after `lastIndex` is taken and `ambiguous` lists
 *   their ids;
 * - "none": no item makes it (a notice, the empty state); index -1.
 * `game` gives the manifest's `items`, `ids` (id -> index), `lookup(screen)`
 * (matchItems's hits) and `savedAmong(hits)` (the saved place's index when
 * it is one of `hits`, else null). Resolves with `{ index, foundBy,
 * ambiguous }`.
 */
export async function findItem(game, now, lastIndex) {
  const named = now.dataItem === null ? undefined : game.ids.get(now.dataItem);
  if (named !== undefined) {
    return { index: named, foundBy: "player", ambiguous: [] };
  }
  const s = now.state;
  const videoShown = s.video?.visible === true;
  let hits = game.lookup({
    text: s.text,
    file: videoShown ? s.video.poster : s.imgSrc,
  });
  if (hits.length > 1) {
    hits = narrowItems(game.items, hits, {
      speaker: s.speaker ?? "",
      files: videoShown ? [s.video.src, s.video.poster] : [s.imgSrc],
    });
  }
  if (hits.length === 0) return { index: -1, foundBy: "none", ambiguous: [] };
  if (hits.length === 1) {
    return { index: hits[0], foundBy: "screen", ambiguous: [] };
  }
  // Two items the reader cannot tell apart: the player's own saved place
  // says which, else the nearest ahead of the last one found.
  const saved = await game.savedAmong(hits);
  if (saved !== null) {
    return { index: saved, foundBy: "saved place", ambiguous: [] };
  }
  return {
    index: nearestAfter(hits, lastIndex),
    foundBy: "guess",
    ambiguous: hits.map((i) => game.items[i].id),
  };
}

// The stage's `data-item` (docs/plan.md Phase 46, item 2): the id of the
// item whose screen the player shows; null from an older player.
const STAGE_ITEM = () =>
  document.getElementById("stage")?.getAttribute("data-item") ?? null;

// Everything current() reports, read in one round trip.
const READ_NOW = `({
  state: (${PAGE_STATE})(),
  dataItem: (${STAGE_ITEM})(),
  choice: (${READ_CHOICE})(),
  map: (${MAP_OPEN})(),
  playAll: document.querySelector(".config-play-all")?.getAttribute("aria-pressed") ?? null,
})`;

// The item the player last saved as on screen (`ctx.lastShown` in its
// state record, src/storage/idb.ts), under the story's storage key: the
// manifest's storyId when valid, else the folder URL. Read only; null
// when there is none.
const READ_SAVED_PLACE = async (storyId) => {
  const key =
    typeof storyId === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(storyId)
      ? `story:${storyId}`
      : new URL(".", document.baseURI).href;
  const db = await new Promise((done) => {
    const open = indexedDB.open("kinetic");
    // No database yet: abort rather than create an empty one.
    open.onupgradeneeded = () => open.transaction.abort();
    open.onsuccess = () => done(open.result);
    open.onerror = () => done(null);
  });
  if (db === null) return null;
  try {
    if (!db.objectStoreNames.contains("state")) return null;
    const record = await new Promise((done) => {
      const req = db.transaction("state").objectStore("state").get(key);
      req.onsuccess = () => done(req.result);
      req.onerror = () => done(null);
    });
    return record?.ctx?.lastShown ?? null;
  } finally {
    db.close();
  }
};

// In the page, on both engines: every media file the document is given
// (an <img>'s src, a <video>'s src and poster) is followed until it is
// confirmed (its element's `load` or `loadeddata`) or failed, which is
// logged once per file as `Failed to load resource: <its URL>`: WebKit
// logs no failed load, and Chrome logs only a missing file, not one it
// cannot decode (collectErrors lists each URL once). A file its element
// moved on from before either event (a fast walk aborts the load, and an
// aborted load fires none), one whose element left the page, and every
// poster (painted as a CSS background too, which fires no event) is
// checked off the page instead, a few at a time: a picture decoded
// through `new Image()`, a video loaded in a detached <video>; these wait
// until no new file has come for a moment, so a fast walk is not slowed. A
// failed <script> or <link> is logged as it fails. checkMedia() asks
// `window.__kineticMedia` to check what is left and reads its count.
const TRACK_MEDIA = () => {
  const CHECKS_AT_ONCE = 4;
  // Checks wait while files keep coming (a walk), so they never compete
  // with it: they run once none has come for this long, or while
  // checkMedia() drains them.
  const QUIET_MS = 300;
  // A video with no first picture by then, from a local file, is failed.
  const VIDEO_CHECK_MS = 15000;
  // URL -> { kind: "picture" | "video", state: "given" (on an element, no
  // event yet), "queued", "checking", "ok" or "failed" }.
  const files = new Map();
  const queue = [];
  let checking = 0;
  let lastGiven = 0;
  let draining = false;
  let wake = null;
  const absolute = (src) => new URL(src, document.baseURI).href;
  const fail = (url, kind) => {
    const file = files.get(url);
    if (file?.state === "failed") return;
    if (file === undefined) files.set(url, { kind, state: "failed" });
    else file.state = "failed";
    console.error(`Failed to load resource: ${url}`);
  };
  const confirm = (url, kind) => {
    const file = files.get(url);
    if (file === undefined) files.set(url, { kind, state: "ok" });
    else if (file.state !== "failed") file.state = "ok";
  };
  const checkPicture = (url) => {
    const img = new Image();
    img.src = url;
    return img.decode().then(
      () => true,
      () => false,
    );
  };
  const checkVideo = (url) =>
    new Promise((done) => {
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      let timer = 0;
      const finish = (ok) => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
        video.removeAttribute("src");
        video.load(); // lets the file go
        done(ok);
      };
      timer = setTimeout(() => finish(false), VIDEO_CHECK_MS);
      video.addEventListener("loadeddata", () => finish(true));
      video.addEventListener("error", () => finish(false));
      video.src = url;
    });
  const pump = () => {
    const quiet = performance.now() - lastGiven;
    if (!draining && quiet < QUIET_MS) {
      if (wake === null && queue.length > 0) {
        wake = setTimeout(() => {
          wake = null;
          pump();
        }, QUIET_MS - quiet);
      }
      return;
    }
    while (checking < CHECKS_AT_ONCE && queue.length > 0) {
      const url = queue.shift();
      const file = files.get(url);
      if (file.state !== "queued") continue; // its element answered first
      file.state = "checking";
      checking += 1;
      const check = file.kind === "video" ? checkVideo : checkPicture;
      check(url).then((ok) => {
        checking -= 1;
        if (file.state === "checking") {
          if (ok) file.state = "ok";
          else fail(url, file.kind);
        }
        pump();
      });
    }
  };
  const enqueue = (url) => {
    const file = files.get(url);
    if (file?.state !== "given") return;
    file.state = "queued";
    queue.push(url);
    pump();
  };
  const given = (value, kind) => {
    if (!value) return null; // a cleared src is no load
    const url = absolute(value);
    if (!files.has(url)) {
      files.set(url, { kind, state: "given" });
      lastGiven = performance.now();
      draining = false; // a walk again: checks wait for it
    }
    return url;
  };
  // The media attributes an element carries, as [attribute, kind].
  const MEDIA = {
    IMG: [["src", "picture"]],
    VIDEO: [
      ["src", "video"],
      ["poster", "picture"],
    ],
  };
  const each = (node, visit) => {
    if (!(node instanceof Element)) return;
    for (const el of [node, ...node.querySelectorAll("img, video")]) {
      for (const [attr, kind] of MEDIA[el.tagName] ?? []) {
        visit(el.getAttribute(attr), kind, attr);
      }
    }
  };
  const onScreen = (value, kind, attr) => {
    const url = given(value, kind);
    if (url !== null && attr === "poster") enqueue(url);
  };
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList") {
        for (const node of record.addedNodes) each(node, onScreen);
        for (const node of record.removedNodes) {
          each(node, (value, kind) => {
            const url = given(value, kind);
            if (url !== null) enqueue(url);
          });
        }
        continue;
      }
      const kind = (MEDIA[record.target.tagName] ?? []).find(
        ([attr]) => attr === record.attributeName,
      )?.[1];
      if (kind === undefined) continue;
      // The value it had is replaced: no event will come for it now.
      const before = given(record.oldValue, kind);
      if (before !== null) enqueue(before);
      onScreen(
        record.target.getAttribute(record.attributeName),
        kind,
        record.attributeName,
      );
    }
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["src", "poster"],
  });
  const sourceOf = (el) =>
    el.currentSrc || el.getAttribute("src") || el.getAttribute("href");
  window.addEventListener(
    "load",
    (event) => {
      const el = event.target;
      if (el instanceof HTMLImageElement && sourceOf(el)) {
        confirm(absolute(sourceOf(el)), "picture");
      }
    },
    true,
  );
  window.addEventListener(
    "loadeddata",
    (event) => {
      const el = event.target;
      if (el instanceof HTMLVideoElement && sourceOf(el)) {
        confirm(absolute(sourceOf(el)), "video");
      }
    },
    true,
  );
  window.addEventListener(
    "error",
    (event) => {
      const el = event.target;
      if (!(el instanceof Element)) return;
      const src = sourceOf(el);
      if (!src) return;
      if (el instanceof HTMLImageElement) fail(absolute(src), "picture");
      else if (el instanceof HTMLVideoElement) fail(absolute(src), "video");
      else console.error(`Failed to load resource: ${absolute(src)}`);
    },
    true,
  );
  Object.defineProperty(window, "__kineticMedia", {
    value: {
      // Queues every file still waiting on its element, and says how many
      // are not yet confirmed or failed (`open`, the first few named), how
      // many files were given, and which failed.
      settle() {
        draining = true;
        const open = [];
        const failed = [];
        for (const [url, file] of files) {
          if (file.state === "given") enqueue(url);
          if (file.state === "failed") failed.push(url);
          else if (file.state !== "ok") open.push(url);
        }
        pump();
        return {
          open: open.length,
          waiting: open.slice(0, 3),
          files: files.size,
          failed,
        };
      },
    },
  });
};

// The player is up once its Esc screen is mounted (after it read storage
// and placed the reader), or it said it could not load the game.
const PLAYER_UP = () =>
  document.getElementById("help") !== null ||
  document.getElementById("error-state") !== null;

async function waitForPlayer(page) {
  try {
    await page.waitForFunction(PLAYER_UP, { timeout: START_MS });
  } catch {
    throw new Error(`openGame: the player did not start within ${START_MS} ms`);
  }
  const failed = await page.evaluate(
    () => document.getElementById("error-state")?.textContent ?? null,
  );
  if (failed !== null) {
    throw new Error(`openGame: the player could not load the game: ${failed}`);
  }
}

// Throws unless the player, now up, shows the item `id`, as one that opened
// at `#start=<id>` does. waitForPlayer has seen the first screen applied,
// so the wait only covers a slow machine.
async function checkStartedAt(page, id) {
  const shown = await page
    .waitForFunction(
      (want) =>
        document.getElementById("stage")?.getAttribute("data-item") === want,
      { timeout: 1000 },
      id,
    )
    .then(() => id)
    .catch(() => page.evaluate(STAGE_ITEM));
  if (shown === id) return;
  const opened =
    shown === null
      ? "its stage names no item"
      : `it opened at ${JSON.stringify(shown)}`;
  throw new Error(
    `openGame: the folder's player does not support starting at an item (asked for ${JSON.stringify(id)}, ${opened}); rebuilding the folder with a current player fixes this (CREATE.md, "Upgrading to a newer Kinetic")`,
  );
}

const SHIM_PREFIX = "window.KINETIC_MANIFEST = ";

/**
 * The folder's manifest as the player reads it: manifest.js (`window.
 * KINETIC_MANIFEST = {...};`, generated from manifest.json) first, else
 * manifest.json. Null when neither holds one.
 */
function readManifestFile(dir) {
  try {
    const shim = readFileSync(join(dir, "manifest.js"), "utf8").trim();
    if (shim.startsWith(SHIM_PREFIX)) {
      const embedded = JSON.parse(
        shim.slice(SHIM_PREFIX.length).replace(/;$/, ""),
      );
      if (embedded !== null && typeof embedded === "object") return embedded;
    }
  } catch {
    // Missing, or more than the plain assignment: manifest.json next.
  }
  try {
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Refuses a startAt the folder's manifest has no item for, before any browser starts. */
function checkStartAt(dir, startAt) {
  if (typeof startAt !== "string") {
    throw new Error("openGame: startAt must be an item id (a string)");
  }
  const manifest = readManifestFile(dir);
  if (manifest === null) {
    throw new Error(
      `openGame: cannot check startAt ${JSON.stringify(startAt)}: ${dir} has no readable manifest.js or manifest.json`,
    );
  }
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  if (!items.some((it) => it?.id === startAt)) {
    throw new Error(
      `openGame: this game has no item ${JSON.stringify(startAt)} to start at (startAt)`,
    );
  }
}

/**
 * The symbolic links in the folder `dir` (any depth; a linked folder is
 * not entered) whose target resolves outside the folder's real path, as
 * paths relative to it with "/" between folders, sorted. A link that
 * resolves inside the folder is left out, and a folder that cannot be
 * read is skipped.
 */
export function outsideLinks(dir) {
  const root = realpathSync.native(dir);
  const inside = (path) => path === root || path.startsWith(root + sep);
  const found = [];
  const folders = [root];
  while (folders.length > 0) {
    const folder = folders.pop();
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      continue; // unreadable: the player cannot read it either
    }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) folders.push(path);
      else if (entry.isSymbolicLink()) {
        let target;
        try {
          target = realpathSync.native(path);
        } catch {
          // A broken link: judged by where it points.
          target = resolve(folder, readlinkSync(path));
        }
        if (!inside(target))
          found.push(relative(root, path).split(sep).join("/"));
      }
    }
  }
  return found.sort();
}

/** openGame's one note about outsideLinks(), or null when there are none. */
export function outsideLinksNote(links) {
  if (links.length === 0) return null;
  const named = links.slice(0, 3).join(", ");
  const more = links.length > 3 ? ` and ${links.length - 3} more` : "";
  const one = links.length === 1;
  return `openGame: ${links.length} symbolic ${one ? "link" : "links"} in this folder ${one ? "points" : "point"} outside it (${named}${more}). WebKit and the macOS app cannot read files through such links (Chrome can); copy or hard-link the files into the folder instead.`;
}

const clip = (text) => (text.length > 60 ? `${text.slice(0, 57)}...` : text);

/** One line naming what a current() result shows, for error messages. */
export function summary(now) {
  return [
    now.id ?? "(no item)",
    now.text ? `"${clip(now.text)}"` : "",
    now.choice ? `with the choice "${now.choice.prompt}" open` : "",
    now.screen
      ? `under the ${now.screen === "esc" ? "Esc" : "map"} screen`
      : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
}

/**
 * Opens the built game folder `folder` (its index.html and app.js) with no
 * window on screen. Options:
 * - `engine`: "webkit", "chrome" or "auto" (default: WebKit on macOS when
 *   its driver builds, else Chrome; `log` says which).
 * - `viewport`: `{ width, height }` in CSS pixels (default 1280 x 720).
 * - `profile`: a folder that keeps the reader's progress and settings
 *   between opens (created if missing; yours to delete). Default: a fresh
 *   profile each open, as a first-time reader.
 * - `closeHelp`: close the first-load Esc screen (default true).
 * - `playAll`: true or false sets Play all routes through the Esc screen
 *   (on by default in a fresh profile; turn it off to answer each choice
 *   yourself), which it leaves closed. Default: left as it is.
 * - `startAt`: an item id; the game opens at that item
 *   (`index.html#start=<id>`, CREATE.md "Playing the folder"), entering
 *   its routes as `u` does, in place of the saved place. An id the
 *   folder's manifest lacks throws before any browser starts; a folder
 *   whose player cannot start at an item (an older one) throws once it
 *   has opened, saying so and that rebuilding with a current player
 *   fixes it.
 * - `log`: gets openGame's notes (default: stderr); null for none. Besides
 *   the engine "auto" picked, one note names symbolic links in the folder
 *   that point outside it (outsideLinks), on either engine: WebKit and
 *   the macOS app cannot read files through them.
 * Failed loads are reported on both engines: errors() lists each picture,
 * video, poster or script that failed to load or decode, once per file;
 * after a fast walk, await the handle's checkMedia() first.
 * Resolves with the game handle (CREATE.md, "Testing your game").
 */
export async function openGame(folder, options = {}) {
  const {
    engine = "auto",
    viewport = DEFAULT_VIEWPORT,
    profile = null,
    closeHelp = true,
    playAll = null,
    startAt = null,
    log = (line) => console.error(line),
  } = options;
  const dir = resolve(folder);
  for (const file of ["index.html", "app.js"]) {
    if (!existsSync(join(dir, file))) {
      throw new Error(
        `openGame: ${dir} has no ${file}; open a built game folder (CREATE.md, "Playing the folder")`,
      );
    }
  }
  if (playAll !== null && typeof playAll !== "boolean") {
    throw new Error(`openGame: playAll must be true, false or null`);
  }
  if (startAt !== null) checkStartAt(dir, startAt);
  const chosen = chooseEngine(engine, log);
  if (log) {
    const note = outsideLinksNote(outsideLinks(dir));
    if (note !== null) log(note);
  }
  const kept = profile === null ? null : resolve(profile);
  // A fresh WebKit profile lives in memory; a fresh Chrome one is a new
  // folder, removed at close.
  let temp = null;
  if (kept === null && chosen === "chrome") {
    mkdirSync(join(scratch, "game-test-profiles"), { recursive: true });
    temp = mkdtempSync(join(scratch, "game-test-profiles", "chrome-"));
  }
  const browser = await launchBrowser(chosen, {
    profile: kept ?? temp,
    crashDumpsDir: join(scratch, "crashdumps"),
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await closeBrowser(browser);
    if (temp !== null) rmSync(temp, { recursive: true, force: true });
  };
  try {
    const page = await browser.newPage();
    const errors = collectErrors(page);
    await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(TRACK_MEDIA);
    const cdp = await page.createCDPSession();
    const url = pathToFileURL(join(dir, "index.html")).href;
    await page.goto(
      startAt === null ? url : `${url}#start=${encodeURIComponent(startAt)}`,
    );
    await waitForPlayer(page);
    if (startAt !== null) await checkStartedAt(page, startAt);
    const embedded = await page.evaluate(() => window.KINETIC_MANIFEST ?? null);
    const manifest = embedded ?? readManifestFile(dir) ?? { items: [] };
    if (closeHelp) await dismissHelp(page, cdp);
    if (playAll !== null) {
      const { after, closed: shut } = await setPlayAll(page, cdp, playAll);
      if (after.playPressed !== String(playAll) || !shut) {
        throw new Error(
          `openGame: Play all routes did not turn ${playAll ? "on" : "off"} (the switch reads ${after.playLabel}; Esc screen closed: ${shut})`,
        );
      }
    }
    return gameHandle(
      { page, cdp, errors, manifest, closeHelp },
      {
        engine: chosen,
        folder: dir,
        url,
        close,
      },
    );
  } catch (error) {
    await close();
    throw error;
  }
}

function gameHandle({ page, cdp, errors, manifest, closeHelp }, fields) {
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  const ids = new Map();
  items.forEach((it, index) => {
    if (!ids.has(it.id)) ids.set(it.id, index);
  });
  // The screen index (indexItems), built on first need: a player that puts
  // the item's id on the page never needs it.
  let screens = null;
  let lastIndex = 0;

  const read = () => page.evaluate(READ_NOW);

  // The saved place, when it is one of `hits`: waited for briefly, since
  // the player issues its write as the screen changes.
  const savedAmong = async (hits) => {
    const until = Date.now() + 500;
    for (;;) {
      const id = await page
        .evaluate(READ_SAVED_PLACE, manifest?.storyId ?? null)
        .catch(() => null);
      const index = ids.get(id) ?? -1;
      if (hits.includes(index)) return index;
      if (Date.now() >= until) return null;
      await sleep(50);
    }
  };

  const finder = {
    items,
    ids,
    lookup: (screen) => {
      if (screens === null) screens = indexItems(items);
      return lookupItems(screens, screen);
    },
    savedAmong,
  };

  const describe = async (now) => {
    const s = now.state;
    const videoShown = s.video?.visible === true;
    const { index, foundBy, ambiguous } = await findItem(
      finder,
      now,
      lastIndex,
    );
    if (index >= 0) lastIndex = index;
    const c = now.choice;
    return {
      id: index >= 0 ? items[index].id : null,
      index,
      text: s.text || null,
      speaker: s.speaker || null,
      file: (videoShown ? s.video.src : s.imgVisible ? s.imgSrc : null) || null,
      choice:
        c.present && !c.hidden
          ? {
              prompt: c.prompt,
              rows: c.rows.map((row) => ({
                number: Number(row.number),
                label: row.label,
                seen: row.seen !== null,
                next: row.next,
                continue: row.isContinue,
              })),
            }
          : null,
      screen: s.helpOpen ? "esc" : now.map ? "map" : null,
      foundBy,
      ambiguous,
    };
  };

  const current = async () => describe(await read());

  const matcher = (target, who) => {
    if (typeof target === "function") return target;
    if (typeof target === "string") {
      if (!ids.has(target)) {
        throw new Error(
          `${who}: this game has no item ${JSON.stringify(target)}`,
        );
      }
      return (now) => now.id === target;
    }
    throw new Error(`${who}: give an item id or a function of current()`);
  };
  const named = (target) =>
    typeof target === "string" ? `item ${target}` : "the condition";

  // Polls current() until `matches`; resolves with it, or null past `timeout`.
  const poll = async (matches, timeout) => {
    const until = Date.now() + timeout;
    for (;;) {
      const now = await current();
      if (matches(now)) return now;
      if (Date.now() >= until) return null;
      await sleep(50);
    }
  };

  // Escape reaches the game: a press the browser kept to leave fullscreen
  // (headless Chrome, before the player's Keyboard Lock holds) is sent
  // again once fullscreen is gone, as the harness's escapeUntil does.
  const escapeToGame = async () => {
    if (await pressEscapeSeen(page, cdp)) return;
    await page
      .waitForFunction(() => document.fullscreenElement === null, {
        timeout: 5000,
      })
      .catch(() => {});
    await pressEscapeSeen(page, cdp);
  };

  return {
    ...fields,
    manifest,
    page,
    /** Presses the key `name` (Space, Tab, Escape, Enter, a letter, a digit, an arrow...) `times` times. */
    async press(name, { times = 1 } = {}) {
      const { key } = keyFor(name);
      for (let n = 0; n < times; n += 1) {
        if (n > 0) await sleep(PRESS_GAP_MS);
        if (key === "Escape") await escapeToGame();
        else await pressNamed(cdp, name);
      }
    },
    /**
     * What the screen shows: `{ id, index, text, speaker, file, choice,
     * screen, foundBy, ambiguous }`. `id` and `index` name the item on
     * screen (null and -1 for none); `foundBy` says how it was named
     * ("player", "screen", "saved place", "guess" or "none", findItem);
     * `ambiguous` lists the look-alike items' ids behind a guess, else [].
     */
    current,
    /** Waits for an item id, or for `fn(current())` to be true. */
    async waitForItem(target, { timeout = 10000 } = {}) {
      const matches = matcher(target, "waitForItem");
      const now = await poll(matches, timeout);
      if (now !== null) return now;
      throw new Error(
        `waitForItem: ${named(target)} not reached in ${timeout} ms; on screen: ${summary(await current())}`,
      );
    },
    /** Waits for a choice to open; resolves with current(). */
    async waitForChoice({ timeout = 10000 } = {}) {
      const now = await poll((c) => c.choice !== null, timeout);
      if (now !== null) return now;
      throw new Error(
        `waitForChoice: no choice opened in ${timeout} ms; on screen: ${summary(await current())}`,
      );
    },
    /** Presses Space until an item id, or `fn(current())`, is reached. */
    async spaceUntil(target, { limit = 100 } = {}) {
      const matches = matcher(target, "spaceUntil");
      let before = null;
      let still = 0;
      for (let presses = 0; ; presses += 1) {
        const raw = await read();
        const now = await describe(raw);
        if (matches(now)) return now;
        const seen = JSON.stringify([
          now.id,
          now.text,
          now.file,
          now.choice,
          now.screen,
        ]);
        still = seen === before ? still + 1 : 0;
        before = seen;
        let why = null;
        if (now.choice !== null && raw.playAll === "false") {
          why =
            "a choice is open and Play all routes is off (pick a route with pickRoute)";
        } else if (still >= STUCK_PRESSES) {
          why = `Space changed nothing ${still} times running`;
        } else if (presses >= limit) {
          why = `${limit} presses`;
        }
        if (why !== null) {
          throw new Error(
            `spaceUntil: ${named(target)} not reached: ${why}; on screen: ${summary(now)}`,
          );
        }
        await pressNamed(cdp, "Space");
        await sleep(PRESS_GAP_MS);
      }
    },
    /** Picks the open choice's row `number` (0-9) with its digit key. */
    async pickRoute(number, { timeout = 5000 } = {}) {
      const before = await current();
      if (before.choice === null) {
        throw new Error(
          `pickRoute(${number}): no choice is open; on screen: ${summary(before)}`,
        );
      }
      const { prompt, rows } = before.choice;
      if (
        !Number.isInteger(number) ||
        number < 0 ||
        number > 9 ||
        !rows.some((row) => row.number === number)
      ) {
        throw new Error(
          `pickRoute(${number}): the choice "${prompt}" has no row ${number} to pick by digit (its rows: ${rows.map((row) => row.number).join(", ")}; reach rows past 9 with press("ArrowDown") and press("Enter"))`,
        );
      }
      await pressNamed(cdp, String(number));
      try {
        await page.waitForFunction(CHOICE_CLOSED, { timeout });
      } catch {
        throw new Error(
          `pickRoute(${number}): the choice "${prompt}" stayed open`,
        );
      }
      // The route's first screen replaces the decision's.
      return (
        (await poll(
          (now) => now.id !== before.id || now.choice !== null,
          1000,
        )) ?? current()
      );
    },
    /** Reloads the page, as a reader's reload does; resolves with current(). */
    async reload() {
      await page.reload();
      await waitForPlayer(page);
      if (closeHelp) await dismissHelp(page, cdp);
      return current();
    },
    /** Saves a PNG of the page at `path` (folders made as needed); resolves with its full path. */
    async screenshot(path) {
      const file = resolve(path);
      mkdirSync(dirname(file), { recursive: true });
      await page.screenshot({ path: file });
      return file;
    },
    /**
     * Waits until every media file the page has been given (each picture,
     * video and poster it showed, however fast the walk moved on) is
     * confirmed loaded or listed in errors() as failed: a file whose load
     * the walk cut short, or a poster (which fires no event), is loaded
     * and decoded off the page to find out. Call it before reading
     * errors() after a walk. Resolves with `{ files, failed }`: how many
     * media files the page was given and the URLs that failed. Throws if
     * `stall` ms pass with no file answered (default 20 s; a video check
     * gives up, as failed, after 15 s).
     */
    async checkMedia({ stall = 20000 } = {}) {
      let fewest = Infinity;
      let since = Date.now();
      for (;;) {
        const status = await page.evaluate(() =>
          window.__kineticMedia.settle(),
        );
        if (status.open === 0) {
          // The failures' console lines can trail the page's answer.
          const until = Date.now() + 3000;
          const listed = (url) => errors.some((line) => line.includes(url));
          while (!status.failed.every(listed) && Date.now() < until) {
            await sleep(20);
          }
          return { files: status.files, failed: status.failed };
        }
        if (status.open < fewest) {
          fewest = status.open;
          since = Date.now();
        } else if (Date.now() - since >= stall) {
          throw new Error(
            `checkMedia: ${status.open} media file(s) neither loaded nor checked in ${stall} ms: ${status.waiting.join(", ")}`,
          );
        }
        await sleep(50);
      }
    },
    /** The console errors and warnings and the page errors so far. */
    errors: () => [...errors],
  };
}
