// A video's own sound (docs/plan.md Phase 47, items 6 and 15) on
// fixtures/audio-demo, read through the player's test hook: the `video`
// slot of the hidden `#audio` (two elements; the one holding the track is
// the sound) against the stage's <video>. The demo's video plays 2-8 s of
// its file and loops back to 4 s, under a text chain; its sound is the
// `clock` track (the video's own time, a click at each wall hit), and it
// ducks the music to 0.3.
//
// Each part opens its own browser at the item before the video
// (`#start=video-title`):
// - posters: the sound plays while the video plays; on its poster (the
//   wheel back over seen content, and a skip burst over it) it is silent;
// - skip with "Play videos in full": the video plays and so does its
//   sound;
// - sync: across ten wraps every click plays once, within 80 ms of its
//   wall hit, and every frame is within 80 ms (`clickReport`); back in step
//   after a seek of the video, and after its own clock is knocked 300 ms
//   off;
// - the text chain: the clip plays on under its lines, and so does its
//   sound, never restarted, every click and frame as for the wraps;
// - the duck: the music falls to 0.3 of its level while the sound plays,
//   stays there through a wrap, and comes back up after the reader leaves;
// - menus and the page: the Esc screen, the branch map and a hidden page
//   each pause the video and its sound, neither moving while paused;
//   closing the menus resumes both, every click and frame as for the
//   wraps; showing the page (whose video the engine resumes unasked)
//   resumes both in step once the sound has landed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  audioDemoDir,
  clickCenter,
  closeSettings,
  MAP_CLOSED,
  MAP_OPEN,
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

// The plan's tolerance: the sound re-seeks past 80 ms from the video.
const SYNC_S = 0.08;
// audiorules.ts VIDEO_LAND_MS: a seek of the sound is left this long, from
// its `seeked`, to land before its drift is judged again, as WebKit holds
// its clock twice after a seek and lands it 340-480 ms late. Frames inside
// a landing (and three frames more, for the player's next check to run)
// are not judged.
const LAND_MS = 900 + 50;
// The player re-seeks on the frame it finds the sound past SYNC_S, which
// this page may sample first: frames up to this long before a seek of the
// sound are its cause, not judged.
const SEEN_MS = 50;
// How far a just-paused element's clock may still move (audio.scenario.mjs).
const CLOCK_SETTLE_S = 0.25;

const ON_ITEM = (id) =>
  document.getElementById("stage")?.getAttribute("data-item") === id;

// The stage's video and the video sound, read together in one frame. The
// sound is the `video` slot's element that holds the track (`data-track`):
// `ai` says which, so a hand-over from one element to another shows.
const READ_PAIR = () => {
  const video = document.getElementById("visual-video");
  const shown = video?.isConnected === true && video.style.display !== "none";
  const slot = Array.from(
    document.querySelectorAll('#audio [data-slot="video"]'),
  );
  const ai = slot.findIndex((el) => (el.dataset.track ?? "") !== "");
  const sound = ai < 0 ? null : slot[ai];
  const held = sound !== null;
  const music = Array.from(
    document.querySelectorAll('#audio [data-slot="music"]'),
  ).filter((el) => (el.dataset.track ?? "") !== "" && !el.paused);
  return {
    at: performance.now(),
    item: document.getElementById("stage")?.getAttribute("data-item") ?? null,
    v: shown ? video.currentTime : null,
    vp: shown ? video.paused : null,
    a: held ? sound.currentTime : null,
    ap: held ? sound.paused : null,
    // Played to its file's end (WebKit's AAC is about 23 ms short): silent,
    // though `paused` and `ended` may lag a frame.
    ae: held
      ? sound.ended || sound.currentTime >= sound.duration - 0.005
      : null,
    as: held ? sound.seeking : null,
    ai: held ? ai : null,
    track: held ? sound.dataset.track : null,
    music: music.map((el) => ({ track: el.dataset.track, v: el.volume })),
  };
};
const readPair = (page) => page.evaluate(READ_PAIR);

// Notes each seek of the video sound, `{ at, done }` (page times of its
// `seeking` and `seeked`; a seek cut short by the next is done when that
// one starts), from the page's open, so a sample knows the landings
// already under way when it starts. Only the element holding the track
// counts: an element waiting with none is never heard. Every `play`,
// `seeking` and `pause` of a `video` slot element, and of the stage's
// video, also goes in `__soundStarts` as `{ type, at, i, t }` (its index in
// the slot, -1 for the stage's video, and its time then): where a run of it
// began.
const INSTALL_SEEK_LOG = () => {
  if (window.__soundSeeks !== undefined) return;
  window.__soundSeeks = [];
  window.__soundStarts = [];
  const slot = (event) => event.target?.dataset?.slot === "video";
  const sound = (event) =>
    slot(event) && (event.target.dataset.track ?? "") !== "";
  for (const type of ["play", "seeking", "pause"]) {
    document.addEventListener(
      type,
      (event) => {
        const stage = event.target?.id === "visual-video";
        if (!slot(event) && !stage) return;
        const all = Array.from(
          document.querySelectorAll('#audio [data-slot="video"]'),
        );
        window.__soundStarts.push({
          type,
          at: performance.now(),
          i: stage ? -1 : all.indexOf(event.target),
          t: event.target.currentTime,
        });
      },
      true,
    );
  }
  document.addEventListener(
    "seeking",
    (event) => {
      if (!sound(event)) return;
      const at = performance.now();
      const last = window.__soundSeeks.at(-1);
      if (last !== undefined) last.done ??= at;
      window.__soundSeeks.push({ at, done: null });
    },
    true,
  );
  document.addEventListener(
    "seeked",
    (event) => {
      const last = window.__soundSeeks.at(-1);
      if (sound(event) && last !== undefined) last.done ??= performance.now();
    },
    true,
  );
};

// Samples READ_PAIR on every animation frame until STOP_SAMPLES.
const START_SAMPLES = (src) => {
  const read = new Function(`return (${src})`)();
  cancelAnimationFrame(window.__pairFrame ?? 0);
  window.__pairs = [];
  const step = () => {
    window.__pairs.push(read());
    window.__pairFrame = requestAnimationFrame(step);
  };
  step();
};
// The samples, and the sound's seeks whose landing runs into them.
const STOP_SAMPLES = (landMs) => {
  cancelAnimationFrame(window.__pairFrame ?? 0);
  const first = window.__pairs[0]?.at ?? 0;
  return {
    pairs: window.__pairs,
    starts: window.__soundStarts ?? [],
    seeks: (window.__soundSeeks ?? []).filter(
      (seek) => (seek.done ?? Infinity) + landMs >= first,
    ),
  };
};
/** READ_PAIR on every frame for `ms`, and the sound's seeks meanwhile. */
async function sampleFor(page, ms) {
  await page.evaluate(INSTALL_SEEK_LOG);
  await page.evaluate(START_SAMPLES, READ_PAIR.toString());
  await sleep(ms);
  return page.evaluate(STOP_SAMPLES, LAND_MS);
}

// Judged frames enough (about 160 ms) to show the sound settled in step: a
// sound that seeked at every landing would leave none, as each window here
// outlasts the player's own.
const SETTLED_FRAMES = 10;

const soundPlays = (s) => s.track !== null && s.ap === false && s.ae !== true;
const videoPlays = (s) => s.v !== null && s.vp === false;
const offMs = (s) =>
  s.a === null || s.v === null ? null : Math.round((s.a - s.v) * 1000);

/** Polls the page until `ok(reading)`; `{ ok, s }` with the last reading. */
async function waitPair(page, ok, timeout = 5000) {
  const until = Date.now() + timeout;
  for (;;) {
    const s = await readPair(page);
    if (ok(s)) return { ok: true, s };
    if (Date.now() >= until) return { ok: false, s };
    await sleep(50);
  }
}

/** Page times where the video's time moved back more than 1 s. */
function wrapsOf(pairs) {
  const wraps = [];
  for (let i = 1; i < pairs.length; i += 1) {
    const [p, s] = [pairs[i - 1], pairs[i]];
    if (p.v !== null && s.v !== null && s.v < p.v - 1) wraps.push(s.at);
  }
  return wraps;
}

/**
 * How a sampled run kept in step. Judged: each frame where both play,
 * outside a landing (LAND_MS after a wrap or one of `marks`, the page times
 * of the test's own seeks and resumes, and from SEEN_MS before a seek of
 * the sound to LAND_MS after its `seeked`). `bad` lists judged frames more
 * than SYNC_S off; `landings` says, for each wrap and mark, where the sound
 * stood once its landing was over and how long it took to be within
 * SYNC_S; `passes` counts the judged frames between wraps.
 */
function stepReport({ pairs, seeks, starts = [] }, marks = []) {
  const wraps = wrapsOf(pairs);
  // A start of an element of the sound lands as a seek does.
  const plays = starts.filter((e) => e.i >= 0 && e.type === "play");
  const windows = [
    ...[...wraps, ...marks].map((m) => [m, m + LAND_MS]),
    ...seeks.map(({ at, done }) => [
      at - SEEN_MS,
      (done ?? Infinity) + LAND_MS,
    ]),
    ...plays.map(({ at }) => [at - SEEN_MS, at + LAND_MS]),
  ];
  const landing = (s) =>
    windows.some(([from, to]) => s.at >= from && s.at < to);
  const both = (s) => videoPlays(s) && soundPlays(s);
  const judged = pairs.filter((s) => both(s) && !landing(s));
  const bad = judged
    .filter((s) => Math.abs(s.a - s.v) > SYNC_S)
    .map((s) => ({ at: Math.round(s.at), v: s.v, a: s.a, off: offMs(s) }));
  const sorted = judged.map(offMs).sort((x, y) => x - y);
  const pick = (q) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const landings = [...wraps, ...marks].map((m) => {
    const after = pairs.filter((s) => s.at >= m && both(s));
    const settled = after.find((s) => !landing(s));
    const inStep = after.find((s) => Math.abs(s.a - s.v) <= SYNC_S);
    return {
      at: Math.round(m),
      offMs: settled === undefined ? null : offMs(settled),
      inStepAfterMs: inStep === undefined ? null : Math.round(inStep.at - m),
    };
  });
  const passes = wraps.map((w, i) => {
    const end = wraps[i + 1] ?? Infinity;
    return judged.filter((s) => s.at >= w && s.at < end).length;
  });
  return {
    wraps: wraps.map(Math.round),
    seeks: seeks.map(({ at }) => Math.round(at)),
    frames: pairs.length,
    judged: judged.length,
    offMs:
      sorted.length === 0
        ? null
        : {
            min: sorted[0],
            p50: pick(0.5),
            p95: pick(0.95),
            max: sorted.at(-1),
          },
    bad: bad.slice(0, 8),
    badCount: bad.length,
    landings,
    passes,
  };
}

// The clock track clicks at each whole second of the video's time, as the
// bar hits a wall (fixtures/build_audio_demo.py), for about 25 ms.
// A run of the sound that starts within this much of a whole second plays
// its click; one that starts later only its tail, which the run before
// played.
const CLICK_HEAD_S = 0.002;
// A run's clock is read where it runs true: the sound's from this long
// after its element's play() (audiorules.ts SEAM_LAND_MS: WebKit's clock
// runs ahead of its sound, then waits for it, for up to about 650 ms; item
// 14), the video's from this long into its run (WebKit's stands at a
// wrap's restart point a moment).
const SOUND_SETTLE_MS = 900;
const VIDEO_SETTLE_MS = 300;
// Wall hits and clicks this close to a run's ends are not judged: their
// partner may lie outside it.
const EDGE_MS = 300;

/**
 * Splits `pairs` into runs where `clock(s)` (a time, or null while it
 * does not play) never moves back, between frames `same(p, s)` keeps
 * together (WebKit's sound clock jumps ahead, then holds for its sound,
 * as it starts): `{ frames, line, from, to, settledAt }`, with
 * `from` where it began and since when (`startOf(first)` says, else its
 * first frame), `settledAt` the page time `settleMs` after that, and
 * `line` the page time of the run's time 0, the median over its frames
 * from `settledAt` (its last frame when it has none). `same(p, s)` keeps
 * two frames in one run.
 */
function runsOf(pairs, clock, same, startOf, settleMs) {
  const runs = [];
  let frames = [];
  const close = () => {
    if (frames.length === 0) return;
    const first = frames[0];
    const start = startOf(first) ?? { t: clock(first), at: first.at };
    const settledAt = start.at + settleMs;
    const settled = frames.filter((s) => s.at >= settledAt);
    const lines = (settled.length > 0 ? settled : [frames.at(-1)])
      .map((s) => s.at - clock(s) * 1000)
      .sort((x, y) => x - y);
    runs.push({
      frames,
      line: lines[Math.floor(lines.length / 2)],
      from: start.t,
      to: clock(frames.at(-1)),
      settledAt,
      // Cut short by the sample's end before its clock could be read.
      cut: settled.length === 0 && frames.at(-1) === pairs.at(-1),
    });
    frames = [];
  };
  for (const s of pairs) {
    const t = clock(s);
    if (t === null) {
      close();
      continue;
    }
    if (frames.length > 0) {
      const p = frames.at(-1);
      if (!same(p, s) || t - clock(p) < -0.001) close();
    }
    frames.push(s);
  }
  close();
  return runs;
}

/**
 * Maps the sound's runs onto the clock track's clicks and the video's runs
 * onto its wall hits, and pairs each hit with the clicks heard for it
 * (the same second, within 500 ms): `skipped` hits had none, `doubled`
 * more than one, `off` one more than SYNC_S away; `strays` are clicks no
 * hit claimed. A run of either starts on a hit when it starts within
 * CLICK_HEAD_S of a whole second (a wrap to 4 s, the entry at 2 s);
 * each run starts where its element was last played or sought from
 * (`starts`; the stage video is -1), as a clock read a frame later is
 * past it, WebKit's sound clock reads early, and a waiting element plays
 * before it takes over. `badFrames` are the frames where both play and the
 * sound is more than SYNC_S from the video, with nothing left out: the
 * sound read from its clock, or from its run's settled clock in the
 * SOUND_SETTLE_MS after its element's play() (`rawBadFrames` reads the
 * clock there too), and a sound still in the pass's last moments while the
 * video runs from its restart point taken one pass on. Only the frames of
 * a run the sample's end cut short before its clock settled are left out
 * (`unjudged`).
 */
function clickReport({ pairs, starts }) {
  const end = audioDemo().audio.tracks.clock.durationSeconds;
  const seconds = (from, to) => {
    const out = [];
    for (let c = Math.ceil(from - CLICK_HEAD_S); c <= to && c < end; c += 1) {
      out.push(c);
    }
    return out;
  };
  const hitsOf = (runs) =>
    runs
      .filter((run) => !run.cut)
      .flatMap((run) =>
        seconds(run.from, run.to).map((c) => ({ c, at: run.line + c * 1000 })),
      );
  /**
   * Where element `i`'s run seen first at frame `first` began: its last
   * play or seek before it, unless it paused after that. A waiting element
   * plays before it takes over, so its run began before it was the sound.
   */
  const startOf = (i) => (first) => {
    const last = starts
      .filter((e) => e.i === i(first) && e.at <= first.at)
      .at(-1);
    return last === undefined || last.type === "pause" ? null : last;
  };
  /**
   * Element `i` was sought away from where frame `p` read it before frame
   * `s` (`clock`).
   */
  const sought = (i, clock) => (p, s) =>
    starts.some(
      (e) =>
        e.i === i(s) &&
        e.type === "seeking" &&
        e.at > p.at &&
        e.at <= s.at &&
        Math.abs(e.t - clock(p)) > 0.01,
    );
  const videoClock = (s) => (s.v !== null && s.vp === false ? s.v : null);
  const soundClock = (s) => (soundPlays(s) && s.as === false ? s.a : null);
  const videoSought = sought(() => -1, videoClock);
  const videoRuns = runsOf(
    pairs,
    videoClock,
    (p, s) => !videoSought(p, s),
    startOf(() => -1),
    VIDEO_SETTLE_MS,
  );
  const soundSought = sought((s) => s.ai, soundClock);
  const soundRuns = runsOf(
    pairs,
    soundClock,
    (p, s) => p.ai === s.ai && !soundSought(p, s),
    startOf((s) => s.ai),
    SOUND_SETTLE_MS,
  );
  const runOf = new Map();
  for (const run of soundRuns) for (const s of run.frames) runOf.set(s, run);
  /** The sound's time at frame `s`: its clock, or its run's settled one. */
  const heardAt = (s) => {
    const run = runOf.get(s);
    return run === undefined || s.at >= run.settledAt
      ? s.a
      : (s.at - run.line) / 1000;
  };
  const unsettled = (s) => {
    const run = runOf.get(s);
    return run?.cut === true && s.at < run.settledAt;
  };
  const { endSeconds, loopStartSeconds } = demoItem("video-sync");
  const pass = endSeconds - loopStartSeconds;
  /** The sound's time less the video's (ms), across a wrap one pass on. */
  const judgedOff = (s) => {
    const off = heardAt(s) - s.v;
    const across = off > pass / 2 ? -pass : off < -pass / 2 ? pass : 0;
    return Math.round((off + across) * 1000);
  };
  const first = pairs[0]?.at ?? 0;
  const last = pairs.at(-1)?.at ?? 0;
  // A hit near the end may have a sound whose clock had not settled.
  const inside = (at) => at >= first + EDGE_MS && at <= last - SOUND_SETTLE_MS;
  const allHits = hitsOf(videoRuns);
  const hits = allHits.filter((h) => inside(h.at));
  const heard = hitsOf(soundRuns);
  // A click for a hit just outside the window is no stray.
  const near = (k, h) => k.c === h.c && Math.abs(k.at - h.at) < 500;
  const claimed = new Set(
    heard.flatMap((k, i) =>
      allHits.some((h) => !inside(h.at) && near(k, h)) ? [i] : [],
    ),
  );
  const rows = hits.map((h) => {
    const offs = [];
    heard.forEach((k, i) => {
      if (near(k, h)) {
        claimed.add(i);
        offs.push(Math.round(k.at - h.at));
      }
    });
    return { c: h.c, at: Math.round(h.at), offs };
  });
  const strays = heard
    .filter((k, i) => !claimed.has(i) && inside(k.at))
    .map((k) => ({ c: k.c, at: Math.round(k.at) }));
  const playing = pairs.filter(
    (s) => videoPlays(s) && soundPlays(s) && s.as === false,
  );
  const both = playing.filter((s) => !unsettled(s));
  const bad = both
    .filter((s) => Math.abs(judgedOff(s)) > SYNC_S * 1000)
    .map((s) => ({ at: Math.round(s.at), v: s.v, a: s.a, off: judgedOff(s) }));
  const offs = rows.flatMap((r) => r.offs).sort((x, y) => x - y);
  const wrong = rows.filter(
    (r) => r.offs.length !== 1 || Math.abs(r.offs[0]) > SYNC_S * 1000,
  );
  return {
    wraps: wrapsOf(pairs).length,
    hits: rows.length,
    skipped: rows.filter((r) => r.offs.length === 0).length,
    doubled: rows.filter((r) => r.offs.length > 1).length,
    off: rows.filter(
      (r) => r.offs.length === 1 && Math.abs(r.offs[0]) > SYNC_S * 1000,
    ).length,
    strays: strays.length,
    clickOffMs: offs.length === 0 ? null : { min: offs[0], max: offs.at(-1) },
    frames: both.length,
    badFrames: bad.length,
    frameOffMs:
      both.length === 0
        ? null
        : {
            min: Math.min(...both.map(judgedOff)),
            max: Math.max(...both.map(judgedOff)),
          },
    rawBadFrames: both.filter((s) => Math.abs(s.a - s.v) > SYNC_S).length,
    unjudged: playing.length - both.length,
    wrong: wrong.slice(0, 6),
    strayList: strays.slice(0, 6),
    bad: bad.slice(0, 6),
  };
}

/** Every click once, on its hit, and every frame in step. */
const clicksInStep = (r) =>
  r.hits > 0 &&
  r.skipped === 0 &&
  r.doubled === 0 &&
  r.off === 0 &&
  r.strays === 0 &&
  r.badFrames === 0;

/**
 * Samples a second at a time until one passes with both playing on every
 * frame, the sound in step (judged as `clickReport` judges it, its clock
 * settled) and no seek of it landing: the session's first plays start,
 * prime and correct the sound for a few seconds. `{ ok, report }` with the
 * last second's stepReport.
 */
async function inStep(page, tries = 10) {
  let report = null;
  for (let n = 0; n < tries; n += 1) {
    const run = await sampleFor(page, 1000);
    report = stepReport(run);
    const steady = clickReport(run);
    if (
      run.seeks.length === 0 &&
      run.pairs.length > 0 &&
      run.pairs.every((s) => videoPlays(s) && soundPlays(s)) &&
      steady.badFrames === 0 &&
      steady.unjudged === 0
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
 * Opens the audio demo on video-title, the item before the video, and
 * presses Space onto the video (a read: it plays, and in Chrome that key
 * unlocks sound). Resolves with the page once the sound has played past
 * 2.5 s of the video, or null (a FAIL is recorded).
 */
async function ontoVideo(check, open, name) {
  const session = await open(name, {
    folder: audioDemoDir,
    closeHelp: true,
    hash: "#start=video-title",
  });
  const { page, cdp } = session;
  await page
    .waitForFunction(ON_ITEM, { timeout: 5000 }, "video-title")
    .catch(() => {});
  await page.evaluate(INSTALL_SEEK_LOG);
  await pressSpace(cdp);
  const { ok, s } = await waitPair(
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

// Every play of the video sound and every `playing` of the stage video,
// from the document (page times).
const INSTALL_PLAY_LOG = () => {
  window.__plays = [];
  for (const type of ["play", "playing"]) {
    document.addEventListener(
      type,
      (event) => {
        const el = event.target;
        const which =
          el?.id === "visual-video"
            ? "video"
            : el?.dataset?.slot === "video" && el.dataset.track
              ? "sound"
              : null;
        if (which !== null) {
          window.__plays.push({ which, type, at: performance.now() });
        }
      },
      true,
    );
  }
};

// ---------------------------------------------------------------------------

async function posters({ check, open, folders }) {
  if (!built(check, folders)) return;
  const session = await ontoVideo(check, open, "vs-posters");
  if (session === null) return;
  const { page, cdp } = session;
  const { pairs: playingRun } = await sampleFor(page, 600);
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
  const away = await waitPair(page, (s) => s.item === "pin" && !soundPlays(s));
  await wheelUntil(page, cdp, true, ON_ITEM, "video-sync-3", 4);
  const { pairs: walkedBack } = await sampleFor(page, 1500);
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
  await page.evaluate(INSTALL_PLAY_LOG);
  await pressTab(cdp);
  const skipped = await waitPair(page, (s) => s.item === "pin", 8000);
  await sleep(400);
  const plays = await page.evaluate(() => window.__plays);
  check(
    "a skip burst over the video shows its poster and plays none of its sound",
    skipped.ok && plays.length === 0 && !soundPlays(await readPair(page)),
    { skipped: skipped.s, plays },
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
  await waitPair(page, (s) => !soundPlays(s), 2000);
  await pressTab(cdp);
  const playing = await waitPair(
    page,
    (s) => s.item === "video-sync" && videoPlays(s) && soundPlays(s),
    4000,
  );
  // The skip plays the clip's 6 s pass in full: time for the landings.
  const steady = playing.ok ? await inStep(page) : { ok: false, report: null };
  const after = await readPair(page);
  check(
    'a skip burst with "Play videos in full" plays the video, and its sound with it, in step',
    on === "true" && playing.ok && steady.ok && after.item === "video-sync",
    { on, playing: playing.s, steady: steady.report, after },
  );
  await pressTab(cdp);
}

async function sync({ check, open, folders }) {
  if (!built(check, folders)) return;
  const session = await ontoVideo(check, open, "vs-sync");
  if (session === null) return;
  const { page } = session;
  // From late in the second pass (the video reaches 8 s and wraps to 4 s,
  // then every 4 s): ten wraps, every click and every frame judged. The
  // first pass holds the session's first start of the sound, before any
  // lead is learnt, and the first wrap's lead rests on a few starts.
  await waitPair(page, (s) => s.v !== null && s.v > 7.5, 7000);
  await waitPair(page, (s) => s.v !== null && s.v > 4 && s.v < 4.6, 2000);
  await waitPair(page, (s) => s.v !== null && s.v > 6.6 && s.v < 7.4, 5000);
  const run = await sampleFor(page, 10 * 4000 + 1200);
  const report = clickReport(run);
  check(
    "across ten wraps every click of the sound plays once, within 80 ms of its wall hit, and every frame is within 80 ms of the video, re-seeks included",
    report.wraps >= 10 && clicksInStep(report),
    { ...report, seeksOfSound: run.seeks.length },
  );

  // Each of the next two runs 5 s, over the next wrap, so a check of the
  // sound's landings before it is never cut short.
  const RUN_MS = 5000;

  // A seek of the video forward, early in a pass: the sound stops, and
  // starts again where the video is.
  await waitPair(page, (s) => s.v !== null && s.v > 4.1 && s.v < 4.4, 6000);
  const seekAt = await page.evaluate(() => {
    const v = document.getElementById("visual-video");
    v.currentTime += 1;
    return performance.now();
  });
  const afterSeek = await sampleFor(page, RUN_MS);
  const seekReport = stepReport(afterSeek, [seekAt]);
  check(
    "after a seek of the video the sound is back within 80 ms of it",
    seekReport.judged >= SETTLED_FRAMES && seekReport.badCount === 0,
    seekReport,
  );

  // The sound's own clock knocked 300 ms ahead, once the wrap's own
  // landing is over (about 1 s after it): it re-seeks onto the video, at
  // once in Chrome, which finishes the knock's seek between two frames,
  // and once that seek has landed in WebKit, which holds the clock after
  // it too.
  await waitPair(page, (s) => s.v !== null && s.v > 5.2 && s.v < 5.5, 6000);
  const knockAt = await page.evaluate(() => {
    const sound = document.querySelector('#audio [data-slot="video"]');
    sound.currentTime += 0.3;
    return performance.now();
  });
  const afterKnock = await sampleFor(page, RUN_MS);
  const knockReport = stepReport(afterKnock, [knockAt]);
  // The player puts it back by handing over to its other element, which
  // it starts where the video will be (the knocked one is never sought).
  const knocked = afterKnock.pairs.find((s) => s.at >= knockAt)?.ai ?? null;
  const handedOver = afterKnock.pairs.some(
    (s) => s.at >= knockAt && s.ai !== null && s.ai !== knocked,
  );
  check(
    "a sound more than 80 ms off its video is put back onto it",
    handedOver &&
      knockReport.judged >= SETTLED_FRAMES &&
      knockReport.badCount === 0,
    { knockAt: Math.round(knockAt), knocked, handedOver, ...knockReport },
  );
}

async function chain({ check, open, folders }) {
  if (!built(check, folders)) return;
  const session = await ontoVideo(check, open, "vs-chain");
  if (session === null) return;
  const { page, cdp } = session;
  const steady = await inStep(page);
  // Marks the elements, so a restart on a fresh one shows.
  await page.evaluate(() => {
    document.getElementById("visual-video").__mark = true;
    for (const el of document.querySelectorAll('#audio [data-slot="video"]')) {
      el.__mark = true;
    }
  });
  const before = await readPair(page);
  const runs = [];
  for (const id of ["video-sync-2", "video-sync-3"]) {
    await pressSpace(cdp);
    await page.waitForFunction(ON_ITEM, { timeout: 3000 }, id).catch(() => {});
    runs.push({ id, run: await sampleFor(page, 2500) });
  }
  const marked = await page.evaluate(
    () =>
      document.getElementById("visual-video")?.__mark === true &&
      Array.from(document.querySelectorAll('#audio [data-slot="video"]')).every(
        (el) => el.__mark === true,
      ),
  );
  const { endSeconds, loopStartSeconds } = demoItem("video-sync");
  // Over both lines: a wrap at the end of one restarts the sound early in
  // the next.
  const wraps = wrapsOf(runs.flatMap(({ run }) => run.pairs));
  const reports = runs.map(({ id, run }) => {
    // A wrap pauses both a moment: the video at its range end, then the
    // sound until the video plays again from its loop point.
    const atWrap = (s) =>
      (s.v !== null && s.v >= endSeconds - 0.1) ||
      wraps.some((w) => s.at >= w && s.at < w + 500);
    // The clip only ever goes back from its range end to its loop point:
    // never to its start, as a restart would.
    const backs = run.pairs
      .slice(1)
      .map((s, i) => [run.pairs[i].v, s.v])
      .filter(([p, v]) => p !== null && v !== null && v < p - 0.05);
    return {
      id,
      onItem: run.pairs.every((s) => s.item === id),
      playing: run.pairs.every(
        (s) => (videoPlays(s) && soundPlays(s)) || atWrap(s),
      ),
      loopsOnly: backs.every(
        ([p, v]) =>
          p >= endSeconds - 0.1 && Math.abs(v - loopStartSeconds) < 0.1,
      ),
      backs,
      clicks: clickReport(run),
    };
  });
  check(
    "under the text chain the clip plays on, and its sound with it, never restarted, every click once on its wall hit and every frame within 80 ms",
    steady.ok &&
      marked &&
      reports.every(
        (r) => r.onItem && r.playing && r.loopsOnly && clicksInStep(r.clicks),
      ),
    { steady: steady.report, before, marked, reports },
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
  const before = await waitPair(page, (s) => full(s) && !soundPlays(s));
  await pressSpace(cdp); // video-sync
  const down = await waitPair(page, (s) => soundPlays(s) && ducked(s), 3000);
  // Through the first wrap (the video reaches 8 s about 6 s in): the music
  // stays down, never rising while the video loops back.
  const { pairs: through } = down.ok
    ? await sampleFor(page, 6500)
    : { pairs: [] };
  const wrapped = wrapsOf(through).length > 0;
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
  const up = await waitPair(page, (s) => full(s) && !soundPlays(s), 3000);
  check(
    "leaving the video lifts the duck: the music comes back to its level",
    up.ok,
    up.s,
  );
}

async function menus({ check, open, folders }) {
  if (!built(check, folders)) return;
  const session = await ontoVideo(check, open, "vs-menus");
  if (session === null) return;
  const { browser, page, cdp } = session;
  // `strict`: every click once on its wall hit and every frame in step,
  // from before the screen opens to 2.5 s after it closes. A hidden page is
  // shown again by the engine itself, its video resuming with no word to
  // the player, so its sound is judged once each seek has landed.
  const under = async (name, openIt, closeIt, strict) => {
    const steady = await inStep(page);
    // Opened mid-pass: the sound of the wrap before it has had its clock
    // settle, and its resume lands before the next wrap.
    await waitPair(page, (s) => s.v !== null && s.v > 5 && s.v < 5.5, 6000);
    await page.evaluate(START_SAMPLES, READ_PAIR.toString());
    await sleep(200);
    await openIt();
    await sleep(300);
    const a = await readPair(page);
    await sleep(600);
    const b = await readPair(page);
    const closedAt = await closeIt();
    const resumed = await waitPair(
      page,
      (s) => videoPlays(s) && soundPlays(s),
      3000,
    );
    await sleep(strict ? 2500 : 3 * LAND_MS + 600);
    const run = await page.evaluate(STOP_SAMPLES, LAND_MS);
    const report = strict
      ? clickReport(run)
      : stepReport(
          { ...run, pairs: run.pairs.filter((s) => s.at >= closedAt) },
          [closedAt],
        );
    const held = (s) => s.vp === true && s.track !== null && s.ap === true;
    check(
      `${name} pauses the video and its sound, neither moving; ${strict ? "closing it resumes both, every click once on its wall hit and every frame within 80 ms" : "shown again, both resume in step"}`,
      steady.ok &&
        held(a) &&
        held(b) &&
        Math.abs(b.a - a.a) < CLOCK_SETTLE_S &&
        Math.abs(b.v - a.v) < CLOCK_SETTLE_S &&
        resumed.ok &&
        (strict
          ? clicksInStep(report)
          : report.judged >= SETTLED_FRAMES && report.badCount === 0),
      { a, b, resumed: resumed.s, report },
    );
  };
  const now = () => page.evaluate(() => performance.now());
  await under(
    "the Esc screen",
    () => openSettings(page, cdp),
    async () => {
      await closeSettings(page, cdp);
      return now();
    },
    true,
  );
  await under(
    "the branch map",
    async () => {
      await pressM(cdp);
      await page.waitForFunction(MAP_OPEN, { timeout: 3000 }).catch(() => {});
    },
    async () => {
      await pressM(cdp);
      await page.waitForFunction(MAP_CLOSED, { timeout: 3000 }).catch(() => {});
      return now();
    },
    true,
  );
  await under(
    "a hidden page",
    () => setPageVisible(browser, page, false),
    async () => {
      await setPageVisible(browser, page, true);
      return now();
    },
    false,
  );
}

export const parts = [posters, skipInFull, sync, chain, duck, menus];
