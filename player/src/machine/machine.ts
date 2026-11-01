// Timeline state machine core (docs/plan.md Phases 3-4, 13). Pure TypeScript:
// no DOM, no imports beyond ./types. Commands in, state out; time enters
// through an injected Scheduler so tests are deterministic.
//
// Seen set (Phase 13): `visited` is the set of item indices that have been
// SHOWN, and it is the source of truth for "seen". MARKING RULE — an item is
// marked the moment it becomes current, by whatever route to it: a forward
// advance, a skip step, a route entered by `choose()`, a wheel or `e` replay
// of the history, a `goTo()` bookmark click or a restore. (The wheel and `e`
// only ever show history entries, which were shown before, and a bookmark
// only reaches seen content, so marking on those arrivals changes nothing.)
// Seeing a decision marks nothing: its routes are ordinary items. The route
// ROW's seen mark is a different, narrower thing than this set: it is
// `played` — the routes the reader was actually routed into (docs/plan.md
// Phase 16, Branches).
//
// Reading history (docs/plan.md, "History rollback spec"): `history` records
// every screen shown, in the order shown — an item with the route frames open
// when it showed, or a decision's choice overlay as it opened (a first fire or
// a route-end re-offer) — and `pos` points at the entry on screen. Reading
// appends (a forward show, a skip step, a pick, the return row, a continuing
// route's join, a play-all auto-pick, an overlay opening); from `pos < last`
// a reading step whose screen equals the next recorded entry just moves `pos`
// along (replay), and one that differs drops the recorded future first (the
// Ren'Py fork). Jumps that are not reading (`goTo()`, a bookmark restore)
// append their landing at the end. The wheel moves `pos` only and shows the
// entry exactly — the item with its frames restored, or the choice screen in
// full — answering nothing and marking nothing played; `e` shows the last
// entry. The record is capped (`HISTORY_CAP`, oldest first) and persists in
// the context. The play-all interstitial is transient and never recorded.
//
// Transition kind (`MachineState.transition`): the same funnel that marks an
// item also records HOW it became current — `advance` for the forward step
// (a space press or the auto timer moving one item on), `nav` for every other
// route to it (a wheel or `e` replay, a bookmark `goTo()` or restore, a
// route entry, a route-end join, skip's dwell step, and the load-time
// landing). Timing is identical either way; the renderer reads the kind with
// `cursor` and `frontier` so a re-read below the seen edge plays its video
// while scrubbing back over the same items holds posters
// (docs/content-format.md, "Timing").
//
// `frontier` stays in `MachineState` as a DERIVED legacy value for the
// renderer and for resume persistence: 1 past the highest index ever shown.
// Where the seen set is a contiguous prefix from 0 — every manifest without
// branches, and a first play-through of one — that is also the smallest index
// not visited, i.e. precisely the old frontier; where routes have left holes
// (items seen inside some other route) it keeps the legacy rule instead of a
// prefix that would fall behind content the reader has seen. The authoritative
// set is `visitedList()`.
//
// Branch decisions (docs/content-format.md, "Branches"): a decision fires on
// the FORWARD SETTLE of its `after` item — on the press or auto-advance that
// completes it, never on navigation onto it. A firing decision either pauses
// (`MachineState.choice`, answered by `choose()` / `chooseContinue()`; space,
// tab and bookmark jumps are inert while it is open, the wheel and `e` leave
// it through the history) or, with `settings.playAllRoutes`, resolves itself
// to the first not-yet-played route in manifest order — the continuing route
// last — and past the decision once every route has played. Scrolling back
// over a decision point shows its choice screen because the history recorded
// it, not because the item has a decision. A stack of open decision contexts
// gives nesting: a route's end pops its frame, proceeds to `continueAt`, or
// re-opens that decision to offer the routes still unplayed. A pure-choice
// decision (no `continuingRoute`) whose every route has played does not
// re-open: it CLOSES and flow continues past the whole menu region — max
// route end + 1, the Ren'Py fall-through (docs/plan.md Phase 13).
//
// Skip mode (tab) advances one item per settings.skipDwellMs regardless of
// media: with skip_all off it ends when the cursor moves onto the first
// never-shown item (which is then shown normally); with skip_all on it marks
// items seen as it shows them and ends when nothing unseen is left to visit.
// Inside a branched manifest a skip visits items in PLAY order, and it PAUSES
// at a decision (docs/plan.md Phase 16): reaching an unresolved decision's
// `after` item opens the choice and ends the burst — `skipAll` governs only
// unseen stops — and after the pick the reader stays in manual mode (a skip
// burst never auto-resumes). `playAllRoutes` remains the no-stop path.
// `skipPlaysVideos` (Phase 18) makes a burst play each video it reaches for
// the video's own time bound instead of one dwell; Space aborts it and the
// burst goes on.

import type {
  Branch,
  ChoiceRoute,
  ChoiceView,
  ContextFrame,
  HistoryEntry,
  InterstitialView,
  Item,
  MachineContext,
  MachineSettings,
  MachineState,
  RouteResult,
  Scheduler,
  TransitionKind,
  VideoItem,
} from "./types";

export interface MachineOptions {
  items: readonly Item[];
  settings: MachineSettings;
  /**
   * The manifest's branch table (docs/content-format.md, "Branches"). Each
   * decision is resolved to item INDICES once, here: `after`, every route's
   * `start` / `end`, `continuingRoute` and `continueAt` become positions.
   * The content validator has already rejected a malformed table, so the
   * machine only defends itself against references that do not resolve: a
   * decision with an unresolvable reference is dropped rather than guessed,
   * and the surrounding items play linearly. Absent is a linear novel.
   */
  branches?: readonly Branch[];
  /**
   * Persisted frontier from a previous session: the first never-shown
   * item, one past the last item the reader saw. The machine then starts
   * on that last seen item (frontier - 1), the resume position.
   * Out-of-range values clamp. Ignored when `resumeContext` is present,
   * which carries that position plus the route-play context.
   */
  resumeFrontier?: number;
  /**
   * Restored route-play context (`exportContext()`), the Phase 13 form of a
   * resume: the seen set, the open decision stack, the routes played and
   * completed per decision, and the reading history — the load starts on
   * the entry at `historyPos` (a choice screen shows its overlay). A
   * context without a history lands on `lastShown` and starts a one-entry
   * history there. A context predating `completedRoutes`
   * restores with nothing completed (see `MachineContext`): the conservative
   * reading, the return row simply stays hidden until the continuing route
   * is finished once. Like the frontier resume that landing counts as
   * settled, and arriving inside a route whose decision was never answered
   * fires nothing: decisions fire only on the forward settle of their
   * `after` item.
   */
  resumeContext?: MachineContext;
  /**
   * Auto-forward mode (docs/plan.md Phase 13b, README `a` bullet). ABSENT
   * OR FALSE means manual — the documented default: no hold timer is
   * armed, items wait for `advance()` / the wheel / skip mode, and
   * nothing auto-advances until `setAutoAdvance(true)` (the `a` key).
   * True starts in auto-forward immediately.
   */
  autoAdvance?: boolean;
  /** Defaults to the global setTimeout/clearTimeout. */
  scheduler?: Scheduler;
}

export interface Machine {
  getState(): MachineState;
  /**
   * Index of the item whose visual to render, `items[visualIndex()]`. It
   * equals `cursor` for a media item and the nearest earlier media item for a
   * `text` item, whose visual keeps looping underneath the chain.
   */
  visualIndex(): number;
  /**
   * Sorted copy of the seen set — every item index that has been shown,
   * across every route visited (docs/plan.md Phase 13). This is what
   * persistence stores; `MachineState.frontier` is the derived legacy value.
   */
  visitedList(): number[];
  /**
   * Route-play context for persistence: `lastShown` (the item on screen),
   * `visitedList()`, the open decision stack, the routes played and
   * completed per decision, and the reading history with the entry on
   * screen — all JSON-safe. `MachineOptions.resumeContext` restores all of
   * it; `importContext()` restores all but the history. It is in array
   * POSITIONS (item, resolved-decision and route indices); storage never
   * holds this form — `storage/ids.ts` converts it to the id-keyed save
   * and back against the manifest being played, so a content update
   * (a prequel, a new route, a reorder) keeps saves valid.
   */
  exportContext(): MachineContext;
  /**
   * The bookmark-restore move: replaces the seen set, decision stack,
   * played routes and completed routes with a stored context and shows its
   * `lastShown` item. The arrival is UNSETTLED, like `goTo()`, fires no
   * decision, and is a jump: the landing is appended to THIS session's
   * history (the stored context's history, if any, is ignored). Like
   * `exportContext()` it takes positions: a bookmark's id-keyed context is
   * converted by `storage/ids.ts` first.
   */
  importContext(context: MachineContext): void;
  /** Receives every state change; returns an unsubscribe function. */
  subscribe(listener: (state: MachineState) => void): () => void;
  /**
   * Space press. In MANUAL mode — the player's start — one press is one
   * step: the current item's wait ends AND the cursor moves on the same
   * press (docs/plan.md Phase 16, "one action means one step"). In
   * AUTO-forward the press turns auto-forward OFF and moves nothing
   * (docs/plan.md Phase 18): the pending hold is cancelled, the reader stays
   * on the item, and the next press steps under the manual rule. During
   * skip mode the press stops the burst ON the item under the cursor — the
   * reader meant this one — so it settles without moving (and auto-forward,
   * if on, turns off like any Space in auto); except while skip
   * PLAYS a video (`settings.skipPlaysVideos`), where the press aborts the
   * video and the burst carries on with its next step.
   * Settling the item a decision hangs off is what fires that decision.
   * Inert while a choice is open, a replayed one included: only `choose()`
   * and `chooseContinue()` answer it. Every step is reading, so it records
   * into the history: from a rolled-back position it replays the record
   * while the screen matches and forks otherwise.
   */
  advance(): void;
  /**
   * Wheel step back one entry in the reading history, clamped at the first
   * (docs/plan.md, "History rollback spec"). The entry is shown exactly: an
   * item with the route frames it showed under, or a choice screen in full
   * (the overlay, the current seen marks and return-row rule). A step
   * answers nothing, marks nothing played, and leaves any open choice (it
   * stays in the history). An item arrival is unsettled, like `goTo()`.
   * During skip mode, exits skip mode and still performs the step.
   */
  wheelBack(): void;
  /**
   * Wheel step forward one entry in the reading history, clamped at the
   * last; otherwise as `wheelBack()`.
   */
  wheelForward(): void;
  /**
   * Tab press: toggles skip mode. While on, every item advances after
   * `settings.skipDwellMs` regardless of text/animation/video; media never
   * gates. With `settings.skipPlaysVideos` on, a video instead plays its
   * whole plan (its time bound, `videoGateMs`) before the burst moves on,
   * playing on beneath its text chain's dwelling lines. With `settings.skipAll` off skip never reveals unseen content
   * (docs/plan.md Phase 18): the burst steps only onto seen items and ends
   * ON the last seen one before the frontier, which is then shown normally;
   * a press with nothing seen ahead does nothing at all. With it on
   * the mode continues through unseen items, marking them seen, and ends
   * when nothing unseen is left to visit. A decision reached during a skip
   * STOPS the burst: the choice opens (`skipping` ends) and the reader
   * picks — the pick never auto-resumes skipping (docs/plan.md Phase 16).
   * Only `settings.playAllRoutes` auto-resolves inside a skip instead.
   */
  toggleSkip(): void;
  /**
   * `e` press: go to the END of the reading history and show that entry
   * exactly, as a wheel step would (docs/plan.md, "History rollback spec").
   * A no-op when already there. It finds no unseen content and looks up no
   * ending.
   */
  jumpToEnd(): void;
  /**
   * Bookmark click (the `t` overlay, README `t` bullet): move the cursor to
   * `index`, clamped to `[0, highest index ever shown]`. Nothing unseen is
   * entered — unseen items are reached by `advance()` or `choose()` — and no
   * decision fires; the route stack is left as it is. Inert while a choice
   * is open. The landing is appended to the end of the reading history.
   * The arrival is
   * UNSETTLED, unlike a resume landing: a bookmark click "continues the
   * novel from that time point", so the item's text hold replays and
   * auto-advance carries the reader onward.
   */
  goTo(index: number): void;
  /**
   * Decision overlay: pick route `routeIdx` (the index in
   * `MachineState.choice.routes`, so 1..9 minus one, or a pointer click).
   * The route is marked played, its frame is pushed for nesting, and its
   * first item is entered as a forward entry — shown, marked seen, its own
   * timing armed. From a choice screen replayed out of the history this is
   * the same real pick: it replays the record when the next entry is this
   * route's first item and forks it otherwise. Inert when no choice is open
   * or the index is out of range.
   */
  choose(routeIdx: number): void;
  /**
   * "Return to main route" on a decision whose CONTINUING route has
   * completed: proceed to the decision's `continueAt`. Inert unless the open
   * choice offers it (`MachineState.choice.continueOption`, which requires a
   * completed continuing route — docs/plan.md Phase 18), and it does not
   * mark the continuing route played — its items are skipped, not replayed.
   */
  chooseContinue(): void;
  /**
   * Pass-complete report for the current video item: the file's `ended`, or
   * a report at `endSeconds` when a playback range bounds it. It increments
   * the item's ended count, which must reach `loopCount` — alongside the
   * time bound — before a standalone video completes. Ignored when the item has
   * `holdSeconds` (a background video loops freely and never gates), while a
   * `text` item follows, during skip mode, and once the item is settled.
   * Below the seen edge a navigation arrival shows a still that reports
   * nothing, so the ended half of the gate drops out there and the item
   * completes on its time bound alone (docs/plan.md Phase 16, "Auto-forward
   * stall at part-012"); an advance below that edge does play and does report,
   * and the same bound paces its replay.
   */
  mediaEnded(): void;
  /**
   * `c` config screen (docs/plan.md Phase 9): replace the pacing settings
   * with a full snapshot; the machine copies it and never reads storage.
   * Changes apply live, each where its setting takes effect:
   *
   * - `readingSpeed` (and `skipDwellMs`): a pending auto-advance is
   *   re-armed as if the new settings had held since the item began, so
   *   the time already shown counts toward the new total — a 2400 ms hold
   *   changed to a 1200 ms one at 500 ms fires 700 ms later. A new total
   *   already behind the elapsed time fires on the next tick. An item
   *   with no pending timer (settled, or waiting on a video's `ended`) is
   *   not armed by this call. A pending `minPlaySeconds` chain-exit floor
   *   re-arms from the chain's own start instant, so the time already
   *   shown counts toward the floor exactly as toward the hold (Phase 15).
   * - `skipAll`: read when skip mode meets content the reader has not seen,
   *   so a change takes effect at the next crossing into unseen content.
   * - `skipPlaysVideos`: a pending skip timer on a video re-times as for
   *   `readingSpeed` (dwell <-> the video's bound), and the state's
   *   `skipVideo` flag follows at once.
   * - `playAllRoutes`: read when a decision fires, so a change takes effect
   *   at the next decision; a choice already open stays open (the reader
   *   answers it, or turns the setting off and back on to auto-play it).
   *
   * After `destroy()` it is inert, like every other command.
   */
  setSettings(settings: MachineSettings): void;
  /**
   * `a`: the auto-forward toggle (docs/plan.md Phase 13b, README `a`
   * bullet). Manual (off) is the player's start (main.ts constructs with
   * `autoAdvance: false`): nothing arms a hold timer, so items wait for
   * `advance()`, the wheel, or skip mode. Turning auto on arms the
   * current unsettled item's full hold from now; turning it off cancels
   * the pending hold. Skip mode is unaffected either way — its dwell is
   * the reader's own command and runs in both modes.
   */
  setAutoAdvance(on: boolean): void;
  isAutoAdvance(): boolean;
  /**
   * The key help's machine freeze (docs/plan.md Phase 13b): cancels the
   * pending timer — hold or skip dwell — and arms none while paused, so
   * the machine waits with no timers while the help screen is up.
   */
  pause(): void;
  /**
   * Ends `pause()`: the current item's hold re-arms FRESH (a skip dwell
   * too), like the other paused overlays — the wait restarts from the
   * moment of closing. A settled item stays settled: it advances only on
   * the reader's press.
   */
  resume(): void;
  /** Cancels the pending timer and drops all subscribers. */
  destroy(): void;
}

export const defaultScheduler: Scheduler = {
  schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  cancel: (handle) => globalThis.clearTimeout(handle as never),
};

/** Text hold in ms: max(minHold, codepoints(text) * msPerChar / speed). */
export function textHoldMs(
  text: string | undefined,
  settings: MachineSettings,
): number {
  const chars = [...(text ?? "")].length;
  if (chars === 0) return settings.minHoldMs;
  return Math.max(
    settings.minHoldMs,
    (chars * settings.msPerChar) / settings.readingSpeed,
  );
}

/** Effective `loopCount` of a video item, default 1. */
function videoLoops(item: VideoItem): number {
  return item.loopCount ?? 1;
}

/**
 * Length of a video item's playback range, in seconds
 * (docs/content-format.md, "Video playback ranges"): `startSeconds` defaults
 * to 0 and `endSeconds` to the file's total `durationSeconds`, so a video
 * without a range spans the whole file. Raw float math — nothing rounds.
 */
function videoRangeSeconds(item: VideoItem): number {
  const start = item.startSeconds ?? 0;
  const end = item.endSeconds ?? item.durationSeconds;
  return end - start;
}

/**
 * Length of a video item's loop pass, in seconds (docs/content-format.md,
 * "Video playback ranges"): `loopStartSeconds` to the range end, where
 * `loopStartSeconds` defaults to `startSeconds` — so without it the loop pass
 * equals the first pass. Raw float math — nothing rounds.
 */
function videoLoopPassSeconds(item: VideoItem): number {
  const end = item.endSeconds ?? item.durationSeconds;
  const loopStart = item.loopStartSeconds ?? item.startSeconds ?? 0;
  return end - loopStart;
}

/**
 * A standalone video's media-gate time bound, in ms: `holdSeconds` when
 * present — the video is then background and only the clock gates — else the
 * passes summed: the first pass (`videoRangeSeconds`) plus `loopCount - 1`
 * loop passes, which restart at `loopStartSeconds` and are the range again
 * without it (docs/content-format.md, "Timing"). Equal to the range length ×
 * `loopCount` when `loopStartSeconds` is absent. The pass-complete half of the
 * gate is unchanged: the machine counts `mediaEnded()` reports however the
 * renderer emits them (per range end via rVFC, or the file's `ended` without a
 * range). Raw float math — no rounding.
 */
function videoGateMs(item: VideoItem): number {
  if (item.holdSeconds !== undefined) return item.holdSeconds * 1000;
  const firstPassMs = videoRangeSeconds(item) * 1000;
  const loopPassMs = videoLoopPassSeconds(item) * 1000;
  return firstPassMs + (videoLoops(item) - 1) * loopPassMs;
}

/**
 * Auto-advance delay for an item, in ms: the time the item must be on screen
 * before it may complete. `nextIsText` marks a media item whose following
 * item is `text`: the chain advances on text holds alone, so an animation's
 * loop time and a video's gate drop out. A standalone video's true advance
 * also waits for its `mediaEnded()` loops unless the chain applies, so the
 * ended count is a second condition the machine checks when this elapses.
 */
export function itemHoldMs(
  item: Item,
  settings: MachineSettings,
  nextIsText = false,
): number {
  const hold = textHoldMs(item.text, settings);
  if (nextIsText) return hold;
  if (item.type === "animation") {
    const loopMs = (item.frames.length * item.loopCount * 1000) / item.fps;
    return Math.max(hold, loopMs);
  }
  if (item.type === "video") return Math.max(hold, videoGateMs(item));
  return hold;
}

/**
 * Index of the item whose visual the renderer draws at position `index`
 * (`items[visualIndexFor(items, index)]`). A media item shows its own
 * visual; a `text` item shows the visual of the nearest earlier
 * media-bearing item, which keeps looping underneath the chain
 * (docs/content-format.md, "Text items"). A `text` item before any media
 * item is a schema violation; index 0 is returned then, so the result is
 * always a usable index for a non-empty manifest.
 */
export function visualIndexFor(items: readonly Item[], index: number): number {
  if (items[index]?.type !== "text") return index;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (items[i].type !== "text") return i;
  }
  return 0;
}

/** A route with its item references resolved to indices. */
export interface ResolvedRoute {
  id: string;
  label: string;
  startIndex: number;
  endIndex: number;
  result: RouteResult;
  /** True for the decision's `continuingRoute`, whose `result` is moot. */
  continuing: boolean;
}

/** A decision with its item references resolved to indices. */
export interface ResolvedDecision {
  /** Position in the resolved table: what the stack and context store. */
  index: number;
  id: string;
  prompt: string;
  afterIndex: number;
  routes: ResolvedRoute[];
  /** Index into `routes` of the continuing route; -1 without one. */
  continuingRoute: number;
  /** Item index the continuing route proceeds to; -1 without one. */
  continueAt: number;
  /** Decision whose route span contains this one; -1 at the top level. */
  parent: number;
}

/** One open decision context: the route of it the reader is inside. */
interface Frame {
  decision: number;
  route: number;
}

/** A decision's menu-region end: the max `end` over all of its routes. */
function regionEnd(decision: ResolvedDecision): number {
  let end = -1;
  for (const route of decision.routes) {
    if (route.endIndex > end) end = route.endIndex;
  }
  return end;
}

/** The decision the overlay is showing, and whether it offers a return. */
interface PendingChoice {
  decision: number;
  continueOption: boolean;
}

/**
 * Resolves the branch table to item indices (docs/content-format.md,
 * "Branches"). The validator has already checked the table; an unresolvable
 * item id, an inverted span or a continuing route without `continueAt` drops
 * that one decision rather than guessing, so the manifest still plays.
 */
export function resolveDecisions(
  items: readonly Item[],
  branches: readonly Branch[],
): ResolvedDecision[] {
  const resolved: ResolvedDecision[] = [];
  if (items.length === 0 || branches.length === 0) return resolved;
  const byId = new Map<string, number>();
  items.forEach((item, index) => {
    if (!byId.has(item.id)) byId.set(item.id, index);
  });
  for (const branch of branches) {
    const afterIndex = byId.get(branch.after);
    if (afterIndex === undefined) continue;
    const continuingRoute = branch.routes.findIndex(
      (route) => route.id === branch.continuingRoute,
    );
    const continueAt =
      branch.continueAt === undefined
        ? -1
        : (byId.get(branch.continueAt) ?? -1);
    // `continuingRoute` and `continueAt` are a pair; a half of the pair that
    // does not resolve leaves the join unknown, so the decision is dropped.
    if (continuingRoute >= 0 !== continueAt >= 0) continue;
    const routes: ResolvedRoute[] = [];
    let sound = branch.routes.length >= 2;
    branch.routes.forEach((route, index) => {
      const startIndex = byId.get(route.start);
      const endIndex = byId.get(route.end);
      if (startIndex === undefined || endIndex === undefined) {
        sound = false;
        return;
      }
      if (startIndex > endIndex) sound = false;
      routes.push({
        id: route.id,
        label: route.label,
        startIndex,
        endIndex,
        result: route.result ?? "ending",
        continuing: index === continuingRoute,
      });
    });
    if (!sound || routes.length !== branch.routes.length) continue;
    resolved.push({
      index: resolved.length,
      id: branch.id,
      prompt: branch.prompt,
      afterIndex,
      routes,
      continuingRoute,
      continueAt,
      parent: -1,
    });
  }
  // Nesting: a decision belongs to the decision whose route span contains its
  // `after` item. Spans nest or are disjoint, so the tightest containing span
  // is its parent, and a top-level decision is contained by none.
  for (const child of resolved) {
    let tightest = Infinity;
    for (const outer of resolved) {
      if (outer.index === child.index) continue;
      for (const route of outer.routes) {
        const inside =
          child.afterIndex >= route.startIndex &&
          child.afterIndex <= route.endIndex;
        const width = route.endIndex - route.startIndex;
        if (inside && width < tightest) {
          tightest = width;
          child.parent = outer.index;
        }
      }
    }
  }
  return resolved;
}

type Listener = (state: MachineState) => void;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** A finite integer, or `fallback` for anything a stored value can be. */
function asIndex(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

/**
 * How long `Play all routes` holds the back-in-time interstitial before the
 * next route starts (docs/plan.md Phase 18).
 */
export const INTERSTITIAL_MS = 2500;

/**
 * The reading history's cap, in entries (docs/plan.md, "History rollback
 * spec"): past it the oldest entries are dropped first.
 */
export const HISTORY_CAP = 5000;

/** One reading-history entry (see `HistoryEntry`), owned by the machine. */
interface Entry {
  index: number;
  stack: Frame[];
  decision?: number;
}

function sameStack(a: readonly Frame[], b: readonly Frame[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (frame, depth) =>
        frame.decision === b[depth].decision && frame.route === b[depth].route,
    )
  );
}

/** Whether two history entries are the same screen. */
function sameEntry(a: Entry, b: Entry): boolean {
  return (
    a.index === b.index &&
    a.decision === b.decision &&
    sameStack(a.stack, b.stack)
  );
}

export function createMachine(options: MachineOptions): Machine {
  const { items } = options;
  // Copied, and copied again on every setSettings(): the caller keeps
  // owning the object it passed (main.ts persists it), and later mutation
  // of it cannot silently retime the timeline.
  let settings: MachineSettings = { ...options.settings };
  const scheduler = options.scheduler ?? defaultScheduler;
  const count = items.length;
  const decisions = resolveDecisions(items, options.branches ?? []);
  /** Decisions keyed by the item index they fire on, in table order. */
  const byAfter = new Map<number, number[]>();
  for (const decision of decisions) {
    const list = byAfter.get(decision.afterIndex);
    if (list === undefined) byAfter.set(decision.afterIndex, [decision.index]);
    else list.push(decision.index);
  }

  /**
   * The ENDING items, where the ending hint can show (docs/plan.md Phase
   * 18): the last item of the array plus the final item of every route
   * whose `result` is `ending`. A `return` route's end re-offers the
   * decision and a continuing route's end rejoins the story, so neither IS
   * an ending.
   */
  const endings = new Set<number>();
  if (count > 0) endings.add(count - 1);
  for (const decision of decisions) {
    for (const route of decision.routes) {
      if (!route.continuing && route.result === "ending")
        endings.add(route.endIndex);
    }
  }

  const listeners = new Set<Listener>();
  let cursor = 0;
  // The kind of the step that made `cursor` current. The start position is an
  // arrival like any other, not an advance — and it is at the seen edge, so
  // the renderer plays it either way.
  let transition: TransitionKind = "nav";
  /** Every item index shown so far, in any route (the seen set). */
  const visited = new Set<number>();
  /** `max(visited)`, -1 when nothing has been shown: the wheel's ceiling. */
  let highestSeen = -1;
  /**
   * The reading history (header, "Reading history"), oldest first, and the
   * position of the entry on screen; -1 only for an empty manifest.
   */
  const history: Entry[] = [];
  let pos = -1;
  /**
   * `exportHistory()`'s frozen copy, kept until the record changes: every
   * state change exports the context (persistence, the route pills), and
   * at the cap that is thousands of entries, while most changes only move
   * `pos`. Set to null wherever `history` itself changes.
   */
  let historyExport: readonly HistoryEntry[] | null = null;
  let settled = false;
  /** Open decision contexts, outermost first — the nesting stack. */
  const stack: Frame[] = [];
  /** Which route indices of each decision have been played, by decision. */
  const played = new Map<number, Set<number>>();
  /**
   * Which route indices of each decision have been COMPLETED — the reader
   * stepped off the route's last item from inside it (`handleRouteEnd`).
   * Entering is not completing: `played` marks on entry, this set marks on
   * reaching the route end. It exists for one rule (docs/plan.md Phase 18,
   * Branches): "Return to main route" is offered only once the decision's
   * CONTINUING route has been completed at least once — a continuation the
   * reader has not reached the end of is not a place to "return" to;
   * picking the continuing route is the way forward there.
   */
  const completed = new Map<number, Set<number>>();
  let pendingChoice: PendingChoice | null = null;
  let skipping = false;
  let holdElapsed = false;
  /** `mediaEnded()` calls counted for the standalone video under the cursor. */
  let endedCount = 0;
  let timer: unknown = null;
  // When the timer now running was armed for the item under the cursor.
  // setSettings() re-arms from this instant, so the new settings act as
  // if they had held since the item began (the interface docs). Time
  // enters only through scheduler and Date.now, both fakeable in tests.
  let timerArmedAt = 0;
  // When the media item that STARTED the current text chain became current
  // (the chain head), or null when the cursor is not inside such a chain:
  // the anchor for a video's `minPlaySeconds` chain-exit floor (Phase 15).
  // Like `timerArmedAt` it is a machine-time instant; the floor's remaining
  // time is derived from it, so a settings re-arm never resets the wait.
  let chainHeadAt: number | null = null;
  // Auto-forward mode (Phase 13b): absent/false is manual — the documented
  // default (README advance bullet): items wait for the reader until `a`.
  let autoAdvance = options.autoAdvance === true;
  // The help screen's freeze (Phase 13b): while paused nothing arms.
  let paused = false;
  /**
   * The play-all back-in-time interstitial being held (docs/plan.md
   * Phase 18): set at a route end that play-all answers with another
   * route; its own timer enters that route when it elapses.
   */
  let interstitial: {
    decision: number;
    fromRoute: number;
    toRoute: number;
    /** A skip burst was running: the elapsed hold resumes it. */
    resumeSkip: boolean;
  } | null = null;
  let interstitialTimer: unknown = null;
  let destroyed = false;
  // Start position. A stored context is authoritative: its history entry on
  // screen (or, without a history, its `lastShown`) is where the reader left
  // off. Otherwise a persisted frontier marks a seen
  // prefix, and the load starts on its last shown item. With neither, this is
  // the first-ever load: item 0, shown, so the frontier is one past it.
  if (count > 0) {
    if (options.resumeContext !== undefined) {
      applyContext(options.resumeContext);
      restoreHistory(options.resumeContext);
      settled = true; // a resume landing was already read, as with a frontier
    } else if (options.resumeFrontier !== undefined) {
      const frontier = clamp(options.resumeFrontier, 1, count);
      for (let index = 0; index < frontier; index += 1) visited.add(index);
      highestSeen = frontier - 1;
      cursor = frontier - 1;
      pushEntry(currentEntry());
      settled = true;
    } else {
      markShown(0);
      pushEntry(currentEntry());
    }
  }
  // The start position is an arrival like any other (Phase 15): a chain
  // entered at start — resumed or fresh — measures its floor from now.
  if (count > 0) chainHeadAt = chainHeadMarkFor(cursor, false);
  let state: MachineState = snapshot();
  // The item shown at start: auto mode arms its hold; manual mode (the
  // player's start, Phase 13b) waits for the reader instead. A restored
  // choice screen waits for its pick.
  if (pendingChoice === null) armTimer();

  function snapshot(): MachineState {
    const choice = pendingChoice === null ? null : choiceView(pendingChoice);
    const frontier = highestSeen < 0 ? 0 : Math.min(highestSeen + 1, count);
    // Play-all carries on from a route ending by itself, so the hint there
    // is noise; the array end still earns it.
    const endingHint =
      choice === null &&
      interstitial === null &&
      endings.has(cursor) &&
      visited.size < count &&
      !(settings.playAllRoutes && cursor !== count - 1);
    return Object.freeze({
      cursor,
      frontier,
      settled,
      skipping,
      transition,
      ...(choice === null ? {} : { choice }),
      ...(endingHint ? { endingHint: true as const } : {}),
      ...(skipPlaysVideo() ? { skipVideo: true as const } : {}),
      ...(interstitial === null
        ? {}
        : { interstitial: interstitialView(interstitial) }),
    });
  }

  function interstitialView(held: {
    decision: number;
    fromRoute: number;
    toRoute: number;
  }): InterstitialView {
    const decision = decisions[held.decision];
    // The context that led to the decision: the `after` item's own line, or
    // the nearest line before it when that item carries none.
    let context: string | undefined;
    for (let index = decision.afterIndex; index >= 0; index -= 1) {
      const text = items[index].text;
      if (typeof text === "string" && text !== "") {
        context = text;
        break;
      }
    }
    return Object.freeze({
      decisionId: decision.id,
      prompt: decision.prompt,
      ...(context !== undefined && context !== "" ? { context } : {}),
      routes: decision.routes.map((route, index) =>
        Object.freeze({
          routeIdx: index,
          id: route.id,
          label: route.label,
          seen: isPlayed(decision.index, index),
        }),
      ),
      fromRouteIdx: held.fromRoute,
      toRouteIdx: held.toRoute,
    });
  }

  /**
   * Play-all's route end answered by another route (docs/plan.md Phase 18):
   * hold a black interstitial for `INTERSTITIAL_MS` before the jump back in
   * time, so the reader can see where the journey goes. Timing is paused
   * underneath; the interstitial's own timer (or a press) enters the route.
   */
  function startInterstitial(
    decision: ResolvedDecision,
    fromRoute: number,
    toRoute: number,
  ): void {
    cancelTimer();
    const resumeSkip = skipping;
    skipping = false;
    settled = true;
    interstitial = { decision: decision.index, fromRoute, toRoute, resumeSkip };
    armInterstitial();
    emit();
  }

  function armInterstitial(): void {
    if (interstitialTimer !== null) scheduler.cancel(interstitialTimer);
    interstitialTimer = paused
      ? null
      : scheduler.schedule(() => finishInterstitial(true), INTERSTITIAL_MS);
  }

  /**
   * Ends the held interstitial and enters its route; false when none. When
   * the hold ELAPSED (`elapsed`) over a skip burst, the burst carries on:
   * play-all with skip-all is the no-interaction path. Any reader command
   * that ends it early leaves skip off — a press means "stop here".
   */
  function finishInterstitial(elapsed = false): boolean {
    if (interstitial === null) return false;
    if (interstitialTimer !== null) scheduler.cancel(interstitialTimer);
    interstitialTimer = null;
    const held = interstitial;
    interstitial = null;
    if (elapsed && held.resumeSkip) skipping = true;
    enterRoute(decisions[held.decision], held.toRoute);
    return true;
  }

  /** The overlay content for the open choice: prompt, routes, return offer. */
  function choiceView(pending: PendingChoice): ChoiceView {
    const decision = decisions[pending.decision];
    const routes: ChoiceRoute[] = decision.routes.map((route, index) =>
      Object.freeze({
        routeIdx: index,
        id: route.id,
        label: route.label,
        seen: isPlayed(decision.index, index),
      }),
    );
    const view = {
      decisionId: decision.id,
      prompt: decision.prompt,
      routes,
      ...(pending.continueOption ? { continueOption: true } : {}),
    };
    return Object.freeze(view);
  }

  function emit(): void {
    state = snapshot();
    for (const listener of [...listeners]) listener(state);
  }

  function cancelTimer(): void {
    if (timer !== null) {
      scheduler.cancel(timer);
      timer = null;
    }
  }

  /** The delay the current timer must cover, under the present settings. */
  function currentDelayMs(): number {
    if (skipping) {
      // Skip mode: one fixed `settings.skipDwellMs` per item whatever its
      // type. Media never gates and never plays to completion; the machine
      // only times (docs/content-format.md, "Timing"). A video's dwell is
      // clamped to its own gate, so a short clip is not shown longer than
      // the content describes. The `minPlaySeconds` floor NEVER enters here:
      // a reader in skip mode chose speed, and manual advance and skip stay
      // immediate — the floor exists so AUTO play sees the video (Phase 15).
      // `skipPlaysVideos` (docs/plan.md Phase 18) lifts the clamp for a
      // video: it plays its whole plan — range, passes or `holdSeconds` —
      // timed by the same bound forward play below the edge uses, so a clip
      // that cannot play never stalls the burst. A chain head plays its plan
      // on the head; the chain's lines then take one dwell each while the
      // video plays on beneath them (`skipPlaysVideo`).
      const item = items[cursor];
      if (item.type === "video") {
        if (settings.skipPlaysVideos) return videoGateMs(item);
        return Math.min(settings.skipDwellMs, videoGateMs(item));
      }
      return settings.skipDwellMs;
    }
    return Math.max(
      itemHoldMs(items[cursor], settings, nextIsText(cursor)),
      chainExitFloorMs(),
    );
  }

  /**
   * Whether skip mode is playing the video on screen (`skipPlaysVideos`,
   * docs/plan.md Phase 18): skipping, the setting on, and the visual under
   * the cursor a video — the video item itself or a line of its text chain.
   * The snapshot's `skipVideo` flag, and what makes Space abort the video
   * and keep the burst going rather than stop it.
   */
  function skipPlaysVideo(): boolean {
    if (!skipping || !settings.skipPlaysVideos || count === 0) return false;
    return items[visualIndexFor(items, cursor)]?.type === "video";
  }

  function onTimerElapsed(): void {
    timer = null;
    // `skipping` can only have changed through a re-arm, so dispatching
    // here matches the mode the timer was armed under.
    if (skipping) skipTick();
    else onHoldElapsed();
  }

  function armTimer(): void {
    cancelTimer();
    if (destroyed || count === 0) return;
    // Manual mode arms no hold — the reader advances by pressing; skip's
    // dwell is the reader's own command and runs in both modes, and the
    // help screen's pause arms nothing until resume() (Phase 13b).
    if (paused || (!skipping && !autoAdvance)) return;
    timerArmedAt = Date.now();
    timer = scheduler.schedule(onTimerElapsed, currentDelayMs());
  }

  /**
   * True when the item after `index` is `text`. The two then form a chain
   * that advances on text holds alone: loop completion and the video `ended`
   * event gate nothing while it lasts (docs/content-format.md, "Timing").
   */
  function nextIsText(index: number): boolean {
    return items[index + 1]?.type === "text";
  }

  /**
   * The `minPlaySeconds` chain-exit floor still owed (docs/plan.md Phase 15),
   * in ms measured from when the current timer was armed — the same anchor
   * `setSettings()` re-arms against, so elapsed time always counts toward the
   * floor and a settings change can neither reset nor shorten it twice. The
   * floor exists only when the item under the cursor is the LAST of a video's
   * text chain: a `text` item whose next item is not `text`, whose chain head
   * (the nearest earlier media item) is a video with the field. A floor
   * already owed nothing — the chain started long enough ago — is 0, and the
   * hold is exactly what it was before the field existed.
   */
  function chainExitFloorMs(): number {
    if (chainHeadAt === null) return 0;
    const item = items[cursor];
    if (item?.type !== "text" || nextIsText(cursor)) return 0;
    const head = items[visualIndexFor(items, cursor)];
    if (head.type !== "video" || head.minPlaySeconds === undefined) return 0;
    return Math.max(
      0,
      head.minPlaySeconds * 1000 - (timerArmedAt - chainHeadAt),
    );
  }

  /**
   * The chain-head instant for arriving at `index` (Phase 15): a media item
   * that starts a text chain stamps the chain's start; leaving any chain
   * clears it; a `text` item entered by a plain forward step KEEPS the
   * chain's existing start. Any other arrival at a `text` item — wheel,
   * `goTo()`, an `e` landing, a route entry — re-bases to now: the machine-time
   * of the original chain start is unknowable across re-entry, and a fresh
   * measurement may only wait LONGER than the original floor, never
   * shorter — acceptable and documented (the floor concerns forward auto
   * play).
   */
  function chainHeadMarkFor(index: number, keepsChain: boolean): number | null {
    if (items[index]?.type === "text") {
      return keepsChain ? chainHeadAt : Date.now();
    }
    return nextIsText(index) ? Date.now() : null;
  }

  /** Fresh view of the item under the cursor. */
  function beginItem(): void {
    settled = false;
    holdElapsed = false;
    endedCount = 0; // every cursor change starts the video's loops afresh
    armTimer();
  }

  /** The marking rule: shown now, so seen from now on. */
  function markShown(index: number): void {
    visited.add(index);
    if (index > highestSeen) highestSeen = index;
  }

  /** The screen under the cursor as a history entry (a copy). */
  function currentEntry(decision?: number): Entry {
    return {
      index: cursor,
      stack: stack.map((frame) => ({ ...frame })),
      ...(decision === undefined ? {} : { decision }),
    };
  }

  /** Appends an entry as the last one, dropping the oldest past the cap. */
  function pushEntry(entry: Entry): void {
    historyExport = null;
    history.push(entry);
    if (history.length > HISTORY_CAP) {
      history.splice(0, history.length - HISTORY_CAP);
    }
    pos = history.length - 1;
  }

  /**
   * Reading showed `entry` (header, "Reading history"): the same screen as
   * the one on record stays put; from `pos < last` a screen equal to the
   * next recorded entry just advances `pos` (replay), and any other drops
   * the recorded future before it is appended (fork).
   */
  function recordRead(entry: Entry): void {
    if (pos >= 0 && sameEntry(history[pos], entry)) return;
    if (pos < history.length - 1) {
      if (sameEntry(history[pos + 1], entry)) {
        pos += 1;
        return;
      }
      history.length = pos + 1; // pushEntry drops the cached export
    }
    pushEntry(entry);
  }

  /**
   * A jump that is not reading (`goTo()`, a bookmark restore): its landing
   * is appended at the END of the record, keeping every recorded screen.
   */
  function recordJump(entry: Entry): void {
    pos = history.length - 1;
    if (pos >= 0 && sameEntry(history[pos], entry)) return;
    pushEntry(entry);
  }

  /**
   * Makes `index` the current item: record how it was reached, mark it shown,
   * record it in the history, restart its timing, and tell the listeners.
   * Every reading route to an item — forward advance, skip step, `choose()`,
   * a join, `goTo()` — comes through here, which is why showing and seeing
   * are the same moment (the header's marking rule). `kind` is the forward
   * step's `advance` or any other route's `nav` arrival (see
   * `TransitionKind`); `jump` marks the non-reading jumps (`goTo()`, a
   * restore), which append at the history's end instead of replaying or
   * forking it. A history replay (`showEntry`) does not come through here.
   */
  function showItem(index: number, kind: TransitionKind, jump = false): void {
    const keepsChain = index === cursor + 1 && chainHeadAt !== null;
    cursor = index;
    transition = kind;
    chainHeadAt = chainHeadMarkFor(index, keepsChain);
    markShown(index);
    if (jump) recordJump(currentEntry());
    else recordRead(currentEntry());
    beginItem();
    emit();
  }

  /**
   * Puts history entry `at` on screen without timing or emitting: the
   * cursor, the route frames it showed under, and — for a choice screen —
   * the overlay, with the CURRENT seen marks and return-row rule. Nothing
   * is answered or marked played.
   */
  function placeEntry(at: number): void {
    pos = at;
    const entry = history[at];
    stack.length = 0;
    stack.push(...entry.stack.map((frame) => ({ ...frame })));
    cursor = entry.index;
    transition = "nav";
    chainHeadAt = chainHeadMarkFor(cursor, false);
    markShown(cursor);
    pendingChoice =
      entry.decision === undefined
        ? null
        : {
            decision: entry.decision,
            continueOption: offersContinue(decisions[entry.decision]),
          };
  }

  /**
   * The wheel and `e`: show history entry `at` exactly (docs/plan.md,
   * "History rollback spec"). Skip mode ends; an item arrives unsettled
   * with its own hold, a choice screen settled and waiting for its pick.
   */
  function showEntry(at: number): void {
    skipping = false;
    placeEntry(at);
    if (pendingChoice === null) {
      beginItem();
    } else {
      settled = true;
      holdElapsed = false;
      endedCount = 0;
      cancelTimer();
    }
    emit();
  }

  /**
   * Whether the media half of the current item's gate is met. Only a
   * standalone video gates on media: a `holdSeconds` video is background and
   * time-driven only, a video under a `text` chain loops beneath the chain
   * ungated, and every other type has no media condition. A video without
   * `holdSeconds` completes when BOTH its time bound has elapsed (checked at
   * the timer) AND `endedCount` has reached `loopCount` (checked at each
   * `mediaEnded()`), whichever happens last. A settled item bypasses the gate
   * entirely — its wait ended on the reader's press or on a resume landing,
   * so ended counts are irrelevant to it.
   *
   * The ended half applies only while the renderer can actually report it.
   * Below the seen edge (`cursor < frontier - 1`) a NAV arrival shows a still
   * — the poster rule for scrubbing back over read content (
   * docs/content-format.md, "Timing"; `playbackModeFor` in render/visual.ts)
   * — and a still never plays, so no pass report can ever arrive: waiting for
   * one froze auto-advance on a navigated re-entry of a range video
   * (docs/plan.md Phase 16, "Auto-forward stall at part-012"). There the gate
   * is the time bound alone, and that bound IS the full replay of the plan —
   * `videoGateMs` sums the first pass and every loop pass exactly as forward
   * play does — so an item entered by navigation (wheel, `goTo()`, `e`, a
   * restore) becomes eligible when its plan's replay time has elapsed, the
   * same shape an image completes on. A forward ADVANCE below the edge does
   * play the clip and does report its passes; leaving the bound as the whole
   * gate there is what makes auto pacing match playback whether or not the
   * element managed to play. At the seen edge the visual plays on a fresh
   * entry and reports its passes, and the ended count gates there as always.
   */
  function mediaGateSatisfied(): boolean {
    const item = items[cursor];
    if (item.type !== "video") return true;
    if (item.holdSeconds !== undefined || nextIsText(cursor)) return true;
    // Below the edge the bound paces the item alone: a nav arrival never
    // plays, and an advance's replay lasts exactly this long anyway.
    if (cursor < Math.min(highestSeen + 1, count) - 1) return true;
    return endedCount >= videoLoops(item);
  }

  function onHoldElapsed(): void {
    holdElapsed = true;
    // The time half of the gate has elapsed; a video auto-advances only when
    // its ended count has reached `loopCount` too (docs/content-format.md,
    // "Timing").
    if (!mediaGateSatisfied()) return;
    moveForward();
  }

  /**
   * Leave the item under the cursor for the next one, unless a decision
   * fires here or the current route span ends here. Both are forward
   * settle-points, so they come before the plain step (docs/plan.md
   * Phase 13).
   */
  function moveForward(): void {
    if (count === 0 || destroyed) return;
    if (fireDecision()) return;
    if (atRouteEnd()) {
      handleRouteEnd();
      return;
    }
    if (cursor >= count - 1) {
      // Nothing unseen ahead: the shown item is simply settled.
      settled = true;
      emit();
      return;
    }
    showItem(cursor + 1, "advance");
  }

  /**
   * Skip-mode dwell elapsed. One fixed-dwell step forward: a media item
   * followed by `text`, and each `text` line of a chain, each consume
   * exactly one dwell (chains are never collapsed). A decision reached is
   * NOT auto-resolved any more: its overlay opens and the burst ends
   * (docs/plan.md Phase 16) — only `playAllRoutes` still flows through.
   * The mode ends when
   * the step moves onto content the reader has not seen with `skipAll` off,
   * or when nothing unseen is left to visit; the ending item is then shown
   * normally, its auto-advance armed per its own hold.
   */
  function skipTick(): void {
    if (destroyed || count === 0) return;
    if (skipWouldReveal()) {
      exitSkip(); // stop ON the last seen item (docs/plan.md Phase 18)
      emit();
      return;
    }
    if (fireDecision()) return;
    if (atRouteEnd()) {
      handleRouteEnd();
      return;
    }
    if (cursor >= count - 1) {
      // Dwell elapsed on the last item; nothing is left to skip.
      skipping = false;
      beginItem();
      emit();
      return;
    }
    const next = cursor + 1;
    if (!visited.has(next) && !settings.skipAll) {
      // Never reveal (docs/plan.md Phase 18): stop ON the last seen item,
      // which plays from here under its own normal hold.
      exitSkip();
      emit();
      return;
    }
    // Stepping onto the last seen item before the frontier ends the burst
    // there: the item is shown under its normal hold, never a dwell.
    if (next >= count - 1 || (!settings.skipAll && !visited.has(next + 1))) {
      skipping = false;
    }
    // A dwell step is a fast traverse, not a read: it arrives as nav, and the
    // burst ends at the seen edge (or on the last item), so the item it hands
    // back to normal timing plays either way.
    showItem(next, "nav"); // arms a dwell if skipping, else the item's normal hold
  }

  /**
   * Whether skip's next forward step would SHOW an unseen item with
   * `skipAll` off (docs/plan.md Phase 18): a continuing route's end joining
   * at an unseen `continueAt`, or a plain step onto an unseen item. A
   * decision here opens its overlay instead (no reveal), and a re-offer
   * reveals nothing either.
   */
  function skipWouldReveal(): boolean {
    if (settings.skipAll) return false;
    if (relevantDecision(cursor) >= 0) return false;
    if (atRouteEnd()) {
      const frame = stack[stack.length - 1];
      const decision = decisions[frame.decision];
      if (!decision.routes[frame.route].continuing) return false;
      return decision.continueAt >= 0 && !visited.has(decision.continueAt);
    }
    return cursor + 1 < count && !visited.has(cursor + 1);
  }

  /** Leave skip mode; the current item restarts under its normal hold. */
  function exitSkip(): void {
    skipping = false;
    beginItem();
  }

  /** Routes played so far of one decision, creating the set on demand. */
  function playedOf(decisionIndex: number): Set<number> {
    let set = played.get(decisionIndex);
    if (set === undefined) {
      set = new Set<number>();
      played.set(decisionIndex, set);
    }
    return set;
  }

  /**
   * The route row's seen mark (docs/plan.md Phase 16, Branches): the route was
   * PLAYED — `enterRoute` put the reader inside it, from `choose()` or a
   * play-all auto-pick. Deliberately NOT `visited` ∩ span: a bookmark or a
   * restored position can land inside a span the reader never chose, which
   * would then read as a route the reader took — exactly what the Phase 16
   * report rules out. `visited` stays the source for ITEM marks (skip,
   * bookmarks, the frontier resume); the row mark is play.
   */
  function isPlayed(decisionIndex: number, routeIdx: number): boolean {
    return played.get(decisionIndex)?.has(routeIdx) === true;
  }

  /** Routes completed so far of one decision, creating the set on demand. */
  function completedOf(decisionIndex: number): Set<number> {
    let set = completed.get(decisionIndex);
    if (set === undefined) {
      set = new Set<number>();
      completed.set(decisionIndex, set);
    }
    return set;
  }

  /**
   * The route `playAllRoutes` picks next: the first not-yet-played route in
   * manifest order, with the continuing route held last so the alternates
   * each get their play before the story leaves the decision (docs/plan.md
   * Phase 13). -1 when every route has played.
   */
  function nextAutoRoute(decision: ResolvedDecision): number {
    for (let index = 0; index < decision.routes.length; index += 1) {
      if (
        index !== decision.continuingRoute &&
        !isPlayed(decision.index, index)
      )
        return index;
    }
    if (
      decision.continuingRoute >= 0 &&
      !isPlayed(decision.index, decision.continuingRoute)
    ) {
      return decision.continuingRoute;
    }
    return -1;
  }

  /** Marks the route played, pushes its frame, and enters its first item. */
  function enterRoute(decision: ResolvedDecision, routeIdx: number): void {
    playedOf(decision.index).add(routeIdx);
    stack.push({ decision: decision.index, route: routeIdx });
    showItem(decision.routes[routeIdx].startIndex, "nav");
  }

  /**
   * The decision hanging off the item at `index`, considering only the ones
   * inside the current route span: with no open frame a top-level decision,
   * otherwise a child of the open decision whose own route contains the
   * item. The forward settle asks it (`fireDecision`), as does skip's
   * reveal check.
   */
  function relevantDecision(index: number): number {
    const candidates = byAfter.get(index);
    if (candidates === undefined) return -1;
    const frame = stack[stack.length - 1];
    for (const candidate of candidates) {
      const decision = decisions[candidate];
      if (frame === undefined) {
        if (decision.parent < 0) return decision.index;
        continue;
      }
      // Inside an open route, two decisions are candidates: one the route
      // contains, and the decision the reader is inside re-asked at its own
      // `after` item — backing into `after` and pressing forward again
      // re-fires the overlay (docs/content-format.md, "Branches").
      const route = decisions[frame.decision].routes[frame.route];
      const inside =
        decision.parent === frame.decision &&
        index >= route.startIndex &&
        index <= route.endIndex;
      if (inside || decision.index === frame.decision) return decision.index;
    }
    return -1;
  }

  /**
   * Drops the open frames of a decision being answered now, and every frame
   * inside them: re-opening a decision (its `after` settled again) abandons
   * the route context the reader navigated out of, so answering it cannot
   * leave a stale frame to pop later.
   */
  function closeFramesFor(decisionIndex: number): void {
    for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
      if (stack[depth].decision === decisionIndex) {
        stack.length = depth;
        return;
      }
    }
  }

  /**
   * Whether an open view of this decision offers "Return to main route"
   * (docs/plan.md Phase 18, Branches): only once the decision's CONTINUING
   * route has been COMPLETED at least once — played through to its route end,
   * not merely entered. A continuation the reader has not reached the end of
   * is not a place to "return" to: from a re-offer they should pick the
   * continuing route to advance, and finishing it once opens the row on
   * every later re-opening and history replay. A decision with no continuing route
   * is never offered one (unchanged).
   */
  function offersContinue(decision: ResolvedDecision): boolean {
    if (decision.continuingRoute < 0) return false;
    return (
      completed.get(decision.index)?.has(decision.continuingRoute) === true
    );
  }

  /**
   * Shows the overlay for a decision, records it in the history, and
   * pauses: the item under the cursor is complete (`settled`), nothing is
   * pending but the reader's pick, and skip mode ends — an overlay is not
   * something to skip past.
   */
  function openChoice(decisionIndex: number): void {
    closeFramesFor(decisionIndex);
    const decision = decisions[decisionIndex];
    pendingChoice = {
      decision: decisionIndex,
      continueOption: offersContinue(decision),
    };
    // An overlay opening is a screen shown while reading: recorded.
    recordRead(currentEntry(decisionIndex));
    // A skip burst pauses at a decision (docs/plan.md Phase 16): the overlay
    // ends the burst, and the pick never restarts it — the reader answers in
    // manual mode from here (a skip burst never auto-resumes).
    skipping = false;
    settled = true;
    cancelTimer();
    emit();
  }

  /**
   * The forward settle of a decision's `after` item. Returns true when a
   * decision did fire, so the caller does not move the cursor: the choice
   * pauses (ending any skip burst — docs/plan.md Phase 16), or
   * `playAllRoutes` resolves the decision in play order and lands on the
   * route's first item.
   */
  function fireDecision(): boolean {
    const index = relevantDecision(cursor);
    if (index < 0) return false;
    const decision = decisions[index];
    if (closeIfPureAndComplete(decision)) return true;
    if (settings.playAllRoutes) {
      autoResolve(decision);
      return true;
    }
    openChoice(decision.index);
    return true;
  }

  /**
   * Answers a decision with no reader: the first route not yet played (the
   * continuing route last), else `continueAt`, else — for a pure-choice
   * decision whose every route has played — the all-played close below.
   */
  function autoResolve(decision: ResolvedDecision): void {
    closeFramesFor(decision.index);
    const routeIdx = nextAutoRoute(decision);
    if (routeIdx >= 0) {
      enterRoute(decision, routeIdx);
      return;
    }
    if (decision.continueAt >= 0) {
      showItem(decision.continueAt, "nav");
      return;
    }
    closeIfPureAndComplete(decision);
  }

  /**
   * The all-played rule for a pure-choice decision (docs/plan.md Phase 13):
   * once every route of a decision WITHOUT `continuingRoute` has played, the
   * decision CLOSES — it never re-opens — and author flow continues after the
   * whole menu region: max route end + 1, the Ren'Py fall-through, never
   * inside another route's span (the routes tile the region, so a re-arrival
   * at `after` with all played resumes past every route, not at `after` + 1).
   * Beyond the last item the story ends as before. Returns true when the
   * decision closed, so the caller neither pauses nor re-offers.
   */
  function closeIfPureAndComplete(decision: ResolvedDecision): boolean {
    if (decision.continuingRoute >= 0 || nextAutoRoute(decision) >= 0)
      return false;
    closeFramesFor(decision.index);
    const next = regionEnd(decision) + 1;
    if (next >= count) {
      settled = true;
      skipping = false;
      emit();
      return true;
    }
    showItem(next, "nav");
    return true;
  }

  /** True when the cursor is on the last item of the innermost open route. */
  function atRouteEnd(): boolean {
    const frame = stack[stack.length - 1];
    if (frame === undefined) return false;
    return cursor === decisions[frame.decision].routes[frame.route].endIndex;
  }

  /**
   * A forward advance off a route's last item (docs/content-format.md,
   * "Branches"): the route is COMPLETED — recorded in the `completed` set —
   * then pop the frame, and by the route's kind — the continuing route
   * proceeds to `continueAt` (its own completion is recorded right here, at
   * the join); any other route re-opens the decision, and that re-offer
   * includes "return to main route" only if the decision's CONTINUING route
   * has already completed (docs/plan.md Phase 18) — the route that just
   * finished opens the join only by being that route. A pure-choice decision
   * whose every route has now played does not re-open: it closes and flow
   * continues past the whole menu region (docs/plan.md Phase 13), ending the
   * story when the region runs to the last item.
   */
  function handleRouteEnd(): void {
    const frame = stack[stack.length - 1];
    const decision = decisions[frame.decision];
    const route = decision.routes[frame.route];
    completedOf(decision.index).add(frame.route);
    if (closeIfPureAndComplete(decision)) return;
    stack.pop();
    if (route.continuing) {
      showItem(decision.continueAt, "nav");
      return;
    }
    // The same pause as `fireDecision`: a skip burst stops at this re-offer
    // too (docs/plan.md Phase 16); only `playAllRoutes` auto-resolves.
    if (settings.playAllRoutes) {
      const next = nextAutoRoute(decision);
      if (next >= 0) {
        startInterstitial(decision, frame.route, next);
        return;
      }
      autoResolve(decision);
      return;
    }
    openChoice(decision.index);
  }

  /**
   * One wheel notch through the history (`direction` -1 back, +1 forward),
   * clamped to the record. Decision (docs/plan.md Phase 4): a step during
   * skip exits skip mode AND performs the step; a clamped step still ends
   * skip, and the item left behind gets its normal timing.
   */
  function stepHistory(direction: -1 | 1): void {
    const target = pos + direction;
    if (target < 0 || target >= history.length) {
      if (skipping) {
        exitSkip();
        emit();
      }
      return;
    }
    showEntry(target);
  }

  /** Sorted view of the seen set: what persistence stores. */
  function visitedSorted(): number[] {
    return [...visited].sort((a, b) => a - b);
  }

  /**
   * Restores a stored context: seen set, played and completed routes, open
   * stack, and the cursor at `lastShown` — everything but the history
   * (`restoreHistory`). Indices outside this manifest are dropped — a save
   * made against different content must degrade to playing, not to a cursor
   * off the end. The seen edge comes back with the seen set: `highestSeen`
   * is the restored maximum, not the landing item — otherwise a resumed
   * reader would find the wheel's forward ceiling (and the persisted
   * frontier) shrunk down to wherever the reading happened to sit.
   */
  function applyContext(context: MachineContext): void {
    visited.clear();
    let seenMax = -1;
    for (const index of context.visited ?? []) {
      const value = asIndex(index, -1);
      if (value >= 0 && value < count) {
        visited.add(value);
        if (value > seenMax) seenMax = value;
      }
    }
    highestSeen = seenMax;
    played.clear();
    for (const entry of context.playedRoutes ?? []) {
      const decisionIndex = asIndex(entry?.decision, -1);
      if (decisionIndex < 0 || decisionIndex >= decisions.length) continue;
      for (const routeIdx of entry.routes ?? []) {
        const value = asIndex(routeIdx, -1);
        if (value >= 0 && value < decisions[decisionIndex].routes.length) {
          playedOf(decisionIndex).add(value);
        }
      }
    }
    // Completed routes restore with the same validation. The field is newer
    // than the rest of the context: a legacy save carries none, and its
    // known played routes say nothing about completions — so the restore
    // treats NOTHING as completed (the conservative reading: the return row
    // just stays hidden until the reader finishes the continuing route once,
    // rather than offering a return to an end they may never have reached).
    completed.clear();
    for (const entry of context.completedRoutes ?? []) {
      const decisionIndex = asIndex(entry?.decision, -1);
      if (decisionIndex < 0 || decisionIndex >= decisions.length) continue;
      for (const routeIdx of entry.routes ?? []) {
        const value = asIndex(routeIdx, -1);
        if (value >= 0 && value < decisions[decisionIndex].routes.length) {
          completedOf(decisionIndex).add(value);
        }
      }
    }
    stack.length = 0;
    for (const frame of context.stack ?? []) {
      const decisionIndex = asIndex(frame?.decision, -1);
      const routeIdx = asIndex(frame?.route, -1);
      if (decisionIndex < 0 || decisionIndex >= decisions.length) continue;
      if (routeIdx < 0 || routeIdx >= decisions[decisionIndex].routes.length) {
        continue;
      }
      stack.push({ decision: decisionIndex, route: routeIdx });
    }
    pendingChoice = null;
    cursor = clamp(asIndex(context.lastShown, 0), 0, count - 1);
    // The landing item is shown, so it counts as seen.
    markShown(cursor);
  }

  /** A stored history entry checked against this manifest; null if foreign. */
  function validEntry(raw: HistoryEntry | undefined): Entry | null {
    if (typeof raw !== "object" || raw === null) return null;
    const index = asIndex(raw.index, -1);
    if (index < 0 || index >= count) return null;
    const entryStack: Frame[] = [];
    for (const frame of Array.isArray(raw.stack) ? raw.stack : []) {
      const decision = asIndex(frame?.decision, -1);
      const route = asIndex(frame?.route, -1);
      if (decision < 0 || decision >= decisions.length) return null;
      if (route < 0 || route >= decisions[decision].routes.length) return null;
      entryStack.push({ decision, route });
    }
    if (raw.decision === undefined) return { index, stack: entryStack };
    const decision = asIndex(raw.decision, -1);
    if (decision < 0 || decision >= decisions.length) return null;
    return { index, stack: entryStack, decision };
  }

  /**
   * The resume half of a stored context (docs/plan.md, "History rollback
   * spec"): its history, checked entry by entry (a foreign entry is
   * dropped) and capped, with the entry at `historyPos` (default: the
   * last) put on screen. A context without a usable history — every save
   * written before the history existed — starts a one-entry history at its
   * `lastShown` landing, under its stored stack.
   */
  function restoreHistory(context: MachineContext): void {
    historyExport = null;
    history.length = 0;
    pos = -1;
    const stored = Array.isArray(context.history) ? context.history : [];
    for (const raw of stored.slice(-HISTORY_CAP)) {
      const entry = validEntry(raw);
      if (entry !== null) history.push(entry);
    }
    if (history.length === 0) {
      pushEntry(currentEntry());
      return;
    }
    const last = history.length - 1;
    placeEntry(clamp(asIndex(context.historyPos, last), 0, last));
  }

  /** The history as JSON-safe context data (cached until it changes). */
  function exportHistory(): readonly HistoryEntry[] {
    if (historyExport !== null) return historyExport;
    historyExport = Object.freeze(
      history.map((entry) =>
        Object.freeze({
          index: entry.index,
          stack: Object.freeze(
            entry.stack.map(
              (frame): ContextFrame =>
                Object.freeze({ decision: frame.decision, route: frame.route }),
            ),
          ),
          ...(entry.decision === undefined ? {} : { decision: entry.decision }),
        }),
      ),
    );
    return historyExport;
  }

  return {
    getState() {
      return state;
    },

    visualIndex() {
      return visualIndexFor(items, cursor);
    },

    visitedList() {
      return visitedSorted();
    },

    exportContext() {
      const routeSets = (map: Map<number, Set<number>>) =>
        [...map.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([decision, routes]) =>
            Object.freeze({
              decision,
              routes: Object.freeze([...routes].sort((a, b) => a - b)),
            }),
          );
      return Object.freeze({
        lastShown: cursor,
        visited: visitedSorted(),
        stack: Object.freeze(
          stack.map((frame) =>
            Object.freeze({ decision: frame.decision, route: frame.route }),
          ),
        ),
        playedRoutes: Object.freeze(routeSets(played)),
        // The Phase 18 completion tracking: which routes were played through
        // to their end. Exported alongside `playedRoutes` even when empty —
        // an ABSENT field (a save written before this shape) restores
        // conservatively: nothing reads as completed, so the return row stays
        // hidden until the continuing route is finished once in the new
        // session.
        completedRoutes: Object.freeze(routeSets(completed)),
        history: exportHistory(),
        historyPos: pos,
      });
    },

    importContext(context) {
      if (destroyed || count === 0) return;
      if (interstitialTimer !== null) scheduler.cancel(interstitialTimer);
      interstitialTimer = null;
      interstitial = null;
      applyContext(context);
      skipping = false; // a restore is manual navigation, like `goTo()`
      // UNSETTLED arrival: the item replays under its hold. A jump: the
      // landing is appended to this session's history.
      showItem(cursor, "nav", true);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    advance() {
      if (destroyed || count === 0) return;
      if (finishInterstitial()) return; // a press ends the hold early
      // Only the choice's own inputs answer it, a replayed one included.
      if (pendingChoice !== null) return;
      if (skipPlaysVideo()) {
        // Space while skip plays a video (`skipPlaysVideos`, docs/plan.md
        // Phase 18) aborts the video and the burst carries on: the dwell
        // elapses now, so the step is skip's own (never-reveal included).
        cancelTimer();
        skipTick();
        return;
      }
      if (skipping) {
        // Space during skip exits skip mode AND stops on the current item:
        // exiting leaves it unset, and this press settles it in place
        // (the reader meant "stop here", not "step past this one"). In
        // auto-forward the stop also returns to manual (docs/plan.md Phase
        // 18), so the next press steps instead of only turning auto off.
        autoAdvance = false;
        exitSkip();
        settled = true;
        cancelTimer();
        if (fireDecision()) return;
        emit();
        return;
      }
      if (autoAdvance) {
        // Space during auto-forward returns to manual (docs/plan.md Phase
        // 18): auto turns off and the reader stays on this item — the press
        // does not also step, the next one does (the manual rule below).
        // The item keeps its settled state; only the pending hold goes.
        autoAdvance = false;
        cancelTimer();
        return; // nothing observable moved: no emit
      }
      // Immediate-complete (docs/plan.md Phase 16): one press = one step.
      // The press marks the item done and falls through to moveForward(),
      // which fires any decision before stepping.
      if (!settled) {
        settled = true;
        cancelTimer();
      }
      moveForward();
    },

    wheelBack() {
      if (destroyed) return;
      finishInterstitial(); // navigation is never trapped: enter, then move
      stepHistory(-1);
    },

    wheelForward() {
      if (destroyed) return;
      finishInterstitial(); // navigation is never trapped: enter, then move
      stepHistory(1);
    },

    toggleSkip() {
      if (destroyed || count === 0 || pendingChoice !== null) return;
      if (interstitial !== null) return; // the hold is not skippable content
      if (skipping) {
        exitSkip(); // tab again: manual off, normal timing from here
      } else {
        // Nothing seen ahead (a fresh start, or standing on the last seen
        // item): skip would only reveal, so the press does nothing.
        if (skipWouldReveal()) return;
        skipping = true;
        beginItem(); // the current item gets a fresh dwell too
      }
      emit();
    },

    jumpToEnd() {
      if (destroyed || count === 0) return;
      finishInterstitial();
      const last = history.length - 1;
      if (pos >= last) return; // already at the end: nothing to do
      showEntry(last);
    },

    goTo(index) {
      if (destroyed || count === 0) return;
      finishInterstitial();
      if (pendingChoice !== null) return; // a choice owns the timeline
      // A bookmark always points at content the reader had reached, but the
      // list outlives the moment it was written, so clamp defensively to
      // seen content `[0, highestSeen]`: unseen items must be entered by
      // advance() or choose() rather than consumed by a jump. (The cursor
      // may move either way — backward, or forward back to the edge of what
      // has been shown.) The landing is appended to the history's end.
      skipping = false; // manual navigation ends skip mode
      showItem(clamp(index, 0, Math.max(0, highestSeen)), "nav", true);
    },

    choose(routeIdx) {
      if (destroyed || count === 0 || pendingChoice === null) return;
      const decision = decisions[pendingChoice.decision];
      if (!Number.isInteger(routeIdx) || routeIdx < 0) return;
      if (routeIdx >= decision.routes.length) return;
      pendingChoice = null;
      // The answered decision's open frames close first — a no-op after a
      // fired open, but it keeps a re-entry into the reader's own route
      // from double-pushing the frame.
      closeFramesFor(decision.index);
      // A skip burst never restarts here: the pause at a decision ended it
      // and the pick belongs to manual reading (docs/plan.md Phase 16).
      enterRoute(decision, routeIdx);
    },

    chooseContinue() {
      if (destroyed || count === 0) return;
      const pending = pendingChoice;
      if (pending === null || !pending.continueOption) return;
      const decision = decisions[pending.decision];
      if (decision.continueAt < 0) return;
      pendingChoice = null;
      // Joining the aftermath replays none of the continuing route's items,
      // so the route is not marked played by this.
      showItem(decision.continueAt, "nav");
    },

    mediaEnded() {
      // During skip a video never plays (the renderer shows the poster), so
      // media-end events are irrelevant; guard against a straggler.
      if (destroyed || count === 0 || settled || skipping) return;
      const item = items[cursor];
      if (item.type !== "video") return;
      // A background (`holdSeconds`) video and a video under a text chain
      // loop freely: their `ended` events gate nothing, so they are dropped
      // rather than counted.
      if (item.holdSeconds !== undefined || nextIsText(cursor)) return;
      endedCount += 1;
      // A pass completed while the help screen is up is counted but does
      // not move: the machine is frozen, and resume() re-arms the wait
      // for this item (Phase 13b).
      if (holdElapsed && mediaGateSatisfied() && !paused) moveForward();
    },

    setSettings(next) {
      const wasSkipVideo = skipPlaysVideo();
      settings = { ...next }; // caller keeps owning its object
      if (destroyed || count === 0) return;
      // `skipVideo` is derived from the settings: tell the renderer when a
      // toggle mid-burst starts or stops the video under the cursor.
      if (skipPlaysVideo() !== wasSkipVideo) emit();
      // Only a live auto-advance is re-timed; a settled item (or one
      // waiting on a video's `ended`) owns no timer to re-arm. The new
      // delay is measured from when this item's timer was armed, so the
      // time already shown counts toward the new total.
      if (timer === null) return;
      const remainingMs = Math.max(
        0,
        currentDelayMs() - (Date.now() - timerArmedAt),
      );
      cancelTimer();
      timer = scheduler.schedule(onTimerElapsed, remainingMs);
    },

    setAutoAdvance(on) {
      autoAdvance = on;
      if (destroyed || count === 0 || paused) return;
      if (on) {
        // Arm the current item's full hold from now; skip's dwell is
        // already running, and a settled item waits for a press in
        // either mode.
        if (!settled && !skipping) armTimer();
      } else if (!skipping) {
        cancelTimer(); // manual: no pending hold; skip's dwell keeps running
      }
    },

    isAutoAdvance() {
      return autoAdvance;
    },

    pause() {
      if (destroyed) return;
      paused = true;
      cancelTimer();
      if (interstitialTimer !== null) scheduler.cancel(interstitialTimer);
      interstitialTimer = null;
    },

    resume() {
      if (destroyed || !paused) return;
      paused = false;
      if (interstitial !== null) armInterstitial(); // the hold restarts fresh
      if (!settled) armTimer(); // the wait restarts fresh (interface docs)
    },

    destroy() {
      destroyed = true;
      cancelTimer();
      if (interstitialTimer !== null) scheduler.cancel(interstitialTimer);
      interstitialTimer = null;
      listeners.clear();
    },
  };
}
