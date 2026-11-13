// A video's own sound (docs/plan.md Phase 47, items 6, 15 and 19) on
// fixtures/audio-demo, read from the engine and a tap of the mix, never by
// listening. The demo's video plays 2-8 s of its file and loops back to
// 4 s, under a text chain; its sound is the `clock` track (the video's own
// time, a click at each whole second, where the bar hits a wall), and it
// ducks the music to 0.3. The sound is the master: its buffer loops the
// video's range on the audio clock, and the video follows it.
//
// What is read:
// - the stage's video: each frame it presents (`requestVideoFrameCallback`:
//   its media time and when it is shown) and its element's state;
// - the hook's `sounds()` (`#audio`): the `video` slot's track, whether it
//   plays and where it stands in the track, with the context's time;
// - the context's output clock (`getOutputTimestamp`), which places a
//   context time on the page's clock, as the reader would hear it;
// - the tap (soundtap.mjs): each click's onset in the mix.
// `clickReport` pairs each wall hit the video shows (a whole second of its
// media time, on the line its presented frames lie on) with the clicks the
// mix played within 500 ms of it: none is skipped, none doubled, none
// strays, each within 80 ms; and every frame shows a time within 80 ms of
// where the sound is heard as it is shown.
//
// Each part opens its own browser at the item before the video
// (`#start=video-title`):
// - posters: the sound plays while the video plays; on its poster (the
//   wheel back over seen content, and a skip burst over it) it is silent;
// - skip with "Play videos in full": the video plays and so does its
//   sound, in step;
// - sync: across ten wraps after the first, every click once within 80 ms
//   of its hit and every frame in step; after a seek of the video, the
//   sound moves to it and the same holds; a video whose clock runs fast is
//   sought back onto its sound, which never moves;
// - the text chain: the clip plays on under its lines, and so does its
//   sound, never restarted, every click and frame as for the wraps;
// - the duck: the music falls to 0.3 of its level while the sound plays,
//   stays there through a wrap, and comes back up after the reader leaves;
// - menus and the page: the Esc screen, the branch map and a hidden page
//   each pause the video and its sound, neither moving while paused;
//   closing or showing resumes both, the sound from where it stopped,
//   every click and frame as for the wraps;
// - the unlock while the video plays (WebKit with the key rule only): until
//   a key the video plays on its own clock, silent; the key starts the
//   sound where the video is, and the video is not sought.
// On WebKit `sync` and `menus` run again with the key rule
// (`requireGestureForAudio`), the context resumed by a key, as in Safari.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  audioDemoDir,
  clickCenter,
  closeSettings,
  MAP_CLOSED,
  MAP_OPEN,
  onWebKit,
  openSettings,
  pressM,
  pressSpace,
  pressTab,
  pressZ,
  repoRoot,
  setPageVisible,
  sleep,
  wheelUntil,
} from "./harness.mjs";
import { findClicks, installTap, startTap, stopTap } from "./soundtap.mjs";

export const title = "a video's sound: plays with it, in step, ducking";

const BUILD_HINT =
  "fixtures/audio-demo is missing: build it with .venv/bin/python fixtures/build_audio_demo.py";

let demo = null;
function audioDemo() {
  demo ??= JSON.parse(
    readFileSync(
      join(repoRoot, "fixtures", "audio-demo", "manifest.json"),
      "utf8",
    ),
  );
  return demo;
}
const demoItem = (id) => audioDemo().items.find((it) => it.id === id);

// The plan's bound: a video more than 80 ms from its sound is sought back.
const SYNC_S = 0.08;
// How far a just-paused clock may still move (audio.scenario.mjs).
const CLOCK_SETTLE_S = 0.25;
// Hits and clicks this close to a recording's ends are not judged: their
// partner may lie outside it.
const EDGE_MS = 600;
// A run of presented frames is placed by its frames from this long after
// its first: WebKit shows a seek's frame at once and runs on from it later.
const RUN_SETTLE_MS = 120;
// A video run starts on a hit when its first frame is this close to a
// whole second (the restart at 4 s, the entry at 2 s).
const HIT_HEAD_S = 0.002;
// The clock track's click (fixtures/build_audio_demo.py CLOCK): a 2,500 Hz
// burst at 0.6 decaying at 120 a second, judged over its first 10 ms; a
// click heard whole fits at about that level.
const CLICK_SHAPE = { hz: 2500, decay: 120, ms: 10 };
const CLICK_GAIN = 0.6;
// A jump of the output's clock against the page's this large between two
// stamps is the engine late with its sound (or catching up).
const CLOCK_JUMP_MS = 30;

const ON_ITEM = (id) =>
  document.getElementById("stage")?.getAttribute("data-item") === id;

// The stage's video and the video sound, read together: the video's time
// and state, and the hook's `video` sound (track, whether it plays, where
// it stands in its track) with the context time it was read at. The hook
// reads the context's time itself, and under load that time can step
// between two reads of it: `cur` is the time read just before and just
// after the hook, null when they differ even on a third try (no reading
// that needs it judges then).
const READ = () => {
  const video = document.getElementById("visual-video");
  const shown = video?.isConnected === true && video.style.display !== "none";
  const ctx = window.KINETIC_TEST_AUDIO?.mix?.context;
  let sounds = [];
  let cur = null;
  for (let n = 0; n < 3 && cur === null; n += 1) {
    const before = ctx?.currentTime ?? null;
    sounds = document.getElementById("audio")?.sounds?.() ?? [];
    const after = ctx?.currentTime ?? null;
    if (before !== null && before === after) cur = before;
  }
  const sound = sounds.find((s) => s.slot === "video" && s.track !== "");
  const music = sounds.filter(
    (s) => s.slot === "music" && s.track !== "" && !s.paused,
  );
  return {
    at: performance.now(),
    item: document.getElementById("stage")?.getAttribute("data-item") ?? null,
    v: shown ? video.currentTime : null,
    vp: shown ? video.paused : null,
    a: sound?.currentTime ?? null,
    ap: sound === undefined ? null : sound.paused,
    track: sound?.track ?? null,
    cur,
    ctx: ctx?.state ?? null,
    music: music.map((s) => ({ track: s.track, v: s.volume })),
  };
};
const read = (page) => page.evaluate(READ);

const soundPlays = (s) => s.track !== null && s.ap === false;
const videoPlays = (s) => s.v !== null && s.vp === false;

/** Polls the page until `ok(reading)`; `{ ok, s }` with the last reading. */
async function waitFor(page, ok, timeout = 5000) {
  const until = Date.now() + timeout;
  for (;;) {
    const s = await read(page);
    if (ok(s)) return { ok: true, s };
    if (Date.now() >= until) return { ok: false, s };
    await sleep(50);
  }
}

// In the page: logs every frame the stage's video presents (`f`: media
// time `m`, shown at page time `d`, with the hook's video sound then: its
// time `t` at context time `cur`, `ap` whether silent), the context's
// output clock on every animation frame (`stamps`: context time `c` heard
// at page time `p`), and `READ` on every animation frame (`reads`), until
// STOP_LOG. A new <video> element is followed.
const START_LOG = (src) => {
  const readNow = new Function(`return (${src})`)();
  const log = { f: [], stamps: [], reads: [], on: true };
  if (window.__vsLog) window.__vsLog.on = false;
  window.__vsLog = log;
  const ctx = window.KINETIC_TEST_AUDIO?.mix?.context;
  const stamp = () => {
    const ts = ctx?.getOutputTimestamp?.();
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
      log.stamps.push({ c: ts.contextTime, p: ts.performanceTime });
    }
  };
  // The hook's video sound with the context time it was read at (`cur`,
  // null when that time stepped during the read, as in READ).
  const sound = () => {
    for (let n = 0; n < 3; n += 1) {
      const before = ctx?.currentTime ?? null;
      const s = (document.getElementById("audio")?.sounds?.() ?? []).find(
        (x) => x.slot === "video" && x.track !== "",
      );
      const after = ctx?.currentTime ?? null;
      if (before !== null && before === after) {
        return {
          t: s?.currentTime ?? null,
          ap: s?.paused ?? true,
          cur: before,
        };
      }
    }
    return { t: null, ap: true, cur: null };
  };
  const watched = new WeakSet();
  const watch = (video) => {
    if (watched.has(video) || !video.requestVideoFrameCallback) return;
    watched.add(video);
    const tick = (now, meta) => {
      if (!log.on) return;
      stamp();
      log.f.push({
        m: meta.mediaTime,
        d: meta.expectedDisplayTime ?? now,
        ...sound(),
      });
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  };
  const frame = () => {
    if (!log.on) return;
    stamp();
    log.reads.push(readNow());
    const video = document.getElementById("visual-video");
    if (video) watch(video);
    requestAnimationFrame(frame);
  };
  frame();
};
const STOP_LOG = () => {
  const log = window.__vsLog;
  if (!log) return { f: [], stamps: [], reads: [] };
  log.on = false;
  return { f: log.f, stamps: log.stamps, reads: log.reads };
};
const startLog = (page) => page.evaluate(START_LOG, READ.toString());
const stopLog = (page) => page.evaluate(STOP_LOG);

/** The page time (ms) context time `c` is heard at, from the nearest stamp. */
function pageAt(stamps, c) {
  let best = null;
  for (const s of stamps) {
    if (best === null || Math.abs(s.c - c) < Math.abs(best.c - c)) best = s;
  }
  return best === null ? null : best.p + (c - best.c) * 1000;
}
/** The context time heard at page time `p` (ms), from the nearest stamp. */
function contextAt(stamps, p) {
  let best = null;
  for (const s of stamps) {
    if (best === null || Math.abs(s.p - p) < Math.abs(best.p - p)) best = s;
  }
  return best === null ? null : best.c + (p - best.p) / 1000;
}

/**
 * The runs of presented frames `f`: frames in one run show media time
 * moving with the page's clock (within 100 ms), so a seek, a wrap or a
 * pause starts a new one. Each run: its frames, the media times it spans,
 * `step`, the media time between its frames (their median, 0.04 s for the
 * demo's 25 fps, when it has too few), and `line`, the page time of its
 * media time 0, the median over its frames from RUN_SETTLE_MS after its
 * first (its first frame when it has none).
 */
function videoRuns(f) {
  const runs = [];
  let frames = [];
  const close = () => {
    if (frames.length === 0) return;
    const first = frames[0];
    const settled = frames.filter((s) => s.d >= first.d + RUN_SETTLE_MS);
    const lines = (settled.length >= 3 ? settled : frames)
      .map((s) => s.d - s.m * 1000)
      .sort((x, y) => x - y);
    const steps = frames
      .slice(1)
      .map((s, i) => s.m - frames[i].m)
      .filter((d) => d > 0.001 && d < 0.1)
      .sort((x, y) => x - y);
    runs.push({
      frames,
      from: first.m,
      to: frames.at(-1).m,
      step: steps.length === 0 ? 0.04 : steps[Math.floor(steps.length / 2)],
      line: lines[Math.floor(lines.length / 2)],
    });
    frames = [];
  };
  for (const s of f) {
    const p = frames.at(-1);
    if (
      p !== undefined &&
      (s.m < p.m - 0.001 || Math.abs((s.m - p.m) * 1000 - (s.d - p.d)) > 100)
    ) {
      close();
    }
    frames.push(s);
  }
  close();
  return runs;
}

/** The clock track's loop (the video item's range) for wrapping times. */
function loopOf() {
  const { endSeconds, loopStartSeconds } = demoItem("video-sync");
  return { end: endSeconds, start: loopStartSeconds };
}

/** `off` (s), the short way round the loop. */
function across(off) {
  const { end, start } = loopOf();
  const span = end - start;
  if (off > span / 2) return off - span;
  if (off < -span / 2) return off + span;
  return off;
}

/**
 * How the video and its sound kept in step over a recording (`log`, the
 * frame log; `clicks`, the tap's onsets in context seconds; `marks`, page
 * times of the test's own seeks and resumes, after which `landMs` is not
 * judged; `from`, the page time judging starts). Each wall hit of the
 * video (a whole second of a run's media time, at the run's line) is
 * paired with the clicks heard within 500 ms of it: `skipped` hits had
 * none, `doubled` more than one, `off` one more than 80 ms away; `strays`
 * are clicks no hit claimed while the video showed frames (within one of
 * its runs), `weak` clicks heard below 90% of their level. A run's hits
 * include the second one frame before its first frame shown, which a run
 * after a seek may skip. Not judged: a hit that found no click with frames
 * the tap lost within 500 ms of it (a gap can hide a click, never add or
 * move one), and hits, clicks and frames around a jump of the output's
 * clock (`clockJumps`), both counted as `unheard`; a click a gap may have
 * cut short (not `weak`); and a click no hit claims that falls between two
 * runs, where the video showed no frame (`unseen`). Callers that need it
 * also check the sound's own timeline (`soundJumps`), which a misplaced
 * click there would break. `badFrames` are presented frames, while the
 * sound plays, showing a time more than 80 ms from where the sound is
 * heard as each is shown.
 */
function clickReport({
  log,
  clicks,
  gaps = [],
  marks = [],
  landMs = 0,
  from = 0,
}) {
  const { f, stamps } = log;
  const trackEnd = audioDemo().audio.tracks.clock.durationSeconds;
  const landing = (at) => marks.some((m) => at >= m && at < m + landMs);
  // Where the tap lost frames a click may have gone unheard: a gap can only
  // hide a click, never add or move one, so it excuses only a hit within
  // 500 ms of it (its pairing window) that found no click, and a click it
  // may have cut short.
  const lost = gaps.map((g) => [
    pageAt(stamps, g.from) - 500,
    pageAt(stamps, g.to ?? Number.POSITIVE_INFINITY) + 500,
  ]);
  const nearGap = (at) => lost.some(([a, b]) => at >= a && at <= b);
  // Where the output's clock jumped against the page's between two stamps
  // by more than CLOCK_JUMP_MS (the engine late with its sound, or catching
  // up), nothing the player does keeps a frame in step, and a click's place
  // on the page's clock is uncertain: no hit, click or frame from 100 ms
  // before such a jump to 500 ms after is judged.
  const sortedStamps = [...stamps].sort((a, b) => a.p - b.p);
  const jumps = [];
  for (let i = 1; i < sortedStamps.length; i += 1) {
    const [a, b] = [sortedStamps[i - 1], sortedStamps[i]];
    const jump = b.p - b.c * 1000 - (a.p - a.c * 1000);
    if (Math.abs(jump) > CLOCK_JUMP_MS) {
      jumps.push({ at: Math.round(b.p), ms: Math.round(jump) });
    }
  }
  const nearJump = (at) =>
    jumps.some((j) => at >= j.at - 100 && at <= j.at + 500);
  const first = Math.max(f[0]?.d ?? 0, from);
  const last = f.at(-1)?.d ?? 0;
  const inside = (at) => at >= first + EDGE_MS && at <= last - EDGE_MS;
  // A run's hits: each whole second it spans, placed on its line. A run
  // that starts after a seek may not show the seek's own frame: under load
  // Chrome showed a restart's first frame at 4.04 s, not 4.00 (2026-11-13),
  // so the second one frame before its first frame shown is its too.
  const runs = videoRuns(f);
  const allHits = runs.flatMap((run) => {
    const out = [];
    const head = run.from - run.step - HIT_HEAD_S;
    for (let c = Math.ceil(head); c <= run.to; c += 1) {
      if (c < trackEnd) out.push({ c, at: run.line + c * 1000 });
    }
    return out;
  });
  // Where the video showed frames: within a run, from its first frame shown
  // to its last. Between runs (a seek landing, a stall) the picture holds
  // no place a click could be out of step with.
  const seen = (at) =>
    runs.some((r) => at >= r.frames[0].d && at <= r.frames.at(-1).d);
  const hits = allHits.filter(
    (h) => inside(h.at) && !landing(h.at) && !nearJump(h.at),
  );
  const heard = clicks
    .map((k) => ({ at: pageAt(stamps, k.c), gain: k.gain }))
    .filter((k) => k.at !== null);
  const near = (k, h) => Math.abs(k.at - h.at) < 500;
  const claimed = new Set(
    heard.flatMap((k, i) => (allHits.some((h) => near(k, h)) ? [i] : [])),
  );
  const allRows = hits.map((h) => ({
    c: h.c,
    at: Math.round(h.at),
    offs: heard.filter((k) => near(k, h)).map((k) => Math.round(k.at - h.at)),
  }));
  // A hit that found no click with a tap gap in its window is `unheard`.
  const unheardRows = allRows.filter(
    (r) => r.offs.length === 0 && nearGap(r.at),
  );
  const rows = allRows.filter((r) => !unheardRows.includes(r));
  const loose = heard.filter(
    (k, i) =>
      !claimed.has(i) && inside(k.at) && !landing(k.at) && !nearJump(k.at),
  );
  // A click no hit claims is a stray where the video showed frames; one
  // between two runs is `unseen`, not judged.
  const strays = loose
    .filter((k) => seen(k.at))
    .map((k) => ({ at: Math.round(k.at), gain: k.gain }));
  const unseen = loose
    .filter((k) => !seen(k.at))
    .map((k) => ({ at: Math.round(k.at), gain: k.gain }));
  // Every presented frame against where the sound is heard as it shows.
  const judged = f.filter(
    (s) =>
      s.ap === false &&
      s.t !== null &&
      s.cur !== null &&
      s.d >= first &&
      !landing(s.d) &&
      !nearJump(s.d),
  );
  const frameOff = (s) => {
    const c = contextAt(stamps, s.d);
    return Math.round(across(s.m - (s.t + (c - s.cur))) * 1000);
  };
  const offsets = judged.map(frameOff);
  const bad = judged
    .map((s, i) => ({ d: Math.round(s.d), m: s.m, off: offsets[i] }))
    .filter((s) => Math.abs(s.off) > SYNC_S * 1000);
  const clickOffs = rows.flatMap((r) => r.offs).sort((x, y) => x - y);
  const wrong = rows.filter(
    (r) => r.offs.length !== 1 || Math.abs(r.offs[0]) > SYNC_S * 1000,
  );
  return {
    hits: rows.length,
    unheard:
      unheardRows.length +
      allHits.filter((h) => inside(h.at) && !landing(h.at) && nearJump(h.at))
        .length,
    clockJumps: jumps.slice(0, 8),
    tapGaps: gaps.length,
    skipped: rows.filter((r) => r.offs.length === 0).length,
    doubled: rows.filter((r) => r.offs.length > 1).length,
    off: rows.filter(
      (r) => r.offs.length === 1 && Math.abs(r.offs[0]) > SYNC_S * 1000,
    ).length,
    strays: strays.length,
    unseen: unseen.length,
    unseenList: unseen.slice(0, 4),
    clickOffMs:
      clickOffs.length === 0
        ? null
        : { min: clickOffs[0], max: clickOffs.at(-1) },
    gains:
      heard.length === 0
        ? null
        : {
            min: Math.min(...heard.map((k) => k.gain)),
            max: Math.max(...heard.map((k) => k.gain)),
          },
    // Clicks in the window heard at less than 90% of their level: cut
    // short (one the recording's start cuts is not judged).
    weak: heard.filter(
      (k) =>
        inside(k.at) &&
        !landing(k.at) &&
        !nearGap(k.at) &&
        !nearJump(k.at) &&
        k.gain < 0.9 * CLICK_GAIN,
    ).length,
    frames: judged.length,
    badFrames: bad.length,
    frameOffMs:
      offsets.length === 0
        ? null
        : { min: Math.min(...offsets), max: Math.max(...offsets) },
    wrong: wrong.slice(0, 6),
    strayList: strays.slice(0, 6),
    bad: bad.slice(0, 6),
    // Around the first frame out of step: the frames shown (page time, media
    // time, the hook's sound time and context time then, the sound's place
    // as the frame showed, ms off) and the output clock's stamps.
    badDetail:
      bad.length === 0
        ? null
        : {
            frames: f
              .filter((x) => Math.abs(x.d - bad[0].d) < 250)
              .map((x) => [
                Math.round(x.d),
                x.m,
                x.t === null ? null : Math.round(x.t * 1000) / 1000,
                x.cur,
                x.t === null || x.cur === null ? null : frameOff(x),
              ]),
            stamps: sortedStamps
              .filter((x) => Math.abs(x.p - bad[0].d) < 250)
              .map((x) => [Math.round(x.p), Math.round(x.c * 1000) / 1000]),
          },
    // Around each stray, what the checker knew: the runs of frames, the
    // frames shown, the tap's gaps and the hook's readings (video time,
    // sound time, context time, sound paused), all in page ms.
    strayDetail: strays.slice(0, 2).map((k) => {
      const runs = videoRuns(f)
        .filter(
          (r) => r.frames.at(-1).d > k.at - 2000 && r.frames[0].d < k.at + 2000,
        )
        .map((r) => ({
          d0: Math.round(r.frames[0].d),
          d1: Math.round(r.frames.at(-1).d),
          m0: r.from,
          m1: r.to,
          n: r.frames.length,
          line: Math.round(r.line),
        }));
      const near = f
        .filter((s) => Math.abs(s.d - k.at) < 400)
        .map((s) => [Math.round(s.d), Math.round(s.m * 1000) / 1000]);
      const gapsAt = gaps.map((g) => [
        Math.round(pageAt(stamps, g.from)),
        Math.round(pageAt(stamps, g.to ?? Number.POSITIVE_INFINITY)),
      ]);
      const reads = (log.reads ?? [])
        .filter((s) => Math.abs(s.at - k.at) < 400)
        .map((s) => [
          Math.round(s.at),
          s.v === null ? null : Math.round(s.v * 1000) / 1000,
          s.a === null ? null : Math.round(s.a * 1000) / 1000,
          s.cur === null ? null : Math.round(s.cur * 1000) / 1000,
          s.ap,
        ]);
      return { at: k.at, runs, frames: near, gapsAt, reads };
    }),
  };
}

/**
 * Every click once, whole, on its hit, and every frame in step; no more
 * than a quarter as many hits unheard (the tap lost frames there) and
 * clicks unseen (between the video's runs of frames) as hits judged.
 */
const clicksInStep = (r) =>
  r.hits > 0 &&
  r.unheard + r.unseen <= r.hits / 4 &&
  r.weak === 0 &&
  r.skipped === 0 &&
  r.doubled === 0 &&
  r.off === 0 &&
  r.strays === 0 &&
  r.frames > 0 &&
  r.badFrames === 0;

/** Wraps of the video (its time moving back more than 1 s) in `reads`. */
function wrapsOf(reads) {
  let wraps = 0;
  for (let i = 1; i < reads.length; i += 1) {
    const [p, s] = [reads[i - 1], reads[i]];
    if (p.v !== null && s.v !== null && s.v < p.v - 1) wraps += 1;
  }
  return wraps;
}

/**
 * The sound's own timeline across `reads`: its time less the context's,
 * the short way round the loop, moves only if the sound was restarted or
 * sought; the most it moved between readings where it played (ms).
 */
function soundJumps(reads) {
  const playing = reads.filter((s) => soundPlays(s) && s.cur !== null);
  let most = 0;
  for (let i = 1; i < playing.length; i += 1) {
    const [p, s] = [playing[i - 1], playing[i]];
    const moved = across(s.a - p.a - (s.cur - p.cur));
    most = Math.max(most, Math.abs(moved) * 1000);
  }
  return Math.round(most);
}

/**
 * Records the tap and the frame log for `ms`, running `during` (if any)
 * meanwhile; resolves with the log and the clicks.
 */
async function record(page, ms, during = async () => {}) {
  await startTap(page);
  await startLog(page);
  const t0 = Date.now();
  const out = await during();
  const left = ms - (Date.now() - t0);
  if (left > 0) await sleep(left);
  const log = await stopLog(page);
  await stopTap(page);
  const clicks = await findClicks(page, { shape: CLICK_SHAPE });
  return {
    log,
    clicks: clicks.clicks ?? [],
    gaps: clicks.gaps ?? [],
    tapped: { ok: clicks.ok, gaps: clicks.gaps?.length ?? null },
    out,
  };
}

/**
 * Samples a second at a time until one passes with both playing on every
 * frame and every presented frame in step: the session's first plays start
 * the sound and settle it. `{ ok, report }` with the last second's.
 */
async function inStep(page, tries = 8) {
  let report = null;
  for (let n = 0; n < tries; n += 1) {
    await startLog(page);
    await sleep(1000);
    const log = await stopLog(page);
    report = clickReport({ log, clicks: [] });
    if (
      log.reads.length > 0 &&
      log.reads.every((s) => videoPlays(s) && soundPlays(s)) &&
      report.frames > 10 &&
      report.badFrames === 0
    ) {
      return { ok: true, report };
    }
  }
  return { ok: false, report };
}

function built(check, folders) {
  if (folders.audioDemo) return true;
  check("fixtures/audio-demo is built", false, BUILD_HINT);
  return false;
}

/**
 * Opens the audio demo on video-title, the item before the video, taps its
 * mix, and presses Space onto the video (a read: it plays, and in Chrome,
 * or WebKit with the key rule, that key unlocks sound). Resolves with the
 * session once the sound has played past 2.5 s of the video, or null (a
 * FAIL is recorded).
 */
async function ontoVideo(check, open, name, options = {}) {
  const session = await open(name, {
    folder: audioDemoDir,
    closeHelp: true,
    hash: "#start=video-title",
    ...options,
  });
  const { page, cdp } = session;
  await page
    .waitForFunction(ON_ITEM, { timeout: 5000 }, "video-title")
    .catch(() => {});
  const tap = await installTap(page);
  if (!tap.ok) {
    check("the mix can be tapped", false, tap);
    return null;
  }
  await pressSpace(cdp);
  const { ok, s } = await waitFor(
    page,
    (now) =>
      now.item === "video-sync" &&
      soundPlays(now) &&
      videoPlays(now) &&
      now.v > 2.5,
  );
  if (!ok) {
    check(
      "the video and its sound play once the reader reads onto it",
      false,
      s,
    );
    return null;
  }
  return session;
}

/** Turns on "Play videos in full" on the Esc screen; its aria-pressed. */
async function playVideosInFull(page, cdp) {
  await openSettings(page, cdp);
  await clickCenter(cdp, ".config-skip-videos");
  const on = await page.evaluate(() =>
    document.querySelector(".config-skip-videos")?.getAttribute("aria-pressed"),
  );
  await closeSettings(page, cdp);
  return on;
}

/** The check's words on WebKit with the key rule, so the two read apart. */
const keyRule = (options) =>
  options.requireGestureForAudio ? " (WebKit with the key rule)" : "";
/** `part` named for the runner, with the key rule apart. */
const named = (name, options, part) =>
  Object.defineProperty(part, "name", {
    value: options.requireGestureForAudio ? `${name}KeyRule` : name,
  });

// ---------------------------------------------------------------------------

async function posters({ check, open, folders }) {
  if (!built(check, folders)) return;
  const session = await ontoVideo(check, open, "vs-posters");
  if (session === null) return;
  const { page, cdp } = session;
  await startLog(page);
  await sleep(600);
  const { reads: playingRun } = await stopLog(page);
  check(
    "the sound plays while the video plays, on the video's clock track",
    playingRun.length > 0 &&
      playingRun.every(
        (s) =>
          videoPlays(s) &&
          soundPlays(s) &&
          s.track === demoItem("video-sync").audio.videoSound.track,
      ),
    { first: playingRun[0], last: playingRun.at(-1) },
  );

  // Read on past the video, then wheel back onto its chain: content seen
  // before, so its poster shows, and its sound stays silent (well past the
  // 250 ms rest a walk waits for).
  for (const id of ["video-sync-2", "video-sync-3", "pin"]) {
    await pressSpace(cdp);
    await page.waitForFunction(ON_ITEM, { timeout: 3000 }, id).catch(() => {});
  }
  const away = await waitFor(page, (s) => s.item === "pin" && !soundPlays(s));
  await wheelUntil(page, cdp, true, ON_ITEM, "video-sync-3", 4);
  await startLog(page);
  await sleep(1500);
  const { reads: walkedBack } = await stopLog(page);
  check(
    "walking back onto the video over seen content shows its poster, and its sound stays silent",
    away.ok &&
      walkedBack.length > 0 &&
      walkedBack.every(
        (s) => s.item === "video-sync-3" && s.vp === true && !soundPlays(s),
      ),
    { away: away.s, first: walkedBack[0], last: walkedBack.at(-1) },
  );

  // A skip burst over it: posters all the way, never a sound.
  await wheelUntil(page, cdp, true, ON_ITEM, "video-title", 6);
  await startLog(page);
  await pressTab(cdp);
  const skipped = await waitFor(page, (s) => s.item === "pin", 8000);
  await sleep(400);
  const { reads: burst } = await stopLog(page);
  const sounded = burst.filter(soundPlays);
  check(
    "a skip burst over the video shows its poster and plays none of its sound",
    skipped.ok && burst.length > 0 && sounded.length === 0,
    { skipped: skipped.s, frames: burst.length, sounded: sounded.slice(0, 3) },
  );
}

async function skipInFull({ check, open, folders }) {
  if (!built(check, folders)) return;
  const session = await ontoVideo(check, open, "vs-skipfull");
  if (session === null) return;
  const { page, cdp } = session;
  for (const id of ["video-sync-2", "video-sync-3", "pin"]) {
    await pressSpace(cdp);
    await page.waitForFunction(ON_ITEM, { timeout: 3000 }, id).catch(() => {});
  }
  const on = await playVideosInFull(page, cdp);
  await wheelUntil(page, cdp, true, ON_ITEM, "video-title", 6);
  await waitFor(page, (s) => !soundPlays(s), 2000);
  await pressTab(cdp);
  const playing = await waitFor(
    page,
    (s) => s.item === "video-sync" && videoPlays(s) && soundPlays(s),
    4000,
  );
  const steady = playing.ok ? await inStep(page) : { ok: false, report: null };
  const after = await read(page);
  check(
    'a skip burst with "Play videos in full" plays the video, and its sound with it, in step',
    on === "true" && playing.ok && steady.ok && after.item === "video-sync",
    { on, playing: playing.s, steady: steady.report, after },
  );
  await pressTab(cdp);
}

const sync = (options = {}) =>
  named("sync", options, async ({ check, open, folders }) => {
    if (!built(check, folders)) return;
    const session = await ontoVideo(
      check,
      open,
      `vs-sync${options.requireGestureForAudio ? "-key" : ""}`,
      options,
    );
    if (session === null) return;
    const { page } = session;
    // From after the first wrap (the video reaches 8 s and wraps to 4 s,
    // then every 4 s): ten wraps, every click and every frame judged.
    await waitFor(page, (s) => s.v !== null && s.v > 7.5, 7000);
    await waitFor(page, (s) => s.v !== null && s.v > 4 && s.v < 4.6, 2000);
    const run = await record(page, 10 * 4000 + 1500);
    const report = clickReport(run);
    const wraps = wrapsOf(run.log.reads);
    // The sound's own timeline unbroken: never restarted or sought, so no
    // click is out of place even where the video showed no frame.
    const timeline = soundJumps(run.log.reads);
    check(
      `across ten wraps every click of the sound plays once, within 80 ms of its wall hit, and every frame is within 80 ms of the sound${keyRule(options)}`,
      wraps >= 10 && timeline <= 5 && clicksInStep(report),
      {
        wraps,
        tapped: run.tapped.ok,
        soundJumpMs: timeline,
        ...report,
      },
    );

    // A seek of the video, early in a pass: its sound goes to the video's
    // new place, and every click and frame after it is in step.
    await waitFor(page, (s) => s.v !== null && s.v > 4.1 && s.v < 4.4, 6000);
    const seek = await record(page, 5000, async () => {
      await sleep(300);
      return page.evaluate(() => {
        const v = document.getElementById("visual-video");
        v.currentTime += 1;
        return performance.now();
      });
    });
    const seekAt = seek.out;
    const seekReport = clickReport({ ...seek, from: seekAt });
    // The sound moved with it: its own timeline jumped the second the
    // video was sought by, and the video stayed where it was sent, both
    // within 80 ms of each other a moment later.
    const jump = soundJumps(seek.log.reads);
    const moved = seek.log.reads.filter(
      (s) =>
        s.at > seekAt + 300 &&
        s.at < seekAt + 1300 &&
        soundPlays(s) &&
        videoPlays(s),
    );
    const movedOk =
      Math.abs(jump - 1000) <= 150 &&
      moved.length > 0 &&
      moved.every((s) => Math.abs(across(s.a - s.v)) < SYNC_S);
    check(
      `after a seek of the video its sound moves to the video's new place, every click once within 80 ms of its hit and every frame in step${keyRule(options)}`,
      movedOk && clicksInStep(seekReport),
      {
        seekAt: Math.round(seekAt),
        soundJumpMs: jump,
        moved: moved[0],
        ...seekReport,
      },
    );

    // A video whose clock runs 30% fast for 0.8 s: the player seeks it
    // back onto its sound, which never moves; in step once it runs true.
    await waitFor(page, (s) => s.v !== null && s.v > 4.2 && s.v < 4.5, 6000);
    const drift = await record(page, 3800, async () => {
      await page.evaluate(() => {
        window.__vsSeeks = 0;
        const v = document.getElementById("visual-video");
        window.__vsSeekCount = () => window.__vsSeeks;
        v.addEventListener("seeking", () => {
          window.__vsSeeks += 1;
        });
        v.playbackRate = 1.3;
      });
      await sleep(800);
      return page.evaluate(() => {
        document.getElementById("visual-video").playbackRate = 1;
        return { trueAt: performance.now(), seeks: window.__vsSeeks };
      });
    });
    const driftReport = clickReport({
      ...drift,
      from: drift.out.trueAt + 400,
    });
    const jumps = soundJumps(drift.log.reads);
    check(
      `a video that strays more than 80 ms from its sound is sought back onto it; the sound never moves${keyRule(options)}`,
      drift.out.seeks > 0 &&
        jumps <= 5 &&
        driftReport.frames >= 20 &&
        driftReport.badFrames === 0,
      { ...drift.out, soundJumpMs: jumps, ...driftReport },
    );
  });

async function chain({ check, open, folders }) {
  if (!built(check, folders)) return;
  const session = await ontoVideo(check, open, "vs-chain");
  if (session === null) return;
  const { page, cdp } = session;
  const steady = await inStep(page);
  // Marks the video element, so a restart on a fresh one shows.
  await page.evaluate(() => {
    document.getElementById("visual-video").__mark = true;
  });
  const before = await read(page);
  const run = await record(page, 6000, async () => {
    for (const id of ["video-sync-2", "video-sync-3"]) {
      await sleep(400);
      await pressSpace(cdp);
      await page
        .waitForFunction(ON_ITEM, { timeout: 3000 }, id)
        .catch(() => {});
      await sleep(2000);
    }
  });
  const marked = await page.evaluate(
    () => document.getElementById("visual-video")?.__mark === true,
  );
  const { endSeconds, loopStartSeconds } = demoItem("video-sync");
  const reads = run.log.reads;
  const items = [...new Set(reads.map((s) => s.item))];
  // The clip only ever goes back from its range end to its loop point:
  // never to its start, as a restart would.
  const backs = reads
    .slice(1)
    .map((s, i) => [reads[i].v, s.v])
    .filter(([p, v]) => p !== null && v !== null && v < p - 0.05);
  const loopsOnly = backs.every(
    ([p, v]) => p >= endSeconds - 0.2 && Math.abs(v - loopStartSeconds) < 0.1,
  );
  const playing = reads.every((s) => videoPlays(s) && soundPlays(s));
  const jumps = soundJumps(reads);
  const report = clickReport(run);
  check(
    "under the text chain the clip plays on, and its sound with it, never restarted, every click once on its wall hit and every frame within 80 ms",
    steady.ok &&
      marked &&
      items.includes("video-sync-2") &&
      items.includes("video-sync-3") &&
      playing &&
      loopsOnly &&
      jumps <= 5 &&
      clicksInStep(report),
    {
      steady: steady.report,
      before,
      marked,
      items,
      playing,
      backs,
      soundJumpMs: jumps,
      ...report,
    },
  );
}

async function duck({ check, open, folders }) {
  if (!built(check, folders)) return;
  const { page, cdp } = await open("vs-duck", {
    folder: audioDemoDir,
    closeHelp: true,
    hash: "#start=video-title",
  });
  const tracks = audioDemo().audio.tracks;
  const level = (s) => {
    const [m] = s.music;
    return m === undefined ? null : m.v / (tracks[m.track].volume ?? 1);
  };
  const full = (s) => s.music.length === 1 && Math.abs(level(s) - 1) < 0.02;
  const duckTo = demoItem("video-sync").audio.videoSound.duck;
  const ducked = (s) =>
    s.music.length === 1 && Math.abs(level(s) - duckTo) < 0.02;

  await page
    .waitForFunction(ON_ITEM, { timeout: 5000 }, "video-title")
    .catch(() => {});
  await pressZ(cdp); // a key with no job: sound starts
  const before = await waitFor(page, (s) => full(s) && !soundPlays(s));
  await pressSpace(cdp); // video-sync
  const down = await waitFor(page, (s) => soundPlays(s) && ducked(s), 3000);
  // Through the first wrap (the video reaches 8 s about 6 s in): the music
  // stays down, never rising while the video loops back.
  let through = [];
  if (down.ok) {
    await startLog(page);
    await sleep(6500);
    through = (await stopLog(page)).reads;
  }
  const wrapped = wrapsOf(through) > 0;
  const levels = through.map(level).filter((l) => l !== null);
  check(
    "the music falls to the video sound's duck while it plays, and stays there through a wrap",
    before.ok &&
      down.ok &&
      wrapped &&
      levels.length === through.length &&
      levels.every((l) => Math.abs(l - duckTo) < 0.02),
    {
      before: before.s,
      down: down.s,
      wrapped,
      levels:
        levels.length === 0
          ? null
          : { min: Math.min(...levels), max: Math.max(...levels) },
    },
  );

  await wheelUntil(page, cdp, true, ON_ITEM, "video-title", 3);
  const up = await waitFor(page, (s) => full(s) && !soundPlays(s), 3000);
  check(
    "leaving the video lifts the duck: the music comes back to its level",
    up.ok,
    up.s,
  );
}

const menus = (options = {}) =>
  named("menus", options, async ({ check, open, folders }) => {
    if (!built(check, folders)) return;
    const session = await ontoVideo(
      check,
      open,
      `vs-menus${options.requireGestureForAudio ? "-key" : ""}`,
      options,
    );
    if (session === null) return;
    const { browser, page, cdp } = session;
    const now = () => page.evaluate(() => performance.now());
    // Each screen opens mid-pass and holds for 900 ms: the video and its
    // sound hold still; it closes, and both play on from there, every
    // click once on its wall hit and every frame in step, from before it
    // opened to 2.5 s after it closed.
    const under = async (name, openIt, closeIt) => {
      const steady = await inStep(page);
      await waitFor(page, (s) => s.v !== null && s.v > 5 && s.v < 5.5, 6000);
      const run = await record(page, 0, async () => {
        await sleep(300);
        await openIt();
        await sleep(300);
        const a = await read(page);
        await sleep(600);
        const b = await read(page);
        const closedAt = await closeIt();
        const resumed = await waitFor(
          page,
          (s) => videoPlays(s) && soundPlays(s),
          3000,
        );
        await sleep(2500);
        return { a, b, closedAt, resumed };
      });
      const { a, b, closedAt, resumed } = run.out;
      const report = clickReport(run);
      const held = (s) =>
        s.vp === true && s.track !== null && s.ap === true && s.a !== null;
      // The sound plays on from where it stopped: its first reading after
      // the close, played back to where it was paused, began while the
      // screen was closing (after `b`, while it was paused, and by that
      // reading). One that resumed from anywhere else began before `b` (it
      // skipped ahead) or after the reading (it went back).
      const after = run.log.reads.find(
        (s) => s.at > b.at && soundPlays(s) && s.cur !== null,
      );
      const pausedCur = b.cur ?? a.cur;
      const resumedFrom =
        after === undefined ? null : Math.round((after.a - b.a) * 1000);
      const sinceClose =
        after === undefined ? null : Math.round(after.at - closedAt);
      const began = after === undefined ? null : after.cur - (after.a - b.a);
      const inPlace =
        began !== null &&
        pausedCur !== null &&
        began >= pausedCur - 0.005 &&
        began <= after.cur + 0.005;
      check(
        `${name} pauses the video and its sound, neither moving; closing it resumes both, the sound from where it stopped, every click once on its wall hit and every frame within 80 ms${keyRule(options)}`,
        steady.ok &&
          held(a) &&
          held(b) &&
          Math.abs(b.a - a.a) < 0.001 &&
          Math.abs(b.v - a.v) < CLOCK_SETTLE_S &&
          resumed.ok &&
          inPlace &&
          clicksInStep(report),
        {
          a,
          b,
          resumed: resumed.s,
          resumedFrom,
          sinceClose,
          resumeBeganAfterPausedMs:
            began === null || pausedCur === null
              ? null
              : Math.round((began - pausedCur) * 1000),
          // The readings from the close on: page time, video time, sound
          // time, context time, sound paused.
          resumeReads: run.log.reads
            .filter((s) => s.at > closedAt - 100)
            .slice(0, 14)
            .map((s) => [Math.round(s.at), s.v, s.a, s.cur, s.ap]),
          ...report,
        },
      );
    };
    await under(
      "the Esc screen",
      () => openSettings(page, cdp),
      async () => {
        await closeSettings(page, cdp);
        return now();
      },
    );
    await under(
      "the branch map",
      async () => {
        await pressM(cdp);
        await page.waitForFunction(MAP_OPEN, { timeout: 3000 }).catch(() => {});
      },
      async () => {
        await pressM(cdp);
        await page
          .waitForFunction(MAP_CLOSED, { timeout: 3000 })
          .catch(() => {});
        return now();
      },
    );
    await under(
      "a hidden page",
      () => setPageVisible(browser, page, false),
      async () => {
        await setPageVisible(browser, page, true);
        return now();
      },
    );
  });

// The unlock while the video plays, on WebKit with the key rule: until a
// key, the video plays on its own clock with its sound silent; at the key
// the sound joins the video where it is, so the video is not sought, and
// from then on it follows its sound. Not on Chrome: its autoplay rule lets
// a page the tools opened or reloaded play at once in some runs and not in
// others (2026-11-13), so its locked state cannot be counted on.
const unlockJoins = (options = {}) =>
  named("unlockJoins", options, async ({ check, open, folders }) => {
    if (!built(check, folders)) return;
    const { page, cdp } = await open(
      `vs-unlock${options.requireGestureForAudio ? "-key" : ""}`,
      {
        folder: audioDemoDir,
        closeHelp: true,
        hash: "#start=video-sync",
        ...options,
      },
    );
    const before = await waitFor(
      page,
      (s) => s.item === "video-sync" && videoPlays(s) && s.v > 2.3 && s.v < 3,
      6000,
    );
    const silent =
      before.ok && !soundPlays(before.s) && before.s.ctx !== "running";
    await page.evaluate(() => {
      window.__vsSeekTimes = [];
      document
        .getElementById("visual-video")
        .addEventListener("seeking", () =>
          window.__vsSeekTimes.push(performance.now()),
        );
    });
    const keyAt = await page.evaluate(() => performance.now());
    await pressZ(cdp); // a key with no job: sound starts
    const joined = await waitFor(page, (s) => soundPlays(s), 3000);
    await startLog(page);
    await sleep(1500);
    const log = await stopLog(page);
    const seeks = await page.evaluate(() => window.__vsSeekTimes);
    const report = clickReport({ log, clicks: [] });
    check(
      `before a key the video plays with its sound silent; the unlocking key starts the sound where the video is, which is not sought, and every frame is in step${keyRule(options)}`,
      silent &&
        joined.ok &&
        Math.abs(across(joined.s.a - joined.s.v)) < SYNC_S &&
        seeks.filter((at) => at > keyAt).length === 0 &&
        report.frames > 20 &&
        report.badFrames === 0,
      {
        before: before.s,
        joined: joined.s,
        seeksAfterKey: seeks.filter((at) => at > keyAt).length,
        frames: report.frames,
        badFrames: report.badFrames,
        frameOffMs: report.frameOffMs,
      },
    );
  });

export const parts = [
  posters,
  skipInFull,
  sync(),
  chain,
  duck,
  menus(),
  // The stock WebKit driver runs the context at once, as the Mac app does;
  // with the key rule it waits for the key, as Safari does.
  ...(onWebKit
    ? [
        sync({ requireGestureForAudio: true }),
        menus({ requireGestureForAudio: true }),
        unlockJoins({ requireGestureForAudio: true }),
      ]
    : []),
];
