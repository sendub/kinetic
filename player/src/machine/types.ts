// Manifest and machine data types. Mirrors docs/content-schema.json; the
// semantics live in docs/content-format.md. Pure data: no DOM, no runtime
// dependencies, and no code in this module.

export type ItemType = "image" | "animation" | "video" | "text";

/** Shared overlay fields. Empty or absent `text` means a bare visual. */
interface OverlayFields {
  speaker?: string;
  text?: string;
  /**
   * `true` marks `text` as `speaker`'s unspoken thought rather than spoken
   * dialogue, so the overlay draws the two differently (docs/plan.md
   * Phase 7b). Timing is untouched; without a non-empty `text` it marks
   * nothing, which the content validator rejects. Data only — no machine rule
   * reads it.
   */
  thought?: boolean;
}

export interface ImageItem extends OverlayFields {
  id: string;
  type: "image";
  file: string;
}

export interface AnimationItem extends OverlayFields {
  id: string;
  type: "animation";
  /** Ordered frames, at least two. */
  frames: readonly string[];
  fps: number;
  /** Times the sequence plays before auto-advance, at least 1. */
  loopCount: number;
}

export interface VideoItem extends OverlayFields {
  id: string;
  type: "video";
  file: string;
  poster: string;
  durationSeconds: number;
  /**
   * Times the video plays before auto-advance, integer at least 1, default 1
   * (docs/content-format.md, "Items"). The gate is the later of the
   * `loopCount`-th `mediaEnded()` and the playback range length × `loopCount`
   * as a time bound — the whole file without a range. The renderer loops the
   * range back to `startSeconds` and reports `mediaEnded()` on each pass
   * complete, so the machine counts them. Ignored when `holdSeconds` is
   * present.
   */
  loopCount?: number;
  /**
   * Start of the playback range in seconds, at least 0, default 0
   * (docs/content-format.md, "Video playback ranges"). Exact fractional
   * seconds: the machine does no rounding. The media gate and skip dwell use
   * the range length (`endSeconds ?? durationSeconds - (startSeconds ?? 0)`)
   * as the time bound; `durationSeconds` stays the file's total duration.
   */
  startSeconds?: number;
  /**
   * End of the playback range in seconds, greater than `startSeconds`,
   * default `durationSeconds`. A pass-complete report arrives when playback
   * reaches it; the machine just counts reports, whatever emits them (the
   * file's `ended` when this is absent).
   */
  endSeconds?: number;
  /**
   * Explicit display duration in seconds, greater than 0. When present the
   * media gate is time-driven only — the hold is `max(textHoldMs,
   * holdSeconds * 1000)` and `mediaEnded()` is ignored entirely, because the
   * video is background: the renderer loops it freely and never reports an
   * `ended` for gating.
   */
  holdSeconds?: number;
}

/**
 * Dialogue over a visual already on screen. Carries no media fields: the
 * visual displayed is the nearest earlier media-bearing item's, which keeps
 * playing underneath the chain (docs/content-format.md, "Text items").
 */
export interface TextItem extends OverlayFields {
  id: string;
  type: "text";
}

export type Item = ImageItem | AnimationItem | VideoItem | TextItem;

export interface Manifest {
  schemaVersion: 1;
  width: number;
  height: number;
  /** Position in the array is position in the novel. */
  items: readonly Item[];
}

/** Player-side pacing settings (docs/content-format.md, "Timing"). */
export interface MachineSettings {
  /** Reading-speed multiplier; default 1.0. */
  readingSpeed: number;
  /** Floor on the text hold, in milliseconds; default 1500. */
  minHoldMs: number;
  /** Base per-code-point allowance, in milliseconds; default 60. */
  msPerChar: number;
  /**
   * Skip-mode dwell per item, in milliseconds; default 120. A fixed, fast
   * rate (~8 items per second): fast enough to re-traverse read content in
   * a burst, slow enough that the surface never lags a frame the player
   * cannot register.
   */
  skipDwellMs: number;
  /** Skip past unseen content too; default false. */
  skipAll: boolean;
}

export const DEFAULT_SETTINGS: MachineSettings = {
  readingSpeed: 1.0,
  minHoldMs: 1500,
  msPerChar: 60,
  skipDwellMs: 120,
  skipAll: false,
};

/**
 * Observable machine state. `cursor` indexes the shown item; `frontier` is
 * the first never-shown item (`frontier === items.length` when everything
 * has been seen); `settled` means the current item's timing rule is
 * satisfied (via its auto-advance condition, a manual `advance()`, or a
 * resume / `e`-jump landing on an item that was read before), so the next
 * `advance()` moves on. `skipping` means skip mode (tab) is active: the
 * machine advances every item after `settings.skipDwellMs` regardless of
 * media. While it is true the renderer must show an animation's first
 * frame and a video's poster as stills and never play media — the machine
 * only times, it cannot stop a playing element.
 */
export interface MachineState {
  readonly cursor: number;
  readonly frontier: number;
  readonly settled: boolean;
  readonly skipping: boolean;
}

/** Timer seam so tests control time. Handles are opaque. */
export interface Scheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}
