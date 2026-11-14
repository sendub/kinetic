// Video segments (docs/plan.md Phase 49, item 3; docs/content-format.md
// "Video segments"): on the last item of a video's chain, Space steps the
// video's camera views before it leaves, and the stage and the video's
// sound follow each step. Copies of fixtures/demo and fixtures/audio-demo
// under the scenario root get `segments` on existing video items; the
// fixtures themselves, and every other scenario, are unchanged.
//
// Read from the engine, never by looking or listening: an in-page log of
// the stage video's time, paused and seeking state on every animation
// frame, its `seeking` events, the item on screen (`data-item`), and, in
// the audio demo, the test hook's video sound (`#audio` `sounds()`).
//
// Parts, each on its own browser:
// - chain: on the demo's floor clip (6 s, two lines after it) Space on the
//   clip and its first line advances with no seek; on the last line each
//   press puts the video inside the stepped segment, the second segment
//   loops from its own restart point, the last one (ending at the file's
//   end) loops on the file's end, and the press after it leaves the clip;
// - back and forth: after a step the wheel back and forward again plays the
//   clip's own range from its start, no segment;
// - menu: the Esc screen pauses the video inside a segment and closing it
//   resumes it there, the loop still the segment's;
// - alone: a video item with no lines (the held WebM) steps at once, and
//   one played to its held end (range-a, 0-1 s of its file) steps to a
//   segment past its own range;
// - sound: on the audio demo's video, whose sound is the master clock, the
//   sound restarts at each stepped segment and loops it with the video
//   staying on it, a step pressed just before the segment's loop wraps
//   included (the sound must not stay a loop behind).

import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  audioDemoDir,
  closeSettings,
  demoDir,
  openSettings,
  pressSpace,
  scenarioRoot,
  sleep,
  wheelUntil,
} from "./harness.mjs";

export const title =
  "video segments: Space steps a video's views, the stage and its sound follow";

const AUDIO_HINT =
  "fixtures/audio-demo is missing: build it with .venv/bin/python fixtures/build_audio_demo.py";

// A time this close to a segment's bounds is inside it: rVFC sees the end
// a frame late (40 ms at 25 fps) and `timeupdate` up to 250 ms late.
const EPS = 0.1;
// A video more than 80 ms from its sound is out of step (the player's
// bound, audiorules.ts VIDEO_SYNC_S, as videosound.scenario.mjs judges).
const SYNC_S = 0.08;
// Reads this soon after a seek of the video are not judged against the
// sound: the seek is landing (a wrap's restart included).
const SEEK_SETTLE_MS = 150;

const FLOOR = [
  { startSeconds: 0, endSeconds: 1.5 },
  { startSeconds: 1.5, loopStartSeconds: 2, endSeconds: 3 },
  { startSeconds: 3.5, endSeconds: 5 },
  { startSeconds: 5, endSeconds: 6 }, // to the file's end
];
const HOLD = [
  { startSeconds: 0, endSeconds: 0.8 },
  { startSeconds: 1, endSeconds: 2 }, // to the file's end
];
// range-a plays 0-1 s of its 2 s file: the segment lies past its range.
const RANGE_A = [{ startSeconds: 1.2, endSeconds: 2 }];
// The audio demo's video plays 2-8 s and loops back to 4 s under its lines.
const SYNC = [
  { startSeconds: 2.5, endSeconds: 4 },
  { startSeconds: 4.5, loopStartSeconds: 5, endSeconds: 6.5 },
  { startSeconds: 6.5, endSeconds: 8 }, // touching, to the file's end
];

/**
 * A fresh copy of `from` at `name` with `segments[id]` added to its items;
 * the folder, or null when `from` has no manifest (not built).
 */
function withSegments(from, name, segments) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(from, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
  const folder = join(scenarioRoot, name);
  rmSync(folder, { recursive: true, force: true });
  cpSync(from, folder, { recursive: true });
  for (const it of manifest.items) {
    if (segments[it.id] !== undefined) it.segments = segments[it.id];
  }
  const json = JSON.stringify(manifest, null, 2);
  writeFileSync(join(folder, "manifest.json"), json);
  writeFileSync(
    join(folder, "manifest.js"),
    `window.KINETIC_MANIFEST = ${json};\n`,
  );
  return folder;
}

const ON_ITEM = (id) =>
  document.getElementById("stage")?.getAttribute("data-item") === id;

// In the page: on every animation frame the item on screen, the stage
// video's time, paused and seeking state, and the hook's video sound (its
// time and whether it plays); every `seeking` of a stage video, with its
// time then. Restarted by each call; `STOP_LOG` returns it.
const START_LOG = () => {
  if (window.__segLog) window.__segLog.on = false;
  const log = { reads: [], seeks: [], on: true };
  window.__segLog = log;
  const watched = new WeakSet();
  const frame = () => {
    if (!log.on) return;
    const video = document.getElementById("visual-video");
    const shown = video?.isConnected === true && video.style.display !== "none";
    if (shown && !watched.has(video)) {
      watched.add(video);
      video.addEventListener("seeking", () => {
        if (log.on) {
          log.seeks.push({ at: performance.now(), to: video.currentTime });
        }
      });
    }
    const sound = (document.getElementById("audio")?.sounds?.() ?? []).find(
      (s) => s.slot === "video" && s.track !== "",
    );
    log.reads.push({
      at: performance.now(),
      item: document.getElementById("stage")?.getAttribute("data-item"),
      v: shown ? video.currentTime : null,
      paused: shown ? video.paused : null,
      seeking: shown ? video.seeking : null,
      a: sound?.currentTime ?? null,
      ap: sound === undefined ? null : sound.paused,
    });
    requestAnimationFrame(frame);
  };
  frame();
  return performance.now();
};
const STOP_LOG = () => {
  const log = window.__segLog ?? { reads: [], seeks: [] };
  log.on = false;
  return { reads: log.reads, seeks: log.seeks };
};

/** Logs for `ms` (after `during`, if given); `{ reads, seeks, from, out }`. */
async function record(page, ms, during = async () => undefined) {
  const from = await page.evaluate(START_LOG);
  const out = await during();
  await sleep(ms);
  return { ...(await page.evaluate(STOP_LOG)), from, out };
}

/** The stage video's time, paused state and the item on screen, now. */
const NOW = () => {
  const video = document.getElementById("visual-video");
  return {
    item: document.getElementById("stage")?.getAttribute("data-item"),
    v: video?.currentTime ?? null,
    paused: video?.paused ?? null,
    seeking: video?.seeking ?? null,
  };
};

/**
 * Waits until the stage video plays, not seeking, at a time in [lo, hi],
 * polling every few ms so a press after it lands near that time.
 */
async function videoBetween(page, lo, hi, timeout = 8000) {
  return page
    .waitForFunction(
      (a, b) => {
        const v = document.getElementById("visual-video");
        return (
          v !== null &&
          !v.paused &&
          !v.seeking &&
          v.currentTime >= a &&
          v.currentTime <= b
        );
      },
      { timeout, polling: 5 },
      lo,
      hi,
    )
    .then(
      () => true,
      () => false,
    );
}

/** Polls `NOW` until `ok(now)`; `{ ok, s }` with the last reading. */
async function waitNow(page, ok, timeout = 3000) {
  const until = Date.now() + timeout;
  for (;;) {
    const s = await page.evaluate(NOW);
    if (ok(s)) return { ok: true, s };
    if (Date.now() >= until) return { ok: false, s };
    await sleep(20);
  }
}

const inside = (t, lo, hi) => t !== null && t >= lo - EPS && t <= hi + EPS;
const lowest = (seg) =>
  Math.min(seg.startSeconds, seg.loopStartSeconds ?? seg.startSeconds);

/**
 * How the video played `seg` over `reads` (from where it first stood
 * inside it): `settled` whether it got there, `outside` the reads outside
 * it once there, `wraps` how often it went back (0.3 s or more), and
 * `belowLoop` the reads after the first wrap before its restart point.
 */
function segmentRun(reads, seg) {
  const shown = reads.filter((s) => s.v !== null && !s.seeking);
  const first = shown.findIndex(
    (s) => !s.paused && inside(s.v, seg.startSeconds, seg.endSeconds),
  );
  if (first < 0) {
    return { settled: false, outside: [], wraps: 0, belowLoop: [] };
  }
  const run = shown.slice(first);
  const outside = run.filter((s) => !inside(s.v, lowest(seg), seg.endSeconds));
  let wraps = 0;
  let wrapped = false;
  const belowLoop = [];
  const restart = seg.loopStartSeconds ?? seg.startSeconds;
  for (let i = 1; i < run.length; i += 1) {
    if (run[i].v < run[i - 1].v - 0.3) {
      wraps += 1;
      wrapped = true;
    }
    if (wrapped && run[i].v < restart - EPS) belowLoop.push(run[i]);
  }
  return {
    settled: true,
    outside: outside.slice(0, 4),
    outsideCount: outside.length,
    wraps,
    belowLoop: belowLoop.slice(0, 4),
    span: [Math.min(...run.map((s) => s.v)), Math.max(...run.map((s) => s.v))],
  };
}

/** Plays `seg` from shortly after the press, wrapping at least `wraps` times. */
const playedSegment = (r, wraps = 0) =>
  r.settled &&
  r.outsideCount === 0 &&
  r.belowLoop.length === 0 &&
  r.wraps >= wraps;

/** Presses Space and logs `ms`: `{ reads, seeks, before }`. */
async function pressAndRecord(page, cdp, ms) {
  const before = await page.evaluate(NOW);
  const run = await record(page, ms, () => pressSpace(cdp));
  return { ...run, before };
}

// ---------------------------------------------------------------------------

function demoWithSegments(name) {
  return withSegments(demoDir, name, {
    "floor-clip": FLOOR,
    "video-hold": HOLD,
    "range-a": RANGE_A,
  });
}

/** Opens `folder` at `start` and reads onto `onto` by Space presses. */
async function openAt(open, name, folder, start, path) {
  const session = await open(name, {
    folder,
    closeHelp: true,
    hash: `#start=${start}`,
  });
  const { page, cdp } = session;
  await page.waitForFunction(ON_ITEM, { timeout: 5000 }, start).catch(() => {});
  for (const id of path) {
    await pressSpace(cdp);
    await page.waitForFunction(ON_ITEM, { timeout: 3000 }, id).catch(() => {});
  }
  return session;
}

async function chain({ check, open }) {
  const folder = demoWithSegments("seg-demo-chain");
  const { page, cdp } = await openAt(open, "seg-chain", folder, "floor-title", [
    "floor-clip",
  ]);
  // Space on the clip and on its first line: a line each, no seek.
  const onClip = await waitNow(
    page,
    (s) => s.item === "floor-clip" && s.paused === false,
  );
  const lines = await record(page, 300, async () => {
    await pressSpace(cdp);
    await page
      .waitForFunction(ON_ITEM, { timeout: 3000 }, "floor-2")
      .catch(() => {});
    await pressSpace(cdp);
    await page
      .waitForFunction(ON_ITEM, { timeout: 3000 }, "floor-3")
      .catch(() => {});
  });
  const after = await page.evaluate(NOW);
  check(
    "Space on a video item and on a line that is not its chain's last advances a line each, the video playing on unsought",
    onClip.ok &&
      after.item === "floor-3" &&
      after.paused === false &&
      lines.seeks.length === 0,
    { onClip: onClip.s, after, seeks: lines.seeks },
  );

  // On the last line, inside the first segment: Space steps to the second.
  const timed = await videoBetween(page, 0.2, 0.9);
  const second = await pressAndRecord(page, cdp, 3200);
  const secondRun = segmentRun(second.reads, FLOOR[1]);
  check(
    "on the chain's last line Space puts the video in the first segment starting after its time, which then loops from its own restart point",
    timed &&
      second.reads.every((s) => s.item === "floor-3") &&
      playedSegment(secondRun, 2),
    { timed, before: second.before, ...secondRun },
  );

  // The next press, by index: the third segment, then the last, which ends
  // at the file's end and loops there.
  const third = await pressAndRecord(page, cdp, 1200);
  const thirdRun = segmentRun(third.reads, FLOOR[2]);
  const last = await pressAndRecord(page, cdp, 2600);
  const lastRun = segmentRun(last.reads, FLOOR[3]);
  check(
    "each later press steps to the next segment by index; the last segment, ending at the file's end, loops on it",
    playedSegment(thirdRun) &&
      playedSegment(lastRun, 1) &&
      last.reads.every((s) => s.item === "floor-3"),
    { third: thirdRun, last: lastRun },
  );

  // With no later segment the press leaves the clip.
  await pressSpace(cdp);
  const left = await waitNow(page, (s) => s.item === "branch-title");
  check(
    "the press after the last segment advances past the video",
    left.ok,
    left.s,
  );
}

async function backAndForth({ check, open }) {
  const folder = demoWithSegments("seg-demo-wheel");
  const { page, cdp } = await openAt(open, "seg-wheel", folder, "floor-title", [
    "floor-clip",
    "floor-2",
    "floor-3",
  ]);
  const timed = await videoBetween(page, 0.2, 0.9);
  const stepped = await pressAndRecord(page, cdp, 800);
  const steppedRun = segmentRun(stepped.reads, FLOOR[1]);
  await wheelUntil(page, cdp, true, ON_ITEM, "floor-2", 3);
  const still = await waitNow(
    page,
    (s) => s.item === "floor-2" && s.paused === true,
  );
  const back = await record(page, 4200, () =>
    wheelUntil(page, cdp, false, ON_ITEM, "floor-3", 3),
  );
  const played = back.reads.filter(
    (s) => s.item === "floor-3" && s.v !== null && s.paused === false,
  );
  const startsAt = played[0]?.v ?? null;
  const reached = Math.max(...played.map((s) => s.v));
  let wentBack = false;
  for (let i = 1; i < played.length; i += 1) {
    if (played[i].v < played[i - 1].v - 0.3) wentBack = true;
  }
  check(
    "after a step, the wheel back (a poster) and forward again play the clip's own range from its start, no segment",
    timed &&
      playedSegment(steppedRun) &&
      still.ok &&
      startsAt !== null &&
      startsAt < 0.6 &&
      reached > FLOOR[1].endSeconds + 0.3 &&
      !wentBack,
    { stepped: steppedRun, still: still.s, startsAt, reached, wentBack },
  );
}

async function menu({ check, open }) {
  const folder = demoWithSegments("seg-demo-menu");
  const { page, cdp } = await openAt(open, "seg-menu", folder, "floor-title", [
    "floor-clip",
    "floor-2",
    "floor-3",
  ]);
  const timed = await videoBetween(page, 0.2, 0.9);
  await pressSpace(cdp);
  const inSegment = await videoBetween(page, 2.1, 2.6, 4000);
  await openSettings(page, cdp);
  const paused = await waitNow(page, (s) => s.paused === true);
  await sleep(500);
  const held = await page.evaluate(NOW);
  const resumed = await record(page, 2600, () => closeSettings(page, cdp));
  const resumedRun = segmentRun(resumed.reads, FLOOR[1]);
  const firstPlaying = resumed.reads.find(
    (s) => s.v !== null && s.paused === false,
  );
  check(
    "the Esc screen pauses the video inside its segment; closing it resumes there, and the segment's loop goes on",
    timed &&
      inSegment &&
      paused.ok &&
      inside(held.v, FLOOR[1].startSeconds, FLOOR[1].endSeconds) &&
      firstPlaying !== undefined &&
      Math.abs(firstPlaying.v - held.v) < 0.3 &&
      playedSegment(resumedRun, 1),
    { held, firstPlaying, ...resumedRun },
  );
}

async function alone({ check, open }) {
  const folder = demoWithSegments("seg-demo-alone");
  const { page, cdp } = await openAt(
    open,
    "seg-alone",
    folder,
    "video-hold",
    [],
  );
  // No lines after it: the first Space steps at once.
  const timed = await videoBetween(page, 0.1, 0.6);
  const step = await pressAndRecord(page, cdp, 2600);
  const stepRun = segmentRun(step.reads, HOLD[1]);
  check(
    "on a video item with no lines Space steps at once, and the segment ending at the file's end loops there",
    timed &&
      step.reads.every((s) => s.item === "video-hold") &&
      playedSegment(stepRun, 1),
    { timed, before: step.before, ...stepRun },
  );
  await pressSpace(cdp);
  const onRange = await waitNow(page, (s) => s.item === "range-a");
  // range-a plays its one 0-1 s pass and holds at its end; its segment lies
  // past that range.
  const heldEnd = await waitNow(
    page,
    (s) => s.item === "range-a" && s.paused === true && s.v >= 0.9,
    4000,
  );
  const past = await pressAndRecord(page, cdp, 2400);
  const pastRun = segmentRun(past.reads, RANGE_A[0]);
  check(
    "the press after the last segment leaves; a video held at its range's end steps to a segment past its range, which plays and loops",
    onRange.ok &&
      heldEnd.ok &&
      past.reads.every((s) => s.item === "range-a") &&
      playedSegment(pastRun, 1),
    { onRange: onRange.s, heldEnd: heldEnd.s, ...pastRun },
  );
}

// --- the video's sound -------------------------------------------------------

/** `off` (s), the short way round the loop of `seg`. */
function across(off, seg) {
  const span = seg.endSeconds - (seg.loopStartSeconds ?? seg.startSeconds);
  if (off > span / 2) return off - span;
  if (off < -span / 2) return off + span;
  return off;
}

/**
 * The video's sound against `seg` over a recording: from where the video
 * first stood inside the segment, the reads where both play and no seek
 * of the video landed within SEEK_SETTLE_MS are judged (`judged`, the
 * first three after the sound came back left out while it starts again).
 * Every one must have the sound inside the segment (`outside`: a sound
 * left on the old loop, or a loop behind, plays outside it). Each more
 * than SYNC_S from the video, the short way round the loop, is `off`; a
 * few are allowed (`offAllowed`), as videosound.scenario.mjs leaves out
 * the frames where a loaded browser is late with a wrap's restart.
 */
function soundRun({ reads, seeks }, seg) {
  const first = reads.findIndex(
    (s) =>
      s.v !== null &&
      !s.seeking &&
      !s.paused &&
      inside(s.v, seg.startSeconds, seg.endSeconds),
  );
  const run = first < 0 ? [] : reads.slice(first);
  const settled = run.filter(
    (s) =>
      s.a !== null &&
      s.ap === false &&
      s.v !== null &&
      !s.seeking &&
      !s.paused &&
      !seeks.some((k) => s.at >= k.at && s.at < k.at + SEEK_SETTLE_MS),
  );
  const judged = settled.slice(3);
  const offs = judged.map((s) => Math.round(across(s.a - s.v, seg) * 1000));
  const outside = judged.filter(
    (s) => !inside(s.a, lowest(seg), seg.endSeconds),
  );
  const off = judged.filter((_, i) => Math.abs(offs[i]) > SYNC_S * 1000);
  return {
    judged: judged.length,
    outside: outside.length,
    outsideList: outside.slice(0, 4).map((s) => ({ v: s.v, a: s.a })),
    off: off.length,
    offAllowed: Math.max(3, Math.floor(judged.length / 20)),
    offList: off.slice(0, 4).map((s) => ({ v: s.v, a: s.a })),
    offMs:
      offs.length === 0
        ? null
        : { min: Math.min(...offs), max: Math.max(...offs) },
  };
}

/** The sound played `seg` with its video, judged over enough reads. */
const soundFollowed = (r) =>
  r.judged > 20 && r.outside === 0 && r.off <= r.offAllowed;

async function sound({ check, open, folders }) {
  if (!folders.audioDemo) {
    check("fixtures/audio-demo is built", false, AUDIO_HINT);
    return;
  }
  const folder = withSegments(audioDemoDir, "seg-audio-demo", {
    "video-sync": SYNC,
  });
  // Space onto the video (in Chrome that key unlocks sound) and its lines.
  const { page, cdp } = await openAt(open, "seg-sound", folder, "video-title", [
    "video-sync",
    "video-sync-2",
    "video-sync-3",
  ]);
  const playing = await page
    .waitForFunction(
      () =>
        (document.getElementById("audio")?.sounds?.() ?? []).some(
          (s) => s.slot === "video" && s.track !== "" && !s.paused,
        ),
      { timeout: 6000 },
    )
    .then(
      () => true,
      () => false,
    );
  // Just after the loop's wrap to 4 s: the step goes to the second
  // segment (4.5-6.5, looping from 5).
  const timed = await videoBetween(page, 4.05, 4.3);
  const first = await pressAndRecord(page, cdp, 4200);
  const firstVideo = segmentRun(first.reads, SYNC[1]);
  const firstSound = soundRun(first, SYNC[1]);
  check(
    "after a step the video's sound restarts at the segment and loops it, the video staying on it and within 80 ms of it",
    playing &&
      timed &&
      playedSegment(firstVideo, 2) &&
      soundFollowed(firstSound),
    { timed, before: first.before, video: firstVideo, sound: firstSound },
  );
  // Just before that segment's loop wraps (6.5 back to 5): the step to the
  // touching last segment (6.5-8, to the file's end). The sound, about to
  // wrap with its old loop, must play on into the new segment, not a loop
  // behind it: judged as a drift the short way round the old loop, the
  // jump to 6.5 is no move from a sound at 5 (a press at 6.47 s left it
  // there, 1.5 s behind the video, 2026-11-14).
  const nearWrap = await videoBetween(page, 6.45, 6.49, 4000);
  const second = await pressAndRecord(page, cdp, 3600);
  const secondVideo = segmentRun(second.reads, SYNC[2]);
  const secondSound = soundRun(second, SYNC[2]);
  check(
    "a step pressed just before the segment's loop wraps: the sound plays the touching next segment with the video and loops it at the file's end",
    nearWrap && playedSegment(secondVideo, 1) && soundFollowed(secondSound),
    {
      nearWrap,
      before: second.before,
      video: secondVideo,
      sound: secondSound,
    },
  );
  await pressSpace(cdp);
  const left = await waitNow(page, (s) => s.item === "pin");
  const quiet = await page
    .waitForFunction(
      () =>
        !(document.getElementById("audio")?.sounds?.() ?? []).some(
          (s) => s.slot === "video" && s.track !== "" && !s.paused,
        ),
      { timeout: 3000 },
    )
    .then(
      () => true,
      () => false,
    );
  check(
    "the press after the last segment leaves the video, and its sound stops",
    left.ok && quiet,
    { left: left.s, quiet },
  );
}

export const parts = [chain, backAndForth, menu, alone, sound];
