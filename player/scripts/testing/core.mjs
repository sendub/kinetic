// What the scenario suite (../scenarios/harness.mjs) and the creators'
// testing library (kinetic.mjs) share to drive a built game folder with no
// window on screen: starting headless Chrome or the hidden WebKit driver,
// trusted key and mouse input through CDP (or the WebKit driver's stand-in
// for it, ../webkit/puppet.mjs), readers of what the page shows, and the
// manifest items a screen can be. docs/verify-player.md; CREATE.md,
// "Testing your game".
import { existsSync, rmSync } from "node:fs";
import { platform } from "node:os";
import puppeteer from "puppeteer-core";

// --------------------------------------------------------------------------
// Browsers: one per profile, headless Chrome or the WebKit driver.
// --------------------------------------------------------------------------

// Where Chrome usually lives, per system; KINETIC_CHROME names another
// (a Chromium or Microsoft Edge works too).
const CHROME_PLACES = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ],
  win32: [
    `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ],
};
/** The Chrome every Chrome session runs (KINETIC_CHROME, else the usual place). */
export const chromePath =
  process.env.KINETIC_CHROME ??
  (CHROME_PLACES[platform()] ?? []).find((path) => existsSync(path)) ??
  CHROME_PLACES.darwin[0];
/** The screen headless Chrome reports (`--screen-info`). */
export const CHROME_SCREEN = { width: 1920, height: 1200 };

/**
 * puppeteer.launch for every Chrome the tools start (headless, at
 * chromePath, unless `options` says otherwise), so none makes a sound:
 * `--disable-audio-output` gives Chrome's audio service a fake output
 * stream. Media plays, its clock runs in real time and its events fire, the
 * autoplay rule still refuses play() before a key or click, but Chrome
 * opens no Core Audio output (puppeteer's own `--mute-audio` still opens
 * one and plays zeros; measured on macOS 27.2, 2026-11-10). biome.json
 * keeps every other script off puppeteer-core.
 */
export function launchChrome(options = {}) {
  return puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    ...options,
    args: [...(options.args ?? []), "--disable-audio-output"],
  });
}

/**
 * Starts one browser with no window and no sound on `engine` ("chrome" or
 * "webkit": launchChrome; the WebKit driver mutes its page).
 * Chrome runs headless on the profile folder `profile`, emptied first when
 * `fresh`. The WebKit driver keeps its storage in memory (a fresh profile)
 * unless `profile` names a folder to keep it in. `requireGestureForAudio`
 * makes the WebKit driver refuse sound until a key or click, as Safari
 * does (it otherwise allows it, as the macOS app does); headless Chrome
 * always requires one, as Chrome does. Each browser is tracked until
 * closeBrowser or killBrowser, so killLiveBrowsers can reap it.
 */
export async function launchBrowser(
  engine,
  {
    profile = null,
    fresh = false,
    crashDumpsDir,
    requireGestureForAudio = false,
  },
) {
  const launch = async () => {
    if (engine === "webkit") {
      const { launchWebKit } = await import("../webkit/puppet.mjs");
      return launchWebKit({
        ...(profile === null ? {} : { profile }),
        requireGestureForAudio,
      });
    }
    if (fresh) rmSync(profile, { recursive: true, force: true });
    return launchChrome({
      userDataDir: profile,
      protocolTimeout: 30000,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-crash-reporter",
        `--crash-dumps-dir=${crashDumpsDir}`,
        // A reader's browser window sits on a larger screen. Headless
        // otherwise reports a screen the size of the window, which the
        // player reads as a window that already fills the screen, and it
        // would never ask for fullscreen (render/fullscreen.ts).
        `--screen-info={${CHROME_SCREEN.width}x${CHROME_SCREEN.height}}`,
      ],
    });
  };
  // A Chrome killed before it is up (seen once on a loaded machine running
  // scenarios side by side: no exit code, no output) gets one more try;
  // nothing has been checked yet, so the retry hides no finding.
  const browser = await launch().catch((error) => {
    if (!String(error?.message).startsWith("Failed to launch")) throw error;
    return launch();
  });
  liveBrowsers.add(browser);
  return browser;
}

const FAILED_LOAD = "Failed to load resource: ";
// The testing library's reporter (kinetic.mjs) names the file's URL after
// FAILED_LOAD; Chrome's own line names a reason there instead
// (net::ERR_FILE_NOT_FOUND, "the server responded with a status of 404").
const REPORTED_URL = /^[a-z][a-z0-9+.-]*:\/\/\S*$/i;

/**
 * The console errors and warnings and the page errors `page` reports from
 * now on, as `[error] text`, `[warning] text` and `[pageerror] message`,
 * in an array that keeps filling. A warning is typed "warn" on Chrome and
 * "warning" on WebKit; both are kept as `[warning]`.
 *
 * A failed load is listed once per URL. Chrome's own "Failed to load
 * resource" line names no file, so its URL (the message's location) is
 * added; the testing library's reporter names the URL itself. When both
 * report one URL, Chrome's line, which carries the reason, is the one kept.
 */
export function collectErrors(page) {
  const errors = [];
  // Failed URL -> { line: the line listed for it, own: whether Chrome's }.
  const failed = new Map();
  const listFailedLoad = (url, own, line) => {
    const listed = failed.get(url);
    if (listed === undefined) {
      failed.set(url, { line, own });
      errors.push(line);
    } else if (own && !listed.own) {
      // Found by its text: a caller may have taken lines out (splice).
      const at = errors.indexOf(listed.line);
      if (at >= 0) errors[at] = line;
      failed.set(url, { line, own });
    }
  };
  page.on("console", (msg) => {
    const type = msg.type() === "warn" ? "warning" : msg.type();
    if (type !== "error" && type !== "warning") return;
    const text = msg.text();
    if (type === "error" && text.startsWith(FAILED_LOAD)) {
      const named = text.slice(FAILED_LOAD.length);
      const own = !REPORTED_URL.test(named);
      const url = own ? msg.location?.()?.url : named;
      if (url) {
        listFailedLoad(url, own, `[error] ${own ? `${text} (${url})` : text}`);
        return;
      }
    }
    errors.push(`[${type}] ${text}`);
  });
  page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
  return errors;
}

// Every browser launchBrowser started and nobody has closed yet, so the
// scenario runner can reap the ones a timed-out or crashed scenario left
// behind (including one whose open threw after the launch).
const liveBrowsers = new Set();

/**
 * Kill `browser`'s whole process tree now. puppeteer starts Chrome as a
 * process-group leader (detached), so the group kill takes its renderer,
 * GPU and utility children too; the plain kill is the fallback.
 */
export function killBrowser(browser) {
  liveBrowsers.delete(browser);
  browser.disconnect().catch(() => {});
  const proc = browser.process();
  if (proc?.pid === undefined) return;
  // The group outlives its leader while any helper is left, so it is
  // killed even when Chrome itself already exited.
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

// How long a graceful close may take before the browser is killed:
// puppeteer's close waits, unbounded, for the process to exit after
// Browser.close was acknowledged.
const CLOSE_WAIT_MS = 10000;

/** Close `browser`, killing its process tree if the close does not finish. */
export async function closeBrowser(browser) {
  let timer;
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, CLOSE_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  killBrowser(browser);
}

/** Kill every browser still open (after a timeout, and before exit). */
export function killLiveBrowsers() {
  for (const browser of [...liveBrowsers]) killBrowser(browser);
}

// --------------------------------------------------------------------------
// What the page shows, read from the DOM the renderer writes.
// --------------------------------------------------------------------------

// Serialised into the page; reads only what the renderer put in the DOM.
const PAGE_STATE = () => {
  const img = document.getElementById("visual-image");
  const overlay = document.getElementById("overlay");
  const app = document.getElementById("app");
  const textEl = document.getElementById("overlay-text");
  return {
    appChildren: app ? Array.from(app.children).map((el) => el.id) : [],
    imgSrc: img ? (img.getAttribute("src") ?? "") : null,
    imgDecoded: img ? img.complete && img.naturalWidth > 0 : false,
    imgWidth: img ? Math.round(img.getBoundingClientRect().width) : 0,
    imgVisible: img ? getComputedStyle(img).display !== "none" : false,
    video: (() => {
      const v = document.getElementById("visual-video");
      if (v === null) return null;
      const cs = getComputedStyle(v);
      return {
        src: v.getAttribute("src") ?? "",
        poster: v.getAttribute("poster") ?? "",
        loop: v.loop,
        paused: v.paused,
        currentTime: Math.round(v.currentTime * 100) / 100,
        readyState: v.readyState,
        visible: cs.display !== "none",
        posterPainted:
          (v.getAttribute("poster") ?? "") !== "" &&
          cs.backgroundImage.includes(v.getAttribute("poster") ?? "\u0000"),
      };
    })(),
    placeholder: document.getElementById("placeholder")?.textContent ?? null,
    emptyState: document.getElementById("empty-state")?.textContent ?? null,
    overlayHidden: overlay ? overlay.hidden : null,
    overlayChildren: overlay ? overlay.children.length : null,
    speaker: document.getElementById("overlay-speaker")?.textContent ?? null,
    text: textEl?.textContent ?? null,
    // The renderer's speech/thought claim (`data-mode`, set on both the band
    // and the line) and what CSS made of it. The computed font-style is the
    // observable half of docs/plan.md Phase 7b: thought italic, dialogue
    // upright. It resolves even while the band is [hidden].
    overlayMode: overlay?.getAttribute("data-mode") ?? null,
    textMode: textEl?.getAttribute("data-mode") ?? null,
    textFontStyle: textEl ? getComputedStyle(textEl).fontStyle : null,
    mapOpen: (() => {
      const p = document.getElementById("branchmap");
      return p === null ? null : !p.hidden;
    })(),
    // The key help screen and the black screen it puts the stage through
    // (docs/plan.md Phase 13b): panel up/down, stage painted or not.
    helpOpen: (() => {
      const p = document.getElementById("help");
      return p === null ? null : !p.hidden;
    })(),
    stageHidden: (() => {
      const s = document.getElementById("stage");
      return s === null ? null : getComputedStyle(s).display === "none";
    })(),
    fsAttempts: window.__fsAttempts ?? 0,
    firstKeys: window.__firstKeys ?? [],
    fullscreenElement: document.fullscreenElement
      ? document.fullscreenElement.tagName.toLowerCase()
      : null,
  };
};

/**
 * The manifest items (indices into `items`, in manifest order) a screen
 * showing the overlay line `text` over the picture `file` can be: the
 * items with that line when there is one, else the items without a line
 * whose own picture it is (an image's file, a video's poster, an
 * animation's frame). Several when a game repeats a line or a picture;
 * none for a screen no item makes (a notice, the empty state).
 */
export function matchItems(items, { text, file }) {
  const hits = [];
  if (text) {
    items.forEach((it, index) => {
      if (it.text === text) hits.push(index);
    });
    if (hits.length > 0) return hits;
  }
  items.forEach((it, index) => {
    if (
      !it.text &&
      (it.file === file ||
        it.poster === file ||
        (Array.isArray(it.frames) && it.frames.includes(file)))
    )
      hits.push(index);
  });
  return hits;
}

/**
 * matchItems's answers without its scan of every item, for a large game:
 * built once per manifest, then lookupItems gives the same hits in the same
 * order. `byText` maps each line to the items with it; `byFile` maps each
 * picture (an image's file, a video's file and poster, an animation's
 * frames) to the items without a line that show it. Both in manifest
 * order, one entry per item per key.
 */
export function indexItems(items) {
  const byText = new Map();
  const byFile = new Map();
  const add = (map, key, index) => {
    const hits = map.get(key);
    if (hits === undefined) map.set(key, [index]);
    else if (hits.at(-1) !== index) hits.push(index);
  };
  items.forEach((it, index) => {
    if (it.text) {
      add(byText, it.text, index);
      return;
    }
    const frames = Array.isArray(it.frames) ? it.frames : [];
    for (const file of [it.file, it.poster, ...frames]) {
      if (typeof file === "string") add(byFile, file, index);
    }
  });
  return { byText, byFile };
}

/** matchItems(items, screen), answered from `index` (indexItems(items)); a new array each call. */
export function lookupItems(index, { text, file }) {
  if (text) {
    const hits = index.byText.get(text);
    if (hits !== undefined) return [...hits];
  }
  return [...(index.byFile.get(file) ?? [])];
}

const HELP_OPEN = () => {
  const p = document.getElementById("help");
  return p !== null && !p.hidden;
};
const HELP_CLOSED = () => {
  const p = document.getElementById("help");
  return p === null || p.hidden;
};
const helpOpen = (page) => page.evaluate(HELP_OPEN);

// The central "close the help if it is up" driver helper (Phase 13b):
// every existing step that assumed first-run goes straight to item 1
// dismisses the help through this, pressing Escape — the help's own key
// and a closing action that touches nothing else (Enter is no key since
// Phase 18's "Key help simplified"). Trusted either through CDP or puppeteer's own
// keyboard (which openAtViewport, without a CDP session, still drives
// through CDP); the wait after it proves the close happened.
const dismissHelp = async (page, cdp) => {
  await page.waitForFunction(() => document.getElementById("help") !== null, {
    timeout: 5000,
  });
  if (!(await helpOpen(page))) return false;
  await pressEscape(cdp);
  await page.waitForFunction(HELP_CLOSED, { timeout: 5000 });
  return true;
};

// The `#choice` decision overlay (Phase 13) as the reader sees it: the
// prompt, and each row's number, label, `seen` marker and whether it is
// the unnumbered return offer. Purely the DOM render/choice.ts writes —
// the driver asserts the screen, never machine state.
const READ_CHOICE = () => {
  const panel = document.getElementById("choice");
  if (panel === null) return { present: false };
  if (panel.hidden) return { present: true, hidden: true };
  return {
    present: true,
    hidden: false,
    prompt: document.querySelector(".choice-title")?.textContent ?? null,
    rows: Array.from(document.querySelectorAll(".choice-row")).map((el) => ({
      idx: el.getAttribute("data-choice-idx"),
      isContinue: el.hasAttribute("data-choice-continue"),
      number: el.querySelector(".choice-num")?.textContent ?? "",
      label: el.querySelector(".choice-label")?.textContent ?? "",
      seen: el.querySelector(".choice-seen")?.textContent ?? null,
      // The play-all next pick, or the route a wheel walk takes through
      // this screen (docs/plan.md Phase 27).
      next: el.classList.contains("choice-next"),
    })),
  };
};
const CHOICE_OPEN = () => {
  const p = document.getElementById("choice");
  return p !== null && !p.hidden;
};
const CHOICE_CLOSED = () => {
  const p = document.getElementById("choice");
  return p === null || p.hidden;
};
const choiceOpen = (page) => page.evaluate(CHOICE_OPEN);

const MAP_OPEN = () => {
  const p = document.getElementById("branchmap");
  return p !== null && !p.hidden;
};
const mapOpen = (page) => page.evaluate(MAP_OPEN);

const CONFIG_OPEN = () => {
  const p = document.getElementById("config");
  return p !== null && !p.hidden;
};
const CONFIG_CLOSED = () => {
  const p = document.getElementById("config");
  return p === null || p.hidden;
};
const configOpen = (page) => page.evaluate(CONFIG_OPEN);

// Escape until `predicate` holds: the settings live on the Esc screen
// (Phase 26), so Escape opens and closes them. Returns whether the
// predicate held.
// A predicate that already holds sends nothing: Escape toggles the screen,
// so pressing it then would undo the state the caller asked for and leave
// every later open/close one step out of phase.
// Whether the browser keeps an Escape to leave fullscreen cannot be
// predicted from `document.fullscreenElement`: in Chrome the player locks
// Escape once fullscreen (Keyboard Lock, Phase 43), so a short Escape
// reaches the page, but one sent in the moment before the lock takes hold
// is the browser's. So each press is followed by asking the page whether
// it saw the key: seen, the page acted on it and the predicate is awaited;
// not seen, the browser kept it to leave fullscreen and one more press
// goes to the page.
async function escapeUntil(page, cdp, predicate) {
  if (await page.evaluate(predicate)) return true;
  for (let press = 0; press < 2; press += 1) {
    if (await pressEscapeSeen(page, cdp)) break;
    try {
      await page.waitForFunction(() => document.fullscreenElement === null, {
        timeout: CLICK_WAIT_MS,
      });
    } catch {
      return false; // kept by the browser, yet still fullscreen
    }
  }
  try {
    await page.waitForFunction(predicate, { timeout: CLICK_WAIT_MS });
    return true;
  } catch {
    return false;
  }
}
/** Opens the Esc screen's settings (Phase 26). */
const openSettings = (page, cdp) => escapeUntil(page, cdp, CONFIG_OPEN);
/** Closes the Esc screen with its own key. */
const closeSettings = (page, cdp) => escapeUntil(page, cdp, CONFIG_CLOSED);
// The bounded wait for a control (or a screen) to be there before the
// driver acts on it: a loaded machine running the whole suite can take
// seconds to lay a panel out.
const CLICK_WAIT_MS = 5000;
// The Esc screen's settings controls (the reset box's buttons are the
// harness's CONFIRM_CONTROL), as clickCenter takes them: a selector is
// resolved when the click happens, after waiting for the control, not from
// a rect read before it was drawn.
const CONFIG_CONTROL = {
  title: ".config-title",
  skip: ".config-skip-all",
  play: ".config-play-all",
  speedUp: '[data-config-action="speed-up"]',
  speedDown: '[data-config-action="speed-down"]',
  reset: ".config-reset",
  exportProgress: '[data-config-action="export-progress"]',
  importProgress: '[data-config-action="import-progress"]',
};
// The rect of the first element matching `selector` once it exists, is
// visible (no hidden ancestor, no display:none or visibility:hidden) and
// has a non-zero box; null until then.
const visibleRect = async (cdp, selector) => {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null || !el.checkVisibility({ visibilityProperty: true }))
        return null;
      // A control below the fold of a scrolling panel is scrolled to, as
      // a reader would, before the click (the Esc screen's 13th key row
      // pushed Reset below 600 px).
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    })()`,
    returnByValue: true,
  });
  if (exceptionDetails !== undefined) {
    throw new Error(
      `clickCenter: cannot query "${selector}": ${exceptionDetails.text}`,
    );
  }
  return result.value ?? null;
};
const isRect = (r) =>
  r !== null &&
  typeof r === "object" &&
  [r.left, r.right, r.top, r.bottom].every(Number.isFinite) &&
  r.right > r.left &&
  r.bottom > r.top;
/**
 * A trusted click at the centre of `target`: a CSS selector (preferred) is
 * waited for — present, visible, with a non-zero box — for up to
 * CLICK_WAIT_MS and then clicked where it is; a rect read earlier is
 * clicked as given. Either throws a clear error, naming the selector,
 * instead of clicking nowhere when the control is not there.
 */
const clickCenter = async (cdp, target) => {
  let rect = target;
  if (typeof target === "string") {
    const deadline = Date.now() + CLICK_WAIT_MS;
    rect = await visibleRect(cdp, target);
    while (rect === null && Date.now() < deadline) {
      await sleep(50);
      rect = await visibleRect(cdp, target);
    }
    if (rect === null) {
      throw new Error(
        `clickCenter: "${target}" not present, visible and laid out after ${CLICK_WAIT_MS} ms`,
      );
    }
  } else if (!isRect(target)) {
    throw new Error(
      `clickCenter: no laid-out rect to click (got ${JSON.stringify(target)}); pass the control's selector so the click waits for it`,
    );
  }
  await clickAt(
    cdp,
    Math.round((rect.left + rect.right) / 2),
    Math.round((rect.top + rect.bottom) / 2),
  );
};

// Play all routes as the Esc screen's switch shows it.
const READ_PLAY_ALL = () => {
  const toggle = document.querySelector(".config-play-all");
  return {
    playLabel: toggle?.textContent ?? null,
    playPressed: toggle?.getAttribute("aria-pressed") ?? null,
  };
};

/**
 * Set `Play all routes` through the Esc screen as a reader would (Phase
 * 26): open it with Escape, click the switch only when it is not already
 * `on`, close it with Escape (a click never closes it, docs/plan.md Phase
 * 24). Returns the switch as it read after the click (`after`: its
 * `playLabel` and `playPressed`) and whether the screen closed. Play all
 * routes is on by default (docs/plan.md Phase 24); a walk that makes its
 * own choices turns it off with this.
 */
async function setPlayAll(page, cdp, on) {
  await openSettings(page, cdp);
  const before = await page.evaluate(READ_PLAY_ALL);
  if (before.playPressed !== String(on))
    await clickCenter(cdp, CONFIG_CONTROL.play);
  const after = await page.evaluate(READ_PLAY_ALL);
  await closeSettings(page, cdp); // its key closes it (a click never does)
  const closed = !(await page.evaluate(CONFIG_OPEN));
  return { after, closed };
}

// --------------------------------------------------------------------------
// Input: trusted keys and clicks through CDP (the WebKit driver answers the
// same calls).
// --------------------------------------------------------------------------

/**
 * CDP's native key code for `key`, sent for Escape alone. With one, Chrome's
 * browser process sees the key too: before the page, where it leaves
 * fullscreen on Escape (the player's Keyboard Lock is tested against
 * that), and after it, when the page leaves the key unhandled. In headless
 * Chrome on macOS such a key then plays the system alert sound (each
 * unhandled key one beep, measured 2026-11-10), and Delete or Backspace
 * stop the page's animation frames for good (bookmarkmap's note). Without
 * one, the key reaches the page alone. The player takes every Escape.
 */
const nativeCode = (key, keyCode) =>
  key === "Escape" ? { nativeVirtualKeyCode: keyCode } : {};

async function pressKey(cdp, key, code, keyCode, text) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    ...nativeCode(key, keyCode),
    text,
    unmodifiedText: text,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    ...nativeCode(key, keyCode),
  });
}

/**
 * A navigation key (the arrows, Page Up / Page Down, Home, End, Delete,
 * Backspace), sent with no native key code (nativeCode).
 */
async function pressNavKey(cdp, key, keyCode) {
  for (const type of ["keyDown", "keyUp"])
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key,
      code: key,
      windowsVirtualKeyCode: keyCode,
    });
}

// The keys a press names, as [key, code, keyCode, text] (letters and digits
// are built in keyFor), and the keys sent as pressNavKey sends them.
const TYPED_KEYS = {
  Space: [" ", "Space", 32, " "],
  Tab: ["Tab", "Tab", 9, ""],
  Enter: ["Enter", "Enter", 13, "\r"],
  Escape: ["Escape", "Escape", 27, ""],
};
const NAV_KEYS = {
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  Delete: 46,
  Backspace: 8,
};

/**
 * The key event a key name stands for: Space (or " "), Tab, Enter, Escape,
 * a letter (either case: the lowercase key), a digit, or a NAV_KEYS name.
 * Returns `{ key, code, keyCode, text, nav }`; throws for any other name.
 */
export function keyFor(name) {
  const named = name === " " ? "Space" : name;
  if (Object.hasOwn(TYPED_KEYS, named)) {
    const [key, code, keyCode, text] = TYPED_KEYS[named];
    return { key, code, keyCode, text, nav: false };
  }
  if (Object.hasOwn(NAV_KEYS, named)) {
    return {
      key: named,
      code: named,
      keyCode: NAV_KEYS[named],
      text: "",
      nav: true,
    };
  }
  if (/^[a-z]$/i.test(named)) {
    const key = named.toLowerCase();
    const upper = key.toUpperCase();
    return {
      key,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      text: key,
      nav: false,
    };
  }
  if (/^[0-9]$/.test(named)) {
    return {
      key: named,
      code: `Digit${named}`,
      keyCode: 48 + Number(named),
      text: named,
      nav: false,
    };
  }
  throw new Error(
    `no key named ${JSON.stringify(name)}: name Space, Tab, Enter, Escape, a letter, a digit or one of ${Object.keys(NAV_KEYS).join(", ")}`,
  );
}

/** One press of the key `name` (keyFor). */
function pressNamed(cdp, name) {
  const k = keyFor(name);
  return k.nav
    ? pressNavKey(cdp, k.key, k.keyCode)
    : pressKey(cdp, k.key, k.code, k.keyCode, k.text);
}
/** A key's identity fields for CDP's Input.dispatchKeyEvent (nativeCode). */
function keyIds(k) {
  return k.nav
    ? { key: k.key, code: k.key, windowsVirtualKeyCode: k.keyCode }
    : {
        key: k.key,
        code: k.code,
        windowsVirtualKeyCode: k.keyCode,
        ...nativeCode(k.key, k.keyCode),
      };
}
/** CDP's `modifiers` bit for each shortcut modifier. */
const SHORTCUT_MODIFIERS = { Alt: 1, Control: 2, Meta: 4 };
/**
 * One press of the key `name` (keyFor) held with `modifier`: "Meta" (⌘),
 * "Control" or "Alt", sent as CDP's `modifiers`, so the page's keydown
 * carries metaKey, ctrlKey or altKey. A shortcut types no text. On WebKit a
 * keydown held with ⌘ is offered to the window as a key equivalent first,
 * as AppKit does in the macOS app (`page.keyEquivalents`).
 */
async function pressShortcut(cdp, modifier, name) {
  const modifiers = SHORTCUT_MODIFIERS[modifier];
  if (modifiers === undefined)
    throw new Error(
      `no modifier named ${JSON.stringify(modifier)}: name Meta, Control or Alt`,
    );
  const ids = keyIds(keyFor(name));
  for (const type of ["keyDown", "keyUp"])
    await cdp.send("Input.dispatchKeyEvent", { type, ...ids, modifiers });
}
/**
 * Holds the key `name` (keyFor) down: its keydown, `repeats` more keydowns
 * as auto-repeats (CDP's `autoRepeat`, so the page sees `repeat: true` and
 * the WebKit driver sends `isARepeat`), then its keyup.
 */
async function holdKey(cdp, name, repeats) {
  const k = keyFor(name);
  const ids = keyIds(k);
  const typed = k.nav ? {} : { text: k.text, unmodifiedText: k.text };
  for (let n = 0; n <= repeats; n += 1) {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...ids,
      ...typed,
      autoRepeat: n > 0,
    });
  }
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...ids });
}
const pressSpace = (cdp) => pressNamed(cdp, "Space");
const pressH = (cdp) => pressNamed(cdp, "h");
const pressTab = (cdp) => pressNamed(cdp, "Tab");
const pressE = (cdp) => pressNamed(cdp, "e");
const pressU = (cdp) => pressNamed(cdp, "u");
const pressB = (cdp) => pressNamed(cdp, "b");
// `t` no longer does anything (Phase 35); scenarios press it to prove that.
const pressT = (cdp) => pressNamed(cdp, "t");
const pressM = (cdp) => pressNamed(cdp, "m");
const pressZ = (cdp) => pressNamed(cdp, "z");
// `c` opens nothing since Phase 26 (the settings live on the Esc screen);
// the key stays here so a scenario can prove it inert.
const pressC = (cdp) => pressNamed(cdp, "c");
const pressA = (cdp) => pressNamed(cdp, "a");
const pressEnter = (cdp) => pressNamed(cdp, "Enter");
const pressEscape = (cdp) => pressNamed(cdp, "Escape");
// Escape, then whether the page's own keydown saw it (true) or the browser
// kept it, as it does to leave fullscreen (false). The CDP key dispatch
// resolves once the page has handled the key, so the answer is final.
const ARM_ESCAPE_PROBE = () => {
  if (window.__escapeProbe !== true) {
    window.__escapeProbe = true;
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") window.__escapeSeen = true;
      },
      true,
    );
  }
  window.__escapeSeen = false;
};
const pressEscapeSeen = async (page, cdp) => {
  await page.evaluate(ARM_ESCAPE_PROBE);
  await pressEscape(cdp);
  return page.evaluate(() => window.__escapeSeen === true);
};
// A decision route digit (Phase 13): the overlay takes 1..9 as its own
// input (keys.ts's routeIndexForKey reads `key`).
const pressDigit = (cdp, digit) => pressNamed(cdp, String(digit));

// A trusted left click at page coordinates: a control is clicked the way a
// reader clicks it, through CDP Input.
const clickAt = async (cdp, x, y) => {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export {
  CHOICE_CLOSED,
  CHOICE_OPEN,
  CONFIG_CLOSED,
  CONFIG_CONTROL,
  CONFIG_OPEN,
  choiceOpen,
  clickAt,
  clickCenter,
  closeSettings,
  configOpen,
  dismissHelp,
  escapeUntil,
  HELP_CLOSED,
  HELP_OPEN,
  helpOpen,
  holdKey,
  MAP_OPEN,
  mapOpen,
  openSettings,
  PAGE_STATE,
  pressA,
  pressB,
  pressC,
  pressDigit,
  pressE,
  pressEnter,
  pressEscape,
  pressEscapeSeen,
  pressH,
  pressKey,
  pressM,
  pressNamed,
  pressNavKey,
  pressShortcut,
  pressSpace,
  pressT,
  pressTab,
  pressU,
  pressZ,
  READ_CHOICE,
  setPlayAll,
  sleep,
};
