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
   * `loopCount`-th `mediaEnded()` and the sum of the passes as a time bound —
   * `loopCount` passes of the range without a loop restart point. The renderer
   * loops the range back and reports `mediaEnded()` on each pass complete, so
   * the machine counts them. Ignored when `holdSeconds` is present.
   */
  loopCount?: number;
  /**
   * Start of the playback range in seconds, at least 0, default 0
   * (docs/content-format.md, "Video playback ranges"). Exact fractional
   * seconds: the machine does no rounding. The first pass runs from here to
   * `endSeconds`, and the media gate and skip dwell are built from the passes
   * rather than the file's duration; `durationSeconds` stays the file's total
   * duration.
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
   * Where a loop restarts, in seconds, at least 0, default `startSeconds`
   * (docs/content-format.md, "Video playback ranges"). Only later passes use
   * it: the first pass always runs `startSeconds` to `endSeconds`, and each
   * pass after that runs `loopStartSeconds` to `endSeconds`, so an intro
   * plays once. Re-entering the item starts a new first pass. The machine
   * needs it for the gate bound alone; the renderer owns the seeking.
   */
  loopStartSeconds?: number;
  /**
   * Explicit display duration in seconds, greater than 0. When present the
   * media gate is time-driven only — the hold is `max(textHoldMs,
   * holdSeconds * 1000)` and `mediaEnded()` is ignored entirely, because the
   * video is background: the renderer loops it freely and never reports an
   * `ended` for gating.
   */
  holdSeconds?: number;
  /**
   * Chain-exit floor in seconds, greater than 0 (docs/plan.md Phase 15,
   * docs/content-format.md "Timing"). When the CURRENT item is the last of
   * this video's text chain and an auto-advance path governs the step
   * (normal auto mode, or a play-all-routes burst — the zero-interactivity
   * experience is auto), the hold is `max(holdMs, minPlaySeconds * 1000 -
   * chainElapsedMs)`, `chainElapsedMs` being machine time since this video
   * became current. The chain plays through its dialogue normally; only
   * LEAVING the chain waits. Manual advance, navigation, and skip dwell
   * stay immediate — the reader who presses tab chose speed. Outside a
   * chain the field has no effect beyond the media gate. Per video item,
   * not per file: items sharing one file may differ.
   */
  minPlaySeconds?: number;
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

/**
 * What happens when a route's span completes (docs/content-format.md,
 * "Branches"). `"ending"` — the default — means the span's last item IS the
 * ending, so afterwards the overlay offers only route reselection; `"return"`
 * means the overlay also offers "return to main route", which proceeds to the
 * decision's `continueAt`. A continuing route's own `result` is moot.
 */
export type RouteResult = "return" | "ending";

/**
 * One route of a decision: an inclusive, contiguous span of items in array
 * order, referenced by item ids (docs/content-format.md, "Branches").
 */
export interface Route {
  /** Unique within its decision. */
  id: string;
  /** Text shown in the route list. */
  label: string;
  /** Id of the span's first item. */
  start: string;
  /** Id of the span's last item. */
  end: string;
  /** Defaults to `"ending"`: there is no implicit join into the main line. */
  result?: RouteResult;
}

/**
 * A branch decision laid over the item array (docs/content-format.md,
 * "Branches"): it fires when its `after` item settles on a forward advance,
 * and offers 2..N route spans. A route may contain further decisions.
 */
export interface Branch {
  /** Unique across `branches` and distinct from every item id. */
  id: string;
  /** Item id the decision fires on. Every route starts after it. */
  after: string;
  /** Question shown above the route list. */
  prompt: string;
  routes: readonly Route[];
  /** Id of the one route that continues the story; requires `continueAt`. */
  continuingRoute?: string;
  /** Item id where the continuing route proceeds after its end. */
  continueAt?: string;
}

export interface Manifest {
  schemaVersion: 1;
  width: number;
  height: number;
  /** Position in the array is position in the novel. */
  items: readonly Item[];
  /** Optional branch decisions over the same item array; absent is linear. */
  branches?: readonly Branch[];
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
  /**
   * Zero-interactivity route playback (docs/plan.md Phase 13); default false.
   * While on, a decision never surfaces its overlay: the machine auto-picks
   * the first not-yet-played route in manifest order — the continuing route
   * last — and after every route has played once it proceeds to `continueAt`.
   * Works inside skip mode too.
   */
  playAllRoutes: boolean;
}

export const DEFAULT_SETTINGS: MachineSettings = {
  readingSpeed: 1.0,
  minHoldMs: 1500,
  msPerChar: 60,
  skipDwellMs: 120,
  skipAll: false,
  playAllRoutes: false,
};

/**
 * One route as the decision overlay shows it. `seen` means the route has
 * already been PLAYED in this save (not merely that some of its items were
 * shown): the route-end overlay offers the routes with `seen: false` plus,
 * when `continueOption` is set, "return to main route".
 */
export interface ChoiceRoute {
  /** Index into the decision's `routes` array; `choose()` takes it. */
  readonly routeIdx: number;
  readonly id: string;
  readonly label: string;
  readonly seen: boolean;
}

/**
 * The open decision (docs/content-format.md, "Branches"). Its presence in
 * `MachineState` IS the awaiting-choice state: the reader picks a route with
 * `choose(routeIdx)`, or — only when `continueOption` is true — presses
 * "return to main route" with `chooseContinue()`.
 */
export interface ChoiceView {
  readonly decisionId: string;
  readonly prompt: string;
  readonly routes: readonly ChoiceRoute[];
  /** True when "return to main route" (the decision's `continueAt`) is offered. */
  readonly continueOption?: boolean;
}

/** One open decision context: which route of it the reader is inside. */
export interface ContextFrame {
  readonly decision: number;
  readonly route: number;
}

/**
 * JSON-safe route-play context for persistence (docs/plan.md Phase 13):
 * `exportContext()` returns it, `importContext()` and `MachineOptions.
 * resumeContext` restore it. `visited` is the per-item seen set (item
 * indices), `stack` the open decision contexts innermost-last, and
 * `playedRoutes` the route indices played per decision.
 */
export interface MachineContext {
  lastShown: number;
  visited: readonly number[];
  stack: readonly ContextFrame[];
  playedRoutes: readonly { decision: number; routes: readonly number[] }[];
}

/**
 * Observable machine state. `cursor` indexes the shown item; `frontier` is a
 * DERIVED legacy value — the first never-shown item of the visited set
 * (`frontier === items.length` when everything has been seen), exactly the
 * old number while seen items form a contiguous prefix, and 1 past the
 * highest item ever shown once routes make the set gappy (see
 * `machine.ts`'s header); `visitedList()` is the authoritative set.
 * `settled` means the current item's timing rule is
 * satisfied (via its auto-advance condition, a manual `advance()`, or a
 * resume / `e`-jump landing on an item that was read before), so the next
 * `advance()` moves on. `skipping` means skip mode (tab) is active: the
 * machine advances every item after `settings.skipDwellMs` regardless of
 * media. While it is true the renderer must show an animation's first
 * frame and a video's poster as stills and never play media — the machine
 * only times, it cannot stop a playing element. `choice` is present while a
 * branch decision awaits the reader: it is the overlay's content, and while
 * it is set every navigation command is inert until `choose()` or
 * `chooseContinue()` answers it.
 */
export interface MachineState {
  readonly cursor: number;
  readonly frontier: number;
  readonly settled: boolean;
  readonly skipping: boolean;
  readonly choice?: ChoiceView;
}

/** Timer seam so tests control time. Handles are opaque. */
export interface Scheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}
