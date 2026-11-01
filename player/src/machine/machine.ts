// Timeline state machine core (docs/plan.md Phases 3-4, 13). Pure TypeScript:
// no DOM, no imports beyond ./types. Commands in, state out; time enters
// through an injected Scheduler so tests are deterministic.
//
// Seen set (Phase 13): `visited` is the set of item indices that have been
// SHOWN, and it is the source of truth for "seen". MARKING RULE — an item is
// marked the moment it becomes current, by whatever route to it: a forward
// advance, a skip step, a route entered by `choose()`, an `e`-jump landing, a
// wheel step or a `goTo()` bookmark click. (Marking on wheel/`goTo` arrival
// cannot change a linear manifest: without branches the wheel and bookmarks
// only ever move onto already-shown items, so a linear novel behaves exactly as
// before, when "shown" was the single frontier's `1 + highest index ever
// shown`.) Seeing a decision marks nothing: its routes are ordinary items.
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
// (`MachineState.choice`, answered by `choose()` / `chooseContinue()`, and
// inert to every other command while it is open) or, with
// `settings.playAllRoutes`, resolves itself to the first not-yet-played route
// in manifest order — the continuing route last — and past the decision once
// every route has played. Navigation onto an unresolved decision's `after`
// item (wheel, `goTo()`, the `e` jump) SHOWS that decision instead of
// passing it invisibly (docs/plan.md Phase 16): `MachineState.choice` appears
// with `arrival: true`, timing pauses, and the decision is NOT consumed —
// navigating away just closes the overlay, and a pick from it chooses exactly
// like a fired decision. A stack of open decision contexts
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

import type {
  Branch,
  ChoiceRoute,
  ChoiceView,
  Item,
  MachineContext,
  MachineSettings,
  MachineState,
  RouteResult,
  Scheduler,
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
   * resume: the seen set, the open decision stack, the routes already
   * played, and `lastShown` — the item shown most recently, which is where
   * the load starts. Like the frontier resume that landing counts as
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
   * Route-play context for persistence: `lastShown`, `visitedList()`, the
   * open decision stack and the routes played per decision, all JSON-safe.
   * `importContext()` (or `MachineOptions.resumeContext`) restores it.
   */
  exportContext(): MachineContext;
  /**
   * Replaces the seen set, decision stack and played routes with a stored
   * context and shows its `lastShown` item — the bookmark-restore move: the
   * arrival is UNSETTLED, like `goTo()`, and it fires no decision.
   */
  importContext(context: MachineContext): void;
  /** Receives every state change; returns an unsubscribe function. */
  subscribe(listener: (state: MachineState) => void): () => void;
  /**
   * Space press. In MANUAL mode — the player's start — one press is one
   * step: the current item's wait ends AND the cursor moves on the same
   * press (docs/plan.md Phase 16, "one action means one step"). In
   * AUTO-forward the press ends the current item's wait where it stands and
   * the next press moves on; auto's own hold-then-advance timer path is
   * untouched. During skip mode the press stops the burst ON the item under
   * the cursor — the reader meant this one — so it settles without moving.
   * Settling the item a decision hangs off is what fires that decision.
   * Inert while a choice is open: only `choose()` and `chooseContinue()`
   * answer it. Over an ARRIVAL-open choice (`choice.arrival`) the press
   * drops the arrival view and lands as the plain press on the same item —
   * the settle-and-move that FIRES the decision, never a step past it.
   */
  advance(): void;
  /**
   * Wheel step back; clamps at item 0. During skip mode, exits skip mode
   * and still performs the step. Entering an item this way is pure
   * navigation: it marks it shown but CONSUMES no decision — landing on an
   * unresolved decision's `after` item opens its arrival view
   * (`choice.arrival`), and stepping away from one closes it without
   * touching the stack.
   */
  wheelBack(): void;
  /**
   * Wheel step forward; never passes the highest item ever shown (so it can
   * reach a seen item of another route, which is where a branched novel's
   * back-and-forth stays sensible), and never enters unseen content. During
   * skip mode, exits skip mode and steps when allowed. A step never consumes
   * a decision, and the arrival is unsettled, like `goTo()` — except that
   * landing on an unresolved decision's `after` item opens its arrival view
   * (`choice.arrival`), and stepping away closes it, stack unchanged.
   */
  wheelForward(): void;
  /**
   * Tab press: toggles skip mode. While on, every item advances after
   * `settings.skipDwellMs` regardless of text/animation/video; media never
   * gates. With `settings.skipAll` off the mode ends when the cursor moves
   * onto the first never-shown item (shown normally afterward); with it on
   * the mode continues through unseen items, marking them seen, and ends
   * when nothing unseen is left to visit. A decision reached during a skip
   * STOPS the burst: the choice opens (`skipping` ends) and the reader
   * picks — the pick never auto-resumes skipping (docs/plan.md Phase 16).
   * Only `settings.playAllRoutes` auto-resolves inside a skip instead.
   */
  toggleSkip(): void;
  /**
   * `e` press: the first UNSEEN item along the path — (a) in the current
   * route span at or after the cursor, else (b) in an unplayed route of a
   * decision on the stack (innermost first) or of the decision that fires
   * next along it, else (c) the first unseen item of the manifest in array
   * order. The landing is a fresh entry: the item is shown and marked seen,
   * its own hold is armed, and skip mode ends. No-op when nothing is unseen
   * or the cursor is already on the target; a further press steps on to the
   * next unseen item. Like the wheel and `goTo()`: a jump onto an unresolved
   * decision's `after` item opens its arrival view, and a jump away from one
   * closes it, stack unchanged.
   */
  jumpToUnseen(): void;
  /**
   * Bookmark click (the `t` overlay, README `t` bullet): move the cursor to
   * `index`, clamped to `[0, highest index ever shown]`. Nothing unseen is
   * entered — unseen items are reached by `advance()`, `choose()` or
   * `jumpToUnseen()` — and no decision is consumed; landing on an
   * unresolved decision's `after` item opens its arrival view
   * (`choice.arrival`), and a jump away from one closes it. The arrival is
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
   * timing armed. Inert when no choice is open or the index is out of range.
   */
  choose(routeIdx: number): void;
  /**
   * "Return to main route" on a completed `return` route: proceed to the
   * decision's `continueAt`. Inert unless the open choice offers it
   * (`MachineState.choice.continueOption`), and it does not mark the
   * continuing route played — its items are skipped, not replayed.
   */
  chooseContinue(): void;
  /**
   * Pass-complete report for the current video item: the file's `ended`, or
   * a report at `endSeconds` when a playback range bounds it. It increments
   * the item's ended count, which must reach `loopCount` — alongside the
   * time bound — before a standalone video completes. Ignored when the item has
   * `holdSeconds` (a background video loops freely and never gates), while a
   * `text` item follows, during skip mode, and once the item is settled.
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
interface ResolvedRoute {
  id: string;
  label: string;
  startIndex: number;
  endIndex: number;
  result: RouteResult;
  /** True for the decision's `continuingRoute`, whose `result` is moot. */
  continuing: boolean;
}

/** A decision with its item references resolved to indices. */
interface ResolvedDecision {
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
  /**
   * True when a navigation ARRIVAL onto the decision's `after` item opened
   * the overlay (docs/plan.md Phase 16) rather than a forward settle
   * firing it: the decision is unconsumed — navigating away closes the
   * view and changes no stack.
   */
  arrival?: boolean;
}

/**
 * Resolves the branch table to item indices (docs/content-format.md,
 * "Branches"). The validator has already checked the table; an unresolvable
 * item id, an inverted span or a continuing route without `continueAt` drops
 * that one decision rather than guessing, so the manifest still plays.
 */
function resolveDecisions(
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

  const listeners = new Set<Listener>();
  let cursor = 0;
  /** Every item index shown so far, in any route (the seen set). */
  const visited = new Set<number>();
  /** `max(visited)`, -1 when nothing has been shown: the wheel's ceiling. */
  let highestSeen = -1;
  /** The item shown most recently: where the next load starts. */
  let lastShown = 0;
  let settled = false;
  /** Open decision contexts, outermost first — the nesting stack. */
  const stack: Frame[] = [];
  /** Which route indices of each decision have been played, by decision. */
  const played = new Map<number, Set<number>>();
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
  let destroyed = false;
  // Start position. A stored context is authoritative: its `lastShown` is
  // where the reader left off. Otherwise a persisted frontier marks a seen
  // prefix, and the load starts on its last shown item. With neither, this is
  // the first-ever load: item 0, shown, so the frontier is one past it.
  if (count > 0) {
    if (options.resumeContext !== undefined) {
      applyContext(options.resumeContext);
      settled = true; // a resume landing was already read, as with a frontier
    } else if (options.resumeFrontier !== undefined) {
      const frontier = clamp(options.resumeFrontier, 1, count);
      for (let index = 0; index < frontier; index += 1) visited.add(index);
      highestSeen = frontier - 1;
      lastShown = frontier - 1;
      cursor = frontier - 1;
      settled = true;
    } else {
      markShown(0);
    }
  }
  // The start position is an arrival like any other (Phase 15): a chain
  // entered at start — resumed or fresh — measures its floor from now.
  if (count > 0) chainHeadAt = chainHeadMarkFor(cursor, false);
  let state: MachineState = snapshot();
  // The item shown at start: auto mode arms its hold; manual mode (the
  // player's start, Phase 13b) waits for the reader instead.
  armTimer();

  function snapshot(): MachineState {
    const choice = pendingChoice === null ? null : choiceView(pendingChoice);
    const frontier = highestSeen < 0 ? 0 : Math.min(highestSeen + 1, count);
    return Object.freeze(
      choice === null
        ? { cursor, frontier, settled, skipping }
        : { cursor, frontier, settled, skipping, choice },
    );
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
      ...(pending.arrival === true ? { arrival: true } : {}),
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
      const item = items[cursor];
      if (item.type === "video") {
        return Math.min(settings.skipDwellMs, videoGateMs(item));
      }
      return settings.skipDwellMs;
    }
    return Math.max(
      itemHoldMs(items[cursor], settings, nextIsText(cursor)),
      chainExitFloorMs(),
    );
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
   * `goTo()`, an `e`-jump, a route entry — re-bases to now: the machine-time
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
    lastShown = index;
  }

  /**
   * Makes `index` the current item: mark it shown, restart its timing, and
   * tell the listeners. Every route to an item — forward advance, skip step,
   * `choose()`, `e`-jump, wheel, `goTo()` — comes through here, which is why
   * showing and seeing are the same moment (the header's marking rule).
   */
  function showItem(index: number): void {
    const keepsChain = index === cursor + 1 && chainHeadAt !== null;
    cursor = index;
    chainHeadAt = chainHeadMarkFor(index, keepsChain);
    markShown(index);
    beginItem();
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
   */
  function mediaGateSatisfied(): boolean {
    const item = items[cursor];
    if (item.type !== "video") return true;
    if (item.holdSeconds !== undefined || nextIsText(cursor)) return true;
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
    showItem(cursor + 1);
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
    if ((!visited.has(next) && !settings.skipAll) || next >= count - 1) {
      skipping = false;
    }
    showItem(next); // arms a dwell if skipping, else the item's normal hold
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

  function isPlayed(decisionIndex: number, routeIdx: number): boolean {
    return played.get(decisionIndex)?.has(routeIdx) === true;
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
    showItem(decision.routes[routeIdx].startIndex);
  }

  /**
   * The decision hanging off the item at `index`, considering only the ones
   * inside the current route span: with no open frame a top-level decision,
   * otherwise a child of the open decision whose own route contains the
   * item. The forward settle asks it firing (it consumes the answer); a
   * navigation arrival asks it showing (arrival view, `choice.arrival`,
   * unconsumed) — the same condition either way.
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
   * Shows the overlay for a decision and pauses: the item under the cursor is
   * complete (`settled`), nothing is pending but the reader's pick, and skip
   * mode ends — an overlay is not something to skip past.
   */
  function openChoice(decisionIndex: number, continueOption: boolean): void {
    closeFramesFor(decisionIndex);
    pendingChoice = { decision: decisionIndex, continueOption };
    // A skip burst pauses at a decision (docs/plan.md Phase 16): the overlay
    // ends the burst, and the pick never restarts it — the reader answers in
    // manual mode from here (a skip burst never auto-resumes).
    skipping = false;
    settled = true;
    cancelTimer();
    emit();
  }

  /**
   * Whether a navigation arrival at the cursor should SHOW a decision
   * (docs/plan.md Phase 16): the same condition the forward settle fires
   * on, minus consumption — the decision must exist here and still have an
   * offer (a pure decision whose every route has played closes on fire
   * rather than pausing, so an arrival shows nothing for it either).
   * `playAllRoutes` is the no-stop path: the reader asked for zero
   * interactivity, so nothing opens and the hold keeps its old auto path.
   */
  function arrivalDecision(): number {
    if (settings.playAllRoutes || pendingChoice !== null) return -1;
    const index = relevantDecision(cursor);
    if (index < 0) return -1;
    const decision = decisions[index];
    if (decision.continuingRoute < 0 && nextAutoRoute(decision) < 0) return -1;
    return index;
  }

  /**
   * A navigation arrival landed on an unresolved decision's `after` item:
   * show the decision without consuming it. Pauses timing — the cursor
   * marks the item settled and the pending timer is cancelled. The timer
   * proof (docs/plan.md Phase 16): a manual arrival arms none at all
   * (`armTimer` returns while `!skipping && !autoAdvance`, and every
   * navigation command clears `skipping` before the step), so this cancel
   * is the whole pause; and no timer that later elapses on this item can
   * pass through it either, because leaving it goes through `moveForward`
   * → `fireDecision`, which fires the decision instead of stepping.
   * Navigation away closes the view (`dismissArrivalChoice`); the stack is
   * untouched — `closeFramesFor` is deliberately NOT called here, unlike a
   * fired `openChoice`.
   */
  function openArrivalChoice(decisionIndex: number): void {
    pendingChoice = {
      decision: decisionIndex,
      continueOption: false,
      arrival: true,
    };
    settled = true;
    cancelTimer();
    emit();
  }

  /**
   * Navigation closes an arrival-open view — the reader is leaving, not
   * answering — and returns true when it did, so the caller can emit even
   * when the cursor cannot move. A fired choice is left untouched: it owns
   * the timeline until answered.
   */
  function dismissArrivalChoice(): boolean {
    if (pendingChoice?.arrival !== true) return false;
    pendingChoice = null;
    return true;
  }

  /**
   * Navigation commands call this after `showItem`: open the arrival view
   * for the decision hanging off the new cursor, if any.
   */
  function openArrivalChoiceIfDue(): void {
    const index = arrivalDecision();
    if (index >= 0) openArrivalChoice(index);
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
    openChoice(decision.index, false);
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
      showItem(decision.continueAt);
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
    showItem(next);
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
   * "Branches"): pop the frame, then by the route's kind — the continuing
   * route proceeds to `continueAt`; a `return` route re-opens the decision
   * with "return to main route" among its offers; an `ending` route re-opens
   * it for reselection only. A pure-choice decision whose every route has
   * now played does not re-open: it closes and flow continues past the whole
   * menu region (docs/plan.md Phase 13), ending the story when the region
   * runs to the last item.
   */
  function handleRouteEnd(): void {
    const frame = stack[stack.length - 1];
    const decision = decisions[frame.decision];
    const route = decision.routes[frame.route];
    if (closeIfPureAndComplete(decision)) return;
    stack.pop();
    if (route.continuing) {
      showItem(decision.continueAt);
      return;
    }
    // The same pause as `fireDecision`: a skip burst stops at this re-offer
    // too (docs/plan.md Phase 16); only `playAllRoutes` auto-resolves.
    if (settings.playAllRoutes) {
      autoResolve(decision);
      return;
    }
    openChoice(
      decision.index,
      route.result === "return" && decision.continuingRoute >= 0,
    );
  }

  /** The last item of the current route span, or content end when none. */
  function currentSpanEnd(): number {
    const frame = stack[stack.length - 1];
    if (frame === undefined) return count - 1;
    return decisions[frame.decision].routes[frame.route].endIndex;
  }

  /** The first item of `[from, to]` the reader has not seen; -1 for none. */
  function firstUnseen(from: number, to: number): number {
    const last = Math.min(to, count - 1);
    for (let index = Math.max(0, from); index <= last; index += 1) {
      if (!visited.has(index)) return index;
    }
    return -1;
  }

  /** The first unseen item inside a route of this decision not yet played. */
  function unseenInUnplayedRoute(decision: ResolvedDecision): number {
    for (let index = 0; index < decision.routes.length; index += 1) {
      if (isPlayed(decision.index, index)) continue;
      const route = decision.routes[index];
      const target = firstUnseen(route.startIndex, route.endIndex);
      if (target >= 0) return target;
    }
    return -1;
  }

  /**
   * The decision that fires next along the current path: the nearest one at
   * or after the cursor in the same context as the open frame (or at the top
   * level when no frame is open).
   */
  function nextDecisionAhead(from: number): number {
    const frame = stack[stack.length - 1];
    const wantParent = frame === undefined ? -1 : frame.decision;
    let found = -1;
    for (const decision of decisions) {
      if (decision.parent !== wantParent || decision.afterIndex < from)
        continue;
      if (found < 0 || decision.afterIndex < decisions[found].afterIndex) {
        found = decision.index;
      }
    }
    return found;
  }

  /**
   * The `e` target — the seen/jump rule of docs/plan.md Phase 13, stated
   * here once: (a) the first unseen item of the current route span at or
   * after the cursor, else (b) the first unseen item of an unplayed route of
   * a decision on the stack, innermost first, or of the decision that fires
   * next along the path, else (c) the first unseen item in array order.
   */
  function unseenTarget(): number {
    const inSpan = firstUnseen(cursor, currentSpanEnd());
    if (inSpan >= 0) return inSpan;
    for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
      const target = unseenInUnplayedRoute(decisions[stack[depth].decision]);
      if (target >= 0) return target;
    }
    const next = nextDecisionAhead(cursor);
    if (next >= 0) {
      const target = unseenInUnplayedRoute(decisions[next]);
      if (target >= 0) return target;
    }
    return firstUnseen(0, count - 1);
  }

  /** Sorted view of the seen set: what persistence stores. */
  function visitedSorted(): number[] {
    return [...visited].sort((a, b) => a - b);
  }

  /**
   * Restores a stored context: seen set, played routes, open stack, and the
   * cursor at `lastShown`. Indices outside this manifest are dropped — a save
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
    markShown(cursor); // the landing item is shown, so it counts as seen
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
      const playedRoutes = [...played.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([decision, routes]) =>
          Object.freeze({
            decision,
            routes: Object.freeze([...routes].sort((a, b) => a - b)),
          }),
        );
      return Object.freeze({
        lastShown,
        visited: visitedSorted(),
        stack: Object.freeze(
          stack.map((frame) =>
            Object.freeze({ decision: frame.decision, route: frame.route }),
          ),
        ),
        playedRoutes: Object.freeze(playedRoutes),
      });
    },

    importContext(context) {
      if (destroyed || count === 0) return;
      applyContext(context);
      skipping = false; // a restore is manual navigation, like `goTo()`
      showItem(cursor); // UNSETTLED arrival: the item replays under its hold
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    advance() {
      if (destroyed || count === 0) return;
      if (pendingChoice !== null) {
        if (pendingChoice.arrival !== true) return;
        // Space over an arrival-open view: the reader pressed on the item,
        // so the view yields to the plain press it would have been — the
        // settle-and-move below, which FIRES the decision (moveForward
        // reaches fireDecision) rather than stepping into the next item.
        pendingChoice = null;
      }
      if (skipping) {
        // Space during skip exits skip mode AND stops on the current item:
        // exiting leaves it unset, and this press settles it in place
        // (the reader meant "stop here", not "step past this one").
        exitSkip();
        settled = true;
        cancelTimer();
        if (fireDecision()) return;
        emit();
        return;
      }
      if (!settled) {
        // Immediate-complete: the item's wait ends now. AUTO mode keeps the
        // two-stage press — settle here, move on the next advance() — and
        // this settle is exactly the forward settle a decision hangs off
        // (docs/plan.md Phase 13). MANUAL mode folds the settle into the
        // move (docs/plan.md Phase 16): one press = one step, so the same
        // press marks the item done and falls through to moveForward(),
        // which fires any decision before stepping.
        settled = true;
        cancelTimer();
        if (autoAdvance) {
          if (fireDecision()) return;
          emit();
          return;
        }
      }
      moveForward();
    },

    wheelBack() {
      if (destroyed) return;
      // An arrival-open choice closes on this step (navigation away); a
      // fired one owns the timeline and swallows it.
      const closedArrival = dismissArrivalChoice();
      if (pendingChoice !== null) return;
      // Decision (docs/plan.md Phase 4): a wheel step during skip exits skip
      // mode AND performs the step — the step is what the user
      // meant; merely dropping it would feel like a dead input.
      const wasSkipping = skipping;
      if (skipping) skipping = false; // a clamped step exits skip too
      if (cursor === 0) {
        if (wasSkipping) beginItem(); // normal timing for the item left behind
        if (wasSkipping || closedArrival) emit();
        return;
      }
      showItem(cursor - 1); // pure nav: shown, seen; no decision consumed
      openArrivalChoiceIfDue();
    },

    wheelForward() {
      if (destroyed) return;
      const closedArrival = dismissArrivalChoice();
      if (pendingChoice !== null) return;
      const wasSkipping = skipping;
      if (skipping) skipping = false; // same decision as wheelBack()
      // The ceiling is the highest item ever shown, which across routes is
      // the union of everything seen — so a forward step can reach a seen
      // item of another route, and entering it is navigation, not a choice.
      if (cursor + 1 > highestSeen) {
        if (wasSkipping) beginItem(); // blocked step still ends skip
        if (wasSkipping || closedArrival) emit();
        return;
      }
      showItem(cursor + 1);
      openArrivalChoiceIfDue();
    },

    toggleSkip() {
      if (destroyed || count === 0 || pendingChoice !== null) return;
      if (skipping) {
        exitSkip(); // tab again: manual off, normal timing from here
      } else {
        skipping = true;
        beginItem(); // the current item gets a fresh dwell too
      }
      emit();
    },

    jumpToUnseen() {
      if (destroyed || count === 0) return;
      const closedArrival = dismissArrivalChoice();
      if (pendingChoice !== null) return; // a fired choice owns the timeline
      const target = unseenTarget();
      if (target < 0 || target === cursor) {
        if (closedArrival) emit(); // nothing to jump to: the view just closed
        return;
      }
      skipping = false; // a jump is manual navigation: skip mode is off
      showItem(target); // fresh entry: seen now, its own hold armed
      openArrivalChoiceIfDue();
    },

    goTo(index) {
      if (destroyed || count === 0) return;
      dismissArrivalChoice(); // navigation away closes an arrival view
      if (pendingChoice !== null) return; // a fired choice owns the timeline
      // Bookmark navigation is navigation too: landing on an unresolved
      // decision's `after` item opens its arrival view, leaving closes it.
      // A bookmark always points at content the reader had reached, but the
      // list outlives the moment it was written, so clamp defensively to
      // seen content `[0, highestSeen]`: unseen items must be entered by
      // advance(), choose() or jumpToUnseen() rather than consumed by a
      // jump. (The cursor may move either way — backward, or forward back
      // to the edge of what has been shown.)
      skipping = false; // like jumpToUnseen: manual navigation ends skip mode
      showItem(clamp(index, 0, Math.max(0, highestSeen)));
      openArrivalChoiceIfDue();
    },

    choose(routeIdx) {
      if (destroyed || count === 0 || pendingChoice === null) return;
      const decision = decisions[pendingChoice.decision];
      if (!Number.isInteger(routeIdx) || routeIdx < 0) return;
      if (routeIdx >= decision.routes.length) return;
      pendingChoice = null;
      // From an arrival-open view this chooses exactly like a fired decision
      // (docs/plan.md Phase 16): the answered decision's open frames close
      // first — a no-op after a fired open, but it keeps a re-entry into the
      // reader's own route from double-pushing the frame.
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
      showItem(decision.continueAt);
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
      settings = { ...next }; // caller keeps owning its object
      if (destroyed || count === 0) return;
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
    },

    resume() {
      if (destroyed || !paused) return;
      paused = false;
      if (!settled) armTimer(); // the wait restarts fresh (interface docs)
    },

    destroy() {
      destroyed = true;
      cancelTimer();
      listeners.clear();
    },
  };
}
