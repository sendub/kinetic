#!/usr/bin/env node
// Driver for docs/verify-player.md: walks the checklist (Phase 5 shell,
// Phase 6 media playback, Phase 7 wheel/skip/jump, Phase 7b speech vs thought
// and contain-fit geometry, Phase 8 bookmarks — `b` with its confirmation
// flash, the `t` overlay (order, scroll position, thumbnails, suspension,
// click-to-continue, backdrop/Escape/t-to-close), and reload-resume —
// Phase 9 config: `c` (readout of speed and skip-all, suspension, backdrop-
// and c-to-close, a live speed change measured against the re-armed hold,
// and persistence across reload), Phase 13b's key help and mode rules — the
// help screen first on a first-ever load (black stage, the keymap as its
// content, machine paused), manual as the default with `a` toggling
// auto-forward on and off, Escape opening help mid-walk with the hold
// re-armed on close, and `helpSeen` keeping the screen closed across
// reloads — and Phase 9b/9c short-video timing over
// the demo fixture: the two range items `part-012` ([0,1], 1 pass) and
// `part-013` ([1,2], 2 passes, `loopStartSeconds` 1.5 — Phase 9d) share
// one 2 s clip and prove the range machinery end to end — seek to
// `startSeconds` on entry, pass completes detected per presented frame
// (`requestVideoFrameCallback`, with the file's `ended` where the range
// runs to the file's end), loop-back to `loopStartSeconds` after a
// completed pass while passes remain and pause when none do, and `loop`
// never on for a range — and Phase 13's branch fixture (steps 34-40):
// the `#choice` overlay on the settle of `bridge-015`, the ending route
// (`refuse`) with its reselection overlay and seen marker, the continuing
// route (`hire`) with the NESTED decision on `hire-017` whose picked
// `return` route (`early`) re-opens it with the "Return to main route"
// row — Enter-answered onto the rejoin at `hire-018` —, the continuing
// route's end going straight to `continueAt`
// (`main-023`, once), reload resume inside branch content with no decision
// re-fire, the seen-aware `e`-jump into the never-taken route, and
// `Play all routes` through a skip-all burst that surfaces no choice and
// plays every route (continuing last) before the aftermath —
// and Phase 15's `minPlaySeconds` chain (steps 43-44): auto advance leaving
// the fixture's floor chain only at the video's floor while the dialogue
// plays under it, and skip walking the same chain in plain dwells —
// and Phase 16's navigation semantics (steps 45-47): one press advances
// exactly one item and one wheel notch steps exactly one item in both
// directions, navigation and tab-skip arrivals on an unresolved decision
// SHOW its `#choice` overlay (skip pauses there; a pick resumes manual),
// the "Return to main route" row is re-offered once any route completed,
// and config's "Reset progress" cancels harmlessly but confirms to a true
// first-ever boot —
// and prints PASS / PARTIAL / FAIL per step.
// Run from player/:  node scripts/verify.mjs
// Exit code: 0 when every step is PASS or PARTIAL, 1 on any FAIL or crash.
//
// Each run reassembles .tmp/verify-demo from fixtures/demo plus the built
// bundle (dist/index.html, dist/app.js); the fixture's own manifest.js is
// never touched, so the demo manifest always comes from the fixture.
// The Chrome profile is wiped before launch: Phase 8 put the reading
// frontier and the bookmark list into IndexedDB, and a run must start from
// first-ever-load state the way a fresh machine does.
// .tmp/verify-demo-empty gets the dist stub manifest (no items) to exercise
// the #empty-state notice, and .tmp/verify-demo-tall is a copy whose item-1
// image has been rescaled to a portrait 640x960 while the manifest still says
// 960x540 — the one shape that tells "fit to the asset" apart from "fit to
// the manifest" (step 32, docs/plan.md Phase 7b).
//
// Every input is real CDP Input: Input.dispatchKeyEvent for keys,
// Input.dispatchMouseEvent `mouseWheel` for the wheel, and
// mousePressed/mouseReleased for the clicks on the `t` list and the `c`
// controls. All arrive trusted, so
// the fullscreen gesture logic treats them as user input and the wheel takes
// the same path a trackpad takes. Nothing reads the machine from the driver:
// each step asserts what the DOM shows.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

// The continue row's label, read from the module that draws it, so the
// branch steps assert the same string the screen shows (as with fit.ts).
import { CONTINUE_LABEL } from "../src/render/choice.ts";
// The contain-fit geometry comes from the renderer's own pure helper, read
// straight from src (node runs the types away), so the driver's expectation
// cannot drift from the rule the unit tests pin.
import { containFit } from "../src/render/fit.ts";

const playerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(playerDir, "..");
const contentDir = join(repoRoot, ".tmp", "verify-demo");
const emptyDir = join(repoRoot, ".tmp", "verify-demo-empty");
const tallDir = join(repoRoot, ".tmp", "verify-demo-tall");
const chromeProfile = join(repoRoot, ".tmp", "verify-chrome-profile");
// The portrait size step 32 rescales item 1's image to. Its aspect (2:3)
// deliberately matches neither the manifest's 16:9 nor any test viewport.
const TALL_ASSET = { width: 640, height: 960 };
const chromePath =
  process.env.KINETIC_CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Expected strings copied from fixtures/demo/manifest.js, so a change to the
// fixture fails a step here rather than silently re-defining correctness.
const EXPECTED = {
  meadowText: "You're early today. The meadow is empty.",
  // Phase 13's branch fixture: strings copied from fixtures/demo, so a
  // change to the branch content fails a step rather than silently
  // re-defining correctness.
  outerPrompt: "What does the studio decide?",
  innerPrompt: "When do they meet?",
  hireLabel: "Offer them the job",
  refuseLabel: "Turn them down",
  lateLabel: "Late, over coffee",
  earlyLabel: "Early, before the sun",
  bridge014Text: "The studio waited on an answer about the temp.",
  hire016Text: "Mei slid the contract over before the coffee cooled.",
  hire017Text: "Start Monday, if that works for you.",
  late021Text: "They showed at ten, late and grinning.",
  early022Text:
    "They were at the door before the sun was up, so the kettle went on.",
  hire018Text: "Either way, the studio had its week back.",
  refuse019Text: "We'll pass this time, Mei said, and she meant it.",
  refuse020Text: "An ending card: the studio kept its quiet.",
  main023Text: "Whatever was decided, the morning moved on.",
  main024Text: "And the tape rolled on without an answer.",
  // The Phase 15 floor chain (steps 43-44): a short line on the video and
  // two short dialogue lines, all under the minHold so the floor, not the
  // text sum, must be what holds the chain's exit.
  strollText: "The light went long.",
  line026Text: "We did not hurry.",
  line027Text: "The path turned soon.",
  lanternText:
    "Lanterns lined the empty street, one for each guest who never came.",
  windowText: "Rain again. It's always rain in this town.",
  ferryText: "The ferry crossed once a day, and that was enough.",
  line007Text: "The street glowed under the awning.",
  line008Text: "Neither of us spoke for a while.",
  sparkText: "Sparks circled the bonfire and went out one by one.",
  line010Text: "The tide took the last of the crates by morning.",
  line011Text: "We stacked the rest ourselves, and called it enough.",
  emptyNotice: "No content yet — this folder has an empty manifest.",
};

// Expando stashed on the <video> element to prove the renderer reuses the
// SAME element across a chain instead of re-creating it (docs Phase 6).
const VIDEO_TOKEN = "kinetic-verify-video";

const results = [];
function record(name, status, evidence) {
  results.push({ name, status });
  console.log(`${status}  ${name}`);
  console.log(`      ${evidence}`);
}

function assembleFolders() {
  for (const file of ["index.html", "app.js"]) {
    if (!existsSync(join(playerDir, "dist", file))) {
      throw new Error(`player/dist/${file} missing - run npm run build first`);
    }
  }
  mkdirSync(contentDir, { recursive: true });
  cpSync(join(repoRoot, "fixtures", "demo"), contentDir, { recursive: true });
  for (const file of ["index.html", "app.js"]) {
    copyFileSync(join(playerDir, "dist", file), join(contentDir, file));
  }
  // A same-origin blank page (no app, so no IDB connection): step 40's
  // storage wipe runs its deleteDatabase from there. A delete issued from
  // the live app is blocked by the app's own connection, and a reload
  // that carries such a half-deleted database strands the next boot (and
  // its help screen) — OBSERVED. about:blank cannot serve: its opaque
  // origin refuses IndexedDB.
  writeFileSync(
    join(contentDir, "blank.html"),
    "<!doctype html><title>blank</title>\n",
  );
  mkdirSync(emptyDir, { recursive: true });
  for (const file of ["index.html", "app.js", "manifest.js"]) {
    copyFileSync(join(playerDir, "dist", file), join(emptyDir, file));
  }
  // The asset/manifest aspect mismatch folder for step 32. Only the JPEG is
  // resampled, never the manifest, and `fixtures/demo` itself stays pristine.
  // `sips` is macOS' own resizer; without it step 32 loses its discriminator
  // and says so instead of quietly asserting a weaker fact.
  mkdirSync(tallDir, { recursive: true });
  cpSync(join(repoRoot, "fixtures", "demo"), tallDir, { recursive: true });
  for (const file of ["index.html", "app.js"]) {
    copyFileSync(join(playerDir, "dist", file), join(tallDir, file));
  }
  let tallAsset = true;
  try {
    execFileSync(
      "sips",
      [
        "-z",
        String(TALL_ASSET.height),
        String(TALL_ASSET.width),
        join(tallDir, "meadow-001.jpg"),
      ],
      { stdio: "pipe" },
    );
  } catch {
    tallAsset = false;
  }
  return tallAsset;
}

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
        posterPainted: cs.backgroundImage.includes("intro-006.poster.jpg"),
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
    bookmarksOpen: (() => {
      const p = document.getElementById("bookmarks");
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
  const content = new URL(".", document.baseURI).href;
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
    return records.map((r) => ({
      id: r.id,
      itemIndex: r.itemIndex,
      timestampMs: r.timestampMs,
      hasThumb: typeof r.thumbDataUrl === "string" && r.thumbDataUrl !== "",
    }));
  } finally {
    db.close();
  }
};

// The `t` overlay as the reader sees it: whether the panel is up, the
// entries top to bottom, where the list is scrolled, and per entry its item
// index, timestamp text, label and whether the thumbnail actually resolved
// (a stored data URL, or the manifest still the entry falls back to when
// the canvas capture was taint-blocked over file://).
const READ_BOOKMARK_OVERLAY = () => {
  const panel = document.getElementById("bookmarks");
  if (panel === null) return { present: false };
  if (panel.hidden) return { present: true, hidden: true };
  const list = document.querySelector(".bookmarks-list");
  const rectOf = (el) => {
    if (el === null || el === undefined) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  return {
    present: true,
    hidden: false,
    title: document.querySelector(".bookmarks-title")?.textContent ?? null,
    titleRect: rectOf(document.querySelector(".bookmarks-title")),
    scrollHeight: list.scrollHeight,
    clientHeight: list.clientHeight,
    scrollTop: list.scrollTop,
    listRect: rectOf(list),
    emptyText: panel.querySelector(".bookmarks-empty")?.textContent ?? null,
    entries: Array.from(document.querySelectorAll(".bookmark-entry")).map(
      (el) => {
        const img = el.querySelector("img.bookmark-thumb");
        return {
          itemIndex: Number(el.getAttribute("data-item-index")),
          time: el.querySelector(".bookmark-time")?.textContent ?? "",
          label: el.querySelector(".bookmark-label")?.textContent ?? "",
          thumbSrcHead: img
            ? (img.getAttribute("src") ?? "").slice(0, 24)
            : null,
          thumbResolved: img ? img.complete && img.naturalWidth > 0 : false,
          rect: rectOf(el),
        };
      },
    ),
  };
};

// Page-side predicates for "is the panel up", and the Node-side wrapper.
const OVERLAY_OPEN = () => {
  const p = document.getElementById("bookmarks");
  return p !== null && !p.hidden;
};
const OVERLAY_CLOSED = () => {
  const p = document.getElementById("bookmarks");
  return p === null || p.hidden;
};
const panelOpen = (page) => page.evaluate(OVERLAY_OPEN);

// The `c` config screen as the reader sees it: the speed readout, the
// skip-all and play-all-routes switches' aria state, and the rects the
// driver clicks.
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
      document.querySelector('[data-confirm-action="reset"]')?.textContent ??
      null,
    resetRect: rectOf(document.querySelector('[data-confirm-action="reset"]')),
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
const configOpen = (page) => page.evaluate(CONFIG_OPEN);
const clickCenter = async (cdp, rect) => {
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

// One sample of the screen for the play-all burst: the painted visual,
// the overlay line, and whether `#choice` is up — the step asserts the
// overlay never surfaces while `Play all routes` resolves decisions.
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
// dismisses the help through this, pressing Enter — a closing action that
// touches nothing else. Trusted either through CDP or puppeteer's own
// keyboard (which openAtViewport, without a CDP session, still drives
// through CDP); the wait after it proves the close happened.
const dismissHelp = async (page, cdp) => {
  await page.waitForFunction(() => document.getElementById("help") !== null, {
    timeout: 5000,
  });
  if (!(await helpOpen(page))) return false;
  await pressEnter(cdp);
  await page.waitForFunction(HELP_CLOSED, { timeout: 5000 });
  return true;
};
const dismissHelpByKeyboard = async (page) => {
  await page.waitForFunction(() => document.getElementById("help") !== null, {
    timeout: 5000,
  });
  if (!(await helpOpen(page))) return false;
  await page.keyboard.press("Enter");
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
  // Enter is this page's first gesture, so fullscreen gets its request as
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
const pressB = (cdp) => pressKey(cdp, "b", "KeyB", 66, "b");
const pressT = (cdp) => pressKey(cdp, "t", "KeyT", 84, "t");
const pressC = (cdp) => pressKey(cdp, "c", "KeyC", 67, "c");
const pressA = (cdp) => pressKey(cdp, "a", "KeyA", 65, "a");
const pressEnter = (cdp) => pressKey(cdp, "Enter", "Enter", 13, "\r");
const pressEscape = (cdp) => pressKey(cdp, "Escape", "Escape", 27, "");
// A decision route digit (Phase 13): the overlay takes 1..9 as its own
// input (keys.ts's routeIndexForKey reads `key`).
const pressDigit = (cdp, digit) =>
  pressKey(cdp, digit, `Digit${digit}`, 48 + Number(digit), digit);

// A trusted left click at page coordinates: the `t` overlay is clicked the
// way a reader clicks it, through CDP Input.
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

// "Are we on this item?" probes for wheelUntil, stated as what the item
// PAINTS — the driver only ever sees the screen.
const ON_PART_013 = () =>
  (
    document.getElementById("visual-video")?.getAttribute("poster") ?? ""
  ).includes("part-013.poster.jpg");
const ON_BARE_PIER = () => {
  const img = document.getElementById("visual-image");
  const video = document.getElementById("visual-video");
  const videoShown =
    video !== null &&
    !video.hidden &&
    getComputedStyle(video).display !== "none";
  return (
    img !== null &&
    (img.getAttribute("src") ?? "").includes("pier-009") &&
    getComputedStyle(img).display !== "none" &&
    !videoShown &&
    (document.getElementById("overlay-text")?.textContent ?? "").length === 0
  );
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

async function main() {
  const tallAsset = assembleFolders();
  // Phase 8 persists across sessions, so each run must start on a machine
  // that has never seen this novel: a fresh profile, the first-ever load.
  rmSync(chromeProfile, { recursive: true, force: true });
  console.log(
    `driver: ${execFileSync(chromePath, ["--version"], { encoding: "utf8" }).trim()}`,
  );
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    userDataDir: chromeProfile,
    // 30 s: a comfortable margin over any legitimate CDP wait here, and
    // short enough that a stalled dispatch surfaces as a fast error with
    // a name instead of a 180 s silent hang.
    protocolTimeout: 30000,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-crash-reporter",
      `--crash-dumps-dir=${join(repoRoot, ".tmp", "verify-crashdumps")}`,
    ],
  });

  const consoleMessages = [];
  const pageErrors = [];
  try {
    const page = await browser.newPage();
    page.on("console", (msg) =>
      consoleMessages.push(`demo [${msg.type()}] ${msg.text()}`),
    );
    page.on("pageerror", (err) => pageErrors.push(`demo ${err.message}`));
    await page.evaluateOnNewDocument(INSTRUMENT);
    const cdp = await page.createCDPSession();

    await page.goto(pathToFileURL(join(contentDir, "index.html")).href);
    await page.waitForFunction(
      () => {
        const el = document.getElementById("overlay-text");
        return el !== null && (el.textContent ?? "").length > 0;
      },
      { timeout: 5000 },
    );

    // 1. Fresh load shows the key help FIRST (docs/plan.md Phase 13b):
    // the #help screen is up over a hidden stage, its rows are the keymap's
    // own table, item 1 waits behind it, and nothing has requested
    // fullscreen yet — the machine is paused and manual, so nothing has
    // started either (the walk-not-moved proof is step 3's wait).
    await waitImageDecoded(page);
    const s1 = await page.evaluate(PAGE_STATE);
    const s1help = await page.evaluate(READ_HELP);
    const s1keys = new Set((s1help.rows ?? []).map((row) => row.key));
    const s1HelpOk =
      s1.helpOpen === true &&
      s1.stageHidden === true &&
      s1help.hidden === false &&
      s1help.title === "Key help" &&
      s1help.coversViewport === true &&
      (s1help.hint ?? "").includes("Esc") &&
      (s1help.rows?.length ?? 0) >= 10 &&
      s1help.rows.every((row) => row.key !== "" && row.desc !== "") &&
      [
        "Space",
        "wheel",
        "Tab",
        "A",
        "H",
        "B",
        "T",
        "E",
        "C",
        "Enter",
        "Esc",
      ].every((k) => s1keys.has(k));
    const s1BehindOk =
      s1.appChildren.includes("stage") &&
      s1.appChildren.includes("overlay") &&
      s1.appChildren.includes("help") &&
      s1.imgSrc === "meadow-001.jpg" &&
      s1.imgDecoded &&
      s1.overlayHidden === false &&
      s1.speaker === "Mei" &&
      s1.text === EXPECTED.meadowText &&
      s1.fsAttempts === 0;
    record(
      "1. fresh load: the key help shows first over a black stage, listing the keymap (Phase 13b)",
      s1HelpOk && s1BehindOk ? "PASS" : "FAIL",
      `#help up=${String(s1.helpOpen)} covering the viewport=${String(s1help.coversViewport)}, stage hidden=${String(s1.stageHidden)} (the black screen), ${String(s1help.rows?.length ?? 0)} rows read from the page, key chips=${JSON.stringify(s1help.rows?.map((r) => r.key))}; behind it item 1 is mounted but unseen: img=${JSON.stringify(s1.imgSrc)} decoded=${String(s1.imgDecoded)} speaker=${String(s1.speaker)} text=${JSON.stringify(s1.text)}; #app children=${JSON.stringify(s1.appChildren)}; requestFullscreen calls=${s1.fsAttempts} — no input yet, and the paused manual machine has armed nothing`,
    );

    // 2. Space closes the help — and is CONSUMED: no advance (item 1 is
    // still current, and step 4's pair proves it was never settled). The
    // closing press is also the page's first trusted gesture, so this is
    // where fullscreen gets its request. Headless cannot show the visual
    // effect, so this stays honest at PARTIAL at best: what it proves is
    // the attempt, its trigger, the consumed action, and no errors.
    await pressSpace(cdp);
    const s2 = await page.evaluate(PAGE_STATE);
    const fsOk =
      s2.fsAttempts === 1 &&
      s2.firstKeys.length === 1 &&
      s2.firstKeys[0].key === " " &&
      s2.firstKeys[0].trusted === true &&
      pageErrors.length === 0;
    const s2ClosedOk =
      s2.helpOpen === false &&
      s2.stageHidden === false &&
      s2.imgSrc === "meadow-001.jpg" &&
      s2.text === EXPECTED.meadowText;
    record(
      "2. space closes the help (consumed: no advance); the first key press requests fullscreen (PARTIAL in headless)",
      fsOk && s2ClosedOk ? "PARTIAL" : "FAIL",
      `after the press: helpOpen=${String(s2.helpOpen)}, stage visible=${String(s2.stageHidden === false)}, item 1 still current (${JSON.stringify(s2.imgSrc)} / text unchanged=${String(s2.text === EXPECTED.meadowText)}) — the press closed the screen instead of advancing; requestFullscreen calls=${s2.fsAttempts}; first keydown key=${JSON.stringify(s2.firstKeys[0]?.key)} isTrusted=${String(s2.firstKeys[0]?.trusted)}; pageErrors=${pageErrors.length}; document.fullscreenElement=${String(s2.fullscreenElement)}; the fullscreen visual effect itself is not observable headless`,
    );

    // 3. Manual is the player's default, and `a` toggles auto-forward
    // (docs/plan.md Phase 13b, README advance bullet). Wait past item 1's
    // own hold: in manual mode nothing moves. `a` turns auto ON and the
    // SAME item advances on a fresh full hold with no other input — the
    // arrival carries item 2's content, the check the old walk ran here.
    // `a` again turns auto OFF mid-item: the armed hold is cancelled.
    const manualWaitMs = 3100; // > item 1's 2400 ms hold (40 chars x 60 ms)
    await sleep(manualWaitMs);
    const s3held = await page.evaluate(PAGE_STATE);
    const s3ManualHeld =
      s3held.imgSrc === "meadow-001.jpg" &&
      s3held.text === EXPECTED.meadowText &&
      s3held.helpOpen === false &&
      s3held.stageHidden === false;
    const s3onAt = Date.now();
    await pressA(cdp); // auto-forward ON
    let s3autoMs = -1;
    let s3autoOnOk = true;
    try {
      await page.waitForFunction(
        (expected) =>
          (document.getElementById("overlay-text")?.textContent ?? "") ===
          expected,
        { timeout: 3200 },
        EXPECTED.lanternText,
      );
      s3autoMs = Date.now() - s3onAt;
    } catch {
      s3autoOnOk = false;
    }
    const s3lantern = await page.evaluate(PAGE_STATE);
    const s3LanternContentOk =
      s3lantern.imgSrc === "lantern-002.jpg" &&
      s3lantern.imgDecoded &&
      s3lantern.overlayHidden === false &&
      s3lantern.speaker === null &&
      s3lantern.text === EXPECTED.lanternText;
    const s3offAt = Date.now();
    await pressA(cdp); // off, mid-item: the pending hold is cancelled
    await sleep(4600); // > lantern-002's 4020 ms hold (67 chars x 60 ms)
    const s3off = await page.evaluate(PAGE_STATE);
    const s3AutoOffOk = s3off.text === EXPECTED.lanternText;
    await wheel(cdp, true, 1); // back onto item 1, fresh, for the manual walk
    const s3back = await page.evaluate(PAGE_STATE);
    const s3BackOk =
      s3back.imgSrc === "meadow-001.jpg" && s3back.text === EXPECTED.meadowText;
    record(
      "3. manual by default; a turns auto-forward on (item advances) and off (hold cancelled)",
      s3ManualHeld &&
        s3autoOnOk &&
        s3LanternContentOk &&
        s3AutoOffOk &&
        s3BackOk
        ? "PASS"
        : "FAIL",
      `waited ${String(manualWaitMs)} ms on item 1 (its hold is 2400 ms): no advance=${String(s3ManualHeld)} — manual is the default; press a: item advanced on its own in ${String(s3autoMs)} ms (a fresh full hold) with no other input, and the arrival showed item 2 content=${String(s3LanternContentOk)} (its own text, no speaker — the check the old walk ran here); press a again mid-lantern: ${String(Math.round((Date.now() - s3offAt) / 10) / 100)}s with no advance past its 4020 ms hold=${String(s3AutoOffOk)} — the armed hold was cancelled; wheeled back onto item 1 fresh=${String(s3BackOk)}, the manual walk continues below`,
    );

    // 4. Space advances: item 2 (lantern-002) shows its own line; a text
    // item with no speaker draws no speaker. Manual mode is one press = one
    // step (docs/plan.md Phase 16): the press ends item 1's wait AND moves
    // on the same press.
    await stepForward(cdp);
    await waitImageDecoded(page);
    const s4 = await page.evaluate(PAGE_STATE);
    const s4Ok =
      s4.imgSrc === "lantern-002.jpg" &&
      s4.imgDecoded &&
      s4.overlayHidden === false &&
      s4.speaker === null &&
      s4.text === EXPECTED.lanternText;
    record(
      "4. space advances: item 2 image + new text, no speaker (manual: one press = one step, Phase 16)",
      s4Ok ? "PASS" : "FAIL",
      JSON.stringify(s4),
    );

    // 5. Item 3 (sunset-003) is a bare image: the overlay draws nothing.
    await stepForward(cdp);
    await waitImageDecoded(page);
    const s5 = await page.evaluate(PAGE_STATE);
    const s5Ok =
      s5.imgSrc === "sunset-003.jpg" &&
      s5.imgDecoded &&
      s5.overlayHidden === true &&
      s5.overlayChildren === 0;
    record(
      "5. bare-image item shows no overlay content",
      s5Ok ? "PASS" : "FAIL",
      JSON.stringify(s5),
    );

    // 6. Space advances again: item 4 (window-004) brings its speaker back.
    await stepForward(cdp);
    await waitImageDecoded(page);
    const s6 = await page.evaluate(PAGE_STATE);
    const s6Ok =
      s6.imgSrc === "window-004.jpg" &&
      s6.imgDecoded &&
      s6.overlayHidden === false &&
      s6.speaker === "Theo" &&
      s6.text === EXPECTED.windowText;
    record(
      "6. space advances: item 4 speaker + text return",
      s6Ok ? "PASS" : "FAIL",
      JSON.stringify(s6),
    );

    // 7. h hides the overlay; the visual stays visible.
    await pressH(cdp);
    await waitImageDecoded(page);
    const s7 = await page.evaluate(PAGE_STATE);
    const s7Ok =
      s7.overlayHidden === true &&
      s7.imgSrc === "window-004.jpg" &&
      s7.imgDecoded &&
      s7.imgWidth > 0;
    record(
      "7. h hides overlay, visual stays visible",
      s7Ok ? "PASS" : "FAIL",
      JSON.stringify(s7),
    );

    // 8. h again restores the overlay.
    await pressH(cdp);
    const s8 = await page.evaluate(PAGE_STATE);
    const s8Ok =
      s8.overlayHidden === false &&
      s8.speaker === "Theo" &&
      s8.text === EXPECTED.windowText &&
      s8.imgSrc === "window-004.jpg";
    record(
      "8. h again restores overlay text",
      s8Ok ? "PASS" : "FAIL",
      JSON.stringify(s8),
    );

    // 9. Advancing into item 5 (spark-005, an animation) plays it: the
    // shared <img> cycles the manifest frames at 8 fps (125 ms each), then
    // stops on the final frame after exactly 2 loops (1000 ms of cycling).
    await stepForward(cdp);
    await page.waitForFunction(
      () =>
        /^spark-005\.f\d{3}\.jpg$/.test(
          document.getElementById("visual-image")?.getAttribute("src") ?? "",
        ),
      { timeout: 5000 },
    );
    const s9a = await page.evaluate(PAGE_STATE);
    let frameAdvanced = true;
    try {
      await page.waitForFunction(
        (first) =>
          (document.getElementById("visual-image")?.getAttribute("src") ??
            "") !== first,
        { timeout: 600 },
        s9a.imgSrc,
      );
    } catch {
      frameAdvanced = false;
    }
    await sleep(900); // past the 2-loop mark (cycling started ~200 ms ago)
    const s9b = await page.evaluate(PAGE_STATE);
    await sleep(400);
    const s9c = await page.evaluate(PAGE_STATE);
    const s9Ok =
      frameAdvanced &&
      s9b.imgSrc === "spark-005.f003.jpg" &&
      s9c.imgSrc === "spark-005.f003.jpg" &&
      s9b.imgVisible &&
      s9b.placeholder === null &&
      s9b.overlayHidden === false &&
      s9b.text === EXPECTED.sparkText;
    record(
      "9. animation advances frames at 8 fps, stops on final frame after 2 loops",
      s9Ok ? "PASS" : "FAIL",
      `first=${s9a.imgSrc}; advanced=${String(frameAdvanced)}; at1.1s=${s9b.imgSrc}; at1.5s=${s9c.imgSrc}`,
    );

    // 10. Item 6 (intro-006, a video) renders ONE <video muted playsinline>
    // whose poster paints first (poster attribute + CSS background), and it
    // plays. An expando marks the element so later steps can prove it is the
    // SAME element, not a re-created one. intro-006's next item is text, so
    // the chain applies from its first frame: loop=true, `ended` ignored.
    await stepForward(cdp);
    await page.waitForFunction(
      () => document.getElementById("visual-video") !== null,
      { timeout: 5000 },
    );
    await page.evaluate((token) => {
      document.getElementById("visual-video").__kineticVerify = token;
    }, VIDEO_TOKEN);
    let played = true;
    try {
      await waitVideoPlaying(page);
    } catch {
      played = false;
    }
    const s10 = await page.evaluate(PAGE_STATE);
    const s10Struct =
      s10.video?.src.endsWith("intro-006.mp4") === true &&
      s10.video?.poster === "intro-006.poster.jpg" &&
      s10.video?.posterPainted === true &&
      s10.video?.visible === true &&
      s10.video?.loop === true &&
      s10.imgVisible === false &&
      s10.placeholder === null;
    record(
      "10. video shows poster, plays muted, chain-loops (intro-006 -> text)",
      !s10Struct ? "FAIL" : played ? "PASS" : "PARTIAL",
      `${JSON.stringify(s10.video)}; played=${String(played)}${
        played
          ? "; the ended->mediaEnded gate itself is covered by machine unit tests (a chain video never fires ended)"
          : " (autoplay did not start headless: poster stays painted and the chain advance does not gate on media end)"
      }`,
    );

    // 11. Item 7 (line-007) is a `text` item: per machine.visualIndex() the
    // visual is still intro-006 — the SAME <video> element (expando intact),
    // still looping — never a placeholder. The overlay shows the line's own
    // speaker and text.
    await stepForward(cdp);
    const s11 = await page.evaluate(PAGE_STATE);
    const same10 = await videoTokenIs(page);
    const s11Ok =
      same10 &&
      s11.video?.loop === true &&
      s11.video?.visible === true &&
      (!played || s11.video?.paused === false) &&
      s11.imgVisible === false &&
      s11.placeholder === null &&
      s11.overlayHidden === false &&
      s11.speaker === "Mei" &&
      s11.text === EXPECTED.line007Text &&
      // line-007 is spoken dialogue: mode "speech" on band and line, upright.
      s11.overlayMode === "speech" &&
      s11.textMode === "speech" &&
      s11.textFontStyle === "normal";
    record(
      "11. text item keeps the earlier video (same element, looping, no placeholder)",
      s11Ok ? "PASS" : "FAIL",
      `sameElement=${String(same10)}; ${JSON.stringify(s11.video)}; overlay=${String(s11.speaker === "Mei" && s11.text === EXPECTED.line007Text)}; mode=${String(s11.overlayMode)}/${String(s11.textMode)} fontStyle=${String(s11.textFontStyle)}`,
    );

    // 12. line-007 -> line-008: the chain advance must not touch the video
    // element at all — same token, still looping and playing. line-008 is one
    // of the demo's two thought lines, so the same read pins the other mode:
    // "thought" on band and line, and CSS has made it italic (Phase 7b).
    await stepForward(cdp);
    const s12 = await page.evaluate(PAGE_STATE);
    const same11 = await videoTokenIs(page);
    const s12Ok =
      same11 &&
      s12.video?.loop === true &&
      s12.video?.visible === true &&
      (!played || s12.video?.paused === false) &&
      s12.video?.currentTime > 0 &&
      s12.imgVisible === false &&
      s12.placeholder === null &&
      s12.overlayHidden === false &&
      s12.speaker === null &&
      s12.text === EXPECTED.line008Text &&
      s12.overlayMode === "thought" &&
      s12.textMode === "thought" &&
      s12.textFontStyle === "italic";
    record(
      "12. line-007 -> line-008 keeps the same <video> element playing",
      s12Ok ? "PASS" : "FAIL",
      `sameElement=${String(same11)}; ${JSON.stringify(s12.video)}; mode=${String(s12.overlayMode)}/${String(s12.textMode)} fontStyle=${String(s12.textFontStyle)} text=${JSON.stringify(s12.text)}`,
    );

    // 13. h over a playing video: the overlay hides, the video keeps
    // playing on the same element (docs/plan.md Phase 6: h hides text over
    // video too). The line being hidden here is a thought, so `h` is shown to
    // hide that mode too (step 7 hides a spoken one). h again restores before
    // the walk continues.
    await pressH(cdp);
    const s13 = await page.evaluate(PAGE_STATE);
    const same12 = await videoTokenIs(page);
    const s13Ok =
      s13.overlayHidden === true &&
      s13.overlayMode === "thought" &&
      s13.textMode === "thought" &&
      same12 &&
      s13.video?.visible === true &&
      (!played || s13.video?.paused === false);
    record(
      "13. h hides overlay while the video keeps playing",
      s13Ok ? "PASS" : "FAIL",
      `overlayHidden=${String(s13.overlayHidden)} (thought line, mode=${String(s13.overlayMode)}); sameElement=${String(same12)}; ${JSON.stringify(s13.video)}`,
    );
    await pressH(cdp);

    // 14. The wheel rewinds through real wheel events, one notch = one item,
    // and rewinding onto the video shows the poster as a still: paused at the
    // start, loop off, poster painted, the SAME element (expando intact). The
    // events are CDP mouseWheel, so the whole Phase 7 path runs: listener ->
    // accumulator -> machine -> renderer.
    await wheelNotch(cdp, true);
    await sleep(WHEEL_GAP_MS);
    const s14a = await page.evaluate(PAGE_STATE);
    await wheelNotch(cdp, true);
    await sleep(WHEEL_GAP_MS);
    const s14b = await page.evaluate(PAGE_STATE);
    const same13 = await videoTokenIs(page);
    const s14Ok =
      s14a.text === EXPECTED.line007Text &&
      s14b.text === EXPECTED.ferryText &&
      same13 &&
      s14b.video?.paused === true &&
      s14b.video?.currentTime < 0.05 &&
      s14b.video?.loop === false &&
      s14b.video?.visible === true &&
      s14b.video?.posterPainted === true;
    record(
      "14. two wheel notches step back two items; rewinding onto the video shows the poster still",
      s14Ok ? "PASS" : "FAIL",
      `after 1st notch text=${JSON.stringify(s14a.text)}; after 2nd text=${JSON.stringify(s14b.text)}; sameElement=${String(same13)}; ${JSON.stringify(s14b.video)}; driven by CDP mouseWheel; poster-vs-frame-0 pixels are identical by format definition, so the observable facts are the paused-at-zero state and the poster wiring`,
    );

    // 15. One notch from an image item is exactly one item: window-004 (image
    // + text) back to sunset-003 (bare image), where the overlay draws
    // nothing. A notch that double-stepped would land on lantern-002 instead.
    await wheel(cdp, true, 2); // intro-006 -> spark-005 -> window-004
    const s15a = await page.evaluate(PAGE_STATE);
    await wheelNotch(cdp, true);
    await sleep(WHEEL_GAP_MS);
    const s15b = await page.evaluate(PAGE_STATE);
    const s15Ok =
      s15a.imgSrc === "window-004.jpg" &&
      s15a.text === EXPECTED.windowText &&
      s15b.imgSrc === "sunset-003.jpg" &&
      s15b.overlayHidden === true &&
      s15b.overlayChildren === 0;
    record(
      "15. one wheel notch from an image item steps back exactly one item",
      s15Ok ? "PASS" : "FAIL",
      `before=${JSON.stringify(s15a.imgSrc)} (text ${String(s15a.text === EXPECTED.windowText)}); after one notch=${JSON.stringify(s15b.imgSrc)}, overlayHidden=${String(s15b.overlayHidden)}, children=${String(s15b.overlayChildren)}`,
    );

    // 16. Both clamps. Past item 0 the wheel does nothing; back the other way
    // it returns through seen items and stops at the frontier. Seven notches
    // from item 0 reach item 7 (the last item ever shown); the three extra
    // notches must not touch the DOM, because unseen content is off limits.
    await wheel(cdp, true, 3); // sunset-003 -> lantern-002 -> meadow-001, +1 clamped
    const s16a = await page.evaluate(PAGE_STATE);
    await wheel(cdp, false, 7); // -> item 7, the frontier edge
    const s16b = await page.evaluate(PAGE_STATE);
    await wheel(cdp, false, 3); // beyond the frontier: no move allowed
    const s16c = await page.evaluate(PAGE_STATE);
    const s16Ok =
      s16a.imgSrc === "meadow-001.jpg" &&
      s16a.speaker === "Mei" &&
      s16a.text === EXPECTED.meadowText &&
      s16b.text === EXPECTED.line008Text &&
      s16b.video?.paused === false &&
      s16c.text === EXPECTED.line008Text &&
      s16c.video?.src === s16b.video?.src;
    record(
      "16. wheel clamps at item 0 and stops at the frontier on the way back",
      s16Ok ? "PASS" : "FAIL",
      `after 3 extra ups item=${JSON.stringify(s16a.imgSrc)} speaker=${String(s16a.speaker)}; after 7 downs text=${JSON.stringify(s16b.text)} videoPlaying=${String(s16b.video?.paused === false)}; after 3 more downs text=${JSON.stringify(s16c.text)} (unchanged=${String(s16c.text === s16b.text)}) — item 8 (pier-009.jpg) was never painted, so nothing unseen was entered`,
    );

    // 17. tab starts skip: with no further input the cursor advances on the
    // 120 ms dwell — measured page-side, so the driver's own latency is not in
    // the samples — and skip ends when the cursor moves onto the first
    // never-shown item (pier-009, item 8, which has no text). Then that
    // frontier item is shown normally: it sits for its own 1500 ms hold
    // instead of the 120 ms dwell, and auto-advances to line-010 afterwards.
    // Auto-forward is turned ON here with `a`: the skip dwell is the
    // reader's own run and fires in both modes (manual mode rode steps
    // 4-16), but "shown normally, its own hold then advances" is auto mode.
    await wheel(cdp, true, 4); // item 7 -> item 3, room to skip through seen items
    await pressA(cdp); // auto-forward ON for this step's frontier tail
    const s17start = await readSignature(page);
    const tabAt = Date.now();
    await pressTab(cdp);
    const skipSamples = await sampleSignatures(page, 900, 40);
    const skipChanges = transitions(skipSamples);
    const s17 = await page.evaluate(PAGE_STATE);
    const skipDeltas = skipChanges
      .slice(1)
      .map(([time], i) => time - skipChanges[i][0])
      .sort((x, y) => x - y);
    const medianDwell = skipDeltas[(skipDeltas.length - 1) >> 1] ?? -1;
    const s17Moves = skipChanges.length - 1;
    const frontierIndex = skipChanges.findIndex(([, sig]) =>
      sig.startsWith("pier-009.jpg"),
    );
    const frontierDelay =
      frontierIndex >= 0 ? skipChanges[frontierIndex][0] - tabAt : -1;
    const tail = skipSamples.slice(-5).map(([, sig]) => sig);
    const stoppedOnFrontier =
      frontierDelay > 0 &&
      frontierDelay < 1000 && // ~5 dwells, not a full read of the item
      s17.imgSrc === "pier-009.jpg" &&
      s17.imgDecoded &&
      s17.overlayHidden === true && // pier-009 has no text
      new Set(tail).size === 1; // and it stayed: the dwell is gone
    let resumedNormalHold = true;
    try {
      await page.waitForFunction(
        (expected) =>
          (document.getElementById("overlay-text")?.textContent ?? "") ===
          expected,
        { timeout: 2400 },
        EXPECTED.line010Text,
      );
    } catch {
      resumedNormalHold = false;
    }
    record(
      "17. tab skips at ~120 ms per item and stops on the frontier item, shown normally",
      s17Moves >= 4 &&
        medianDwell >= 80 &&
        medianDwell <= 260 &&
        stoppedOnFrontier
        ? resumedNormalHold
          ? "PASS"
          : "PARTIAL"
        : "FAIL",
      `from ${JSON.stringify(s17start.split("|").pop())} the cursor moved ${String(s17Moves)} times with no input (median dwell ${String(medianDwell)}ms against settings.skipDwellMs = 120; the dwell runs in both modes — a was pressed at the step's start); the frontier item pier-009.jpg appeared at +${String(frontierDelay)}ms, decoded=${String(s17.imgDecoded)}, overlayHidden=${String(s17.overlayHidden)}, and the last ${String(tail.length)} samples were identical; its normal 1500 ms hold then auto-advanced to line-010=${String(resumedNormalHold)} (auto-forward on)`,
    );

    // 18. Space during skip exits skip mode: the machine leaves skip and
    // settles the item under the cursor, so nothing moves afterward. Half a
    // second of stillness is the discriminator — a 120 ms dwell would have
    // moved ~4 times. The first 220 ms after the press are ignored, since a
    // dwell already in flight when the key was handled is allowed to land.
    await wheel(cdp, true, 4); // line-010 -> intro-006
    await pressTab(cdp);
    const skippingChanges = transitions(await sampleSignatures(page, 320, 40));
    await pressSpace(cdp);
    const spaceAt = Date.now();
    const afterSpace = (await sampleSignatures(page, 720, 60)).filter(
      ([time]) => time > spaceAt + 220,
    );
    const s18 = await page.evaluate(PAGE_STATE);
    const s18Ok =
      skippingChanges.length >= 3 &&
      new Set(afterSpace.map(([, s]) => s)).size === 1;
    record(
      "18. space during skip exits skip mode and holds the item",
      s18Ok ? "PASS" : "FAIL",
      `skip was running: the visible state changed ${String(skippingChanges.length - 1)} times in the ~320 ms before the press; after the press, ${String(new Set(afterSpace.map(([, s]) => s)).size - 1)} further change in ~500 ms (a 120 ms dwell would have moved ~4 times); it stopped on ${JSON.stringify(s18.text ?? s18.imgSrc)}, which is inside seen content, so a continuing skip would have moved on from there`,
    );

    // 19. e steps to the first UNSEEN item of the path and shows it —
    // Phase 13's seen-tracking ("Seen tracking": the landing is the unseen
    // item itself, the spot the reader resumes from) — and the wheel
    // cannot push past it from there (next > highestSeen stays blocked).
    // The walk has shown items 0..9, so from item 5 the target is item 10,
    // line-011, painted over item 8's still. Step 21 reads its thought
    // styling from that same landing.
    await wheel(cdp, true, 2);
    const s19before = await readSignature(page);
    await pressE(cdp);
    await sleep(80);
    const s19 = await page.evaluate(PAGE_STATE);
    await wheelNotch(cdp, false);
    await sleep(WHEEL_GAP_MS);
    const s19after = await page.evaluate(PAGE_STATE);
    const s19Ok =
      s19.text === EXPECTED.line011Text &&
      s19.imgSrc === "pier-009.jpg" &&
      s19after.text === EXPECTED.line011Text &&
      s19after.imgSrc === "pier-009.jpg";
    record(
      "19. e steps onto the first unseen item (where the reading stopped); wheel cannot pass it",
      s19Ok ? "PASS" : "FAIL",
      `after 2 wheel-back notches=${JSON.stringify(s19before.split("|").pop())}; after e=${JSON.stringify(s19.imgSrc)} text=${JSON.stringify(s19.text)} mode=${String(s19.overlayMode)}/${String(s19.textMode)} fontStyle=${String(s19.textFontStyle)} — the jump entered item 10, the first never-shown item of the path (shown now, so the frontier moved with it); one wheel-down after e left it at ${JSON.stringify(s19after.imgSrc)} (frontier edge: the next item is unseen and the wheel does not enter unseen content)`,
    );

    // 20. Escape opens the key help MID-FLOW (docs/plan.md Phase 13b),
    // over the same fullscreen caveat the bookmarks panel measured in
    // step 25: the page is fullscreen since step 2, and Chrome keeps the
    // FIRST Escape for leaving fullscreen — the page sees no keydown and
    // the help does not open. Windowed, Escape opens it directly: a black
    // screen (stage hidden, media hidden with it) over the SAME item, the
    // machine paused so no timer fires (auto-forward is ON, so an
    // unpaused machine WOULD advance inside the sampling window). `c` and
    // `t` cannot open behind it — one screen at a time. Closing by click
    // resumes the machine with the item's hold re-armed FRESH from the
    // close: the observed advance now comes a full 2880 ms later.
    const sh0 = await page.evaluate(PAGE_STATE);
    await pressEscape(cdp); // fullscreen's Escape: the browser's, not ours
    await sleep(150);
    const shEsc1 = await page.evaluate(PAGE_STATE);
    // The fullscreen Escape's OBSERVED shape: fullscreenElement went null
    // and the page did not receive the keydown, so the help stayed shut.
    const shEsc1Ok =
      sh0.helpOpen === false &&
      shEsc1.helpOpen === false &&
      shEsc1.fullscreenElement === null;
    // Windowed now, Escape reaches the page: this one opens the help.
    await pressEscape(cdp);
    let shOpened = true;
    try {
      await page.waitForFunction(HELP_OPEN, { timeout: 2000 });
    } catch {
      shOpened = false;
    }
    const shOpen = await page.evaluate(PAGE_STATE);
    const shRead = await page.evaluate(READ_HELP);
    const shImgBoxWidth = await page.evaluate(
      () =>
        document.getElementById("visual-image")?.getBoundingClientRect()
          .width ?? -1,
    );
    const shOpenOk =
      shOpened &&
      shOpen.helpOpen === true &&
      shOpen.stageHidden === true &&
      shImgBoxWidth === 0 && // the visual has no box at all behind the black
      shOpen.text === EXPECTED.line011Text && // the SAME item, still current
      shRead.title === "Key help" &&
      shRead.coversViewport === true;
    await pressC(cdp); // no screen opens behind help
    await pressT(cdp);
    const shBlockedOk =
      (await helpOpen(page)) === true &&
      (await configOpen(page)) === false &&
      (await panelOpen(page)) === false;
    // Timers gated: line-011's 2820 ms hold was armed by step 19's `e` and
    // mostly spent; 3200 ms behind the help must show no move even though
    // auto-forward is on. Then a click closes, and the hold re-arms fresh
    // from that close.
    const shSamples = transitions(await sampleSignatures(page, 3200, 120));
    const shGatedOk =
      shSamples.length === 1 && shSamples[0][1].includes(EXPECTED.line011Text);
    await clickAt(cdp, 400, 40); // a click anywhere closes
    const shClick = await page.evaluate(PAGE_STATE);
    const shClickOk =
      shClick.helpOpen === false &&
      shClick.stageHidden === false &&
      shClick.text === EXPECTED.line011Text;
    const shHoldAt = Date.now();
    let shReArmMs = -1;
    let shReArmOk = true;
    try {
      // The resumed hold fires a FULL 2820 ms after the close (not at the
      // spent remnant), and the next item is the part-012 video: its
      // poster attribute marks the arrival.
      await page.waitForFunction(
        () =>
          (
            document.getElementById("visual-video")?.getAttribute("poster") ??
            ""
          ).includes("part-012.poster.jpg"),
        { timeout: 3400 },
      );
      shReArmMs = Date.now() - shHoldAt;
      shReArmOk = shReArmMs > 2300; // fresh full hold, not a spent remnant
    } catch {
      shReArmOk = false;
    }
    record(
      "20. Escape opens help mid-flow: black, paused, screens blocked; closing resumes the same item with a fresh hold",
      shEsc1Ok && shOpenOk && shBlockedOk && shGatedOk && shClickOk && shReArmOk
        ? "PASS"
        : "FAIL",
      `first Escape (fullscreen): OBSERVED consumed by the browser — helpOpen=${String(shEsc1.helpOpen)} and fullscreenElement=${String(shEsc1.fullscreenElement)} (left fullscreen, page saw no open); the windowed Escape OBSERVED opened #help directly: stage hidden=${String(shOpen.stageHidden)}, visual box width=${String(shImgBoxWidth)}, same line-011 item underneath, panel covers viewport=${String(shRead.coversViewport)}; c and t behind help: help stayed up=${String(shBlockedOk)}; ${String(shSamples.length - 1)} state changes in 3200 ms of sampling with auto-forward ON (pause froze the armed hold); click closed=${String(shClickOk)} on the same item; after the close the walk advanced on its own at ${String(shReArmMs)}ms — the full 2820 ms hold re-armed from the close, landing on the part-012 video`,
    );

    // 21. The demo's other thought line, over a still (docs/plan.md
    // Phase 7b). Step 20's resumed hold carried the walk on to part-012, so
    // one wheel notch back re-reads line-011 — a thought: "thought" on the
    // band and on the line, and the computed font-style italic where the
    // spoken lines read speech / upright (the two modes the README promises
    // read differently). The mode change must not disturb the visual
    // either: a `text` item shows the nearest earlier media item's, so
    // pier-009.jpg stays painted, decoded and visible (machine.visualIndex,
    // no regression).
    const s21Back = await wheelUntil(
      page,
      cdp,
      true,
      ON_TEXT,
      EXPECTED.line011Text,
    ); // part-012 -> line-011 (back onto the thought)
    await waitImageDecoded(page);
    const s21 = await page.evaluate(PAGE_STATE);
    const s21ModeOk =
      s21.text === EXPECTED.line011Text &&
      s21.overlayHidden === false &&
      s21.overlayMode === "thought" &&
      s21.textMode === "thought" &&
      s21.textFontStyle === "italic";
    const s21VisualOk =
      s21.imgSrc === "pier-009.jpg" && s21.imgDecoded && s21.imgVisible;
    record(
      "21. thought line over a still: data-mode=thought, italic, visual kept",
      s21Back && s21ModeOk && s21VisualOk ? "PASS" : "FAIL",
      `re-read by wheel-back from the video step 20's resumed hold advanced to: line-011 text=${String(s21.text === EXPECTED.line011Text)}; mode=${String(s21.overlayMode)}/${String(s21.textMode)} fontStyle=${String(s21.textFontStyle)} (the spoken lines of steps 6/19 read speech/normal); visual=${JSON.stringify(s21.imgSrc)} decoded=${String(s21.imgDecoded)} visible=${String(s21.imgVisible)}`,
    );

    // 22. `b` appends bookmarks (docs/plan.md Phase 8, README bookmark
    // bullet) — TWICE, at two DIFFERENT items: a wheel-back walk moves the
    // cursor from line-011 (item 10) to line-008 (item 7) for the first
    // press, and the way back to line-011 for the second, so the list holds
    // two distinct entries. The flash is the DOM half; the records are read
    // back from the player's own IndexedDB. main.ts flashes only after the
    // append is durable, so once #flash shows, the record is committed.
    // Over `file://` Chrome taints the canvas, so the opportunistic thumb
    // is null — by design the durable entry is {timestampMs, itemIndex}.
    const flashShown = () => {
      const el = document.getElementById("flash");
      return el !== null && (el.textContent ?? "") === "Bookmarked";
    };
    await wheel(cdp, true, 3); // line-011 -> line-008 (item 7)
    const s22at008 = await page.evaluate(PAGE_STATE);
    await pressB(cdp);
    await page.waitForFunction(flashShown, { timeout: 5000 });
    await wheel(cdp, false, 3); // -> line-011 (item 10, the frontier edge)
    await pressB(cdp);
    await page.waitForFunction(flashShown, { timeout: 5000 });
    // Auto-forward is on, so settle line-011 in place now (an unsettled
    // item would walk on behind the panel steps); settled items never
    // auto-move, which keeps the walk's position deterministic below.
    await pressSpace(cdp);
    const s22list = await page.evaluate(READ_BOOKMARKS);
    await sleep(1700); // the pill shows ~900 ms, then fades within ~450 ms
    const s22FlashGone = await page.evaluate(
      () => document.getElementById("flash") === null,
    );
    const s22Ok =
      s22at008.text === EXPECTED.line008Text &&
      s22list.length === 2 &&
      s22list[0].itemIndex === 7 && // insertion order: first press first
      s22list[1].itemIndex === 10 &&
      s22list.every((b) => b.timestampMs > 0 && b.id.length > 0) &&
      s22FlashGone;
    record(
      "22. b appends bookmarks at two different items, with a flash that fades",
      s22Ok ? "PASS" : "FAIL",
      `#flash "Bookmarked" shown twice, removed=${String(s22FlashGone)}; IndexedDB bookmarks=${JSON.stringify(s22list)} — two entries at items 7 and 10 (b pressed on line-008, then on line-011), timestamped, insertion-ordered; hasThumb=${JSON.stringify(s22list.map((b) => b.hasThumb))} (over file:// Chrome taints the canvas, so null thumbs are the expected capture fallback; over http the same code stores JPEG data URLs)`,
    );

    // 23. `t` opens the bookmark overlay (README `t` bullet): a panel whose
    // list runs OLDEST at the top down to the NEWEST at the bottom, and is
    // scrolled to the bottom so the most recent entry is visible. The
    // viewport shrinks first so two entries genuinely overflow the list —
    // at a tall viewport "scrolled to the bottom" would assert nothing.
    // Thumbnails resolve (data URL or the manifest still the entry falls
    // back to), timestamps read YYYY-MM-DD HH:MM:SS, and while the panel is
    // open the timeline is suspended: a wheel notch must not move the
    // cursor behind it (space and tab are gated by the same rule).
    const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    await page.setViewport({ width: 800, height: 180, deviceScaleFactor: 1 });
    await pressT(cdp);
    await page.waitForFunction(OVERLAY_OPEN, { timeout: 5000 });
    const s23 = await page.evaluate(READ_BOOKMARK_OVERLAY);
    const maxScroll = Math.max(0, s23.scrollHeight - s23.clientHeight);
    const newest = s23.entries[s23.entries.length - 1];
    const newestVisible =
      newest !== undefined &&
      newest.rect.top >= s23.listRect.top - 1 &&
      newest.rect.bottom <= s23.listRect.bottom + 1;
    const s23ListOk =
      s23.title === "Bookmarks" &&
      s23.entries.length === 2 &&
      s23.entries[0].itemIndex === 7 && // OLDEST first, at the top
      s23.entries[1].itemIndex === 10 && // newest at the bottom
      maxScroll > 0 && // the short viewport forced a real scroll
      s23.scrollTop >= maxScroll - 1 && // scrolled to the bottom
      newestVisible &&
      s23.entries.every(
        (e) =>
          e.thumbResolved &&
          (e.thumbSrcHead?.startsWith("data:") === true ||
            /\.(?:jpg|jpeg|png|webp|gif)$/i.test(e.thumbSrcHead ?? "")) &&
          TIME_RE.test(e.time),
      );
    // Suspension: the overlay takes precedence. Without it a wheel-up notch
    // would move the cursor to item 9 and repaint the overlay band behind
    // the panel (signature change); space and tab are gated by the same
    // rule (keys.ts suspendTimeline).
    const s23sigBefore = await readSignature(page);
    await pressSpace(cdp);
    await pressTab(cdp);
    await wheelNotch(cdp, true);
    await sleep(WHEEL_GAP_MS);
    const s23sigAfter = await readSignature(page);
    const s23still = await page.evaluate(READ_BOOKMARK_OVERLAY);
    const s23SuspendOk =
      s23sigAfter === s23sigBefore &&
      s23still.hidden === false &&
      s23still.entries.length === 2;
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
    record(
      "23. t opens the overlay: oldest first, scrolled to the newest, timeline suspended",
      s23ListOk && s23SuspendOk ? "PASS" : "FAIL",
      `viewport 800x180 to force overflow: entries=${JSON.stringify(s23.entries.map((e) => e.itemIndex))} top-to-bottom (oldest first), scrollTop=${String(s23.scrollTop)} of max ${String(maxScroll)} (newest entry fully visible=${String(newestVisible)}), thumbs=${JSON.stringify(s23.entries.map((e) => [e.thumbSrcHead, e.thumbResolved]))} (both file:// captures were null, so these are the manifest stills: line-008 -> intro-006.poster.jpg, line-011 -> pier-009.jpg), times=${JSON.stringify(s23.entries.map((e) => e.time))}, labels=${JSON.stringify(s23.entries.map((e) => e.label))}; while open, space+tab+wheel-up changed nothing (${String(s23sigAfter === s23sigBefore)}) and the panel stayed open; viewport restored to 800x600`,
    );

    // 24. Clicking the OLDER entry (item 7, at the top of the list) closes
    // the panel and continues the novel from that time point (README `t`
    // bullet): the record carries a ctx, so the restore goes through
    // `machine.importContext` — the cursor lands on the bookmarked item
    // UNSETTLED inside its recorded context, and the seen set comes back
    // as it was captured, never shrinking the frontier. A space press
    // settles the re-shown line in place (a settled arrival would have
    // moved), and `e`
    // afterwards steps to the first UNSEEN item — part-013 (item 12):
    // the walk's seen run is 0..11, since step 20's resumed hold entered
    // part-012 on its own. The restore moved the cursor only inside seen
    // content,
    // and `e` lands exactly at the frontier edge (the LAST item). A space
    // settles it there so the steps below hold the position. The click is
    // a trusted CDP mouse event at the entry's rect.
    const s24open = await page.evaluate(READ_BOOKMARK_OVERLAY);
    const older = s24open.entries[0];
    await clickAt(
      cdp,
      Math.round((older.rect.left + older.rect.right) / 2),
      Math.round((older.rect.top + older.rect.bottom) / 2),
    );
    await page.waitForFunction(OVERLAY_CLOSED, { timeout: 5000 });
    const s24 = await page.evaluate(PAGE_STATE);
    const s24Landed =
      s24.bookmarksOpen === false &&
      s24.text === EXPECTED.line008Text &&
      s24.video?.visible === true &&
      s24.imgVisible === false; // line-008's visual is the chain's video
    await pressSpace(cdp); // settle the re-shown line in place: no move
    const s24Held = await page.evaluate(PAGE_STATE);
    await pressE(cdp);
    let s24e = await page.evaluate(PAGE_STATE);
    try {
      await page.waitForFunction(
        () =>
          (
            document.getElementById("visual-video")?.getAttribute("poster") ??
            ""
          ).includes("part-013.poster.jpg"),
        { timeout: 5000 },
      );
      s24e = await page.evaluate(PAGE_STATE);
    } catch {
      // keep the first read; the asserts below report the miss honestly
    }
    await pressSpace(cdp); // settle the entered video: the walk holds here
    const s24FrontierOk =
      s24Held.text === EXPECTED.line008Text && // unsettled arrival: space held it
      s24e.video?.poster.includes("part-013.poster.jpg") === true &&
      s24e.video?.visible === true;
    record(
      "24. clicking the older entry continues from that item; e proves the frontier unchanged",
      s24Landed && s24FrontierOk ? "PASS" : "FAIL",
      `click on entry #7 closed the panel (bookmarksOpen=${String(s24.bookmarksOpen)}); the player continued at line-008 over the intro-006 video (text=${JSON.stringify(s24.text)}); the arrival was UNSETTLED: one space settled it in place (still line-008=${String(s24Held.text === EXPECTED.line008Text)}); e then stepped onto ${JSON.stringify(s24e.video?.poster || s24e.imgSrc)} — item 12, the first unseen item (0..11 had been shown — step 20's resumed hold entered part-012): the frontier is exactly where the walk left it, so the ctx restore moved the cursor only inside seen content`,
    );

    // 25. The other ways in and out of the panel: `t` reopens it (the list
    // is re-read from storage on every open), a click on the backdrop —
    // the title strip, outside the scroll list — closes it, `t` again
    // closes it, and Escape closes it too. Windowed, this is one Escape:
    // the page is no longer fullscreen (step 20's first Escape left it,
    // OBSERVED consumed by the browser — the fullscreen caveat belongs to
    // that step, and to step 28's).
    await pressT(cdp);
    await page.waitForFunction(OVERLAY_OPEN, { timeout: 5000 });
    const s25reopened = await page.evaluate(READ_BOOKMARK_OVERLAY);
    const title = s25reopened.titleRect;
    await clickAt(
      cdp,
      Math.round((title.left + title.right) / 2),
      Math.round((title.top + title.bottom) / 2),
    );
    const s25AfterBackdrop = await panelOpen(page);
    await pressT(cdp);
    await page.waitForFunction(OVERLAY_OPEN, { timeout: 5000 });
    await pressEscape(cdp);
    await sleep(80);
    const s25AfterEscape = await panelOpen(page);
    const s25StillWindowed = await page.evaluate(
      () => document.fullscreenElement === null,
    );
    await pressT(cdp);
    await page.waitForFunction(OVERLAY_OPEN, { timeout: 5000 });
    await pressT(cdp);
    const s25AfterT = await panelOpen(page);
    const s25Ok =
      s25reopened.entries.length === 2 &&
      s25AfterBackdrop === false &&
      s25AfterEscape === false &&
      s25StillWindowed &&
      s25AfterT === false;
    record(
      "25. t reopens (fresh from storage); backdrop click, one windowed Escape and t again all close",
      s25Ok ? "PASS" : "FAIL",
      `reopen showed ${String(s25reopened.entries.length)} entries again; backdrop (title strip) click closed=${String(s25AfterBackdrop === false)}; windowed (step 20 left fullscreen), so the page receives Escape directly: one press closed=${String(s25AfterEscape === false)} and fullscreenElement stayed null=${String(s25StillWindowed)} — the fullscreen one-Esc caveat is OBSERVED in steps 20 and 28; second t press closed=${String(s25AfterT === false)}; the walk continues with the panel closed`,
    );

    // 26. Reload resume (docs/plan.md Phase 13): the stored ctx's
    // `lastShown` is where the load starts — the exact item the reader
    // walked away from, not the seen edge and not item 0. Wheel back from
    // part-013 to bare pier-009 (wheelUntil: notches until the screen is
    // bare), settle it so the ctx flush freezes, reload, and require the
    // page to come back on exactly that item — same painted signature,
    // still unmoved 1.8 s later (a resume lands settled, and the reloaded
    // machine is manual again). The key help must NOT show again either:
    // `helpSeen` rode along in the record (Phase 13b), so a returning
    // reader resumes straight into the novel. The SEEN EDGE is a separate
    // mechanism — the frontier `e` walks (step 19); `lastShown` is where
    // the reading sits.
    const s26AtPier = await wheelUntil(page, cdp, true, ON_BARE_PIER);
    await pressSpace(cdp); // settle the wheel landing: the flush freezes here
    const s26before = await page.evaluate(PAGE_STATE);
    const s26sig = await page.evaluate(PAINT_SIG);
    await page.reload();
    await sleep(700); // resume paints at load; a beat for media elements
    const s26 = await page.evaluate(PAGE_STATE);
    const s26sigResumed = await page.evaluate(PAINT_SIG);
    await sleep(1800); // past every item's floor hold: nothing may move
    const s26sigHeld = await page.evaluate(PAINT_SIG);
    const s26StoppedMid = s26AtPier && s26before.overlayHidden === true;
    const s26Resumed = s26sigResumed === s26sig && s26sigHeld === s26sig;
    const s26NotFirstLoad =
      s26.imgSrc !== "meadow-001.jpg" && s26.text !== EXPECTED.meadowText;
    const s26HelpStayedShut =
      s26.helpOpen === false && s26.stageHidden === false;
    record(
      "26. reload resumes on the item the reader left (ctx lastShown); helpSeen keeps the help closed",
      s26StoppedMid && s26Resumed && s26NotFirstLoad && s26HelpStayedShut
        ? "PASS"
        : "FAIL",
      `before reload the reader had wheeled back to bare pier-009 and settled it (overlayHidden=${String(s26before.overlayHidden)}); after reload the page came back on the SAME item — identical painted signature (identical=${String(s26sigResumed === s26sig)}, still identical 1.8 s later=${String(s26sigHeld === s26sig)}; left ${JSON.stringify(s26sig)}, came back ${JSON.stringify(s26sigResumed)}, held ${JSON.stringify(s26sigHeld)}): the resume landed settled and the reloaded machine, manual by default, holds it); the ctx's lastShown drives the resume position (Phase 13) — not item 0, and not the seen edge (that is the frontier step 19's e walks); first-ever-load item 0 ruled out=${String(s26NotFirstLoad)}; the key help stayed closed on reload: helpOpen=${String(s26.helpOpen)}, stage visible=${String(s26.stageHidden === false)} — helpSeen was written when the first-load help closed and rides in every save since`,
    );

    // 27. `c` opens the config screen (docs/plan.md Phase 9, README `c`
    // bullet): the panel shows the current reading speed (the default) and
    // the skip-all state; while it is open the timeline is suspended by the
    // same gate as the `t` panel (space, tab, e and the wheel must not move
    // the cursor behind it); clicking the switches turns skip-all and the
    // Phase 13 play-all-routes on (both default off); a click
    // on the title strip is backdrop and closes; `c` reopens the panel
    // showing the values now in force, and `c` again closes it. This `c` is
    // the first key after step 26's reload, so the page also entered
    // fullscreen here — step 28's Escape accounts for that, the fullscreen
    // caveat OBSERVED there.
    const s27bg = await page.evaluate(PAINT_SIG);
    await pressC(cdp);
    await page.waitForFunction(CONFIG_OPEN, { timeout: 5000 });
    const s27open = await page.evaluate(READ_CONFIG_OVERLAY);
    const s27DefaultsOk =
      s27open.hidden === false &&
      s27open.title === "Config" &&
      s27open.speedValue === "1.00x — ~60 ms/char" &&
      s27open.skipPressed === "false" &&
      s27open.skipLabel === "Off" &&
      s27open.playPressed === "false" && // play-all-routes defaults off
      s27open.playLabel === "Off";
    const s27sigBefore = await readSignature(page);
    await pressSpace(cdp);
    await pressTab(cdp);
    await pressE(cdp);
    await wheelNotch(cdp, true);
    await sleep(WHEEL_GAP_MS);
    const s27sigAfter = await readSignature(page);
    const s27Toggled = await page.evaluate(READ_CONFIG_OVERLAY);
    await clickCenter(cdp, s27Toggled.skipRect); // flip skip-all ON
    await clickCenter(cdp, s27Toggled.playRect); // flip play-all-routes ON
    const s27toggled = await page.evaluate(READ_CONFIG_OVERLAY);
    const s27ToggleOk =
      s27toggled.hidden === false &&
      s27toggled.skipPressed === "true" &&
      s27toggled.skipLabel === "On" &&
      s27toggled.playPressed === "true" &&
      s27toggled.playLabel === "On";
    await clickCenter(cdp, s27toggled.titleRect); // backdrop click closes
    const s27Closed = await configOpen(page);
    await pressC(cdp); // reopen: shows the value now in force
    await page.waitForFunction(CONFIG_OPEN, { timeout: 5000 });
    const s27again = await page.evaluate(READ_CONFIG_OVERLAY);
    // Flip play-all back to its default before leaving the panel: this
    // linear demo has no decisions for it to auto-play, and the walk's
    // record stays default-clean for the steps after this one.
    await clickCenter(cdp, s27again.playRect);
    const s27playOff = await page.evaluate(READ_CONFIG_OVERLAY);
    await pressC(cdp); // c closes again
    const s27ClosedAgain = await configOpen(page);
    const s27Ok =
      s27DefaultsOk &&
      s27sigAfter === s27sigBefore &&
      s27ToggleOk &&
      s27Closed === false &&
      s27again.hidden === false &&
      s27again.skipPressed === "true" &&
      s27again.playPressed === "true" &&
      s27playOff.playPressed === "false" &&
      s27ClosedAgain === false;
    record(
      "27. c opens the config screen: values shown, timeline suspended, toggle/backdrop/c behave",
      s27Ok ? "PASS" : "FAIL",
      `panel opened over paint ${JSON.stringify(s27bg)}; defaults read speed=${JSON.stringify(s27open.speedValue)} skipAll=${String(s27open.skipPressed)} playAll=${String(s27open.playPressed)}; while open, space+tab+e+wheel-up changed nothing (${String(s27sigAfter === s27sigBefore)}); clicking the switches: skip aria-pressed=${String(s27toggled.skipPressed)} label=${JSON.stringify(s27toggled.skipLabel)}, play-all aria-pressed=${String(s27toggled.playPressed)} label=${JSON.stringify(s27toggled.playLabel)}; backdrop (title strip) click closed=${String(s27Closed === false)}; c reopened showing skip aria-pressed=${String(s27again.skipPressed)} play-all aria-pressed=${String(s27again.playPressed)}, play-all flipped back to ${String(s27playOff.playPressed)} and c closed it again=${String(s27ClosedAgain === false)}; the panel is #config, z-index 5 under #flash, holding the player's settings: reading speed, skip-all, play-all-routes (Phase 13)`,
    );

    // 28. A changed setting applies live, and survives a reload (the
    // Phase 9 acceptance). Four clicks on the stepper's + take the reading
    // speed 1.00x -> 2.00x (the readout updates in the open panel). Closing
    // by Escape shows the fullscreen caveat again — the first Escape is the
    // browser's and leaves fullscreen, the second reaches the page. Then
    // WITHOUT a reload the re-armed hold is measured: the wheel clamps
    // forward onto part-013 (a position-independent anchor; its ceiling
    // is the seen edge), then backs off — self-healing — onto line-010
    // (48 code points: 2880 ms at 1.00x), and the
    // auto-advance back to line-011 must come ~1500 ms later — the 2.00x
    // text allowance (1440 ms) floored at minHold — not at the old 2880 ms.
    // Before the reload the walk is frozen (one space settles wherever it
    // stands), so after the reload the ctx resume must land on exactly
    // that item. The startup merge also reads the persisted settings
    // record: reopening `c` shows 2.00x and skip-all ON. Both are set
    // back to the defaults so the steps after this one walk defaults.
    await pressC(cdp);
    await page.waitForFunction(CONFIG_OPEN, { timeout: 5000 });
    for (let i = 0; i < 4; i += 1) {
      const r = await page.evaluate(READ_CONFIG_OVERLAY);
      await clickCenter(cdp, r.speedUpRect);
    }
    const s28speed = await page.evaluate(READ_CONFIG_OVERLAY);
    const s28SpeedOk =
      s28speed.speedValue === "2.00x — ~30 ms/char" &&
      s28speed.skipPressed === "true";
    await pressEscape(cdp);
    await sleep(80);
    const s28EscFullscreen = await configOpen(page);
    const s28LeftFullscreen = await page.evaluate(
      () => document.fullscreenElement === null,
    );
    await pressEscape(cdp);
    const s28Closed = await configOpen(page);
    const s28bg = await page.evaluate(PAINT_SIG);
    // After step 26's reload the machine is manual again (Phase 13b):
    // press a to turn auto-forward on, or the live-hold measurement would
    // wait forever. The resume item is settled, so `a` itself arms
    // nothing; the holds are armed by the wheel arrivals below. Clamp
    // forward to part-013 first, then back off (wheelUntil) onto line-010
    // for a fresh hold — the measurement no longer depends on where the
    // resume landed.
    await pressA(cdp);
    const s28AtEnd = await wheelUntil(page, cdp, false, ON_PART_013);
    const s28AtLine10 = await wheelUntil(
      page,
      cdp,
      true,
      ON_TEXT,
      EXPECTED.line010Text,
    );
    const s28samples = transitions(await sampleSignatures(page, 2600, 50));
    const s28back = s28samples.findIndex(([, sig]) =>
      sig.includes(EXPECTED.line010Text),
    );
    const s28on11 = s28samples
      .slice(s28back + 1)
      .find(([, sig]) => sig.includes(EXPECTED.line011Text));
    const s28holdMs =
      s28back >= 0 && s28on11 !== undefined
        ? s28on11[0] - s28samples[s28back][0]
        : -1;
    const s28LiveOk = s28holdMs > 1350 && s28holdMs < 2400; // 1.00x: 2880 ms
    // Freeze the walk before the reload: on an unsettled arrival, space
    // settles in place, so the ctx flushes a stable lastShown and the
    // resume below must land on exactly this item.
    await pressSpace(cdp);
    const s28sig = await page.evaluate(PAINT_SIG);
    await page.reload();
    await sleep(700);
    const s28sigResumed = await page.evaluate(PAINT_SIG);
    await pressC(cdp);
    await page.waitForFunction(CONFIG_OPEN, { timeout: 5000 });
    const s28persist = await page.evaluate(READ_CONFIG_OVERLAY);
    const s28PersistOk =
      s28AtEnd &&
      s28AtLine10 &&
      s28sigResumed === s28sig &&
      s28persist.speedValue === "2.00x — ~30 ms/char" &&
      s28persist.skipPressed === "true";
    for (let i = 0; i < 4; i += 1) {
      const r = await page.evaluate(READ_CONFIG_OVERLAY);
      await clickCenter(cdp, r.speedDownRect);
    }
    const s28reset = await page.evaluate(READ_CONFIG_OVERLAY);
    await clickCenter(cdp, s28reset.skipRect);
    const s28off = await page.evaluate(READ_CONFIG_OVERLAY);
    await clickCenter(cdp, s28off.titleRect); // backdrop closes
    const s28resetClosed = await configOpen(page);
    const s28ResetOk =
      s28reset.speedValue === "1.00x — ~60 ms/char" &&
      s28off.skipPressed === "false" &&
      s28resetClosed === false;
    record(
      "28. config changes apply live and persist: 2.00x speed and skip-all survive reload",
      s28SpeedOk &&
        s28EscFullscreen === true &&
        s28LeftFullscreen &&
        s28Closed === false &&
        s28LiveOk &&
        s28PersistOk &&
        s28ResetOk
        ? "PASS"
        : "FAIL",
      `stepper 1.00x -> ${JSON.stringify(s28speed.speedValue)} by four trusted + clicks; the first Escape left fullscreen=${String(s28LeftFullscreen)} with the panel open=${String(s28EscFullscreen === true)} (the browser keeps it, as OBSERVED in step 20), the second closed=${String(s28Closed === false)}; background before the wheel work ${JSON.stringify(s28bg)}; live effect with no reload (anchors end=${String(s28AtEnd)} line-010=${String(s28AtLine10)}, first signature ${JSON.stringify(s28samples[0]?.[1])}): line-010's auto-advance measured at ${String(s28holdMs)}ms (2.00x floors at the 1500 ms minHold; at the old 1.00x it is 2880 ms and the 2600 ms sampling window would show no move); after reload the reader came back to exactly the item the walk froze on (paint signature identical=${String(s28sigResumed === s28sig)}) and c showed ${JSON.stringify(s28persist.speedValue)} skipAll=${String(s28persist.skipPressed)} — the settings record rode through storage; reset to 1.00x/Off closed, so the steps below walk default behaviour`,
    );

    // 29. Video playback ranges, range 1 (docs/plan.md Phase 9c): item 11,
    // part-012 — plays [0.0, 1.0] of the shared 2 s clip `clip-012.mp4`
    // with `loopCount` 1 and no text. OBSERVED while verifying: a video
    // plays ONLY while it is the frontier edge — visual.playbackModeFor
    // ("skipping || cursor < frontier - 1" shows the poster still — the
    // README's rewind rule), and a paused reused element is never played
    // again. The main walk read items 11 and 12 long ago (step 20's
    // resumed hold, step 24's e), so on that page they can only ever show
    // stills. The range measurement therefore runs on a deliberate clean
    // slate: delete this novel's storage, reload to a first-ever load
    // (the key help shows again — helpSeen left with the record — and the
    // central dismissal closes it), walk onto line-011 with manual press
    // pairs, turn auto-forward on, and enter part-012 exactly as a reader
    // enters a range item for the first time. Before that press the
    // driver installs (a) an `ended` capture counter on `document` and
    // (b) a sampler that runs a self-scheduling `requestVideoFrameCallback`
    // chain on the page's <video> (attached at install if one is mounted,
    // else on its first `play`; the renderer reuses ONE element across the
    // video chain, so nothing pauses here). Nothing is presented before
    // `play()`, so the first recorded callback IS the first frame shown
    // after entry. Each frame records the poster attribute, which marks
    // which range item is on screen. Observed and recorded: the first
    // presented frame's `mediaTime` and the element's `currentTime` at
    // that callback; whether playback stayed inside [0, 1]; how far past
    // 1.0 the pass completed (rVFC sees `mediaTime >= endSeconds` exactly
    // at the presented frame). HTML facts: `loop` is off (a ranged video
    // must never loop=true — the element's loop would seek to 0), and no
    // native `ended` may fire from clip-012 during this phase (the pass
    // ends at 1.0, before the file's end; the renderer's own rVFC watch
    // reports the pass and the machine advances after its 1500 ms
    // min-hold — observed as the poster attribute switching to
    // part-013.poster.jpg).
    const s29rvfc = await page.evaluate(
      () =>
        typeof HTMLVideoElement.prototype.requestVideoFrameCallback ===
        "function",
    );
    await page.evaluate(
      () =>
        new Promise((done) => {
          const rq = indexedDB.deleteDatabase("kinetic");
          rq.onsuccess = () => done();
          rq.onerror = () => done();
          rq.onblocked = () => done();
        }),
    );
    await page.reload();
    await dismissHelp(page, cdp); // the help shows again — a first-ever page
    // Manual walk onto line-011 (item 10): one press = one item (Phase 16),
    // so ten presses land exactly on it, and manual arms no timer, so
    // nothing walks on between them.
    for (let press = 0; press < 10; press += 1) {
      await pressSpace(cdp);
      await sleep(40);
    }
    const s29walked = await page.evaluate(ON_TEXT, EXPECTED.line011Text);
    await page.evaluate(() => {
      // OBSERVED here: the renderer REUSES one <video> across the chain
      // (same clip-012 file, poster swapped) — and a paused reused
      // element is never played again, so nothing may pause anything
      // between install and the measurement. Frames are told apart by
      // the poster attribute; `ended` only fires at the file's real end,
      // which the shorter ranges never reach. The chain attaches to an
      // already-mounted video immediately or, if none exists yet, on the
      // first `play`.
      window.__kineticVid = { frames: [], ended: [] };
      document.addEventListener(
        "ended",
        (event) => {
          const el = event.target;
          if (el && el.tagName === "VIDEO") {
            window.__kineticVid.ended.push({
              src: String(el.getAttribute("src") ?? ""),
              currentTime: el.currentTime,
              at: Date.now(),
              // The reused <img> keeps the last image item's src while a
              // video plays; once it reads bridge-014.jpg the machine has
              // moved on, and an `ended` fired by that transition is not
              // a part-013 pass report (Phase 13 made part-013 mid-story).
              img:
                document.getElementById("visual-image")?.getAttribute("src") ??
                "",
            });
          }
        },
        true,
      );
      const startSampler = (v) => {
        if (v.__kineticSampler) return;
        v.__kineticSampler = true;
        const tick = (_now, meta) => {
          const rec = window.__kineticVid;
          if (rec.frames.length < 4000) {
            rec.frames.push({
              poster: String(v.getAttribute("poster") ?? ""),
              mediaTime: meta.mediaTime,
              currentTime: v.currentTime,
              at: Date.now(),
              // Which image the reused <img> last painted. While part-013
              // is on screen this still reads pier-009.jpg (videos keep
              // the earlier image); the flip to bridge-014.jpg dates the
              // item change, so frames and `ended` events the element
              // produces AFTER it — the hidden re-loop the renderer plays
              // when the last pass's report carries the machine straight
              // onto the next item — are observed but not counted as
              // part-013's own passes.
              img:
                document.getElementById("visual-image")?.getAttribute("src") ??
                "",
            });
          }
          v.requestVideoFrameCallback(tick);
        };
        v.requestVideoFrameCallback(tick);
      };
      document.addEventListener(
        "play",
        (event) => {
          if (event.target && event.target.tagName === "VIDEO") {
            startSampler(event.target);
          }
        },
        true,
      );
      const mounted = document.getElementById("visual-video");
      if (mounted) startSampler(mounted);
    });
    await pressSpace(cdp); // the eleventh press enters part-012 at the
    // frontier edge — manual, so it settles-and-moves (Phase 16) — and it
    // plays; auto comes on only after, so its own gate drives the step on.
    await pressA(cdp); // auto-forward ON: the range's gate drives the step
    let s29onClip = true;
    try {
      await page.waitForFunction(
        () =>
          (
            document.getElementById("visual-video")?.getAttribute("src") ?? ""
          ).includes("clip-012.mp4"),
        { timeout: 5000 },
      );
    } catch {
      s29onClip = false;
    }
    const s29loop = await page.evaluate(
      () => document.getElementById("visual-video")?.loop ?? null,
    );
    let s29played = true;
    try {
      await waitVideoPlaying(page);
    } catch {
      s29played = false;
    }
    // The machine advances part-012 -> part-013 on its own (1 pass report
    // + 1500 ms min-hold); the poster attribute marks the entry.
    let s29advanced = true;
    try {
      await page.waitForFunction(
        () =>
          (
            document.getElementById("visual-video")?.getAttribute("poster") ??
            ""
          ).includes("part-013.poster.jpg"),
        { timeout: 6000 },
      );
    } catch {
      s29advanced = false;
    }
    const s29rec = await page.evaluate(() => window.__kineticVid);
    const s29frames = s29rec.frames.filter((f) =>
      f.poster.includes("part-012.poster.jpg"),
    );
    const s29first = s29frames[0] ?? null;
    const s29maxEnd =
      s29frames.length > 0
        ? Math.max(...s29frames.map((f) => f.mediaTime))
        : -1;
    const s29inside =
      s29frames.length > 0 &&
      s29frames.every((f) => f.mediaTime >= -0.05 && f.mediaTime <= 1.25);
    const s29endedInPhase = s29rec.ended.filter((e) =>
      e.src.includes("clip-012.mp4"),
    ).length;
    const s29startOffset = s29first ? s29first.mediaTime : -1;
    const s29passDelta = s29maxEnd - 1.0;
    const s29Ok =
      s29rvfc &&
      s29walked &&
      s29onClip &&
      s29played &&
      s29loop === false &&
      s29advanced &&
      s29first !== null &&
      s29startOffset <= 0.15 &&
      s29inside &&
      s29passDelta >= -0.04 &&
      s29passDelta <= 0.25 &&
      s29endedInPhase === 0;
    record(
      "29. part-012 plays range [0,1] and reports its pass via rVFC",
      s29Ok ? "PASS" : !s29rvfc ? "PARTIAL" : !s29played ? "PARTIAL" : "FAIL",
      `requestVideoFrameCallback available=${String(s29rvfc)}; clean-slate page walked to line-011=${String(s29walked)}, clip present=${String(s29onClip)}; first presented frame mediaTime=${JSON.stringify(s29first && Math.round(s29first.mediaTime * 1000) / 1000)} currentTime=${JSON.stringify(s29first && Math.round(s29first.currentTime * 1000) / 1000)} (start offset OBSERVED ${s29startOffset >= 0 ? "+" : ""}${s29startOffset.toFixed(3)}s of ${String(s29frames.length)} frames, all inside [0, 1+0.25]=${String(s29inside)}); pass completed OBSERVED at mediaTime ${s29maxEnd.toFixed(3)} = +${s29passDelta.toFixed(3)}s past endSeconds 1.0; loop=${String(s29loop)} (never loop=true on a range); native ended from clip-012 during this phase=${String(s29endedInPhase)} (0: the pass ends before the file); machine advanced to part-013=${String(s29advanced)} (poster attribute flipped)${
        s29played ? "" : "; autoplay did not start headless"
      }`,
    );

    // 30. Video playback ranges, range 2 (docs/plan.md Phases 9c and 9d):
    // item 12, part-013 — the SAME clip-012.mp4 file at [1.0, 2.0] with
    // `loopCount` 2 and `loopStartSeconds` 1.5, entered automatically by
    // step 29's machine advance. Entry seeks to startSeconds 1.0; the
    // loop-back after pass 1 seeks to loopStartSeconds 1.5, NOT 1.0 — the
    // intro [1.0, 1.5) plays once. Because the range end equals the file's
    // duration, the pass boundary is the file's own `ended` (no frame is
    // ever presented past it), so the ended counter doubles as the
    // pass-report counter: exactly 2, each seeking back to 1.5 except
    // after the last. Observed and recorded: the first frame after entry
    // (start offset from 1.0), the loop-back (mediaTime wrap 2.0 -> 1.5)
    // and where it actually landed, the two pass reports, and the hold
    // near 2.0 at the end. The time gate is now firstPass + loopPass =
    // 1.0 + 0.5 = 1.5 s (machine-tested arithmetic), so the wait below
    // lands ~1.5 s after entry plus the reports; the 6 s timeout covers
    // it generously. Since the Phase 13 fixture this item is NOT the
    // story's end; since Phase 15 what follows is a VIDEO chain (stroll-
    // 025), so the reused <video> element would keep playing if the
    // machine advanced mid-measurement: auto is turned OFF on entry (the
    // ended reports still count, but with no timer nothing moves) and
    // restored at the step's end, after which the armed hold carries the
    // walk on (loop stays off throughout — a range must never loop=true).
    await pressA(cdp); // auto OFF: measure part-013's hold on a frozen cursor
    let s30settled = true;
    try {
      await page.waitForFunction(
        () => {
          const v = document.getElementById("visual-video");
          return (
            v?.paused === true &&
            v.currentTime >= 1.9 &&
            (v.getAttribute("poster") ?? "").includes("part-013.poster.jpg")
          );
        },
        { timeout: 6000 },
      );
    } catch {
      s30settled = false;
    }
    await sleep(350); // a stray third pass (loop=true behaviour) would show
    const s30rec = await page.evaluate(() => window.__kineticVid);
    const s30recFrames = s30rec.frames.filter((f) =>
      f.poster.includes("part-013.poster.jpg"),
    );
    // Only frames presented while part-013 was on screen: the poster
    // attribute flips the instant the element is retargeted, so frames of
    // anything after part-013 are already filtered out by the poster. The
    // img gate below stays from the Phase 13 walk, when the next item was
    // the bridge-014 image and a synchronous item change let the element
    // play one hidden re-loop first — with auto off across this
    // measurement there is normally nothing to exclude.
    const s30frames = s30recFrames.filter((f) => f.img !== "bridge-014.jpg");
    const s30hiddenFrames = s30recFrames.length - s30frames.length;
    const s30first = s30frames[0] ?? null;
    // The loop-back: the pass-1 boundary seeks 2.0 -> 1.5, so the frame
    // stream wraps by ~0.45 — well above the 0.04 s in-pass cadence, well
    // below the old 0.5 threshold, which would MISS a wrap that lands on
    // loopStartSeconds instead of 1.0. One wrap = one in-pass restart.
    let s30wraps = 0;
    let s30wrapLand = null;
    for (let i = 1; i < s30frames.length; i += 1) {
      if (s30frames[i - 1].mediaTime - s30frames[i].mediaTime > 0.25) {
        s30wraps += 1;
        s30wrapLand = s30frames[i].mediaTime;
      }
    }
    const s30inside =
      s30frames.length > 0 &&
      s30frames.every((f) => f.mediaTime >= 0.95 && f.mediaTime <= 2.05);
    const s30ended = s30rec.ended.filter((e) => e.src.includes("clip-012.mp4"));
    // The ended filter below stays from the Phase 13 walk: an `ended`
    // fired by the item-change transition (reused element, image already
    // painted) is an event of the NEXT item's screen, not a part-013 pass
    // report. The pass-report count is therefore read while part-013 is
    // still what's on screen (the reused <img> still shows pier-009).
    const s30pass = s30ended.filter((e) => e.img !== "bridge-014.jpg");
    const s30endedExtra = s30ended.length - s30pass.length;
    const s30last = await page.evaluate(() => {
      const v = document.getElementById("visual-video");
      return v
        ? {
            paused: v.paused,
            loop: v.loop,
            currentTime: Math.round(v.currentTime * 1000) / 1000,
          }
        : null;
    });
    const s30startOffset = s30first ? s30first.mediaTime - 1.0 : 99;
    const s30Ok =
      s30settled &&
      s30first !== null &&
      Math.abs(s30startOffset) <= 0.15 &&
      s30inside &&
      s30wraps === 1 &&
      s30wrapLand !== null &&
      // The loop-back lands at loopStartSeconds 1.5, NOT at the range
      // start 1.0 (which the pre-9c/9d element-loop or a startSeconds
      // seek-back would give): exactly one landing, recorded actual.
      Math.abs(s30wrapLand - 1.5) <= 0.15 &&
      s30pass.length === 2 &&
      s30last !== null &&
      s30last.paused === true &&
      s30last.loop === false &&
      s30last.currentTime >= 1.9 &&
      s30last.currentTime <= 2.05;
    record(
      "30. part-013 plays [1,2] twice, looping back at loopStartSeconds 1.5",
      s30Ok ? "PASS" : "FAIL",
      `${String(s30frames.length)} presented frames, all inside [1-0.05, 2+0.05]=${String(s30inside)}; entered at OBSERVED mediaTime ${s30first ? s30first.mediaTime.toFixed(3) : "n/a"} (start offset ${s30startOffset >= 0 ? "+" : ""}${s30startOffset.toFixed(3)}s from startSeconds 1.0); pass-1 loop-back observed=${String(s30wraps === 1)} landing OBSERVED ${s30wrapLand === null ? "n/a" : s30wrapLand.toFixed(3)} (offset ${s30wrapLand === null ? "n/a" : `${s30wrapLand - 1.5 >= 0 ? "+" : ""}${(s30wrapLand - 1.5).toFixed(3)}s`} from loopStartSeconds 1.5, not 1.0); pass reports (native ended from clip-012, endSeconds == duration)=${String(s30pass.length)} of 2 while part-013 was on screen${s30endedExtra > 0 ? ` (+${String(s30endedExtra)} stray native ended and ${String(s30hiddenFrames)} hidden-pass frame${s30hiddenFrames === 1 ? "" : "s"} from the item-change element re-loop — an OBSERVED artefact when the machine moves in the same event, excluded from the arithmetic above and reported)` : ""} — auto was OFF across this measurement (Phase 15: the next item is now the stroll-025 VIDEO chain, whose play through the same reused element would blur the hold), the reports alone never moved the cursor, and the last one left the element holding OBSERVED ${JSON.stringify(s30last)} near 2.0, paused, loop=${String(s30last?.loop)}; its gate arithmetic (both reports + the 1.5 s time bound) is pinned by machine tests, and the a-toggle now restores auto for the walk below`,
    );
    await pressA(cdp); // auto back ON: the armed hold carries part-013's
    // settled gate on into the Phase 15 chain and the branch walk below

    // 31. A folder with the empty stub manifest shows the empty state —
    // and `t` there opens the same panel, saying the novel has no
    // bookmarks yet (storage is namespaced per novel folder, and this
    // folder has none). Escape closes it again.
    const emptyPage = await browser.newPage();
    emptyPage.on("console", (msg) =>
      consoleMessages.push(`empty [${msg.type()}] ${msg.text()}`),
    );
    emptyPage.on("pageerror", (err) => pageErrors.push(`empty ${err.message}`));
    await emptyPage.goto(pathToFileURL(join(emptyDir, "index.html")).href);
    await emptyPage.waitForFunction(
      () => {
        const el = document.getElementById("empty-state");
        return el !== null && (el.textContent ?? "").length > 0;
      },
      { timeout: 5000 },
    );
    // A different novel folder means a first-ever load, so the key help
    // shows here too — over the empty state (Phase 13b: helpSeen belongs
    // to the novel's namespace, and this folder has never been read).
    // Reading the state happens with the help up; closing it below is the
    // page's first gesture.
    const s31 = await emptyPage.evaluate(PAGE_STATE);
    const s31Ok =
      s31.emptyState === EXPECTED.emptyNotice &&
      s31.imgSrc === null &&
      s31.overlayHidden === true &&
      s31.helpOpen === true &&
      s31.stageHidden === true;
    const emptyCdp = await emptyPage.createCDPSession();
    const s31HelpDismissed = await dismissHelp(emptyPage, emptyCdp);
    await pressT(emptyCdp);
    await emptyPage.waitForFunction(OVERLAY_OPEN, { timeout: 5000 });
    const s31overlay = await emptyPage.evaluate(READ_BOOKMARK_OVERLAY);
    const s31EmptyOverlayOk =
      s31overlay.hidden === false &&
      s31overlay.entries.length === 0 &&
      s31overlay.emptyText === "No bookmarks yet — press b";
    // Same fullscreen caveat as step 20: dismissing the help (Enter) was
    // this page's first gesture so it entered fullscreen, and the browser
    // keeps the first Escape.
    await pressEscape(emptyCdp);
    await sleep(80);
    await pressEscape(emptyCdp);
    const s31Closed = await panelOpen(emptyPage);
    record(
      "31. empty-manifest folder shows the empty state under its own first-load help; t there says no bookmarks yet",
      s31Ok && s31HelpDismissed && s31EmptyOverlayOk && s31Closed === false
        ? "PASS"
        : "FAIL",
      `${JSON.stringify({ emptyState: s31.emptyState, imgSrc: s31.imgSrc, overlayHidden: s31.overlayHidden, helpOpen: s31.helpOpen, stageHidden: s31.stageHidden })} — the empty novel gets its own help screen too (helpSeen is per novel folder); Enter closed it=${String(s31HelpDismissed)}; t opened the overlay: emptyText=${JSON.stringify(s31overlay.emptyText)} entries=${String(s31overlay.entries.length)} (the demo folder's two bookmarks are another novel's — storage is keyed per folder); Escape (after the fullscreen-exiting one the browser keeps) closed=${String(s31Closed === false)}`,
    );
    // Done with the empty-novel tab. It must actually CLOSE: its app
    // holds a connection to the same "kinetic" IndexedDB (keyed inside,
    // one database), and a live connection makes every later
    // deleteDatabase block forever — OBSERVED: with this tab still open,
    // step 40's fresh-slate wipe could never delete, the storage stayed
    // dirty, and the first-ever help screen never came back.
    await emptyPage.close();

    // 32. Fill the screen (docs/plan.md Phase 7b): the media is the largest
    // centred contain fit of the ASSET's own aspect ratio into whatever
    // viewport the player gets, never the manifest's box. Two mismatched
    // viewports, one per letterbox direction: the fixture image (16:9, the
    // same aspect as the manifest) in a portrait viewport, and the copy whose
    // item-1 image was rescaled to 2:3 while the manifest stayed 16:9, in a
    // wide viewport. Only the second can tell "fit to the asset" apart from
    // "fit to the manifest", so without the rescaled asset the step says
    // PARTIAL rather than asserting a weaker fact as if it were the real one.
    const fitPages = [];
    try {
      const portrait = await openAtViewport(
        browser,
        contentDir,
        700,
        1000,
        "portrait fit",
        consoleMessages,
        pageErrors,
      );
      const tall = await openAtViewport(
        browser,
        tallDir,
        1200,
        700,
        "tall fit",
        consoleMessages,
        pageErrors,
      );
      fitPages.push(portrait, tall);
      const portraitState = await portrait.evaluate(FIT_STATE);
      const tallState = await tall.evaluate(FIT_STATE);
      const portraitFit = judgeFit(portraitState);
      const tallFit = judgeFit(tallState);
      const [tvw, tvh] = tallState.viewport;
      const [bandLeft, bandWidth, bandBottom] = tallState.overlayBand ?? [
        0, 0, 0,
      ];
      const facts = {
        assetIsPortrait:
          tallState.natural?.join("x") ===
          `${TALL_ASSET.width}x${TALL_ASSET.height}`,
        manifestIsWide: tallState.manifest.join("x") === "960x540",
        // The asset's own aspect genuinely differs from the manifest's in this
        // folder, and `aspectKept` above proves the fitted box follows the
        // asset's — so the box cannot have come from the manifest size.
        assetDiffersFromManifest:
          tallState.natural !== null &&
          Math.abs(
            tallState.natural[0] / tallState.natural[1] -
              tallState.manifest[0] / tallState.manifest[1],
          ) > 0.05,
        // The overlay is a band across the whole viewport, not a caption
        // inside the pillarbox: full width, bottom flush, wider than media.
        bandSpansScreen:
          Math.abs(bandLeft) <= 1 &&
          Math.abs(bandWidth - tvw) <= 1 &&
          Math.abs(bandBottom - tvh) <= 1,
        bandOverLetterbox: bandWidth > tallFit.fit.width + 20,
      };
      const core = portraitFit.ok && tallFit.ok;
      const rest =
        facts.assetIsPortrait &&
        facts.manifestIsWide &&
        facts.assetDiffersFromManifest &&
        facts.bandSpansScreen &&
        facts.bandOverLetterbox;
      const status = !tallAsset
        ? core && rest
          ? "PARTIAL"
          : "FAIL"
        : core && rest
          ? "PASS"
          : "FAIL";
      const brief = (state, fit) =>
        `viewport=${state.viewport.join("x")} asset=${state.natural?.join("x")} ` +
        `box=${state.box?.map((n) => Math.round(n)).join("x")} ` +
        `contain=${fit.fit.width.toFixed(1)}x${fit.fit.height.toFixed(1)}@${fit.fit.x.toFixed(1)},${fit.fit.y.toFixed(1)} ` +
        `(manifest fit would be ${fit.manifestFit.width.toFixed(1)}x${fit.manifestFit.height.toFixed(1)}) ` +
        `fit=${state.objectFit}/${state.objectPosition} ` +
        `bad=${
          Object.entries(fit.facts)
            .filter(([, v]) => !v)
            .map(([k]) => k)
            .join(",") || "none"
        }`;
      record(
        "32. media fills the viewport as a centred contain fit of its own aspect",
        status,
        `${brief(portraitState, portraitFit)} | ${brief(tallState, tallFit)} | ` +
          `overlay band=${bandWidth.toFixed(0)}px of ${tvw}px, bottom=${bandBottom.toFixed(0)} of ${tvh}px ` +
          `(spans screen=${String(facts.bandSpansScreen)}, past the pillarbox=${String(facts.bandOverLetterbox)}, ` +
          `asset aspect ${tallState.natural?.join("x")} vs manifest ${tallState.manifest.join("x")}=${String(facts.assetDiffersFromManifest)})` +
          (tallAsset
            ? "; the letterbox paint itself is CSS object-fit: contain, so its pixels are not sampled here - on a real screen the black bars should sit outside the media, top/bottom or left/right"
            : "; PARTIAL: sips could not rescale a copy of the fixture image, so the measured asset's aspect equals the manifest's and independence from the manifest box is asserted by rule, not by measurement"),
      );
    } finally {
      for (const page of fitPages) {
        const context = page.browserContext();
        await page.close();
        await context.close();
      }
    }

    // 33. Console stayed empty through the linear walk. The branch steps
    // below keep writing into the same arrays, and step 41 re-checks the
    // whole run after them.
    const s33Ok = consoleMessages.length === 0 && pageErrors.length === 0;
    record(
      "33. console stayed empty through the linear walk (re-checked at 41)",
      s33Ok ? "PASS" : "FAIL",
      s33Ok
        ? "zero console messages, zero page errors, every page, up to here (the branch steps are covered by step 41)"
        : `console=[${consoleMessages.join(" | ")}] pageErrors=[${pageErrors.join(" | ")}]`,
    );

    // ---- Phase 13: the branch fixture, walked for real (docs/plan.md
    // Phase 13). Steps 29-30 left auto-forward ON with part-013's gate
    // done — and part-013 is no longer the story's end, so the story has
    // been walking ITSELF on through the Phase 15 floor chain (auto exits
    // it at the 4.5 s floor) and the lead-in while steps 31-33 ran on
    // other pages. The fixture's branch table: `outer-hire` hangs off
    // bridge-015 (routes hire [continuing, result return] / refuse
    // [ending], continueAt main-023), and inside the hire span
    // `inner-time` hangs off hire-017 (late [continuing, continueAt
    // hire-018] / early [ending]).
    // OBSERVED: after steps 31-32 opened (and closed) their own tabs, the
    // FIRST trusted-mouse dispatch on the main page hung for the whole
    // protocol timeout (twice, on wheel and on click alike, across
    // reloads) while keys and evaluates kept answering — the tab had not
    // regained foreground. Take it back explicitly.
    await page.bringToFront();
    await page.evaluate(INSTALL_BRANCH_LOG);

    // 34. Walking on past the old last item reaches the lead-in, and the
    // FORWARD SETTLE of bridge-015 — carried by the auto-advance, still
    // on, which has been walking the story on its own ever since
    // part-013's gate (part-013 is mid-story now) — opens `#choice`
    // INSTEAD of moving. The item holds: with auto-forward armed and a
    // 2 s wait, the decision is what owns the screen.
    let s34autoFired = true;
    try {
      // No input at all: bridge-014's text hold, bridge-015's 1500 ms
      // floor, and the settle fires — all on the auto-advance.
      await page.waitForFunction(CHOICE_OPEN, { timeout: 12000 });
    } catch {
      s34autoFired = false;
    }
    // Fallback drive (the step's core claim is the overlay itself): if no
    // decision came on its own, press toward one.
    let s34driven = false;
    for (let i = 0; i < 6 && !(await page.evaluate(CHOICE_OPEN)); i += 1) {
      s34driven = true;
      await pressSpace(cdp);
      await sleep(300);
    }
    const s34fired = await page.evaluate(CHOICE_OPEN);
    const s34 = await page.evaluate(PAGE_STATE);
    const s34choice = await page.evaluate(READ_CHOICE);
    const s34sig = await page.evaluate(PAINT_SIG);
    await sleep(2000); // auto-forward ON: a pending decision does not move
    const s34sigHeld = await page.evaluate(PAINT_SIG);
    const s34still = await page.evaluate(READ_CHOICE);
    const s34RowsOk =
      s34choice.hidden === false &&
      s34choice.prompt === EXPECTED.outerPrompt &&
      s34choice.rows.length === 2 &&
      s34choice.rows[0]?.idx === "0" &&
      s34choice.rows[0]?.number === "1" &&
      s34choice.rows[0]?.label === EXPECTED.hireLabel &&
      s34choice.rows[1]?.idx === "1" &&
      s34choice.rows[1]?.number === "2" &&
      s34choice.rows[1]?.label === EXPECTED.refuseLabel &&
      s34choice.rows.every((r) => !r.isContinue && r.seen === null);
    record(
      "34. branch: settling bridge-015 opens #choice (prompt + 2 routes); the item does not advance",
      s34fired &&
        s34.imgSrc === "bridge-015.jpg" &&
        s34.overlayHidden === true &&
        s34RowsOk &&
        s34sig === s34sigHeld &&
        s34still.hidden === false &&
        s34still.prompt === EXPECTED.outerPrompt
        ? "PASS"
        : "FAIL",
      `the decision ${s34autoFired && !s34driven ? "OPENED PURELY ON THE AUTO-ADVANCE — no advance key between part-013 and the overlay (step 30 toggled only the a key around its hold measurement): part-013 is mid-story, the auto-advance walked the Phase 15 floor chain's exit and the lead-in on its own, and the settle of bridge-015 fires it" : `came only after ${String(s34driven ? "drive presses" : "nothing")} (auto-fired=${String(s34autoFired)})`}: #choice up=${String(s34choice.hidden === false)} current=${JSON.stringify(s34.imgSrc)} overlayHidden=${String(s34.overlayHidden)} prompt=${JSON.stringify(s34choice.prompt)} rows=${JSON.stringify(s34choice.rows)} (numbered 1..2, manifest order, no seen markers, no return row); the settled decision's item holds: 2000 ms of sampling with auto-forward ON changed nothing (${String(s34sig === s34sigHeld)}) and the overlay stayed up=${String(s34still.hidden === false)} — a pending decision owns the screen`,
    );

    // 35. Digit 2 picks `refuse` — the ENDING route. The refuse span plays
    // (refuse-019's own image, then its ending line over it), and the hire
    // route's image is NEVER painted: the page-side change log proves it.
    // Past refuse-020 the decision RE-OPENS for reselection: refuse row
    // carries the seen marker, the hire row does not — and since Phase 16
    // ("the ending-loop is escapable") the re-open OFFERS "Return to main
    // route": once ANY route of a decision has completed, every re-opening
    // carries it whenever the decision has a continuing route.
    await pressDigit(cdp, "2"); // refuse
    await page.waitForFunction(CHOICE_CLOSED, { timeout: 5000 });
    await pressA(cdp); // manual from here: the branch walk's presses are ours
    const s35 = await page.evaluate(PAGE_STATE);
    await stepForward(cdp); // -> refuse-020, the route's ending line
    const s35b = await page.evaluate(PAGE_STATE);
    await stepForward(cdp); // one press settles it AND steps off the route
    // end (manual mode, Phase 16) — which re-opens the decision
    let s35reopen = true;
    try {
      await page.waitForFunction(CHOICE_OPEN, { timeout: 5000 });
    } catch {
      s35reopen = false;
    }
    const s35choice = await page.evaluate(READ_CHOICE);
    const s35log = await readBranchLog(page);
    const s35Ok =
      s35.imgSrc === "refuse-019.jpg" &&
      s35.speaker === "Mei" &&
      s35.text === EXPECTED.refuse019Text &&
      s35b.imgSrc === "refuse-019.jpg" && // the ending line plays over it
      s35b.text === EXPECTED.refuse020Text &&
      s35reopen &&
      s35choice.hidden === false &&
      s35choice.prompt === EXPECTED.outerPrompt &&
      s35choice.rows.length === 3 &&
      s35choice.rows[0]?.seen === null &&
      s35choice.rows[1]?.seen === "seen" &&
      s35choice.rows[2]?.isContinue === true &&
      s35choice.rows[2]?.label === CONTINUE_LABEL &&
      !s35log.some((l) => l.includes("hire-016.jpg"));
    record(
      "35. route refuse (ending): its span plays, hire-016 never shows, the decision re-opens seen-marked WITH the Return row (Phase 16)",
      s35Ok ? "PASS" : "FAIL",
      `digit 2 opened the refuse span on refuse-019 (img=${JSON.stringify(s35.imgSrc)} speaker=${String(s35.speaker)} text=${String(s35.text === EXPECTED.refuse019Text)}), then its ending line over the SAME image (${String(s35b.text === EXPECTED.refuse020Text)}); the page-side log never held hire-016.jpg=${String(!s35log.some((l) => l.includes("hire-016.jpg")))} (the hire route was entered, never painted); past the route end #choice came back=${String(s35reopen)} rows=${JSON.stringify(s35choice.rows)} — refuse row marked seen, hire row unmarked, and the unnumbered ${JSON.stringify(CONTINUE_LABEL)} row present (Phase 16: once any route completed, the re-offer always carries it when a continuing route exists, whatever the played route's result — the ending-loop is escapable)`,
    );

    // 36. Digit 1 picks `hire` — the CONTINUING route. It opens on
    // hire-016, and settling hire-017 fires the NESTED `inner-time`
    // decision (prompt + late/early rows, no return row — no route of it
    // has completed yet). Digit 2 picks `early`; after early-022 the inner
    // decision RE-OPENS with early seen-marked, late unmarked, and the
    // unnumbered "Return to main route" row (the same Phase 16 re-offer
    // step 35 pinned). Enter answers it onto the continueAt — the change
    // log proves early-022 was shown before hire-018, the re-opened
    // overlay between them. The `late` route still plays, in the play-all
    // burst (step 40).
    await pressDigit(cdp, "1"); // hire
    await page.waitForFunction(CHOICE_CLOSED, { timeout: 5000 });
    const s36 = await page.evaluate(PAGE_STATE);
    await stepForward(cdp); // -> hire-017
    const s36b = await page.evaluate(PAGE_STATE);
    await pressSpace(cdp); // settles hire-017; the move fires the nested
    // decision before any step happens (Phase 16 press = settle + move)
    let s36inner = true;
    try {
      await page.waitForFunction(CHOICE_OPEN, { timeout: 5000 });
    } catch {
      s36inner = false;
    }
    const s36choice = await page.evaluate(READ_CHOICE);
    await pressDigit(cdp, "2"); // early — the nested `return` route
    let s36early = true;
    try {
      await page.waitForFunction(
        (expected) =>
          (document.getElementById("overlay-text")?.textContent ?? "") ===
          expected,
        { timeout: 5000 },
        EXPECTED.early022Text,
      );
    } catch {
      s36early = false;
    }
    const s36earlyState = await page.evaluate(PAGE_STATE);
    await stepForward(cdp); // settles early-022 AND steps off the route end
    // in one press — the inner decision re-opens
    let s36reopen = true;
    try {
      await page.waitForFunction(CHOICE_OPEN, { timeout: 5000 });
    } catch {
      s36reopen = false;
    }
    const s36reopenChoice = await page.evaluate(READ_CHOICE);
    await pressEnter(cdp); // "Return to main route"
    let s36rejoin = true;
    try {
      await page.waitForFunction(
        (expected) =>
          (document.getElementById("overlay-text")?.textContent ?? "") ===
          expected,
        { timeout: 5000 },
        EXPECTED.hire018Text,
      );
    } catch {
      s36rejoin = false;
    }
    const s36rejoinState = await page.evaluate(PAGE_STATE);
    const s36rejoinChoice = await page.evaluate(READ_CHOICE);
    const s36log = await readBranchLog(page);
    const s36earlyAt = s36log.findIndex((l) =>
      l.includes(EXPECTED.early022Text),
    );
    const s36rejoinAt = s36log.findIndex((l) =>
      l.includes(EXPECTED.hire018Text),
    );
    // The re-open is part of the path now: a choice-open line MUST sit
    // between the route's last item and the rejoin the Enter answered.
    const s36reopenBetween =
      s36earlyAt >= 0 &&
      s36rejoinAt > s36earlyAt &&
      s36log
        .slice(s36earlyAt + 1, s36rejoinAt)
        .some((l) => l.includes("choice-open"));
    const s36ReopenRowsOk =
      s36reopenChoice.hidden === false &&
      s36reopenChoice.prompt === EXPECTED.innerPrompt &&
      s36reopenChoice.rows.length === 3 &&
      s36reopenChoice.rows[0]?.label === EXPECTED.lateLabel &&
      s36reopenChoice.rows[0]?.seen === null &&
      s36reopenChoice.rows[1]?.label === EXPECTED.earlyLabel &&
      s36reopenChoice.rows[1]?.seen === "seen" &&
      s36reopenChoice.rows[2]?.isContinue === true &&
      s36reopenChoice.rows[2]?.label === CONTINUE_LABEL &&
      s36reopenChoice.rows[2]?.seen === null;
    const s36Ok =
      s36.imgSrc === "hire-016.jpg" &&
      s36.speaker === "Mei" &&
      s36.text === EXPECTED.hire016Text &&
      s36b.imgSrc === "hire-016.jpg" && // hire-017 is a chain line over it
      s36b.text === EXPECTED.hire017Text &&
      s36inner &&
      s36choice.hidden === false &&
      s36choice.prompt === EXPECTED.innerPrompt &&
      s36choice.rows.length === 2 &&
      s36choice.rows[0]?.label === EXPECTED.lateLabel &&
      s36choice.rows[1]?.label === EXPECTED.earlyLabel &&
      s36choice.rows.every((r) => !r.isContinue) &&
      s36early &&
      s36earlyState.imgSrc === "hire-016.jpg" &&
      s36earlyState.text === EXPECTED.early022Text &&
      s36reopen &&
      s36ReopenRowsOk &&
      s36rejoin &&
      s36rejoinState.text === EXPECTED.hire018Text &&
      s36rejoinState.imgSrc === "hire-016.jpg" &&
      s36rejoinChoice.hidden === true &&
      s36reopenBetween;
    record(
      "36. route hire: nested decision on hire-017; picking early (return) re-opens it with the Return row; Enter rejoins at hire-018",
      s36Ok ? "PASS" : "FAIL",
      `digit 1 opened the hire route on hire-016 (img/text/speaker=${String(s36.imgSrc === "hire-016.jpg" && s36.text === EXPECTED.hire016Text && s36.speaker === "Mei")}); settling hire-017 fired the NESTED overlay=${String(s36inner)} prompt=${JSON.stringify(s36choice.prompt)} rows=${JSON.stringify(s36choice.rows.map((r) => r.label))} (no return row); digit 2 picked early -> early-022 over the hire-016 visual=${String(s36early)}; stepping off its end RE-OPENED the inner decision=${String(s36reopen)} rows=${JSON.stringify(s36reopenChoice.rows.map((r) => [r.label, r.seen, r.isContinue]))} — early seen-marked, late unmarked, plus the unnumbered ${JSON.stringify(CONTINUE_LABEL)} row (result return is the only offer); Enter took it -> hire-018 current=${String(s36rejoinState.text === EXPECTED.hire018Text)} with #choice shut=${String(s36rejoinChoice.hidden === true)} — the page-side log shows ${JSON.stringify(EXPECTED.early022Text)} at #${String(s36earlyAt)}, a choice-open line between, then ${JSON.stringify(EXPECTED.hire018Text)} at #${String(s36rejoinAt)}=${String(s36reopenBetween)} (late plays only in the play-all burst)`,
    );

    // 37. hire-018 is the OUTER hire route's end, and hire is the
    // continuing route: its end goes STRAIGHT to continueAt — no overlay,
    // no continue row (the return row exists only after a non-continuing
    // `return` route; the continuing route's own result is moot). The
    // aftermath plays once: main-023.jpg appears exactly once in the log.
    await stepForward(cdp); // settles hire-018 AND steps off the outer end
    // in one press — the continuing route's end goes to continueAt
    let s37main = true;
    try {
      await page.waitForFunction(
        () =>
          (
            document.getElementById("visual-image")?.getAttribute("src") ?? ""
          ).includes("main-023.jpg"),
        { timeout: 5000 },
      );
    } catch {
      s37main = false;
    }
    const s37 = await page.evaluate(PAGE_STATE);
    const s37choice = await page.evaluate(READ_CHOICE);
    const s37log = await readBranchLog(page);
    const s37mainCount = s37log.filter((l) =>
      l.includes("main-023.jpg"),
    ).length;
    await stepForward(cdp); // -> main-024, the closing line
    const s37b = await page.evaluate(PAGE_STATE);
    const s37Ok =
      s37main &&
      s37.imgSrc === "main-023.jpg" &&
      s37.speaker === "Mei" &&
      s37.text === EXPECTED.main023Text &&
      s37choice.hidden === true &&
      s37mainCount === 1 &&
      s37b.text === EXPECTED.main024Text &&
      s37b.imgSrc === "main-023.jpg";
    record(
      "37. continuing-route end: off hire-018 straight into main-023 (continueAt), no overlay, aftermath once",
      s37Ok ? "PASS" : "FAIL",
      `stepping off the hire route's end landed on the aftermath directly: img=${JSON.stringify(s37.imgSrc)} text=${String(s37.text === EXPECTED.main023Text)} speaker=${String(s37.speaker)}, #choice stayed shut=${String(s37choice.hidden === true)} (the continuing route proceeds to continueAt — its end is not a reselection point; the engine test "the continuing route proceeds to continueAt past its end" pins the rule); main-023.jpg appears ${String(s37mainCount)}x in the whole-page change log (the aftermath plays once, not per route); the walk continues onto the closing line=${String(s37b.text === EXPECTED.main024Text)}`,
    );

    // 38. Reload resume INSIDE branch content: the walk ended on the
    // closing line main-024 (continueAt aftermath included), so lastShown
    // is branch content — reload must come back on exactly that item,
    // with NO decision re-firing on load: decisions fire on the forward
    // settle of `after`, never on a resume landing. (These steps need no
    // wheel and no click: after steps 31-32's extra tabs the first
    // mouse-class dispatch on the main page had hung — foreground is
    // reclaimed above; keys and reloads carry everything here.)
    // The write went out when lastShown changed (Phase 14 removed the
    // debounce); this short wait lets that transaction commit before the
    // reload — belt and braces, not the mechanism, since step 42 reloads
    // with no wait at all and still resumes correctly.
    await sleep(400);
    const s38sig = await page.evaluate(PAINT_SIG);
    await page.reload();
    await sleep(700); // resume paints at load; helpSeen keeps the help shut
    const s38 = await page.evaluate(PAGE_STATE);
    const s38choice = await page.evaluate(READ_CHOICE);
    const s38sigResumed = await page.evaluate(PAINT_SIG);
    await sleep(1800); // past every hold: a resume lands settled and holds
    const s38sigHeld = await page.evaluate(PAINT_SIG);
    const s38Ok =
      s38sigResumed === s38sig &&
      s38sigHeld === s38sig &&
      s38.text === EXPECTED.main024Text &&
      s38.imgSrc === "main-023.jpg" &&
      s38choice.hidden === true &&
      s38.helpOpen === false &&
      s38.stageHidden === false;
    record(
      "38. reload resumes inside branch content on lastShown (main-024); no decision re-fires on load",
      s38Ok ? "PASS" : "FAIL",
      `the branch walk's last item reloaded: the page came back on the SAME item (signature identical=${String(s38sigResumed === s38sig)}, still identical 1.8 s later=${String(s38sigHeld === s38sig)}) — lastShown drove the landing, the restored route-play ctx carried the played routes, and #choice never re-fired on load=${String(s38choice.hidden === true)} (resuming inside branch content fires nothing: decisions fire only on the forward settle of their after item); the help stayed closed=${String(s38.helpOpen === false)}`,
    );

    // 39. Seen-aware `e` on the resumed page: everything on the played
    // path is seen (the ctx's visited set survived the reload), and the
    // ONLY item never shown is late-021 — the inner route the walk never
    // picked (early was, and returned). Rule (c) (first unseen item in
    // array order) lands there, and the landing marks it seen. A second
    // press then follows the Phase 16 rule: with EVERYTHING seen, `e`
    // shows the ENDING — the most recently seen ending item (main-024,
    // the array end, tracked as lastEnding and persisted with the ctx) —
    // and a third press on that item stays put (no ending cycle).
    await pressE(cdp);
    let s39e = true;
    try {
      await page.waitForFunction(
        (expected) =>
          (document.getElementById("overlay-text")?.textContent ?? "") ===
          expected,
        { timeout: 5000 },
        EXPECTED.late021Text,
      );
    } catch {
      s39e = false;
    }
    const s39 = await page.evaluate(PAGE_STATE);
    const s39choice = await page.evaluate(READ_CHOICE);
    await pressE(cdp); // everything is seen now: the press shows the ENDING
    let s39ending = true;
    try {
      await page.waitForFunction(
        (expected) =>
          (document.getElementById("overlay-text")?.textContent ?? "") ===
          expected,
        { timeout: 5000 },
        EXPECTED.main024Text,
      );
    } catch {
      s39ending = false;
    }
    const s39end = await page.evaluate(PAGE_STATE);
    const s39sig = await page.evaluate(PAINT_SIG);
    await pressE(cdp); // already on the ending item: the press stays put
    await sleep(400);
    const s39sigHeld = await page.evaluate(PAINT_SIG);
    const s39Ok =
      s39e &&
      s39.text === EXPECTED.late021Text &&
      s39.imgSrc === "hire-016.jpg" && // the jump shows the never-taken line
      s39choice.hidden === true &&
      s39ending &&
      s39end.text === EXPECTED.main024Text &&
      s39end.imgSrc === "main-023.jpg" && // the most recently seen ending
      s39sig === s39sigHeld;
    record(
      "39. e jumps to the never-taken route's item; with everything seen it shows the ENDING (Phase 16); a further press stays put",
      s39Ok ? "PASS" : "FAIL",
      `e landed on ${JSON.stringify(s39.text)} over ${JSON.stringify(s39.imgSrc)} — late-021, the inner route the walk never played (early was picked and returned in step 36 — the played path is all seen: the visited set came back with the ctx, itself OBSERVED here; no decision is open, so the rule (c) array-order jump is what fires; #choice stayed shut=${String(s39choice.hidden === true)}); the landing marks it seen, so the SECOND e met an all-seen story and showed the ENDING instead: ${JSON.stringify(s39end.text)} over ${JSON.stringify(s39end.imgSrc)}=${String(s39ending)} — main-024, the most recently seen ending item, tracked as lastEnding since the walk passed it (and restored through step 38's reload); a third e on that item changed nothing (${String(s39sig === s39sigHeld)}) — the press never cycles through endings`,
    );

    // 40. `Play all routes` + skip-all, zero interactivity (docs/plan.md
    // Phase 13): a CLEAN slate (storage wiped, first-ever load), both
    // switches ON in `c` BEFORE the walk reaches any decision, then one
    // tab burst runs the whole story. A decision reached during a skip
    // resolves in play order — the first not-yet-played route in manifest
    // order, the CONTINUING route held last — so refuse plays before hire
    // even though hire is first in the manifest, and early before late.
    // early is now the inner `return` route: its end must AUTO-resolve
    // too — a completed return under play-all advances to the next
    // unplayed route without ever surfacing the Return row.
    // `#choice` never surfaces; every route plays once; the aftermath
    // follows. (Phase 16 kept play-all-routes as the NO-PAUSE path: the
    // skip-pauses-at-decisions rule applies without it. The route-start
    // announcements this mode may flash are pills, not timeline, and this
    // step asserts only what the probe and the change log hold.)
    // Fresh slate. OBSERVED once: with the cursor left inside branch
    // content (step 39's landing) the app page still held an IndexedDB
    // connection — one open handle is enough, writes pending or not — the
    // delete only reached `blocked`, and the reload
    // document still had helpSeen — no help screen, and the step died on
    // a bare 5 s wait. So: report which event ended the delete, and if
    // the fresh start did not materialise, wipe once more. Every wait
    // here records instead of crashing.
    const wipeAndReload = async () => {
      await page.goto(pathToFileURL(join(contentDir, "blank.html")).href);
      let outcome = "threw";
      try {
        outcome = await page.evaluate(
          () =>
            new Promise((done) => {
              const rq = indexedDB.deleteDatabase("kinetic");
              rq.onsuccess = () => done("success");
              rq.onerror = () => done("error");
              rq.onblocked = () => done("blocked");
            }),
        );
      } catch {
        /* stays "threw"; the fresh-start check below decides */
      }
      await page.goto(pathToFileURL(join(contentDir, "index.html")).href);
      let helpShown = true;
      try {
        await page.waitForFunction(
          () => document.getElementById("help") !== null,
          { timeout: 4000 },
        );
      } catch {
        helpShown = false;
      }
      console.error(`[40] wipe: ${outcome}, help shown=${String(helpShown)}`);
      return helpShown;
    };
    let s40Fresh = await wipeAndReload();
    if (!s40Fresh) s40Fresh = await wipeAndReload();
    const s40HelpDismissed = s40Fresh ? await dismissHelp(page, cdp) : false;
    let s40ConfigOpened = true;
    try {
      await pressC(cdp);
      await page.waitForFunction(CONFIG_OPEN, { timeout: 5000 });
    } catch {
      s40ConfigOpened = false;
    }
    if (!s40ConfigOpened) {
      const diag = await page.evaluate(() => ({
        help: document.getElementById("help") !== null,
        config: document.getElementById("config") !== null,
        text: document.getElementById("overlay-text")?.textContent ?? null,
        img:
          document.getElementById("visual-image")?.getAttribute("src") ?? null,
      }));
      record(
        "40. Play all routes + skip-all: one burst plays every route (continuing last), no choice ever surfaces, aftermath follows",
        "FAIL",
        `the fresh-slate start never reached the config screen (help shown=${String(s40Fresh)}, dismissed=${String(s40HelpDismissed)}): ${JSON.stringify(diag)}`,
      );
    } else {
      const s40cfg = await page.evaluate(READ_CONFIG_OVERLAY);
      await clickCenter(cdp, s40cfg.skipRect); // skip-all ON: burst the walk
      await clickCenter(cdp, s40cfg.playRect); // play-all-routes ON
      const s40toggled = await page.evaluate(READ_CONFIG_OVERLAY);
      await clickCenter(cdp, s40toggled.titleRect); // backdrop closes
      await page.evaluate(INSTALL_BRANCH_LOG); // a fresh log for the burst
      await pressTab(cdp);
      const s40samples = [];
      const s40start = Date.now();
      let s40reached = false;
      while (Date.now() - s40start < 25000) {
        const line = await page.evaluate(SKIP_PROBE);
        s40samples.push(line);
        if (line.includes(EXPECTED.main024Text)) {
          s40reached = true;
          break;
        }
        await sleep(50);
      }
      await sleep(600); // a trailing overlay or stray advance would still show
      const s40log = await readBranchLog(page);
      const s40closed = await page.evaluate(READ_CHOICE);
      const s40Markers = [
        "bridge-014.jpg",
        "bridge-015.jpg",
        "refuse-019.jpg", // alternates before the continuing route
        EXPECTED.refuse020Text,
        "hire-016.jpg",
        EXPECTED.hire017Text,
        EXPECTED.early022Text, // the inner alternate before its continuing late
        EXPECTED.late021Text,
        EXPECTED.hire018Text, // the rejoin, then the aftermath
        "main-023.jpg",
        EXPECTED.main024Text,
      ];
      const s40Idx = s40Markers.map((marker) =>
        s40log.findIndex((l) => l.includes(marker)),
      );
      const s40OrderOk =
        s40Idx.every((i) => i >= 0) &&
        s40Idx.every((i, k) => k === 0 || i > s40Idx[k - 1]);
      const s40NoChoice =
        !s40samples.some((l) => l.includes("choice-open")) &&
        !s40log.some((l) => l.includes("choice-open")) &&
        s40closed.hidden === true;
      const s40SwitchesOk =
        s40toggled.skipPressed === "true" &&
        s40toggled.playPressed === "true" &&
        (await configOpen(page)) === false;
      const s40Ok =
        s40HelpDismissed &&
        s40SwitchesOk &&
        s40reached &&
        s40OrderOk &&
        s40NoChoice;
      const s40OrderText = s40Markers
        .map((marker, i) => `${marker}@${s40Idx[i]}`)
        .join(" ");
      record(
        "40. Play all routes + skip-all: one burst plays every route (continuing last), no choice ever surfaces, aftermath follows",
        s40Ok ? "PASS" : "FAIL",
        `clean slate (storage wiped, help dismissed=${String(s40HelpDismissed)}), skip-all=${String(s40toggled.skipPressed)} play-all-routes=${String(s40toggled.playPressed)} set in c BEFORE the walk, then one tab press ran everything: observed play order ${JSON.stringify(s40OrderText)} — strictly increasing=${String(s40OrderOk)}, so refuse-019 played BEFORE hire-016 and early-022 BEFORE late-021 (auto-pick = first unplayed route in manifest order, the continuing route LAST — engine nextAutoRoute, pinned by branches.test.ts), and the aftermath main-023 followed every route; #choice never opened across ${String(s40samples.length)} samples and the whole change log=${String(s40NoChoice)}; the burst ended on the closing line=${String(s40reached)}`,
      );
    }

    // 41. Console stayed empty through the WHOLE run, branch steps
    // included (it was already checked at 33, before them; step 42 re-reads
    // the same arrays after its own work).
    const s41Ok = consoleMessages.length === 0 && pageErrors.length === 0;
    record(
      "41. console stayed empty throughout the whole run, branch steps included",
      s41Ok ? "PASS" : "FAIL",
      s41Ok
        ? "zero console messages, zero page errors, every page, whole run — including the decision overlays, the nested decision, the rejoin, the e-jump into the never-taken route, the resume inside branch content, and the play-all skip burst"
        : `console=[${consoleMessages.join(" | ")}] pageErrors=[${pageErrors.join(" | ")}]`,
    );

    // 42. The Phase 14 durability walk: a bookmark on a clean slate, and a
    // reload issued the INSTANT its confirmation appears — nothing waits in
    // between. That is exactly where the old 250 ms debounce lost the
    // position: the state write had not been issued yet, and a transaction
    // opened at pagehide is not promised a commit (docs/progress.md Phase
    // 14). The pill is now the commit of BOTH writes (main.ts), so "reload
    // when the pill shows" is the fastest sequence a reader can perform —
    // and the step asserts the whole pair: the reload resumes on the
    // bookmarked item, and the newest `t` row leads back to it too.
    let s42Fresh = await wipeAndReload();
    if (!s42Fresh) s42Fresh = await wipeAndReload();
    const s42HelpDismissed = s42Fresh ? await dismissHelp(page, cdp) : false;
    // Walk to window-004 (item 3). The machine is MANUAL on a fresh slate,
    // so one press is exactly one item (Phase 16), and nothing advances on
    // its own between the presses.
    let s42Walked = false;
    for (let move = 0; move < 6 && !s42Walked; move += 1) {
      const at = await page.evaluate(PAGE_STATE);
      if ((at.imgSrc ?? "").includes("window-004.jpg")) s42Walked = true;
      else await stepForward(cdp);
    }
    const s42at = await page.evaluate(PAGE_STATE);
    const s42atOk =
      s42at.imgSrc === "window-004.jpg" &&
      s42at.speaker === "Theo" &&
      s42at.text === EXPECTED.windowText;
    await pressB(cdp);
    let s42Flashed = true;
    try {
      await page.waitForFunction(flashShown, { timeout: 5000 });
    } catch {
      s42Flashed = false;
    }
    // No sleep here, and no read either: the reload is the very next thing
    // the driver does after the pill (the stored bookmark is read back from
    // the NEW document, so even that IndexedDB open waits).
    const s42flashSeenAt = Date.now();
    await page.reload();
    const s42flashToLoadMs = Date.now() - s42flashSeenAt;
    let s42Painted = true;
    try {
      await page.waitForFunction(
        () =>
          (document.getElementById("visual-image")?.getAttribute("src") ??
            "") !== "",
        { timeout: 5000 },
      );
    } catch {
      s42Painted = false;
    }
    const s42resumed = await page.evaluate(PAGE_STATE);
    const s42stored = await page.evaluate(READ_BOOKMARKS);
    const s42resumeOk =
      s42Painted &&
      s42resumed.imgSrc === "window-004.jpg" &&
      s42resumed.speaker === "Theo" &&
      s42resumed.text === EXPECTED.windowText &&
      s42resumed.helpOpen === false &&
      s42resumed.stageHidden === false;
    // `t`, then the newest row (the only one on this slate): the restore
    // goes through the ctx the bookmark captured and lands on that item.
    await pressT(cdp);
    let s42PanelOpen = true;
    try {
      await page.waitForFunction(OVERLAY_OPEN, { timeout: 5000 });
    } catch {
      s42PanelOpen = false;
    }
    const s42list = await page.evaluate(READ_BOOKMARK_OVERLAY);
    const s42entries = s42list.entries ?? [];
    const s42newest = s42entries[s42entries.length - 1];
    let s42clicked = false;
    if (s42newest?.rect) {
      await clickAt(
        cdp,
        Math.round((s42newest.rect.left + s42newest.rect.right) / 2),
        Math.round((s42newest.rect.top + s42newest.rect.bottom) / 2),
      );
      s42clicked = true;
      try {
        await page.waitForFunction(OVERLAY_CLOSED, { timeout: 5000 });
      } catch {
        s42clicked = false;
      }
    }
    const s42after = await page.evaluate(PAGE_STATE);
    const s42ConsoleClean =
      consoleMessages.length === 0 && pageErrors.length === 0;
    const s42Ok =
      s42Fresh &&
      s42HelpDismissed &&
      s42Walked &&
      s42atOk &&
      s42Flashed &&
      s42stored.length === 1 &&
      s42stored[0]?.itemIndex === 3 &&
      s42resumeOk &&
      s42PanelOpen &&
      s42entries.length === 1 &&
      s42clicked &&
      s42after.imgSrc === "window-004.jpg" &&
      s42after.text === EXPECTED.windowText &&
      s42after.bookmarksOpen === false &&
      s42ConsoleClean;
    record(
      "42. b then an immediate reload: the resume is the bookmarked item, and its t row agrees (Phase 14)",
      s42Ok ? "PASS" : "FAIL",
      `clean slate (help dismissed=${String(s42HelpDismissed)}), walked to item 3 ${JSON.stringify(s42at.imgSrc)}=${String(s42atOk)}, b -> the "Bookmarked" pill (the commit of the bookmark AND the state write) -> reload with NOTHING in between (pill -> new document load took ${String(s42flashToLoadMs)} ms — the window the old 250 ms debounce lost): the page came back on ${JSON.stringify(s42resumed.imgSrc)} / ${JSON.stringify(s42resumed.text)}=${String(s42resumeOk)}, the position being committed before the pill appeared, and the help stayed closed=${String(s42resumed.helpOpen === false)}; IndexedDB holds ${String(s42stored.length)} bookmark at item ${String(s42stored[0]?.itemIndex)}, and clicking that newest row in the t list=${String(s42clicked)} left the screen on ${JSON.stringify(s42after.imgSrc)} / ${JSON.stringify(s42after.text)} (the ctx restore re-enters the same item); console still empty=${String(s42ConsoleClean)}`,
    );

    // ---- Phase 15: the minPlaySeconds chain-exit floor (docs/plan.md
    // Phase 15). The fixture's chain — `stroll-025` (a ~6 s video carrying
    // the first line, `minPlaySeconds: 4.5`), then `line-026`, `line-027` —
    // sits between the range items and the branch lead-in, so the next
    // unseen item past the step-42 walk's frontier is a plain forward step
    // away in array order and `e`, which walks the frontier one unseen item
    // per press (the landing marks its item seen), is the robust route to
    // the chain head. Navigation fires no decision along the way.

    // 43. auto advance honors the floor: the visual past the chain changes
    // no earlier than 4.5 s after the video item became current — the
    // dialogue advancing at reading speed UNDER the video the whole time —
    // where the two dialogue holds alone come to ~3 s.
    let s43ChainStart = null;
    for (let i = 0; i < 30 && s43ChainStart === null; i += 1) {
      await pressE(cdp);
      const tArrive = Date.now(); // after the handler ran: the machine's
      // chain-head instant is this or a hair earlier, never later
      if (await page.evaluate(ON_TEXT, EXPECTED.strollText)) {
        s43ChainStart = tArrive;
      } else {
        await sleep(40);
      }
    }
    const s43Arrived = await page.evaluate(CHAIN_PROBE);
    // Phase 16's manual press always MOVES, so the in-place settle this
    // step needs is the AUTO-mode press (two-stage kept): a lands first,
    // its press ends the chain head's wait where it stands, and one more
    // press steps on — the shape the floor measurement wants, exactly as
    // before, now walked with the new semantics.
    await pressA(cdp); // auto ON — the floor governs auto advance
    await pressSpace(cdp); // the auto-mode press settles the video in place
    const s43Settled = await page.evaluate(CHAIN_PROBE);
    await pressSpace(cdp); // the settled item steps on; auto takes the chain
    const s43MovedAt = Date.now();
    const s43sigs = [];
    let s43BridgeAt = null;
    const s43Until = Date.now() + 9000;
    while (Date.now() < s43Until) {
      const sig = await page.evaluate(CHAIN_PROBE);
      s43sigs.push([Date.now(), sig]);
      if (sig.includes("bridge-014.jpg")) {
        s43BridgeAt = Date.now();
        break;
      }
      await sleep(60);
    }
    const s43Idx = (needle) =>
      s43sigs.findIndex(([, sig]) => sig.includes(needle));
    const s43Line26At = s43Idx(EXPECTED.line026Text);
    const s43Line27At = s43Idx(EXPECTED.line027Text);
    const s43Wall = s43BridgeAt === null ? -1 : s43BridgeAt - s43ChainStart;
    const s43TextWall = s43BridgeAt === null ? -1 : s43BridgeAt - s43MovedAt;
    const s43PlayingUnderText =
      s43Line26At >= 0 &&
      s43sigs[s43Line26At][1].includes("stroll-025.mp4|playing") &&
      s43Line27At >= 0 &&
      s43sigs[s43Line27At][1].includes("stroll-025.mp4|playing");
    const s43Ok =
      s43ChainStart !== null &&
      s43Arrived.includes("stroll-025.mp4") &&
      s43Settled.includes(EXPECTED.strollText) &&
      s43Line26At >= 0 &&
      s43Line27At > s43Line26At && // the dialogue advanced during the video
      s43PlayingUnderText &&
      s43BridgeAt !== null && // the visual left the chain at all
      s43Wall >= 4400; // not the ~3 s two-line text sum
    await pressA(cdp); // auto back OFF for the step below
    record(
      "43. minPlaySeconds floor: auto exits the chain at ~4.5 s, not the text sum; dialogue plays under the video",
      s43Ok ? "PASS" : "FAIL",
      `e walked the unseen frontier to the chain head (stroll-025.mp4=${String(s43Arrived.includes("stroll-025.mp4"))}), a + space settled the video item in place — the AUTO-mode press, since a manual press now steps (Phase 16) (still its line=${String(s43Settled.includes(EXPECTED.strollText))}) — then a + space let AUTO drive the chain: ${JSON.stringify(EXPECTED.line026Text)} came at +${String(s43Line26At >= 0 ? s43sigs[s43Line26At][0] - s43ChainStart : -1)}ms and ${JSON.stringify(EXPECTED.line027Text)} at +${String(s43Line27At >= 0 ? s43sigs[s43Line27At][0] - s43ChainStart : -1)}ms, both with the video still PLAYING beneath them=${String(s43PlayingUnderText)} (the chain does not stall the media); the visual then changed past the chain at +${String(s43Wall)}ms from the video becoming current=${String(s43Wall >= 4400)} — the floor, not the two dialogue holds (~${String(s43TextWall)}ms from the chain's first auto step, and even less without the settle) — and the machine landed on bridge-014=${String(s43BridgeAt !== null)}; auto turned back off after`,
    );

    // 44. skip stays immediate THROUGH the chain: wheel back before it, one
    // tab burst walks the video poster and both lines and leaves the chain
    // in plain dwells — no floor re-entry wait anywhere (the corrected
    // machine never applies the floor to skip; the re-based chain head from
    // the wheel re-entry would otherwise cost ~4.5 s AGAIN).
    const s44BeforeChain = await wheelUntil(page, cdp, true, ON_PART_013);
    const s44TabAt = Date.now();
    await pressTab(cdp);
    const s44sigs = [];
    let s44BridgeAt = null;
    const s44Until = Date.now() + 4000;
    while (Date.now() < s44Until) {
      const sig = await page.evaluate(CHAIN_PROBE);
      s44sigs.push([Date.now(), sig]);
      if (sig.includes("bridge-014.jpg")) {
        s44BridgeAt = Date.now();
        break;
      }
      await sleep(30);
    }
    await pressTab(cdp); // leave skip: the item left under the cursor holds
    const s44Idx = (needle) =>
      s44sigs.findIndex(([, sig]) => sig.includes(needle));
    const s44StrollAt = s44Idx(EXPECTED.strollText);
    const s44Line26At = s44Idx(EXPECTED.line026Text);
    const s44Line27At = s44Idx(EXPECTED.line027Text);
    const s44ChainEnd =
      s44BridgeAt === null ? s44sigs.length : s44Idx("bridge-014.jpg");
    const s44PosterOnly =
      s44StrollAt >= 0 &&
      s44Line26At > s44StrollAt &&
      s44Line27At > s44Line26At &&
      s44sigs
        .slice(s44StrollAt, s44ChainEnd)
        .every(([, sig]) => !sig.includes("playing")); // skip shows posters, never plays
    const s44Wall = s44BridgeAt === null ? -1 : s44BridgeAt - s44TabAt;
    const s44HeadWall =
      s44BridgeAt === null || s44StrollAt < 0
        ? -1
        : s44BridgeAt - s44sigs[s44StrollAt][0];
    const s44ConsoleClean =
      consoleMessages.length === 0 && pageErrors.length === 0;
    const s44Ok =
      s44BeforeChain &&
      s44StrollAt >= 0 &&
      s44Line26At > s44StrollAt &&
      s44Line27At > s44Line26At &&
      s44PosterOnly &&
      s44BridgeAt !== null &&
      s44Wall < 1500 && // three dwells + one, not the floor's 4.5 s
      s44HeadWall < 1200 && // from the chain head: leaving waited nothing
      s44ConsoleClean;
    record(
      "44. skip through the floor chain stays immediate: poster + both lines + exit in a few dwells",
      s44Ok ? "PASS" : "FAIL",
      `wheeled back to part-013=${String(s44BeforeChain)} (before the chain), one tab walked the whole chain: ${JSON.stringify(EXPECTED.strollText)} at +${String(s44StrollAt >= 0 ? s44sigs[s44StrollAt][0] - s44TabAt : -1)}ms, ${JSON.stringify(EXPECTED.line026Text)} at +${String(s44Line26At >= 0 ? s44sigs[s44Line26At][0] - s44TabAt : -1)}ms, ${JSON.stringify(EXPECTED.line027Text)} at +${String(s44Line27At >= 0 ? s44sigs[s44Line27At][0] - s44TabAt : -1)}ms — all on the poster still, nothing playing=${String(s44PosterOnly)} — and bridge-014 followed at +${String(s44Wall)}ms from the tab press (from the chain's head: ${String(s44HeadWall)}ms)=${String(s44Wall >= 0 && s44Wall < 1500)}: ${String(120)}ms dwells only, the chain-exit floor (4.5 s from this fresh re-entry, which step 43's auto exit honored) applies to NO skip step; tab again left skip; the console stayed empty through both steps=${String(s44ConsoleClean)}`,
    );

    // ---- Phase 16: the navigation rules the second round of demo
    // feedback produced, walked on their own (steps 45-47).

    // 45. One-press navigation proof (strict 1:1), on a PRIVATE fresh
    // page (its own storage: a first-ever load, help dismissed) so nothing
    // the main walk stored can blur the count. Manual is the default: one
    // press moves exactly one item (press 1: lantern), and three quick
    // presses move exactly THREE items (lantern -> sunset -> window ->
    // spark) — not the one-and-a-half a settle-then-move pair would give.
    // One wheel notch then steps exactly one item in each direction (back
    // onto window-004, forward onto spark-005 again). The page and its
    // context close right after: a lingering tab would block step 47's
    // storage wipe (the verify-step-40 IDB lesson).
    const s45Console = [];
    const s45Errors = [];
    {
      const context45 = await browser.createBrowserContext();
      const page45 = await context45.newPage();
      page45.on("console", (msg) =>
        s45Console.push(`step45 [${msg.type()}] ${msg.text()}`),
      );
      page45.on("pageerror", (err) => s45Errors.push(`step45 ${err.message}`));
      try {
        await page45.goto(pathToFileURL(join(contentDir, "index.html")).href);
        const cdp45 = await page45.createCDPSession();
        await dismissHelpByKeyboard(page45); // first-ever load: help, then item 1
        await waitImageDecoded(page45);
        const s45start = await page45.evaluate(PAGE_STATE);
        await stepForward(cdp45); // one press = one item
        await waitImageDecoded(page45);
        const s45one = await page45.evaluate(PAGE_STATE);
        for (let i = 0; i < 3; i += 1) {
          await stepForward(cdp45);
          await sleep(40);
        }
        await waitImageDecoded(page45);
        const s45three = await page45.evaluate(PAGE_STATE);
        await wheel(cdp45, true, 1); // one notch back = one item
        const s45back = await page45.evaluate(PAGE_STATE);
        await wheel(cdp45, false, 1); // one notch forward = one item
        const s45fwd = await page45.evaluate(PAGE_STATE);
        const spark = /^spark-005\.f\d{3}\.jpg$/;
        const s45Ok =
          s45start.imgSrc === "meadow-001.jpg" &&
          s45start.text === EXPECTED.meadowText &&
          s45one.imgSrc === "lantern-002.jpg" &&
          s45one.text === EXPECTED.lanternText &&
          spark.test(s45three.imgSrc ?? "") &&
          s45three.text === EXPECTED.sparkText &&
          s45back.imgSrc === "window-004.jpg" &&
          s45back.text === EXPECTED.windowText &&
          spark.test(s45fwd.imgSrc ?? "") &&
          s45fwd.text === EXPECTED.sparkText &&
          s45Console.length === 0 &&
          s45Errors.length === 0;
        record(
          "45. one-press advance, strict 1:1 (Phase 16): one press = one item, three presses = three items, one wheel notch = one step both directions",
          s45Ok ? "PASS" : "FAIL",
          `private first-ever page, manual by default: item 1 (${JSON.stringify(s45start.imgSrc)}) + 1 press -> ${JSON.stringify(s45one.imgSrc)}=${String(s45one.imgSrc === "lantern-002.jpg")} (its line=${String(s45one.text === EXPECTED.lanternText)}); 3 quick presses -> ${JSON.stringify(s45three.imgSrc)}=${String(spark.test(s45three.imgSrc ?? ""))} — exactly items 2, 3, 4, not the item ~2 a two-press-per-move world would give; wheel up 1 notch -> ${JSON.stringify(s45back.imgSrc)} (its line=${String(s45back.text === EXPECTED.windowText)}), wheel down 1 notch -> ${JSON.stringify(s45fwd.imgSrc)} (its line=${String(s45fwd.text === EXPECTED.sparkText)}): one notch = one step, forward and back; console=${String(s45Console.length)} errors=${String(s45Errors.length)}; the page and its storage context closed after`,
        );
      } finally {
        await page45.close();
        await context45.close();
      }
    }

    // 46. Decisions surface on navigation (docs/plan.md Phase 16): on the
    // main page, where step 44's skip burst stopped at bridge-014 and the
    // outer decision is UNRESOLVED. One press moves onto bridge-015 (its
    // settle, not its arrival, is what fires), so #choice is still shut;
    // wheeling off and back is a NAV arrival — and the arrival now SHOWS
    // the overlay without consuming the decision; wheeling away closes it.
    // Tab then skips INTO the decision and PAUSES there with the overlay
    // up — the burst ends instead of sweeping past. Picking `refuse`
    // resumes MANUAL (no skip resume), the ending plays, and its re-offer
    // carries the Return row (reusing the flow step 35 pins, kept short:
    // the row plus Enter onto main-023 proves the ending-loop is escapable).
    await page.bringToFront(); // step 45's context tab took the foreground
    const s46start = await page.evaluate(PAGE_STATE);
    await stepForward(cdp); // bridge-014 -> bridge-015: an ADVANCE arrival
    const s46arr = await page.evaluate(PAGE_STATE);
    const s46arrNoView =
      s46arr.imgSrc === "bridge-015.jpg" && (await choiceOpen(page)) === false;
    await wheel(cdp, true, 1); // navigation away
    await wheel(cdp, false, 1); // navigation BACK onto the after item: view
    const s46wheel = await page.evaluate(PAGE_STATE);
    const s46wheelChoice = await page.evaluate(READ_CHOICE);
    const s46WheelOk =
      s46wheel.imgSrc === "bridge-015.jpg" &&
      s46wheelChoice.hidden === false &&
      s46wheelChoice.prompt === EXPECTED.outerPrompt &&
      s46wheelChoice.rows.length === 2 && // no route played: no Return yet
      s46wheelChoice.rows.every((r) => r.seen === null && !r.isContinue);
    await wheel(cdp, true, 1); // leaving closes the view, stack untouched
    const s46closed = await choiceOpen(page);
    const s46TabAt = Date.now();
    await pressTab(cdp); // skip ON: the burst must PAUSE at the decision
    let s46Pause = null;
    let s46PausedAt = -1;
    const s46Until = Date.now() + 2500;
    while (Date.now() < s46Until) {
      const line = await page.evaluate(SKIP_PROBE);
      if (line.includes("choice-open")) {
        s46Pause = line;
        s46PausedAt = Date.now();
        break;
      }
      await sleep(30);
    }
    await sleep(600); // a pause, not a pass-through: still there, overlay up
    const s46Held = await page.evaluate(SKIP_PROBE);
    const s46PauseOk =
      s46Pause?.includes("bridge-015.jpg") === true &&
      s46PausedAt - s46TabAt < 1500 && // dwells, not a hold
      s46Held === s46Pause;
    await pressDigit(cdp, "2"); // pick the ending route FROM the pause
    await page.waitForFunction(CHOICE_CLOSED, { timeout: 5000 });
    const s46refuse = await page.evaluate(PAGE_STATE);
    // Picking never resumes the burst: 1.5 s of manual stillness is the
    // discriminator — a resumed 120 ms skip would have moved ~12 items.
    const s46manualChanges = transitions(
      await sampleSignatures(page, 1500, 75),
    );
    const s46PickOk =
      s46refuse.imgSrc === "refuse-019.jpg" &&
      s46refuse.text === EXPECTED.refuse019Text &&
      s46manualChanges.length === 1;
    await stepForward(cdp); // -> the ending line
    const s46endLine = await page.evaluate(PAGE_STATE);
    await stepForward(cdp); // and one press off the route end re-opens
    let s46reopen = true;
    try {
      await page.waitForFunction(CHOICE_OPEN, { timeout: 5000 });
    } catch {
      s46reopen = false;
    }
    const s46reopenChoice = await page.evaluate(READ_CHOICE);
    const s46ReturnOk =
      s46endLine.text === EXPECTED.refuse020Text &&
      s46reopen &&
      s46reopenChoice.hidden === false &&
      s46reopenChoice.rows.length === 3 &&
      s46reopenChoice.rows[0]?.seen === null &&
      s46reopenChoice.rows[1]?.seen === "seen" &&
      s46reopenChoice.rows[2]?.isContinue === true &&
      s46reopenChoice.rows[2]?.label === CONTINUE_LABEL;
    await pressEnter(cdp); // Return to main route: the loop is escapable
    let s46main = true;
    try {
      await page.waitForFunction(
        (expected) =>
          (document.getElementById("overlay-text")?.textContent ?? "") ===
          expected,
        { timeout: 5000 },
        EXPECTED.main023Text,
      );
    } catch {
      s46main = false;
    }
    const s46Ok =
      s46start.text === EXPECTED.bridge014Text &&
      s46arrNoView &&
      s46closed === false &&
      s46WheelOk &&
      s46PauseOk &&
      s46PickOk &&
      s46ReturnOk &&
      s46main;
    record(
      "46. decisions surface on nav (Phase 16): wheel arrival shows #choice, tab-skip pauses there with the overlay, the pick resumes manual, and an ending's re-offer carries the Return row onto main-023",
      s46Ok ? "PASS" : "FAIL",
      `from ${JSON.stringify(s46start.text)} (step 44's stop) one press arrived on ${JSON.stringify(s46arr.imgSrc)} with #choice still SHUT=${String(s46arrNoView)} (advance arrivals fire on the settle, not the arrival); wheel off and back -> the arrival view opened=${String(s46WheelOk)} prompt=${JSON.stringify(s46wheelChoice.prompt)} rows=${JSON.stringify(s46wheelChoice.rows.map((r) => r.label))} (2 routes, unmarked — showing consumes nothing), and wheeling away closed it=${String(s46closed === false)}; tab ON at +${String(s46PausedAt - s46TabAt)}ms the burst PAUSED on bridge-015 with the overlay=${String(s46PauseOk)} and held it (probe unchanged after 600 ms); digit 2 picked refuse from the pause -> ${JSON.stringify(s46refuse.imgSrc)}, then ${String(s46manualChanges.length - 1)} changes in 1500 ms: manual, no skip resume=${String(s46PickOk)}; off the ending re-opened with ${JSON.stringify(s46reopenChoice.rows.map((r) => [r.label, r.seen]))} — refuse seen-marked, the ${JSON.stringify(CONTINUE_LABEL)} row offered=${String(s46ReturnOk)}; Enter took it onto the main route=${String(s46main)} (the ending-loop is escapable end to end)`,
    );

    // 47. Config's "Reset progress" (docs/plan.md Phase 16): a clean slate
    // walked to ~item 5 (intro-006) and bookmarked, so state exists to
    // lose. The row opens the confirmation box — cancel touches nothing
    // (a reload proves: same resume item, same bookmark row). Confirming
    // IS a fresh boot: help overlay up, item 1 current, the bookmark list
    // empty, and the speed readout back at the default 1.00x.
    let s47Fresh = await wipeAndReload();
    if (!s47Fresh) s47Fresh = await wipeAndReload();
    const s47HelpDismissed = s47Fresh ? await dismissHelp(page, cdp) : false;
    for (let i = 0; i < 5; i += 1) {
      await stepForward(cdp); // one press = one item: item 5 in five
      await sleep(60);
    }
    const s47at = await page.evaluate(PAGE_STATE);
    const s47WalkedOk =
      s47at.video?.poster === "intro-006.poster.jpg" &&
      s47at.video?.visible === true;
    await pressB(cdp);
    let s47Flashed = true;
    try {
      await page.waitForFunction(flashShown, { timeout: 5000 });
    } catch {
      s47Flashed = false;
    }
    await pressC(cdp);
    await page.waitForFunction(CONFIG_OPEN, { timeout: 5000 });
    const s47cfg = await page.evaluate(READ_CONFIG_OVERLAY);
    await clickCenter(cdp, s47cfg.resetRect); // the row opens the box
    const s47box = await page.evaluate(READ_CONFIRM_OVERLAY);
    await clickCenter(cdp, s47box.cancelRect); // cancel: touch nothing
    const s47BoxClosed = (await page.evaluate(CONFIRM_OPEN)) === false;
    // Cancel keeps everything: reload must resume on item 5 with help
    // closed and the bookmark row still in the list.
    await page.reload();
    await sleep(700);
    const s47resume = await page.evaluate(PAGE_STATE);
    await pressT(cdp);
    await page.waitForFunction(OVERLAY_OPEN, { timeout: 5000 });
    const s47list = await page.evaluate(READ_BOOKMARK_OVERLAY);
    await pressT(cdp); // close the panel again
    const s47KeptOk =
      s47resume.video?.poster === "intro-006.poster.jpg" &&
      s47resume.helpOpen === false &&
      s47list.hidden === false &&
      s47list.entries.length === 1 &&
      s47list.entries[0]?.itemIndex === 5;
    // Reset again, confirmed this time: delete + reload is the app's own
    // path; the fresh boot must show the help and item 1.
    await pressC(cdp);
    await page.waitForFunction(CONFIG_OPEN, { timeout: 5000 });
    const s47cfg2 = await page.evaluate(READ_CONFIG_OVERLAY);
    await clickCenter(cdp, s47cfg2.resetRect);
    const s47box2 = await page.evaluate(READ_CONFIRM_OVERLAY);
    await clickCenter(cdp, s47box2.resetRect); // the box's own Reset
    let s47BootHelp = true;
    try {
      await page.waitForFunction(HELP_OPEN, { timeout: 6000 });
    } catch {
      s47BootHelp = false;
    }
    await sleep(400); // the reload lands; nothing may move behind the help
    const s47boot = await page.evaluate(PAGE_STATE);
    await pressEnter(cdp); // close the help: the fresh profile's first key
    await page.waitForFunction(HELP_CLOSED, { timeout: 5000 });
    await pressT(cdp);
    await page.waitForFunction(OVERLAY_OPEN, { timeout: 5000 });
    const s47list2 = await page.evaluate(READ_BOOKMARK_OVERLAY);
    await pressT(cdp);
    await pressC(cdp);
    await page.waitForFunction(CONFIG_OPEN, { timeout: 5000 });
    const s47cfg3 = await page.evaluate(READ_CONFIG_OVERLAY);
    await pressC(cdp); // close; the run is over
    const s47BootOk =
      s47boot.helpOpen === true &&
      s47boot.stageHidden === true &&
      s47boot.imgSrc === "meadow-001.jpg" &&
      s47boot.text === EXPECTED.meadowText;
    const s47EmptyOk =
      s47list2.entries.length === 0 &&
      s47list2.emptyText === "No bookmarks yet — press b";
    const s47DefaultOk =
      s47cfg3.speedValue === "1.00x — ~60 ms/char" &&
      s47cfg3.skipPressed === "false" &&
      s47cfg3.playPressed === "false";
    const s47Ok =
      s47HelpDismissed &&
      s47WalkedOk &&
      s47Flashed &&
      s47box.hidden === false &&
      s47box.title === "Reset progress" &&
      s47box.resetLabel === "Reset" &&
      s47box.cancelLabel === "Cancel" &&
      s47BoxClosed &&
      s47KeptOk &&
      s47box2.hidden === false &&
      s47BootHelp &&
      s47BootOk &&
      s47EmptyOk &&
      s47DefaultOk;
    record(
      "47. Reset progress (Phase 16): the box confirms or cancels; cancel keeps everything (reload proves it), confirm is a true first-ever boot — help up, item 1, empty list, 1.00x",
      s47Ok ? "PASS" : "FAIL",
      `clean slate (help dismissed=${String(s47HelpDismissed)}), five presses landed on ${JSON.stringify(s47at.video?.poster)}=${String(s47WalkedOk)}, b bookmarked it (pill=${String(s47Flashed)}); c -> the Reset row opened the box: title=${JSON.stringify(s47box.title)} buttons=${JSON.stringify([s47box.resetLabel, s47box.cancelLabel])}; Cancel closed=${String(s47BoxClosed)} and the reload came back on the SAME item with the row still stored (${JSON.stringify(s47resume.video?.poster)}, entries=${JSON.stringify(s47list.entries.map((e) => e.itemIndex))})=${String(s47KeptOk)} — cancel touched nothing; the second box's Reset ran the app's own delete+reload: help showed again=${String(s47BootHelp)} on item 1 (${JSON.stringify(s47boot.imgSrc)}, stage black=${String(s47boot.stageHidden)})=${String(s47BootOk)}, t says ${JSON.stringify(s47list2.emptyText)} with ${String(s47list2.entries.length)} entries=${String(s47EmptyOk)}, and c reads ${JSON.stringify(s47cfg3.speedValue)} skip=${String(s47cfg3.skipPressed)} play=${String(s47cfg3.playPressed)}=${String(s47DefaultOk)} — the full first-ever-play experience restored`,
    );
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => r.status === "FAIL").length;
  const partial = results.filter((r) => r.status === "PARTIAL").length;
  console.log(
    `\n${results.length} steps: ${results.length - failed - partial} pass, ${partial} partial, ${failed} fail`,
  );
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(`FAIL  driver crashed\n      ${String(error)}`);
  process.exitCode = 1;
});
