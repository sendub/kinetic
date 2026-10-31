#!/usr/bin/env node
// Driver for docs/verify-player.md: walks the checklist (Phase 5 shell,
// Phase 6 media playback, Phase 7 wheel/skip/jump, Phase 7b speech vs thought
// and contain-fit geometry) against the demo fixture
// in headless Chrome and prints PASS / PARTIAL / FAIL per step.
// Run from player/:  node scripts/verify.mjs
// Exit code: 0 when every step is PASS or PARTIAL, 1 on any FAIL or crash.
//
// Each run reassembles .tmp/verify-demo from fixtures/demo plus the built
// bundle (dist/index.html, dist/app.js); the fixture's own manifest.js is
// never touched, so the demo manifest always comes from the fixture.
// .tmp/verify-demo-empty gets the dist stub manifest (no items) to exercise
// the #empty-state notice, and .tmp/verify-demo-tall is a copy whose item-1
// image has been rescaled to a portrait 640x960 while the manifest still says
// 960x540 — the one shape that tells "fit to the asset" apart from "fit to
// the manifest" (step 22, docs/plan.md Phase 7b).
//
// Every input is real CDP Input: Input.dispatchKeyEvent for keys and
// Input.dispatchMouseEvent `mouseWheel` for the wheel. Both arrive trusted, so
// the fullscreen gesture logic treats them as user input and the wheel takes
// the same path a trackpad takes. Nothing reads the machine from the driver:
// each step asserts what the DOM shows.

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
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
// The portrait size step 22 rescales item 1's image to. Its aspect (2:3)
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
  // The asset/manifest aspect mismatch folder for step 22. Only the JPEG is
  // resampled, never the manifest, and `fixtures/demo` itself stays pristine.
  // `sips` is macOS' own resizer; without it step 22 loses its discriminator
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
    fsAttempts: window.__fsAttempts ?? 0,
    firstKeys: window.__firstKeys ?? [],
    fullscreenElement: document.fullscreenElement
      ? document.fullscreenElement.tagName.toLowerCase()
      : null,
  };
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
// rotated phone or an un-maximised window looks like to the layout.
const openAtViewport = async (
  browser,
  dir,
  width,
  height,
  label,
  messages,
  errors,
) => {
  const page = await browser.newPage();
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
  console.log(
    `driver: ${execFileSync(chromePath, ["--version"], { encoding: "utf8" }).trim()}`,
  );
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    userDataDir: join(repoRoot, ".tmp", "verify-chrome-profile"),
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

    // 20. Reload: the frontier is not persisted yet, so a reload starts the
    // first-ever load again — item 0, not the resume spot. Honest PARTIAL:
    // the machine accepts `resumeFrontier` and main.ts passes nothing, so
    // persistence itself is Phase 8 wiring (IndexedDB), not a Phase 7 gap.
    await page.reload();
    await page.waitForFunction(
      () => {
        const el = document.getElementById("overlay-text");
        return el !== null && (el.textContent ?? "").length > 0;
      },
      { timeout: 5000 },
    );
    const s20 = await page.evaluate(PAGE_STATE);
    const s20AtStart =
      s20.imgSrc === "meadow-001.jpg" && s20.text === EXPECTED.meadowText;
    record(
      "20. reload resume (PARTIAL: persistence wired in Phase 8)",
      s20AtStart ? "PARTIAL" : "FAIL",
      `after reload the player shows ${JSON.stringify(s20.imgSrc)} with Mei's first line — it restarted at item 0 instead of resuming at the frontier; nothing stores the frontier yet (main.ts passes no resumeFrontier), which is Phase 8's IndexedDB work`,
    );

    // 21. A folder with the empty stub manifest shows the empty state.
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
    const s21 = await emptyPage.evaluate(PAGE_STATE);
    const s21Ok =
      s21.emptyState === EXPECTED.emptyNotice &&
      s21.imgSrc === null &&
      s21.overlayHidden === true;
    record(
      "21. empty-manifest folder shows the empty state",
      s21Ok ? "PASS" : "FAIL",
      JSON.stringify(s21),
    );

    // 22. Fill the screen (docs/plan.md Phase 7b): the media is the largest
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
        "22. media fills the viewport as a centred contain fit of its own aspect",
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
      for (const page of fitPages) await page.close();
    }

    // 23. Console stayed empty throughout both pages.
    const s23Ok = consoleMessages.length === 0 && pageErrors.length === 0;
    record(
      "23. console stayed empty throughout",
      s23Ok ? "PASS" : "FAIL",
      s23Ok
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
