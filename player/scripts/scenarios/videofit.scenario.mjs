// Videos fill the stage (docs/plan.md Phase 46 item 6): on every path
// onto a video item the video's painted frames, read from a screenshot,
// cover the box `object-fit: contain` gives its own size in the stage, and
// nothing else (the picture before it, a stale poster) shows beside them.
// A walk over many videos holds one <video> at a time: each new file gets a
// fresh element, ranges of one file share one, and each element let go has
// no source left (render/visual.ts, `retireVideo`). Its own folders: solid
// green videos of several shapes (MP4 and WebM), solid blue posters and red
// pictures of other shapes, so a screenshot tells the frames, the poster
// and a picture apart. Each part builds its own copy and opens its own
// browser.
//
// What this cannot see: WebKit composites a playing video in its GPU
// process, which the off-screen driver window never renders (a capture of
// the window shows no video at all), and its screenshot paints the current
// frame into the element's object-fit box instead. A video layer WebKit
// sized wrongly on screen (the user's report: Safari and the macOS app,
// fullscreen, after many pictures and videos) passes here: these checks
// guard the paths, they cannot fail for that bug headless.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clickCenter,
  closeSettings,
  containFit,
  dismissHelp,
  openSettings,
  playerDir,
  pressE,
  pressSpace,
  pressTab,
  scenarioRoot,
  sleep,
  wheel,
} from "./harness.mjs";

export const title = "videos fill the stage on every path onto them";

const VIDEOS = [
  { name: "v169", ext: "mp4", w: 640, h: 360 },
  { name: "v43", ext: "webm", w: 640, h: 480 },
  { name: "vtall", ext: "mp4", w: 360, h: 640 },
  { name: "vsquare", ext: "webm", w: 480, h: 480 },
  { name: "vcine", ext: "mp4", w: 840, h: 360 },
  { name: "vlong", ext: "mp4", w: 640, h: 360, seconds: 9 },
];

// The paths' story: pictures and videos of different shapes, a video
// straight after a video, the same file again after another.
const PATH_ITEMS = ({ video, picture }) => [
  picture("start", "p43.jpg", "A 4:3 picture."),
  video("wide-video", "v169", "A 16:9 video after a 4:3 picture."),
  picture("wide-picture", "pwide.jpg", "A wide picture."),
  video("square-video", "v43", "A 4:3 WebM video after it."),
  video("tall-video", "vtall", "A portrait video straight after."),
  video("wide-again", "v169", "The 16:9 video again, after a video."),
  picture("end", "p43.jpg", "The end."),
];

/**
 * A folder of synthetic media and the built player, under the scenario
 * root; `layout({ video, picture, range })` lists its items.
 */
function buildFolder(name, layout = PATH_ITEMS) {
  const dir = join(scenarioRoot, `videofit-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const ff = (...args) =>
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args], {
      stdio: "pipe",
    });
  for (const v of VIDEOS) {
    const codec =
      v.ext === "mp4"
        ? ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
        : ["-c:v", "libvpx-vp9", "-b:v", "100k", "-pix_fmt", "yuv420p"];
    ff(
      "-f",
      "lavfi",
      "-i",
      `color=c=0x00ff00:s=${v.w}x${v.h}:r=30:d=${v.seconds ?? 4}`,
      ...codec,
      join(dir, `${v.name}.${v.ext}`),
    );
    ff(
      "-f",
      "lavfi",
      "-i",
      `color=c=0x0000ff:s=${v.w}x${v.h}:d=1`,
      "-frames:v",
      "1",
      join(dir, `${v.name}.poster.jpg`),
    );
  }
  for (const [pic, size] of [
    ["p43", "800x600"],
    ["pwide", "1260x540"],
  ]) {
    ff(
      "-f",
      "lavfi",
      "-i",
      `color=c=0xff0000:s=${size}:d=1`,
      "-frames:v",
      "1",
      join(dir, `${pic}.jpg`),
    );
  }
  const video = (id, name, text) => {
    const v = VIDEOS.find((x) => x.name === name);
    return {
      id,
      type: "video",
      file: `${v.name}.${v.ext}`,
      poster: `${v.name}.poster.jpg`,
      durationSeconds: v.seconds ?? 4,
      text,
    };
  };
  // A range of the 9 s file (its poster is the file's: solid blue anyway).
  const range = (id, startSeconds, endSeconds, text) => ({
    ...video(id, "vlong", text),
    startSeconds,
    endSeconds,
  });
  const picture = (id, file, text) => ({ id, type: "image", file, text });
  const manifest = {
    schemaVersion: 1,
    storyId: `videofit-${name}`,
    title: "Video fit",
    width: 640,
    height: 360,
    items: layout({ video, picture, range }),
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(
    join(dir, "manifest.js"),
    `window.KINETIC_MANIFEST = ${JSON.stringify(manifest)};\n`,
  );
  for (const file of ["index.html", "app.js"]) {
    copyFileSync(join(playerDir, "dist", file), join(dir, file));
  }
  return dir;
}

// The green (frames), blue (poster) and red (picture) boxes of a
// screenshot, read through a canvas in the page, and how many pixels of
// each lie outside `rect` grown by 2 px (an edge pixel of the poster under
// a frame's antialiased border is not a stale still).
const COLOUR_BOXES = async (png, rect) => {
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const [rx, ry, rw, rh] = rect;
  const boxes = {};
  const outside = { frames: 0, poster: 0, picture: 0 };
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const i = (y * canvas.width + x) * 4;
      const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
      let k = null;
      if (g > 25 && g > 2 * r + 10 && g > 2 * b + 10) k = "frames";
      else if (b > 25 && b > 2 * r + 10 && b > 2 * g + 10) k = "poster";
      else if (r > 25 && r > 2 * g + 10 && r > 2 * b + 10) k = "picture";
      if (k === null) continue;
      const box = boxes[k] ?? { x0: x, y0: y, x1: x, y1: y };
      box.x0 = Math.min(box.x0, x);
      box.y0 = Math.min(box.y0, y);
      box.x1 = Math.max(box.x1, x);
      box.y1 = Math.max(box.y1, y);
      boxes[k] = box;
      if (x < rx - 2 || y < ry - 2 || x >= rx + rw + 2 || y >= ry + rh + 2) {
        outside[k] += 1;
      }
    }
  }
  const out = { outside };
  for (const [k, b] of Object.entries(boxes)) {
    out[k] = [b.x0, b.y0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1];
  }
  return out;
};

// The page's side: the item on screen, the stage, the video element's box,
// own size and state, and the picture element's.
const VIDEO_FACTS = () => {
  const stage = document.getElementById("stage");
  const v = document.getElementById("visual-video");
  const img = document.getElementById("visual-image");
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  };
  return {
    item: stage?.getAttribute("data-item") ?? null,
    stage: stage ? rect(stage) : null,
    video:
      v && getComputedStyle(v).display !== "none"
        ? {
            box: rect(v),
            size: [v.videoWidth, v.videoHeight],
            paused: v.paused,
            readyState: v.readyState,
          }
        : null,
    picture: img ? getComputedStyle(img).display !== "none" : false,
  };
};

/**
 * The video on screen measured: its frames' painted box against the box
 * `contain` gives its own size in the stage (or, for a still, the poster's
 * box), and no picture beside it.
 */
async function measureVideo(page) {
  // A frame presented since the last change, then the page and a screenshot.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const v = document.getElementById("visual-video");
        if (!v || typeof v.requestVideoFrameCallback !== "function") {
          setTimeout(resolve, 100);
          return;
        }
        const timer = setTimeout(resolve, 600);
        v.requestVideoFrameCallback(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  );
  const facts = await page.evaluate(VIDEO_FACTS);
  const png = await page.screenshot({ encoding: "base64" });
  const after = await page.evaluate(VIDEO_FACTS);
  const v = facts.video;
  if (v === null || facts.stage === null) {
    return { ok: false, why: "no video shown", facts };
  }
  if (after.item !== facts.item) {
    return { ok: false, why: "the item changed under the screenshot", facts };
  }
  const [sx, sy, sw, sh] = facts.stage;
  const fit = containFit(v.size[0], v.size[1], sw, sh);
  const want = [sx + fit.x, sy + fit.y, fit.width, fit.height].map(Math.round);
  const boxes = await page.evaluate(COLOUR_BOXES, png, want);
  // A still shows the poster, a playing video its frames, in the contain
  // box; nothing (frames, poster or a picture) shows outside it.
  const painted = v.paused ? boxes.poster : boxes.frames;
  const near = painted?.every((n, i) => Math.abs(n - want[i]) <= 3) === true;
  const boxIsStage = v.box.every((n, i) => Math.abs(n - facts.stage[i]) <= 1);
  const clear = Object.values(boxes.outside).every((n) => n === 0);
  const ok = boxIsStage && near && clear && !facts.picture;
  return { ok, item: facts.item, want, boxes, facts };
}

const brief = (m) => ({
  item: m.item ?? m.facts?.item,
  want: m.want,
  boxes: m.boxes,
  video: m.facts?.video,
  stage: m.facts?.stage,
  picture: m.facts?.picture,
  why: m.why,
});

async function itemIs(page, id, timeout = 3000) {
  const until = Date.now() + timeout;
  for (;;) {
    const now = await page.evaluate(
      () => document.getElementById("stage")?.getAttribute("data-item") ?? null,
    );
    if (now === id) return true;
    if (Date.now() > until) return false;
    await sleep(40);
  }
}

async function spaceUntil(page, cdp, id, limit = 12) {
  for (let n = 0; n < limit; n += 1) {
    if (await itemIs(page, id, 0)) return true;
    await pressSpace(cdp);
    await sleep(120);
  }
  return itemIs(page, id, 1000);
}

// Space onto each video (after a picture, after another video, of each
// shape), the wheel back onto a video and forward again, a jump to the
// furthest item and skip: each video item fills the stage.
async function reading({ check, open }) {
  const folder = buildFolder("reading");
  const { page, cdp } = await open("videofit-reading", {
    closeHelp: true,
    folder,
  });
  await page.setViewport({ width: 1280, height: 720 });
  const onto = async (label, id) => {
    const reached = await spaceUntil(page, cdp, id);
    const m = await measureVideo(page);
    check(label, reached && m.ok, brief(m));
  };
  await onto(
    "Space onto a 16:9 video after a 4:3 picture: it fills the stage",
    "wide-video",
  );
  await onto(
    "Space onto a 4:3 WebM video after a wide picture: it fills the stage",
    "square-video",
  );
  await onto(
    "Space onto a portrait video straight after a video: it fills the stage",
    "tall-video",
  );
  await onto(
    "Space onto a 16:9 video straight after the portrait one: it fills the stage",
    "wide-again",
  );

  await wheel(cdp, true, 1);
  const back = (await itemIs(page, "tall-video")) && (await measureVideo(page));
  check(
    "the wheel back onto a video: its still fills the stage as the poster",
    back !== false && back.ok,
    back === false ? "did not reach tall-video" : brief(back),
  );
  await wheel(cdp, false, 1);
  const forward =
    (await itemIs(page, "wide-again")) && (await measureVideo(page));
  check(
    "the wheel forward onto a video: it fills the stage",
    forward !== false && forward.ok,
    forward === false ? "did not reach wide-again" : brief(forward),
  );
  await pressSpace(cdp);
  await itemIs(page, "end");
  await wheel(cdp, true, 1);
  await itemIs(page, "wide-again");
  await pressSpace(cdp);
  await pressSpace(cdp);
  await itemIs(page, "end");
  // Back to the first video, then `e` to the furthest item read...
  await wheel(cdp, true, 5);
  await itemIs(page, "wide-video");
  await pressE(cdp);
  const atEnd = await itemIs(page, "end");
  await wheel(cdp, true, 1);
  const jumped =
    atEnd && (await itemIs(page, "wide-again")) && (await measureVideo(page));
  check(
    "a jump (e) and a wheel notch back onto a video: it fills the stage",
    jumped !== false && jumped.ok,
    jumped === false ? "did not reach wide-again" : brief(jumped),
  );
}

// Skip: a burst that stops on a video (the furthest item read), and with
// "Play videos in full" on, a burst that plays a video: each fills the
// stage.
async function skip({ check, open }) {
  const folder = buildFolder("skip");
  const { page, cdp } = await open("videofit-skip", {
    closeHelp: true,
    folder,
  });
  await page.setViewport({ width: 1280, height: 720 });
  await spaceUntil(page, cdp, "wide-again");
  await sleep(300);
  await wheel(cdp, true, 5);
  await itemIs(page, "start");
  await pressTab(cdp);
  const stopped =
    (await itemIs(page, "wide-again", 5000)) && (await measureVideo(page));
  check(
    "skip stopping on a video (the furthest item read): it fills the stage",
    stopped !== false && stopped.ok,
    stopped === false ? "skip did not stop on wide-again" : brief(stopped),
  );

  await openSettings(page, cdp);
  const rect = await page.evaluate(() => {
    const r = document
      .querySelector(".config-skip-videos")
      .getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
  await clickCenter(cdp, rect);
  const on = await page.evaluate(() =>
    document.querySelector(".config-skip-videos").getAttribute("aria-pressed"),
  );
  await closeSettings(page, cdp);
  await wheel(cdp, true, 5);
  await itemIs(page, "start");
  await pressTab(cdp);
  const played =
    (await itemIs(page, "wide-video", 3000)) && (await measureVideo(page));
  check(
    "skip playing a video in full: it fills the stage",
    on === "true" &&
      played !== false &&
      played.ok &&
      !played.facts.video.paused,
    played === false
      ? { on, why: "skip did not reach wide-video" }
      : { on, ...brief(played) },
  );
  await pressTab(cdp);
}

// A restore (reload) landing on a video, a resize while one is shown and
// while it is hidden behind a picture, a screen-sized viewport (what a
// fullscreen change does to the page), and the first video after a load
// opened at it (#start=): each fills the stage.
async function changes({ check, open }) {
  const folder = buildFolder("changes");
  const { page, cdp } = await open("videofit-changes", {
    closeHelp: true,
    folder,
  });
  await page.setViewport({ width: 1280, height: 720 });
  await spaceUntil(page, cdp, "square-video");
  await sleep(300);
  await page.reload();
  // The reload lands on the saved item (behind the key help, if it shows).
  await dismissHelp(page, cdp);
  const restored =
    (await itemIs(page, "square-video", 5000)) && (await measureVideo(page));
  check(
    "a restore landing on a video: it fills the stage",
    restored !== false && restored.ok,
    restored === false ? "did not restore onto square-video" : brief(restored),
  );

  await page.setViewport({ width: 1000, height: 800 });
  await sleep(200);
  const resized = await measureVideo(page);
  check(
    "a resize while a video is shown: it fills the new stage",
    resized.ok,
    brief(resized),
  );

  await spaceUntil(page, cdp, "tall-video");
  await wheel(cdp, true, 2);
  await itemIs(page, "wide-picture");
  await page.setViewport({ width: 1440, height: 900 });
  await sleep(200);
  await pressSpace(cdp);
  const afterHidden =
    (await itemIs(page, "square-video")) && (await measureVideo(page));
  check(
    "a resize while the video is hidden behind a picture, then Space onto it: it fills the stage",
    afterHidden !== false && afterHidden.ok,
    afterHidden === false ? "did not reach square-video" : brief(afterHidden),
  );

  await page.setViewport({ width: 1920, height: 1080 });
  await sleep(200);
  const screen = await measureVideo(page);
  check(
    "the page grown to a screen's size (a fullscreen change) under a video: it fills the stage",
    screen.ok,
    brief(screen),
  );

  const started = await open("videofit-start", {
    closeHelp: true,
    folder,
    hash: "#start=tall-video",
  });
  await started.page.setViewport({ width: 1920, height: 1080 });
  const first =
    (await itemIs(started.page, "tall-video", 5000)) &&
    (await measureVideo(started.page));
  check(
    "the first video after a load opened at it: it fills the stage",
    first !== false && first.ok,
    first === false ? "did not open at tall-video" : brief(first),
  );
}

// A walk over many videos of different shapes and codecs, with pictures,
// a text line and ranges of one file between them: the page never holds
// more than one <video>, each new file gets its own element while the
// ranges of one file share one, and every element let go has no source and
// is emptied (no media player left behind).
async function elements({ check, open }) {
  const folder = buildFolder("elements", ({ video, picture, range }) => [
    picture("start", "p43.jpg", "Start."),
    video("e1", "v169", "16:9."),
    video("e2", "v43", "4:3 WebM straight after."),
    picture("p1", "pwide.jpg", "A picture."),
    video("e3", "vtall", "Portrait."),
    range("r1", 0, 3, "A range of the long file."),
    range("r2", 3, 6, "The next range of it."),
    range("r3", 6, 9, "And the last."),
    video("e4", "vsquare", "Square WebM."),
    { id: "line", type: "text", text: "A line over it." },
    video("e5", "vcine", "Wide."),
    picture("p2", "p43.jpg", "Another picture."),
    video("e6", "v169", "16:9 again."),
    video("e7", "v43", "4:3 again."),
    video("e8", "vtall", "Portrait again."),
    video("e9", "vtall", "The same file, the next item."),
    picture("end", "pwide.jpg", "The end."),
  ]);
  const { page, cdp } = await open("videofit-elements", {
    closeHelp: true,
    folder,
  });
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluate(() => {
    const rec = { elements: [], most: 0 };
    window.__videoElements = rec;
    new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node.tagName === "VIDEO" && !rec.elements.includes(node)) {
            rec.elements.push(node);
          }
        }
      }
      rec.most = Math.max(rec.most, document.querySelectorAll("video").length);
    }).observe(document.body, { childList: true, subtree: true });
    const frame = () => {
      rec.most = Math.max(rec.most, document.querySelectorAll("video").length);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const sources = [];
  let reached = false;
  for (let n = 0; n < 24; n += 1) {
    await pressSpace(cdp);
    await sleep(450);
    const now = await page.evaluate(() => {
      const v = document.getElementById("visual-video");
      return {
        item: document.getElementById("stage")?.getAttribute("data-item"),
        src:
          v && getComputedStyle(v).display !== "none"
            ? v.getAttribute("src")
            : null,
      };
    });
    if (now.src !== null && sources.at(-1) !== now.src) sources.push(now.src);
    if (now.src === null) sources.push(null);
    if (now.item === "end") {
      reached = true;
      break;
    }
  }
  const facts = await page.evaluate(() => {
    const rec = window.__videoElements;
    const current = document.getElementById("visual-video");
    return {
      most: rec.most,
      inPage: document.querySelectorAll("video").length,
      made: rec.elements.length,
      released: rec.elements
        .filter((v) => v !== current)
        .map((v) => ({
          connected: v.isConnected,
          src: v.getAttribute("src"),
          networkState: v.networkState,
          readyState: v.readyState,
        })),
    };
  });
  // One element per run of one file between other visuals.
  const runs = sources.filter(
    (src, i) => src !== null && sources[i - 1] !== src,
  );
  check(
    "a walk over many videos never holds more than one <video>",
    reached && facts.most === 1 && facts.inPage <= 1,
    { reached, most: facts.most, inPage: facts.inPage },
  );
  check(
    "each new file gets a fresh <video>; the ranges of one file share one",
    reached && facts.made === runs.length && runs.length === 9,
    { made: facts.made, runs },
  );
  check(
    "each <video> let go has no source left and is out of the page",
    facts.released.length === facts.made - 1 &&
      facts.released.every(
        (v) =>
          !v.connected &&
          v.src === null &&
          v.networkState === 0 &&
          v.readyState === 0,
      ),
    facts.released,
  );
}

export const parts = [reading, skip, changes, elements];
