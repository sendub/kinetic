// Loops at a file's end (docs/plan.md Phase 50): a pass that ends at its
// file's end loops back at every end, on every engine and container. WebKit
// sends `pause` and `ended` only at a Matroska or WebM file's first end and
// then holds on its last frame, so the player takes the file's end from
// whichever comes first of the frame callback presenting the last frame
// (plus one frame interval), a `timeupdate` at the duration and the native
// `ended`, each end handled once.
//
// Synthetic clips made by PATH ffmpeg (6 s, 25 fps, no sound, the last
// frame at 5.96, one frame before the duration): VP9 in `.mkv`, VP9 in
// `.webm` and H.264 in `.mp4`. Each part copies the demo folder under the
// scenario root, adds its clip and its case after the demo's items, opens
// it on a fresh browser and reads the stage video's time every 30 ms in the
// page. A wrap is the time going back more than 0.5 s; a good one leaves
// from the file's end (5.8 s or later) and lands on the case's loop start.
//
// Cases, per container:
// - chain: a range from 1.5 s to the file's end, looping from 4 s, under a
//   line: 3 wraps to 4 s;
// - counted: the same range played standalone with `loopCount` 3, auto on
//   and a text hold longer than its passes: 2 wraps to 4 s, then it holds
//   paused at the end and the machine moves on once the hold runs out (a
//   pass reported twice for one end would hold after 1 wrap, a pass never
//   reported would never move on);
// - segment: a standalone item playing 0-1.5 s whose one segment runs
//   from 3 s to the file's end looping from 4 s, stepped by Space from its
//   held end: 3 wraps to 4 s;
// - free: no range under a line (the element looped natively before
//   Phase 50): 3 wraps to 0;
// - nextdown: a chain range whose `endSeconds` is one float step below the
//   duration (no frame reaches it): 3 wraps to 4 s at the file's end.

import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  demoDir,
  pressA,
  pressSpace,
  scenarioRoot,
  sleep,
} from "./harness.mjs";

export const title =
  "a pass ending at its file's end loops back at every end (.mkv, .webm, .mp4)";

const DURATION = 6;
const START = 1.5;
const LOOP = 4;
// A wrap leaves from the file's end: the last frame is at 5.96.
const FROM_END = 5.8;

const CONTAINERS = {
  mkv: ["-c:v", "libvpx-vp9", "-b:v", "200k", "-deadline", "realtime"],
  webm: ["-c:v", "libvpx-vp9", "-b:v", "200k", "-deadline", "realtime"],
  mp4: ["-c:v", "libx264", "-movflags", "+faststart"],
};

// The largest double below `x` (Math.nextDown).
function nextDown(x) {
  const f = new Float64Array([x]);
  const u = new BigInt64Array(f.buffer);
  u[0] -= 1n;
  return f[0];
}

// A counted item's text: its hold, 180 characters at 60 ms each (the
// default speed), outlasts its passes (4.5 + 2 + 2 s) by about 2 s.
const LONG_TEXT =
  "A counted clip: three passes, each loop from four seconds.".padEnd(
    180,
    " It holds at its end until this line has been read.",
  );

const CASES = {
  chain: {
    loopStart: LOOP,
    wraps: 3,
    budgetMs: 20000,
    items: (video, line) => [
      video({ startSeconds: START, loopStartSeconds: LOOP }, "A chain range."),
      line(),
    ],
  },
  counted: {
    loopStart: LOOP,
    wraps: 2,
    budgetMs: 20000,
    items: (video) => [
      video(
        { startSeconds: START, loopStartSeconds: LOOP, loopCount: 3 },
        LONG_TEXT,
      ),
    ],
  },
  segment: {
    loopStart: LOOP,
    wraps: 3,
    budgetMs: 16000,
    items: (video) => [
      video(
        {
          startSeconds: 0,
          endSeconds: 1.5,
          segments: [
            { startSeconds: 3, loopStartSeconds: LOOP, endSeconds: DURATION },
          ],
        },
        "A clip with one view to its file's end.",
      ),
    ],
  },
  free: {
    loopStart: 0,
    wraps: 3,
    budgetMs: 30000,
    items: (video, line) => [video({}, "A clip with no range."), line()],
  },
  nextdown: {
    loopStart: LOOP,
    wraps: 3,
    budgetMs: 20000,
    items: (video, line) => [
      video(
        {
          startSeconds: START,
          loopStartSeconds: LOOP,
          endSeconds: nextDown(DURATION),
        },
        "A range ending a float step below the duration.",
      ),
      line(),
    ],
  },
};

/** The demo copy for `ext` and `kind`: its clip, poster and case items. */
function buildFolder(ext, kind) {
  const dir = join(scenarioRoot, `fileend-${ext}-${kind}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(demoDir, dir, { recursive: true });
  const clip = `fe-clip.${ext}`;
  const ff = (...args) =>
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args], {
      stdio: "pipe",
    });
  ff(
    "-f",
    "lavfi",
    "-i",
    `testsrc2=s=320x180:r=25:d=${DURATION}`,
    ...CONTAINERS[ext],
    "-pix_fmt",
    "yuv420p",
    "-an",
    join(dir, clip),
  );
  ff("-i", join(dir, clip), "-frames:v", "1", join(dir, "fe-poster.jpg"));
  const video = (extra, text) => ({
    id: "fe-video",
    type: "video",
    file: clip,
    poster: "fe-poster.jpg",
    durationSeconds: DURATION,
    ...extra,
    text,
  });
  const line = () => ({ id: "fe-line", type: "text", text: "A line over it." });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  manifest.items.push(
    { id: "fe-pre", type: "image", file: "after-start.jpg", text: "Before." },
    ...CASES[kind].items(video, line),
    { id: "fe-after", type: "image", file: "after-start.jpg", text: "After." },
  );
  const json = JSON.stringify(manifest, null, 2);
  writeFileSync(join(dir, "manifest.json"), json);
  writeFileSync(
    join(dir, "manifest.js"),
    `window.KINETIC_MANIFEST = ${json};\n`,
  );
  return dir;
}

// In the page: every 30 ms the item on screen and the stage video's time,
// paused and seeking state; restarted by each call.
const START_LOG = () => {
  if (window.__feLog) clearInterval(window.__feLog.timer);
  const log = { reads: [] };
  window.__feLog = log;
  log.timer = setInterval(() => {
    const v = document.getElementById("visual-video");
    const shown = v?.isConnected === true && v.style.display !== "none";
    log.reads.push({
      at: performance.now(),
      item: document.getElementById("stage")?.getAttribute("data-item"),
      v: shown ? v.currentTime : null,
      paused: shown ? v.paused : null,
      seeking: shown ? v.seeking : null,
    });
  }, 30);
};
const READ_LOG = () => window.__feLog.reads;
const ON_ITEM = (id) =>
  document.getElementById("stage")?.getAttribute("data-item") === id;

/**
 * The wraps of the video in `reads` (on the case's item): `good` those
 * leaving from the file's end and landing on `loopStart`, `bad` any other.
 */
function wrapsOf(reads, loopStart) {
  const on = reads.filter((r) => r.item === "fe-video" && r.v !== null);
  const good = [];
  const bad = [];
  for (let i = 1; i < on.length; i += 1) {
    const [from, to] = [on[i - 1].v, on[i].v];
    if (to >= from - 0.5) continue;
    const wrap = { at: Math.round(on[i].at), from, to };
    if (from >= FROM_END && to >= loopStart - 0.05 && to <= loopStart + 0.6) {
      good.push(wrap);
    } else {
      bad.push(wrap);
    }
  }
  return { good, bad };
}

/** How long (ms) the video's time has stood still at the end of `reads`. */
function stillFor(reads) {
  const on = reads.filter((r) => r.v !== null);
  const last = on.at(-1);
  if (last === undefined) return 0;
  let since = last.at;
  for (let i = on.length - 1; i >= 0 && on[i].v === last.v; i -= 1) {
    since = on[i].at;
  }
  return last.at - since;
}

const r3 = (x) => (x === null ? null : Math.round(x * 1000) / 1000);

async function runCase({ check, open }, ext, kind) {
  const spec = CASES[kind];
  const folder = buildFolder(ext, kind);
  const { page, cdp } = await open(`${ext}-${kind}`, {
    folder,
    closeHelp: true,
    hash: "#start=fe-pre",
  });
  await page.waitForFunction(ON_ITEM, { timeout: 5000 }, "fe-pre");
  await page.evaluate(START_LOG);
  await pressSpace(cdp);
  await page.waitForFunction(ON_ITEM, { timeout: 3000 }, "fe-video");
  if (kind === "counted") await pressA(cdp);
  let stepped = true;
  if (kind === "segment") {
    // Its own 0-1.5 s pass holds at its end; Space steps to the view.
    stepped = await page
      .waitForFunction(
        () => {
          const v = document.getElementById("visual-video");
          return v?.paused && v.currentTime >= 1.4;
        },
        { timeout: 6000, polling: 30 },
      )
      .then(
        () => true,
        () => false,
      );
    await page.evaluate(START_LOG);
    await pressSpace(cdp);
  }
  const begin = Date.now();
  let reads = [];
  for (;;) {
    await sleep(300);
    reads = await page.evaluate(READ_LOG);
    const { good, bad } = wrapsOf(reads, spec.loopStart);
    if (bad.length > 0) break;
    if (kind === "counted") {
      if (reads.at(-1)?.item === "fe-after") break;
    } else if (good.length >= spec.wraps) {
      // Landed and playing on after the last wrap.
      const last = reads.at(-1);
      if (last.v !== null && last.v > spec.loopStart + 0.3) break;
    }
    // Stuck on a frame (not a counted hold) for 3 s: it will not wrap.
    if (kind !== "counted" && stillFor(reads) > 3000) break;
    if (Date.now() - begin > spec.budgetMs) break;
  }
  const { good, bad } = wrapsOf(reads, spec.loopStart);
  const last = reads.filter((r) => r.v !== null).at(-1) ?? null;
  const evidence = {
    stepped,
    good: good.map((w) => [w.at, r3(w.from), r3(w.to)]),
    bad: bad.slice(0, 4).map((w) => [w.at, r3(w.from), r3(w.to)]),
    last: last && { item: last.item, v: r3(last.v), paused: last.paused },
    stillMs: Math.round(stillFor(reads)),
  };
  if (kind === "counted") {
    // Its last read on the item: held paused at the end, for a while.
    const onItem = reads.filter((r) => r.item === "fe-video" && r.v !== null);
    const held = onItem.at(-1) ?? null;
    let heldMs = 0;
    for (let i = onItem.length - 1; i >= 0; i -= 1) {
      if (!onItem[i].paused || onItem[i].v < FROM_END) break;
      heldMs = held.at - onItem[i].at;
    }
    const movedOn = reads.at(-1)?.item === "fe-after";
    check(
      `${ext}, counted loopCount 3 to the file's end: 2 wraps to its loop start, then held paused at the end, then the machine moves on`,
      good.length === 2 &&
        bad.length === 0 &&
        held !== null &&
        held.paused === true &&
        held.v >= FROM_END &&
        heldMs >= 500 &&
        movedOn,
      {
        ...evidence,
        held: held && r3(held.v),
        heldMs: Math.round(heldMs),
        movedOn,
      },
    );
    return;
  }
  const what = {
    chain: "a chain range to the file's end",
    segment: "a last segment to the file's end, stepped by Space",
    free: "a chain with no range",
    nextdown: "a chain range ending a float step below the duration",
  }[kind];
  check(
    `${ext}, ${what}: ${spec.wraps} wraps from the file's end to its loop start (${spec.loopStart} s)`,
    stepped && good.length >= spec.wraps && bad.length === 0,
    evidence,
  );
}

export const parts = Object.keys(CONTAINERS).flatMap((ext) =>
  Object.keys(CASES).map((kind) => {
    const part = (ctx) => runCase(ctx, ext, kind);
    Object.defineProperty(part, "name", { value: `${ext}-${kind}` });
    return part;
  }),
);
