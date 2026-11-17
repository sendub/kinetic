// The game's own window controls (docs/plan.md Phase 43 item 9): the Esc
// screen's Fullscreen | Window switch and Exit, under a game app's host
// and in a browser tab.
//
// With a host (`open(name, { host })`: on WebKit the macOS app's own Swift
// bridge with a recording host, in Chrome a stand-in object of the same
// shape), Exit sends `{ type: "quit" }`, a half sends `{ type: "display",
// mode }`, the pressed half follows the host's mode (a change the reader
// makes with the system's controls included), and the page never asks for
// element fullscreen. Both host kinds behave alike.
//
// In a browser tab, the page keeps the Display setting: Escape never asks
// for fullscreen and any other key asks while windowed, again after the
// reader leaves; Window leaves fullscreen and stops the asking, across a
// reload; Fullscreen asks at once; nothing asks when the window already
// fills the screen; Exit closes the tab where the browser lets a page close
// itself, else says to close it in the `#flash` pill over the Esc screen
// (docs/plan.md Phase 43 item 12), nothing on the screen moving. A host
// that appears after load takes over.
// WebKit's web view has element fullscreen off, so the checks that need
// the page to be fullscreen there are PARTIAL (as in screens and reading).
//
// Held keys under the macOS app's host (the user's play check, 2026-11-09:
// holding Esc took the app out of fullscreen): the page takes every
// keydown of a key it owns, repeats included, and acts on the first alone.
// On WebKit the driver's window is the app's own class (KineticWindow), and
// each key the page leaves unhandled comes back to it from the web view: a
// held Esc, Space or Tab sends nothing back, and a key the page leaves
// alone comes back, repeats included, and goes no further than the window.
//
// ⌘H under the macOS app's host (the user's play check, 2026-11-09: ⌘H hid
// the text, never the app): a key held with ⌘ is the host's, so the page
// runs nothing on ⌘H and leaves it, while a plain h still hides the text.
// On WebKit the web view claims ⌘H as a key equivalent only to give the
// page its turn, then hands it back unclaimed, where NSApp offers it to the
// app's main menu (Hide is ⌘H).

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CHROME_SCREEN,
  clickAt,
  clickCenter,
  closeSettings,
  currentItemId,
  demoDir,
  helpOpen,
  holdKey,
  onWebKit,
  openSettings,
  PAGE_STATE,
  pressC,
  pressEscape,
  pressH,
  pressShortcut,
  pressSpace,
  READ_CONFIG_RECTS,
  sleep,
} from "./harness.mjs";

export const title =
  "window controls: Fullscreen | Window and Exit, with a host and in a tab";

const HALF = {
  fullscreen: '[data-config-action="display-fullscreen"]',
  window: '[data-config-action="display-window"]',
};
const EXIT = '[data-config-action="exit-game"]';

/**
 * The window controls and what the page knows about fullscreen; `note` is
 * the tab note when the `#flash` pill says it.
 */
const READ_WINDOW = (closeTabNote) => {
  const half = (mode) =>
    document.querySelector(`[data-config-action="display-${mode}"]`);
  const pressed = ["fullscreen", "window"].filter(
    (mode) => half(mode)?.getAttribute("aria-pressed") === "true",
  );
  const pill = document.getElementById("flash")?.textContent ?? null;
  return {
    pressed: pressed.length === 1 ? pressed[0] : pressed.join("+") || null,
    visible:
      half("fullscreen")?.checkVisibility() === true &&
      document
        .querySelector('[data-config-action="exit-game"]')
        ?.checkVisibility() === true,
    note: pill === closeTabNote ? pill : null,
    fsAttempts: window.__fsAttempts ?? 0,
    fullscreen: document.fullscreenElement !== null,
    history: history.length,
  };
};
const readWindow = (page) =>
  page.evaluate(
    READ_WINDOW,
    "This browser keeps the tab open: close the tab to exit.",
  );
/** Host messages as text, `type` first (the Swift side orders keys its own way). */
const asText = (messages) =>
  messages
    .map((m) => (m.mode === undefined ? m.type : `${m.type} ${m.mode}`))
    .join(", ");

const waitFor = async (page, fn, timeout = 2000, arg = undefined) => {
  try {
    await page.waitForFunction(fn, { timeout }, arg);
    return true;
  } catch {
    return false;
  }
};
/** Waits for the page to be fullscreen (true) or not; false on timeout. */
const waitFullscreen = (page, want, timeout = 2000) =>
  waitFor(
    page,
    (w) => (document.fullscreenElement !== null) === w,
    timeout,
    want,
  );
const pressedIs = (page, mode) =>
  waitFor(
    page,
    (m) =>
      document
        .querySelector(`[data-config-action="display-${m}"]`)
        ?.getAttribute("aria-pressed") === "true",
    2000,
    mode,
  );

/**
 * A game app: Exit, both halves and a host-side change, for one host kind.
 * Nothing the reader does asks for element fullscreen.
 */
async function hostSession({ check, open }, kind) {
  const { page, cdp, host } = await open(kind, {
    closeHelp: true,
    host: { kind, display: "fullscreen" },
  });
  // Gestures that would ask in a tab: keys and a click on the story.
  await pressSpace(cdp);
  await pressC(cdp);
  await clickAt(cdp, 400, 300);
  await pressSpace(cdp);
  await sleep(150);
  const gestures = await readWindow(page);
  check(
    `${kind}: keys and clicks never ask for element fullscreen under a host`,
    gestures.fsAttempts === 0 && gestures.fullscreen === false,
    gestures,
  );

  const opened = await openSettings(page, cdp);
  const first = await readWindow(page);
  check(
    `${kind}: the Esc screen shows Fullscreen | Window and Exit, the host's mode (Fullscreen) pressed`,
    opened && first.visible && first.pressed === "fullscreen",
    first,
  );

  await clickCenter(cdp, HALF.window);
  const sentWindow = await host.waitForMessages(1);
  await sleep(150);
  const waiting = await readWindow(page);
  check(
    `${kind}: the Window half sends { type: "display", mode: "window" }; Fullscreen stays pressed until the host switches`,
    asText(sentWindow) === "display window" &&
      waiting.pressed === "fullscreen" &&
      waiting.fsAttempts === 0,
    { sentWindow, waiting },
  );

  // The host switched (the page's request carried out, or the reader's
  // own green button or shortcut): the pressed half follows.
  await host.setDisplay("window");
  const followed = await pressedIs(page, "window");
  await clickCenter(cdp, HALF.window); // the pressed half: nothing to send
  await clickCenter(cdp, HALF.fullscreen);
  const sentBoth = await host.waitForMessages(2);
  await sleep(150);
  check(
    `${kind}: a host-side change to Window moves the pressed half; then the pressed half sends nothing and Fullscreen sends mode "fullscreen"`,
    followed && asText(sentBoth) === "display window, display fullscreen",
    { followed, sentBoth },
  );

  // A change while the screen is closed shows when it opens.
  await closeSettings(page, cdp);
  await host.setDisplay("fullscreen");
  await openSettings(page, cdp);
  const reopened = await readWindow(page);

  // The host's mode outlives a reload: the page starts with it (the macOS
  // bridge swaps its user script on every change).
  await host.setDisplay("window");
  await page.reload();
  await waitFor(page, () => document.getElementById("config") !== null, 5000);
  await openSettings(page, cdp);
  const reloaded = await readWindow(page);
  check(
    `${kind}: after a reload the page starts in the host's mode now (Window pressed)`,
    reloaded.pressed === "window" && reloaded.fsAttempts === 0,
    reloaded,
  );
  await host.setDisplay("fullscreen");
  await pressedIs(page, "fullscreen");
  await clickCenter(cdp, EXIT);
  const sentQuit = await host.waitForMessages(3);
  await sleep(200);
  const after = await readWindow(page);
  check(
    `${kind}: a change made with the screen closed shows when it opens; Exit sends { type: "quit" } and no element fullscreen was ever asked for`,
    reopened.pressed === "fullscreen" &&
      asText(sentQuit) === "display window, display fullscreen, quit" &&
      after.note === null &&
      after.fsAttempts === 0,
    { reopened: reopened.pressed, sentQuit, after },
  );
}

const macApp = (ctx) => hostSession(ctx, "mac-app");
const windowsApp = (ctx) => hostSession(ctx, "windows-app");

/** Presses `press` and reports whether the page asked for fullscreen. */
async function asks(page, press) {
  const before = await readWindow(page);
  await press();
  await sleep(120);
  const after = await readWindow(page);
  return {
    wasFullscreen: before.fullscreen,
    asked: after.fsAttempts - before.fsAttempts,
  };
}

/** A browser tab: the asking rules, the Display setting, a late host. */
async function browserTab({ check, open }) {
  const { page, cdp } = await open("tab", { closeHelp: true });
  const start = await readWindow(page);
  check(
    "tab: Escape (closing the first-load screen) never asks for fullscreen",
    start.fsAttempts === 0 && start.fullscreen === false,
    start,
  );

  const space = await asks(page, () => pressSpace(cdp));
  const entered = await waitFullscreen(page, true);
  const whileFull = await asks(page, () => pressC(cdp));
  check(
    "tab: a key while windowed asks for fullscreen; none while fullscreen",
    space.asked === 1 && (entered ? whileFull.asked === 0 : "PARTIAL"),
    { space, entered, whileFull },
  );

  // The reader leaves (holding Esc does it in Chrome); the next key asks
  // again, Escape never.
  if (entered) await page.evaluate(() => document.exitFullscreen());
  await waitFullscreen(page, false);
  const onEscape = await asks(page, () => pressEscape(cdp));
  const helpUp = await page.evaluate(
    () => !document.getElementById("help").hidden,
  );
  if (helpUp) await pressEscape(cdp); // close the screen Escape opened
  const again = await asks(page, () => pressC(cdp));
  check(
    "tab: after leaving fullscreen the next key asks again, Escape never",
    onEscape.asked === 0 &&
      helpUp &&
      again.wasFullscreen === false &&
      again.asked === 1,
    { onEscape, helpUp, again },
  );
  await waitFullscreen(page, true);

  // Window: leaves fullscreen and stops the asking.
  await openSettings(page, cdp);
  const shown = await readWindow(page);
  await clickCenter(cdp, HALF.window);
  const left = await waitFullscreen(page, false);
  const chose = await readWindow(page);
  await closeSettings(page, cdp);
  const quiet = [
    await asks(page, () => pressSpace(cdp)),
    await asks(page, () => pressC(cdp)),
    await asks(page, () => clickAt(cdp, 400, 300)),
  ];
  check(
    "tab: the switch shows Fullscreen (the default); Window leaves fullscreen, is pressed, and then no key or click asks",
    shown.visible &&
      shown.pressed === "fullscreen" &&
      chose.pressed === "window" &&
      left &&
      chose.fullscreen === false &&
      quiet.every((q) => q.asked === 0),
    { shown, chose, left, quiet },
  );

  // The setting is kept with the others.
  await page.reload();
  await waitFor(page, () => document.getElementById("config") !== null, 5000);
  const reloadQuiet = await asks(page, () => pressSpace(cdp));
  await openSettings(page, cdp);
  const kept = await readWindow(page);
  check(
    "tab: Window survives a reload: still pressed, and still no asking",
    kept.pressed === "window" &&
      reloadQuiet.asked === 0 &&
      kept.fsAttempts === 0,
    { kept, reloadQuiet },
  );

  // Fullscreen: the click is the gesture.
  await clickCenter(cdp, HALF.fullscreen);
  const reentered = await waitFullscreen(page, true);
  const asked = await readWindow(page);
  check(
    "tab: Fullscreen asks for fullscreen at once and is pressed",
    asked.pressed === "fullscreen" &&
      asked.fsAttempts === 1 &&
      (reentered ? true : "PARTIAL"),
    { asked, reentered },
  );

  // Windowed again (the reader held Esc): a click on a settings control
  // still asks nothing, since the request would spend the gesture the
  // control may need (Import's file picker).
  if (reentered) await page.evaluate(() => document.exitFullscreen());
  await waitFullscreen(page, false);
  const onControl = [
    await asks(page, () => clickCenter(cdp, ".config-skip-all")),
    await asks(page, () => clickCenter(cdp, ".config-skip-all")),
  ];
  check(
    "tab: windowed, a click on a settings control asks nothing",
    onControl.every((q) => q.wasFullscreen === false && q.asked === 0),
    { onControl },
  );
  await closeSettings(page, cdp);

  // A window that already fills the screen asks nothing.
  const screen = onWebKit
    ? await page.evaluate(() => ({
        width: screen.width,
        height: screen.height,
      }))
    : CHROME_SCREEN;
  const viewport = page.viewport();
  await page.setViewport({ ...screen, deviceScaleFactor: 1 });
  await sleep(150);
  const filled = await asks(page, () => pressC(cdp));
  if (viewport !== null) await page.setViewport(viewport);
  await sleep(150);
  check(
    "tab: a window that already fills the screen does not ask",
    filled.wasFullscreen === false && filled.asked === 0,
    { filled, screen },
  );

  // A host that appears after load takes over (the protocol allows a
  // late host; both apps define theirs as the document starts): the
  // switch shows its mode, its halves and Exit go to it, and nothing asks
  // for element fullscreen.
  await page.evaluate(() => {
    window.__late = [];
    Object.defineProperty(window, "kineticHost", {
      value: Object.freeze({
        kind: "windows-app",
        display: "window",
        send: (message) => window.__late.push(message),
      }),
    });
    window.dispatchEvent(new Event("kinetic-host"));
  });
  const tookOver = await pressedIs(page, "window");
  await openSettings(page, cdp);
  const lateBefore = await readWindow(page);
  await clickCenter(cdp, HALF.fullscreen);
  await clickCenter(cdp, EXIT);
  await waitFor(
    page,
    () => window.__late.filter((m) => m.type !== "language").length >= 2,
  );
  await closeSettings(page, cdp);
  const lateKey = await asks(page, () => pressSpace(cdp));
  const sentLate = await page.evaluate(() => window.__late);
  // The page tells a late host its language as it arrives (docs/plan.md
  // Phase 56 item 7), before anything else.
  const late = sentLate.filter((m) => m.type !== "language");
  check(
    "tab: a host that appears after load takes over: told the page's language first, its mode pressed, a half and Exit sent to it, no fullscreen asked",
    tookOver &&
      sentLate[0]?.type === "language" &&
      sentLate[0]?.ui === "en" &&
      asText(late) === "display fullscreen, quit" &&
      lateKey.asked === 0 &&
      (await readWindow(page)).fsAttempts === lateBefore.fsAttempts,
    { tookOver, sentLate, lateKey },
  );
}

/** Clicks Exit and waits for the pill to say the tab note; true once it does. */
async function exitAndWaitForNote(page, cdp) {
  await clickCenter(cdp, EXIT);
  return waitFor(
    page,
    (text) => document.getElementById("flash")?.textContent === text,
    3000,
    "This browser keeps the tab open: close the tab to exit.",
  );
}

/**
 * Exit in a browser tab, both ways. Where the browser will not let a page
 * close its own tab (more than one history entry: Chrome's scenario page,
 * or WebKit's after a fragment step), the page asks nothing that would be
 * refused (a refused `window.close()` logs a warning; the session's console
 * check would see it) and says to close the tab. A tab opened straight on
 * the game (one history entry: a new Chrome tab, a fresh WebKit page)
 * closes.
 */
async function exitInTab({ check, open }) {
  const { browser, page, cdp } = await open("exit", { closeHelp: true });
  if (onWebKit) {
    await page.evaluate(() => {
      location.hash = "again";
    });
  }
  await openSettings(page, cdp);
  const before = await readWindow(page);
  const rowsBefore = await page.evaluate(READ_CONFIG_RECTS);
  const said = await exitAndWaitForNote(page, cdp);
  const rowsAfter = await page.evaluate(READ_CONFIG_RECTS);
  check(
    "tab: where the browser will not let the page close its tab, Exit says to close the tab in the pill, nothing on the Esc screen moves, and the page stays",
    before.history === 2 &&
      said &&
      JSON.stringify(rowsAfter) === JSON.stringify(rowsBefore) &&
      page.isClosed() === false,
    { history: before.history, said, closed: page.isClosed() },
  );

  const url = pathToFileURL(join(demoDir, "index.html")).href;
  let tab;
  let context = null;
  if (onWebKit) {
    // A fresh driver: its first page has one history entry.
    context = await browser.createBrowserContext();
    tab = await context.newPage();
    await tab.goto(url);
  } else {
    // Puppeteer's pages start at about:blank; a tab created on the URL
    // has the game as its only entry, as a double-clicked index.html does.
    const session = await browser.target().createCDPSession();
    await session.send("Target.createTarget", { url });
    const target = await browser.waitForTarget(
      (t) => t.type() === "page" && t.url() === url && t !== page.target(),
      { timeout: 5000 },
    );
    tab = await target.page();
  }
  const errors = [];
  tab.on("console", (msg) => {
    // console.warn is "warn" on Chrome, "warning" on WebKit.
    if (["error", "warn", "warning"].includes(msg.type())) {
      errors.push(msg.text());
    }
  });
  tab.on("pageerror", (err) => errors.push(err.message));
  await tab.waitForFunction(() => document.getElementById("config") !== null, {
    timeout: 5000,
  });
  // A fresh WebKit profile opens on the Esc screen; Chrome's tab shares
  // the scenario page's profile, which has seen it, so Escape opens it.
  const tabCdp = await tab.createCDPSession();
  const opened = await openSettings(tab, tabCdp);
  const history = await tab.evaluate(() => history.length);
  const closing = new Promise((resolve) => tab.on("close", resolve));
  await clickCenter(tabCdp, EXIT);
  const closed = await Promise.race([
    closing.then(() => true),
    sleep(3000).then(() => false),
  ]);
  check(
    "tab: a tab opened straight on the game (one history entry) closes on Exit, its console clean",
    opened && history === 1 && closed && tab.isClosed() && errors.length === 0,
    { opened, history, closed, errors },
  );
  if (context !== null) await context.close();
}

/** Repeats per held key: a key held about half a second. */
const HELD_REPEATS = 5;

/**
 * Records every keydown the page sees as { key, repeat, meta, taken }. On
 * window in the bubble phase, so it runs after the key map's listener on
 * document and `taken` (defaultPrevented) says whether the page took the
 * key.
 */
const RECORD_KEYDOWNS = () => {
  window.__keydowns = [];
  window.addEventListener("keydown", (event) => {
    window.__keydowns.push({
      key: event.key,
      repeat: event.repeat,
      meta: event.metaKey,
      taken: event.defaultPrevented,
    });
  });
};

/** Whether `downs` is one held key: a press, then `repeats` repeats. */
const isHold = (downs, repeats) =>
  downs.length === repeats + 1 && downs.every((d, n) => d.repeat === n > 0);

/**
 * Held keys in the macOS app (header). On WebKit the key the page leaves
 * alone is `z`, held last: the web view hands keys back in order, so once
 * its repeats are back every earlier key that would come back has.
 */
async function heldKeys({ check, open }) {
  const { page, cdp } = await open("held", {
    closeHelp: true,
    host: { kind: "mac-app", display: "fullscreen" },
  });
  await page.evaluate(RECORD_KEYDOWNS);
  const startItem = await currentItemId(page);
  await holdKey(cdp, "Escape", HELD_REPEATS);
  await sleep(100);
  const escOpened = await helpOpen(page);
  await holdKey(cdp, "Space", HELD_REPEATS);
  await sleep(100);
  const spaceClosed = !(await helpOpen(page));
  await holdKey(cdp, "Tab", HELD_REPEATS);
  await sleep(100);
  const endItem = await currentItemId(page);
  await holdKey(cdp, "z", 2);
  const downs = await page.evaluate(() => window.__keydowns);
  const of = (key) => downs.filter((d) => d.key === key);
  const owned = ["Escape", " ", "Tab"].map((key) => ({
    key,
    held: isHold(of(key), HELD_REPEATS),
    allTaken: of(key).every((d) => d.taken),
  }));
  check(
    "held Esc, Space and Tab under the macOS app's host: the page takes every keydown, repeats included, and acts on the first alone (Esc opens the Esc screen and it stays open; Space closes it and the story stays put)",
    owned.every((o) => o.held && o.allTaken) &&
      escOpened &&
      spaceClosed &&
      startItem !== null &&
      endItem === startItem,
    { owned, escOpened, spaceClosed, startItem, endItem },
  );
  const z = of("z");
  check(
    "a held key the page does not own (z) is left to the page, repeats included",
    isHold(z, 2) && z.every((d) => !d.taken),
    { z },
  );
  // Chrome has no app window behind the page: there the page check above
  // is the whole story.
  if (!onWebKit) return;
  const until = Date.now() + 3000;
  const zBack = () => page.windowKeys.filter((k) => k.code === "KeyZ");
  while (zBack().length < 3 && Date.now() < until) await sleep(20);
  const others = page.windowKeys.filter((k) => k.code !== "KeyZ");
  check(
    "WebKit: held Esc, Space and Tab send nothing back to the game app's window (the web view hands back only a key the page left unhandled)",
    zBack().length === 3 && others.length === 0,
    { others, zBack: zBack().length },
  );
  check(
    "WebKit: the held z comes back to the game app's window, repeats included, and the window drops each one: none reaches AppKit's own keyDown",
    zBack().length === 3 &&
      zBack().every((k) => k.fate === "dropped") &&
      zBack()
        .map((k) => k.repeat)
        .join() === "false,true,true",
    { windowKeys: page.windowKeys },
  );
}

/**
 * ⌘H in the macOS app (header). The plain h presses come after ⌘H, so on
 * WebKit every key equivalent line is ⌘H's: a plain key is offered as none.
 */
async function commandH({ check, open }) {
  const { page, cdp } = await open("cmdh", {
    closeHelp: true,
    host: { kind: "mac-app", display: "fullscreen" },
  });
  await page.evaluate(RECORD_KEYDOWNS);
  const textHidden = async () =>
    (await page.evaluate(PAGE_STATE)).overlayHidden;
  const hDowns = async () =>
    (await page.evaluate(() => window.__keydowns)).filter((d) => d.key === "h");
  const before = await textHidden();
  await pressShortcut(cdp, "Meta", "h");
  await sleep(100);
  const afterCommand = await textHidden();
  const command = await hDowns();
  check(
    "⌘H under the macOS app's host: the page leaves it (no preventDefault) and the text stays shown",
    before === false &&
      afterCommand === false &&
      command.length === 1 &&
      command[0].meta === true &&
      command[0].taken === false,
    { before, afterCommand, command },
  );
  await pressH(cdp);
  await sleep(100);
  const afterH = await textHidden();
  const plain = (await hDowns()).slice(1);
  await pressH(cdp);
  await sleep(100);
  const restored = await textHidden();
  check(
    "a plain h still hides the text, taken by the page; h again brings it back",
    plain.length === 1 &&
      plain[0].meta === false &&
      plain[0].taken === true &&
      afterH === true &&
      restored === false,
    { plain, afterH, restored },
  );
  if (!onWebKit) return;
  const until = Date.now() + 3000;
  while (page.keyEquivalents.length < 2 && Date.now() < until) await sleep(20);
  const hBack = page.windowKeys.filter((k) => k.code === "KeyH");
  check(
    "WebKit: the web view claims ⌘H as a key equivalent to give the page its turn, then hands it back unclaimed, so NSApp offers it to the app's main menu (Hide); the driver has no menu, and its window drops it",
    page.keyEquivalents.map((k) => `${k.code} ${k.claimed}`).join() ===
      "KeyH true,KeyH false" &&
      hBack.length === 1 &&
      hBack[0].fate === "dropped",
    { keyEquivalents: page.keyEquivalents, windowKeys: page.windowKeys },
  );
}

export const parts = [
  macApp,
  windowsApp,
  browserTab,
  exitInTab,
  heldKeys,
  commandH,
];
