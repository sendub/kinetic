// The sound's rules (docs/plan.md Phase 47, items 5 and 18), apart from the
// engine that plays it (render/audio.ts): the volume product and the gain
// nodes it is split into, fades on a gain, the one-shot pool, how a track
// plays and loops and where a play stands, the video sound's cues, and the
// director, which turns the machine's arrivals into what should sound and
// when. DOM-free: time enters through the global timers, which tests fake,
// and the context times callers pass.
//
// By arrival kind (`Machine.arrival`):
// - `read`: the target applies at once with the item's `fadeMs`, its voice
//   starts and its one-shots fire after their `delayMs`; a one-shot still
//   waiting when the cursor leaves the item is dropped.
// - `walk` and `jump`: once the cursor has rested `REST_MS`, the target
//   applies with a `REST_FADE_MS` fade and the voice starts; no one-shots
//   fire, and those playing fade out.
// - `skip`: nothing changes while skip runs (a pick play-all makes inside a
//   burst included); when it stops, the item it stopped on applies as
//   after a rest.
// Leaving an item stops its voice, whatever the arrival.

import type { Machine } from "../machine/machine";
import type {
  AudioTrack,
  Item,
  MachineSettings,
  SfxCue,
  TargetSound,
} from "../machine/types";

/** How long the cursor rests after a walk or jump before its sound applies. */
export const REST_MS = 250;
/** The fade a rested arrival, or the item a skip stopped on, applies with. */
export const REST_FADE_MS = 250;
/** An item's music and ambience fade when it sets no `fadeMs`. */
export const DEFAULT_FADE_MS = 1000;
/** One-shots that can sound at once; a seventh steals the oldest. */
export const SFX_POOL_SIZE = 6;
/**
 * How far a video's sound may be from its video's time before it is put
 * back onto it (docs/plan.md Phase 47, items 6 and 15). The converting agent
 * measured a steady 16-43 ms behind, and 200-340 ms off right after a seek
 * in Chrome.
 */
export const VIDEO_SYNC_S = 0.08;
/**
 * How long a paused element is given to land a seek before it is asked to
 * play (`videoCue`): WebKit holds a seek 40-180 ms (macOS 27.2).
 */
export const VIDEO_PARK_S = 0.25;
/**
 * How long a video takes to run again from its restart point once it
 * reaches its end (a wrap), until learnt: 33-41 ms in headless Chrome and
 * the WebKit driver alike (macOS 27.2, 2026-11-10, with no sound playing).
 */
export const VIDEO_RESTART_S = 0.04;
/**
 * How long a video takes to run once asked to play from paused (a start),
 * until learnt: 0 ms in headless Chrome and 6-12 ms in the WebKit driver
 * after a menu, sought to where it stands (macOS 27.2, 2026-11-11).
 */
export const VIDEO_START_S = 0.01;
/**
 * The duck's fade: music and ambience going down as a video's sound
 * starts, and back up.
 */
export const DUCK_FADE_MS = 250;

/**
 * How long the Volumes sheet's sample of an Effects or Voice change plays
 * at most (docs/plan.md Phase 47 item 7).
 */
export const SAMPLE_MS = 2000;

/**
 * What an audio element plays (the test hook's `data-slot`): `sample` is
 * the Volumes sheet's sample of a one-shot or a voice line.
 */
export type AudioSlot =
  | "music"
  | "ambience"
  | "sfx"
  | "voice"
  | "video"
  | "sample";

/**
 * The reader's volume for a slot's group: Music for music and ambience,
 * Effects for one-shots and video sound, Voice for voice. A sample takes
 * the group of what it samples.
 */
export function groupVolume(
  slot: Exclude<AudioSlot, "sample">,
  settings: MachineSettings,
): number {
  switch (slot) {
    case "music":
    case "ambience":
      return settings.musicVolume;
    case "sfx":
    case "video":
      return settings.effectsVolume;
    case "voice":
      return settings.voiceVolume;
  }
}

/** What, beside the slot, decides whether an element may sound now. */
export interface SoundGate {
  readonly soundOn: boolean;
  /** The page is hidden. */
  readonly hidden: boolean;
  /** The Esc screen (or the reset box over it) is up. */
  readonly esc: boolean;
  /** The branch map is up. */
  readonly map: boolean;
  /** The Esc screen's Volumes pop-out (item 7) is open. */
  readonly volumesOpen: boolean;
}

/**
 * Whether an element of `slot` may sound (docs/plan.md Phase 47, items 5
 * and 7): nothing with sound off or the page hidden; under the Esc screen
 * nothing, except music, ambience and a volume's sample while its Volumes
 * pop-out is open; under the branch map everything but the voice; over the
 * story and a choice screen everything. An element held here pauses where
 * it is and plays on once it may again.
 */
export function maySound(slot: AudioSlot, gate: SoundGate): boolean {
  if (!gate.soundOn || gate.hidden) return false;
  if (gate.esc) {
    return (
      gate.volumesOpen &&
      (slot === "music" || slot === "ambience" || slot === "sample")
    );
  }
  return !(gate.map && slot === "voice");
}

/**
 * What the Volumes sheet samples for a change of `group` (item 7): for
 * Effects the last one-shot fired (`lastSfx`), else the game's first
 * one-shot track in story order; for Voice the item at `cursor`'s voice
 * line, else the game's first. Only tracks the manifest has; null when
 * there is none.
 */
export function sampleTrack(
  group: "effects" | "voice",
  game: {
    items: readonly Item[];
    tracks: Readonly<Record<string, AudioTrack>>;
    cursor: number;
    lastSfx: string | null;
  },
): string | null {
  const known = (id: string | null | undefined): id is string =>
    id != null && game.tracks[id] !== undefined;
  if (group === "effects") {
    if (known(game.lastSfx)) return game.lastSfx;
    for (const item of game.items) {
      const cue = item.audio?.sfx?.find((c) => known(c.track));
      if (cue !== undefined) return cue.track;
    }
    return null;
  }
  const own = game.items[game.cursor]?.audio?.voice;
  if (known(own)) return own;
  for (const item of game.items) {
    if (known(item.audio?.voice)) return item.audio?.voice ?? null;
  }
  return null;
}

const unit = (value: number): number => Math.min(1, Math.max(0, value));

/** What a sound's volume is made of (`elementVolume`, `gainStages`). */
export interface VolumeParts {
  /** The track's own `volume` (default 1). */
  readonly track: number | undefined;
  /** The reader's volume for its group (`groupVolume`). */
  readonly group: number;
  /** The duck on music and ambience (`duckFor`); 1 for the rest. */
  readonly duck: number;
  /** Its fade, 0 to 1 (`fadeLevel`). */
  readonly fade: number;
}

/**
 * A sound's volume: the track's `volume` (default 1) x its group's x the
 * duck x the fade, each held to [0, 1] so a stored setting outside it (an
 * imported file can hold any number) never makes `element.volume` throw.
 * The test hook reports it for every sound.
 */
export function elementVolume(parts: VolumeParts): number {
  const stages = gainStages(parts);
  return stages.sound * stages.group * stages.duck;
}

/**
 * `elementVolume` split over the gain nodes a sound passes through: its own
 * (the track's volume x its fade, so a fade is one ramp on it), its group's
 * (the reader's volume) and, for music and ambience, the duck's.
 */
export function gainStages(parts: VolumeParts): {
  sound: number;
  group: number;
  duck: number;
} {
  return {
    sound: unit(parts.track ?? 1) * unit(parts.fade),
    group: unit(parts.group),
    duck: unit(parts.duck),
  };
}

/**
 * A gain moving in a straight line from `from` to `to` over `seconds`,
 * begun at context time `at`; `at` is NaN while it is held where it is
 * (`holdFade`), `seconds` then being what is left of it.
 */
export interface Fade {
  readonly from: number;
  readonly to: number;
  readonly at: number;
  readonly seconds: number;
}

/** A gain that stays at `level`. */
export function still(level: number): Fade {
  return { from: level, to: level, at: Number.NaN, seconds: 0 };
}

/** `fade`'s level at context time `now`. */
export function fadeLevel(fade: Fade, now: number): number {
  if (Number.isNaN(fade.at)) return fade.from;
  const progress = fade.seconds <= 0 ? 1 : unit((now - fade.at) / fade.seconds);
  return fade.from + (fade.to - fade.from) * progress;
}

/**
 * `fade` held at context time `now`, where it is, keeping what is left of
 * it for `runFade`: a fade waits while its sound is held (a menu, a hidden
 * page) or has not started (still decoding, or sound still locked).
 */
export function holdFade(fade: Fade, now: number): Fade {
  if (Number.isNaN(fade.at)) return fade;
  return {
    from: fadeLevel(fade, now),
    to: fade.to,
    at: Number.NaN,
    seconds: Math.max(0, fade.at + fade.seconds - now),
  };
}

/** A held `fade` running on from context time `now`. */
export function runFade(fade: Fade, now: number): Fade {
  return Number.isNaN(fade.at) ? { ...fade, at: now } : fade;
}

/**
 * Where and when a video's sound next begins on its waiting element
 * (`videoCue`): the playing element is never sought.
 */
export interface VideoCue {
  /** The track time it plays from: the video's time at `at`. */
  readonly from: number;
  /** When it should begin to sound (page ms). */
  readonly at: number;
  /** The video wraps, the sound is silent, or it is too far off. */
  readonly kind: "wrap" | "start" | "correct";
}

/**
 * The next cue of a video's sound at page time `at` (docs/plan.md Phase 47,
 * item 15); the track's time is the video's media time. The playing element
 * is never sought, as every seek of a playing element goes silent or plays
 * out of step while it lands (0.1-0.6 s) and skips what lay between: a
 * second element, waiting paused at the cue's `from`, is played its `lead`
 * before `at` (`seamStep` times it), so it sounds as the video reaches
 * `from`, and takes over then. The cue is:
 * - the one under way once its element was asked to play (`started`);
 * - none while the video does not run;
 * - while the sound is silent, a start where the video will be once a
 *   waiting element can land a seek (`VIDEO_PARK_S`, from `parkFrom`, page
 *   ms, when it may be sought) and sound (`lead`);
 * - while it sounds more than `VIDEO_SYNC_S` off the video, judged once its
 *   clock has `settled`, a correction there;
 * - else, while the pass under way wraps, the wrap: the video's restart
 *   point as the video runs from it again, `restart` seconds after it
 *   reaches its end. A start or a correction gives way to it when the
 *   waiting element would not be free again in time for it.
 */
export function videoCue(now: {
  at: number;
  video: {
    time: number;
    runs: boolean;
    /** Where the pass under way ends. */
    end: number;
    /** Where it restarts after `end`; null when it ends there. */
    restartAt: number | null;
  };
  /** The playing element's time while it sounds, else null. */
  sound: { time: number; settled: boolean } | null;
  cue: VideoCue | null;
  started: boolean;
  lead: number;
  restart: number;
  /** When (page ms) the waiting element may be sought; default now. */
  parkFrom?: number;
  /** A video waits to start with this cue's sound (`videoStartDelay`). */
  starting?: boolean;
}): VideoCue | null {
  const { at, video, sound, cue, lead } = now;
  if (cue !== null && now.started) return cue;
  // A wrap waits through the video's own restart, and holds once the video
  // runs on from its restart point before its moment (a range end inside
  // the file wraps with a seek of the playing video).
  if (!video.runs) {
    const waits =
      cue?.kind === "wrap" || (now.starting && cue?.kind === "start");
    return waits ? cue : null;
  }
  if (
    cue?.kind === "wrap" &&
    Math.abs(video.time - cue.from - (at - cue.at) / 1000) < VIDEO_PARK_S
  ) {
    return cue;
  }
  const wrap: VideoCue | null =
    video.restartAt === null
      ? null
      : {
          from: video.restartAt,
          at: at + (video.end - video.time + now.restart) * 1000,
          kind: "wrap",
        };
  const fits = (next: VideoCue): boolean =>
    wrap === null || next.at + VIDEO_PARK_S * 1000 <= wrap.at - lead * 1000;
  const parkFrom = Math.max(at, now.parkFrom ?? at);
  const soon = (kind: "start" | "correct"): VideoCue => {
    const after = (parkFrom - at) / 1000 + VIDEO_PARK_S + lead;
    return { from: video.time + after, at: at + after * 1000, kind };
  };
  // A cue whose element cannot have landed its park before it must start
  // is made again: a start just after a seek lands late.
  const ready = (next: VideoCue): boolean =>
    now.parkFrom === undefined ||
    next.at - lead * 1000 >= now.parkFrom + VIDEO_PARK_S * 1000 - 1;
  if (sound === null) {
    const start = cue?.kind === "start" && ready(cue) ? cue : soon("start");
    return fits(start) ? start : wrap;
  }
  if (cue?.kind === "correct" && ready(cue) && fits(cue)) return cue;
  if (sound.settled && Math.abs(sound.time - video.time) > VIDEO_SYNC_S) {
    const correct = soon("correct");
    if (fits(correct)) return correct;
  }
  return wrap;
}

/**
 * The duck on music and ambience (item 6): the video sound's `duck` while
 * its video plays and the sound can be heard (Effects above 0), else 1.
 */
export function duckFor(
  videoSound: TargetSound["videoSound"],
  plays: boolean,
  effectsVolume: number,
): number {
  return videoSound !== null && plays && effectsVolume > 0
    ? unit(videoSound.duck)
    : 1;
}

/** Where a play of a track starts, loops and ends, in seconds. */
export interface PlayPlan {
  /**
   * Restarts at `loopStartSeconds` when it reaches `endSeconds` (an
   * AudioBufferSourceNode's own loop, sample-exact).
   */
  loops: boolean;
  startSeconds: number;
  loopStartSeconds: number;
  /**
   * The track's `durationSeconds`, or its decoded buffer's length when that
   * is shorter: an element's own duration is never read.
   */
  endSeconds: number;
}

/**
 * How `track` plays: `looping` for music and ambience, which loop unless
 * the track says `loop: false`; one-shots and voice play once. With its
 * decoded `buffer`, the end is the buffer's when that comes first, and the
 * three times sit on whole samples of it: `durationSeconds` is a sample
 * count written to 6 decimals, and a loop whose ends fall between samples
 * would move by a fraction of one at every wrap. A loop too short for its
 * restart point loops the whole of it.
 */
export function playPlan(
  track: AudioTrack,
  looping: boolean,
  buffer?: { duration: number; sampleRate: number },
): PlayPlan {
  const snap =
    buffer === undefined
      ? (t: number) => t
      : (t: number) => Math.round(t * buffer.sampleRate) / buffer.sampleRate;
  const loops = looping && track.loop !== false;
  const endSeconds = snap(
    Math.min(
      track.durationSeconds,
      buffer?.duration ?? Number.POSITIVE_INFINITY,
    ),
  );
  let startSeconds = snap(track.startSeconds ?? 0);
  let loopStartSeconds = snap(
    track.loopStartSeconds ?? track.startSeconds ?? 0,
  );
  if (loops && loopStartSeconds >= endSeconds) loopStartSeconds = 0;
  if (loops && startSeconds >= endSeconds) startSeconds = loopStartSeconds;
  return { loops, startSeconds, loopStartSeconds, endSeconds };
}

/**
 * Where a play of `plan` stands `elapsed` seconds after it played from
 * track time `from`: a loop wraps from its end to its restart point; a
 * play that does not loop stops at its end. A sound paused there resumes
 * from this place, so a pause splits its timeline without moving it.
 */
export function playPosition(
  plan: PlayPlan,
  from: number,
  elapsed: number,
): number {
  const at = from + Math.max(0, elapsed);
  if (at < plan.endSeconds) return at;
  if (!plan.loops) return plan.endSeconds;
  const span = plan.endSeconds - plan.loopStartSeconds;
  if (span <= 0) return plan.loopStartSeconds;
  return plan.loopStartSeconds + ((at - plan.endSeconds) % span);
}

/**
 * How long before a cue a video sound's waiting element is asked to play
 * while nothing is learnt of its file or any other: the slowest start
 * measured, WebKit playing a PCM WAV from paused (335-354 ms; Opus in WebM
 * 266-280 ms, headless Chrome about 60 ms; macOS 27.2, 2026-11-10).
 */
export const SEAM_LEAD_S = 0.35;
/** The most a lead may grow to. */
export const SEAM_LEAD_MAX_S = 0.75;
/**
 * How long after a waiting element's play() its clock is trusted to say
 * when its sound began: WebKit's clock for a WAV runs from about 85 ms,
 * stops near 0.37 s for about 270 ms while the sound catches up, then runs
 * true (measured as for `SEAM_LEAD_S`).
 */
export const SEAM_LAND_MS = 900;

/** What a video sound's cue needs now (`seamStep`). */
export interface SeamStep {
  readonly step: "wait" | "start" | "switch";
  /** In how many seconds it is due (0: now); a timer, finer than frames, keeps it. */
  readonly inS: number;
}

/**
 * One look at a video sound's cue (docs/plan.md Phase 47, items 6 and 15),
 * made on each animation frame. An element sought while it plays goes
 * silent or out of step while it lands (0.1-0.6 s), so a second element,
 * waiting paused where the cue begins, is asked to play `lead` seconds
 * before the cue's moment (`start`) and takes over at it (`switch`), when
 * `remaining` (the time to the moment) reaches 0 or the playing element
 * ended before it. Each is asked for on the last look before its moment
 * (within a `frame`, seconds, of it), timed to that moment by `inS`: a
 * start on the nearest frame could still be half a frame off, and an
 * engine starts a sound only on the next block of its output (every start
 * measured lay within 1 ms of a grid of 10.7 ms in headless Chrome and
 * 85.3 ms in the muted WebKit driver), so the error is at least the
 * distance to the nearest block. `spare` is what the second element is
 * doing.
 */
export function seamStep(now: {
  remaining: number;
  lead: number;
  spare: "idle" | "started";
  ended: boolean;
  frame: number;
}): SeamStep {
  const due = (step: SeamStep["step"], inS: number): SeamStep => ({
    step,
    inS: Math.max(0, inS),
  });
  if (now.ended) return due("switch", 0);
  if (now.remaining < now.frame) return due("switch", now.remaining);
  if (now.spare === "started") return due("wait", 0);
  const toStart = now.remaining - now.lead;
  if (toStart < now.frame) return due("start", toStart);
  return due("wait", 0);
}

/**
 * The lead after one start of a second element, from its own clock: it was
 * asked to play at page time `played` (ms) and, read at `at`, had played
 * `media` seconds from where it waited, so its sound began at
 * `at - media`. Null (nothing learnt) while the clock may not have settled,
 * before `SEAM_LAND_MS`. A file's first start is taken whole and later
 * ones move the lead halfway, as starts scatter by about 10 ms; it stays
 * within 0 and `SEAM_LEAD_MAX_S`.
 */
export function learnSeamLead(
  lead: number | null,
  measure: { played: number; at: number; media: number },
): number | null {
  if (measure.at - measure.played < SEAM_LAND_MS) return lead;
  const took = (measure.at - measure.media * 1000 - measure.played) / 1000;
  const next = lead === null ? took : lead + (took - lead) / 2;
  return Math.min(SEAM_LEAD_MAX_S, Math.max(0, next));
}

/** How many of the latest starts a video sound's lead is learnt from. */
export const VIDEO_LEAD_SAMPLES = 8;

/**
 * Output blocks an engine may begin a sound on (ms): 2048-4096 frames at
 * 48 or 44.1 kHz, largest first. The muted WebKit driver begins every
 * sound on a grid of 4096 frames at 48 kHz, 85.3 ms (macOS 27.2: 18 starts
 * in a row lay within 1 ms of one phase). Finer blocks (headless Chrome's
 * 10.7 ms) scatter starts too little to matter, and three random times fit
 * them too often to tell.
 */
const START_GRIDS_MS = [4096, 2048].flatMap((frames) => [
  frames / 48,
  frames / 44.1,
]);
/** How closely begin times share one phase of a grid to lie on it (ms). */
const GRID_FIT_MS = 3;

/**
 * The largest output grid (`START_GRIDS_MS`) that the sounds which began
 * at page times `begins` all lie on, within `GRID_FIT_MS` of one phase;
 * null for fewer than 3 or none.
 */
export function startGrid(begins: readonly number[]): number | null {
  if (begins.length < 3) return null;
  for (const grid of START_GRIDS_MS) {
    const phase = (t: number) => ((t % grid) + grid) % grid;
    const first = phase(begins[0]);
    const offs = begins.map((t) => {
      const d = phase(t) - first;
      return d > grid / 2 ? d - grid : d < -grid / 2 ? d + grid : d;
    });
    if (Math.max(...offs) - Math.min(...offs) <= 2 * GRID_FIT_MS) return grid;
  }
  return null;
}

/** A start of a video sound's waiting element: when asked (page ms), and how long it took to sound (s). */
export interface VideoStart {
  readonly played: number;
  readonly took: number;
}

/**
 * A video sound's lead after one more start of its waiting element, as
 * `learnSeamLead` measures it, from up to the last `VIDEO_LEAD_SAMPLES`
 * starts. An engine that begins sounds on an output grid (`startGrid`)
 * takes from its least time up to one block more, as the play falls in the
 * block, so a start lands at best within half a block of the span's
 * middle. The middle lies between the slowest start less half a block and
 * the quickest plus half a block: the lead is the midpoint, the mean of
 * the quickest and the slowest, which a few starts already place near the
 * middle (the median of three can sit near the span's edge, and the
 * quickest plus half a block overshoots when they fell late); a start
 * slower than the quickest by more than a block, one the engine held back,
 * is left out. With no grid it is the median start (the mean of the middle
 * two).
 */
export function learnVideoLead(
  prev: { lead: number; samples: readonly VideoStart[] } | null,
  measure: { played: number; at: number; media: number },
): { lead: number; samples: readonly VideoStart[] } | null {
  const took = learnSeamLead(null, measure);
  if (took === null) return prev;
  const samples = [
    ...(prev?.samples ?? []),
    { played: measure.played, took },
  ].slice(-VIDEO_LEAD_SAMPLES);
  const tooks = samples.map((s) => s.took).sort((x, y) => x - y);
  const grid = startGrid(samples.map((s) => s.played + s.took * 1000));
  if (grid !== null) {
    // One held back past a block (a main-thread stall) is no span sample.
    const span = tooks.filter((t) => t <= tooks[0] + grid / 1000);
    return { lead: (span[0] + span[span.length - 1]) / 2, samples };
  }
  const mid = tooks.length / 2;
  const lead = Number.isInteger(mid)
    ? (tooks[mid - 1] + tooks[mid]) / 2
    : tooks[Math.floor(mid)];
  return { lead, samples };
}

/**
 * When to play a video sound's waiting element so it sounds on the end of
 * the output grid's block nearest `target` (page ms), and no play sooner
 * than `earliest`, from the starts measured (`learnVideoLead`), when they
 * show a grid (`startGrid`). A play sounds at the end of the block it falls
 * in, after the engine's least time, which lies between the slowest start
 * less a block and the quickest (held-back starts aside). Played that block
 * end less the mean of the quickest and the slowest start, it falls in
 * that block for any least time between, with half their spread to spare
 * either side for a timer that fires late or a start held back. Null when
 * the starts show no grid.
 */
export function gridPlay(
  samples: readonly VideoStart[],
  target: number,
  earliest: number,
): { play: number; sounds: number } | null {
  const begins = samples.map((s) => s.played + s.took * 1000);
  const grid = startGrid(begins);
  if (grid === null) return null;
  const tooks = samples.map((s) => s.took * 1000).sort((x, y) => x - y);
  const span = tooks.filter((t) => t <= tooks[0] + grid);
  const mid = (span[0] + span[span.length - 1]) / 2;
  let sounds = begins[0] + Math.round((target - begins[0]) / grid) * grid;
  while (sounds - mid < earliest) sounds += grid;
  return { play: sounds - mid, sounds };
}

/** Which pool element a one-shot takes, and the ones it stops first. */
export interface SfxTake {
  slot: number;
  /** Elements whose one-shot stops: its channel's, or the oldest stolen. */
  stop: number[];
}

export interface SfxPool {
  /** A one-shot on `channel` (or none) starts now. */
  take(channel: string | undefined): SfxTake;
  /** The one-shot on element `slot` ended or was stopped. */
  release(slot: number): void;
}

/**
 * The one-shot pool's bookkeeping over `size` elements. A one-shot on a
 * channel stops the one playing on that channel, as Ren'Py's `play sound`
 * does; one-shots without a channel overlap. Each takes the first free
 * element, and with none free it steals the one that started longest ago.
 */
export function createSfxPool(size: number): SfxPool {
  /** Per element: when its one-shot started (a counter), or -1 when free. */
  const started = new Array<number>(size).fill(-1);
  const channels = new Array<string | undefined>(size).fill(undefined);
  let clock = 0;
  return {
    take(channel) {
      const stop: number[] = [];
      if (channel !== undefined) {
        for (let slot = 0; slot < size; slot += 1) {
          if (started[slot] >= 0 && channels[slot] === channel) {
            stop.push(slot);
            started[slot] = -1;
          }
        }
      }
      let slot = started.indexOf(-1);
      if (slot < 0) {
        slot = 0;
        for (let other = 1; other < size; other += 1) {
          if (started[other] < started[slot]) slot = other;
        }
        stop.push(slot);
      }
      started[slot] = clock;
      clock += 1;
      channels[slot] = channel;
      return { slot, stop };
    },
    release(slot) {
      started[slot] = -1;
      channels[slot] = undefined;
    },
  };
}

/** What the director drives: the elements (render/audio.ts). */
export interface SoundOutput {
  /**
   * Make `target` sound: music and ambience change with a `fadeMs` fade,
   * and with `voice` the target's voice starts, unless it is already this
   * item's (playing or played out).
   */
  apply(target: TargetSound, fadeMs: number, voice: boolean): void;
  /** Start a one-shot now. */
  fire(cue: SfxCue): void;
  /** The cursor left the item: its voice stops. */
  leave(): void;
  /** Fade out the one-shots playing (a walk or a jump left their item). */
  fadeOutEffects(): void;
  /** Sound was turned off: stop everything. */
  silence(): void;
}

export interface SoundDirector {
  /**
   * Sound on or off: off silences everything and applies nothing until it
   * is on again; on applies the screen's sound with no voice and no
   * one-shots.
   */
  setSoundOn(on: boolean): void;
  destroy(): void;
}

/**
 * Follows `machine` and drives `out` by the rules in this file's header.
 * The load is an arrival like any other (a jump: a rest, then its sound).
 */
export function createSoundDirector(options: {
  machine: Machine;
  items: readonly Item[];
  out: SoundOutput;
  soundOn: boolean;
}): SoundDirector {
  const { machine, items, out } = options;
  let soundOn = options.soundOn;
  let lastArrival = 0;
  let lastCursor = -1;
  /** An arrival was let pass while skip ran: apply when it stops. */
  let skipHeld = false;
  let rest: ReturnType<typeof setTimeout> | null = null;
  /** One-shots waiting for their `delayMs`, dropped when the cursor leaves. */
  let pending: ReturnType<typeof setTimeout>[] = [];

  const cancelRest = (): void => {
    if (rest !== null) clearTimeout(rest);
    rest = null;
  };
  const dropPending = (): void => {
    for (const timer of pending) clearTimeout(timer);
    pending = [];
  };
  const applyRested = (voice: boolean): void => {
    out.apply(machine.targetSound(), REST_FADE_MS, voice);
  };

  /** A read arrival; its one-shots fire only on reaching a new item. */
  function read(cursor: number, moved: boolean): void {
    const audio = items[cursor]?.audio;
    out.apply(machine.targetSound(), audio?.fadeMs ?? DEFAULT_FADE_MS, true);
    if (!moved) return;
    for (const cue of audio?.sfx ?? []) {
      const delay = cue.delayMs ?? 0;
      if (delay <= 0) {
        out.fire(cue); // in the same task: inside the key's own handler
        continue;
      }
      const timer = setTimeout(() => {
        pending = pending.filter((other) => other !== timer);
        out.fire(cue);
      }, delay);
      pending.push(timer);
    }
  }

  function onState(): void {
    const state = machine.getState();
    const arrival = machine.arrival();
    if (arrival.number === lastArrival) {
      // No arrival: a burst that stopped where it stood, or a re-emit.
      if (skipHeld && !state.skipping) {
        skipHeld = false;
        if (soundOn) applyRested(true);
      }
      return;
    }
    lastArrival = arrival.number;
    // The load arrives from nowhere: nothing to leave.
    const left = lastCursor >= 0 && state.cursor !== lastCursor;
    const moved = state.cursor !== lastCursor;
    lastCursor = state.cursor;
    cancelRest();
    if (moved) dropPending();
    if (!soundOn) return;
    if (left) out.leave();
    if (state.skipping) {
      skipHeld = true;
      return;
    }
    skipHeld = false;
    if (arrival.kind === "skip") {
      applyRested(true); // the burst's last step: it ended here
      return;
    }
    if (arrival.kind === "read") {
      read(state.cursor, moved);
      return;
    }
    if (left) out.fadeOutEffects();
    rest = setTimeout(() => {
      rest = null;
      applyRested(true);
    }, REST_MS);
  }

  const unsubscribe = machine.subscribe(onState);
  onState(); // the load's arrival

  return {
    setSoundOn(on) {
      if (on === soundOn) return;
      soundOn = on;
      cancelRest();
      dropPending();
      skipHeld = false;
      if (!on) {
        out.silence();
        return;
      }
      if (!machine.getState().skipping) applyRested(false);
      else skipHeld = true;
    },
    destroy() {
      unsubscribe();
      cancelRest();
      dropPending();
    },
  };
}
