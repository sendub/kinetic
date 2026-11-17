#!/usr/bin/env node
// The README's screenshots (docs/plan.md Phase 57 item 11c), taken with
// the testing library's openGame in headless Chrome at a fixed 1280 x 720
// from fixtures/showcase-demo, a short story with synthetic art shaped
// for the branch map (fixtures/build_showcase_demo.py):
//
//   docs/images/reading.png    Ines's line in her colours, with text tags
//   docs/images/esc-screen.png the Esc screen: the keys and the settings
//   docs/images/map.png        the branch map at Fit: a decision with both
//                              routes played and bookmarked, one played
//                              1/2, one not reached (its tip shown)
//   docs/images/bookmarks.png  the map at Full size, cropped to the first
//                              decision's fork and its bookmark cards
//
// One fresh profile reads the story from its start with Play all routes
// on (its default), taking bookmarks on the way, and stops on an ending
// partway through; then it opens the map and the Esc screen. Each shot
// waits for the screen to be still: transitions and CSS animations over,
// the #flash pill gone, the map's thumbnails loaded. Two runs give the
// same files.
//
// Run from player/:  npm run build && npm run screenshots
// The story is built by `.venv/bin/python fixtures/build_showcase_demo.py`
// (gitignored output, no ffmpeg needed); the game folder is assembled in
// .tmp/screenshots-demo/ and removed at the end.

import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openGame } from "./testing/kinetic.mjs";

const playerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(playerDir, "..");
const demo = join(repoRoot, "fixtures", "showcase-demo");
const folder = join(repoRoot, ".tmp", "screenshots-demo");
const images = join(repoRoot, "docs", "images");

for (const [path, fix] of [
  [
    join(demo, "manifest.json"),
    ".venv/bin/python fixtures/build_showcase_demo.py",
  ],
  [join(playerDir, "dist", "app.js"), "npm run build (from player/)"],
]) {
  if (!existsSync(path)) {
    console.error(`screenshots: ${path} is missing; run ${fix}`);
    process.exit(1);
  }
}

rmSync(folder, { recursive: true, force: true });
cpSync(demo, folder, { recursive: true });
for (const file of ["index.html", "app.js"]) {
  copyFileSync(join(playerDir, "dist", file), join(folder, file));
}
mkdirSync(images, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Nothing on screen still moving: every CSS animation and transition
// (the picture transitions, overlay fades) finished, and no #flash pill
// ("Bookmarked", "Skip off", a route's name), which render/app.ts removes
// once it has faded.
const STILL = () =>
  document.getAnimations().every((a) => a.playState !== "running") &&
  document.getElementById("flash") === null;

const MAP_LOADED = () => {
  const p = document.getElementById("branchmap");
  if (p === null || p.hidden || p.dataset.ready !== "true") return false;
  return [...p.querySelectorAll(".bm-card")].every((card) => {
    const pic = card.querySelector(".bm-thumb > .bm-pic");
    return pic !== null && (pic.tagName !== "IMG" || pic.complete);
  });
};

const game = await openGame(folder, {
  engine: "chrome",
  viewport: { width: 1280, height: 720 },
  log: null,
});

async function still(extra = 400) {
  await sleep(extra);
  await game.page.waitForFunction(STILL, { timeout: 10000 });
  await sleep(200);
}

async function shot(name, clip = undefined) {
  const file = join(images, name);
  // captureBeyondViewport false: the default resizes the page for a clip,
  // which would end the pointer's hover.
  await game.page.screenshot({
    path: file,
    captureBeyondViewport: false,
    ...(clip ? { clip } : {}),
  });
  console.log(`screenshots: wrote ${file}`);
}

// A bookmark's time shows when its card is hovered, so each bookmark gets
// a fixed one: the page's clock reads `minute` minutes past BASE_MS while
// `b` takes it, in UTC (emulated below), and runs on again after.
const BASE_MS = Date.UTC(2026, 10, 17, 20, 0, 0);
await game.page.emulateTimezone("UTC");

async function bookmarkAt(id, minute) {
  await game.spaceUntil(id);
  await game.page.evaluate(
    (ms) => {
      window.screenshotsNow ??= Date.now;
      Date.now = () => ms;
    },
    BASE_MS + minute * 60000,
  );
  await game.press("b");
  await still();
  await game.page.evaluate(() => {
    Date.now = window.screenshotsNow;
  });
}

try {
  // Bookmarks on the opening, on both routes of the first decision
  // ("fork") and on the main line after it. Play all routes plays the
  // shorter route, through the town (it returns to the choice), then the
  // cliff path (it continues), so "fork" reads 2/2. At "festival" it plays
  // the shorter route, the last boat, an ending, where the walk stops:
  // "festival" reads 1/2 and "confession" is not reached ("?", faded, its
  // labels hidden with Spoilers off). The cliff bookmark has the latest
  // time, so it is the newest: the one N centres on.
  await bookmarkAt("open", 1);
  // Ines's coloured line with italic and bold.
  await game.spaceUntil("open-2");
  await still(1000);
  await shot("reading.png");
  await bookmarkAt("town", 2);
  await bookmarkAt("cliff", 9);
  await bookmarkAt("square", 4);
  await game.spaceUntil("leave");
  await still(1000);

  // The map's first open is Full size centred on "you are here". N centres
  // it on the newest bookmark, and the pointer rests on that card, which
  // shows its delete x and its time. The shot is cropped to the fork: the
  // decision's node and both routes' bookmark cards, with their count
  // lines.
  await game.press("m");
  await game.page.waitForFunction(MAP_LOADED, { timeout: 10000 });
  await game.press("n");
  await still(800);
  const fork = await game.page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const cards = ["town", "cliff"].map((id) =>
      box(document.querySelector(`.bm-card[data-item-id="${id}"]`)),
    );
    const node = box(document.querySelector('#branchmap .map-dec[data-d="0"]'));
    const newest = box(document.querySelector(".bm-card.bm-newest"));
    return {
      left: Math.min(node.left, ...cards.map((r) => r.left)),
      right: Math.max(node.right, ...cards.map((r) => r.right)),
      top: Math.min(node.top, ...cards.map((r) => r.top)),
      bottom: Math.max(node.bottom, ...cards.map((r) => r.bottom)),
      hover: {
        x: newest.left + newest.width / 2,
        y: newest.top + newest.height / 2,
      },
    };
  });
  await game.page.mouse.move(fork.hover.x, fork.hover.y);
  await still(800);
  const y = Math.max(0, Math.round(fork.top - 40));
  await shot("bookmarks.png", {
    x: 0,
    y,
    width: 1280,
    height: Math.min(720, Math.round(fork.bottom + 44)) - y,
  });
  // At Fit the pointer rests on the decision not reached, whose tip reads
  // "Decision not reached" while Spoilers is off.
  await game.press("f");
  await still(800);
  const node = await game.page.evaluate(() => {
    const r = document
      .querySelector("#branchmap .map-dec.map-inert")
      .getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await game.page.mouse.move(node.x, node.y);
  await still(800);
  await shot("map.png");
  await game.page.mouse.move(1279, 719);
  // Esc closes the map; the next Esc opens the Esc screen over the story.
  await game.press("Escape");
  await still();
  await game.press("Escape");
  await game.page.waitForFunction(
    () => document.getElementById("help")?.hidden === false,
    { timeout: 5000 },
  );
  await still();
  await shot("esc-screen.png");
} finally {
  await game.close();
  rmSync(folder, { recursive: true, force: true });
}
