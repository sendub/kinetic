// The arithmetic of a streamed spoken line (docs/plan.md Phase 52 item 4b).
// A line the reader waits for is generated in chunks (render/voiceclient.ts
// `SpeechChunk`), each decoded as it arrives; played back to back they are
// the whole line, the joins already crossfaded by the engine. The stream has
// a timeline of its own, its chunks' seconds joined end to end; `base` is
// the audio context time at which that timeline's 0 falls while the stream
// plays, so its position at context time `at` is `at - base`.
//
// The player (render/audio.ts) schedules each chunk's source on the
// context's clock from these places: all the chunks so far from a position
// (a start, or a resume after a menu or a hidden page held it), and each new
// one where the last scheduled one ends, or at once when it is late.

/**
 * How long past what has been scheduled auto-forward still waits for a
 * streamed line's next chunk: the line's end is unknown until its final
 * chunk comes, so the hold is renewed by each chunk. A stall longer than
 * this (an engine that hung) gives the hold up.
 */
export const STREAM_MORE_MS = 30_000;

/** One chunk's place: when its source starts, and from where in the chunk. */
export interface Placement {
  readonly index: number;
  /** Context time. */
  readonly when: number;
  /** Seconds into the chunk (a chunk resumed part way). */
  readonly offset: number;
}

/** Slack for a boundary that floating point puts a hair either side of. */
const EPS = 1e-9;

/**
 * Plays chunks of `durations` from stream `position` at context time `at`:
 * the stream's `base` for that, and the placement of each chunk not yet
 * wholly played, back to back (the first starts at `at`, from its offset).
 * With every chunk played already there is nothing to place.
 */
export function resumePlan(
  durations: readonly number[],
  position: number,
  at: number,
): { base: number; placements: Placement[] } {
  const base = at - position;
  const placements: Placement[] = [];
  let start = 0;
  durations.forEach((seconds, index) => {
    const end = start + seconds;
    if (end > position + EPS) {
      const offset = Math.max(0, position - start);
      placements.push({ index, when: base + start + offset, offset });
    }
    start = end;
  });
  return { base, placements };
}

/**
 * Where a chunk that arrives at context time `at` goes, when
 * the stream plays with `base` and `total` seconds already scheduled: where
 * the scheduled audio ends, so the two play back to back; a late chunk (the
 * scheduled audio ended before it came) starts at once and moves the
 * timeline's base so what follows still joins it. Returns the new base.
 */
export function appendPlan(
  base: number,
  total: number,
  at: number,
): { base: number; when: number } {
  const when = Math.max(base + total, at);
  return { base: when - total, when };
}

/** Where a stream that plays with `base` stands at context time `at`, within what has arrived. */
export function streamPosition(
  base: number,
  total: number,
  at: number,
): number {
  return Math.min(total, Math.max(0, at - base));
}
