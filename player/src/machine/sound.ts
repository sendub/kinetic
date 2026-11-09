// What should sound at an item (docs/content-format.md, "What plays at an
// item"; docs/plan.md Phase 47, item 4). Pure: the machine (machine.ts
// `targetSound`) owns the story order and hands this module a `SoundPath`;
// this module finds, for music and for ambience separately, the nearest
// item at or before a given one along that path that sets the channel, and
// keeps the answers so an arrival costs next to nothing.
//
// Cost: most of a story's backward path is item i to item i - 1. Those
// stretches (runs) are static, so per item the nearest setter inside its
// own run is precomputed once (`musicIn`, `ambienceIn`), and a resolution
// walks the path one RUN at a time: only a run's first item asks the
// machine for its step back, which depends on the last picks and the seen
// set. The answer at each run's first item is kept (`memo`) until the
// machine says those inputs changed (`invalidate`, `seen`), so reading on
// costs one lookup per arrival, and a jump costs the run starts between it
// and the nearest kept one. The tables are built on the first resolution
// and only for a manifest whose items carry audio; one without makes none.

import type { Item, TargetSound } from "./types";

/** The story order a resolution walks, from the machine. */
export interface SoundPath {
  /**
   * True when the step back from item `index` is item `index - 1` whatever
   * the last picks and the seen set: no route starts there, nothing joins
   * into it, and the step forward from `index - 1` is `index`. Static.
   */
  linear(index: number): boolean;
  /**
   * The item before item `index` on the path back (choice screens passed
   * through), or -1 at the start. Reads the current picks and seen set.
   */
  back(index: number): number;
}

/** Where a channel's value comes from: the setting item's index, or -1. */
export interface SoundSetters {
  readonly music: number;
  readonly ambience: number;
}

const NONE: SoundSetters = Object.freeze({ music: -1, ambience: -1 });

const NO_AMBIENCE: readonly string[] = Object.freeze([]);

/** The target of a manifest without audio, or of a screen with none. */
export const SILENCE: TargetSound = Object.freeze({
  music: null,
  ambience: NO_AMBIENCE,
  voice: null,
  videoSound: null,
});

/** Whether any item of the manifest carries `audio`. */
export function hasItemAudio(items: readonly Item[]): boolean {
  return items.some((item) => item.audio !== undefined);
}

/** The music the setter gives (null: silence or none found). */
export function musicOf(items: readonly Item[], setter: number): string | null {
  return setter < 0 ? null : (items[setter].audio?.music ?? null);
}

/** The ambience the setter gives (empty: silence or none found). */
export function ambienceOf(
  items: readonly Item[],
  setter: number,
): readonly string[] {
  return setter < 0
    ? NO_AMBIENCE
    : (items[setter].audio?.ambience ?? NO_AMBIENCE);
}

export interface SoundResolver {
  /** The music and ambience setters at item `index` for the path now. */
  at(index: number): SoundSetters;
  /** The picks changed, or the seen set was replaced: forget every answer. */
  invalidate(): void;
  /**
   * Item `index` has just been seen for the first time. The step back from
   * a run's first item reads the seen marks of the items at run edges (a
   * route's first and last item, a decision's `after` item, a join and the
   * item before it), so a first sight of one forgets every answer.
   */
  seen(index: number): void;
}

export function createSoundResolver(
  items: readonly Item[],
  path: SoundPath,
): SoundResolver {
  const count = items.length;
  /** The first item of each item's run. */
  const runStart = new Int32Array(count);
  /** The nearest item at or before each one, in its run, setting music. */
  const musicIn = new Int32Array(count);
  /** The same for ambience. */
  const ambienceIn = new Int32Array(count);
  for (let i = 0; i < count; i += 1) {
    const linear = i > 0 && path.linear(i);
    const audio = items[i].audio;
    runStart[i] = linear ? runStart[i - 1] : i;
    musicIn[i] = audio?.music !== undefined ? i : linear ? musicIn[i - 1] : -1;
    ambienceIn[i] =
      audio?.ambience !== undefined ? i : linear ? ambienceIn[i - 1] : -1;
  }
  /** The setters at a run's first item, for the picks and seen set now. */
  const memo = new Map<number, SoundSetters>();

  /** The setters at item `index` given the setters at its run's start. */
  function within(index: number, start: SoundSetters): SoundSetters {
    const music = musicIn[index];
    const ambience = ambienceIn[index];
    if (music >= 0 && ambience >= 0) return { music, ambience };
    return {
      music: music >= 0 ? music : start.music,
      ambience: ambience >= 0 ? ambience : start.ambience,
    };
  }

  /**
   * The setters at run start `start`: walks back run by run to a kept
   * answer or the story's start, then fills in every run start passed,
   * farthest first. The walk is bounded by the item count, so a malformed
   * branch table whose steps loop ends in silence rather than hanging.
   */
  function atRunStart(start: number): SoundSetters {
    const known = memo.get(start);
    if (known !== undefined) return known;
    const starts: number[] = [];
    const befores: number[] = [];
    let tail = NONE;
    for (let at = start; ; ) {
      starts.push(at);
      const before = starts.length > count ? -1 : path.back(at);
      befores.push(before);
      if (before < 0) break;
      at = runStart[before];
      const kept = memo.get(at);
      if (kept !== undefined) {
        tail = kept;
        break;
      }
    }
    for (let k = starts.length - 1; k >= 0; k -= 1) {
      const before = befores[k];
      const behind = before < 0 ? NONE : within(before, tail);
      const own = starts[k];
      const setters = within(own, behind);
      memo.set(own, setters);
      tail = setters;
    }
    return tail;
  }

  return {
    at(index) {
      if (musicIn[index] >= 0 && ambienceIn[index] >= 0) {
        return { music: musicIn[index], ambience: ambienceIn[index] };
      }
      return within(index, atRunStart(runStart[index]));
    },
    invalidate() {
      memo.clear();
    },
    seen(index) {
      if (memo.size === 0) return;
      const edge =
        runStart[index] === index ||
        index === count - 1 ||
        runStart[index + 1] === index + 1;
      if (edge) memo.clear();
    },
  };
}
