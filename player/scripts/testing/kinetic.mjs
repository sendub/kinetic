// Testing a built Kinetic game folder with no window on screen (CREATE.md,
// "Testing your game"). A creator's own script imports this file by its
// absolute path, which `kinetic check --library` prints (from an
// installed Kinetic, the copy scripts/bundle-check.mjs bundled with
// puppeteer-core, which needs no node_modules):
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
import { pathToFileURL } from "node:url";
import { folderKineticVersion } from "../version.mjs";
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
import { scratchDir } from "./scratch.mjs";
import { serveFolder } from "./serve.mjs";

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
// checkMedia(), measured on a converted corpus game's 60,000 files
// (docs/plan.md Phase 48): one Chrome page decodes one picture at a time
// (19-20 ms a file however many it is given), while pages in browser
// contexts of their own add up (4 pages 5.9 ms a file, 6 pages 5.8); one
// WebKit page decodes several at once (8.5 ms a file at 4, 6.7 at 8, 6.5
// at 16). So on Chrome CHECKER_PAGES pages of their own check the files,
// CHECKER_LANES at a time each, taking CHECKER_BATCH at a time from the
// walking page; on WebKit the walking page checks them,
// WALKING_PAGE_CHECKS at a time. Over 12,000 of that game's files left by
// a walk (2026-11-14) that took 1.7 ms a file on Chrome (22 before) and
// 6.5 on WebKit; 6 or 8 Chrome pages were no faster than 4.
const CHECKER_PAGES = { chrome: 4, webkit: 0 };
const WALKING_PAGE_CHECKS = { chrome: 4, webkit: 8 };
const CHECKER_LANES = 4;
const CHECKER_BATCH = 8;

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

// The stage's `data-segment` (docs/plan.md Phase 49, item 4): `n/m` while
// segment n (from 1) of the video item's m is active; null when none is,
// and always from a player older than segments.
const STAGE_SEGMENT = () =>
  document.getElementById("stage")?.getAttribute("data-segment") ?? null;

/**
 * current()'s `segment`, from the stage's `data-segment` (`raw`):
 * `{ index, count }` as the machine has it (`MachineState.segment`, index
 * from 0), or null for no attribute or anything other than `n/m` with
 * whole numbers 1 <= n <= m.
 */
export function readSegment(raw) {
  const m = typeof raw === "string" ? /^(\d+)\/(\d+)$/.exec(raw) : null;
  if (m === null) return null;
  const view = Number(m[1]);
  const count = Number(m[2]);
  return view >= 1 && view <= count ? { index: view - 1, count } : null;
}

// The player's end card (`#end-card`, docs/plan.md Phase 18) when it shows:
// its words (the title, then the hint when there is one); else null.
const END_CARD = () => {
  const card = document.getElementById("end-card");
  if (card === null || card.hidden) return null;
  const words = Array.from(card.children, (el) =>
    el.hidden ? "" : (el.textContent ?? "").trim(),
  ).filter((text) => text !== "");
  return words.length > 0 ? words.join(" ") : (card.textContent ?? "").trim();
};

/**
 * current()'s `audio`, read from `doc` (the page's document): the player's
 * hidden `#audio` (docs/plan.md Phase 47, items 5 and 18) lists its sounds
 * through `sounds()`, each as `{ slot, track, paused, currentTime, volume }`
 * (an older player's `#audio` held <audio> elements with `data-slot` and
 * `data-track` instead, read the same way), and carries the target sound
 * as JSON (`data-target`, from when the first one applies) and
 * `data-unlocked`. Resolves `{ unlocked, target, elements }`, where
 * `elements` lists each sound holding a track (idle ones are left out), or
 * null when the page has no `#audio`: a game without audio, or a player
 * older than sound. Runs in the page, so it uses nothing from outside its
 * own body.
 */
export const readAudio = (doc) => {
  const hook = doc.getElementById("audio");
  if (hook === null) return null;
  let target = null;
  try {
    target = JSON.parse(hook.dataset.target ?? "null");
  } catch {}
  const sounds =
    typeof hook.sounds === "function"
      ? hook.sounds()
      : Array.from(hook.children, (el) => ({
          slot: el.dataset.slot,
          track: el.dataset.track ?? "",
          paused: el.paused,
          currentTime: el.currentTime,
          volume: el.volume,
        }));
  return {
    unlocked: hook.dataset.unlocked === "true",
    target,
    elements: sounds
      .filter((s) => s.track !== "")
      .map(({ slot, track, paused, currentTime, volume }) => ({
        slot,
        track,
        paused,
        currentTime,
        volume,
      })),
  };
};

// Everything current() reports, read in one round trip.
const READ_NOW = `({
  state: (${PAGE_STATE})(),
  dataItem: (${STAGE_ITEM})(),
  segment: (${STAGE_SEGMENT})(),
  endCard: (${END_CARD})(),
  choice: (${READ_CHOICE})(),
  map: (${MAP_OPEN})(),
  audio: (${readAudio})(document),
  playAll: document.querySelector(".config-play-all")?.getAttribute("aria-pressed") ?? null,
})`;

// A manifest `storyId` the player keys progress by (src/storage/idb.ts).
const STORY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * The storage key the player keeps a story's progress under when its
 * manifest's `storyId` names it, `story:<storyId>` (src/storage/idb.ts
 * storageKeys); null for a missing or invalid one, whose progress the
 * folder's URL keys instead (FOLDER_KEY, read in the page).
 */
export function storyKeyOf(storyId) {
  return typeof storyId === "string" && STORY_ID_PATTERN.test(storyId)
    ? `story:${storyId}`
    : null;
}

// The storage key of a story whose manifest names none: the folder's
// absolute URL, as the player's contentSignature makes it.
const FOLDER_KEY = () => new URL(".", document.baseURI).href;

/**
 * Throws unless `record` is null or a state record openGame can write
 * (`savedState`): a plain object that JSON can carry into the page.
 */
export function checkSavedState(record) {
  const shaped =
    record === null ||
    (typeof record === "object" &&
      !Array.isArray(record) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(record)));
  let carried = shaped;
  if (shaped && record !== null) {
    try {
      carried = typeof JSON.stringify(record) === "string";
    } catch {
      carried = false;
    }
  }
  if (!carried) {
    throw new Error(
      "openGame: savedState must be a state record (a plain object, such as the game's savedState() resolves with) or null",
    );
  }
}

// Writes `record` as the story's state record (the `state` store of the
// player's `kinetic` database, src/storage/idb.ts) under the storage key
// (`storyKey`, else FOLDER_KEY's) before the player reads storage: given
// to evaluateOnNewDocument, it runs before the page's scripts, and its
// open and its write are queued ahead of the player's, which IndexedDB
// serves in order. Once per page: a sessionStorage mark, which survives a
// reload, keeps a reload from writing it again. A database not there yet
// is made with the player's stores, as the player makes it. A failed
// write is a console error, which errors() lists.
const SEED_STATE = (storyKey, record) => {
  const MARK = "kinetic-test-saved-state";
  try {
    if (sessionStorage.getItem(MARK) !== null) return;
    sessionStorage.setItem(MARK, "1");
  } catch {
    // No sessionStorage: the record is written at every load.
  }
  const key = storyKey ?? new URL(".", document.baseURI).href;
  const failed = (why) =>
    console.error(`openGame: savedState was not written (${why})`);
  const open = indexedDB.open("kinetic");
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains("state")) db.createObjectStore("state");
    if (!db.objectStoreNames.contains("bookmarks")) {
      db.createObjectStore("bookmarks", {
        keyPath: "seq",
        autoIncrement: true,
      }).createIndex("content", "content");
    }
  };
  open.onerror = () => failed(open.error?.message ?? "the open failed");
  open.onsuccess = () => {
    const db = open.result;
    try {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(record, key);
      tx.oncomplete = () => db.close();
      tx.onabort = () => {
        failed(tx.error?.message ?? "the write was aborted");
        db.close();
      };
    } catch (error) {
      failed(error.message);
      db.close();
    }
  };
};

// The story's state record under the storage key `key` (src/storage/
// idb.ts), or with `placeOnly` just the item it saved as on screen
// (`ctx.lastShown`). Read only; null when there is none.
const READ_STATE = async (key, placeOnly) => {
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
    if (placeOnly) return record?.ctx?.lastShown ?? null;
    return record ?? null;
  } finally {
    db.close();
  }
};

// In the page, on both engines: every media file the document is given
// (an <img>'s src, a <video>'s src and poster) is followed until it is
// confirmed (its element's `load` or `loadeddata`) or failed, which is
// logged once per file as `Failed to load resource: <its URL>`: WebKit
// logs no failed load, and Chrome logs only a missing file, not one it
// cannot decode (collectErrors lists each URL once, saying why from the
// disk: `(not found)`, `(could not decode)`...). A file its element
// moved on from before either event (a fast walk aborts the load, and an
// aborted load fires none), one whose element left the page, and every
// poster (painted as a CSS background too, which fires no event) is
// checked off the page instead: a picture decoded through `new Image()`, a
// video loaded in a detached <video>. These checks wait until no new file
// has come for a moment, so a fast walk is not slowed; checkMedia() then
// drains them, here a few at a time or handing them out (take) to pages
// of their own that check them (check) and say how each went (report). A
// failed <script> or <link> is logged as it fails. checkMedia() adds the
// files its walked items reference that the page was never given (add):
// an animation's later frames, and each audio track's script
// (`<file>.js`), which the player reads in place of the file and decodes
// with decodeAudioData, as the check does; a script the page added counts
// as requested. `offPage: false` (the openGame option mediaChecks) checks
// nothing off the page: only the elements' own events count.
const TRACK_MEDIA = ({ offPage = true } = {}) => {
  // Checks at once in this page while the walk pauses; checkMedia() sets
  // its own number while it drains.
  const CHECKS_AT_ONCE = 4;
  // Checks wait while files keep coming (a walk), so they never compete
  // with it: they run once none has come for this long, or while
  // checkMedia() drains them.
  const QUIET_MS = 300;
  // A video with no first picture by then, from a local file, is failed;
  // so is an audio script not decoded by then.
  const VIDEO_CHECK_MS = 15000;
  // An audio check decodes at this rate, which few files have: WebKit
  // decodes AAC at the file's own rate in time growing with the square of
  // its length (player/src/render/audioload.ts).
  const AUDIO_CHECK_RATE = 22050;
  // URL -> { kind: "picture" | "video" | "audio", state: "given" (on an
  // element, no event yet), "queued", "checking" (here), "elsewhere"
  // (taken by another page), "ok" or "failed" }.
  const files = new Map();
  // The scripts the page added (an audio track's is its request).
  const scripts = new Set();
  // URLs to check, first in first out: read from `head` on, as a shift()
  // per file costs the whole list on a game of 60,000 files.
  let queue = [];
  let head = 0;
  const queued = () => queue.length - head;
  const dequeue = () => {
    const url = queue[head];
    head += 1;
    if (head >= 1024 && head * 2 >= queue.length) {
      queue = queue.slice(head);
      head = 0;
    }
    return url;
  };
  let checking = 0;
  let atOnce = CHECKS_AT_ONCE;
  let lastGiven = 0;
  let draining = false;
  // checkMedia() hands the queue to other pages: none is checked here.
  let elsewhere = false;
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
  // An audio track's script, run in a frame of its own (the player's
  // __kineticAudio stays untouched), its bytes decoded.
  const checkAudio = (url) =>
    new Promise((done) => {
      const root =
        document.documentElement ??
        document.appendChild(document.createElement("html"));
      const frame = document.createElement("iframe");
      frame.style.display = "none";
      let timer = 0;
      const finish = (ok) => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
        frame.remove();
        done(ok);
      };
      timer = setTimeout(() => finish(false), VIDEO_CHECK_MS);
      root.append(frame);
      const doc = frame.contentDocument;
      let called = false;
      frame.contentWindow.__kineticAudio = (_file, base64) => {
        called = true;
        let bytes;
        try {
          const text = atob(base64);
          bytes = new Uint8Array(text.length);
          for (let n = 0; n < text.length; n += 1) {
            bytes[n] = text.charCodeAt(n);
          }
        } catch {
          finish(false);
          return;
        }
        new OfflineAudioContext(1, 1, AUDIO_CHECK_RATE)
          .decodeAudioData(bytes.buffer)
          .then(
            () => finish(true),
            () => finish(false),
          );
      };
      const script = doc.createElement("script");
      script.onerror = () => finish(false);
      script.onload = () => {
        if (!called) finish(false);
      };
      script.src = url;
      (
        doc.head ??
        doc.documentElement ??
        doc.appendChild(doc.createElement("html"))
      ).append(script);
    });
  const checkFile = (url, kind) =>
    kind === "video"
      ? checkVideo(url)
      : kind === "audio"
        ? checkAudio(url)
        : checkPicture(url);
  const pump = () => {
    if (!offPage || elsewhere) return;
    const quiet = performance.now() - lastGiven;
    if (!draining && quiet < QUIET_MS) {
      if (wake === null && queued() > 0) {
        wake = setTimeout(() => {
          wake = null;
          pump();
        }, QUIET_MS - quiet);
      }
      return;
    }
    while (checking < atOnce && queued() > 0) {
      const url = dequeue();
      const file = files.get(url);
      if (file.state !== "queued") continue; // its element answered first
      file.state = "checking";
      checking += 1;
      checkFile(url, file.kind).then((ok) => {
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
        for (const node of record.addedNodes) {
          if (node instanceof HTMLScriptElement && node.getAttribute("src")) {
            scripts.add(absolute(node.getAttribute("src")));
          }
          each(node, onScreen);
        }
        for (const node of record.removedNodes) {
          each(node, (value, kind) => {
            const url = given(value, kind);
            if (url !== null) enqueue(url);
          });
        }
        continue;
      }
      if (record.target instanceof HTMLScriptElement) {
        const src = record.target.getAttribute("src");
        if (src) scripts.add(absolute(src));
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
      else if (el instanceof HTMLVideoElement) {
        // WebKit fires error at a video whose poster failed, with no media
        // error: the poster's own check reports that, not the video.
        if (el.error !== null) fail(absolute(src), "video");
      } else console.error(`Failed to load resource: ${absolute(src)}`);
    },
    true,
  );
  Object.defineProperty(window, "__kineticMedia", {
    value: {
      // Queues every file still waiting on its element, and says how many
      // are not yet confirmed or failed (`open`, the first few named), how
      // many files were given, and which failed. Checks go on here,
      // `atOnce` at a time, or with `elsewhere` only through take().
      settle({
        atOnce: checks = CHECKS_AT_ONCE,
        elsewhere: away = false,
      } = {}) {
        draining = true;
        atOnce = checks;
        elsewhere = away;
        let open = 0;
        const waiting = [];
        const failed = [];
        for (const [url, file] of files) {
          if (file.state === "given") enqueue(url);
          if (file.state === "failed") failed.push(url);
          else if (file.state !== "ok") {
            open += 1;
            if (waiting.length < 3) waiting.push(url);
          }
        }
        pump();
        return { open, waiting, files: files.size, failed };
      },
      // Queues `list` ([{ path, kind }], paths as the manifest names
      // them) where the page was never given a file: says how many it
      // added and how many of those the page never requested.
      add(list) {
        let added = 0;
        let neverRequested = 0;
        for (const { path, kind } of list) {
          const url = absolute(path);
          if (files.has(url)) continue;
          files.set(url, { kind, state: "given" });
          enqueue(url);
          added += 1;
          if (!(kind === "audio" && scripts.has(url))) neverRequested += 1;
        }
        pump();
        return { added, neverRequested };
      },
      // Takes up to `count` queued files for another page to check, as
      // [{ url, kind }]: at most one video or audio script, last, so a
      // slow one holds up no picture behind it.
      take(count) {
        const taken = [];
        while (taken.length < count && queued() > 0) {
          const url = dequeue();
          const file = files.get(url);
          if (file.state !== "queued") continue;
          file.state = "elsewhere";
          taken.push({ url, kind: file.kind });
          if (file.kind !== "picture") break;
        }
        return taken;
      },
      // How the files take() gave out went, as [{ url, ok }]: each failed
      // one is logged here, once, as if checked here.
      report(results) {
        for (const { url, ok } of results) {
          const file = files.get(url);
          if (file?.state !== "elsewhere") continue; // its element answered
          if (ok) file.state = "ok";
          else fail(url, file.kind);
        }
      },
      // In a page of its own (a checker): checks `taken` (take()'s list)
      // one at a time and resolves with how each went, for report().
      async check(taken) {
        const results = [];
        for (const { url, kind } of taken) {
          results.push({ url, ok: await checkFile(url, kind) });
        }
        return results;
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

/**
 * trace()'s read of the page `win` (its window), in one round trip so no
 * record the player appends can fall between the read and the emptying:
 * `{ records, dropped }`, every record in `__kineticTrace`, which it empties
 * in place (`length = 0`: the player keeps appending to the same array),
 * and `__kineticTraceDropped`, the records the player dropped past its cap
 * since the last read, which it resets to 0 (the player adds to the
 * counter as it finds it). Null when the page has no trace array: a player
 * that keeps no trace (src/render/trace.ts). Runs in the page, so it uses
 * nothing from outside its own body.
 */
export const drainTrace = (win) => {
  const trace = win.__kineticTrace;
  if (!Array.isArray(trace)) return null;
  const records = trace.slice();
  trace.length = 0;
  const dropped = win.__kineticTraceDropped ?? 0;
  win.__kineticTraceDropped = 0;
  return { records, dropped };
};

/**
 * trace()'s refusal on a folder whose player keeps no trace (an older
 * one), naming its `version` (folderKineticVersion; null for a player
 * built before the version stamp).
 */
export const traceRefusal = (version) =>
  `trace: the folder's player (${version === null ? "built before Kinetic versions were stamped" : `Kinetic ${version}`}) keeps no item trace; rebuilding the folder with a current player fixes this (CREATE.md, "Upgrading to a newer Kinetic")`;

// Sets the player's trace flag (src/render/trace.ts) before it starts.
const TRACE_FLAG = () => {
  window.KINETIC_TEST_TRACE = true;
};

const SHIM_PREFIX = "window.KINETIC_MANIFEST = ";

/**
 * The folder `dir`'s manifest as the player reads it: manifest.js (`window.
 * KINETIC_MANIFEST = {...};`, generated from manifest.json) first, else
 * manifest.json. Null when neither holds one. Reads files only, so a
 * script can check ids before it opens the game.
 */
export function readManifestFile(dir) {
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

const LANGUAGE_SHIM = (tag) =>
  `window.KINETIC_LANGUAGES[${JSON.stringify(tag)}] = `;

/**
 * The folder `dir`'s language file for `tag` (docs/content-format.md
 * "Translations"), as the player loads it: `lang/<tag>.js`'s JSON, else
 * `lang/<tag>.json`; null when neither reads.
 */
export function readLanguageFile(dir, tag) {
  const prefix = LANGUAGE_SHIM(tag);
  try {
    const shim = readFileSync(join(dir, "lang", `${tag}.js`), "utf8").trim();
    if (shim.startsWith(prefix)) {
      const data = JSON.parse(shim.slice(prefix.length).replace(/;$/, ""));
      if (data !== null && typeof data === "object") return data;
    }
  } catch {
    // Missing, or more than the plain assignment: the JSON next.
  }
  try {
    return JSON.parse(readFileSync(join(dir, "lang", `${tag}.json`), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Refuses a `language` the folder's manifest does not offer (its base
 * `language`, default `en`, or one its `languages` lists), before any
 * browser starts. Returns the manifest's languages, base first.
 */
function checkLanguage(dir, language) {
  if (typeof language !== "string" || language === "") {
    throw new Error("openGame: language must be a language tag (a string)");
  }
  const manifest = readManifestFile(dir);
  if (manifest === null) {
    throw new Error(
      `openGame: cannot check language ${JSON.stringify(language)}: ${dir} has no readable manifest.js or manifest.json`,
    );
  }
  const base = typeof manifest.language === "string" ? manifest.language : "en";
  const offered = [
    base,
    ...(Array.isArray(manifest.languages) ? manifest.languages : []).filter(
      (tag) => typeof tag === "string" && tag !== base,
    ),
  ];
  if (!offered.includes(language)) {
    throw new Error(
      `openGame: this game has no language ${JSON.stringify(language)} (language); it offers ${offered.join(", ")}`,
    );
  }
  return offered;
}

// The game language the page shows: the Language control's own `lang`
// (render/languagecontrol.ts names the shown language in itself); null
// with no control (one language, or a player older than translations).
const SHOWN_LANGUAGE = () =>
  document.querySelector(".help-lang-name")?.getAttribute("lang") ?? null;

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

/** What openGame says about outsideLinks(): up to three, the count, the fix. */
function outsideLinksWords(links) {
  const named = links.slice(0, 3).join(", ");
  const more = links.length > 3 ? ` and ${links.length - 3} more` : "";
  const one = links.length === 1;
  return `${links.length} symbolic ${one ? "link" : "links"} in this folder ${one ? "points" : "point"} outside it (${named}${more}). WebKit and the macOS app cannot read files through such links (Chrome can); copy or hard-link the files into the folder instead.`;
}

/** openGame's one note about outsideLinks(), or null when there are none. */
export function outsideLinksNote(links) {
  return links.length === 0 ? null : `openGame: ${outsideLinksWords(links)}`;
}

/**
 * The errors() line openGame starts with when outsideLinks() found any (so
 * a check fails on every engine, Chrome included, where the loads work),
 * or null when there are none.
 */
export function outsideLinksError(links) {
  return links.length === 0 ? null : `[error] ${outsideLinksWords(links)}`;
}

const clip = (text) => (text.length > 60 ? `${text.slice(0, 57)}...` : text);

/** One line naming what a current() result shows, for error messages. */
export function summary(now) {
  return [
    now.id ?? "(no item)",
    now.text ? `"${clip(now.text)}"` : "",
    now.segment ? `view ${now.segment.index + 1} of ${now.segment.count}` : "",
    now.choice ? `with the choice "${now.choice.prompt}" open` : "",
    now.screen
      ? `under the ${now.screen === "esc" ? "Esc" : "map"} screen`
      : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
}

/**
 * The files the items `ids` of `manifest` reference, as checkMedia()'s
 * `items` checks them: `[{ path, kind }]`, each path once, in item order,
 * paths as the manifest names them. An item's picture or video (`file`),
 * a video's `poster`, every animation frame (kind "picture" or "video"),
 * then each audio track the item names (music, ambience, one-shots,
 * voice, video sound) as the script the player reads, `<file>.js` (kind
 * "audio"). Ids the manifest lacks and undeclared tracks are skipped.
 */
export function referencedFiles(manifest, ids) {
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  const byId = new Map(items.map((it) => [it?.id, it]));
  const tracks = manifest?.audio?.tracks ?? {};
  const listed = new Set();
  const out = [];
  const add = (path, kind) => {
    if (typeof path !== "string" || path === "" || listed.has(path)) return;
    listed.add(path);
    out.push({ path, kind });
  };
  for (const id of ids) {
    const it = byId.get(id);
    if (it === undefined) continue;
    add(it.file, it.type === "video" ? "video" : "picture");
    add(it.poster, "picture");
    for (const frame of Array.isArray(it.frames) ? it.frames : []) {
      add(frame, "picture");
    }
    const audio = it.audio ?? {};
    const named = [
      audio.music,
      ...(Array.isArray(audio.ambience) ? audio.ambience : []),
      ...(Array.isArray(audio.sfx) ? audio.sfx.map((sfx) => sfx?.track) : []),
      audio.voice,
      audio.videoSound?.track,
    ];
    for (const track of named) {
      const file = Object.hasOwn(tracks, track) ? tracks[track]?.file : null;
      if (typeof file === "string") add(`${file}.js`, "audio");
    }
  }
  return out;
}

/**
 * checkMedia()'s progress: `{ checked, total }` after `previous` (null at
 * the first count) with `open` files now left. Files answered count as
 * checked and never go back; files that come while it checks add to the
 * total.
 */
export function countChecked(previous, open) {
  if (previous === null) return { checked: 0, total: open };
  const checked = Math.max(previous.checked, previous.total - open);
  return { checked, total: Math.max(previous.total, checked + open) };
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
 * - `trace`: true sets `window.KINETIC_TEST_TRACE` before the player
 *   starts (on every load, reloads included), so it keeps the item trace
 *   the handle's trace() reads (src/render/trace.ts). Default false.
 * - `language`: a game language tag the manifest offers (its `language`,
 *   default `en`, or one of its `languages`); the game opens showing it,
 *   as for a reader whose system language it is, so the player's own
 *   words follow it too where its catalogue has the language (else
 *   English). A tag the game lacks throws before any browser starts; a
 *   game that opens in another language throws once it has opened (a
 *   language file that would not load, a `profile` holding another pick,
 *   or a player older than translations). The handle's `language` is the
 *   tag, null when not given (the system's languages, as before).
 * - `mediaChecks`: false loads no media file off the page to check it, so
 *   errors() lists only the failed loads the page's own elements report
 *   and checkMedia() throws (check-game's `--no-media-check`). Default
 *   true.
 * - `http`: true serves the folder over HTTP on 127.0.0.1 (serve.mjs, as a
 *   web host would) and opens it there in place of its file:// address;
 *   `{ port }` picks the port, else the system picks one. The server
 *   stops at close(). The page's storage is per origin, the port
 *   included, so a kept `profile` resumes the place over HTTP only on the
 *   same port, and never what a file:// open saved. `{ url }` starts no
 *   server: the folder is already served at `url` (http or https, ending
 *   in "/"), such as a copy on a web host, and the game opens there,
 *   while the manifest and the reasons for failed loads still come from
 *   the folder on disk. Default false.
 * - `savedState`: a state record, the object the player keeps per story
 *   in its IndexedDB database `kinetic`, store `state` (src/storage/
 *   idb.ts; its shape belongs to the folder's player version, so this is
 *   for tests only). It is written under the story's storage key before
 *   the player reads storage, on either engine (SEED_STATE), so the game
 *   opens as for a reader who saved that state: its place (unless
 *   `startAt` is given), routes, settings. Only the first load writes it;
 *   reload() keeps what the player has saved since. It replaces the
 *   record a kept `profile` holds; that profile's bookmarks and seen
 *   items stay, and a `ctx.visited` list in the record joins the seen
 *   items as at any load. A record the player cannot read opens as a
 *   first-time reader, as for a reader. Anything but a plain object or
 *   null throws before any browser starts. Default null: storage as the
 *   profile has it. The handle's `storageKey` is the key
 *   (`story:<storyId>` for a manifest with a valid storyId, else the
 *   folder's URL as the page has it) and its savedState() reads the
 *   record back.
 * - `log`: gets openGame's notes (default: stderr); null for none. Besides
 *   the engine "auto" picked, one note names symbolic links in the folder
 *   that point outside it (outsideLinks), on either engine: WebKit and
 *   the macOS app cannot read files through them. The same words are the
 *   first errors() line (outsideLinksError), on either engine, so a check
 *   that reads errors() fails; WebKit also lists each file it could not
 *   load through one, `(a symbolic link out of the folder)`.
 * Failed loads are reported on both engines: errors() lists each picture,
 * video, poster or script that failed to load or decode, once per file,
 * as `[error] Failed to load resource: <url> (<reason>)`: `not found`,
 * `could not decode`, `not readable` or `a symbolic link out of the
 * folder` (failedLoadReason, in core.mjs);
 * after a fast walk, await the handle's checkMedia() first. The handle's
 * current() reports the game's sound as `audio` (readAudio). The handle's
 * `kineticVersion` is the folder's player version, read from its app.js's
 * stamp on disk (folderKineticVersion, scripts/version.mjs): null for a
 * player built before the stamp.
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
    language = null,
    mediaChecks = true,
    trace = false,
    http = false,
    savedState = null,
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
  if (typeof trace !== "boolean") {
    throw new Error("openGame: trace must be true or false");
  }
  if (
    !(
      typeof http === "boolean" ||
      (http !== null &&
        typeof http === "object" &&
        (http.url === undefined
          ? Number.isInteger(http.port ?? 0)
          : http.port === undefined &&
            typeof http.url === "string" &&
            /^https?:\/\/[^/]+\/(.*\/)?$/.test(http.url)))
    )
  ) {
    throw new Error(
      'openGame: http must be true, false, { port } or { url } (an http or https address ending in "/")',
    );
  }
  checkSavedState(savedState);
  if (startAt !== null) checkStartAt(dir, startAt);
  // The story's storage key when its manifest names the story; else the
  // folder's URL keys it, read from the page (FOLDER_KEY).
  const storyKey = storyKeyOf(readManifestFile(dir)?.storyId);
  const offered = language === null ? null : checkLanguage(dir, language);
  const chosen = chooseEngine(engine, log);
  const links = outsideLinks(dir);
  if (log) {
    const note = outsideLinksNote(links);
    if (note !== null) log(note);
  }
  const kept = profile === null ? null : resolve(profile);
  const scratch = scratchDir();
  // A fresh WebKit profile lives in memory; a fresh Chrome one is a new
  // folder, removed at close.
  let temp = null;
  if (kept === null && chosen === "chrome") {
    mkdirSync(join(scratch, "game-test-profiles"), { recursive: true });
    temp = mkdtempSync(join(scratch, "game-test-profiles", "chrome-"));
  }
  const server =
    http === false || http.url !== undefined
      ? null
      : await serveFolder(dir, http === true ? {} : { port: http.port });
  const served = server?.url ?? (http === false ? null : http.url);
  let browser;
  try {
    browser = await launchBrowser(chosen, {
      profile: kept ?? temp,
      crashDumpsDir: join(scratch, "crashdumps"),
      ...(language === null ? {} : { languages: [language] }),
    });
  } catch (error) {
    await server?.close();
    throw error;
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await closeBrowser(browser);
    await server?.close();
    if (temp !== null) rmSync(temp, { recursive: true, force: true });
  };
  try {
    const page = await browser.newPage();
    const errors = collectErrors(page, {
      folder: dir,
      served,
    });
    const linked = outsideLinksError(links);
    if (linked !== null) errors.push(linked);
    await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(TRACK_MEDIA, {
      offPage: mediaChecks !== false,
    });
    if (trace) await page.evaluateOnNewDocument(TRACE_FLAG);
    if (savedState !== null) {
      await page.evaluateOnNewDocument(SEED_STATE, storyKey, savedState);
    }
    const cdp = await page.createCDPSession();
    const url =
      served === null
        ? pathToFileURL(join(dir, "index.html")).href
        : `${served}index.html`;
    await page.goto(
      startAt === null ? url : `${url}#start=${encodeURIComponent(startAt)}`,
    );
    await waitForPlayer(page);
    const storageKey = storyKey ?? (await page.evaluate(FOLDER_KEY));
    if (startAt !== null) await checkStartedAt(page, startAt);
    if (offered !== null && offered.length > 1) {
      const shown = await page.evaluate(SHOWN_LANGUAGE);
      if (shown !== language) {
        throw new Error(
          shown === null
            ? `openGame: this folder's player shows no game languages (a player older than translations); upgrade the folder's player (CREATE.md, "Upgrading to a newer Kinetic") to open it in ${language}`
            : `openGame: the game opened in ${shown}, not ${language} (language): its language file did not load, or the profile holds another pick`,
        );
      }
    }
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
      {
        page,
        cdp,
        errors,
        manifest,
        closeHelp,
        browser,
        indexUrl: url,
        mediaChecks: mediaChecks !== false,
        traced: trace,
      },
      {
        engine: chosen,
        folder: dir,
        kineticVersion: folderKineticVersion(dir),
        language,
        url,
        storageKey,
        close,
      },
    );
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * A page for checkMedia() in a browser context of its own: the game
 * folder's index.html, stopped before it is parsed, so files load from the
 * folder as the game's page loads them and no player starts; given
 * TRACK_MEDIA for its check(). Resolves with `{ context, page }`.
 */
async function openChecker(browser, indexUrl) {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.evaluateOnNewDocument(() => window.stop());
    await page.goto(indexUrl);
    await page.evaluate(TRACK_MEDIA);
    return { context, page };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

function gameHandle(
  {
    page,
    cdp,
    errors,
    manifest,
    closeHelp,
    browser,
    indexUrl,
    mediaChecks,
    traced,
  },
  fields,
) {
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
        .evaluate(READ_STATE, fields.storageKey, true)
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
      endCard: now.endCard,
      segment: readSegment(now.segment),
      audio: now.audio,
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
     * screen, foundBy, ambiguous, endCard, segment, audio }`. `id` and `index` name
     * the item on screen (null and -1 for none); `foundBy` says how it was
     * named ("player", "screen", "saved place", "guess" or "none",
     * findItem); `ambiguous` lists the look-alike items' ids behind a
     * guess, else []; `endCard` is the words of the player's end card
     * when it shows (at the story's end, docs/content-format.md "End
     * card"), else null. `segment` is the active video segment
     * (docs/content-format.md "Video segments"), `{ index, count }` with
     * `index` from 0 (readSegment), else null (always null from a player
     * older than segments). `audio` is the sound (readAudio): `{ unlocked,
     * target, elements }`, where `target` is what should sound here
     * (`{ music, ambience, voice, videoSound }`, from a moment after a
     * walk or jump lands: the player waits 250 ms) and `elements` each
     * sound holding a track, `{ slot, track, paused, currentTime,
     * volume }`, slot "music", "ambience", "sfx", "voice",
     * "video" or "sample" (the Esc screen's Volumes sheet sampling a
     * one-shot or a voice line); null for a game without audio. The
     * player plays nothing in a browser, both engines here included,
     * until the first key or click other than Esc or a Cmd/Ctrl/Alt
     * shortcut (`unlocked` false until then); only the Mac and Windows
     * apps play at once.
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
          now.segment,
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
     * and decoded off the page to find out. On Chrome `pages` pages in
     * browser contexts of their own (default 4) check those files (`pages`
     * 0 checks them in the game's page, 4 at a time); on WebKit the game's
     * page checks them 8 at a time, whatever `pages` says. Either way a
     * failure is listed in errors() once, as one the game's page found.
     * `items`, a list of item ids (the ones a walk showed), adds every
     * file they reference that the page was never given (referencedFiles:
     * an animation's later frames, a video's file shown only as a poster,
     * each audio track's script, decoded as the player decodes it). Call
     * it before reading errors() after a walk. Resolves with `{ files,
     * failed, loaded, checked, neverRequested }`: how many media files
     * the page was given (with those `items` added), the URLs that failed,
     * how many had loaded (or failed) before the check, how many it
     * checked, and how many of those the page was never given (an audio
     * script the player added counts as given). Throws if `stall`
     * ms pass with no file answered (default 20 s; a video check gives up,
     * as failed, after 15 s), if a checking page fails, or on a game
     * opened with `mediaChecks: false`. `onWaiting(count)`, if given, is
     * called once before it waits, with how many files are still to check
     * (not at all when none are); `onProgress({ checked, total })` each
     * time that count changes, the last time with every file checked.
     */
    async checkMedia({
      stall = 20000,
      onWaiting = null,
      onProgress = null,
      pages = CHECKER_PAGES[fields.engine],
      items = [],
    } = {}) {
      if (!mediaChecks) {
        throw new Error(
          "checkMedia: this game was opened with mediaChecks: false, which checks no media file off the page",
        );
      }
      const drain = {
        atOnce: WALKING_PAGE_CHECKS[fields.engine],
        // WebKit's own pages add little (2 more driver processes 7.5 ms a
        // file, 4 more 7.1, against 7.8 in the game's page alone).
        elsewhere: fields.engine === "chrome" && pages > 0,
      };
      const settle = () =>
        page.evaluate((how) => window.__kineticMedia.settle(how), drain);
      let status = await settle();
      const loaded = status.files - status.open;
      let added = { added: 0, neverRequested: 0 };
      if (items.length > 0) {
        added = await page.evaluate(
          (list) => window.__kineticMedia.add(list),
          referencedFiles(manifest, items),
        );
      }
      const checked = status.open + added.added;
      if (added.added > 0) status = await settle();
      if (checked > 0) onWaiting?.(checked);
      // Counted from every file to check, though some may be answered by
      // now (on WebKit the game's page started on them at once).
      let progress = countChecked(null, checked);
      if (checked > 0) onProgress?.(progress);
      const checkers = [];
      const lanes = [];
      let done = false;
      let laneError = null;
      // One of a checking page's lanes: takes a few files from the game's
      // page, checks them there and reports how each went.
      const lane = async (checker) => {
        while (!done) {
          const taken = await page.evaluate(
            (count) => window.__kineticMedia.take(count),
            CHECKER_BATCH,
          );
          if (taken.length === 0) {
            await sleep(50);
            continue;
          }
          const results = await checker.evaluate(
            (files) => window.__kineticMedia.check(files),
            taken,
          );
          await page.evaluate(
            (answers) => window.__kineticMedia.report(answers),
            results,
          );
        }
      };
      try {
        if (drain.elsewhere && status.open > 0) {
          // No more pages than there are batches to give them.
          const count = Math.min(pages, Math.ceil(status.open / CHECKER_BATCH));
          const opening = await Promise.allSettled(
            Array.from({ length: count }, () => openChecker(browser, indexUrl)),
          );
          for (const opened of opening) {
            if (opened.status === "fulfilled") checkers.push(opened.value);
          }
          const refused = opening.find((o) => o.status === "rejected");
          if (refused !== undefined) {
            throw new Error(
              `checkMedia: a checking page did not open: ${refused.reason?.message ?? refused.reason}`,
            );
          }
          for (const checker of checkers) {
            for (let n = 0; n < CHECKER_LANES; n += 1) {
              lanes.push(
                lane(checker.page).catch((error) => {
                  if (!done) laneError ??= error;
                }),
              );
            }
          }
        }
        let fewest = Infinity;
        let since = Date.now();
        for (;;) {
          if (laneError !== null) {
            throw new Error(
              `checkMedia: a checking page failed: ${laneError.message}`,
            );
          }
          const next = countChecked(progress, status.open);
          if (
            next.checked !== progress.checked ||
            next.total !== progress.total
          ) {
            progress = next;
            onProgress?.(progress);
          }
          if (status.open === 0) {
            // The failures' console lines can trail the page's answer.
            const until = Date.now() + 3000;
            const listed = (url) => errors.some((line) => line.includes(url));
            while (!status.failed.every(listed) && Date.now() < until) {
              await sleep(20);
            }
            return {
              files: status.files,
              failed: status.failed,
              loaded,
              checked,
              neverRequested: added.neverRequested,
            };
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
          status = await settle();
        }
      } finally {
        done = true;
        await Promise.all(
          checkers.map((checker) => checker.context.close().catch(() => {})),
        );
        await Promise.all(lanes);
        // Checks while the walk pauses are this page's again.
        if (drain.elsewhere) {
          await page
            .evaluate(() => window.__kineticMedia.settle())
            .catch(() => {});
        }
      }
    },
    /**
     * The item trace's records since the last call (src/render/trace.ts;
     * CREATE.md, "Testing your game"), for a game opened with `trace:
     * true`: resolves `{ records, dropped }`, `records` in the order the
     * player made them (`n` from 0 per page load, so a gap shows) and
     * `dropped` how many the player dropped past its cap of 200,000 since
     * the last call (0 unless the array went that long undrained). Each
     * call empties the page's array and resets that counter in the same
     * round trip (drainTrace), so call it often on a long walk. A reload()
     * starts the trace again from `n` 0: read it before reloading. Rejects
     * on a game opened without `trace: true`, and on a folder whose player
     * keeps no trace (an older one), naming its version and the fix
     * (traceRefusal).
     */
    async trace() {
      if (!traced) {
        throw new Error(
          "trace: this game was opened without trace: true, so the player keeps no item trace",
        );
      }
      const drained = await page.evaluate(`(${drainTrace})(window)`);
      if (drained === null)
        throw new Error(traceRefusal(fields.kineticVersion));
      return drained;
    },
    /**
     * The story's whole state record as the player keeps it now, under
     * `storageKey` (src/storage/idb.ts; the shape belongs to the folder's
     * player version), or null when it has saved none. The player writes
     * it as the screen changes, so read it once the save has landed.
     */
    savedState: () => page.evaluate(READ_STATE, fields.storageKey, false),
    /** The console errors and warnings and the page errors so far. */
    errors: () => [...errors],
  };
}
