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
  /**
   * Optional stable identity of the story (docs/content-format.md): the
   * player keys saved progress by it instead of the folder URL.
   */
  storyId?: string;
  /**
   * Optional name of the game (docs/content-format.md): the heading of the
   * Esc help screen and the page title. Absent: no heading.
   */
  title?: string;
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
   * Skip-mode dwell per picture or video still, in milliseconds (see
   * `DEFAULT_SETTINGS`). A fixed, fast rate: fast enough to re-traverse
   * read content in a burst, slow enough that the surface never lags a
   * frame the player cannot register. A `text` item takes no dwell during
   * skip (docs/plan.md Phase 18, skip paces by pictures).
   */
  skipDwellMs: number;
  /** Skip past unseen content too; default false. */
  skipAll: boolean;
  /**
   * Skip plays videos (docs/plan.md Phase 18); default false. While on, a
   * skip burst that reaches a video plays it as forward reading would — its
   * range, loop passes or `holdSeconds`, timed by `videoGateMs` — instead of
   * a `skipDwellMs` poster, then the burst carries on. A video heading a
   * text chain plays its plan on the head item, then the chain's lines take
   * zero time like every line during skip. Space during
   * such a playback aborts the video and the burst continues.
   */
  skipPlaysVideos: boolean;
  /**
   * Zero-interactivity route playback (docs/plan.md Phase 13, reworked in
   * Phase 18); default true since Phase 24 — Kinetic is an interaction-free
   * kinetic game, so a reader opts out of it, not in. While on, each decision's choice still shows,
   * with a countdown sized to its words and rows (`choiceCountdownMs`), then the
   * machine picks the shortest not-yet-played route — the continuing route
   * last — highlights it briefly and enters it (`ChoiceView.autoPick`).
   * After every route has played once it proceeds to `continueAt`. Inside a
   * skip burst the countdown is dropped; only the highlight shows.
   */
  playAllRoutes: boolean;
  /**
   * The branch map's Spoilers toggle (docs/plan.md Phase 31); default
   * false. While off, the map (`m`) shows placeholders instead of the
   * question of every decision not reached and the labels of its routes.
   * A reader setting stored with the others (so it persists and travels
   * with exported progress); the machine itself never reads it.
   */
  mapSpoilers: boolean;
}

export const DEFAULT_SETTINGS: MachineSettings = {
  readingSpeed: 1.0,
  minHoldMs: 1500,
  msPerChar: 60,
  // ~40 items/s: near Ren'Py's frame-rate-bound skip (config.skip_delay
  // 5 ms per statement), still showing each item's first frame.
  skipDwellMs: 25,
  skipAll: false,
  skipPlaysVideos: false,
  playAllRoutes: true,
  mapSpoilers: false,
};

/**
 * One route as the decision overlay shows it. `seen` means the route has
 * already been PLAYED in this save (not merely that some of its items were
 * shown): the route-end overlay offers the routes with `seen: false` plus,
 * when `continueOption` is set, "return to main route".
 *
 * PLAYED means `choose()` or a play-all auto-pick put the reader inside the
 * route (docs/plan.md Phase 16, Branches). Nothing else marks it: firing,
 * viewing or leaving the decision, a wheel step or `e` walking through the
 * route's items, and a restored position landing inside the span.
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
 * "return to main route" with `chooseContinue()`. A choice screen the
 * wheel walks onto (docs/plan.md Phase 27) is the same view — the panel,
 * the current seen marks and the return-row rule, a pick from it a real
 * pick — plus `walkRoute`.
 */
export interface ChoiceView {
  readonly decisionId: string;
  readonly prompt: string;
  readonly routes: readonly ChoiceRoute[];
  /**
   * True when "return to main route" (the decision's `continueAt`) is
   * offered — which requires the decision's CONTINUING route to have been
   * COMPLETED at least once (docs/plan.md Phase 18): entered-and-abandoned
   * does not count, and a decision with no continuing route never shows
   * the row. The renderer draws the row and its `0` hint only when set.
   */
  readonly continueOption?: boolean;
  /**
   * Present while `Play all routes` is about to answer this choice itself
   * (docs/plan.md Phase 18, "Play all routes shows the choice"): a
   * countdown, then the picked row highlighted, then the route starts.
   */
  readonly autoPick?: AutoPickView;
  /**
   * Present on a choice screen the wheel walked onto (docs/plan.md Phase
   * 27): the route the walk takes through this screen — going back, the
   * route that had been taken from it; going forward, the route about to be
   * taken. The renderer highlights its row as play-all marks its next pick
   * (`.choice-next`). Absent on a choice opened by reading, and on a walked
   * screen past a pure choice's region, where no route follows.
   */
  readonly walkRoute?: number;
}

/** The play-all auto-pick on an open choice (`ChoiceView.autoPick`). */
export interface AutoPickView {
  /** The route play-all takes: the shortest unplayed, the continuing last. */
  readonly routeIdx: number;
  /** False while counting down; true while the picked row is highlighted. */
  readonly picked: boolean;
  /** How long the current phase lasts from when it was armed, in ms. */
  readonly ms: number;
  /** Changes every time a phase is (re)armed, e.g. after a pause. */
  readonly armId: number;
  /** On a re-offer: the label of the route that just ended. */
  readonly backFromLabel?: string;
}

/** One open decision context: which route of it the reader is inside. */
export interface ContextFrame {
  readonly decision: number;
  readonly route: number;
}

/** The routes of one decision, by position (a played or completed set). */
export interface RouteSet {
  readonly decision: number;
  readonly routes: readonly number[];
}

/**
 * JSON-safe route-play context for persistence (docs/plan.md Phase 13):
 * `exportContext()` returns it, `importContext()` and `MachineOptions.
 * resumeContext` restore it. `visited` is the per-item seen set (item
 * indices), `stack` the open decision contexts innermost-last,
 * `playedRoutes` the route indices played per decision,
 * `completedRoutes` the route indices played THROUGH to their route end
 * per decision (docs/plan.md Phase 18), `lastPicks` the route last picked
 * at each decision and `choice` the decision whose choice screen is up
 * (docs/plan.md Phase 27). `lastShown` is the item on screen: the landing
 * of a restore. Every number here
 * is a POSITION in this manifest; what storage holds is the same context
 * keyed by item / decision / route id (`SavedContext`, converted by
 * `storage/ids.ts`), so saves survive content updates.
 */
export interface MachineContext {
  lastShown: number;
  visited: readonly number[];
  stack: readonly ContextFrame[];
  playedRoutes: readonly { decision: number; routes: readonly number[] }[];
  /**
   * Which routes were COMPLETED — stepped off their last item from inside
   * the route (docs/plan.md Phase 18, Branches). Entered-and-abandoned is
   * `playedRoutes` only; completion additionally needs `completedRoutes`.
   * "Return to main route" is offered from the CONTINUING route appearing
   * here. The field is newer than the rest of the context: absent (a legacy
   * save) restores as nothing-completed, the conservative reading — the row
   * simply stays hidden until the reader finishes the continuing route once.
   */
  completedRoutes?: readonly { decision: number; routes: readonly number[] }[];
  /**
   * The routes PLAYED THIS PASS (docs/plan.md Phase 22): unlike the
   * cumulative `playedRoutes` (the rows' seen marks), this record rewinds
   * with the reading position and drives only the route flow — play-all's
   * next pick, re-offer or close at a route end, the all-played rule.
   * Absent (an older save) reads as `playedRoutes`.
   */
  passRoutes?: readonly { decision: number; routes: readonly number[] }[];
  /**
   * The route LAST PICKED at each decision (docs/plan.md Phase 27), one
   * frame per decision: the wheel follows it through the decision. Absent
   * (a save from before the timeline) reads as no pick known; storage
   * derives it from an old save's reading history (storage/idb.ts).
   */
  lastPicks?: readonly ContextFrame[];
  /**
   * The decision whose choice screen is up over `lastShown`, so a reload
   * opens it again (a play-all countdown restarts). Absent: no choice, or
   * one the wheel walked onto (a reload lands on the item under it).
   */
  choice?: number;
}

/**
 * How the item under the cursor became current. `advance` is a forward step
 * the reader took or the auto timer took — a space press or the auto-advance
 * firing — so the item is being READ now and its media plays. `nav` is an
 * arrival at content the reader already has on the map: the wheel, a
 * bookmark `goTo()`, a bookmark restore, `e`, a route entry or a
 * route-end join, skip's dwell step, and the load-time landing. Scrubbing
 * stays fast, so a nav arrival below the seen edge holds the poster. The
 * renderer reads this with `cursor`/`frontier` to decide whether a video
 * replays (docs/content-format.md, "Timing"; `playbackModeFor`).
 */
export type TransitionKind = "advance" | "nav";

/**
 * Observable machine state. `cursor` indexes the shown item; `frontier` is a
 * DERIVED legacy value — the first never-shown item of the visited set
 * (`frontier === items.length` when everything has been seen), exactly the
 * old number while seen items form a contiguous prefix, and 1 past the
 * highest item ever shown once routes make the set gappy (see
 * `machine.ts`'s header); `visitedList()` is the authoritative set.
 * `settled` means the current item's timing rule is
 * satisfied (via its auto-advance condition, a manual `advance()`, or a
 * resume landing on an item that was read before), so the next
 * `advance()` moves on. `skipping` means skip mode (tab) is active: the
 * machine advances every picture after `settings.skipDwellMs` regardless
 * of media and every `text` item after zero time. While it is true the
 * renderer hides the caption (docs/plan.md Phase 18) and must show an animation's first
 * frame and a video's poster as stills and never play media (unless
 * `skipVideo` says skip is playing the video) — the machine
 * only times, it cannot stop a playing element. `choice` is present while a
 * branch decision awaits the reader: it is the overlay's content, and while
 * it is set space, tab and bookmark jumps are inert until `choose()` or
 * `chooseContinue()` answers it; the wheel and `e` walk on and leave it.
 * `transition` is the kind of the step that made `cursor` current
 * (`TransitionKind`): a forward advance plays its media wherever the cursor
 * sits, a nav arrival below the seen edge shows posters instead.
 */
export interface MachineState {
  readonly cursor: number;
  readonly frontier: number;
  readonly settled: boolean;
  readonly skipping: boolean;
  readonly transition: TransitionKind;
  readonly choice?: ChoiceView;
  /**
   * Present while the cursor stands on an ENDING — the array end or an
   * ending route's last item — with no choice open (docs/plan.md Phase
   * 18, "End card"): the render layer
   * draws the small end card from it. Present when content is still
   * unseen, and — in a manifest with branches — when everything has been
   * seen (all counts zero), so the card can say so. Absent otherwise, and
   * at a play-all route ending (the journey carries on by itself).
   */
  readonly endCard?: EndCard;
  /**
   * Present (true) while skip mode is PLAYING the video on screen (the
   * `skipPlaysVideos` setting): the cursor item is a video, or a text line
   * of a video's chain. The render layer then plays the video as a forward
   * advance would, instead of holding it to its poster; `skipping` stays
   * true (docs/plan.md Phase 18, "Skip can play videos").
   */
  readonly skipVideo?: true;
}

/**
 * The end card's content (docs/plan.md Phase 18, "End card"): what is still
 * unseen when an ending shows. All zero / false means everything has been
 * seen.
 */
export interface EndCard {
  /**
   * Routes never played (across every decision, nested ones included) that
   * still hold an unseen item.
   */
  readonly unseenRoutes: number;
  /**
   * Some unseen item lies outside every unplayed route: main-line content
   * (a prequel, an aftermath reached through a route) or the rest of a
   * route that was entered and left.
   */
  readonly otherUnseen: boolean;
  /** `jumpToUnseen()` (`u`) has somewhere to go from here. */
  readonly nextUnseen: boolean;
}

/** Timer seam so tests control time. Handles are opaque. */
export interface Scheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}
