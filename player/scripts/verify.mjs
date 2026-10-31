#!/usr/bin/env node
// Driver for docs/verify-player.md: walks the checklist (Phase 5 shell +
// Phase 6 media playback) against the demo fixture in headless Chrome and
// prints PASS / PARTIAL / FAIL per step.
// Run from player/:  node scripts/verify.mjs
// Exit code: 0 when every step is PASS or PARTIAL, 1 on any FAIL or crash.
//
// Each run reassembles .tmp/verify-demo from fixtures/demo plus the built
// bundle (dist/index.html, dist/app.js); the fixture's own manifest.js is
// never touched, so the demo manifest always comes from the fixture.
// .tmp/verify-demo-empty gets the dist stub manifest (no items) to exercise
// the #empty-state notice.
//
// Keys are real CDP Input events (Input.dispatchKeyEvent): trusted events,
// so the fullscreen gesture logic treats them as user input.

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const playerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(playerDir, "..");
const contentDir = join(repoRoot, ".tmp", "verify-demo");
const emptyDir = join(repoRoot, ".tmp", "verify-demo-empty");
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
  line007Text: "The street glowed under the awning.",
  line008Text: "Neither of us spoke for a while.",
  sparkText: "Sparks circled the bonfire and went out one by one.",
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
}

// Serialised into the page; reads only what the renderer put in the DOM.
const PAGE_STATE = () => {
  const img = document.getElementById("visual-image");
  const overlay = document.getElementById("overlay");
  const app = document.getElementById("app");
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
    text: document.getElementById("overlay-text")?.textContent ?? null,
    fsAttempts: window.__fsAttempts ?? 0,
    firstKeys: window.__firstKeys ?? [],
    fullscreenElement: document.fullscreenElement
      ? document.fullscreenElement.tagName.toLowerCase()
      : null,
  };
};

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
  assembleFolders();
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
      s10.text === EXPECTED.line007Text;
    record(
      "10. text item keeps the earlier video (same element, looping, no placeholder)",
      s10Ok ? "PASS" : "FAIL",
      `sameElement=${String(same10)}; ${JSON.stringify(s10.video)}; overlay=${String(s10.speaker === "Mei" && s10.text === EXPECTED.line007Text)}`,
    );

    // 11. line-007 -> line-008: the chain advance must not touch the video
    // element at all — same token, still looping and playing.
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
      s11.text === EXPECTED.line008Text;
    record(
      "11. line-007 -> line-008 keeps the same <video> element playing",
      s11Ok ? "PASS" : "FAIL",
      `sameElement=${String(same11)}; ${JSON.stringify(s11.video)}`,
    );

    // 12. h over a playing video: the overlay hides, the video keeps
    // playing on the same element (docs/plan.md Phase 6: h hides text over
    // video too). h again restores before the walk continues.
    await pressH(cdp);
    const s12 = await page.evaluate(PAGE_STATE);
    const same12 = await videoTokenIs(page);
    const s12Ok =
      s12.overlayHidden === true &&
      same12 &&
      s12.video?.visible === true &&
      (!played || s12.video?.paused === false);
    record(
      "12. h hides overlay while the video keeps playing",
      s12Ok ? "PASS" : "FAIL",
      `overlayHidden=${String(s12.overlayHidden)}; sameElement=${String(same12)}; ${JSON.stringify(s12.video)}`,
    );
    await pressH(cdp);

    // 13. Rewinding onto the earlier video item shows the poster still: the
    // video pauses at the start with the poster painted. The real wheel
    // gesture lands in Phase 7, so the driver commands machine.wheelBack()
    // through the __kineticDebug seam (render/app.ts): this proves the
    // renderer's rewind-still behavior, NOT the wheel wiring — its honest
    // ceiling is PARTIAL, and headless cannot distinguish the poster pixels
    // from frame 0 (the poster IS the first frame by format docs).
    try {
      await page.evaluate(() => {
        const m = window.__kineticDebug?.machine;
        if (m === undefined) throw new Error("__kineticDebug.machine missing");
        m.wheelBack(); // line-008 -> line-007: below frontier, still mode
        m.wheelBack(); // line-007 -> intro-006 itself: still mode
      });
      await sleep(150);
      const s13 = await page.evaluate(PAGE_STATE);
      const same13 = await videoTokenIs(page);
      const s13Ok =
        same13 &&
        s13.video?.paused === true &&
        s13.video?.currentTime < 0.05 &&
        s13.video?.loop === false &&
        s13.video?.visible === true &&
        s13.video?.posterPainted === true;
      record(
        "13. rewind onto the video item shows the poster still (PARTIAL in headless)",
        s13Ok ? "PARTIAL" : "FAIL",
        `sameElement=${String(same13)}; ${JSON.stringify(s13.video)}; driven by machine.wheelBack() — real wheel wiring lands in Phase 7; poster-vs-frame-0 pixels indistinguishable by definition`,
      );
    } catch (error) {
      record(
        "13. rewind onto the video item shows the poster still (PARTIAL in headless)",
        "FAIL",
        String(error),
      );
    }

    // 14. A folder with the empty stub manifest shows the empty state.
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
    const s14 = await emptyPage.evaluate(PAGE_STATE);
    const s14Ok =
      s14.emptyState === EXPECTED.emptyNotice &&
      s14.imgSrc === null &&
      s14.overlayHidden === true;
    record(
      "14. empty-manifest folder shows the empty state",
      s14Ok ? "PASS" : "FAIL",
      JSON.stringify(s14),
    );

    // 15. Console stayed empty throughout both pages.
    const s15Ok = consoleMessages.length === 0 && pageErrors.length === 0;
    record(
      "15. console stayed empty throughout",
      s15Ok ? "PASS" : "FAIL",
      s15Ok
        ? "zero console messages, zero page errors, both pages, whole run"
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
