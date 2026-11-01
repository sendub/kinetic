#!/usr/bin/env node
// End-to-end walk of any Kinetic content folder over file:// — the reusable
// half of docs/plan.md Phase 11 ("every sampled slice extracts and plays in
// the player"). One command per slice, so a corpus sample is judged by the
// same walk the demo fixture passed.
//
//   node player/scripts/play-folder.mjs <content-folder>
//
// The folder is a converter output (manifest.json + manifest.js + media); the
// script drops the current player bundle (dist/index.html, dist/app.js) into
// it, so the folder's own manifest.js always wins — the bundle is never the
// thing under test. Chrome runs headless with a throwaway profile: Phase 8
// put the reading frontier and bookmarks in IndexedDB, and a walk has to start
// at the first item the way a fresh machine does.
//
// Walk logic mirrors docs/verify-player.md: read the item count from
// window.KINETIC_MANIFEST, then press space once per step (the README space
// binding) for enough steps to cross the whole manifest. A step settles if the
// machine was mid-hold, so one press never skips an item — at worst it
// re-observes one. Each step records the ONE visible surface (the renderer
// keeps exactly the image, the video, or the notice visible), so the run
// reports which distinct visuals actually painted: a decoded image
// (naturalWidth > 0), a video element, or the placeholder/notice.
//
// Output is one JSON line on stdout:
//   { items, mediaFiles, decodedVisuals, paintedSteps, placeholderSteps,
//     videoSteps, maxNat, errors, paintedFiles, missingFiles }
// Exit 0 when the console stayed clean and every media file the manifest names
// painted at least once (a slice with no media — a dynamic-scene-name sample —
// passes on a clean console alone, which is a result, not a failure).

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const playerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(playerDir, "..");
const chromePath =
  process.env.KINETIC_CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const folder = process.argv[2];
if (!folder) {
  console.error("usage: node scripts/play-folder.mjs <content-folder>");
  process.exit(2);
}
const contentDir = resolve(folder);
if (!existsSync(join(contentDir, "manifest.js"))) {
  console.error(`play-folder: ${contentDir} has no manifest.js`);
  process.exit(2);
}
for (const file of ["index.html", "app.js"]) {
  if (!existsSync(join(playerDir, "dist", file))) {
    console.error(`play-folder: player/dist/${file} missing - npm run build`);
    process.exit(2);
  }
  copyFileSync(join(playerDir, "dist", file), join(contentDir, file));
}

// The manifest is read from disk for the expected-media denominator; the page
// still supplies the item count the walk uses.
const manifest = JSON.parse(
  readFileSync(join(contentDir, "manifest.json"), "utf8"),
);
const mediaFiles = [
  ...new Set(
    manifest.items
      .filter((item) => item.type !== "text")
      .map((item) => item.file)
      .filter((file) => typeof file === "string" && file.length > 0),
  ),
];

const profile = mkdtempSync(join(tmpdir(), "kinetic-play-"));
const errors = [];
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-crash-reporter",
    `--crash-dumps-dir=${join(repoRoot, ".tmp", "crashdumps")}`,
    "--allow-file-access-from-files",
    `--user-data-dir=${profile}`,
  ],
});

// Which surface is visible, and whether it actually decoded. `display: none`
// marks the hidden ones, so computed style is the authority, not presence.
const SNAPSHOT = `(() => {
  const pick = (el) => el && getComputedStyle(el).display !== "none";
  const img = pick(document.querySelector("#stage img#visual-image"))
    ? document.querySelector("#stage img#visual-image") : null;
  const video = pick(document.querySelector("#stage video#visual-video"))
    ? document.querySelector("#stage video#visual-video") : null;
  const notice = document.querySelector("#stage .notice");
  const band = document.querySelector("#overlay");
  const textEl = document.querySelector("#overlay-text");
  const bandText = band && !band.hidden && textEl ? textEl.textContent.trim() : "";
  // The declared path, recovered from the element's resolved URL. The manifest
  // is the authority and a bucket subpath (assets/ab/x.jpg, docs/plan.md
  // Phase 17) is part of the declaration, so the walk keys on the
  // folder-relative PATH rather than the basename: two buckets can hold the
  // same name, and a basename match would hide a misresolved path.
  const root = new URL(".", location.href).pathname;
  const rel = (src) =>
    src ? decodeURIComponent(new URL(String(src), location.href).pathname.slice(root.length)) : "";
  if (video && !img) return { kind: "video", key: "video:" + rel(video.currentSrc || video.src), nat: video.videoWidth || 0, text: bandText };
  if (img) return { kind: "img", key: "img:" + rel(img.src), nat: img.naturalWidth, complete: img.complete, text: bandText };
  if (notice) return { kind: "notice", key: "notice:" + notice.id + ":" + notice.textContent, nat: 0, text: bandText };
  return { kind: "none", key: "none", nat: 0, text: bandText };
})()`;

let exitCode = 1;
try {
  const page = await browser.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.endsWith("manifest.json")) return; // app.js prefers manifest.js
    errors.push(`requestfailed: ${url.split("/").slice(-2).join("/")}`);
  });

  await page.goto(`file://${join(contentDir, "index.html")}`, {
    waitUntil: "load",
  });
  await page.waitForSelector("#stage", { timeout: 10000 });
  const items = await page.evaluate(
    () => (window.KINETIC_MANIFEST?.items ?? []).length,
  );

  const painted = new Set();
  const overlayTexts = new Set();
  let paintedSteps = 0;
  let placeholderSteps = 0;
  let videoSteps = 0;
  let maxNat = 0;

  const observe = async () => {
    let snap = await page.evaluate(SNAPSHOT);
    // Give a still that has not decoded yet a bounded window; file:// images
    // decode in a frame or two, and a stalled one is the finding, not a race.
    for (
      let waited = 0;
      snap.kind === "img" && !snap.complete && waited < 2000;
      waited += 100
    ) {
      await new Promise((r) => setTimeout(r, 100));
      snap = await page.evaluate(SNAPSHOT);
    }
    if (snap.text) overlayTexts.add(snap.text);
    if (snap.kind === "video") {
      videoSteps += 1;
      paintedSteps += 1;
      painted.add(snap.key);
    } else if (snap.kind === "img" && snap.nat > 0) {
      paintedSteps += 1;
      maxNat = Math.max(maxNat, snap.nat);
      painted.add(snap.key);
    } else if (snap.kind === "notice") {
      placeholderSteps += 1;
    }
    return snap;
  };

  await observe();
  // Fixed step budget: one press per item, plus room for the settle press the
  // machine takes on a still-holding item or a playing video. An early stop on
  // repeated visuals would be wrong — a media item and the text items chained
  // over it share one surface, so identical steps are normal mid-manifest. Past
  // the last item a press only re-settles, so extra steps are harmless.
  const steps = items * 2 + 8;
  let decisions = 0;
  for (let step = 0; step < steps; step += 1) {
    // A pending decision blocks space; pick route 1 to keep walking.
    // #choice is a persistent element: the `hidden` attribute is truth.
    const choiceUp = await page.evaluate(() => {
      const el = document.querySelector("#choice");
      return !!el && !el.hidden;
    });
    if (choiceUp) {
      decisions += 1;
      // Cycle routes so pure-choice decisions run out of unplayed
      // routes and the walk proceeds past them.
      const routeCount = await page.evaluate(
        () => document.querySelectorAll("#choice .choice-num").length || 1,
      );
      await page.keyboard.press(String((decisions % routeCount) + 1));
    } else {
      await page.keyboard.press(" ");
    }
    await new Promise((r) => setTimeout(r, 90));
    await observe();
  }

  const paintedFiles = [...painted].sort();
  // The manifest's declared path is the key — a flat name or a bucket subpath,
  // compared as declared (docs/plan.md Phase 17). The walk never assumes the
  // folder root is the file's directory.
  const missingFiles = mediaFiles.filter(
    (file) =>
      !paintedFiles.some(
        (key) => key === `img:${file}` || key === `video:${file}`,
      ),
  );
  const decodedVisuals = paintedFiles.length;
  // Clean console is the floor. When the manifest names media, every distinct
  // file must have painted; a slice with no media (dynamic scene refs only) is
  // judged on the clean console and a manifest that loaded.
  const ok = errors.length === 0 && missingFiles.length === 0;
  exitCode = ok ? 0 : 1;
  console.log(
    JSON.stringify(
      {
        items,
        mediaFiles: mediaFiles.length,
        decisions,
        decodedVisuals,
        paintedSteps,
        placeholderSteps,
        overlayTexts: overlayTexts.size,
        videoSteps,
        maxNat,
        errors,
        paintedFiles,
        missingFiles,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(exitCode);
