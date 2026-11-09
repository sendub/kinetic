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
// in headless Chrome (Chrome and the Windows Edge app). Neither shows a
// window. check-game.mjs beside it is a small example in use.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DriverBuildError, ensureDriver } from "../webkit/build.mjs";
import {
  CHOICE_CLOSED,
  closeBrowser,
  collectErrors,
  dismissHelp,
  keyFor,
  launchBrowser,
  MAP_OPEN,
  matchItems,
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
  chrome: "Chrome (Chrome and the Windows Edge app)",
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

// Everything current() reports, read in one round trip.
const READ_NOW = `({
  state: (${PAGE_STATE})(),
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

// Chrome logs a picture, video or script that fails to load ("Failed to
// load resource"); WebKit logs nothing, so on WebKit this logs it, and
// errors() lists it on both engines. A cleared src (empty) is no load.
const REPORT_FAILED_LOADS = () => {
  window.addEventListener(
    "error",
    (event) => {
      const el = event.target;
      if (!(el instanceof Element)) return;
      const src =
        el.currentSrc || el.getAttribute("src") || el.getAttribute("href");
      if (src) console.error(`Failed to load resource: ${src}`);
    },
    true,
  );
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

function readManifestFile(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    return { items: [] };
  }
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
 * - `log`: gets openGame's notes (default: stderr); null for none.
 * Resolves with the game handle (CREATE.md, "Testing your game").
 */
export async function openGame(folder, options = {}) {
  const {
    engine = "auto",
    viewport = DEFAULT_VIEWPORT,
    profile = null,
    closeHelp = true,
    playAll = null,
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
  const chosen = chooseEngine(engine, log);
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
    if (chosen === "webkit") {
      await page.evaluateOnNewDocument(REPORT_FAILED_LOADS);
    }
    const cdp = await page.createCDPSession();
    const url = pathToFileURL(join(dir, "index.html")).href;
    await page.goto(url);
    await waitForPlayer(page);
    const manifest =
      (await page.evaluate(() => window.KINETIC_MANIFEST ?? null)) ??
      readManifestFile(dir);
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
      const index = items.findIndex((it) => it.id === id);
      if (hits.includes(index)) return index;
      if (Date.now() >= until) return null;
      await sleep(50);
    }
  };

  const describe = async (now) => {
    const s = now.state;
    const videoShown = s.video?.visible === true;
    let hits = matchItems(items, {
      text: s.text,
      file: videoShown ? s.video.poster : s.imgSrc,
    });
    let ambiguous = [];
    if (hits.length > 1) {
      hits = narrowItems(items, hits, {
        speaker: s.speaker ?? "",
        files: videoShown ? [s.video.src, s.video.poster] : [s.imgSrc],
      });
    }
    if (hits.length > 1) {
      // Two items the reader cannot tell apart: the player's own saved
      // place says which, else the nearest ahead of the last one found.
      const saved = await savedAmong(hits);
      if (saved !== null) hits = [saved];
      else {
        ambiguous = hits.map((i) => items[i].id);
        hits = [nearestAfter(hits, lastIndex)];
      }
    }
    const index = hits[0] ?? -1;
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
      ambiguous,
    };
  };

  const current = async () => describe(await read());

  const matcher = (target, who) => {
    if (typeof target === "function") return target;
    if (typeof target === "string") {
      if (!items.some((it) => it.id === target)) {
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
    /** The console errors and warnings and the page errors so far. */
    errors: () => [...errors],
  };
}
