#!/usr/bin/env node
// Driver for docs/verify-player.md: walks the Phase 5 checklist against the
// demo fixture in headless Chrome and prints PASS / PARTIAL / FAIL per step.
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
  emptyNotice: "No content yet — this folder has an empty manifest.",
};

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

    // 8. Advancing into item 5 (spark-005) shows the labeled placeholder
    // (animation media lands in Phase 6).
    await advancePair(cdp);
    const s8 = await page.evaluate(PAGE_STATE);
    const s8Ok =
      s8.placeholder?.includes("spark-005") &&
      s8.placeholder.includes("animation placeholder") &&
      s8.imgSrc === null &&
      s8.overlayHidden === false &&
      s8.text === "Sparks circled the bonfire and went out one by one.";
    record(
      "8. animation item shows labeled placeholder (Phase 6 pending)",
      s8Ok ? "PASS" : "FAIL",
      JSON.stringify(s8),
    );

    // 9. Item 6 (intro-006) likewise gets its labeled video placeholder.
    await advancePair(cdp);
    const s9 = await page.evaluate(PAGE_STATE);
    const s9Ok =
      s9.placeholder?.includes("intro-006") &&
      s9.placeholder.includes("video placeholder") &&
      s9.imgSrc === null;
    record(
      "9. video item shows labeled placeholder (Phase 6 pending)",
      s9Ok ? "PASS" : "FAIL",
      JSON.stringify(s9),
    );

    // 10. Item 7 (line-007) is a text item: machine.visualIndex() keeps the
    // earlier video's placeholder on screen unchanged while the cursor's own
    // speaker + line draw in the overlay.
    await advancePair(cdp);
    const s10 = await page.evaluate(PAGE_STATE);
    const s10Ok =
      s10.placeholder === s9.placeholder &&
      s10.imgSrc === null &&
      s10.overlayHidden === false &&
      s10.speaker === "Mei" &&
      s10.text === EXPECTED.line007Text;
    record(
      "10. text item keeps earlier visual, shows own speaker + text",
      s10Ok ? "PASS" : "FAIL",
      `placeholder unchanged from step 9=${String(s10.placeholder === s9.placeholder)}; ${JSON.stringify(s10)}`,
    );

    // 11. A folder with the empty stub manifest shows the empty state.
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
    const s11 = await emptyPage.evaluate(PAGE_STATE);
    const s11Ok =
      s11.emptyState === EXPECTED.emptyNotice &&
      s11.imgSrc === null &&
      s11.overlayHidden === true;
    record(
      "11. empty-manifest folder shows the empty state",
      s11Ok ? "PASS" : "FAIL",
      JSON.stringify(s11),
    );

    // 12. Console stayed empty throughout both pages.
    const s12Ok = consoleMessages.length === 0 && pageErrors.length === 0;
    record(
      "12. console stayed empty throughout",
      s12Ok ? "PASS" : "FAIL",
      s12Ok
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
