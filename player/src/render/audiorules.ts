// The sound's rules (docs/plan.md Phase 47, item 5), apart from the elements
// that play it (render/audio.ts): the volume product, the one-shot pool,
// how a track plays and loops, and the director, which turns the machine's
// arrivals into what should sound and when. DOM-free: time enters through
// the global timers, which tests fake.
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
 * How far a video's sound may be from its video's time before it seeks
 * back onto it (docs/plan.md Phase 47, item 6). The converting agent
 * measured a steady 16-43 ms behind, and 200-340 ms off right after a seek
 * in Chrome; headless Chrome here, seeking with no lead, lands 64-86 ms
 * behind.
 */
export const VIDEO_SYNC_S = 0.08;
/**
 * How long a seek of a video's sound is given to land, from its `seeked`,
 * before its drift is judged again (`stepVideoSync`). Measured on macOS
 * 27.2: WebKit holds an audio element's clock while it seeks (40-180 ms),
 * plays, then holds it again, so a seek lands 340-480 ms late (a play from
 * paused, or a rate change, holds it too) and is steady 640-880 ms after
 * it was made; Chrome is steady within 100 ms.
 */
export const VIDEO_LAND_MS = 900;
/**
 * The most a seek aims ahead of its video, above the latest landing
 * measured (645 ms: WebKit's first start of a file; a resume after a menu
 * up to 575 ms). A landing further off than this (a seek the engine
 * dropped, as WebKit drops one before the file's metadata) teaches the
 * lead nothing.
 */
export const VIDEO_LEAD_MAX_S = 0.75;
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

/**
 * An element's volume: the track's `volume` (default 1) x its group's x the
 * duck x the fade, each held to [0, 1] so a stored setting outside it (an
 * imported file can hold any number) never makes `element.volume` throw.
 */
export function elementVolume(parts: {
  track: number | undefined;
  group: number;
  duck: number;
  fade: number;
}): number {
  return (
    unit(parts.track ?? 1) *
    unit(parts.group) *
    unit(parts.duck) *
    unit(parts.fade)
  );
}

/**
 * The kinds of seek of a video's sound, each landing its own way in WebKit
 * (macOS 27.2): a start as the video plays again after its own seek (a
 * wrap, or its entry) about 340 ms late; a start as the video resumes (a
 * menu closed, the page shown) 440-575 ms late; a seek while the sound
 * plays 390-460 ms late. Chrome lands each 64-86 ms late.
 */
export type SeekKind = "wrap" | "resume" | "seek";

/** What the landings of one kind of seek have taught. */
export interface Lead {
  /**
   * How far ahead of the video such a seek aims (seconds): an engine holds
   * an element's clock while it seeks and starts, so a seek lands behind
   * where it aimed.
   */
  readonly lead: number;
  /** Some landing of this kind has been learnt from. */
  readonly learnt: boolean;
  /**
   * The last landing judged lay more than twice the tolerance off, and
   * taught nothing: the next such one teaches.
   */
  readonly strayed: boolean;
}

/** Where `stepVideoSync` stands between steps. */
export interface VideoSync {
  /** By kind of seek, kept for the session. */
  readonly leads: Readonly<Record<SeekKind, Lead>>;
  /**
   * The sound's last seek, until its landing is judged: when (page ms; the
   * moment it stopped seeking), whether to learn from where it lands, its
   * kind, and the lead it aimed with.
   */
  readonly landing: {
    readonly at: number;
    readonly learn: boolean;
    readonly kind: SeekKind;
    readonly aim: number;
  } | null;
  /** The video's time at the last step; null when nothing is known yet. */
  readonly lastVideo: number | null;
}

const UNLEARNT: Lead = Object.freeze({
  lead: 0,
  learnt: false,
  strayed: false,
});

/** Nothing learnt, nothing landing. */
export const VIDEO_SYNC_START: VideoSync = Object.freeze({
  leads: Object.freeze({ wrap: UNLEARNT, resume: UNLEARNT, seek: UNLEARNT }),
  landing: null,
  lastVideo: null,
});

/**
 * One check of a video's sound against its video at page time `at`
 * (docs/plan.md Phase 47, item 6); the track's time is the video's media
 * time. It seeks to the video's time, its kind's lead ahead:
 * - when the sound starts (`starting`: the caller plays it after the seek):
 *   a `wrap` start when the video's time moved back since the last step or
 *   nothing is known of it yet, else a `resume`;
 * - when the video's time moved back (a range wrap or a native loop) while
 *   the sound plays, even while the last seek lands: a `wrap`. A playing
 *   video's time never steps back otherwise (measured in both engines);
 * - when the sound is more than `VIDEO_SYNC_S` from the video, judged only
 *   once its last seek, its own or any other, has landed: `VIDEO_LAND_MS`
 *   after the sound stopped seeking. A `seek`.
 *
 * The first judgement after one of its seeks teaches that kind's lead how
 * far off it landed: all of the miss the first time, half after that, as
 * landings scatter. A kind not yet taught aims with a taught one's lead.
 * Nothing is learnt from a seek made before the sound had played its file
 * (`warm` false: a file's first start lands as late as the engine takes to
 * open it), nor from one more than `VIDEO_LEAD_MAX_S` off. Once a kind is
 * taught, a landing more than twice `VIDEO_SYNC_S` off teaches only if the
 * one before it strayed as far: WebKit holds back the first play after the
 * page shows by about 300 ms, a one-off, while two in a row say the
 * engine's own lag has changed.
 */
export function stepVideoSync(
  sync: VideoSync,
  at: number,
  now: {
    sound: number;
    video: number;
    starting: boolean;
    /** The sound element is seeking. */
    seeking: boolean;
    /** The sound has played since its file loaded, and could play at once. */
    warm: boolean;
  },
): { sync: VideoSync; seekTo: number | null } {
  const seek = (kind: SeekKind, leads: VideoSync["leads"]) => {
    const aim = aimFor(leads, kind);
    return {
      sync: {
        leads,
        landing: { at, learn: now.warm, kind, aim },
        lastVideo: now.video,
      },
      seekTo: Math.max(0, now.video + aim),
    };
  };
  const movedBack = sync.lastVideo !== null && now.video < sync.lastVideo;
  if (now.starting) {
    const wrap = movedBack || sync.lastVideo === null;
    return seek(wrap ? "wrap" : "resume", sync.leads);
  }
  if (movedBack) return seek("wrap", sync.leads);
  const hold = (landing: VideoSync["landing"]) => ({
    sync: { ...sync, landing, lastVideo: now.video },
    seekTo: null,
  });
  const { landing } = sync;
  if (now.seeking) {
    return hold(
      landing === null
        ? { at, learn: false, kind: "seek", aim: 0 }
        : { ...landing, at },
    );
  }
  if (landing !== null && at - landing.at < VIDEO_LAND_MS) return hold(landing);
  const off = now.sound - now.video;
  const leads =
    landing?.learn === true && Math.abs(off) <= VIDEO_LEAD_MAX_S
      ? {
          ...sync.leads,
          [landing.kind]: learnLead(sync.leads[landing.kind], landing.aim, off),
        }
      : sync.leads;
  if (Math.abs(off) > VIDEO_SYNC_S) return seek("seek", leads);
  return {
    sync: { leads, landing: null, lastVideo: now.video },
    seekTo: null,
  };
}

/** The lead a seek of `kind` aims with: its own, else a taught kind's. */
function aimFor(leads: VideoSync["leads"], kind: SeekKind): number {
  const taught = [kind, "seek", "wrap", "resume"] as const;
  return taught.map((k) => leads[k]).find((lead) => lead.learnt)?.lead ?? 0;
}

/** A kind's lead after a trusted landing `off` seconds from its video. */
function learnLead(lead: Lead, aim: number, off: number): Lead {
  if (lead.learnt && Math.abs(off) > 2 * VIDEO_SYNC_S && !lead.strayed) {
    return { ...lead, strayed: true };
  }
  const next = aim - (lead.learnt ? off / 2 : off);
  return {
    lead: Math.min(VIDEO_LEAD_MAX_S, Math.max(0, next)),
    learnt: true,
    strayed: false,
  };
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
   * Restarts at `loopStartSeconds` when it reaches `endSeconds`, on a
   * second element (`seamStep`), never by the element's own `loop` or a
   * seek of the playing element.
   */
  loops: boolean;
  startSeconds: number;
  loopStartSeconds: number;
  /** The track's `durationSeconds`: the element's own duration is never read. */
  endSeconds: number;
}

/**
 * How `track` plays: `looping` for music and ambience, which loop unless
 * the track says `loop: false`; one-shots and voice play once.
 */
export function playPlan(track: AudioTrack, looping: boolean): PlayPlan {
  const startSeconds = track.startSeconds ?? 0;
  const loopStartSeconds = track.loopStartSeconds ?? startSeconds;
  return {
    loops: looping && track.loop !== false,
    startSeconds,
    loopStartSeconds,
    endSeconds: track.durationSeconds,
  };
}

/**
 * How long before a loop's end its second element is asked to play while
 * nothing is learnt of that file: the slowest start measured, WebKit
 * playing a PCM WAV from paused (335-354 ms; Opus in WebM 266-280 ms,
 * headless Chrome about 60 ms; macOS 27.2, 2026-11-10).
 */
export const SEAM_LEAD_S = 0.35;
/** The most a lead may grow to. */
export const SEAM_LEAD_MAX_S = 0.75;
/**
 * How long after a second element's play() its clock is trusted to say
 * when its sound began: WebKit's clock for a WAV runs from about 85 ms,
 * stops near 0.37 s for about 270 ms while the sound catches up, then runs
 * true (measured as for `SEAM_LEAD_S`).
 */
export const SEAM_LAND_MS = 900;
/**
 * How far ahead of the second element's start a loop's end is watched on
 * animation frames: more than the 250 ms between `timeupdate`s, which
 * start the watch.
 */
export const SEAM_WATCH_S = 0.5;
/**
 * How long the window for a rehearsal is, just before the time its clock
 * needs to settle before the watch: late in the pass, so the playing
 * element's own start has settled and the second element has waited a
 * while, as it does before a real start (one rehearsed 0.3 s after its
 * file loaded took 205 ms where the real starts took 312-353 ms; WebKit,
 * AAC).
 */
export const SEAM_REHEARSE_S = 0.5;

/** What a loop's wrap needs now (`seamStep`). */
export interface SeamStep {
  readonly step: "wait" | "rehearse" | "start" | "switch";
  /** In how many seconds it is due (0: now); a timer, finer than frames, keeps it. */
  readonly inS: number;
}

/**
 * One look at a looping track's wrap (docs/plan.md Phase 47, item 14),
 * made on each animation frame near the end and on each `timeupdate`.
 * Every engine pauses an element that wraps on its own: the element's own
 * `loop` and a seek of a playing element each cost about 100 ms in
 * Chrome and 0.2-0.6 s in WebKit, and WebKit's own loop can stop for good
 * at the end of an Opus WebM or a WAV (measured as for `SEAM_LEAD_S`). So a
 * second element, waiting paused at the loop's restart point, is asked to
 * play `lead` seconds before the playing element reaches the end
 * (`start`; it plays inaudibly until then), and takes over at the end
 * (`switch`), when `remaining` (the end less the playing element's time)
 * reaches 0 or the element ended before it. Each is asked for on the last
 * look before its moment (within a `frame`, seconds, of it), timed to
 * that moment by `inS`: a start on the nearest frame could still be half
 * a frame off, and an engine starts a sound only on the next block of its
 * output (every start measured lay within 1 ms of a grid of 10.7 ms in
 * headless Chrome and 85.3 ms in the muted WebKit driver), so the error
 * is at least the distance to the nearest block. While no lead
 * is `learnt` for the file, the second element first rehearses its start
 * (`rehearse`), once, in the `SEAM_REHEARSE_S` before the pass leaves too
 * little time for its clock to settle before the watch, so even the first
 * wrap starts it on time. `spare` is what the second element is doing.
 */
export function seamStep(now: {
  remaining: number;
  lead: number;
  learnt: boolean;
  spare: "idle" | "rehearsing" | "started";
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
  const settled = now.lead + SEAM_LAND_MS / 1000 + SEAM_WATCH_S;
  if (
    now.spare === "idle" &&
    !now.learnt &&
    now.remaining > settled &&
    now.remaining <= settled + SEAM_REHEARSE_S
  ) {
    return due("rehearse", 0);
  }
  return due("wait", 0);
}

/**
 * The lead after one start of a second element, from its own clock: it was
 * asked to play at page time `played` (ms) and, read at `at`, had played
 * `media` seconds from the loop's restart point, so its sound began at
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
