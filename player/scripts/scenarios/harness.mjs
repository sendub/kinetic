// Shared harness for the scenario suite (docs/verify-player.md). The
// page-side readers and input helpers came from the retired one-sequence
// driver; each scenario now opens its own fresh browser. What the creators'
// testing library also uses (launching, keys, clicks, the generic readers,
// the item lookup) lives in ../testing/core.mjs and is re-exported here.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// A line as the player draws it, its text tags read, from the player's
// own parser, so the screen's line matches its item.
import { shownText } from "../../src/machine/texttags.ts";
// The continue row's label, read from the module that draws it, so the
// branch steps assert the same string the screen shows (as with fit.ts).
import { continueLabel } from "../../src/render/choice.ts";
// The contain-fit geometry comes from the renderer's own pure helper, read
// straight from src (node runs the types away), so the driver's expectation
// cannot drift from the rule the unit tests pin.
import { containFit } from "../../src/render/fit.ts";
import {
  CHOICE_CLOSED,
  CHOICE_OPEN,
  CHROME_SCREEN,
  CONFIG_CLOSED,
  CONFIG_CONTROL,
  CONFIG_OPEN,
  choiceOpen,
  chromePath,
  clickAt,
  clickCenter,
  closeBrowser,
  closeSettings,
  collectErrors,
  configOpen,
  dismissHelp,
  escapeUntil,
  HELP_CLOSED,
  HELP_OPEN,
  helpOpen,
  holdKey,
  killBrowser,
  killLiveBrowsers,
  launchBrowser,
  MAP_OPEN,
  mapOpen,
  matchItems,
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
} from "../testing/core.mjs";
import { FAKE_VOICE_HOST } from "../testing/fakevoice.mjs";
import { testLocaleScript } from "../testing/testlocale.mjs";

// Expando stashed on the <video> element to prove the renderer reuses the
// SAME element across a chain instead of re-creating it (docs Phase 6).
const VIDEO_TOKEN = "kinetic-verify-video";

/** The continue row's label in English, the scenarios' language. */
const CONTINUE_LABEL = continueLabel();

// The Phase 8 bookmark list, read back from IndexedDB inside the page: the
// database is the player's own storage (src/storage/idb.ts — db `kinetic`,
// store `bookmarks`, auto-increment `seq`, per-novel `content` index keyed
// by the novel folder URL). Steps assert the stored record, not a DOM echo.
const READ_BOOKMARKS = async () => {
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
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction("bookmarks", "readonly");
      const req = tx
        .objectStore("bookmarks")
        .index("content")
        .getAll(IDBKeyRange.only(content));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // Bookmarks name their item by id (Phase 18, saves keyed by id); the
    // demo index is added node-side by `readBookmarks`.
    return records.map((r) => ({
      id: r.id,
      itemId: r.itemId,
      timestampMs: r.timestampMs,
      hasThumb: typeof r.thumbDataUrl === "string" && r.thumbDataUrl !== "",
    }));
  } finally {
    db.close();
  }
};

// The branch map's bookmark cards as the reader sees them (docs/plan.md
// Phase 35: the bookmarks live on the map; the `t` screen is gone): whether
// the map is up and has drawn its cards, and per card, in DOM order (story
// order, top to bottom then left to right), its item, its timestamp (from
// its label, "Bookmark <time>" with " (newest)" on the newest: a card has
// no caption, Phase 40), newest and deleted marks, its parts (child
// classes), its outline (box-shadow), where it and its thumbnail are on
// screen, and whether its picture resolved (the stored capture, or the
// manifest still shrunk into a canvas that names its file,
// `data-still-src`).
const READ_MAP_CARDS = () => {
  const panel = document.getElementById("branchmap");
  if (panel === null) return { present: false };
  if (panel.hidden) return { present: true, hidden: true };
  const rectOf = (el) => {
    if (el === null || el === undefined) return null;
    const r = el.getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      width: r.width,
      height: r.height,
    };
  };
  const view = panel.querySelector(".map-view");
  return {
    present: true,
    hidden: false,
    ready: panel.dataset.ready === "true",
    viewRect: rectOf(view),
    scale: Number(panel.querySelector(".map-svg")?.getAttribute("data-scale")),
    toast: (() => {
      const t = panel.querySelector(".map-toast");
      return t === null || t.hidden ? null : t.textContent;
    })(),
    cards: Array.from(panel.querySelectorAll(".bm-card")).map((el) => {
      const pic = el.querySelector(".bm-thumb > .bm-pic");
      return {
        id: el.getAttribute("data-bm"),
        itemId: el.getAttribute("data-item-id"),
        itemIndex: Number(el.getAttribute("data-item-index")),
        time: (el.getAttribute("aria-label") ?? "")
          .replace(/^Bookmark /, "")
          .replace(/ \(newest\)$/, ""),
        newest: el.classList.contains("bm-newest"),
        deleted: el.classList.contains("bm-deleted"),
        label: el.getAttribute("aria-label"),
        parts: Array.from(el.children).map((c) => c.className),
        outline: getComputedStyle(el).boxShadow,
        picTag: pic?.tagName ?? null,
        picSrcHead: pic
          ? (
              pic.getAttribute("data-still-src") ??
              pic.getAttribute("src") ??
              ""
            ).slice(0, 24)
          : null,
        picResolved:
          pic === null
            ? false
            : pic.tagName === "IMG"
              ? pic.complete && pic.naturalWidth > 0
              : pic.width > 0,
        rect: rectOf(el),
        thumbRect: rectOf(el.querySelector(".bm-thumb")),
        deleteRect: rectOf(el.querySelector(".bm-del")),
        // The x is drawn (an SVG path in the button), not a glyph.
        deleteDrawn: el.querySelector(".bm-del > svg > path") !== null,
      };
    }),
  };
};

// Page-side predicates for the map, and the Node-side wrapper. The map
// shows the moment `m` is pressed and draws its cards once the bookmark
// list is read (`data-ready`): MAP_OPEN is the first, MAP_READY the
// second, MAP_CARDS_LOADED waits until every card shows its picture too.
const MAP_READY = () => {
  const p = document.getElementById("branchmap");
  return p !== null && !p.hidden && p.dataset.ready === "true";
};
const MAP_CARDS_LOADED = () => {
  const p = document.getElementById("branchmap");
  if (p === null || p.hidden || p.dataset.ready !== "true") return false;
  return [...p.querySelectorAll(".bm-card")].every((card) => {
    const pic = card.querySelector(".bm-thumb > .bm-pic");
    if (pic === null) return false;
    return pic.tagName !== "IMG" || pic.complete;
  });
};
const MAP_CLOSED = () => {
  const p = document.getElementById("branchmap");
  return p === null || p.hidden;
};

// The branch map's view as the page shows it (docs/plan.md Phase 41): the
// half of "Full size | Fit" pressed ("full" or "fit"), the stage's
// transform, the map view's size, the layout's size (the SVG's), and
// Full size's scroll bar and thumb on screen (null while hidden).
const READ_MAP_VIEW = () => {
  const panel = document.getElementById("branchmap");
  const pressed = (act) =>
    panel
      ?.querySelector(`.map-tool[data-act="${act}"]`)
      ?.getAttribute("aria-pressed") === "true";
  const [x, y, scale] = (panel?.querySelector(".map-stage")?.dataset.view ?? "")
    .split(" ")
    .map(Number);
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      width: r.width,
      height: r.height,
    };
  };
  const viewEl = panel?.querySelector(".map-view");
  const svg = panel?.querySelector(".map-svg");
  const bar = panel?.querySelector(".map-scroll");
  const shown = bar !== null && bar !== undefined && !bar.hidden;
  return {
    view: pressed("full") ? "full" : pressed("fit") ? "fit" : null,
    x,
    y,
    scale,
    vw: viewEl?.clientWidth ?? 0,
    vh: viewEl?.clientHeight ?? 0,
    viewRect: viewEl ? rect(viewEl) : null,
    width: Number(svg?.getAttribute("width")),
    height: Number(svg?.getAttribute("height")),
    bar: shown ? rect(bar) : null,
    thumb: shown ? rect(bar.querySelector(".map-thumb")) : null,
  };
};

/**
 * Shows the branch map's `which` view ("full" or "fit"): F, when the other
 * one is on show (F switches). Returns the view after.
 */
async function showMapView(page, cdp, which) {
  if ((await page.evaluate(READ_MAP_VIEW)).view !== which) {
    await pressKey(cdp, "f", "KeyF", 70, "f");
    await sleep(120);
  }
  return page.evaluate(READ_MAP_VIEW);
}

// The settings section of the Esc screen (Phase 26: Escape opens the one
// screen holding the keys and every setting; `c` is gone) as the reader
// sees it: the speed readout, the
// skip-all and play-all-routes switches' aria state, the rects the driver
// clicks, and the layout in reading order (each heading and row label, an
// indented option marked by two leading spaces) with each row's first
// control's left edge. A label's or heading's words leave out the tip its
// "?" carries (Phase 43 item 12: drawn only on hover, focus or a click).
const READ_CONFIG_OVERLAY = () => {
  const panel = document.getElementById("config");
  if (panel === null) return { present: false };
  if (panel.hidden) return { present: true, hidden: true };
  const rectOf = (el) => {
    if (el === null || el === undefined) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  const words = (el) => {
    if (el === null || el === undefined) return "";
    const copy = el.cloneNode(true);
    for (const tip of copy.querySelectorAll(".config-tip-text")) tip.remove();
    return copy.textContent;
  };
  const toggle = document.querySelector(".config-skip-all");
  const playToggle = document.querySelector(".config-play-all");
  return {
    present: true,
    hidden: false,
    title: document.querySelector(".config-title")?.textContent ?? null,
    titleRect: rectOf(document.querySelector(".config-title")),
    // The screen's one hint, shared by the keys and the settings.
    hint: document.querySelector(".help-hint")?.textContent ?? null,
    // The settings sit with the keys on the same screen: under the key
    // list when the sheet is one column, beside it (to its right, level
    // with it) when it is two (Phase 40: from 700px wide).
    belowKeys: (() => {
      const grid = document.querySelector("#help .help-list");
      return (
        grid !== null &&
        panel.parentElement?.id === "help" &&
        panel.getBoundingClientRect().top >= grid.getBoundingClientRect().bottom
      );
    })(),
    besideKeys: (() => {
      const grid = document.querySelector("#help .help-list");
      if (grid === null || panel.parentElement?.id !== "help") return false;
      const g = grid.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      return p.left >= g.right && p.top < g.bottom && p.bottom > g.top;
    })(),
    speedValue:
      document.querySelector(".config-speed-value")?.textContent ?? null,
    speedDownRect: rectOf(
      document.querySelector('[data-config-action="speed-down"]'),
    ),
    speedUpRect: rectOf(
      document.querySelector('[data-config-action="speed-up"]'),
    ),
    skipLabel: toggle?.textContent ?? null,
    skipPressed: toggle?.getAttribute("aria-pressed") ?? null,
    skipRect: rectOf(toggle),
    playLabel: playToggle?.textContent ?? null,
    playPressed: playToggle?.getAttribute("aria-pressed") ?? null,
    playRect: rectOf(playToggle),
    // The Phase 16 "Reset progress" row: a control, so it has a rect too.
    resetLabel: document.querySelector(".config-reset")?.textContent ?? null,
    resetRect: rectOf(document.querySelector(".config-reset")),
    // The Phase 21 Progress group: Export / Import. Its notices are the
    // `#flash` pill (Phase 43 item 12; READ_PILL), not a line here.
    exportRect: rectOf(
      document.querySelector('[data-config-action="export-progress"]'),
    ),
    importRect: rectOf(
      document.querySelector('[data-config-action="import-progress"]'),
    ),
    noMessageLine:
      document.querySelector(
        ".config-message, .config-window-note, .config-group-note, .config-speed-note, .config-note",
      ) === null,
    lines: [...panel.querySelectorAll(".config-section, .config-row")].map(
      (el) =>
        el.classList.contains("config-section")
          ? `# ${words(el)}`
          : `${el.classList.contains("config-option") ? "  " : ""}${words(
              el.querySelector(".config-label"),
            )}`,
    ),
    labelLefts: [...panel.querySelectorAll(".config-row .config-label")].map(
      (el) => Math.round(el.getBoundingClientRect().left),
    ),
    rowRects: [...panel.querySelectorAll(".config-row")].map(rectOf),
    // Each section heading's text (not its padded box): its left edge.
    headingTextLefts: [...panel.querySelectorAll(".config-section")].map(
      (el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return Math.round(range.getBoundingClientRect().left);
      },
    ),
    controlLefts: [...panel.querySelectorAll(".config-row")].map((row) =>
      Math.round(
        row.querySelector("button, input")?.getBoundingClientRect().left ?? -1,
      ),
    ),
    speedValueRect: rectOf(document.querySelector(".config-speed-value")),
    skipHeadingRect: rectOf(document.querySelector(".config-section")),
    viewportWidth: window.innerWidth,
  };
};

// Every child of the settings section (`#config`) and of each of its
// groups (each heading and row) as a rect, in order: a notice that pushed
// anything down would show as a difference.
const READ_CONFIG_RECTS = () =>
  [
    ...(document
      .getElementById("config")
      ?.querySelectorAll(":scope > *, :scope > .config-group > *") ?? []),
  ].map((el) => {
    const r = el.getBoundingClientRect();
    return [el.className, r.left, r.top, r.width, r.height];
  });

// The `#flash` pill now: its text, whether it is fully shown (not fading),
// and how it sits over the Esc screen: its z-index against the screen's,
// its background colour (solid over the screen, Phase 43 item 12) and its
// box inside the window.
const READ_PILL = () => {
  const pill = document.getElementById("flash");
  if (pill === null) return null;
  const cs = getComputedStyle(pill);
  const help = document.getElementById("help");
  const r = pill.getBoundingClientRect();
  return {
    text: pill.textContent,
    shown: cs.opacity === "1",
    z: Number(cs.zIndex),
    helpZ: help === null ? null : Number(getComputedStyle(help).zIndex),
    helpOpen: help !== null && !help.hidden,
    background: cs.backgroundColor,
    inWindow:
      r.left >= 0 &&
      r.top >= 0 &&
      r.right <= innerWidth &&
      r.bottom <= innerHeight,
  };
};

// The reset-confirmation box (docs/plan.md Phase 16) as the reader sees it:
// the `c` row opens it, and nothing is cleared until it confirms.
const READ_CONFIRM_OVERLAY = () => {
  const panel = document.getElementById("confirm");
  if (panel === null) return { present: false };
  if (panel.hidden) return { present: true, hidden: true };
  const rectOf = (el) => {
    if (el === null || el === undefined) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  return {
    present: true,
    hidden: false,
    title: document.querySelector(".confirm-title")?.textContent ?? null,
    message: document.querySelector(".confirm-message")?.textContent ?? null,
    resetLabel:
      document.querySelector('[data-confirm-action="confirm"]')?.textContent ??
      null,
    resetRect: rectOf(
      document.querySelector('[data-confirm-action="confirm"]'),
    ),
    cancelLabel:
      document.querySelector('[data-confirm-action="cancel"]')?.textContent ??
      null,
    cancelRect: rectOf(
      document.querySelector('[data-confirm-action="cancel"]'),
    ),
  };
};
const CONFIRM_OPEN = () => {
  const p = document.getElementById("confirm");
  return p !== null && !p.hidden;
};

// The reset box's buttons, as clickCenter takes them (the settings
// controls are CONFIG_CONTROL).
const CONFIRM_CONTROL = {
  confirm: '[data-confirm-action="confirm"]',
  cancel: '[data-confirm-action="cancel"]',
};

// The `#help` key help screen (docs/plan.md Phase 13b) as the reader sees
// it: its rows are the keymap's own table, so the driver reads key chips
// and descriptions rather than echoing a hardcoded list — and asserts the
// panel genuinely covers the viewport, which is what makes it a screen.
const READ_HELP = () => {
  const panel = document.getElementById("help");
  if (panel === null) return { present: false };
  if (panel.hidden) return { present: true, hidden: true };
  const r = panel.getBoundingClientRect();
  return {
    present: true,
    hidden: false,
    // The game's name heading (docs/plan.md Phase 21): its text, whether
    // it is the panel's first line, and the page title beside it.
    game: document.querySelector(".help-game")?.textContent ?? null,
    gameFirst: panel.firstElementChild?.className === "help-game",
    pageTitle: document.title,
    title: document.querySelector(".help-title")?.textContent ?? null,
    hint: document.querySelector(".help-hint")?.textContent ?? null,
    rows: Array.from(document.querySelectorAll(".help-row")).map((el) => ({
      key: el.querySelector(".help-key")?.textContent ?? "",
      desc: el.querySelector(".help-desc")?.textContent ?? "",
    })),
    coversViewport:
      Math.abs(r.width - window.innerWidth) <= 1 &&
      Math.abs(r.height - window.innerHeight) <= 1,
  };
};
// The Esc screen's key grid (Phase 26): how many columns its rows fall
// into, whether the second row sits beside the first (across before
// down), the grid's rect, and the screen's scroll width against its box
// (no horizontal scroll).
const READ_KEY_GRID = () => {
  const panel = document.getElementById("help");
  const grid = document.querySelector("#help .help-list");
  if (panel === null || grid === null) return { present: false };
  const rows = [...grid.querySelectorAll(".help-row")].map((el) =>
    el.getBoundingClientRect(),
  );
  const r = grid.getBoundingClientRect();
  return {
    present: true,
    rows: rows.length,
    columns: new Set(rows.map((b) => Math.round(b.left))).size,
    acrossFirst:
      rows.length > 1 &&
      Math.round(rows[1].top) === Math.round(rows[0].top) &&
      rows[1].left > rows[0].left,
    rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
    scrollWidth: panel.scrollWidth,
    clientWidth: panel.clientWidth,
    scrollHeight: panel.scrollHeight,
    clientHeight: panel.clientHeight,
  };
};
// A page-side change log for the branch walk: every visible mutation
// records one line of `img|overlay-text|choice-open?`, deduplicated. The
// driver's own probes only ever see NOW; this log is what proves an
// ORDER ("late-021 was shown before hire-018", "hire-016 was never
// shown") across a burst of key presses.
const INSTALL_BRANCH_LOG = () => {
  window.__branchLog = [];
  if (window.__branchLogObs) window.__branchLogObs.disconnect();
  const probe = () => {
    const img = document.getElementById("visual-image");
    const textEl = document.getElementById("overlay-text");
    const choice = document.getElementById("choice");
    const line = [
      img ? (img.getAttribute("src") ?? "") : "no-img",
      textEl ? (textEl.textContent ?? "") : "",
      choice !== null && !choice.hidden ? "choice-open" : "choice-shut",
    ].join("|");
    const log = window.__branchLog;
    if (log.length === 0 || log[log.length - 1] !== line) log.push(line);
  };
  window.__branchLogObs = new MutationObserver(probe);
  window.__branchLogObs.observe(document.getElementById("app"), {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "hidden"],
    characterData: true,
  });
  probe();
};
const readBranchLog = (page) => page.evaluate(() => window.__branchLog);

// Every `#flash` pill that appears from now on, in order (docs/plan.md
// Phases 20 and 43, the mode pills): a MutationObserver logs each new
// pill's text, so a pill that has already faded or been replaced is still
// counted. A pill already on screen at the install is not new. A second
// install starts the log afresh.
const INSTALL_PILL_LOG = () => {
  window.__pills = [];
  if (window.__pillObs) window.__pillObs.disconnect();
  const seen = new WeakSet();
  const already = document.getElementById("flash");
  if (already !== null) seen.add(already);
  const scan = () => {
    const pill = document.getElementById("flash");
    if (pill !== null && !seen.has(pill)) {
      seen.add(pill);
      window.__pills.push(pill.textContent);
    }
  };
  window.__pillObs = new MutationObserver(scan);
  window.__pillObs.observe(document.body, { childList: true, subtree: true });
};
const READ_PILLS = () => [...(window.__pills ?? [])];
const readPills = (page) => page.evaluate(READ_PILLS);

// One sample of the screen for a skip burst: the painted visual, the
// overlay line, and whether `#choice` is up.
const SKIP_PROBE = () => {
  const img = document.getElementById("visual-image");
  const video = document.getElementById("visual-video");
  const overlay = document.getElementById("overlay");
  const textEl = document.getElementById("overlay-text");
  const choice = document.getElementById("choice");
  const imgShown = img !== null && getComputedStyle(img).display !== "none";
  const videoShown =
    video !== null &&
    !video.hidden &&
    getComputedStyle(video).display !== "none";
  return [
    imgShown ? (img.getAttribute("src") ?? "") : "no-img",
    videoShown ? (video.getAttribute("poster") ?? "") : "no-video",
    overlay && !overlay.hidden ? (textEl?.textContent ?? "") : "text-off",
    choice !== null && !choice.hidden ? "choice-open" : "choice-shut",
  ].join("|");
};

// One sample of the screen for the Phase 15 floor steps: which video is
// current and whether it plays or sits on its poster, which image is
// painted, and the overlay line. The chain step tells auto (playing, then
// a timed exit) from skip (paused poster, immediate steps) from the
// DOM alone.
const CHAIN_PROBE = () => {
  const img = document.getElementById("visual-image");
  const video = document.getElementById("visual-video");
  const textEl = document.getElementById("overlay-text");
  const videoShown =
    video !== null &&
    !video.hidden &&
    getComputedStyle(video).display !== "none";
  return [
    videoShown ? (video.getAttribute("src") ?? "") : "no-video",
    videoShown ? (video.paused ? "paused" : "playing") : "-",
    videoShown ? (video.getAttribute("poster") ?? "") : "-",
    img !== null && getComputedStyle(img).display !== "none"
      ? (img.getAttribute("src") ?? "")
      : "no-img",
    textEl?.textContent ?? "",
  ].join("|");
};

const dismissHelpByKeyboard = async (page) => {
  await page.waitForFunction(() => document.getElementById("help") !== null, {
    timeout: 5000,
  });
  if (!(await helpOpen(page))) return false;
  await page.keyboard.press("Escape");
  await page.waitForFunction(HELP_CLOSED, { timeout: 5000 });
  return true;
};

// Geometry of the media as rendered: the element box, the CSS paint rule that
// fits it, the asset's OWN decoded size (which no manifest field can change),
// and the overlay band. Object-position is read because it is what centres the
// contained paint, so "centred" is a measured fact and not an assumption.
const FIT_STATE = () => {
  const img = document.getElementById("visual-image");
  const overlay = document.getElementById("overlay");
  const manifest = window.KINETIC_MANIFEST ?? { width: 0, height: 0 };
  const box = img?.getBoundingClientRect();
  const cs = img ? getComputedStyle(img) : null;
  const band = overlay?.getBoundingClientRect();
  return {
    viewport: [window.innerWidth, window.innerHeight],
    natural: img ? [img.naturalWidth, img.naturalHeight] : null,
    box: box ? [box.width, box.height, box.left, box.top] : null,
    objectFit: cs?.objectFit ?? null,
    objectPosition: cs?.objectPosition ?? null,
    overlayBand: band ? [band.left, band.width, band.bottom] : null,
    manifest: [manifest.width, manifest.height],
  };
};

// A page opened at a chosen viewport: the device-metrics override is what a
// rotated phone or an un-maximised window looks like to the layout. It opens
// in a FRESH browser context — its own storage — so a fit page is a
// first-ever load showing item 1's image, untouched by the main walk's
// frontier (which steps 29-30 push onto part-013, a video; a page resuming
// there paints no <img> to measure). Callers close the context.
const openAtViewport = async (
  browser,
  dir,
  width,
  height,
  label,
  messages,
  errors,
) => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("console", (msg) =>
    messages.push(`${label} [${msg.type()}] ${msg.text()}`),
  );
  page.on("pageerror", (err) => errors.push(`${label} ${err.message}`));
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(dir, "index.html")).href);
  // First load shows the key help (Phase 13b) over a hidden stage — there
  // is no media geometry to measure behind it. Escape closes it (Escape
  // never asks for fullscreen, Phase 43); then the stage paints.
  await dismissHelpByKeyboard(page);
  await waitImageDecoded(page);
  return page;
};

/**
 * What the contain fit must be, checked against the measured page: the media
 * box is the whole viewport (so nothing was letterboxed to the manifest box),
 * the paint rule is `object-fit: contain` at the centre, and the contain fit
 * of the asset's own size keeps its aspect ratio, is flush with the viewport
 * in one dimension and letterboxed in the other. `manifestFit` is the box the
 * manifest's display size would have produced, kept for the evidence line.
 */
function judgeFit(state) {
  const [vw, vh] = state.viewport;
  const [aw, ah] = state.natural ?? [0, 0];
  const fit = containFit(aw, ah, vw, vh);
  const manifestFit = containFit(state.manifest[0], state.manifest[1], vw, vh);
  const [bw, bh, bl, bt] = state.box ?? [0, 0, 0, 0];
  const facts = {
    // The media box covers the viewport: the fit happens in the paint.
    boxIsViewport:
      Math.abs(bw - vw) <= 1 &&
      Math.abs(bh - vh) <= 1 &&
      Math.abs(bl) <= 1 &&
      Math.abs(bt) <= 1,
    contained: state.objectFit === "contain",
    centred:
      state.objectPosition === "50% 50%" &&
      Math.abs(bl + bw / 2 - vw / 2) <= 1 &&
      Math.abs(bt + bh / 2 - vh / 2) <= 1,
    // The fitted rect keeps the asset's aspect ratio, to within rounding.
    aspectKept: Math.abs(fit.width / fit.height - aw / ah) < 1e-6,
    // It is maximal: one dimension is flush with the viewport...
    flushOneEdge:
      Math.abs(Math.max(fit.width / vw, fit.height / vh) - 1) < 1e-9,
    // ...and the other leaves room, i.e. a real letterbox at this viewport.
    letterboxes: Math.min(fit.width / vw, fit.height / vh) < 0.999,
  };
  return {
    fit,
    manifestFit,
    facts,
    ok: Object.values(facts).every(Boolean),
  };
}

// Records requestFullscreen calls and the first keydowns' trust (and whether
// the page was fullscreen as each arrived), before the page scripts run.
// The wrapper keeps the real request; it only observes.
const INSTRUMENT = () => {
  window.__fsAttempts = 0;
  window.__firstKeys = [];
  const original = Element.prototype.requestFullscreen;
  Element.prototype.requestFullscreen = function requestFullscreen() {
    window.__fsAttempts += 1;
    return original.apply(this);
  };
  document.addEventListener(
    "keydown",
    (event) => {
      if (window.__firstKeys.length < 12) {
        window.__firstKeys.push({
          key: event.key,
          trusted: event.isTrusted,
          fullscreen: document.fullscreenElement !== null,
        });
      }
    },
    true,
  );
};

// One deliberate wheel notch. `WHEEL_PX` is render/wheel.ts's step size and
// `WHEEL_GAP_MS` clears its rate cap, so a notch means exactly one machine
// step; a trackpad's small deltas are the driver's business only as pixels.
const WHEEL_PX = 100;
const WHEEL_GAP_MS = 120;

const wheelNotch = (cdp, up) =>
  cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 400,
    y: 300,
    deltaX: 0,
    deltaY: up ? -WHEEL_PX : WHEEL_PX,
  });

const wheel = async (cdp, up, notches = 1) => {
  for (let i = 0; i < notches; i += 1) {
    await wheelNotch(cdp, up);
    await sleep(WHEEL_GAP_MS);
  }
};

// Wheel notches until the page itself says the target item is on screen
// (or the notch budget runs out). A fixed-count wheel walk lands one item
// off when the browser's wheel-event controller swallows a CDP mouseWheel
// event — observed twice while this driver was written — and that then
// surfaces as a confusing timeout on a LATER step. One notch is exactly
// one item, so checking after each notch lands exactly on the target.
// `atTarget` runs in the page; `arg` is its argument.
const wheelUntil = async (
  page,
  cdp,
  up,
  atTarget,
  arg = null,
  maxNotches = 8,
) => {
  for (let i = 0; i < maxNotches; i += 1) {
    if (await page.evaluate(atTarget, arg)) return true;
    await wheel(cdp, up, 1);
  }
  return page.evaluate(atTarget, arg);
};

const ON_TEXT = (expected) =>
  (document.getElementById("overlay-text")?.textContent ?? "") === expected;

// Reload-stable paint signature: like SIGNATURE, minus the paused/playing
// field — a resumed video starts playing on its own, which says nothing
// about WHICH item is on screen. The poster attribute distinguishes the
// two items sharing clip-012.mp4.
const PAINT_SIG = () => {
  const img = document.getElementById("visual-image");
  const video = document.getElementById("visual-video");
  const overlay = document.getElementById("overlay");
  const videoShown =
    video !== null &&
    !video.hidden &&
    getComputedStyle(video).display !== "none";
  return [
    img ? (img.getAttribute("src") ?? "") : "no-img",
    img && getComputedStyle(img).display !== "none" ? "img-on" : "img-off",
    videoShown ? (video.getAttribute("src") ?? "") : "no-video",
    videoShown ? (video.getAttribute("poster") ?? "") : "-",
    overlay?.hidden ? "text-off" : "text-on",
    document.getElementById("overlay-text")?.textContent ?? "",
  ].join("|");
};

// What a reader can see, as one string: which surface is painted and which
// line the overlay holds. Steps compare signatures to count cursor moves
// without reading machine state — the DOM is the only source of truth here.
const SIGNATURE = () => {
  const img = document.getElementById("visual-image");
  const video = document.getElementById("visual-video");
  const overlay = document.getElementById("overlay");
  return [
    img ? (img.getAttribute("src") ?? "") : "no-img",
    img && getComputedStyle(img).display !== "none" ? "img-on" : "img-off",
    video ? (video.getAttribute("src") ?? "") : "no-video",
    video ? (video.paused ? "paused" : "playing") : "-",
    overlay?.hidden ? "text-off" : "text-on",
    document.getElementById("overlay-text")?.textContent ?? "",
  ].join("|");
};

const readSignature = (page) => page.evaluate(SIGNATURE);

// Polls the visible state from the driver, so every sample also forces the
// renderer to run (a page-side setInterval is unreliable when the driver is
// merely sleeping: headless produces no frames of its own). Deltas are
// therefore quantized by `gapMs`, which is far below the 120 ms / 1500 ms
// timings being told apart here.
const sampleSignatures = async (page, durationMs, gapMs) => {
  const samples = [];
  const until = Date.now() + durationMs;
  while (Date.now() < until) {
    samples.push([Date.now(), await readSignature(page)]);
    await sleep(gapMs);
  }
  return samples;
};

// Collapses [[time, signature]] to its changes: [[time, signature]].
function transitions(samples) {
  const changes = [];
  for (const [time, sig] of samples) {
    if (changes.length === 0 || changes[changes.length - 1][1] !== sig) {
      changes.push([time, sig]);
    }
  }
  return changes;
}

// One press = one step (docs/plan.md Phase 16): in manual mode a space press
// ends the item's wait AND moves the cursor on the same press, so a walk move
// is one press. (Auto mode keeps the two-stage press — settle in place, move
// on the next — which the steps that want a freeze get from their own `a`.)
const stepForward = (cdp) => pressSpace(cdp);

// A human glances at the screen, which is after the image paints; a probe
// fired the millisecond after src changes would catch img.complete false.
// Wait for the decode, so imgDecoded asserts the visible fact, not a race.
const waitImageDecoded = (page) =>
  page.waitForFunction(
    () => {
      const img = document.getElementById("visual-image");
      return img?.complete && img.naturalWidth > 0;
    },
    { timeout: 5000 },
  );

const waitVideoPlaying = (page, timeout = 5000) =>
  page.waitForFunction(
    () => {
      const v = document.getElementById("visual-video");
      return v !== null && !v.paused && v.currentTime > 0;
    },
    { timeout },
  );

// True while the <video> element still carries the expando stashed in step 10:
// the element was reused, never re-created.
const videoTokenIs = (page) =>
  page.evaluate(
    (token) =>
      document.getElementById("visual-video")?.__kineticVerify === token,
    VIDEO_TOKEN,
  );

// --------------------------------------------------------------------------
// Scenario harness (docs/verify-player.md): folders, a fresh browser per
// scenario, the demo manifest as the single source of item facts, results.
// --------------------------------------------------------------------------

export const playerDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const repoRoot = join(playerDir, "..");
// KINETIC_SCENARIO_ROOT lets parallel runs use separate folders.
export const scenarioRoot =
  process.env.KINETIC_SCENARIO_ROOT ?? join(repoRoot, ".tmp", "scenarios");
export const demoDir = join(scenarioRoot, "demo");
export const emptyDir = join(scenarioRoot, "demo-empty");
export const tallDir = join(scenarioRoot, "demo-tall");
export const TALL_ASSET = { width: 640, height: 960 };
/** fixtures/audio-demo with the player (`audio.scenario.mjs`). */
export const audioDemoDir = join(scenarioRoot, "audio-demo");
const audioDemoSource = join(repoRoot, "fixtures", "audio-demo");
// A track file's extensions (docs/content-format.md, "Audio").
const AUDIO_FILE = /\.(mp3|m4a|wav|flac|webm|ogg|oga|opus)$/i;

/**
 * A copy of the audio demo keeping only some of its kinds of sound
 * (docs/plan.md Phase 52 item 10: the Volumes sheet has a row for each kind
 * a game has): `keep` lists `music` (music, ambience and their fades),
 * `effects` (one-shots and a video's sound) and `voice` (recorded voice
 * lines). The tracks stay defined; what no item names plays nothing and
 * gets no row. One folder per `name`, as parts run side by side.
 */
export function soundFolder(name, keep) {
  const dir = join(scenarioRoot, `sound-${name}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(audioDemoDir, dir, { recursive: true });
  const file = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const kinds = {
    music: ["music", "ambience", "fadeMs"],
    effects: ["sfx", "videoSound"],
    voice: ["voice"],
  };
  const kept = new Set(keep.flatMap((kind) => kinds[kind]));
  for (const item of manifest.items) {
    if (item.audio === undefined) continue;
    item.audio = Object.fromEntries(
      Object.entries(item.audio).filter(([key]) => kept.has(key)),
    );
    if (Object.keys(item.audio).length === 0) delete item.audio;
  }
  const json = JSON.stringify(manifest, null, 2);
  writeFileSync(file, json);
  writeFileSync(
    join(dir, "manifest.js"),
    `window.KINETIC_MANIFEST = ${json};\n`,
  );
  return dir;
}

// The engine every scenario browser runs on: headless Chrome (the default)
// or, with KINETIC_ENGINE=webkit (the runner's --webkit), the system WebKit
// set up as the macOS game app sets it up (player/scripts/webkit).
export const ENGINES = { chrome: "Chrome", webkit: "WebKit" };
export const engine = process.env.KINETIC_ENGINE || "chrome";
if (!(engine in ENGINES)) {
  throw new Error(
    `KINETIC_ENGINE must be one of ${Object.keys(ENGINES).join(", ")}, got "${engine}"`,
  );
}
export const onWebKit = engine === "webkit";

/** The repo's VERSION: the Kinetic version the built player is stamped with. */
export const kineticVersion = readFileSync(
  join(repoRoot, "VERSION"),
  "utf8",
).trim();

/**
 * Takes the version stamp, app.js's first line (scripts/version.mjs), out
 * of the folder `dir`'s app.js: a player built before the stamp.
 */
export function removeVersionStamp(dir) {
  const file = join(dir, "app.js");
  const code = readFileSync(file, "utf8");
  if (!code.startsWith("/*! Kinetic ")) {
    throw new Error(`${file} does not open with the version stamp`);
  }
  writeFileSync(file, code.slice(code.indexOf("\n") + 1));
}

// A page script, run before the player's own, that hides the trace flag
// from the player (src/render/trace.ts): it then keeps no trace, as a
// player from before the trace (docs/plan.md Phase 54) does.
const HIDE_TRACE_FLAG = `Object.defineProperty(window, "KINETIC_TEST_TRACE", {
  get: () => undefined,
  set: () => {},
});
`;

/**
 * Makes the folder `dir` (a copy of the demo) stand in for a player from
 * before the item trace, stamped `version` (scripts/version.mjs; null for
 * no stamp at all): a script in its index.html, run before the player's,
 * hides `window.KINETIC_TEST_TRACE` from it, so the player keeps no trace
 * however the page set the flag.
 */
export function keepNoTrace(dir, version) {
  writeFileSync(join(dir, "hide-trace-flag.js"), HIDE_TRACE_FLAG);
  const index = join(dir, "index.html");
  const html = readFileSync(index, "utf8");
  const at = html.indexOf('<script src="manifest.js">');
  if (at < 0) throw new Error(`no manifest.js script in ${index}`);
  writeFileSync(
    index,
    `${html.slice(0, at)}<script src="hide-trace-flag.js"></script>\n    ${html.slice(at)}`,
  );
  removeVersionStamp(dir);
  if (version !== null) {
    const file = join(dir, "app.js");
    writeFileSync(
      file,
      `/*! Kinetic ${version} */\n${readFileSync(file, "utf8")}`,
    );
  }
}

/** The demo manifest, read from fixtures/demo: ids, texts and order. */
export const manifest = JSON.parse(
  readFileSync(join(repoRoot, "fixtures", "demo", "manifest.json"), "utf8"),
);
const indexById = new Map(
  manifest.items.map((item, index) => [item.id, index]),
);

/** An item by id, with its index: `item("text-speech").text`. */
export function item(id) {
  const index = indexById.get(id);
  if (index === undefined) throw new Error(`demo has no item ${id}`);
  return { ...manifest.items[index], index };
}

/** A decision by id from the demo's branch table. */
export function branch(id) {
  const found = (manifest.branches ?? []).find((b) => b.id === id);
  if (found === undefined) throw new Error(`demo has no branch ${id}`);
  return found;
}

/** The demo's items with each line as drawn (`shownText`). */
const shownItems = manifest.items.map((it) =>
  typeof it.text === "string" ? { ...it, text: shownText(it.text) } : it,
);

/**
 * The demo item the screen shows, identified from what it paints: the
 * overlay line as drawn, its text tags read, when there is one (every demo
 * line is unique), else the visual's file. Null when nothing matches (an
 * overlay or empty state).
 */
export async function currentItemId(page) {
  const s = await page.evaluate(PAGE_STATE);
  const videoShown = s.video?.visible === true;
  const [first] = matchItems(shownItems, {
    text: s.text,
    file: videoShown ? s.video.poster : s.imgSrc,
  });
  return first === undefined ? null : manifest.items[first].id;
}

/**
 * The stored bookmark rows (READ_BOOKMARKS) with each row's demo index
 * beside its `itemId` (-1 for an id the demo manifest lacks).
 */
export async function readBookmarks(page) {
  const rows = await page.evaluate(READ_BOOKMARKS);
  return rows.map((row) => ({
    ...row,
    itemIndex: indexById.get(row.itemId) ?? -1,
  }));
}

/** Press Space until the screen shows `id` (at most `limit` presses). */
export async function spaceTo(page, cdp, id, limit = 60) {
  for (let n = 0; n < limit; n += 1) {
    if ((await currentItemId(page)) === id) return true;
    await pressSpace(cdp);
    await sleep(90);
  }
  return (await currentItemId(page)) === id;
}

/**
 * Assemble the demo, empty and tall folders from fixtures/demo + dist, and
 * the audio demo from fixtures/audio-demo + dist when that folder has been
 * built (`audioDemo` says whether; it is gitignored, made by
 * `.venv/bin/python fixtures/build_audio_demo.py`). As
 * tools/assemble_folder.py does, the audio demo leaves out each audio
 * file that has its script: the player reads only the scripts.
 */
export function assembleFolders() {
  for (const file of ["index.html", "app.js"]) {
    if (!existsSync(join(playerDir, "dist", file))) {
      throw new Error(`player/dist/${file} missing - run npm run build first`);
    }
  }
  rmSync(scenarioRoot, { recursive: true, force: true });
  for (const dir of [demoDir, tallDir]) {
    mkdirSync(dir, { recursive: true });
    cpSync(join(repoRoot, "fixtures", "demo"), dir, { recursive: true });
    for (const file of ["index.html", "app.js"]) {
      copyFileSync(join(playerDir, "dist", file), join(dir, file));
    }
  }
  mkdirSync(emptyDir, { recursive: true });
  for (const file of ["index.html", "app.js", "manifest.js"]) {
    copyFileSync(join(playerDir, "dist", file), join(emptyDir, file));
  }
  const audioDemo = existsSync(join(audioDemoSource, "manifest.json"));
  if (audioDemo) {
    cpSync(audioDemoSource, audioDemoDir, {
      recursive: true,
      filter: (src) => !(AUDIO_FILE.test(src) && existsSync(`${src}.js`)),
    });
    for (const file of ["index.html", "app.js"]) {
      copyFileSync(join(playerDir, "dist", file), join(audioDemoDir, file));
    }
  }
  // The asset/manifest aspect mismatch folder: only the first image's JPEG
  // is resampled (macOS sips), never the manifest.
  let tallAsset = true;
  try {
    execFileSync(
      "sips",
      [
        "-z",
        String(TALL_ASSET.height),
        String(TALL_ASSET.width),
        join(tallDir, manifest.items[0].file),
      ],
      { stdio: "pipe" },
    );
  } catch {
    tallAsset = false;
  }
  return { tallAsset, audioDemo };
}

// The tab each Chrome browser fronts to hide its scenario page.
const coverTabs = new WeakMap();

/**
 * Hides (`visible` false) or shows the page, as switching to another tab
 * or minimising the game app's window does, and resolves with its
 * `document.visibilityState` once that has changed (or after 3 s). Chrome
 * fronts a blank tab of the same browser over it, then the page again;
 * the WebKit driver hides and shows its web view (puppet.mjs setVisible).
 */
export async function setPageVisible(browser, page, visible) {
  if (onWebKit) return page.setVisible(visible);
  if (!visible) {
    let cover = coverTabs.get(browser);
    if (cover === undefined) {
      cover = await browser.newPage();
      coverTabs.set(browser, cover);
    }
    await cover.bringToFront();
  } else {
    await page.bringToFront();
  }
  const want = visible ? "visible" : "hidden";
  await page
    .waitForFunction(
      (w) => document.visibilityState === w,
      { timeout: 3000 },
      want,
    )
    .catch(() => {});
  return page.evaluate(() => document.visibilityState);
}

// A game app's host object for Chrome sessions opened with `host`: the
// same `window.kineticHost` and `kinetic-host` event the macOS app's bridge
// (apps/macos/WebViewSetup.swift, KineticHostBridge) and the Windows exe's
// creation script (apps/windows/host.go, hostScript) give the page: a
// frozen object, not enumerable, with its display setter beside it.
// Messages go through JSON, as WebView2's postMessage sends them, and are
// recorded instead of acted on; like both hosts, its script is swapped on
// every change, so a reload starts in the mode in force. Kept this small on purpose: the WebKit run installs the real
// Swift bridge with a recording host instead (apps/macos/driver), so the
// page meets the real one there.
const EMULATED_HOST = (kind, display) => {
  let mode = display;
  const host = Object.freeze({
    kind,
    get display() {
      return mode;
    },
    send(message) {
      window.__kineticHostRecord(JSON.stringify(message));
    },
  });
  Object.defineProperty(window, "kineticHost", { value: host });
  Object.defineProperty(window, "__kineticHostSetDisplay", {
    value(next) {
      if (next === mode) return;
      mode = next;
      window.dispatchEvent(new Event("kinetic-host"));
    },
  });
  window.dispatchEvent(new Event("kinetic-host"));
};

/**
 * Gives `page` a recording host before its first navigation, on either
 * engine: `messages()` lists what the page sent but its language messages,
 * `languageMessages()` those (docs/plan.md Phase 56 item 7: the page sends
 * one at boot and on each change of language), `waitForMessages(n)` waits
 * until it has sent at least n of the first kind, and `setDisplay(mode)`
 * changes the host's mode as the reader's own control would (the page gets
 * `kinetic-host`).
 */
async function installRecordingHost(page, { kind, display }) {
  let script = null;
  if (onWebKit) {
    await page.installHost(kind, display);
  } else {
    const recorded = [];
    await page.exposeFunction("__kineticHostRecord", (json) => {
      recorded.push(JSON.parse(json));
    });
    script = await page.evaluateOnNewDocument(EMULATED_HOST, kind, display);
    page.hostMessages = recorded;
  }
  const messages = () => page.hostMessages.filter((m) => m.type !== "language");
  return {
    messages,
    languageMessages: () =>
      page.hostMessages.filter((m) => m.type === "language"),
    async waitForMessages(count, timeout = 3000) {
      const until = Date.now() + timeout;
      while (messages().length < count && Date.now() < until) {
        await sleep(20);
      }
      return messages();
    },
    async setDisplay(mode) {
      if (onWebKit) {
        await page.setHostDisplay(mode);
        return;
      }
      await page.removeScriptToEvaluateOnNewDocument(script.identifier);
      script = await page.evaluateOnNewDocument(EMULATED_HOST, kind, mode);
      await page.evaluate((m) => window.__kineticHostSetDisplay(m), mode);
    },
  };
}

// The reader's reduced-motion setting where the driver cannot emulate it
// (the WebKit driver): `matchMedia` answers the query as matching.
const REDUCED_MOTION = () => {
  const query = "(prefers-reduced-motion: reduce)";
  const own = window.matchMedia.bind(window);
  window.matchMedia = (media) => {
    const list = own(media);
    if (media.replace(/\s+/g, " ").trim() !== query) return list;
    // The real list's methods, bound to it; only `matches` is answered.
    const bound = (name) => list[name].bind(list);
    return {
      matches: true,
      media,
      onchange: null,
      addEventListener: bound("addEventListener"),
      removeEventListener: bound("removeEventListener"),
      addListener: bound("addListener"),
      removeListener: bound("removeListener"),
      dispatchEvent: bound("dispatchEvent"),
    };
  };
};

/**
 * One scenario's browser: a FRESH profile (first-ever load), console and
 * page errors captured, the INSTRUMENT shim installed, and the demo opened
 * with the key help up (pass `closeHelp: true` to dismiss it by keyboard).
 * `requireGestureForAudio: true` makes the WebKit driver refuse sound until
 * a key or click, as Safari does (headless Chrome always does, as Chrome
 * does; the stock driver allows it, as the macOS app does).
 * `manualChoices: true` (with `closeHelp`) then turns Play all routes off
 * on the Esc screen, so the walk answers every decision itself; it throws if the
 * switch did not end Off with the screen closed. `host: { kind, display }`
 * opens the page as a game app would show it, with a recording host
 * (installRecordingHost; returned as `host`). `voiceHost: { ... }` opens it
 * instead with the stand-in voice engine (../testing/fakevoice.mjs, its
 * options), the same page script on either engine. `hash` is added to the page
 * URL (`"#start=<id>"`, docs/plan.md Phase 46, opens at that item).
 * `trace: true` sets `window.KINETIC_TEST_TRACE` before the player starts
 * (the item trace, src/render/trace.ts).
 * `locale` gives the page the test-only UI language flag
 * (../testing/testlocale.mjs; `PSEUDO_LOCALE` draws the player's words in
 * the pseudo-locale).
 * `languages` (BCP 47 tags, most wanted first) sets the browser's own
 * languages, `navigator.languages` (launchBrowser; the WebKit driver shows
 * the page only the first, with a region added).
 * `reducedMotion: true` gives the page `prefers-reduced-motion: reduce`:
 * Chrome's own media emulation, and on WebKit, whose driver has none, a
 * `matchMedia` that answers that query so before the player starts.
 * `consoleLines` is every console line from the first load on, any type,
 * as `{ type, text }` (Chrome types `console.warn` "warn" and WebKit
 * "warning"); `errors` (collectErrors) keeps the errors and warnings of
 * both, for the runner's console check.
 */
export async function openScenario(name, options = {}) {
  // One WebKit driver process is one fresh, in-memory profile; Chrome
  // gets an emptied profile folder of its own.
  const browser = await launchBrowser(engine, {
    profile: onWebKit ? null : join(scenarioRoot, "profiles", name),
    fresh: true,
    crashDumpsDir: join(scenarioRoot, "crashdumps"),
    requireGestureForAudio: options.requireGestureForAudio === true,
    ...(options.languages === undefined
      ? {}
      : { languages: options.languages }),
  });
  const page = await browser.newPage();
  const errors = collectErrors(page);
  const consoleLines = [];
  page.on("console", (msg) =>
    consoleLines.push({ type: msg.type(), text: msg.text() }),
  );
  await page.evaluateOnNewDocument(INSTRUMENT);
  if (options.trace === true) {
    await page.evaluateOnNewDocument(() => {
      window.KINETIC_TEST_TRACE = true;
    });
  }
  const host =
    options.host === undefined
      ? null
      : await installRecordingHost(page, options.host);
  if (options.voiceHost !== undefined) {
    await page.evaluateOnNewDocument(FAKE_VOICE_HOST, options.voiceHost);
  }
  if (options.locale !== undefined) {
    await page.evaluateOnNewDocument(testLocaleScript(options.locale));
  }
  const cdp = await page.createCDPSession();
  if (options.reducedMotion === true) {
    if (onWebKit) await page.evaluateOnNewDocument(REDUCED_MOTION);
    else {
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
    }
  }
  const folder = options.folder ?? demoDir;
  await page.goto(
    pathToFileURL(join(folder, "index.html")).href + (options.hash ?? ""),
  );
  await page.waitForFunction(HELP_OPEN, { timeout: 5000 });
  if (options.closeHelp) {
    await pressEscape(cdp);
    await page.waitForFunction(HELP_CLOSED, { timeout: 5000 });
  }
  if (options.manualChoices) {
    const { after, closed } = await setPlayAll(page, cdp, false);
    if (after.playPressed !== "false" || !closed) {
      throw new Error(
        `manualChoices: play all routes not off (${after.playLabel}, closed ${closed})`,
      );
    }
  }
  return { browser, page, cdp, errors, consoleLines, url: page.url(), host };
}

/** Collects one scenario's checks; the runner prints and totals them. */
export function recorder(scenario) {
  const checks = [];
  return {
    checks,
    check(name, ok, evidence = "") {
      checks.push({
        scenario,
        name,
        status: ok === "PARTIAL" ? "PARTIAL" : ok ? "PASS" : "FAIL",
        evidence:
          typeof evidence === "string" ? evidence : JSON.stringify(evidence),
      });
    },
  };
}

export {
  CHAIN_PROBE,
  CHOICE_CLOSED,
  CHOICE_OPEN,
  CHROME_SCREEN,
  CONFIG_CLOSED,
  CONFIG_CONTROL,
  CONFIG_OPEN,
  CONFIRM_CONTROL,
  CONFIRM_OPEN,
  CONTINUE_LABEL,
  choiceOpen,
  chromePath,
  clickAt,
  clickCenter,
  closeBrowser,
  closeSettings,
  configOpen,
  containFit,
  dismissHelp,
  dismissHelpByKeyboard,
  escapeUntil,
  FIT_STATE,
  HELP_CLOSED,
  HELP_OPEN,
  helpOpen,
  holdKey,
  INSTALL_BRANCH_LOG,
  INSTALL_PILL_LOG,
  INSTRUMENT,
  judgeFit,
  killBrowser,
  killLiveBrowsers,
  MAP_CARDS_LOADED,
  MAP_CLOSED,
  MAP_OPEN,
  MAP_READY,
  mapOpen,
  ON_TEXT,
  openAtViewport,
  openSettings,
  PAGE_STATE,
  PAINT_SIG,
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
  pressNavKey,
  pressShortcut,
  pressSpace,
  pressT,
  pressTab,
  pressU,
  pressZ,
  READ_BOOKMARKS,
  READ_CHOICE,
  READ_CONFIG_OVERLAY,
  READ_CONFIG_RECTS,
  READ_CONFIRM_OVERLAY,
  READ_HELP,
  READ_KEY_GRID,
  READ_MAP_CARDS,
  READ_MAP_VIEW,
  READ_PILL,
  READ_PILLS,
  readBranchLog,
  readPills,
  readSignature,
  SIGNATURE,
  SKIP_PROBE,
  sampleSignatures,
  setPlayAll,
  showMapView,
  sleep,
  stepForward,
  transitions,
  VIDEO_TOKEN,
  videoTokenIs,
  WHEEL_GAP_MS,
  WHEEL_PX,
  waitImageDecoded,
  waitVideoPlaying,
  wheel,
  wheelNotch,
  wheelUntil,
};
