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

/** What an audio element plays (the test hook's `data-slot`). */
export type AudioSlot = "music" | "ambience" | "sfx" | "voice" | "video";

/**
 * The reader's volume for a slot's group: Music for music and ambience,
 * Effects for one-shots and video sound, Voice for voice.
 */
export function groupVolume(
  slot: AudioSlot,
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
 * Whether an element of `slot` may sound (docs/plan.md Phase 47, item 5):
 * nothing with sound off or the page hidden; under the Esc screen nothing,
 * except music and ambience while its Volumes pop-out is open; under the
 * branch map everything but the voice; over the story and a choice screen
 * everything. An element held here pauses where it is and plays on once
 * it may again.
 */
export function maySound(slot: AudioSlot, gate: SoundGate): boolean {
  if (!gate.soundOn || gate.hidden) return false;
  if (gate.esc) {
    return gate.volumesOpen && (slot === "music" || slot === "ambience");
  }
  return !(gate.map && slot === "voice");
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

/** Where a play of a track starts, loops and ends, in seconds. */
export interface PlayPlan {
  /** Restarts at `loopStartSeconds` when it reaches `endSeconds`. */
  loops: boolean;
  /**
   * The element's own `loop` attribute does the looping: only when the
   * loop and the play both start at 0, as the element always restarts at 0.
   */
  native: boolean;
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
  const loops = looping && track.loop !== false;
  return {
    loops,
    native: loops && startSeconds === 0 && loopStartSeconds === 0,
    startSeconds,
    loopStartSeconds,
    endSeconds: track.durationSeconds,
  };
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
