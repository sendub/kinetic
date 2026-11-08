// Shared harness for the scenario suite (docs/verify-player.md). The
// page-side readers and input helpers came from the retired one-sequence
// driver; each scenario now opens its own fresh browser.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

// The continue row's label, read from the module that draws it, so the
// branch steps assert the same string the screen shows (as with fit.ts).
import { CONTINUE_LABEL } from "../../src/render/choice.ts";
// The contain-fit geometry comes from the renderer's own pure helper, read
// straight from src (node runs the types away), so the driver's expectation
// cannot drift from the rule the unit tests pin.
import { containFit } from "../../src/render/fit.ts";

// Expando stashed on the <video> element to prove the renderer reuses the
// SAME element across a chain instead of re-creating it (docs Phase 6).
const VIDEO_TOKEN = "kinetic-verify-video";

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
const MAP_OPEN = () => {
  const p = document.getElementById("branchmap");
  return p !== null && !p.hidden;
};
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
const mapOpen = (page) => page.evaluate(MAP_OPEN);

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

/**
 * A navigation key (the arrows, Page Up / Page Down, Home, End) sent
 * without a native key code: in headless Chrome on macOS some keys sent
 * with one stop the page's animation frames for good (bookmarkmap's
 * Delete note), which would freeze the map's painting.
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

// The settings section of the Esc screen (Phase 26: Escape opens the one
// screen holding the keys and every setting; `c` is gone) as the reader
// sees it: the speed readout, the
// skip-all and play-all-routes switches' aria state, the rects the driver
// clicks, and the layout in reading order (each heading and row label, an
// indented option marked by two leading spaces) with each row's first
// control's left edge.
const READ_CONFIG_OVERLAY = () => {
  const panel = document.getElementById("config");
  if (panel === null) return { present: false };
  if (panel.hidden) return { present: true, hidden: true };
  const rectOf = (el) => {
    if (el === null || el === undefined) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
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
    // The Phase 21 Progress group: Export / Import and the message line.
    exportRect: rectOf(
      document.querySelector('[data-config-action="export-progress"]'),
    ),
    importRect: rectOf(
      document.querySelector('[data-config-action="import-progress"]'),
    ),
    message: (() => {
      const el = document.querySelector(".config-message");
      return el === null || el.hidden ? null : el.textContent;
    })(),
    lines: [
      ...panel.querySelectorAll(
        ".config-section, .config-group-note, .config-row",
      ),
    ].map((el) =>
      el.classList.contains("config-section")
        ? `# ${el.textContent}`
        : el.classList.contains("config-group-note")
          ? `  ~ ${el.textContent}`
          : `${el.classList.contains("config-option") ? "  " : ""}${
              el.querySelector(".config-label")?.textContent ?? ""
            }`,
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
    playNote:
      document.querySelector(".config-play-all ~ .config-note")?.textContent ??
      null,
    // The Phase 24 speed note under the speed row: its text box, its font
    // size, the readout's and the next heading's boxes, and the viewport
    // width it must fit in.
    speedNote:
      document.querySelector(".config-speed-note")?.textContent ?? null,
    speedNoteRect: (() => {
      const el = document.querySelector(".config-speed-note");
      if (el === null) return null;
      const range = document.createRange();
      range.selectNodeContents(el);
      return rectOf(range);
    })(),
    speedNoteFontPx: (() => {
      const el = document.querySelector(".config-speed-note");
      return el === null ? null : parseFloat(getComputedStyle(el).fontSize);
    })(),
    speedValueRect: rectOf(document.querySelector(".config-speed-value")),
    skipHeadingRect: rectOf(document.querySelector(".config-section")),
    viewportWidth: window.innerWidth,
    // The Phase 22 Progress note: its rect, to check it is one line that
    // fits the panel: the text's own box, past the indent padding.
    progressNoteRect: (() => {
      const el = document.querySelector(".config-group-note");
      if (el === null) return null;
      const range = document.createRange();
      range.selectNodeContents(el);
      return rectOf(range);
    })(),
    progressNoteFontPx: (() => {
      const el = document.querySelector(".config-group-note");
      return el === null ? null : parseFloat(getComputedStyle(el).fontSize);
    })(),
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
// predicted from `document.fullscreenElement`: headless Chrome enters
// fullscreen on the first gesture and drops it again on its own tens to
// hundreds of ms later, and an Escape sent while it is still up reaches
// the page (it toggles the screen) instead of being kept. So each press is
// followed by asking the page whether it saw the key: seen, the page acted
// on it and the predicate is awaited; not seen, the browser kept it to
// leave fullscreen and one more press goes to the page.
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
// The Esc screen's settings controls and the reset box's buttons, as
// clickCenter takes them: a selector is resolved when the click happens,
// after waiting for the control, not from a rect read before it was drawn.
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
const CONFIRM_CONTROL = {
  confirm: '[data-confirm-action="confirm"]',
  cancel: '[data-confirm-action="cancel"]',
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
const HELP_OPEN = () => {
  const p = document.getElementById("help");
  return p !== null && !p.hidden;
};
const HELP_CLOSED = () => {
  const p = document.getElementById("help");
  return p === null || p.hidden;
};
const helpOpen = (page) => page.evaluate(HELP_OPEN);

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
  // is no media geometry to measure behind it. Closing the help with
  // Escape is this page's first gesture, so fullscreen gets its request as
  // it would for any reader's first action; then the stage paints.
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

// Records requestFullscreen calls and the first keydowns' trust, before the
// page scripts run. The wrapper keeps the real request; it only observes.
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
        window.__firstKeys.push({ key: event.key, trusted: event.isTrusted });
      }
    },
    true,
  );
};

async function pressKey(cdp, key, code, keyCode, text) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    text,
    unmodifiedText: text,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
}
const pressSpace = (cdp) => pressKey(cdp, " ", "Space", 32, " ");
const pressH = (cdp) => pressKey(cdp, "h", "KeyH", 72, "h");
const pressTab = (cdp) => pressKey(cdp, "Tab", "Tab", 9, "");
const pressE = (cdp) => pressKey(cdp, "e", "KeyE", 69, "e");
const pressU = (cdp) => pressKey(cdp, "u", "KeyU", 85, "u");
const pressB = (cdp) => pressKey(cdp, "b", "KeyB", 66, "b");
// `t` no longer does anything (Phase 35); scenarios press it to prove that.
const pressT = (cdp) => pressKey(cdp, "t", "KeyT", 84, "t");
const pressM = (cdp) => pressKey(cdp, "m", "KeyM", 77, "m");
const pressZ = (cdp) => pressKey(cdp, "z", "KeyZ", 90, "z");
// `c` opens nothing since Phase 26 (the settings live on the Esc screen);
// the key stays here so a scenario can prove it inert.
const pressC = (cdp) => pressKey(cdp, "c", "KeyC", 67, "c");
const pressA = (cdp) => pressKey(cdp, "a", "KeyA", 65, "a");
const pressEnter = (cdp) => pressKey(cdp, "Enter", "Enter", 13, "\r");
const pressEscape = (cdp) => pressKey(cdp, "Escape", "Escape", 27, "");
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
const pressDigit = (cdp, digit) =>
  pressKey(cdp, digit, `Digit${digit}`, 48 + Number(digit), digit);

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
const scenarioRoot =
  process.env.KINETIC_SCENARIO_ROOT ?? join(repoRoot, ".tmp", "scenarios");
export const demoDir = join(scenarioRoot, "demo");
export const emptyDir = join(scenarioRoot, "demo-empty");
export const tallDir = join(scenarioRoot, "demo-tall");
export const TALL_ASSET = { width: 640, height: 960 };
export const chromePath =
  process.env.KINETIC_CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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

/**
 * The demo item the screen shows, identified from what it paints: the
 * overlay line when there is one (every demo line is unique), else the
 * visual's file. Null when nothing matches (an overlay or empty state).
 */
export async function currentItemId(page) {
  const s = await page.evaluate(PAGE_STATE);
  if (s.text) {
    const hit = manifest.items.find((it) => it.text === s.text);
    if (hit) return hit.id;
  }
  const videoShown = s.video?.visible === true;
  const file = videoShown ? s.video.poster : s.imgSrc;
  const bare = manifest.items.find(
    (it) => !it.text && (it.file === file || it.poster === file),
  );
  return bare?.id ?? null;
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

/** Assemble the demo, empty and tall folders from fixtures/demo + dist. */
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
  return { tallAsset };
}

/**
 * Set `Play all routes` through the Esc screen as a reader would (Phase
 * 26): open it with Escape, click the switch only when it is not already
 * `on`, close it with Escape (a click never closes it, docs/plan.md Phase
 * 24). Returns the screen as it read after the switch (`after`) and
 * whether it closed. Play all routes is on by default (docs/plan.md
 * Phase 24); a walk that makes its own choices turns it off with this.
 */
async function setPlayAll(page, cdp, on) {
  await openSettings(page, cdp);
  const before = await page.evaluate(READ_CONFIG_OVERLAY);
  if (before.playPressed !== String(on))
    await clickCenter(cdp, CONFIG_CONTROL.play);
  const after = await page.evaluate(READ_CONFIG_OVERLAY);
  await closeSettings(page, cdp); // its key closes it (a click never does)
  const closed = !(await page.evaluate(CONFIG_OPEN));
  return { after, closed };
}

/**
 * One scenario's browser: a FRESH profile (first-ever load), console and
 * page errors captured, the INSTRUMENT shim installed, and the demo opened
 * with the key help up (pass `closeHelp: true` to dismiss it by keyboard).
 * `manualChoices: true` (with `closeHelp`) then turns Play all routes off
 * on the Esc screen, so the walk answers every decision itself; it throws if the
 * switch did not end Off with the screen closed.
 */
export async function openScenario(name, options = {}) {
  const profile = join(scenarioRoot, "profiles", name);
  const launch = () => {
    rmSync(profile, { recursive: true, force: true });
    return puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      userDataDir: profile,
      protocolTimeout: 30000,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-crash-reporter",
        `--crash-dumps-dir=${join(scenarioRoot, "crashdumps")}`,
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
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      errors.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
  await page.evaluateOnNewDocument(INSTRUMENT);
  const cdp = await page.createCDPSession();
  const folder = options.folder ?? demoDir;
  await page.goto(pathToFileURL(join(folder, "index.html")).href);
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
  return { browser, page, cdp, errors, url: page.url() };
}

// Every Chrome openScenario launched and nobody has closed yet, so the
// runner can reap the ones a timed-out or crashed scenario left behind
// (including one whose openScenario threw after the launch).
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
  CONFIG_CLOSED,
  CONFIG_CONTROL,
  CONFIG_OPEN,
  CONFIRM_CONTROL,
  CONFIRM_OPEN,
  CONTINUE_LABEL,
  choiceOpen,
  clickAt,
  clickCenter,
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
  INSTALL_BRANCH_LOG,
  INSTALL_PILL_LOG,
  INSTRUMENT,
  judgeFit,
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
  pressSpace,
  pressT,
  pressTab,
  pressU,
  pressZ,
  READ_BOOKMARKS,
  READ_CHOICE,
  READ_CONFIG_OVERLAY,
  READ_CONFIRM_OVERLAY,
  READ_HELP,
  READ_KEY_GRID,
  READ_MAP_CARDS,
  READ_MAP_VIEW,
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
