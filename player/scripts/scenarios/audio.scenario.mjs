// Sound (docs/plan.md Phase 47, items 5 and 18) on fixtures/audio-demo,
// read through the player's test hook, never by listening: the hidden
// `#audio` lists the player's sounds (`sounds()`: slot, track, paused,
// currentTime, volume) and carries the target sound (`data-target`) and
// `data-unlocked`; the loops are read from a tap of the mix (soundtap.mjs).
//
// Each part opens its own browser on the audio demo:
// - Space, the wheel, `e`, a bookmark, skip and a reload each land on the
//   item's target, with exactly its music and ambience playing at full
//   level; a loop in both sets plays on unrestarted (`u` lands in the join
//   part: the demo's only unseen content `u` reaches is the route not
//   taken, since `u` skips the reader's own continuation);
// - the track rules: a crossfade, a music track that plays once and stays
//   silent, a play that starts partway and loops back to its restart point,
//   a fade to silence;
// - loops play on (item 14), read from the tap: the mix matches the
//   tracks' decoded samples looped, sample for sample, through three
//   wraps of rain and hum, of the calm tune and of `steps` from its loop
//   point, and `amb-shrink` fades the rain while the hum plays on in the
//   same phase (on WebKit both with and without the key rule);
// - one-shots fire only on read arrivals: delayed, cut by a channel,
//   overlapping without one, dropped when the reader moves on first, faded
//   out by a walk, and never fired by a walk, a jump or skip;
// - the join's music follows the route read last, each route in turn;
// - with a gesture required (the WebKit driver's option; Chrome always
//   requires one) nothing plays after a reload until a key, the "Press any
//   key for sound" hint shows and moves nothing, Esc does not unlock it,
//   and one Space unlocks sound and still does its own job; a one-shot and
//   a voice line auto-forward starts seconds after that one key still
//   play; the stock WebKit driver, like the macOS app, plays at once and
//   shows no hint;
// - a hidden page pauses every sound and a shown one resumes;
// - the Esc screen pauses every sound (music, ambience, one-shots, voice)
//   and closing it resumes them; under the branch map music and ambience
//   play on and the voice pauses until it closes;
// - auto-forward waits for the long voice line while it is audible, and
//   only for the line's text once Voice is at 0 (an imported progress file
//   carries the setting);
// - fixtures/demo, a game without audio, makes no <audio> element and no
//   hook, and openGame's current() reports `audio` (null there).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openGame } from "../testing/kinetic.mjs";
import {
  audioDemoDir,
  CHOICE_OPEN,
  CONFIG_CONTROL,
  CONFIRM_CONTROL,
  CONFIRM_OPEN,
  clickCenter,
  closeSettings,
  demoDir,
  engine,
  INSTALL_PILL_LOG,
  MAP_CLOSED,
  MAP_OPEN,
  MAP_READY,
  onWebKit,
  openSettings,
  pressA,
  pressB,
  pressDigit,
  pressE,
  pressEscape,
  pressH,
  pressKey,
  pressM,
  pressSpace,
  pressTab,
  pressU,
  pressZ,
  READ_MAP_CARDS,
  readPills,
  repoRoot,
  scenarioRoot,
  setPageVisible,
  sleep,
  wheelUntil,
} from "./harness.mjs";
import {
  checkLoops,
  installTap,
  readClock,
  startTap,
  stopTap,
} from "./soundtap.mjs";

export const title =
  "sound: targets, one-shots, unlock, menus and the voice hold";

// The fixture is built, not committed (.gitignore): each part fails with
// how to build it when it is missing.
const BUILD_HINT =
  "fixtures/audio-demo is missing: build it with .venv/bin/python fixtures/build_audio_demo.py";

let demo = null;
/** The audio demo's manifest (read once). */
function audioDemo() {
  demo ??= JSON.parse(
    readFileSync(
      join(repoRoot, "fixtures", "audio-demo", "manifest.json"),
      "utf8",
    ),
  );
  return demo;
}
const indexOf = (id) => audioDemo().items.findIndex((it) => it.id === id);
const tracks = () => audioDemo().audio.tracks;

/**
 * What should sound at item `id` of the audio demo (docs/content-format.md,
 * "What plays at an item"), worked out on the demo's own shape: the path
 * back runs through the items before its one decision, then the route
 * picked there (`route`: "warm" or "cold"), then the items after the join.
 */
function expectedTarget(id, route = "warm") {
  const { items, branches } = audioDemo();
  const [decision] = branches;
  const at = (rid) => indexOf(rid);
  const after = at(decision.after);
  const spans = Object.fromEntries(
    decision.routes.map((r) => [r.id, [at(r.start), at(r.end)]]),
  );
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
  const index = at(id);
  const inRoute = Object.entries(spans).find(
    ([, [a, b]]) => index >= a && index <= b,
  );
  let path;
  if (index <= after) path = range(0, index);
  else if (inRoute) path = [...range(0, after), ...range(inRoute[1][0], index)];
  else {
    const [a, b] = spans[route];
    path = [
      ...range(0, after),
      ...range(a, b),
      ...range(at(decision.continueAt), index),
    ];
  }
  const last = (field) => {
    for (let k = path.length - 1; k >= 0; k -= 1) {
      const audio = items[path[k]].audio;
      if (audio !== undefined && field in audio) return audio[field];
    }
    return field === "music" ? null : [];
  };
  // The visual a line shows is the media item before it.
  let visual = index;
  while (items[visual].type === "text") visual -= 1;
  const sound = items[visual].audio?.videoSound;
  return {
    music: last("music"),
    ambience: last("ambience"),
    voice: items[index].audio?.voice ?? null,
    videoSound:
      sound === undefined
        ? null
        : { track: sound.track, duck: sound.duck ?? 1 },
  };
}

// The page as the sound sees it, in one round trip.
const READ_SOUND = () => {
  const hook = document.getElementById("audio");
  const hint = document.getElementById("sound-hint");
  let target = null;
  try {
    target = JSON.parse(hook?.dataset.target ?? "null");
  } catch {}
  return {
    now: performance.now(),
    item: document.getElementById("stage")?.getAttribute("data-item") ?? null,
    hook: hook !== null,
    audioCount: document.querySelectorAll("audio").length,
    target,
    unlocked: hook?.dataset.unlocked === "true",
    hint: hint !== null && !hint.hidden,
    // Every sound made so far, in the order made: `n` names one.
    els: (hook?.sounds?.() ?? []).map((sound, n) => ({
      n,
      slot: sound.slot,
      track: sound.track,
      paused: sound.paused,
      t: Math.round(sound.currentTime * 1000) / 1000,
      v: Math.round(sound.volume * 1000) / 1000,
    })),
  };
};
const readSound = (page) => page.evaluate(READ_SOUND);

/** The elements of `slot` (or every slot) playing a track. */
const playing = (s, slot = null) =>
  s.els.filter(
    (e) => e.track !== "" && !e.paused && (slot === null || e.slot === slot),
  );
const sorted = (list) => [...list].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether exactly the target's music and ambience play, each at its
 * track's full level (the fades done, nothing fading out).
 */
function bedMatches(s, target) {
  if (s.target === null || !same(s.target, target)) return false;
  const music = playing(s, "music");
  const ambience = playing(s, "ambience");
  const full = [...music, ...ambience].every(
    (e) => Math.abs(e.v - (tracks()[e.track].volume ?? 1)) < 0.02,
  );
  return (
    same(
      music.map((e) => e.track),
      target.music === null ? [] : [target.music],
    ) &&
    same(sorted(ambience.map((e) => e.track)), sorted(target.ambience)) &&
    full
  );
}

/** Polls the page until `ok(sound)`; `{ ok, s }` with the last reading. */
async function waitSound(page, ok, timeout = 5000) {
  const until = Date.now() + timeout;
  for (;;) {
    const s = await readSound(page);
    if (ok(s)) return { ok: true, s };
    if (Date.now() >= until) return { ok: false, s };
    await sleep(50);
  }
}

/** Presses Space until the stage shows item `id`. */
async function spaceToItem(page, cdp, id, limit = 40) {
  for (let n = 0; n < limit; n += 1) {
    if ((await readSound(page)).item === id) return true;
    await pressSpace(cdp);
    await sleep(90);
  }
  return (await readSound(page)).item === id;
}

const ON_ITEM = (id) =>
  document.getElementById("stage")?.getAttribute("data-item") === id;

/** What a check reports about a reading: the item, target and live tracks. */
const evidence = (s) => ({
  item: s.item,
  target: s.target,
  unlocked: s.unlocked,
  hint: s.hint,
  live: s.els
    .filter((e) => e.track !== "")
    .map(
      (e) =>
        `${e.slot}:${e.track}${e.paused ? " (paused)" : ""} t${e.t} v${e.v}`,
    ),
});

// How far a just-paused sound's clock may still be read to move (frozen):
// a video sound's element in WebKit settles a little after pause() (seen
// moving 0.07-0.17 s either way); one playing on would move the whole
// 0.6 s between readings.
const CLOCK_SETTLE_S = 0.25;

// Nothing plays in `y`, and each sound holding a track in `x` holds it,
// paused at the same place. (A one-shot still due may load into a sound
// meanwhile; it waits paused too.)
const frozen = (x, y) =>
  playing(y).length === 0 &&
  x.els
    .filter((e) => e.track !== "")
    .every((e) => {
      const later = y.els[e.n];
      return (
        later?.track === e.track &&
        later.paused === e.paused &&
        Math.abs(later.t - e.t) < CLOCK_SETTLE_S
      );
    });

/**
 * Each sound holding a track in reading `x`, or only those of `slot`
 * playing `track`, stands in reading `y` no further on than the page's time
 * between the two (a restart from its start, or a jump, lands elsewhere),
 * counting a loop's wrap back to its restart point; and in `y` it plays
 * (`playing`) or is paused.
 */
const movedOn = (x, y, { playing, slot = null, track = null }) =>
  x.els
    .filter(
      (e) =>
        e.track !== "" &&
        (slot === null || e.slot === slot) &&
        (track === null || e.track === track),
    )
    .every((e) => {
      const now = y.els[e.n];
      if (now === undefined || now.track !== e.track) return false;
      if (now.paused === playing) return false;
      const t = tracks()[e.track];
      const loopStart = t.loopStartSeconds ?? t.startSeconds ?? 0;
      let moved = now.t - e.t;
      if (moved < 0 && t.loop !== false) moved += t.durationSeconds - loopStart;
      return moved >= 0 && moved <= (y.now - x.now) / 1000 + 0.05;
    });

const openDemo = (open, name, options = {}) =>
  open(name, { folder: audioDemoDir, closeHelp: true, ...options });

/** False, with the build hint as evidence, when the fixture is missing. */
function built(check, folders) {
  if (folders.audioDemo) return true;
  check("fixtures/audio-demo is built", false, BUILD_HINT);
  return false;
}

// ---------------------------------------------------------------------------

async function landings({ check, open, folders }) {
  if (!built(check, folders)) return;
  const { page, cdp } = await openDemo(open, "landings");
  const landed = async (how, id, extra = () => true) => {
    const target = expectedTarget(id);
    const { ok, s } = await waitSound(
      page,
      (now) => now.item === id && bedMatches(now, target) && extra(now),
    );
    check(
      `${how} lands on ${id} with its target and exactly its music and ambience playing`,
      ok,
      { expected: target, ...evidence(s) },
    );
    return s;
  };

  await spaceToItem(page, cdp, "music-carry");
  await landed("Space", "music-carry");
  await pressB(cdp);
  await page
    .waitForFunction(
      () => document.getElementById("flash")?.textContent === "Bookmarked",
      { timeout: 5000 },
    )
    .catch(() => {});
  await spaceToItem(page, cdp, "amb-carry");
  await landed("Space", "amb-carry");
  await wheelUntil(page, cdp, true, ON_ITEM, "music-start", 12);
  await landed("the wheel", "music-start");
  await pressE(cdp);
  await landed("e", "amb-carry");

  await pressM(cdp);
  await page.waitForFunction(MAP_READY, { timeout: 5000 }).catch(() => {});
  const { cards = [] } = await page.evaluate(READ_MAP_CARDS);
  const card = cards.find((c) => c.itemId === "music-carry");
  if (card !== undefined) await clickCenter(cdp, card.rect);
  await landed("a bookmark", "music-carry");

  await pressTab(cdp);
  const stopped = await waitSound(
    page,
    (s) => s.item !== null && indexOf(s.item) > indexOf("music-carry"),
    5000,
  );
  await sleep(600); // the burst ends on the last seen item
  const skippedTo = (await readSound(page)).item;
  await landed("skip", skippedTo ?? "amb-shrink");
  check(
    "skip ran on from the bookmark to the last item seen",
    stopped.ok && skippedTo === "amb-carry",
    { skippedTo },
  );

  await page.reload();
  await page
    .waitForFunction(ON_ITEM, { timeout: 5000 }, "amb-carry")
    .catch(() => {});
  if (!onWebKit) {
    // Chrome plays nothing after a reload until a key (the unlock part).
    await waitSound(page, (s) => s.hint, 3000);
    await pressZ(cdp);
  }
  await landed("a reload", "amb-carry", (s) => s.unlocked && !s.hint);

  // The next set drops the rain and keeps the hum: the hum plays on,
  // never restarted. Its 4 s loop wraps (on its other element), so its
  // clock is read against the page's: a restart at the arrival would put
  // it well off. Read first mid-loop, where a restart is plain to see.
  const humOf = (s) =>
    playing(s, "ambience").find((e) => e.track === "hum") ?? null;
  const mid = await waitSound(page, (s) => {
    const t = humOf(s)?.t ?? -1;
    return t >= 0.8 && t <= 2.2;
  });
  const hum = humOf(mid.s);
  await pressSpace(cdp); // amb-shrink
  const shrunk = await waitSound(page, (s) =>
    bedMatches(s, expectedTarget("amb-shrink")),
  );
  const humAfter = humOf(shrunk.s) ?? undefined;
  const loopS = tracks().hum.durationSeconds;
  const due =
    hum === null ? -1 : (hum.t + (shrunk.s.now - mid.s.now) / 1000) % loopS;
  const off =
    humAfter === undefined
      ? Infinity
      : Math.min(
          Math.abs(humAfter.t - due),
          loopS - Math.abs(humAfter.t - due),
        );
  check(
    "a loop in both the old and the new ambience set plays on unrestarted while the other fades out",
    shrunk.ok &&
      hum !== null &&
      humAfter?.track === "hum" &&
      !humAfter.paused &&
      off < 0.3,
    { hum, humAfter, due, after: evidence(shrunk.s) },
  );
}

async function trackRules({ check, open, folders }) {
  if (!built(check, folders)) return;
  const { page, cdp } = await openDemo(open, "tracks");
  await spaceToItem(page, cdp, "music-carry");
  await waitSound(page, (s) => bedMatches(s, expectedTarget("music-carry")));

  await pressSpace(cdp); // music-crossfade, a 4 s fade
  await sleep(1800);
  const mid = await readSound(page);
  const calm = playing(mid, "music").find((e) => e.track === "calm");
  const bright = playing(mid, "music").find((e) => e.track === "bright");
  const done = await waitSound(
    page,
    (s) => bedMatches(s, expectedTarget("music-crossfade")),
    5000,
  );
  check(
    "a crossfade plays both tunes partway through, the old falling as the new rises, then the new alone",
    calm !== undefined &&
      bright !== undefined &&
      calm.v > 0.1 &&
      calm.v < 0.9 &&
      bright.v > 0.1 &&
      bright.v < 0.9 &&
      done.ok,
    { mid: evidence(mid), after: evidence(done.s) },
  );

  await pressSpace(cdp); // music-once: a 3 s fanfare with loop: false
  const started = await waitSound(
    page,
    (s) => playing(s, "music").some((e) => e.track === "fanfare"),
    3000,
  );
  await sleep(3600);
  const ended = await readSound(page);
  await sleep(1000);
  const later = await readSound(page);
  const fanfare = (s) => s.els.find((e) => e.track === "fanfare");
  check(
    "a music track with loop: false plays once, then stays silent while the music is still it",
    started.ok &&
      ended.target?.music === "fanfare" &&
      playing(ended, "music").length === 0 &&
      fanfare(later)?.paused === true &&
      fanfare(later)?.t === fanfare(ended)?.t,
    { started: started.ok, ended: evidence(ended), later: evidence(later) },
  );

  await pressSpace(cdp); // music-partway: starts at 6 s, loops back to 3 s
  const first = await waitSound(
    page,
    (s) => playing(s, "music").some((e) => e.track === "steps"),
    3000,
  );
  const startT = playing(first.s, "music").find((e) => e.track === "steps")?.t;
  const arrived = Date.now();
  // The track ends at 12 s: about 6 s on, it wraps to 3 s, not 0 or 6.
  await sleep(Math.max(0, 7000 - (Date.now() - arrived)));
  const wrapped = await readSound(page);
  const wrapT = playing(wrapped, "music").find((e) => e.track === "steps")?.t;
  check(
    "a play starts at startSeconds and a loop restarts at loopStartSeconds",
    startT !== undefined &&
      startT >= 5.9 &&
      startT < 7.5 &&
      wrapT !== undefined &&
      wrapT >= 3 &&
      wrapT < 5.5,
    { startT, wrapT },
  );

  await pressSpace(cdp); // music-stop: a 2 s fade to silence
  const silent = await waitSound(
    page,
    (s) => bedMatches(s, expectedTarget("music-stop")),
    4000,
  );
  check(
    "music: null fades the music out to silence",
    silent.ok && playing(silent.s).length === 0,
    evidence(silent.s),
  );
}

// The audio demo's track `id`: its manifest entry and its file's bytes, the
// base64 its script (`<file>.js`) holds.
function trackSource(id, read) {
  const track = tracks()[id];
  const script = readFileSync(
    join(repoRoot, "fixtures", "audio-demo", `${track.file}.js`),
    "utf8",
  );
  const sound = read.sounds.find((x) => x.track === id && !x.paused);
  return {
    name: id,
    track,
    base64: /"([A-Za-z0-9+/=]*)"\);\n?$/.exec(script)?.[1] ?? "",
    gain: track.volume ?? 1,
    read: { at: read.at, position: sound?.currentTime ?? null },
  };
}

// How long after an arrival the mix is compared: its fade (the demo's
// items fade over the default 1 s) is over by then.
const STEADY_S = 1.5;

/**
 * Opens the demo at `before`, taps the mix, and reads Space onto `item`
 * (the key that unlocks sound); resolves with the session, the context
 * time of the arrival, and the hook's reading 0.4 s later, before any
 * loop has wrapped.
 */
async function tapFrom(open, name, before, item, options) {
  const session = await openDemo(open, name, {
    hash: `#start=${before}`,
    ...options,
  });
  const { page, cdp } = session;
  await page
    .waitForFunction(ON_ITEM, { timeout: 5000 }, before)
    .catch(() => {});
  const tap = await installTap(page);
  await startTap(page);
  await spaceToItem(page, cdp, item);
  const arrived = (await readClock(page)).at;
  await sleep(400);
  return { ...session, tap, arrived, read: await readClock(page) };
}

/**
 * Whether the tap heard the loops play on unbroken: every frame of the
 * window matched the tracks looped, with nothing lost, through at least
 * `wraps[name]` wraps of each.
 */
const loopsHeld = (result, wraps) =>
  result.ok === true &&
  result.lostFrames === 0 &&
  result.badFrames === 0 &&
  Object.entries(wraps).every(([name, least]) => {
    const source = result.sources.find((x) => x.name === name);
    return (
      source !== undefined &&
      source.wraps.length >= least &&
      source.wraps.every((w) => w.worst <= 1e-3)
    );
  });

/** A check's result, shortened for its evidence line. */
const loopEvidence = (result) => ({
  ...result,
  sources: result.sources?.map((x) => ({
    name: x.name,
    moved: x.moved,
    began: Math.round(x.began * 1e5) / 1e5,
    wraps: x.wraps.map((w) => `${w.at}:${w.worst.toExponential(1)}`),
  })),
});

/** The check's words on WebKit with the key rule, so the two read apart. */
const keyRule = (options) =>
  options.requireGestureForAudio ? " (WebKit with the key rule)" : "";

/** `part` named for the runner (its times file), with the key rule apart. */
const loopPart = (name, options, part) =>
  Object.defineProperty(part, "name", {
    value: options.requireGestureForAudio ? `${name}KeyRule` : name,
  });

// Rain (6 s, FLAC, at the track's 0.5) and hum (4 s, WAV) loop from 0
// through three of the rain's lengths over `amb-start` and `amb-carry`;
// `amb-shrink` drops the rain and keeps the hum (docs/plan.md Phase 47,
// item 14).
const ambienceLoops = (options = {}) =>
  loopPart("ambienceLoops", options, async ({ check, open, folders }) => {
    if (!built(check, folders)) return;
    const { page, cdp, tap, arrived, read } = await tapFrom(
      open,
      `loops-ambience${options.requireGestureForAudio ? "-key" : ""}`,
      "amb-title",
      "amb-start",
      options,
    );
    await sleep(10000);
    await spaceToItem(page, cdp, "amb-carry");
    await sleep(11000);
    const carried = (await readClock(page)).at;
    const sources = [trackSource("rain", read), trackSource("hum", read)];
    const first = await checkLoops(page, {
      sources,
      from: arrived + STEADY_S,
      to: carried,
    });
    check(
      `rain and hum loop on through three of the rain's lengths over amb-start and amb-carry, the mix matching both tracks looped sample for sample at every wrap${keyRule(options)}`,
      tap.ok && loopsHeld(first, { rain: 3, hum: 4 }) && first.seconds >= 18,
      { tap, ...loopEvidence(first) },
    );

    await spaceToItem(page, cdp, "amb-shrink");
    const shrunk = (await readClock(page)).at;
    await sleep(5000);
    const end = (await readClock(page)).at;
    await stopTap(page);
    // Both before the arrival, with the rain's level through its fade.
    const before = await checkLoops(page, {
      sources,
      from: shrunk - 1.6,
      to: shrunk - 0.1,
      gainsAt: [shrunk - 0.5, shrunk + 0.5, shrunk + 2],
    });
    // The hum alone after it: the rain gone, the hum in the same phase.
    const after = await checkLoops(page, {
      sources: [sources[1]],
      from: shrunk + STEADY_S,
      to: end,
    });
    const humBegan = (r) => r.sources?.find((x) => x.name === "hum")?.began;
    const rainAt = (k) => before.gains?.[k]?.gains.rain ?? Number.NaN;
    const rain = { before: rainAt(0), mid: rainAt(1), late: rainAt(2) };
    const rainVolume = tracks().rain.volume ?? 1;
    check(
      `amb-shrink fades the rain out over its second while the hum loops on unbroken, in the phase it had since amb-start${keyRule(options)}`,
      loopsHeld(before, { hum: 0 }) &&
        loopsHeld(after, { hum: 1 }) &&
        humBegan(before) === humBegan(first) &&
        humBegan(after) === humBegan(first) &&
        Math.abs(rain.before - rainVolume) < 0.01 &&
        rain.mid > 0.1 * rainVolume &&
        rain.mid < 0.9 * rainVolume &&
        Math.abs(rain.late) < 1e-3,
      {
        rain,
        humBegan: [humBegan(first), humBegan(before), humBegan(after)],
        before: loopEvidence(before),
        after: loopEvidence(after),
      },
    );
  });

// The calm tune (8 s, AAC) loops from 0 through three of its lengths over
// `music-start` and `music-carry`.
const musicLoop = (options = {}) =>
  loopPart("musicLoop", options, async ({ check, open, folders }) => {
    if (!built(check, folders)) return;
    const { page, cdp, tap, arrived, read } = await tapFrom(
      open,
      `loops-music${options.requireGestureForAudio ? "-key" : ""}`,
      "music-title",
      "music-start",
      options,
    );
    await sleep(12500);
    await spaceToItem(page, cdp, "music-carry");
    await sleep(14500);
    const end = (await readClock(page)).at;
    await stopTap(page);
    const result = await checkLoops(page, {
      sources: [trackSource("calm", read)],
      from: arrived + STEADY_S,
      to: end,
    });
    check(
      `the calm tune loops on through three of its lengths over music-start and music-carry, the mix matching it looped sample for sample at every wrap${keyRule(options)}`,
      tap.ok && loopsHeld(result, { calm: 3 }) && result.seconds >= 24,
      { tap, ...loopEvidence(result) },
    );
  });

// `steps` (Vorbis in WebM) starts at 6 s and loops back to 3 s at its end
// (12.001333 s, on its last whole sample): three wraps.
const partwayLoop = (options = {}) =>
  loopPart("partwayLoop", options, async ({ check, open, folders }) => {
    if (!built(check, folders)) return;
    const { page, tap, arrived, read } = await tapFrom(
      open,
      `loops-partway${options.requireGestureForAudio ? "-key" : ""}`,
      "music-once",
      "music-partway",
      options,
    );
    await sleep(27500);
    const end = (await readClock(page)).at;
    await stopTap(page);
    const result = await checkLoops(page, {
      sources: [trackSource("steps", read)],
      from: arrived + STEADY_S,
      to: end,
    });
    check(
      `steps loops from its end back to 3 s three times, the mix matching it looped sample for sample at every wrap${keyRule(options)}`,
      tap.ok &&
        loopsHeld(result, { steps: 3 }) &&
        read.sounds.some(
          (x) => x.track === "steps" && x.currentTime >= 6 && x.currentTime < 7,
        ),
      { tap, ...loopEvidence(result) },
    );
  });

// Every one-shot that starts, seen on the animation frame it first sounds
// (a sound of the sfx slot holding a track and not paused, after a frame
// where it did not, held another track or stood further on): the track,
// and when (page time).
const INSTALL_SFX_LOG = () => {
  window.__sfx = [];
  const last = new Map();
  const step = () => {
    const sounds = document.getElementById("audio")?.sounds?.() ?? [];
    sounds.forEach((sound, n) => {
      const was = last.get(n);
      const sounding = sound.track !== "" && !sound.paused;
      if (
        sound.slot === "sfx" &&
        sounding &&
        (was === undefined ||
          !was.sounding ||
          was.track !== sound.track ||
          sound.currentTime < was.t)
      ) {
        window.__sfx.push({ track: sound.track, at: performance.now() });
      }
      last.set(n, { sounding, track: sound.track, t: sound.currentTime });
    });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};
const pageNow = (page) => page.evaluate(() => performance.now());
const sfxSince = (page, since) =>
  page.evaluate((t) => window.__sfx.filter((e) => e.at >= t), since);

async function oneShots({ check, open, folders }) {
  if (!built(check, folders)) return;
  const { page, cdp } = await openDemo(open, "one-shots");
  await page.evaluate(INSTALL_SFX_LOG);
  await spaceToItem(page, cdp, "sfx-title");

  await pressSpace(cdp); // sfx-delay: the knock 1.5 s on
  const t0 = await pageNow(page);
  await sleep(2300);
  const knock = await sfxSince(page, t0 - 200);
  await pressSpace(cdp); // sfx-channel
  const t1 = await pageNow(page);
  await sleep(900);
  const sirenOn = await readSound(page);
  await sleep(1600);
  const cut = await readSound(page);
  await sleep(1000); // the bell (3 s) ends before the next line
  await pressSpace(cdp); // sfx-overlap
  await sleep(2500);
  const both = await readSound(page);
  const tracksOf = (s) => sorted(playing(s, "sfx").map((e) => e.track));
  check(
    "a read fires its one-shots: the knock 1.5 s late, the bell cutting the siren on its channel, both together without one",
    knock.length === 1 &&
      knock[0].track === "knock" &&
      knock[0].at - t0 >= 1300 &&
      same(tracksOf(sirenOn), ["siren"]) &&
      same(tracksOf(cut), ["bell"]) &&
      same(tracksOf(both), ["bell", "siren"]),
    {
      knock: knock.map((k) => ({ track: k.track, ms: Math.round(k.at - t0) })),
      sirenOn: tracksOf(sirenOn),
      cut: tracksOf(cut),
      both: tracksOf(both),
      t1,
    },
  );

  // Walking away fades the playing one-shots out; the walk and a jump
  // fire none.
  const walkAt = await pageNow(page);
  await wheelUntil(page, cdp, true, ON_ITEM, "sfx-channel", 3);
  const faded = await waitSound(
    page,
    (s) => playing(s, "sfx").length === 0,
    1500,
  );
  await sleep(2600);
  await pressE(cdp); // back to sfx-overlap, a jump
  await sleep(2800);
  const fired = await sfxSince(page, walkAt);
  check(
    "a walk fades out the one-shots playing; a walk and a jump onto one-shot lines fire none",
    faded.ok &&
      fired.length === 0 &&
      (await readSound(page)).item === "sfx-overlap",
    { faded: faded.ok, fired },
  );

  // A one-shot still waiting is dropped when the reader moves on first.
  await wheelUntil(page, cdp, true, ON_ITEM, "sfx-title", 4);
  await sleep(400);
  await pressSpace(cdp); // sfx-delay again: a read
  const t2 = await pageNow(page);
  await sleep(700);
  await pressSpace(cdp); // on to sfx-channel before the knock is due
  await sleep(2500);
  const dropped = await sfxSince(page, t2);
  check(
    "a one-shot still waiting is dropped when the reader moves on before it is due",
    !dropped.some((e) => e.track === "knock") &&
      dropped.some((e) => e.track === "siren"),
    dropped.map((e) => ({ track: e.track, ms: Math.round(e.at - t2) })),
  );

  // Skip over the one-shot lines fires none, nor does the item it stops on.
  await wheelUntil(page, cdp, true, ON_ITEM, "sfx-title", 4);
  await sleep(400);
  const skipAt = await pageNow(page);
  await pressTab(cdp);
  const stop = await waitSound(page, (s) => s.item === "sfx-overlap", 5000);
  await sleep(2600);
  const skipped = await sfxSince(page, skipAt);
  check(
    "skip over the one-shot lines fires none, nor does the line it stops on",
    stop.ok && skipped.length === 0,
    { stoppedOn: stop.s.item, skipped },
  );
}

async function joinMusic({ check, open, folders }) {
  if (!built(check, folders)) return;
  const { page, cdp } = await openDemo(open, "join", { manualChoices: true });
  await spaceToItem(page, cdp, "branch-ask");
  const results = [];
  /** Reads on to the join; its target and music, for the route read last. */
  const toJoin = async (route, how) => {
    await spaceToItem(page, cdp, "branch-join", 6);
    const target = expectedTarget("branch-join", route);
    const { ok, s } = await waitSound(page, (now) => bedMatches(now, target));
    results.push({ how, route, ok, ...evidence(s) });
  };
  const pick = async (digit, route) => {
    if (results.length === 0) await pressSpace(cdp);
    else await wheelUntil(page, cdp, true, CHOICE_OPEN, null, 6);
    await page.waitForFunction(CHOICE_OPEN, { timeout: 3000 }).catch(() => {});
    await pressDigit(cdp, digit);
    await toJoin(route, `pick ${digit}`);
  };
  await pick("1", "warm");
  // `u` from the join: the unseen route of a decision already reached.
  await pressU(cdp);
  const target = expectedTarget("route-cold");
  const viaU = await waitSound(
    page,
    (s) => s.item === "route-cold" && bedMatches(s, target),
  );
  check(
    "u lands on the unseen route's first item with its target and its music playing",
    viaU.ok,
    { expected: target, ...evidence(viaU.s) },
  );
  await toJoin("cold", "u, then Space");
  await pick("1", "warm");
  await pick("2", "cold");
  check(
    "the join plays the music of the route read last: warm, cold (entered by u), warm, cold",
    results.every((r) => r.ok) &&
      results.map((r) => r.target?.music).join() === "warm,cold,warm,cold",
    results,
  );
}

async function unlock({ check, open, folders }) {
  if (!built(check, folders)) return;
  const { page, cdp } = await openDemo(open, "unlock", {
    requireGestureForAudio: true,
  });
  await spaceToItem(page, cdp, "music-start");
  const first = await waitSound(page, (s) =>
    bedMatches(s, expectedTarget("music-start")),
  );
  check(
    "the first Space is the key that unlocks sound: the music plays",
    first.ok && first.s.unlocked && !first.s.hint,
    evidence(first.s),
  );

  await page.reload();
  // No page reads until the load's sound has tried to play: on WebKit a
  // script the driver runs counts as a gesture.
  await sleep(1500);
  const locked = await readSound(page);
  const layout = () =>
    page.evaluate(() =>
      ["stage", "overlay", "notice"].map((id) => {
        const r = document.getElementById(id)?.getBoundingClientRect();
        return r ? [r.left, r.top, r.width, r.height].map(Math.round) : null;
      }),
    );
  const withHint = await layout();
  const hintStyle = await page.evaluate(() => {
    const el = document.getElementById("sound-hint");
    const cs = el ? getComputedStyle(el) : null;
    return cs
      ? { text: el.textContent, position: cs.position, radius: cs.borderRadius }
      : null;
  });
  check(
    "after a reload nothing plays before a key: the target is set, its music waits, and the hint shows",
    locked.item === "music-start" &&
      same(locked.target, expectedTarget("music-start")) &&
      !locked.unlocked &&
      locked.hint &&
      playing(locked).length === 0 &&
      locked.els.some((e) => e.track === "calm"),
    evidence(locked),
  );

  await pressSpace(cdp); // a key that counts: unlocks and still advances
  const unlocked = await waitSound(
    page,
    (s) =>
      s.item === "music-carry" && bedMatches(s, expectedTarget("music-carry")),
  );
  const withoutHint = await layout();
  check(
    "one Space unlocks sound, hides the hint and still advances",
    unlocked.ok && unlocked.s.unlocked && !unlocked.s.hint,
    evidence(unlocked.s),
  );
  check(
    'the hint says "Press any key for sound" in a fixed pill, moving nothing',
    hintStyle?.text === "Press any key for sound" &&
      hintStyle.position === "fixed" &&
      hintStyle.radius === "999px" &&
      same(withHint, withoutHint),
    { hintStyle, withHint, withoutHint },
  );

  // A reload locks sound again. Esc, no activation, leaves it locked under
  // the Esc screen; the Space that closes the screen unlocks it.
  await page.reload();
  await sleep(1500);
  const relocked = await readSound(page);
  await pressEscape(cdp);
  await sleep(400);
  const underEsc = await readSound(page);
  await pressSpace(cdp);
  const closed = await waitSound(
    page,
    (s) =>
      s.item === "music-carry" && bedMatches(s, expectedTarget("music-carry")),
  );
  const escClosed = await page.evaluate(
    () => document.getElementById("help")?.hidden !== false,
  );
  check(
    "after another reload Esc does not unlock; the Space that closes the Esc screen does",
    !relocked.unlocked &&
      relocked.hint &&
      !underEsc.unlocked &&
      playing(underEsc).length === 0 &&
      closed.ok &&
      closed.s.unlocked &&
      escClosed,
    {
      relocked: evidence(relocked),
      underEsc: evidence(underEsc),
      closed: evidence(closed.s),
    },
  );
}

// Every sound that starts playing, seen on the animation frame it first
// sounds, as INSTALL_SFX_LOG sees one-shots: its slot and track, and when
// (page time). Installed before the page loads, so it waits for the hook.
const INSTALL_PLAYING_LOG = () => {
  window.__playing = [];
  const last = new Map();
  const step = () => {
    const sounds = document.getElementById("audio")?.sounds?.() ?? [];
    sounds.forEach((sound, n) => {
      const was = last.get(n);
      const sounding = sound.track !== "" && !sound.paused;
      if (
        sounding &&
        (was === undefined ||
          !was.sounding ||
          was.track !== sound.track ||
          sound.currentTime < was.t)
      ) {
        window.__playing.push({
          slot: sound.slot,
          track: sound.track,
          at: performance.now(),
        });
      }
      last.set(n, { sounding, track: sound.track, t: sound.currentTime });
    });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

// After the one key that unlocked sound (WebKit with the key rule), a
// one-shot and a voice line that auto-forward starts many seconds later
// still play.
async function soundsAfterUnlock({ check, open, folders }) {
  if (!built(check, folders)) return;
  const { page, cdp } = await openDemo(open, "after-unlock", {
    requireGestureForAudio: true,
  });
  await spaceToItem(page, cdp, "amb-stop");
  await page.evaluateOnNewDocument(INSTALL_PLAYING_LOG);
  await page.reload();
  await sleep(1500);
  const before = await readSound(page);
  await pressA(cdp); // the only key: it unlocks sound and starts auto-forward
  const keyAt = await pageNow(page);
  await page
    .waitForFunction(ON_ITEM, { timeout: 30000 }, "sfx-delay")
    .catch(() => {});
  await sleep(2500);
  const knock = await page.evaluate(() =>
    window.__playing.filter((e) => e.track === "knock"),
  );
  await page
    .waitForFunction(ON_ITEM, { timeout: 60000 }, "voice-mei")
    .catch(() => {});
  await sleep(800);
  const voice = await page.evaluate(() =>
    window.__playing.filter((e) => e.track === "mei-1"),
  );
  await pressA(cdp);
  check(
    "after the one key that unlocked sound, a one-shot and a voice line that auto-forward starts seconds later still play",
    !before.unlocked &&
      knock.length === 1 &&
      knock[0].at - keyAt > 5000 &&
      voice.length === 1,
    {
      before: evidence(before),
      knockMs: knock.map((e) => Math.round(e.at - keyAt)),
      voiceMs: voice.map((e) => Math.round(e.at - keyAt)),
    },
  );
}

async function autoplay({ check, open, folders }) {
  if (!built(check, folders)) return;
  const { page, cdp } = await openDemo(open, "autoplay");
  await spaceToItem(page, cdp, "music-start");
  await waitSound(page, (s) => bedMatches(s, expectedTarget("music-start")));
  await page.reload();
  await sleep(1500);
  const s = await readSound(page);
  if (onWebKit) {
    // The stock driver sets WebKit up as the macOS app does.
    const ok = (
      await waitSound(page, (now) =>
        bedMatches(now, expectedTarget("music-start")),
      )
    ).ok;
    check(
      "the stock WebKit driver, like the macOS app, plays after a reload with no key and shows no hint",
      ok && s.unlocked && !s.hint,
      evidence(s),
    );
  } else {
    check(
      "Chrome plays nothing after a reload until a key, and shows the hint",
      !s.unlocked && s.hint && playing(s).length === 0,
      evidence(s),
    );
  }
}

async function hiddenPage({ check, open, folders }) {
  if (!built(check, folders)) return;
  const { browser, page, cdp } = await openDemo(open, "hidden");
  await spaceToItem(page, cdp, "amb-carry");
  const shown = await waitSound(page, (s) =>
    bedMatches(s, expectedTarget("amb-carry")),
  );
  const hiddenState = await setPageVisible(browser, page, false);
  await sleep(300);
  const a = await readSound(page);
  await sleep(700);
  const b = await readSound(page);
  const shownState = await setPageVisible(browser, page, true);
  const back = await waitSound(page, (s) =>
    bedMatches(s, expectedTarget("amb-carry")),
  );
  check(
    "a hidden page pauses every sound where it had got to; shown again, they play on from there",
    shown.ok &&
      hiddenState === "hidden" &&
      playing(a).length === 0 &&
      frozen(a, b) &&
      shownState === "visible" &&
      back.ok &&
      movedOn(shown.s, a, { playing: false }) &&
      movedOn(b, back.s, { playing: true }),
    {
      hiddenState,
      shownState,
      a: evidence(a),
      b: evidence(b),
      back: evidence(back.s),
    },
  );
}

async function menus({ check, open, folders }) {
  if (!built(check, folders)) return;
  const { page, cdp } = await openDemo(open, "menus");
  const under = async (openIt, closeIt) => {
    const before = await readSound(page);
    await openIt();
    await sleep(300);
    const a = await readSound(page);
    await sleep(600);
    const b = await readSound(page);
    await closeIt();
    await sleep(500);
    const c = await readSound(page);
    return { before, a, b, c };
  };
  const esc = () =>
    under(
      () => openSettings(page, cdp),
      () => closeSettings(page, cdp),
    );
  const map = () =>
    under(
      async () => {
        await pressM(cdp);
        await page.waitForFunction(MAP_OPEN, { timeout: 3000 }).catch(() => {});
      },
      async () => {
        await pressM(cdp);
        await page
          .waitForFunction(MAP_CLOSED, { timeout: 3000 })
          .catch(() => {});
      },
    );
  const tracksPlaying = (s, slot) =>
    sorted(playing(s, slot).map((e) => e.track));

  // Music, then ambience: the Esc screen pauses them, the map does not.
  await spaceToItem(page, cdp, "music-carry");
  await waitSound(page, (s) => bedMatches(s, expectedTarget("music-carry")));
  const musicEsc = await esc();
  const musicMap = await map();
  await spaceToItem(page, cdp, "amb-carry");
  await waitSound(page, (s) => bedMatches(s, expectedTarget("amb-carry")));
  const ambEsc = await esc();
  const ambMap = await map();
  // A one-shot (the 6 s siren) and a voice line (8.4 s), each heard for a
  // moment first.
  const heard = (s, slot, track) =>
    playing(s, slot).some((e) => e.track === track && e.t > 0.3);
  await spaceToItem(page, cdp, "sfx-overlap");
  await waitSound(page, (s) => heard(s, "sfx", "siren"), 3000);
  const sfxEsc = await esc();
  await spaceToItem(page, cdp, "voice-long");
  await waitSound(page, (s) => heard(s, "voice", "mei-long"), 3000);
  const voiceEsc = await esc();
  const voiceMap = await map();

  // Paused where it had got to, and played on from there.
  const pausedThenResumed = ({ before, a, b, c }, slot, track) =>
    playing(a).length === 0 &&
    frozen(a, b) &&
    a.els.some((e) => e.slot === slot && e.track === track) &&
    tracksPlaying(c, slot).includes(track) &&
    movedOn(before, a, { playing: false, slot, track }) &&
    movedOn(b, c, { playing: true, slot, track });
  const escCases = {
    music: pausedThenResumed(musicEsc, "music", "calm"),
    rain: pausedThenResumed(ambEsc, "ambience", "rain"),
    hum: pausedThenResumed(ambEsc, "ambience", "hum"),
    siren: pausedThenResumed(sfxEsc, "sfx", "siren"),
    voice: pausedThenResumed(voiceEsc, "voice", "mei-long"),
  };
  check(
    "the Esc screen pauses every sound (music, ambience, a one-shot, a voice) where it had got to, and closing it resumes them from there",
    Object.values(escCases).every(Boolean),
    {
      escCases,
      music: [evidence(musicEsc.a), evidence(musicEsc.b), evidence(musicEsc.c)],
      sfx: [evidence(sfxEsc.a), evidence(sfxEsc.b), evidence(sfxEsc.c)],
      voice: [evidence(voiceEsc.a), evidence(voiceEsc.c)],
    },
  );
  const playsOn = ({ a, b }, slot, track) => {
    const x = playing(a, slot).find((e) => e.track === track);
    const y = playing(b, slot).find((e) => e.track === track);
    return x !== undefined && y !== undefined && y.t > x.t;
  };
  check(
    "music and ambience play on under the branch map",
    playsOn(musicMap, "music", "calm") &&
      playsOn(ambMap, "ambience", "rain") &&
      playsOn(ambMap, "ambience", "hum"),
    { music: evidence(musicMap.b), ambience: evidence(ambMap.b) },
  );
  const voiceOf = (s) => s.els.find((e) => e.slot === "voice");
  check(
    "the voice pauses under the branch map where it had got to and resumes from there when it closes",
    voiceOf(voiceMap.a)?.track === "mei-long" &&
      voiceOf(voiceMap.a).paused &&
      voiceOf(voiceMap.b)?.paused === true &&
      Math.abs(voiceOf(voiceMap.b).t - voiceOf(voiceMap.a).t) <
        CLOCK_SETTLE_S &&
      tracksPlaying(voiceMap.c, "voice").includes("mei-long") &&
      movedOn(voiceMap.before, voiceMap.a, { playing: false, slot: "voice" }) &&
      movedOn(voiceMap.b, voiceMap.c, { playing: true, slot: "voice" }),
    { under: evidence(voiceMap.a), after: evidence(voiceMap.c) },
  );
}

/** The audio demo's progress file: the place, voice-theo, and `settings`. */
function progressFile(settings) {
  const { items, storyId, title: gameTitle } = audioDemo();
  const upTo = indexOf("voice-theo");
  const file = join(scenarioRoot, `audio-progress-${engine}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      kind: "kinetic-progress",
      version: 1,
      storyId,
      title: gameTitle,
      exportedAt: new Date().toISOString(),
      state: {
        ctx: {
          lastShown: "voice-theo",
          visited: items.slice(0, upTo + 1).map((it) => it.id),
        },
        settings,
        helpSeen: true,
      },
      bookmarks: [],
    }),
  );
  return file;
}

async function voiceHold({ check, open, folders }) {
  if (!built(check, folders)) return;
  const { items } = audioDemo();
  const { page, cdp } = await openDemo(open, "voice-hold");
  const longMs = tracks()["mei-long"].durationSeconds * 1000;
  const textMs = Math.max(
    1500,
    [...items[indexOf("voice-long")].text].length * 60,
  );
  /** Auto-forward from voice-theo: how long voice-long held. */
  const holdOfLongLine = async () => {
    await pressA(cdp); // auto-forward on, at voice-theo
    await page
      .waitForFunction(ON_ITEM, { timeout: 8000 }, "voice-long")
      .catch(() => {});
    const from = Date.now();
    const s = await readSound(page);
    await page
      .waitForFunction(ON_ITEM, { timeout: 15000 }, "voice-after")
      .catch(() => {});
    const ms = Date.now() - from;
    await pressA(cdp); // auto-forward off
    return { ms, s };
  };

  await spaceToItem(page, cdp, "voice-theo");
  const audible = await holdOfLongLine();
  check(
    `auto-forward waits for the ${longMs} ms voice line while it is audible, past its ${textMs} ms text hold`,
    audible.s.unlocked &&
      audible.ms >= longMs - 250 &&
      audible.ms <= longMs + 1500,
    { ms: audible.ms, ...evidence(audible.s) },
  );

  // Voice at 0, carried in by an imported progress file: the line is not
  // heard, so its text alone paces it.
  const file = progressFile({ voiceVolume: 0 });
  await openSettings(page, cdp);
  const [chooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 5000 }),
    clickCenter(cdp, CONFIG_CONTROL.importProgress),
  ]);
  await chooser.accept([file]);
  await page.waitForFunction(CONFIRM_OPEN, { timeout: 5000 }).catch(() => {});
  await Promise.all([
    page
      .waitForNavigation({ waitUntil: "load", timeout: 8000 })
      .catch(() => {}),
    clickCenter(cdp, CONFIRM_CONTROL.confirm),
  ]);
  await page
    .waitForFunction(ON_ITEM, { timeout: 5000 }, "voice-theo")
    .catch(() => {});
  await sleep(500);
  const silent = await holdOfLongLine();
  check(
    `with Voice at 0 the line holds only for its ${textMs} ms text`,
    silent.ms >= textMs - 250 &&
      silent.ms <= textMs + 1500 &&
      silent.ms < longMs - 1000,
    { ms: silent.ms, ...evidence(silent.s) },
  );
}

async function library({ check, folders }) {
  // A game without audio: no element, no hook, and current() says so.
  const quiet = await openGame(demoDir, { engine, log: null });
  await quiet.press("Space", { times: 3 });
  await sleep(600);
  const quietNow = await quiet.current();
  const quietPage = await quiet.page.evaluate(READ_SOUND);
  const quietErrors = quiet.errors();
  await quiet.close();
  check(
    "fixtures/demo, a game without audio, makes no <audio> element, no #audio and no hint, and current().audio is null",
    quietPage.audioCount === 0 &&
      !quietPage.hook &&
      !quietPage.hint &&
      quietNow.audio === null &&
      quietErrors.length === 0,
    { quietPage, audio: quietNow.audio, errors: quietErrors },
  );

  if (!built(check, folders)) return;
  const game = await openGame(audioDemoDir, { engine, log: null });
  await game.spaceUntil("music-start");
  await sleep(1500);
  const now = await game.current();
  const errors = game.errors();
  await game.close();
  const music = now.audio?.elements.find((e) => e.slot === "music");
  check(
    "openGame's current() reports the sound: the target, unlocked, and the music playing",
    now.id === "music-start" &&
      same(now.audio?.target, expectedTarget("music-start")) &&
      now.audio?.unlocked === true &&
      music?.track === "calm" &&
      music.paused === false &&
      music.currentTime > 0 &&
      music.volume > 0.9 &&
      errors.length === 0,
    { audio: now.audio, errors },
  );
}

// ---- The sound controls (docs/plan.md Phase 47 item 7) ----------------

/** `v`: sound on or off. */
const pressV = (cdp) => pressKey(cdp, "v", "KeyV", 86, "v");
const VOLUMES_OPEN = () => {
  const sheet = document.getElementById("volumes");
  return sheet !== null && !sheet.hidden;
};
/** Opens the Esc screen and its Volumes sheet; true once the sheet is up. */
async function openVolumes(page, cdp) {
  await openSettings(page, cdp);
  await clickCenter(cdp, '[data-config-action="volumes"]');
  return page
    .waitForFunction(VOLUMES_OPEN, { timeout: 2000 })
    .then(() => true)
    .catch(() => false);
}
/** A volume row's readout ("90%") in the open sheet. */
const READ_VOLUME = (name) =>
  document.querySelector(`[data-volume="${name}"] .config-value`)
    ?.textContent ?? null;
const percent = (text) => Number.parseInt(text ?? "", 10) / 100;

// The settings in the player's saved state record (src/storage/idb.ts),
// under the story's storage key; null before any write.
const READ_SAVED_SETTINGS = async () => {
  const story = window.KINETIC_MANIFEST?.storyId;
  const key =
    typeof story === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(story)
      ? `story:${story}`
      : new URL(".", document.baseURI).href;
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open("kinetic", 1);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    const record = await new Promise((resolve, reject) => {
      const req = db.transaction("state").objectStore("state").get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return record?.settings ?? null;
  } finally {
    db.close();
  }
};

/** Polls the saved settings until `ok(settings)` (1 s); the last reading. */
async function waitSaved(page, ok) {
  const until = Date.now() + 1000;
  for (;;) {
    const saved = await page.evaluate(READ_SAVED_SETTINGS);
    if ((saved !== null && ok(saved)) || Date.now() > until) return saved;
    await sleep(40);
  }
}

/**
 * Music and ambience play while the Volumes sheet is open and pause again
 * when it closes; a Music change is on the elements' volume at once, and
 * survives a reload.
 */
async function volumesSound({ check, open, folders }) {
  if (!built(check, folders)) return;
  // `pin` sets music and ambience both; Space reads on to `end`, which
  // keeps them, and unlocks sound.
  const { page, cdp } = await openDemo(open, "volumes-sound", {
    hash: "#start=pin",
  });
  await pressSpace(cdp);
  const bed = expectedTarget("end");
  const level = (s, slot) => playing(s, slot).map((e) => e.v);
  const full = await waitSound(page, (s) => bedMatches(s, bed));
  await openSettings(page, cdp);
  await sleep(300);
  const underEsc = await readSound(page);
  const sheetUp = await openVolumes(page, cdp);
  const a = (await waitSound(page, (s) => bedMatches(s, bed))).s;
  await sleep(600);
  const b = await readSound(page);
  const clockMoved = (slot) =>
    playing(b, slot).every((e) => {
      const before = a.els[e.n];
      return before?.track === e.track && e.t > before.t + 0.3;
    });
  check(
    "music and ambience pause under the Esc screen, play while the Volumes sheet is open (their clocks moving), and nothing else does",
    full.ok &&
      playing(underEsc).length === 0 &&
      sheetUp &&
      bedMatches(a, bed) &&
      bedMatches(b, bed) &&
      clockMoved("music") &&
      clockMoved("ambience") &&
      playing(b).every((e) => e.slot === "music" || e.slot === "ambience"),
    { underEsc: evidence(underEsc), a: evidence(a), b: evidence(b) },
  );

  // Music down to 50%: five presses of its - button.
  for (let n = 0; n < 5; n += 1) {
    await clickCenter(cdp, '[data-config-action="volume-music-down"]');
  }
  const music = percent(await page.evaluate(READ_VOLUME, "musicVolume"));
  // Saved at once, with the sheet still open: the stored record has it.
  const saved = await waitSaved(page, (st) => st.musicVolume === 0.5);
  const halved = await waitSound(
    page,
    (s) =>
      level(s, "music").every((v) => Math.abs(v - music) < 0.02) &&
      level(s, "ambience").every(
        (v) => Math.abs(v - music * (tracks().rain.volume ?? 1)) < 0.02,
      ) &&
      level(s, "music").length === 1,
    2000,
  );
  await pressEscape(cdp); // the sheet only
  await sleep(300);
  const closedA = await readSound(page);
  await sleep(600);
  const closedB = await readSound(page);
  const screenUp = await page.evaluate(
    () => !document.getElementById("help").hidden,
  );
  check(
    "five presses of Music's - read 50%, are saved at once, and set the music and ambience volume to half their level at once; Escape closes the sheet and they pause again under the Esc screen",
    music === 0.5 &&
      saved?.musicVolume === 0.5 &&
      halved.ok &&
      screenUp &&
      playing(closedA).length === 0 &&
      frozen(closedA, closedB),
    {
      music,
      saved: saved?.musicVolume,
      halved: evidence(halved.s),
      closed: [evidence(closedA), evidence(closedB)],
    },
  );

  // A reload: a key that counts unlocks sound (h, twice, moves nothing),
  // and the music comes back at the saved level.
  await page.reload();
  await page.waitForFunction(ON_ITEM, { timeout: 5000 }, "end").catch(() => {});
  await pressH(cdp);
  await pressH(cdp);
  const back = await waitSound(
    page,
    (s) =>
      s.unlocked &&
      level(s, "music").length === 1 &&
      level(s, "music").every((v) => Math.abs(v - 0.5) < 0.02),
    5000,
  );
  await openVolumes(page, cdp);
  const shown = await page.evaluate(READ_VOLUME, "musicVolume");
  check(
    "after a reload the music plays at the saved 50%, and the sheet's Music row reads 50%",
    back.ok && shown === "50%",
    { back: evidence(back.s), shown },
  );
}

/**
 * Polls the page from just before `act` until 3 s after it, and reports
 * the sample sound as it went: whether it played `track` at `volume`,
 * how long after the act it stopped, and how far into the track it got.
 */
async function sampleAfter(page, act, track, volume) {
  const startedAt = await page.evaluate(() => performance.now());
  await act();
  const readings = [];
  for (const until = Date.now() + 3000; Date.now() < until; ) {
    const s = await readSound(page);
    const el = s.els.find((e) => e.slot === "sample");
    readings.push({ at: s.now - startedAt, el, s });
    await sleep(40);
  }
  const heard = readings.filter(
    (r) => r.el !== undefined && r.el.track === track && !r.el.paused,
  );
  const start = tracks()[track].startSeconds ?? 0;
  const lastHeard = heard.at(-1)?.at ?? Number.POSITIVE_INFINITY;
  const stoppedAt = readings.find(
    (r) => r.at > lastHeard && (r.el?.track !== track || r.el.paused),
  )?.at;
  return {
    heard: heard.length > 0,
    level:
      heard.length > 0 && heard.every((r) => Math.abs(r.el.v - volume) < 0.02),
    stoppedAt: stoppedAt ?? null,
    furthest: Math.max(0, ...heard.map((r) => r.el.t - start)),
    // Nothing else sounds meanwhile (one-shots and voice stay held).
    alone: readings.every((r) =>
      playing(r.s).every(
        (e) =>
          e.slot === "sample" || e.slot === "music" || e.slot === "ambience",
      ),
    ),
    voice: readings.map((r) => r.s.els.find((e) => e.slot === "voice")),
  };
}
const sampleOk = (r, maxMs = 2000) =>
  r.heard &&
  r.level &&
  r.alone &&
  r.stoppedAt !== null &&
  r.stoppedAt <= maxMs + 300 &&
  r.furthest <= maxMs / 1000 + 0.05;

/**
 * An Effects or Voice change plays a sample of at most 2 s at the new
 * level: the last one-shot fired, else the game's first one-shot; the
 * current item's voice, else the game's first voice line.
 */
async function volumeSamples({ check, open, folders }) {
  if (!built(check, folders)) return;
  const { page, cdp } = await openDemo(open, "volume-samples");
  const firstSfx = audioDemo().items.find((it) => it.audio?.sfx)?.audio.sfx[0]
    .track;
  const down = (name) => () =>
    clickCenter(cdp, `[data-config-action="volume-${name}-down"]`);

  // No one-shot has fired yet: the game's first one-shot track.
  await pressSpace(cdp); // unlocks sound
  await openVolumes(page, cdp);
  const first = await sampleAfter(page, down("effects"), firstSfx, 0.9);
  await pressEscape(cdp);
  await pressEscape(cdp);
  check(
    `with no one-shot fired yet, an Effects change plays the game's first one-shot (${firstSfx}) at the new 90%, and it stops by itself`,
    sampleOk(first),
    { ...first, voice: undefined },
  );

  // sfx-overlap fires the siren, then the bell 2 s later: the bell (3 s)
  // is the last one-shot fired, and its sample stops at 2 s.
  await spaceToItem(page, cdp, "sfx-overlap");
  await sleep(2600);
  await openVolumes(page, cdp);
  const bell = tracks().bell.volume ?? 1;
  const last = await sampleAfter(page, down("effects"), "bell", 0.8 * bell);
  await pressEscape(cdp);
  await pressEscape(cdp);
  check(
    "an Effects change plays the last one-shot fired (the 3 s bell) at the new 80% for at most 2 s, the item's own one-shots staying held",
    sampleOk(last) && last.furthest > 1.2,
    { ...last, voice: undefined },
  );

  // The current item's voice (8.4 s), held under the Esc screen, samples
  // from its start for at most 2 s; the held line keeps its place.
  await spaceToItem(page, cdp, "voice-long");
  await waitSound(
    page,
    (s) => playing(s, "voice").some((e) => e.track === "mei-long" && e.t > 0.3),
    3000,
  );
  await openVolumes(page, cdp);
  await sleep(200);
  const voice = await sampleAfter(
    page,
    down("voice"),
    "mei-long",
    0.9 * (tracks()["mei-long"].volume ?? 1),
  );
  const held = voice.voice.filter((e) => e?.track === "mei-long");
  check(
    "a Voice change plays the current item's voice line (8.4 s) at the new 90% for at most 2 s, while the line itself stays paused where it was",
    sampleOk(voice) &&
      voice.furthest > 1.2 &&
      held.length === voice.voice.length &&
      held.every((e) => e.paused && Math.abs(e.t - held[0].t) < 0.25),
    { ...voice, voice: [held[0], held.at(-1)] },
  );
}

/**
 * `v`: its pill, everything silent while off, and turning it on applies
 * the screen's sound with no one-shot and no voice restart; the setting is
 * the Esc screen's switch and survives a reload.
 */
async function soundKey({ check, open, folders }) {
  if (!built(check, folders)) return;
  const { page, cdp } = await openDemo(open, "sound-key");
  const toggled = async () => {
    await page.evaluate(INSTALL_PILL_LOG);
    await pressV(cdp);
    await sleep(300);
    return readPills(page);
  };

  // Ambience: off silences it, on brings the same loops back.
  await spaceToItem(page, cdp, "amb-carry");
  const bed = expectedTarget("amb-carry");
  await waitSound(page, (s) => bedMatches(s, bed));
  const offPill = await toggled();
  const off = await readSound(page);
  const savedOff = await waitSaved(page, (st) => st.soundOn === false);
  const onPill = await toggled();
  const on = await waitSound(page, (s) => bedMatches(s, bed), 3000);
  check(
    'v shows "Sound off", saves it at once and silences every sound, then "Sound on" and the screen\'s ambience plays again',
    JSON.stringify(offPill) === JSON.stringify(["Sound off"]) &&
      savedOff?.soundOn === false &&
      playing(off).length === 0 &&
      JSON.stringify(onPill) === JSON.stringify(["Sound on"]) &&
      on.ok,
    {
      offPill,
      onPill,
      savedOff: savedOff?.soundOn,
      off: evidence(off),
      on: evidence(on.s),
    },
  );

  // One-shots: off then on at sfx-overlap fires none (nor the pending bell).
  await spaceToItem(page, cdp, "sfx-overlap");
  await waitSound(page, (s) => playing(s, "sfx").length > 0, 2000);
  await toggled();
  await toggled();
  await sleep(2500); // past the bell's 2 s delay
  const noShots = await readSound(page);
  // Voice: off then on during the long line does not start it again.
  await spaceToItem(page, cdp, "voice-long");
  await waitSound(
    page,
    (s) => playing(s, "voice").some((e) => e.track === "mei-long"),
    3000,
  );
  await toggled();
  await toggled();
  await sleep(1000);
  const noVoice = await readSound(page);
  check(
    "turning sound on fires no one-shot (the siren gone, the pending bell dropped) and does not restart the voice line",
    playing(noShots, "sfx").length === 0 &&
      playing(noVoice, "voice").length === 0,
    { sfx: evidence(noShots), voice: evidence(noVoice) },
  );

  // Off is the Esc screen's switch, shown there; over the screen v flips
  // it back, with its pill; and Off survives a reload.
  await toggled();
  await openSettings(page, cdp);
  const SWITCH = () =>
    document
      .querySelector('[data-config-action="sound"]')
      ?.getAttribute("aria-pressed") ?? null;
  const shownOff = await page.evaluate(SWITCH);
  const overScreen = await toggled();
  const shownOn = await page.evaluate(SWITCH);
  await clickCenter(cdp, '[data-config-action="sound"]'); // Off again
  const clickedOff = await page.evaluate(SWITCH);
  await closeSettings(page, cdp);
  await page.reload();
  await page
    .waitForFunction(ON_ITEM, { timeout: 5000 }, "voice-long")
    .catch(() => {});
  await pressH(cdp);
  await pressH(cdp);
  await sleep(1200);
  const reloaded = await readSound(page);
  await openSettings(page, cdp);
  const afterReload = await page.evaluate(SWITCH);
  check(
    "the Esc screen's Sound switch shows v's Off; v over the screen turns it On with its pill; a click on it turns it Off, which survives a reload: nothing plays and no hint shows",
    shownOff === "false" &&
      JSON.stringify(overScreen) === JSON.stringify(["Sound on"]) &&
      shownOn === "true" &&
      clickedOff === "false" &&
      afterReload === "false" &&
      playing(reloaded).length === 0 &&
      !reloaded.hint,
    {
      shownOff,
      overScreen,
      shownOn,
      clickedOff,
      afterReload,
      reloaded: evidence(reloaded),
    },
  );
}

// Independent parts (each opens its own browsers); the runner runs them
// side by side and prints their checks in this order.
export const parts = [
  landings,
  trackRules,
  ambienceLoops(),
  musicLoop(),
  partwayLoop(),
  // The stock WebKit driver runs the context at once, as the Mac app does;
  // with the key rule it waits for the key, as Safari does (Chrome always
  // does), and the loops must hold from a context resumed in that key.
  ...(onWebKit
    ? [
        ambienceLoops({ requireGestureForAudio: true }),
        musicLoop({ requireGestureForAudio: true }),
        partwayLoop({ requireGestureForAudio: true }),
      ]
    : []),
  oneShots,
  joinMusic,
  unlock,
  soundsAfterUnlock,
  autoplay,
  hiddenPage,
  menus,
  voiceHold,
  library,
  volumesSound,
  volumeSamples,
  soundKey,
];
