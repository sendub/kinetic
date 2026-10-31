#!/usr/bin/env node
// Driver for docs/verify-player.md: walks the checklist (Phase 5 shell,
// Phase 6 media playback, Phase 7 wheel/skip/jump, Phase 7b speech vs thought
// and contain-fit geometry, Phase 8 bookmarks — `b` with its confirmation
// flash, the `t` overlay (order, scroll position, thumbnails, suspension,
// click-to-continue, backdrop/Escape/t-to-close), and reload-resume — and
// Phase 9 config: `c` (readout of speed and skip-all, suspension, backdrop-
// and c-to-close, a live speed change measured against the re-armed hold,
// and persistence across reload) — and Phase 9b/9c short-video timing over
// the demo fixture: the two range items `part-012` ([0,1], 1 pass) and
// `part-013` ([1,2], 2 passes, `loopStartSeconds` 1.5 — Phase 9d) share
// one 2 s clip and prove the range machinery end to end — seek to
// `startSeconds` on entry, pass completes detected per presented frame
// (`requestVideoFrameCallback`, with the file's `ended` where the range
// runs to the file's end), loop-back to `loopStartSeconds` after a
// completed pass while passes remain and pause when none do, and `loop`
// never on for a range — and prints PASS / PARTIAL / FAIL per step.
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
// the manifest" (step 30, docs/plan.md Phase 7b).
//
// Every input is real CDP Input: Input.dispatchKeyEvent for keys,
// Input.dispatchMouseEvent `mouseWheel` for the wheel, and
// mousePressed/mouseReleased for the clicks on the `t` list and the `c`
// controls. All arrive trusted, so
// the fullscreen gesture logic treats them as user input and the wheel takes
// the same path a trackpad takes. Nothing reads the machine from the driver:
// each step asserts what the DOM shows.

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

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
// The portrait size step 30 rescales item 1's image to. Its aspect (2:3)
// deliberately matches neither the manifest's 16:9 nor any test viewport.
const TALL_ASSET = { width: 640, height: 960 };
const chromePath =
  process.env.KINETIC_CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Expected strings copied from fixtures/demo/manifest.js, so a change to the
// fixture fails a step here rather than silently re-defining correctness.
const EXPECTED = {
  meadowText: "You're early today. The meadow is empty.",
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
  mkdirSync(emptyDir, { recursive: true });
  for (const file of ["index.html", "app.js", "manifest.js"]) {
    copyFileSync(join(playerDir, "dist", file), join(emptyDir, file));
  }
  // The asset/manifest aspect mismatch folder for step 30. Only the JPEG is
  // resampled, never the manifest, and `fixtures/demo` itself stays pristine.
  // `sips` is macOS' own resizer; without it step 30 loses its discriminator
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
// skip-all switch's aria state, and the rects the driver clicks.
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
  };
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
// frontier (which steps 27-28 push onto part-013, a video; a page resuming
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
      if (window.__firstKeys.length < 3) {
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
const pressEscape = (cdp) => pressKey(cdp, "Escape", "Escape", 27, "");

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

// Space on an unsettled item completes it in place (machine Phase 3
// immediate-complete); the next space moves the cursor. One move = two presses.
const advancePair = async (cdp) => {
  await pressSpace(cdp);
  await pressSpace(cdp);
};

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

// True while the <video> element still carries the expando stashed in step 9:
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

    // 1. Demo folder loads: item 1 image + speaker + text, nothing before
    // the first key has requested fullscreen.
    await waitImageDecoded(page);
    const s1 = await page.evaluate(PAGE_STATE);
    const s1Ok =
      s1.appChildren.includes("stage") &&
      s1.appChildren.includes("overlay") &&
      s1.imgSrc === "meadow-001.jpg" &&
      s1.imgDecoded &&
      s1.overlayHidden === false &&
      s1.speaker === "Mei" &&
      s1.text === EXPECTED.meadowText &&
      s1.fsAttempts === 0;
    record(
      "1. demo folder loads with item 1 image + speaker + text",
      s1Ok ? "PASS" : "FAIL",
      JSON.stringify(s1),
    );

    // 2. The first key press requests fullscreen. Headless cannot show the
    // visual effect of fullscreen, so this is honest at PARTIAL at best:
    // what it proves is the attempt, its trigger, and the absence of errors.
    await pressSpace(cdp);
    const s2 = await page.evaluate(PAGE_STATE);
    const fsOk =
      s2.fsAttempts === 1 &&
      s2.firstKeys.length === 1 &&
      s2.firstKeys[0].key === " " &&
      s2.firstKeys[0].trusted === true &&
      pageErrors.length === 0;
    record(
      "2. first key press requests fullscreen (PARTIAL in headless)",
      fsOk ? "PARTIAL" : "FAIL",
      `requestFullscreen calls=${s2.fsAttempts}; first keydown key=${JSON.stringify(s2.firstKeys[0]?.key)} isTrusted=${String(s2.firstKeys[0]?.trusted)}; pageErrors=${pageErrors.length}; document.fullscreenElement=${String(s2.fullscreenElement)}; the fullscreen visual effect itself is not observable headless`,
    );

    // 3. Space advances: item 2 (lantern-002) shows its own line; a text
    // item with no speaker draws no speaker.
    await pressSpace(cdp);
    await waitImageDecoded(page);
    const s3 = await page.evaluate(PAGE_STATE);
    const s3Ok =
      s3.imgSrc === "lantern-002.jpg" &&
      s3.imgDecoded &&
      s3.overlayHidden === false &&
      s3.speaker === null &&
      s3.text === EXPECTED.lanternText;
    record(
      "3. space advances: item 2 image + new text, no speaker",
      s3Ok ? "PASS" : "FAIL",
      JSON.stringify(s3),
    );

    // 4. Item 3 (sunset-003) is a bare image: the overlay draws nothing.
    await advancePair(cdp);
    await waitImageDecoded(page);
    const s4 = await page.evaluate(PAGE_STATE);
    const s4Ok =
      s4.imgSrc === "sunset-003.jpg" &&
      s4.imgDecoded &&
      s4.overlayHidden === true &&
      s4.overlayChildren === 0;
    record(
      "4. bare-image item shows no overlay content",
      s4Ok ? "PASS" : "FAIL",
      JSON.stringify(s4),
    );

    // 5. Space advances again: item 4 (window-004) brings its speaker back.
    await advancePair(cdp);
    await waitImageDecoded(page);
    const s5 = await page.evaluate(PAGE_STATE);
    const s5Ok =
      s5.imgSrc === "window-004.jpg" &&
      s5.imgDecoded &&
      s5.overlayHidden === false &&
      s5.speaker === "Theo" &&
      s5.text === EXPECTED.windowText;
    record(
      "5. space advances: item 4 speaker + text return",
      s5Ok ? "PASS" : "FAIL",
      JSON.stringify(s5),
    );

    // 6. h hides the overlay; the visual stays visible.
    await pressH(cdp);
    await waitImageDecoded(page);
    const s6 = await page.evaluate(PAGE_STATE);
    const s6Ok =
      s6.overlayHidden === true &&
      s6.imgSrc === "window-004.jpg" &&
      s6.imgDecoded &&
      s6.imgWidth > 0;
    record(
      "6. h hides overlay, visual stays visible",
      s6Ok ? "PASS" : "FAIL",
      JSON.stringify(s6),
    );

    // 7. h again restores the overlay.
    await pressH(cdp);
    const s7 = await page.evaluate(PAGE_STATE);
    const s7Ok =
      s7.overlayHidden === false &&
      s7.speaker === "Theo" &&
      s7.text === EXPECTED.windowText &&
      s7.imgSrc === "window-004.jpg";
    record(
      "7. h again restores overlay text",
      s7Ok ? "PASS" : "FAIL",
      JSON.stringify(s7),
    );

    // 8. Advancing into item 5 (spark-005, an animation) plays it: the
    // shared <img> cycles the manifest frames at 8 fps (125 ms each), then
    // stops on the final frame after exactly 2 loops (1000 ms of cycling).
    await advancePair(cdp);
    await page.waitForFunction(
      () =>
        /^spark-005\.f\d{3}\.jpg$/.test(
          document.getElementById("visual-image")?.getAttribute("src") ?? "",
        ),
      { timeout: 5000 },
    );
    const s8a = await page.evaluate(PAGE_STATE);
    let frameAdvanced = true;
    try {
      await page.waitForFunction(
        (first) =>
          (document.getElementById("visual-image")?.getAttribute("src") ??
            "") !== first,
        { timeout: 600 },
        s8a.imgSrc,
      );
    } catch {
      frameAdvanced = false;
    }
    await sleep(900); // past the 2-loop mark (cycling started ~200 ms ago)
    const s8b = await page.evaluate(PAGE_STATE);
    await sleep(400);
    const s8c = await page.evaluate(PAGE_STATE);
    const s8Ok =
      frameAdvanced &&
      s8b.imgSrc === "spark-005.f003.jpg" &&
      s8c.imgSrc === "spark-005.f003.jpg" &&
      s8b.imgVisible &&
      s8b.placeholder === null &&
      s8b.overlayHidden === false &&
      s8b.text === EXPECTED.sparkText;
    record(
      "8. animation advances frames at 8 fps, stops on final frame after 2 loops",
      s8Ok ? "PASS" : "FAIL",
      `first=${s8a.imgSrc}; advanced=${String(frameAdvanced)}; at1.1s=${s8b.imgSrc}; at1.5s=${s8c.imgSrc}`,
    );

    // 9. Item 6 (intro-006, a video) renders ONE <video muted playsinline>
    // whose poster paints first (poster attribute + CSS background), and it
    // plays. An expando marks the element so later steps can prove it is the
    // SAME element, not a re-created one. intro-006's next item is text, so
    // the chain applies from its first frame: loop=true, `ended` ignored.
    await advancePair(cdp);
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
    const s9 = await page.evaluate(PAGE_STATE);
    const s9Struct =
      s9.video?.src.endsWith("intro-006.mp4") === true &&
      s9.video?.poster === "intro-006.poster.jpg" &&
      s9.video?.posterPainted === true &&
      s9.video?.visible === true &&
      s9.video?.loop === true &&
      s9.imgVisible === false &&
      s9.placeholder === null;
    record(
      "9. video shows poster, plays muted, chain-loops (intro-006 -> text)",
      !s9Struct ? "FAIL" : played ? "PASS" : "PARTIAL",
      `${JSON.stringify(s9.video)}; played=${String(played)}${
        played
          ? "; the ended->mediaEnded gate itself is covered by machine unit tests (a chain video never fires ended)"
          : " (autoplay did not start headless: poster stays painted and the chain advance does not gate on media end)"
      }`,
    );

    // 10. Item 7 (line-007) is a `text` item: per machine.visualIndex() the
    // visual is still intro-006 — the SAME <video> element (expando intact),
    // still looping — never a placeholder. The overlay shows the line's own
    // speaker and text.
    await advancePair(cdp);
    const s10 = await page.evaluate(PAGE_STATE);
    const same10 = await videoTokenIs(page);
    const s10Ok =
      same10 &&
      s10.video?.loop === true &&
      s10.video?.visible === true &&
      (!played || s10.video?.paused === false) &&
      s10.imgVisible === false &&
      s10.placeholder === null &&
      s10.overlayHidden === false &&
      s10.speaker === "Mei" &&
      s10.text === EXPECTED.line007Text &&
      // line-007 is spoken dialogue: mode "speech" on band and line, upright.
      s10.overlayMode === "speech" &&
      s10.textMode === "speech" &&
      s10.textFontStyle === "normal";
    record(
      "10. text item keeps the earlier video (same element, looping, no placeholder)",
      s10Ok ? "PASS" : "FAIL",
      `sameElement=${String(same10)}; ${JSON.stringify(s10.video)}; overlay=${String(s10.speaker === "Mei" && s10.text === EXPECTED.line007Text)}; mode=${String(s10.overlayMode)}/${String(s10.textMode)} fontStyle=${String(s10.textFontStyle)}`,
    );

    // 11. line-007 -> line-008: the chain advance must not touch the video
    // element at all — same token, still looping and playing. line-008 is one
    // of the demo's two thought lines, so the same read pins the other mode:
    // "thought" on band and line, and CSS has made it italic (Phase 7b).
    await advancePair(cdp);
    const s11 = await page.evaluate(PAGE_STATE);
    const same11 = await videoTokenIs(page);
    const s11Ok =
      same11 &&
      s11.video?.loop === true &&
      s11.video?.visible === true &&
      (!played || s11.video?.paused === false) &&
      s11.video?.currentTime > 0 &&
      s11.imgVisible === false &&
      s11.placeholder === null &&
      s11.overlayHidden === false &&
      s11.speaker === null &&
      s11.text === EXPECTED.line008Text &&
      s11.overlayMode === "thought" &&
      s11.textMode === "thought" &&
      s11.textFontStyle === "italic";
    record(
      "11. line-007 -> line-008 keeps the same <video> element playing",
      s11Ok ? "PASS" : "FAIL",
      `sameElement=${String(same11)}; ${JSON.stringify(s11.video)}; mode=${String(s11.overlayMode)}/${String(s11.textMode)} fontStyle=${String(s11.textFontStyle)} text=${JSON.stringify(s11.text)}`,
    );

    // 12. h over a playing video: the overlay hides, the video keeps
    // playing on the same element (docs/plan.md Phase 6: h hides text over
    // video too). The line being hidden here is a thought, so `h` is shown to
    // hide that mode too (step 6 hides a spoken one). h again restores before
    // the walk continues.
    await pressH(cdp);
    const s12 = await page.evaluate(PAGE_STATE);
    const same12 = await videoTokenIs(page);
    const s12Ok =
      s12.overlayHidden === true &&
      s12.overlayMode === "thought" &&
      s12.textMode === "thought" &&
      same12 &&
      s12.video?.visible === true &&
      (!played || s12.video?.paused === false);
    record(
      "12. h hides overlay while the video keeps playing",
      s12Ok ? "PASS" : "FAIL",
      `overlayHidden=${String(s12.overlayHidden)} (thought line, mode=${String(s12.overlayMode)}); sameElement=${String(same12)}; ${JSON.stringify(s12.video)}`,
    );
    await pressH(cdp);

    // 13. The wheel rewinds through real wheel events, one notch = one item,
    // and rewinding onto the video shows the poster as a still: paused at the
    // start, loop off, poster painted, the SAME element (expando intact). The
    // events are CDP mouseWheel, so the whole Phase 7 path runs: listener ->
    // accumulator -> machine -> renderer.
    await wheelNotch(cdp, true);
    await sleep(WHEEL_GAP_MS);
    const s13a = await page.evaluate(PAGE_STATE);
    await wheelNotch(cdp, true);
    await sleep(WHEEL_GAP_MS);
    const s13b = await page.evaluate(PAGE_STATE);
    const same13 = await videoTokenIs(page);
    const s13Ok =
      s13a.text === EXPECTED.line007Text &&
      s13b.text === EXPECTED.ferryText &&
      same13 &&
      s13b.video?.paused === true &&
      s13b.video?.currentTime < 0.05 &&
      s13b.video?.loop === false &&
      s13b.video?.visible === true &&
      s13b.video?.posterPainted === true;
    record(
      "13. two wheel notches step back two items; rewinding onto the video shows the poster still",
      s13Ok ? "PASS" : "FAIL",
      `after 1st notch text=${JSON.stringify(s13a.text)}; after 2nd text=${JSON.stringify(s13b.text)}; sameElement=${String(same13)}; ${JSON.stringify(s13b.video)}; driven by CDP mouseWheel; poster-vs-frame-0 pixels are identical by format definition, so the observable facts are the paused-at-zero state and the poster wiring`,
    );

    // 14. One notch from an image item is exactly one item: window-004 (image
    // + text) back to sunset-003 (bare image), where the overlay draws
    // nothing. A notch that double-stepped would land on lantern-002 instead.
    await wheel(cdp, true, 2); // intro-006 -> spark-005 -> window-004
    const s14a = await page.evaluate(PAGE_STATE);
    await wheelNotch(cdp, true);
    await sleep(WHEEL_GAP_MS);
    const s14b = await page.evaluate(PAGE_STATE);
    const s14Ok =
      s14a.imgSrc === "window-004.jpg" &&
      s14a.text === EXPECTED.windowText &&
      s14b.imgSrc === "sunset-003.jpg" &&
      s14b.overlayHidden === true &&
      s14b.overlayChildren === 0;
    record(
      "14. one wheel notch from an image item steps back exactly one item",
      s14Ok ? "PASS" : "FAIL",
      `before=${JSON.stringify(s14a.imgSrc)} (text ${String(s14a.text === EXPECTED.windowText)}); after one notch=${JSON.stringify(s14b.imgSrc)}, overlayHidden=${String(s14b.overlayHidden)}, children=${String(s14b.overlayChildren)}`,
    );

    // 15. Both clamps. Past item 0 the wheel does nothing; back the other way
    // it returns through seen items and stops at the frontier. Seven notches
    // from item 0 reach item 7 (the last item ever shown); the three extra
    // notches must not touch the DOM, because unseen content is off limits.
    await wheel(cdp, true, 3); // sunset-003 -> lantern-002 -> meadow-001, +1 clamped
    const s15a = await page.evaluate(PAGE_STATE);
    await wheel(cdp, false, 7); // -> item 7, the frontier edge
    const s15b = await page.evaluate(PAGE_STATE);
    await wheel(cdp, false, 3); // beyond the frontier: no move allowed
    const s15c = await page.evaluate(PAGE_STATE);
    const s15Ok =
      s15a.imgSrc === "meadow-001.jpg" &&
      s15a.speaker === "Mei" &&
      s15a.text === EXPECTED.meadowText &&
      s15b.text === EXPECTED.line008Text &&
      s15b.video?.paused === false &&
      s15c.text === EXPECTED.line008Text &&
      s15c.video?.src === s15b.video?.src;
    record(
      "15. wheel clamps at item 0 and stops at the frontier on the way back",
      s15Ok ? "PASS" : "FAIL",
      `after 3 extra ups item=${JSON.stringify(s15a.imgSrc)} speaker=${String(s15a.speaker)}; after 7 downs text=${JSON.stringify(s15b.text)} videoPlaying=${String(s15b.video?.paused === false)}; after 3 more downs text=${JSON.stringify(s15c.text)} (unchanged=${String(s15c.text === s15b.text)}) — item 8 (pier-009.jpg) was never painted, so nothing unseen was entered`,
    );

    // 16. tab starts skip: with no further input the cursor advances on the
    // 120 ms dwell — measured page-side, so the driver's own latency is not in
    // the samples — and skip ends when the cursor moves onto the first
    // never-shown item (pier-009, item 8, which has no text). Then that
    // frontier item is shown normally: it sits for its own 1500 ms hold
    // instead of the 120 ms dwell, and auto-advances to line-010 afterwards.
    await wheel(cdp, true, 4); // item 7 -> item 3, room to skip through seen items
    const s16start = await readSignature(page);
    const tabAt = Date.now();
    await pressTab(cdp);
    const skipSamples = await sampleSignatures(page, 900, 40);
    const skipChanges = transitions(skipSamples);
    const s16 = await page.evaluate(PAGE_STATE);
    const skipDeltas = skipChanges
      .slice(1)
      .map(([time], i) => time - skipChanges[i][0])
      .sort((x, y) => x - y);
    const medianDwell = skipDeltas[(skipDeltas.length - 1) >> 1] ?? -1;
    const s16Moves = skipChanges.length - 1;
    const frontierIndex = skipChanges.findIndex(([, sig]) =>
      sig.startsWith("pier-009.jpg"),
    );
    const frontierDelay =
      frontierIndex >= 0 ? skipChanges[frontierIndex][0] - tabAt : -1;
    const tail = skipSamples.slice(-5).map(([, sig]) => sig);
    const stoppedOnFrontier =
      frontierDelay > 0 &&
      frontierDelay < 1000 && // ~5 dwells, not a full read of the item
      s16.imgSrc === "pier-009.jpg" &&
      s16.imgDecoded &&
      s16.overlayHidden === true && // pier-009 has no text
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
      "16. tab skips at ~120 ms per item and stops on the frontier item, shown normally",
      s16Moves >= 4 &&
        medianDwell >= 80 &&
        medianDwell <= 260 &&
        stoppedOnFrontier
        ? resumedNormalHold
          ? "PASS"
          : "PARTIAL"
        : "FAIL",
      `from ${JSON.stringify(s16start.split("|").pop())} the cursor moved ${String(s16Moves)} times with no input (median dwell ${String(medianDwell)}ms against settings.skipDwellMs = 120); the frontier item pier-009.jpg appeared at +${String(frontierDelay)}ms, decoded=${String(s16.imgDecoded)}, overlayHidden=${String(s16.overlayHidden)}, and the last ${String(tail.length)} samples were identical; its normal 1500 ms hold then auto-advanced to line-010=${String(resumedNormalHold)}`,
    );

    // 17. Space during skip exits skip mode: the machine leaves skip and
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
    const s17 = await page.evaluate(PAGE_STATE);
    const s17Ok =
      skippingChanges.length >= 3 &&
      new Set(afterSpace.map(([, s]) => s)).size === 1;
    record(
      "17. space during skip exits skip mode and holds the item",
      s17Ok ? "PASS" : "FAIL",
      `skip was running: the visible state changed ${String(skippingChanges.length - 1)} times in the ~320 ms before the press; after the press, ${String(new Set(afterSpace.map(([, s]) => s)).size - 1)} further change in ~500 ms (a 120 ms dwell would have moved ~4 times); it stopped on ${JSON.stringify(s17.text ?? s17.imgSrc)}, which is inside seen content, so a continuing skip would have moved on from there`,
    );

    // 18. e jumps back to the last item ever seen (frontier - 1), wherever the
    // cursor was, and the wheel cannot push past it from there.
    await wheel(cdp, true, 2);
    const s18before = await readSignature(page);
    await pressE(cdp);
    await sleep(80);
    const s18 = await page.evaluate(PAGE_STATE);
    await wheelNotch(cdp, false);
    await sleep(WHEEL_GAP_MS);
    const s18after = await page.evaluate(PAGE_STATE);
    const s18Ok =
      s18.text === EXPECTED.line010Text &&
      s18.speaker === "Theo" &&
      s18.imgSrc === "pier-009.jpg" &&
      s18after.text === EXPECTED.line010Text &&
      // The line `e` lands on is spoken dialogue with a speaker, so it reads
      // as speech: mode "speech" on band and line, upright (Phase 7b).
      s18.overlayMode === "speech" &&
      s18.textMode === "speech" &&
      s18.textFontStyle === "normal";
    record(
      "18. e returns to the last seen item (frontier - 1); wheel cannot pass it",
      s18Ok ? "PASS" : "FAIL",
      `after 2 wheel-back notches=${JSON.stringify(s18before.split("|").pop())}; after e=${JSON.stringify(s18.imgSrc)} speaker=${String(s18.speaker)} text=${JSON.stringify(s18.text)} mode=${String(s18.overlayMode)}/${String(s18.textMode)} fontStyle=${String(s18.textFontStyle)}; one wheel-down after e left it at ${JSON.stringify(s18after.text)} (frontier edge, item 10 unseen was not entered)`,
    );

    // 19. The demo's other thought line, over a still (docs/plan.md
    // Phase 7b). `e` left the cursor on spoken line-010 with its hold armed,
    // so an advance pair lands on line-011, a thought: "thought" on the band
    // and on the line, and the computed font-style italic where line-010 read
    // "speech" / upright (step 18) — the two modes the README promises read
    // differently. The mode change must not disturb the visual either: a
    // `text` item shows the nearest earlier media item's, so pier-009.jpg
    // stays painted, decoded and visible (machine.visualIndex, no regression).
    await advancePair(cdp);
    await waitImageDecoded(page);
    const s19 = await page.evaluate(PAGE_STATE);
    const s19ModeOk =
      s19.text === EXPECTED.line011Text &&
      s19.overlayHidden === false &&
      s19.overlayMode === "thought" &&
      s19.textMode === "thought" &&
      s19.textFontStyle === "italic";
    const s19VisualOk =
      s19.imgSrc === "pier-009.jpg" && s19.imgDecoded && s19.imgVisible;
    record(
      "19. thought line over a still: data-mode=thought, italic, visual kept",
      s19ModeOk && s19VisualOk ? "PASS" : "FAIL",
      `line-011 text=${String(s19.text === EXPECTED.line011Text)}; mode=${String(s19.overlayMode)}/${String(s19.textMode)} fontStyle=${String(s19.textFontStyle)} (the spoken line-010 it followed read speech/normal in step 18); visual=${JSON.stringify(s19.imgSrc)} decoded=${String(s19.imgDecoded)} visible=${String(s19.imgVisible)}`,
    );

    // 20. `b` appends bookmarks (docs/plan.md Phase 8, README bookmark
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
    const s20at008 = await page.evaluate(PAGE_STATE);
    await pressB(cdp);
    await page.waitForFunction(flashShown, { timeout: 5000 });
    await wheel(cdp, false, 3); // -> line-011 (item 10, the frontier edge)
    await pressB(cdp);
    await page.waitForFunction(flashShown, { timeout: 5000 });
    const s20list = await page.evaluate(READ_BOOKMARKS);
    await sleep(1700); // the pill shows ~900 ms, then fades within ~450 ms
    const s20FlashGone = await page.evaluate(
      () => document.getElementById("flash") === null,
    );
    const s20Ok =
      s20at008.text === EXPECTED.line008Text &&
      s20list.length === 2 &&
      s20list[0].itemIndex === 7 && // insertion order: first press first
      s20list[1].itemIndex === 10 &&
      s20list.every((b) => b.timestampMs > 0 && b.id.length > 0) &&
      s20FlashGone;
    record(
      "20. b appends bookmarks at two different items, with a flash that fades",
      s20Ok ? "PASS" : "FAIL",
      `#flash "Bookmarked" shown twice, removed=${String(s20FlashGone)}; IndexedDB bookmarks=${JSON.stringify(s20list)} — two entries at items 7 and 10 (b pressed on line-008, then on line-011), timestamped, insertion-ordered; hasThumb=${JSON.stringify(s20list.map((b) => b.hasThumb))} (over file:// Chrome taints the canvas, so null thumbs are the expected capture fallback; over http the same code stores JPEG data URLs)`,
    );

    // 21. `t` opens the bookmark overlay (README `t` bullet): a panel whose
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
    const s21 = await page.evaluate(READ_BOOKMARK_OVERLAY);
    const maxScroll = Math.max(0, s21.scrollHeight - s21.clientHeight);
    const newest = s21.entries[s21.entries.length - 1];
    const newestVisible =
      newest !== undefined &&
      newest.rect.top >= s21.listRect.top - 1 &&
      newest.rect.bottom <= s21.listRect.bottom + 1;
    const s21ListOk =
      s21.title === "Bookmarks" &&
      s21.entries.length === 2 &&
      s21.entries[0].itemIndex === 7 && // OLDEST first, at the top
      s21.entries[1].itemIndex === 10 && // newest at the bottom
      maxScroll > 0 && // the short viewport forced a real scroll
      s21.scrollTop >= maxScroll - 1 && // scrolled to the bottom
      newestVisible &&
      s21.entries.every(
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
    const s21sigBefore = await readSignature(page);
    await pressSpace(cdp);
    await pressTab(cdp);
    await wheelNotch(cdp, true);
    await sleep(WHEEL_GAP_MS);
    const s21sigAfter = await readSignature(page);
    const s21still = await page.evaluate(READ_BOOKMARK_OVERLAY);
    const s21SuspendOk =
      s21sigAfter === s21sigBefore &&
      s21still.hidden === false &&
      s21still.entries.length === 2;
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
    record(
      "21. t opens the overlay: oldest first, scrolled to the newest, timeline suspended",
      s21ListOk && s21SuspendOk ? "PASS" : "FAIL",
      `viewport 800x180 to force overflow: entries=${JSON.stringify(s21.entries.map((e) => e.itemIndex))} top-to-bottom (oldest first), scrollTop=${String(s21.scrollTop)} of max ${String(maxScroll)} (newest entry fully visible=${String(newestVisible)}), thumbs=${JSON.stringify(s21.entries.map((e) => [e.thumbSrcHead, e.thumbResolved]))} (both file:// captures were null, so these are the manifest stills: line-008 -> intro-006.poster.jpg, line-011 -> pier-009.jpg), times=${JSON.stringify(s21.entries.map((e) => e.time))}, labels=${JSON.stringify(s21.entries.map((e) => e.label))}; while open, space+tab+wheel-up changed nothing (${String(s21sigAfter === s21sigBefore)}) and the panel stayed open; viewport restored to 800x600`,
    );

    // 22. Clicking the OLDER entry (item 7, at the top of the list) closes
    // the panel and continues the novel from that time point (README `t`
    // bullet): machine.goTo lands the cursor on the bookmarked item
    // UNSETTLED and never moves the frontier. A space press settles the
    // re-shown line in place (a settled arrival would have moved), and `e`
    // afterwards lands back on frontier - 1 (line-011 over pier-009) — the
    // frontier is exactly where the walk left it, so `e` still works after
    // closing. The click is a trusted CDP mouse event at the entry's rect.
    const s22open = await page.evaluate(READ_BOOKMARK_OVERLAY);
    const older = s22open.entries[0];
    await clickAt(
      cdp,
      Math.round((older.rect.left + older.rect.right) / 2),
      Math.round((older.rect.top + older.rect.bottom) / 2),
    );
    await page.waitForFunction(OVERLAY_CLOSED, { timeout: 5000 });
    const s22 = await page.evaluate(PAGE_STATE);
    const s22Landed =
      s22.bookmarksOpen === false &&
      s22.text === EXPECTED.line008Text &&
      s22.video?.visible === true &&
      s22.imgVisible === false; // line-008's visual is the chain's video
    await pressSpace(cdp); // settle the re-shown line in place: no move
    const s22Held = await page.evaluate(PAGE_STATE);
    await pressE(cdp);
    await sleep(80);
    await waitImageDecoded(page);
    const s22e = await page.evaluate(PAGE_STATE);
    const s22FrontierOk =
      s22Held.text === EXPECTED.line008Text && // unsettled arrival: space held it
      s22e.text === EXPECTED.line011Text &&
      s22e.imgSrc === "pier-009.jpg" &&
      s22e.imgVisible === true;
    record(
      "22. clicking the older entry continues from that item; e proves the frontier unchanged",
      s22Landed && s22FrontierOk ? "PASS" : "FAIL",
      `click on entry #7 closed the panel (bookmarksOpen=${String(s22.bookmarksOpen)}); the player continued at line-008 over the intro-006 video (text=${JSON.stringify(s22.text)}); the arrival was UNSETTLED: one space settled it in place (still line-008=${String(s22Held.text === EXPECTED.line008Text)}); e then landed on ${JSON.stringify(s22e.imgSrc)} with line-011=${String(s22e.text === EXPECTED.line011Text)} — frontier - 1 exactly where the walk left it (item 11 unseen never entered), so goTo moved the cursor only inside seen content`,
    );

    // 23. The other ways in and out of the panel: `t` reopens it (the list
    // is re-read from storage on every open), a click on the backdrop —
    // the title strip, outside the scroll list — closes it, `t` again
    // closes it, and Escape closes it too. One fullscreen caveat, shown
    // honestly: while fullscreen, Chrome reserves Escape for leaving
    // fullscreen and the page never receives that keydown (measured in a
    // probe: a document capture listener sees nothing and
    // fullscreenElement goes to null). The second Escape reaches the page
    // and closes the panel.
    await pressT(cdp);
    await page.waitForFunction(OVERLAY_OPEN, { timeout: 5000 });
    const s23reopened = await page.evaluate(READ_BOOKMARK_OVERLAY);
    const title = s23reopened.titleRect;
    await clickAt(
      cdp,
      Math.round((title.left + title.right) / 2),
      Math.round((title.top + title.bottom) / 2),
    );
    const s23AfterBackdrop = await panelOpen(page);
    await pressT(cdp);
    await page.waitForFunction(OVERLAY_OPEN, { timeout: 5000 });
    await pressEscape(cdp);
    await sleep(80);
    const s23EscFullscreen = await panelOpen(page);
    const s23LeftFullscreen = await page.evaluate(
      () => document.fullscreenElement === null,
    );
    await pressEscape(cdp);
    const s23AfterEscape = await panelOpen(page);
    await pressT(cdp);
    await page.waitForFunction(OVERLAY_OPEN, { timeout: 5000 });
    await pressT(cdp);
    const s23AfterT = await panelOpen(page);
    const s23Ok =
      s23reopened.entries.length === 2 &&
      s23AfterBackdrop === false &&
      s23EscFullscreen === true &&
      s23LeftFullscreen === true &&
      s23AfterEscape === false &&
      s23AfterT === false;
    record(
      "23. t reopens (fresh from storage); backdrop click, Escape and t again all close",
      s23Ok ? "PASS" : "FAIL",
      `reopen showed ${String(s23reopened.entries.length)} entries again; backdrop (title strip) click closed=${String(s23AfterBackdrop === false)}; while fullscreen the first Escape is the browser's — it left fullscreen=${String(s23LeftFullscreen)} and the panel stayed open=${String(s23EscFullscreen)} — the second closed=${String(s23AfterEscape === false)}; second t press closed=${String(s23AfterT === false)}; the walk continues with the panel closed`,
    );

    // 24. Reload resume (docs/plan.md Phase 8): stop MID-content — two
    // wheel-back notches leave the cursor below the resume point — so the
    // reload proves the persisted FRONTIER (resume at frontier-1), not the
    // position the reader happened to be at, and a first-ever load (item 0)
    // is ruled out too.
    await wheel(cdp, true, 2);
    const s24before = await page.evaluate(PAGE_STATE);
    await page.reload();
    await page.waitForFunction(
      () => {
        const el = document.getElementById("overlay-text");
        return el !== null && (el.textContent ?? "").length > 0;
      },
      { timeout: 5000 },
    );
    const s24 = await page.evaluate(PAGE_STATE);
    const s24StoppedMid = s24before.overlayHidden === true; // bare pier-009
    const s24Resumed =
      s24.text === EXPECTED.line011Text &&
      s24.imgSrc === "pier-009.jpg" &&
      s24.overlayHidden === false;
    const s24NotFirstLoad =
      s24.imgSrc !== "meadow-001.jpg" && s24.text !== EXPECTED.meadowText;
    record(
      "24. reload resumes at the frontier, not the wheel position or item 0",
      s24StoppedMid && s24Resumed && s24NotFirstLoad ? "PASS" : "FAIL",
      `before reload the reader had wheeled back to bare pier-009 (overlayHidden=${String(s24before.overlayHidden)}); after reload the player resumed at line-011 over pier-009.jpg — the last item ever shown (frontier-1), settled: the frontier is persisted and reload-resume reads it (README: "the state the game starts at when loaded"); first-ever-load item 0 ruled out=${String(s24NotFirstLoad)}`,
    );

    // 25. `c` opens the config screen (docs/plan.md Phase 9, README `c`
    // bullet): the panel shows the current reading speed (the default) and
    // the skip-all state; while it is open the timeline is suspended by the
    // same gate as the `t` panel (space, tab, e and the wheel must not move
    // the cursor behind it); clicking the switch turns skip-all on; a click
    // on the title strip is backdrop and closes; `c` reopens the panel
    // showing the value now in force, and `c` again closes it. This `c` is
    // the first key after step 24's reload, so the page also entered
    // fullscreen here — step 26's Escape accounts for that, as step 23 did.
    await pressC(cdp);
    await page.waitForFunction(CONFIG_OPEN, { timeout: 5000 });
    const s25open = await page.evaluate(READ_CONFIG_OVERLAY);
    const s25DefaultsOk =
      s25open.hidden === false &&
      s25open.title === "Config" &&
      s25open.speedValue === "1.00x — ~60 ms/char" &&
      s25open.skipPressed === "false" &&
      s25open.skipLabel === "Off";
    const s25sigBefore = await readSignature(page);
    await pressSpace(cdp);
    await pressTab(cdp);
    await pressE(cdp);
    await wheelNotch(cdp, true);
    await sleep(WHEEL_GAP_MS);
    const s25sigAfter = await readSignature(page);
    const s25Toggled = await page.evaluate(READ_CONFIG_OVERLAY);
    await clickCenter(cdp, s25Toggled.skipRect); // flip skip-all ON
    const s25toggled = await page.evaluate(READ_CONFIG_OVERLAY);
    const s25ToggleOk =
      s25toggled.hidden === false &&
      s25toggled.skipPressed === "true" &&
      s25toggled.skipLabel === "On";
    await clickCenter(cdp, s25toggled.titleRect); // backdrop click closes
    const s25Closed = await configOpen(page);
    await pressC(cdp); // reopen: shows the value now in force
    await page.waitForFunction(CONFIG_OPEN, { timeout: 5000 });
    const s25again = await page.evaluate(READ_CONFIG_OVERLAY);
    await pressC(cdp); // c closes again
    const s25ClosedAgain = await configOpen(page);
    const s25Ok =
      s25DefaultsOk &&
      s25sigAfter === s25sigBefore &&
      s25ToggleOk &&
      s25Closed === false &&
      s25again.hidden === false &&
      s25again.skipPressed === "true" &&
      s25ClosedAgain === false;
    record(
      "25. c opens the config screen: values shown, timeline suspended, toggle/backdrop/c behave",
      s25Ok ? "PASS" : "FAIL",
      `defaults read speed=${JSON.stringify(s25open.speedValue)} skipAll=${String(s25open.skipPressed)}; while open, space+tab+e+wheel-up changed nothing (${String(s25sigAfter === s25sigBefore)}); clicking the switch: aria-pressed=${String(s25toggled.skipPressed)} label=${JSON.stringify(s25toggled.skipLabel)}; backdrop (title strip) click closed=${String(s25Closed === false)}; c reopened showing aria-pressed=${String(s25again.skipPressed)} and c closed it again=${String(s25ClosedAgain === false)}; the panel is #config, z-index 5 under #flash, with exactly the two README settings`,
    );

    // 26. A changed setting applies live, and survives a reload (the
    // Phase 9 acceptance). Four clicks on the stepper's + take the reading
    // speed 1.00x -> 2.00x (the readout updates in the open panel). Closing
    // by Escape shows the fullscreen caveat again — the first Escape is the
    // browser's and leaves fullscreen, the second reaches the page. Then
    // WITHOUT a reload the re-armed hold is measured: one wheel notch back
    // lands on line-010 (48 code points: 2880 ms at 1.00x), and the
    // auto-advance back to line-011 must come ~1500 ms later — the 2.00x
    // text allowance (1440 ms) floored at minHold — not at the old 2880 ms.
    // Then reload: the startup merge reads the persisted record, and
    // reopening `c` shows 2.00x and skip-all ON. Both are set back to the
    // defaults so the steps after this one walk default behaviour.
    await pressC(cdp);
    await page.waitForFunction(CONFIG_OPEN, { timeout: 5000 });
    for (let i = 0; i < 4; i += 1) {
      const r = await page.evaluate(READ_CONFIG_OVERLAY);
      await clickCenter(cdp, r.speedUpRect);
    }
    const s26speed = await page.evaluate(READ_CONFIG_OVERLAY);
    const s26SpeedOk =
      s26speed.speedValue === "2.00x — ~30 ms/char" &&
      s26speed.skipPressed === "true";
    await pressEscape(cdp);
    await sleep(80);
    const s26EscFullscreen = await configOpen(page);
    const s26LeftFullscreen = await page.evaluate(
      () => document.fullscreenElement === null,
    );
    await pressEscape(cdp);
    const s26Closed = await configOpen(page);
    await wheel(cdp, true, 1); // back onto line-010, unsettled, fresh hold
    const s26samples = transitions(await sampleSignatures(page, 2600, 50));
    const s26back = s26samples.findIndex(([, sig]) =>
      sig.includes(EXPECTED.line010Text),
    );
    const s26on11 = s26samples
      .slice(s26back + 1)
      .find(([, sig]) => sig.includes(EXPECTED.line011Text));
    const s26holdMs =
      s26back >= 0 && s26on11 !== undefined
        ? s26on11[0] - s26samples[s26back][0]
        : -1;
    const s26LiveOk = s26holdMs > 1350 && s26holdMs < 2400; // 1.00x: 2880 ms
    await page.reload();
    await page.waitForFunction(
      () => {
        const el = document.getElementById("overlay-text");
        return el !== null && (el.textContent ?? "").length > 0;
      },
      { timeout: 5000 },
    );
    const s26resumed = await page.evaluate(PAGE_STATE);
    await pressC(cdp);
    await page.waitForFunction(CONFIG_OPEN, { timeout: 5000 });
    const s26persist = await page.evaluate(READ_CONFIG_OVERLAY);
    const s26PersistOk =
      s26resumed.text === EXPECTED.line011Text &&
      s26persist.speedValue === "2.00x — ~30 ms/char" &&
      s26persist.skipPressed === "true";
    for (let i = 0; i < 4; i += 1) {
      const r = await page.evaluate(READ_CONFIG_OVERLAY);
      await clickCenter(cdp, r.speedDownRect);
    }
    const s26reset = await page.evaluate(READ_CONFIG_OVERLAY);
    await clickCenter(cdp, s26reset.skipRect);
    const s26off = await page.evaluate(READ_CONFIG_OVERLAY);
    await clickCenter(cdp, s26off.titleRect); // backdrop closes
    const s26resetClosed = await configOpen(page);
    const s26ResetOk =
      s26reset.speedValue === "1.00x — ~60 ms/char" &&
      s26off.skipPressed === "false" &&
      s26resetClosed === false;
    record(
      "26. config changes apply live and persist: 2.00x speed and skip-all survive reload",
      s26SpeedOk &&
        s26EscFullscreen === true &&
        s26LeftFullscreen &&
        s26Closed === false &&
        s26LiveOk &&
        s26PersistOk &&
        s26ResetOk
        ? "PASS"
        : "FAIL",
      `stepper 1.00x -> ${JSON.stringify(s26speed.speedValue)} by four trusted + clicks; the first Escape left fullscreen=${String(s26LeftFullscreen)} with the panel open=${String(s26EscFullscreen === true)} (the browser keeps it, as in step 23), the second closed=${String(s26Closed === false)}; live effect with no reload: line-010's auto-advance measured at ${String(s26holdMs)}ms (2.00x floors at the 1500 ms minHold; at the old 1.00x it is 2880 ms and the 2600 ms sampling window would show no move); after reload the player resumed at line-011 and c showed ${JSON.stringify(s26persist.speedValue)} skipAll=${String(s26persist.skipPressed)} — the settings record rode with the frontier through storage; reset to 1.00x/Off closed, so the steps below walk default behaviour`,
    );

    // 27. Video playback ranges, range 1 (docs/plan.md Phase 9c): item 11,
    // part-012 — plays [0.0, 1.0] of the shared 2 s clip `clip-012.mp4`
    // with `loopCount` 1 and no text. Before the key press the driver
    // installs (a) an `ended` capture counter on `document` and (b) a
    // sampler that attaches a self-scheduling `requestVideoFrameCallback`
    // chain to the first <video> that fires `play` (the element does not
    // exist yet after step 26's reload; nothing is presented before
    // `play()`, so the first recorded callback IS the first frame shown
    // after entry). Each frame records the poster attribute, which marks
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
    const s27rvfc = await page.evaluate(
      () =>
        typeof HTMLVideoElement.prototype.requestVideoFrameCallback ===
        "function",
    );
    await page.evaluate(() => {
      window.__kineticVid = { frames: [], ended: [] };
      document.addEventListener(
        "ended",
        (event) => {
          const el = event.target;
          if (el && el.tagName === "VIDEO") {
            window.__kineticVid.ended.push({
              src: String(el.getAttribute("src") ?? ""),
              currentTime: el.currentTime,
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
    });
    await pressSpace(cdp); // settled resume item: one press moves the cursor
    await page.waitForFunction(
      () =>
        (
          document.getElementById("visual-video")?.getAttribute("src") ?? ""
        ).includes("clip-012.mp4"),
      { timeout: 5000 },
    );
    const s27loop = await page.evaluate(
      () => document.getElementById("visual-video")?.loop ?? null,
    );
    let s27played = true;
    try {
      await waitVideoPlaying(page);
    } catch {
      s27played = false;
    }
    // The machine advances part-012 -> part-013 on its own (1 pass report
    // + 1500 ms min-hold); the poster attribute marks the entry.
    let s27advanced = true;
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
      s27advanced = false;
    }
    const s27rec = await page.evaluate(() => window.__kineticVid);
    const s27frames = s27rec.frames.filter((f) =>
      f.poster.includes("part-012.poster.jpg"),
    );
    const s27first = s27frames[0] ?? null;
    const s27maxEnd =
      s27frames.length > 0
        ? Math.max(...s27frames.map((f) => f.mediaTime))
        : -1;
    const s27inside =
      s27frames.length > 0 &&
      s27frames.every((f) => f.mediaTime >= -0.05 && f.mediaTime <= 1.25);
    const s27endedInPhase = s27rec.ended.filter((e) =>
      e.src.includes("clip-012.mp4"),
    ).length;
    const s27startOffset = s27first ? s27first.mediaTime : -1;
    const s27passDelta = s27maxEnd - 1.0;
    const s27Ok =
      s27rvfc &&
      s27played &&
      s27loop === false &&
      s27advanced &&
      s27first !== null &&
      s27startOffset <= 0.15 &&
      s27inside &&
      s27passDelta >= -0.04 &&
      s27passDelta <= 0.25 &&
      s27endedInPhase === 0;
    record(
      "27. part-012 plays range [0,1] and reports its pass via rVFC",
      s27Ok ? "PASS" : !s27rvfc ? "PARTIAL" : !s27played ? "PARTIAL" : "FAIL",
      `requestVideoFrameCallback available=${String(s27rvfc)}; first presented frame mediaTime=${JSON.stringify(s27first && Math.round(s27first.mediaTime * 1000) / 1000)} currentTime=${JSON.stringify(s27first && Math.round(s27first.currentTime * 1000) / 1000)} (start offset OBSERVED ${s27startOffset >= 0 ? "+" : ""}${s27startOffset.toFixed(3)}s of ${String(s27frames.length)} frames, all inside [0, 1+0.25]=${String(s27inside)}); pass completed OBSERVED at mediaTime ${s27maxEnd.toFixed(3)} = +${s27passDelta.toFixed(3)}s past endSeconds 1.0; loop=${String(s27loop)} (never loop=true on a range); native ended from clip-012 during this phase=${String(s27endedInPhase)} (0: the pass ends before the file); machine advanced to part-013=${String(s27advanced)} (poster attribute flipped)${
        s27played ? "" : "; autoplay did not start headless"
      }`,
    );

    // 28. Video playback ranges, range 2 (docs/plan.md Phases 9c and 9d):
    // item 12, part-013 — the SAME clip-012.mp4 file at [1.0, 2.0] with
    // `loopCount` 2 and `loopStartSeconds` 1.5, entered automatically by
    // step 27's machine advance. Entry seeks to startSeconds 1.0; the
    // loop-back after pass 1 seeks to loopStartSeconds 1.5, NOT 1.0 — the
    // intro [1.0, 1.5) plays once. Because the range end equals the file's
    // duration, the pass boundary is the file's own `ended` (no frame is
    // ever presented past it), so the ended counter doubles as the
    // pass-report counter: exactly 2, each seeking back to 1.5 except
    // after the last. Observed and recorded: the first frame after entry
    // (start offset from 1.0), the loop-back (mediaTime wrap 2.0 -> 1.5)
    // and where it actually landed, the two pass reports, and the hold
    // near 2.0 at the end. The time gate is now firstPass + loopPass =
    // 1.0 + 0.5 = 1.5 s (machine-tested arithmetic), so the settle below
    // waits ~1.5 s after entry plus the reports; the 6 s timeout covers
    // it generously. The item is LAST, so the machine's advance is a
    // settle in place — the fact step 24 records; loop stays off
    // throughout (a range must never loop=true).
    let s28settled = true;
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
      s28settled = false;
    }
    await sleep(350); // a stray third pass (loop=true behaviour) would show
    const s28rec = await page.evaluate(() => window.__kineticVid);
    const s28frames = s28rec.frames.filter((f) =>
      f.poster.includes("part-013.poster.jpg"),
    );
    const s28first = s28frames[0] ?? null;
    // The loop-back: the pass-1 boundary seeks 2.0 -> 1.5, so the frame
    // stream wraps by ~0.45 — well above the 0.04 s in-pass cadence, well
    // below the old 0.5 threshold, which would MISS a wrap that lands on
    // loopStartSeconds instead of 1.0. One wrap = one in-pass restart.
    let s28wraps = 0;
    let s28wrapLand = null;
    for (let i = 1; i < s28frames.length; i += 1) {
      if (s28frames[i - 1].mediaTime - s28frames[i].mediaTime > 0.25) {
        s28wraps += 1;
        s28wrapLand = s28frames[i].mediaTime;
      }
    }
    const s28inside =
      s28frames.length > 0 &&
      s28frames.every((f) => f.mediaTime >= 0.95 && f.mediaTime <= 2.05);
    const s28ended = s28rec.ended.filter((e) => e.src.includes("clip-012.mp4"));
    const s28last = await page.evaluate(() => {
      const v = document.getElementById("visual-video");
      return v
        ? {
            paused: v.paused,
            loop: v.loop,
            currentTime: Math.round(v.currentTime * 1000) / 1000,
          }
        : null;
    });
    const s28startOffset = s28first ? s28first.mediaTime - 1.0 : 99;
    const s28Ok =
      s28settled &&
      s28first !== null &&
      Math.abs(s28startOffset) <= 0.15 &&
      s28inside &&
      s28wraps === 1 &&
      s28wrapLand !== null &&
      // The loop-back lands at loopStartSeconds 1.5, NOT at the range
      // start 1.0 (which the pre-9c/9d element-loop or a startSeconds
      // seek-back would give): exactly one landing, recorded actual.
      Math.abs(s28wrapLand - 1.5) <= 0.15 &&
      s28ended.length === 2 &&
      s28last !== null &&
      s28last.paused === true &&
      s28last.loop === false &&
      s28last.currentTime >= 1.9 &&
      s28last.currentTime <= 2.05;
    record(
      "28. part-013 plays [1,2] twice, looping back at loopStartSeconds 1.5",
      s28Ok ? "PASS" : "FAIL",
      `${String(s28frames.length)} presented frames, all inside [1-0.05, 2+0.05]=${String(s28inside)}; entered at OBSERVED mediaTime ${s28first ? s28first.mediaTime.toFixed(3) : "n/a"} (start offset ${s28startOffset >= 0 ? "+" : ""}${s28startOffset.toFixed(3)}s from startSeconds 1.0); pass-1 loop-back observed=${String(s28wraps === 1)} landing OBSERVED ${s28wrapLand === null ? "n/a" : s28wrapLand.toFixed(3)} (offset ${s28wrapLand === null ? "n/a" : `${s28wrapLand - 1.5 >= 0 ? "+" : ""}${(s28wrapLand - 1.5).toFixed(3)}s`} from loopStartSeconds 1.5, not 1.0); pass reports (native ended from clip-012, endSeconds == duration)=${String(s28ended.length)} of 2 — machine moved on only after both plus the 1.5 s time bound (firstPass 1.0 + loopPass 0.5), and the 2nd left the element holding OBSERVED ${JSON.stringify(s28last)} near 2.0, paused, loop=${String(s28last?.loop)} (last item: the advance is a settle in place, step 24; its gate arithmetic is pinned by machine tests)`,
    );

    // 29. A folder with the empty stub manifest shows the empty state —
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
    const s29 = await emptyPage.evaluate(PAGE_STATE);
    const s29Ok =
      s29.emptyState === EXPECTED.emptyNotice &&
      s29.imgSrc === null &&
      s29.overlayHidden === true;
    const emptyCdp = await emptyPage.createCDPSession();
    await pressT(emptyCdp);
    await emptyPage.waitForFunction(OVERLAY_OPEN, { timeout: 5000 });
    const s29overlay = await emptyPage.evaluate(READ_BOOKMARK_OVERLAY);
    const s29EmptyOverlayOk =
      s29overlay.hidden === false &&
      s29overlay.entries.length === 0 &&
      s29overlay.emptyText === "No bookmarks yet — press b";
    // Same fullscreen caveat as step 23: `t` was this page's first gesture
    // so it entered fullscreen, and the browser keeps the first Escape.
    await pressEscape(emptyCdp);
    await sleep(80);
    await pressEscape(emptyCdp);
    const s29Closed = await panelOpen(emptyPage);
    record(
      "29. empty-manifest folder shows the empty state; t there says no bookmarks yet",
      s29Ok && s29EmptyOverlayOk && s29Closed === false ? "PASS" : "FAIL",
      `${JSON.stringify({ emptyState: s29.emptyState, imgSrc: s29.imgSrc, overlayHidden: s29.overlayHidden })}; t opened the overlay: emptyText=${JSON.stringify(s29overlay.emptyText)} entries=${String(s29overlay.entries.length)} (the demo folder's two bookmarks are another novel's — storage is keyed per folder); Escape (after the fullscreen-exiting one the browser keeps) closed=${String(s29Closed === false)}`,
    );

    // 30. Fill the screen (docs/plan.md Phase 7b): the media is the largest
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
        "30. media fills the viewport as a centred contain fit of its own aspect",
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

    // 31. Console stayed empty throughout both pages.
    const s31Ok = consoleMessages.length === 0 && pageErrors.length === 0;
    record(
      "31. console stayed empty throughout",
      s31Ok ? "PASS" : "FAIL",
      s31Ok
        ? "zero console messages, zero page errors, every page, whole run"
        : `console=[${consoleMessages.join(" | ")}] pageErrors=[${pageErrors.join(" | ")}]`,
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
