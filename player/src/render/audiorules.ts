// The sound's rules (docs/plan.md Phase 47, items 5, 18 and 19), apart from
// the engine that plays it (render/audio.ts): the volume product and the
// gain nodes it is split into, fades on a gain, the one-shot pool, how a
// track plays and loops and where a play stands, how a video follows its
// sound, and the director, which turns the machine's arrivals into what
// should sound and when. DOM-free: time enters through the global timers, which tests fake,
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
 * How far a video may stray from its sound before it is sought back onto
 * it (docs/plan.md Phase 47, items 6 and 19). The converting agent measured
 * a steady 16-43 ms behind, and 200-340 ms off right after a seek in
 * Chrome.
 */
export const VIDEO_SYNC_S = 0.08;
/**
 * How long a seek of a playing video takes to land and run on, until learnt
 * (`learnSeekLead`): the video is sought this long before it must show the
 * place, ahead of each wrap of its sound and onto the sound when it strays.
 * 33-41 ms for a wrap's restart in headless Chrome and the WebKit driver
 * alike (macOS 27.2, 2026-11-10, item 6); item 16's trial learnt 20-53 ms
 * seeking a video ahead of a buffer loop's wrap, the same in both engines
 * (2026-11-11). Under a load average of 15 a restart landed 85 ms late
 * (2026-11-13).
 */
export const VIDEO_SEEK_S = 0.04;
/** The most a seek's lead may grow to. */
export const VIDEO_SEEK_MAX_S = 0.25;
/**
 * How many frames of a restart's run teach its seek's lead, after the
 * seek's own first frame (WebKit shows it at once and runs on later).
 */
export const SEEK_LEARN_FRAMES = 4;
/**
 * The most one restart moves a seek's lead: a run the engine held back
 * once (a load spike) moves it only so far.
 */
export const SEEK_LEARN_STEP_S = 0.03;
/**
 * How many of the latest frames shown the drift is judged on, as their
 * median: one frame shown late is a moment the engine was late (twice in
 * five WebKit runs a frame showed 156 ms off and the next in step, macOS
 * 27.2, 2026-11-13), and chasing it makes the picture jump; frames of a
 * 25 fps video on a 60 Hz screen jitter by a vsync about the drift, so a
 * drift past the bound shows one frame in three under it, and still
 * counts. Three at 25 fps are 120 ms.
 */
export const VIDEO_STRAY_FRAMES = 3;
/**
 * How long after a seek of the video lands its distance from the sound is
 * left unjudged, in an engine that reports no frames (judged on the frames
 * it shows, a frame shown since the seek landed suffices): WebKit shows a
 * seek's frame at once and runs on from it tens of ms later (item 16's
 * trial).
 */
export const VIDEO_SETTLE_MS = 250;
/**
 * How long a video takes to run once asked to play from paused (a start):
 * 0 ms in headless Chrome and 6-12 ms in the WebKit driver after a menu,
 * sought to where it stands (macOS 27.2, 2026-11-11). Its sound, started
 * at the same moment, is heard after the output's latency; the video waits
 * the difference (render/audio.ts `videoStartDelay`).
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
 * What a sound plays (the test hook's `slot`): `sample` is the Volumes
 * sheet's sample of a one-shot or a voice line, `video` a video's own
 * sound.
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
 * How a video's sound plays the pass under way (docs/plan.md Phase 47, item
 * 19): the track's time is the video's media time, and a pass that wraps
 * loops the sound from its restart point to its end, on whole samples of
 * the decoded `buffer` as `playPlan` puts them, so the sound is the clock
 * the video follows. A pass that holds at its end (the last of a counted
 * video, or one that plays once) plays once up to it. The end is the
 * pass's, or the track's when that is shorter (the validator allows 0.05 s).
 */
export function videoSoundPlan(
  track: AudioTrack,
  pass: { end: number; restart: number | null },
  buffer?: { duration: number; sampleRate: number },
): PlayPlan {
  const from = pass.restart ?? 0;
  return playPlan(
    {
      file: track.file,
      durationSeconds: Math.min(track.durationSeconds, pass.end),
      startSeconds: from,
      loopStartSeconds: from,
      loop: pass.restart !== null,
    },
    true,
    buffer,
  );
}

/**
 * How far a video's time `video` is from its sound's `sound` (seconds,
 * positive when the video is ahead), the short way round a loop of `plan`:
 * a video that went back to its restart point just before or after its
 * sound is that far off, not a pass.
 */
export function videoDrift(plan: PlayPlan, video: number, sound: number) {
  const off = video - sound;
  const span = plan.endSeconds - plan.loopStartSeconds;
  if (!plan.loops || span <= 0) return off;
  if (off > span / 2) return off - span;
  if (off < -span / 2) return off + span;
  return off;
}

/**
 * Where a video's sound starts playing (item 19): where it stopped
 * (`stoppedAt`, its `playPosition` then), when its video stands within
 * `VIDEO_SYNC_S` of it as the sound is heard (`videoAt`), so a pause of
 * both resumes in place with neither a gap nor a repeat; else where the
 * video is (a seek or a jump into the video, a sound that never played, the
 * unlock while the video plays). A time past a loop's end is inside the
 * loop.
 */
export function videoSoundStart(
  plan: PlayPlan,
  stoppedAt: number | null,
  videoAt: number,
): number {
  if (
    stoppedAt !== null &&
    Math.abs(videoDrift(plan, videoAt, stoppedAt)) <= VIDEO_SYNC_S
  ) {
    return stoppedAt;
  }
  return playPosition(plan, videoAt, 0);
}

/**
 * Whether a seek of the video to `to` moves its sound there (item 19,
 * "Seeks"): one more than `VIDEO_SYNC_S` from where the sound will be heard
 * as it lands (`soundAt`, the short way round a loop; null for a sound that
 * never played) is a seek or a jump into the video, and the sound follows
 * it; a wrap's or a resume's lands with the sound and leaves it. The
 * player's own seek (`own`, the place it sent the video: a restart, a seek
 * onto the sound, a resume it judged as it started the sound) never moves
 * it: its event can be handled a main-thread stall late, when the sound has
 * played on and the seek only looks far from it, and moving the sound then
 * would play its last moments, a click among them, twice.
 */
export function seekMovesSound(
  plan: PlayPlan,
  to: number,
  soundAt: number | null,
  own: number | null,
): boolean {
  if (own !== null && Math.abs(to - own) < 0.002) return false;
  if (soundAt === null) return true;
  return Math.abs(videoDrift(plan, to, soundAt)) > VIDEO_SYNC_S;
}

/** What one look at a video and its sound asks for (`followVideo`). */
export type VideoStep =
  | { readonly step: "none" }
  /** End the pass under way and play on from its restart point, in `inMs`. */
  | { readonly step: "restart"; readonly inMs: number }
  /** Seek the video to track time `to` now. */
  | { readonly step: "seek"; readonly to: number };

const NO_STEP: VideoStep = { step: "none" };

/**
 * One look at a video against its sound (docs/plan.md Phase 47, item 19),
 * on each animation frame while both play: the sound is the master, its
 * buffer looping the video's range on the audio clock, and the video
 * follows it. `heard` is where the reader hears the sound now (track time,
 * on the output's clock), `video` the video's time, whether it runs and
 * whether a seek of it is still landing; `shown`, when the engine reports
 * its frames, the drift (`videoDrift`) of each frame shown since a seek of
 * it last landed, against where the sound was heard as it showed, oldest
 * first. `lead` is how long a seek takes to land (`learnSeekLead`,
 * `VIDEO_SEEK_S` by default).
 * - A pass that wraps: on the last look before the moment a seek must start
 *   to land as the sound wraps (`lead` before it), a restart timed to that
 *   moment, unless the video is already back in the first half of its
 *   pass.
 * - Otherwise, a video more than `VIDEO_SYNC_S` from its sound, the short
 *   way round a loop, is sought to where the sound will be heard as the
 *   seek lands; judged on the frames shown when there are (the median of
 *   the last `VIDEO_STRAY_FRAMES`, none until that many have shown), else
 *   on its clock; none while a seek of it lands.
 */
export function followVideo(now: {
  plan: PlayPlan;
  heard: number;
  video: { time: number; runs: boolean; settling: boolean };
  shown?: { offs: readonly number[] } | null;
  lead?: number;
  frameMs: number;
}): VideoStep {
  const { plan, heard, video } = now;
  const lead = now.lead ?? VIDEO_SEEK_S;
  if (!video.runs) return NO_STEP;
  const span = plan.endSeconds - plan.loopStartSeconds;
  if (plan.loops && span > 0) {
    const inMs = (plan.endSeconds - heard - lead) * 1000;
    const late = video.time > plan.endSeconds - span / 2;
    if (inMs < now.frameMs && late) {
      return { step: "restart", inMs: Math.max(0, inMs) };
    }
  }
  if (video.settling) return NO_STEP;
  const { shown } = now;
  let off = videoDrift(plan, video.time, heard);
  if (shown != null) {
    if (shown.offs.length < VIDEO_STRAY_FRAMES) return NO_STEP;
    const last = [...shown.offs.slice(-VIDEO_STRAY_FRAMES)].sort(
      (a, b) => a - b,
    );
    off = last[Math.floor(last.length / 2)];
  }
  if (Math.abs(off) <= VIDEO_SYNC_S) return NO_STEP;
  return { step: "seek", to: playPosition(plan, heard, lead) };
}

/**
 * A seek's lead after a restart (`followVideo`), from `offs`, the drift
 * (video less sound, seconds, `videoDrift`) of the `SEEK_LEARN_FRAMES`
 * frames its run showed after the seek's own: the lead grows by 0.8 of how
 * far they lagged (their median, so one frame held back does not count),
 * as in item 16's trial, by at most `SEEK_LEARN_STEP_S`, within 0 and
 * `VIDEO_SEEK_MAX_S`. Fewer frames teach nothing.
 */
export function learnSeekLead(lead: number, offs: readonly number[]) {
  if (offs.length < SEEK_LEARN_FRAMES) return lead;
  const sorted = [...offs].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const median = Number.isInteger(mid)
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[Math.floor(mid)];
  const step = Math.min(
    SEEK_LEARN_STEP_S,
    Math.max(-SEEK_LEARN_STEP_S, -0.8 * median),
  );
  return Math.min(VIDEO_SEEK_MAX_S, Math.max(0, lead + step));
}

/**
 * When (context time) a playing video sound hands over to its pass's new
 * `next` plan, standing at `position` under `old` at context time `at`: a
 * loop that becomes a play once with its wrap less than half a pass away
 * (the video's last pass, reported as the video was sought ahead of the
 * wrap) loops that once more and hands over at the wrap, so the last pass
 * plays whole; any other change at `soonest`.
 */
export function planSwitchAt(
  old: PlayPlan,
  next: PlayPlan,
  position: number,
  at: number,
  soonest: number,
): number {
  if (old.loops && !next.loops) {
    const toWrap = old.endSeconds - position;
    if (toWrap < (old.endSeconds - old.loopStartSeconds) / 2) {
      return Math.max(soonest, at + toWrap);
    }
  }
  return soonest;
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
