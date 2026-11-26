// Timeline state machine core (docs/plan.md Phases 3-4, 13). Pure TypeScript:
// no DOM, no imports beyond ./types, ./choicetext and ./sound. Commands in,
// state out; time enters through an injected Scheduler so tests are
// deterministic.
//
// Seen set (Phase 13): `visited` is the set of item indices that have been
// SHOWN, and it is the source of truth for "seen". MARKING RULE — an item is
// marked the moment it becomes current, by whatever route to it: a forward
// advance, a skip step, a route entered by `choose()`, a `goTo()` bookmark
// click or a restore. The wheel and `e` mark nothing: they only ever show
// seen screens (the timeline below).
// Seeing a decision marks nothing: its routes are ordinary items. The route
// ROW's seen mark is a different, narrower thing than this set: it is
// `played` — the routes the reader was actually routed into (docs/plan.md
// Phase 16, Branches).
//
// Timeline (docs/plan.md Phase 27): the wheel walks the STORY ORDER, not a
// record of what was shown. A step goes to the neighbouring screen in the
// item array as the story flows: through a decision it follows the route
// LAST PICKED there (`lastPick`, persisted; with none known, the longest
// route holding seen content). A decision's choice screen is a step of its
// own, passed through like any screen and shown with the walk's route
// highlighted (`ChoiceView.walkRoute`); a returning route leads back to its
// choice screen and on along the continuing route; a continuing route's end
// joins at `continueAt`, as does a `continue` route's (whatever play-all's
// flow does there); an ending route's end stops the walk. A pure
// choice (no continuing route) closes past its menu region once every route
// has played, so each of its routes leads back to its choice screen and on
// past the region, whatever its `result`. Route frames are not stored per screen:
// an item's frames are its enclosing route spans (`framesAround`), which
// spans that nest or are disjoint make unique. The wheel shows only seen
// screens: forward, an unseen one stops it; back, it passes over unseen
// screens (content added since the reader passed, or skipped by a jump) to
// the nearest seen one, and stays when none lies behind; back through a
// join it follows the route last picked there whenever that route holds
// anything read, its end seen or not (docs/plan.md Phase 39). It marks
// nothing seen or played, answers nothing, and reading on from where it
// stopped simply continues from there.
// `e` goes to the furthest screen read in story order: the highest seen item,
// with its enclosing frames. The played-this-pass record (`passPlayed`,
// docs/plan.md Phase 22) rewinds with the walk: a walked-to screen shows the
// record as it stood when the walk began minus every decision at or after
// the screen (enclosing decisions keep theirs, plus the routes enclosing the
// screen), so reading on from before a decision plays its routes again. The
// cumulative `played` / `completed` records (seen marks, return row) never
// rewind.
//
// Transition kind (`MachineState.transition`): the same funnel that marks an
// item also records HOW it became current — `advance` for the forward step
// (a space press or the auto timer moving one item on) and for an item
// entered as new reading (a `u` landing, a URL start), `nav` for every other
// route to it (a wheel or `e` replay, a bookmark `goTo()` or restore, a
// route entry, a route-end join, skip's dwell step, and the load-time
// landing). Timing is identical either way; the renderer reads the kind with
// `cursor` and `frontier` so a re-read below the seen edge plays its video
// while scrubbing back over the same items holds posters
// (docs/content-format.md, "Timing").
//
// Arrival kind (`Machine.arrival`, docs/plan.md Phase 47): `showItem` and
// `showScreen`, the only ways the screen on show changes after the load,
// also record how the reader arrived, for the sound (`read`, `skip`, `walk`
// or `jump`), and number each arrival.
// The target sound (`Machine.targetSound`) resolves music and ambience back
// along the wheel's own path (`stepBack`); machine/sound.ts keeps the
// answers.
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
// (`MachineState.choice`, answered by `choose()` / `chooseContinue()`; space
// and bookmark jumps are inert while it is open, tab and `a` only switch
// their mode for after the answer, the wheel and `e` walk on and leave it)
// — with `settings.playAllRoutes` the choice
// answers itself on screen after a countdown, taking the shortest
// not-yet-played route (the continuing route last), and once every route
// has played the decision resolves past itself unshown. A stack of open decision contexts
// gives nesting: a route's end pops its frame, proceeds to `continueAt`, or
// re-opens that decision to offer the routes still unplayed. A pure-choice
// decision (no `continuingRoute`) whose every route has played does not
// re-open: it CLOSES and flow continues past the whole menu region — max
// route end + 1, the Ren'Py fall-through (docs/plan.md Phase 13).
//
// Skip mode (tab) paces by pictures (docs/plan.md Phase 18): a `text` item
// takes ZERO time — the renderer hides the caption while skipping — so one
// settings.skipDwellMs passes per picture or video still, regardless of
// media. Every line is still walked (shown, marked seen, checked against
// every stop rule), so a burst can stop ON a line,
// which then shows normally. With skip_all off it ends when the cursor moves onto the first
// never-shown item (which is then shown normally); with skip_all on it marks
// items seen as it shows them and ends when nothing unseen is left to visit.
// Inside a branched manifest a skip visits items in PLAY order, and it PAUSES
// at a decision (docs/plan.md Phase 16): reaching an unresolved decision's
// `after` item opens the choice and ends the burst — `skipAll` governs only
// unseen stops — and the pick does not resume it by itself (a skip burst
// never auto-resumes). `playAllRoutes` remains the no-stop path.
// Tab ON an open choice (docs/plan.md Phase 43) turns skip on without
// moving anything: the mode is ARMED (`skipArmed`) until the reader's
// answer, whose first shown item then starts the burst exactly as a Tab
// pressed there would — or, with nothing seen ahead and `skipAll` off or
// nothing ahead at all, turns the mode back off. Every real flip of the mode — the burst
// running or armed, versus neither — is reported once (`onSkipChange`).
// `skipPlaysVideos` (Phase 18) makes a burst play each video it reaches for
// the video's own time bound instead of one dwell; Space aborts it and the
// burst goes on.

import {
  AUTO_PICK_SHOW_MS,
  choiceCountdownMs,
  choiceRowCount,
  choiceScreenText,
} from "./choicetext";
import {
  ambienceOf,
  createSoundResolver,
  hasItemAudio,
  musicOf,
  SILENCE,
  type SoundResolver,
} from "./sound";
import { shownLength } from "./texttags";
import type {
  AnimationItem,
  Arrival,
  ArrivalKind,
  AudioTrack,
  AutoPickView,
  Branch,
  ChoiceRoute,
  ChoiceView,
  ContextFrame,
  EndCard,
  Item,
  MachineContext,
  MachinePlace,
  MachineSettings,
  MachineState,
  MachineWords,
  ManifestAudio,
  Route,
  RouteResult,
  RouteSet,
  Scheduler,
  SegmentView,
  TargetSound,
  TransitionKind,
  VideoItem,
  VideoSegment,
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
   * resume: the seen set, the open decision stack, the routes played,
   * completed and played this pass per decision, and the last pick at each
   * decision — the load starts on `lastShown` (with `choice`, that
   * decision's choice screen is up again, and play-all counts it down
   * again). A context predating `completedRoutes`
   * restores with nothing completed (see `MachineContext`): the conservative
   * reading, the return row simply stays hidden until the continuing route
   * is finished once. Like the frontier resume that landing counts as
   * settled, and arriving inside a route whose decision was never answered
   * fires nothing: decisions fire only on the forward settle of their
   * `after` item.
   */
  resumeContext?: MachineContext;
  /**
   * The item to open at for this load (`index.html#start=<id>`,
   * docs/plan.md Phase 46), in place of the resume landing. The restore
   * (`resumeContext`) brings everything else — the seen set, the routes
   * played, completed and played this pass, the last picks — and the item
   * is then entered as `jumpToUnseen()` enters its target: the open frames
   * become the item's enclosing route frames, each of those routes marked
   * played and made its decision's last pick, and the item is shown as a
   * forward read (seen, unsettled, its media playing). A stored open
   * choice is not reopened, and nothing before the item is marked seen
   * (a first load does not see item 0). An index that is not a position
   * in `items` is ignored.
   */
  startAt?: number;
  /**
   * Auto-forward mode (docs/plan.md Phase 13b; docs/player.md, "Auto-forward"). ABSENT
   * OR FALSE means manual — the documented default: no hold timer is
   * armed, items wait for `advance()` / the wheel / skip mode, and
   * nothing auto-advances until `setAutoAdvance(true)` (the `a` key).
   * True starts in auto-forward immediately.
   */
  autoAdvance?: boolean;
  /**
   * The manifest's sound (docs/content-format.md, "Audio"): the machine
   * reads only its tracks' lengths, for the voice hold
   * (`setVoiceAudible`). Absent: no item waits for a voice.
   */
  audio?: ManifestAudio;
  /** Defaults to the global setTimeout/clearTimeout. */
  scheduler?: Scheduler;
  /**
   * The words the reader is shown (docs/plan.md Phase 56 item 3): the
   * text holds and a choice screen's prompt, labels and countdown read
   * them. Absent: the manifest's own.
   */
  words?: MachineWords;
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
   * across every route visited (docs/plan.md Phase 13); `MachineState.
   * frontier` is the derived legacy value. Its cost grows with the set:
   * a save on every screen change takes the set's growth instead
   * (`seenSince`, docs/plan.md Phase 46).
   */
  visitedList(): number[];
  /**
   * Route-play context (an export file, a bookmark restore's merge, the
   * map's marks): `lastShown` (the item on screen),
   * `visitedList()`, the open decision stack, the routes played, completed
   * and played this pass per decision, the last pick at each decision, and
   * the open choice screen's decision — all JSON-safe.
   * `MachineOptions.resumeContext` restores all of it; `importContext()`
   * all but the open choice. It is in array
   * POSITIONS (item, resolved-decision and route indices); storage never
   * holds this form — `storage/ids.ts` converts it to the id-keyed save
   * and back against the manifest being played, so a content update
   * (a prequel, a new route, a reorder) keeps saves valid.
   */
  exportContext(): MachineContext;
  /**
   * `exportContext()` without `visited` (docs/plan.md Phase 46): what a
   * save on every screen change writes, and what a bookmark keeps. Its
   * cost is bounded by the manifest's decisions, not by how much has been
   * read; the seen set reaches storage as it grows (`seenSince`).
   */
  exportPlace(): MachinePlace;
  /**
   * The seen set's growth (docs/plan.md Phase 46): the item indices that
   * joined it from position `from` of its join log on, each once, in the
   * order they joined. A load's restored set is not logged — only what is
   * seen after it (the landing included when the restored set lacked it)
   * and what a restore (`importContext`) adds. A caller keeps its own
   * position and moves it on by the length returned, so each save hands
   * storage just the newly seen items.
   */
  seenSince(from: number): readonly number[];
  /**
   * The bookmark-restore move: replaces the seen set, decision stack,
   * played, completed and played-this-pass routes and last picks with a
   * stored context (an absent `passRoutes` reads as its `playedRoutes`) and
   * shows its `lastShown` item; a stored `choice` is not reopened. The
   * arrival is UNSETTLED, like `goTo()`, and fires no decision. Like
   * `exportContext()` it takes positions: a bookmark's id-keyed context is
   * converted by `storage/ids.ts` first.
   */
  importContext(context: MachineContext): void;
  /** Receives every state change; returns an unsubscribe function. */
  subscribe(listener: (state: MachineState) => void): () => void;
  /**
   * How the reader reached the screen on show (`ArrivalKind`; docs/plan.md
   * Phase 47, item 4): `read`, `skip`, `walk` or `jump`, and its number.
   * The number grows by one on every arrival, also at the same item again,
   * and stays on a re-emit (a settle, a choice opening, a skip or settings
   * flip), so a subscriber compares it to tell an arrival from a re-emit.
   * The object is the same until the next arrival. Not in `MachineState`,
   * whose shape stays as it was.
   */
  arrival(): Arrival;
  /**
   * What should sound on the screen on show (`TargetSound`;
   * docs/content-format.md, "What plays at an item"), computed when asked
   * and kept for the arrival (the same object until the next one), so a
   * subscriber that ignores skip arrivals costs nothing during a burst.
   *
   * - `music` and `ambience`, each separately: the value set by the
   *   nearest item at or before the item on show, following the story back
   *   along the path the wheel walks (through the route last picked at each
   *   decision, over unseen items too); silence when nothing sets it back
   *   to the start. So a route's first item inherits from its decision's
   *   `after` item, a join from the route last picked there, and an item
   *   setting both pins them.
   * - `voice`: the item on show's own voice line.
   * - `videoSound`: the soundtrack of the video the screen shows
   *   (`visualIndex()`), on the video item and its text chain.
   *
   * A choice screen, play-all's countdown and the end card stand over an
   * item and give that item's target: a choice opened by reading, or the
   * end card, is no arrival and changes nothing. A manifest whose items
   * carry no `audio` gets the silent target and builds nothing for sound.
   */
  targetSound(): TargetSound;
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
   * Where the story ends the press settles the item and moves nothing: the
   * last item, and a route's last item once a pure choice's menu has
   * closed there (docs/plan.md Phase 43; the next item belongs to another
   * route, reached only through its decision).
   * Inert while a choice is open, a walked-to one included: only `choose()`
   * and `chooseContinue()` answer it — except that a play-all auto-pick on
   * the choice is taken at once, and as Space it stops skip: a mode armed
   * on that choice (`toggleSkip()`) or carried by a burst turns off rather
   * than running after the pick. From a screen the wheel walked to it
   * simply reads on from there.
   */
  advance(): void;
  /**
   * Right (docs/plan.md Phase 49, docs/content-format.md "Video segments"):
   * where a manual Space would step a video's segments — the last item of
   * its chain, its visual a video with `segments`, the stage playing it
   * (`setVideoClock`) — steps to the next segment exactly as Space does
   * (first one after the video's time, then by index), but never leaves
   * the item: on the last segment, or with no segment starting after the
   * time, it does nothing. Inert, with no emit, anywhere else, and in
   * auto-forward, skip, on an open choice or an auto-pick, where Space
   * never steps segments either (the arrows only step; they do not take
   * over Space's other jobs, such as turning auto-forward off).
   */
  segmentForward(): void;
  /**
   * Left: under the same conditions as `segmentForward()`, steps to the
   * previous segment — before any step, the one before the segment the
   * video's time is in (`startSeconds <= time < endSeconds`), or, with the
   * time in no segment, the last one starting before the time; after a
   * step, the one before the active segment. With none it does nothing.
   */
  segmentBack(): void;
  /**
   * Wheel step back one screen in STORY ORDER (docs/plan.md Phase 27; the
   * header's "Timeline"): an item with its enclosing route frames, or a
   * decision's choice screen with the walk's route highlighted
   * (`ChoiceView.walkRoute`), the current seen marks and the return-row
   * rule. Through a decision the walk follows the last pick there. A step
   * shows only seen screens (an unseen neighbour, or none, leaves the
   * position as it is), answers nothing, marks nothing seen or played, and
   * leaves any open choice. It puts back the played-this-pass record as of
   * the screen (docs/plan.md Phases 22, 27), so reading on from before a
   * decision plays its routes again. An item arrival is unsettled, like
   * `goTo()`. During skip mode, exits skip mode and still performs the
   * step.
   */
  wheelBack(): void;
  /**
   * Wheel step forward one screen in story order, stopping before an unseen
   * one, so it ends at the furthest point read; otherwise as `wheelBack()`.
   */
  wheelForward(): void;
  /**
   * Tab press: toggles skip mode. While on, every picture or video still
   * advances after `settings.skipDwellMs` regardless of animation/video,
   * and a `text` item after zero time (its caption hidden; docs/plan.md
   * Phase 18) — still shown, marked seen and recorded, so the burst can
   * stop ON a line; media never gates. With `settings.skipPlaysVideos` on,
   * a video instead plays its whole plan (its time bound, `videoGateMs`)
   * before the burst moves on through its chain's zero-time lines. With `settings.skipAll` off skip never reveals unseen content
   * (docs/plan.md Phase 18): the burst steps only onto seen items and ends
   * ON the last seen one before the frontier, which is then shown normally;
   * a press with nothing seen ahead does nothing at all, and so does a press
   * where the story ends (the last item, or a route's last item once a pure
   * choice's menu has closed there; docs/plan.md Phase 43). With it on
   * the mode continues through unseen items, marking them seen, and ends
   * when nothing unseen is left to visit. A decision reached during a skip
   * STOPS the burst: the choice opens (`skipping` ends) and the reader
   * picks — the pick never resumes the burst by itself (docs/plan.md Phase
   * 16). Only `settings.playAllRoutes` auto-resolves inside a skip instead:
   * the mode stays on over its auto-pick and runs on from the route entered.
   *
   * On an open choice (docs/plan.md Phase 43) the press moves nothing and
   * the choice stays open: it ARMS skip for after the answer, and a second
   * press disarms it. The answer — `choose()`, `chooseContinue()` or
   * play-all's elapsed auto-pick — then starts the burst on the first item
   * it shows, as if Tab were pressed just after it; with nothing seen ahead
   * there (and `skipAll` off), or where the story ends, the mode turns off
   * instead. An answer that
   * opens another choice keeps it armed for that one. Leaving the choice
   * unanswered (a wheel notch, even one with nowhere to go; `e`, `u`, a map
   * click, a restore) or Space taking a play-all auto-pick disarms it. `MachineState.skipping` stays false
   * while armed; `onSkipChange` reports the mode.
   */
  toggleSkip(): void;
  /**
   * `e` press: go to the furthest screen read in story order (docs/plan.md
   * Phase 27): the highest seen item, with its enclosing route frames,
   * arriving as a wheel step does. It moves only when reading passes it;
   * a no-op when already there. It finds no unseen content.
   */
  jumpToEnd(): void;
  /**
   * `u` press: go to the NEXT UNSEEN content wherever it is (docs/plan.md
   * Phase 18, "Reach unseen content from anywhere"). The target is the
   * first unseen item in array (reading) order after the cursor, wrapping
   * round to earlier content, among the items a reader could reach there:
   *
   * - Not the reader's own continuation: the unseen run a plain forward
   *   step would show next (Space reads it), nor the routes of an
   *   untouched decision the next step opens (the reader picks there).
   * - An item inside routes only when every enclosing decision's `after`
   *   item has been seen (the reader got to that decision).
   * - Not content behind an unpassed decision: past a decision's menu
   *   region (in the same enclosing route) while no route joining at its
   *   `continueAt` (the continuing route, or a `"continue"` one) has been
   *   completed, or for a pure choice, while a route is unplayed — the
   *   machine itself only flows there after that.
   *
   * The landing opens the target's enclosing route frames and marks those
   * routes PLAYED, exactly as if each had been picked, so a forward press
   * carries on inside the route and the route rows' seen marks agree. Skip
   * ends, any open choice is left, the landing's routes become the last
   * picks at their decisions, and it arrives unsettled as a forward read
   * (its media plays). A no-op when there is nowhere to go.
   */
  jumpToUnseen(): void;
  /**
   * Whether unseen content the reader passed over lies BEFORE the cursor
   * (the resume notice, docs/plan.md Phase 18): an item `jumpToUnseen()`
   * could reach, earlier in the array, and not inside a route the reader
   * declined (an unplayed route of a decision with another route played —
   * the end card counts those).
   */
  hasEarlierUnseen(): boolean;
  /**
   * Bookmark click (a card on the branch map; docs/player.md, "Bookmarks"): move the cursor to
   * `index`, clamped to `[0, highest index ever shown]`. Nothing unseen is
   * entered — unseen items are reached by `advance()` or `choose()` — and no
   * decision fires; the route stack is left as it is. Inert while a choice
   * is open. The arrival is
   * UNSETTLED, unlike a resume landing: a bookmark click "continues the
   * novel from that time point", so the item's text hold replays and
   * auto-advance carries the reader onward.
   */
  goTo(index: number): void;
  /**
   * Branch map click on a decision (docs/plan.md Phase 31): show decision
   * `decision`'s choice screen (a position in the resolved table) exactly
   * as a wheel step onto it would — its enclosing route frames, the walk's
   * route highlighted (the last pick there, else the longest seen route),
   * the current seen marks and return-row rule, the played-this-pass
   * record as of the screen. Nothing is marked seen or played and nothing
   * is answered; a pick from it is a real `choose()`. Inert unless the
   * decision's `after` item has been seen (the reader reached it).
   */
  showChoice(decision: number): void;
  /**
   * Decision overlay: pick route `routeIdx` (the index in
   * `MachineState.choice.routes`, so 1..9 minus one, or a pointer click).
   * The route is marked played, its frame is pushed for nesting, and its
   * first item is entered as a forward entry — shown, marked seen, its own
   * timing armed; it becomes the decision's last pick. From a choice screen
   * the wheel walked to this is the same real pick. Inert when no choice is
   * open or the index is out of range. Skip armed on the choice
   * (`toggleSkip()`) starts on the route's first item, or turns off when it
   * has nothing seen to run through; auto-forward, if on, arms that item's
   * hold as for any arrival. `source` `"map"` marks a branch-map route
   * click (render/mapmodel.ts `runJump`): the same pick, arriving as a
   * `jump` (`Machine.arrival`) where a pick on the choice screen is `read`.
   */
  choose(routeIdx: number, source?: "map"): void;
  /**
   * "Return to main route" on a decision whose CONTINUING route has
   * completed: proceed to the decision's `continueAt`. Inert unless the open
   * choice offers it (`MachineState.choice.continueOption`, which requires a
   * completed continuing route — docs/plan.md Phase 18), and it does not
   * mark the continuing route played — its items are skipped, not replayed.
   * An answer like `choose()`: armed skip starts on the item it lands on.
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
   * The stage's video clock (docs/plan.md Phase 49, "Video segments"): a
   * source the visual layer sets once it exists, returning the current
   * media time, in seconds, of the stage's video while the stage plays
   * the video of the item on show (a video a menu holds paused counts as
   * playing), and null while it shows a still (a `nav` arrival below the
   * seen edge, skip) or no video. Null or never set means no video plays.
   * `advance()` reads it on the last item of a video's chain whose item
   * has `segments`: a Space press there steps to the next segment
   * (`MachineState.segment`) instead of leaving while the stage plays the
   * video. Setting it changes no state.
   */
  setVideoClock(clock: (() => number | null) | null): void;
  /**
   * Settings on the Esc screen (docs/plan.md Phase 9; `c` is retired):
   * replace the pacing settings with a full snapshot; the machine copies
   * it and never reads storage.
   * Changes apply live, each where its setting takes effect:
   *
   * - `readingSpeed` (and `skipDwellMs`): a pending auto-advance is
   *   re-armed as if the new settings had held since the item began, so
   *   the time already shown counts toward the new total — a 2400 ms hold
   *   changed to a 1200 ms one at 500 ms fires 700 ms later. A new total
   *   already behind the elapsed time fires on the next tick. An item
   *   with no pending timer (manual mode, an open choice, a completed item
   *   with nothing after it, or one waiting on a video's `ended`) is not
   *   armed by this call. A pending `minPlaySeconds` chain-exit floor
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
   * Whether the reader hears voice lines (docs/plan.md Phase 47, item 5;
   * docs/content-format.md "Timing"): sound on, Voice above 0 and sound
   * unlocked, as the audio module (render/audio.ts) finds. While true, an
   * item's auto-forward hold lasts at least as long as its voice line, the
   * track's `durationSeconds` less its `startSeconds`; skip, manual mode
   * and a manifest without that track are untouched. False at
   * construction. A change re-times a pending hold as `setSettings` does,
   * from when the item's timer was armed.
   */
  setVoiceAudible(audible: boolean): void;
  /**
   * A new language shown (docs/plan.md Phase 56 item 3): the words the
   * holds and choice screens read (`MachineOptions.words`; null for the
   * manifest's own). The state is emitted again, so an open choice redraws
   * its prompt and labels, and a pending hold re-times as `setSettings`
   * does, from when the item's timer was armed. Nothing else moves: the
   * position, picks, seen set and auto-forward stay.
   */
  setWords(words: MachineWords | null): void;
  /**
   * A spoken line's hold (docs/plan.md Phase 52; render/spoken.ts): while
   * the reader hears voice lines (`setVoiceAudible`), the auto-forward hold
   * of item `index` lasts at least until `untilMs`, a `Date.now()` time:
   * 20 s from arrival while its line is generated, then the line's own end
   * once it plays. Null clears it. A hold for an item other than the one
   * under the cursor counts for nothing; skip and manual mode are
   * untouched, as for a recorded voice. A change re-times a pending hold.
   */
  setSpokenHold(index: number, untilMs: number | null): void;
  /**
   * `a`: the auto-forward toggle (docs/plan.md Phase 13b, docs/player.md,
   * "Auto-forward"). Manual (off) is the player's start (main.ts constructs with
   * `autoAdvance: false`): nothing arms a hold timer, so items wait for
   * `advance()`, the wheel, or skip mode. Turning auto on arms what is
   * left of the current item's hold, measured from when the item first
   * appeared, so an item already up past its hold moves on at the next
   * tick. A settled item counts too (docs/plan.md Phase 43): a resume
   * landing, or the item Space stopped a skip burst on, moves on like any
   * other. Nothing arms while a choice is open (it waits for its answer —
   * turned on there, it runs from the first item the answer shows, whose
   * hold arms as for any arrival (docs/plan.md Phase 43); play-all's
   * auto-pick runs on its own timer) or on a settled item with
   * nothing after it (the last item, or a route's last item once its menu
   * has closed). Turning auto off cancels the pending hold. Skip mode is
   * unaffected either way — its dwell is the reader's own command and runs
   * in both modes.
   */
  setAutoAdvance(on: boolean): void;
  isAutoAdvance(): boolean;
  /**
   * Reports every real flip of the auto-forward mode (docs/plan.md Phase
   * 20): `a` either way, and the Space that stops auto (alone or ending a
   * skip burst). A repeat of the current mode reports nothing, and so do
   * construction (a load or resume), Tab, pause/resume, a choice and the
   * end — none of them changes the mode. Not a state change: subscribers
   * see nothing. Returns the unsubscribe; destroy() drops every listener.
   */
  onAutoAdvanceChange(listener: (on: boolean) => void): () => void;
  /**
   * Reports every real flip of skip mode (docs/plan.md Phase 43), the
   * twin of `onAutoAdvanceChange`: on when Tab starts a burst or arms one
   * on an open choice; off whenever neither is left — Tab again, Space, the
   * burst stopping (the last seen item, a choice, the end), the wheel, `e`,
   * `u`, a map click or a restore ending it, an armed answer with nothing
   * seen to run through, Space taking a play-all auto-pick. Each is
   * reported after the state change that makes it, once (the subscribers
   * have seen that state). A play-all choice a burst carries on through
   * reports nothing, nor do a Tab that does nothing (nothing seen ahead,
   * or where the story ends),
   * construction, pause/resume or a repeat. When Space stops a burst in
   * auto-forward the skip flip is reported before the auto-forward one.
   * Not a state change itself; returns the unsubscribe; destroy() drops
   * every listener.
   */
  onSkipChange(listener: (on: boolean) => void): () => void;
  /**
   * The key help's machine freeze (docs/plan.md Phase 13b): cancels the
   * pending timer — hold or skip dwell — and arms none while paused, so
   * the machine waits with no timers while the help screen is up.
   */
  pause(): void;
  /**
   * Ends `pause()`: the current item's hold re-arms FRESH (a skip dwell
   * too), like the other paused overlays — the wait restarts from the
   * moment of closing. In auto-forward that holds for a settled item too
   * (docs/plan.md Phase 43), with `setAutoAdvance`'s exceptions: an open
   * choice waits for its answer (a play-all countdown restarts its own
   * phase instead), and a settled item with nothing after it stays. In
   * manual mode a settled item still waits for the reader's press.
   */
  resume(): void;
  /** Cancels the pending timer and drops all subscribers. */
  destroy(): void;
}

export const defaultScheduler: Scheduler = {
  schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  cancel: (handle) => globalThis.clearTimeout(handle as never),
};

/**
 * Text hold in ms: max(minHold, codepoints(text) * msPerChar * factor /
 * speed), where `factor` is the reading-time factor of the language the
 * text is shown in (docs/content-format.md "Timing"; 1 for most) and the
 * code points are those shown, its text tags read (`shownLength`).
 */
export function textHoldMs(
  text: string | undefined,
  settings: MachineSettings,
  factor = 1,
): number {
  const chars = shownLength(text ?? "");
  if (chars === 0) return settings.minHoldMs;
  return Math.max(
    settings.minHoldMs,
    (chars * settings.msPerChar * factor) / settings.readingSpeed,
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
 * An animation's `frameSeconds` when they fit its frames, one finite number
 * above 0 per frame (docs/content-format.md, "Items"), else null: even
 * timing at `fps`. A folder the validator refuses plays at `fps`.
 */
export function animationFrameSeconds(
  item: Pick<AnimationItem, "frames" | "frameSeconds">,
): readonly number[] | null {
  const seconds = item.frameSeconds;
  if (!Array.isArray(seconds) || seconds.length !== item.frames.length) {
    return null;
  }
  return seconds.every(
    (s) => typeof s === "number" && Number.isFinite(s) && s > 0,
  )
    ? seconds
    : null;
}

/**
 * One loop of an animation, in ms (docs/content-format.md, "Timing"): the
 * sum of its `frameSeconds`, else `len(frames) / fps`.
 */
export function animationLoopMs(
  item: Pick<AnimationItem, "frames" | "fps" | "frameSeconds">,
): number {
  const seconds = animationFrameSeconds(item);
  if (seconds === null) return (item.frames.length * 1000) / item.fps;
  return seconds.reduce((sum, s) => sum + s * 1000, 0);
}

/**
 * The frame an animation shows as a still (rewind, skip, a `nav` arrival
 * below the seen edge): `frames[0]` on its own item, and on a `text` item
 * after it the last frame when it holds that (`holdLastFrame`,
 * docs/content-format.md "Text items"), else `frames[0]` too.
 */
export function animationStillFrame(
  item: Pick<AnimationItem, "frames" | "holdLastFrame">,
  onText: boolean,
): string {
  return onText && item.holdLastFrame === true
    ? item.frames[item.frames.length - 1]
    : item.frames[0];
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
  shown?: { readonly text: string | undefined; readonly factor: number },
): number {
  // The text as drawn, in its language (`MachineWords.itemText`), else
  // the manifest's.
  const hold =
    shown === undefined
      ? textHoldMs(item.text, settings)
      : textHoldMs(shown.text, settings, shown.factor);
  if (nextIsText) return hold;
  if (item.type === "animation") {
    return Math.max(hold, animationLoopMs(item) * item.loopCount);
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

/**
 * Whether a route's end leads on to its decision's `continueAt` in story
 * order: the continuing route, or a `"continue"` one (docs/content-format.md,
 * "Branches"). `resolveDecisions` keeps a `"continue"` route only on a
 * decision that has a `continueAt`. The timeline and the branch map draw
 * this; the flow off a `"continue"` route's end also asks play-all.
 */
export function joinsAtContinue(route: ResolvedRoute): boolean {
  return route.continuing || route.result === "continue";
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
  /**
   * The decision this one follows (`follows`, docs/content-format.md,
   * "Branches"), -1 for none: a table the validator would reject leaves
   * an ordinary decision, as an older player reads every one.
   */
  follows: number;
  /**
   * With `follows`: for each route of the followed decision, by position,
   * the route of this one that takes it (the one whose `when` names it,
   * else the `when`-less route), or -1 where none does and the decision
   * passes on to `continueAt`. Empty without `follows`.
   */
  takes: number[];
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
  /** The route whose end re-offered it, or -1 on a first fire. */
  via: number;
  /**
   * Present on a screen the wheel walked onto: the route the walk takes
   * from it (`ChoiceView.walkRoute`; -1 past a pure choice's region).
   */
  walk?: number;
}

/**
 * Resolves the branch table to item indices (docs/content-format.md,
 * "Branches"). The validator has already checked the table; an unresolvable
 * item id, an inverted span, a continuing route without `continueAt` or a
 * `"continue"` route on a decision without one (no join to continue to)
 * drops that one decision rather than guessing, so the manifest still plays.
 */
export function resolveDecisions(
  items: readonly Item[],
  branches: readonly Branch[],
): ResolvedDecision[] {
  const resolved: ResolvedDecision[] = [];
  /** The `branches` entry of each resolved decision, by position. */
  const sources: Branch[] = [];
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
      if (route.result === "continue" && continueAt < 0) sound = false;
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
      follows: -1,
      takes: [],
    });
    sources.push(branch);
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
  resolveFollows(resolved, sources);
  return resolved;
}

/**
 * Sets each decision's `follows` and `takes` from its entry's `follows` and
 * its routes' `when` (docs/content-format.md, "Branches"), where the table
 * is sound: the followed decision is another, earlier in array order (its
 * `after` first) and not one enclosing this decision; every `when` names
 * routes of it, no route twice; at most one route has no `when`; and a
 * followed route no route takes has a `continueAt` to pass on to. Anything
 * else leaves the decision ordinary.
 */
function resolveFollows(
  resolved: ResolvedDecision[],
  sources: readonly Branch[],
): void {
  const byId = new Map<string, number>();
  for (const decision of resolved) {
    if (!byId.has(decision.id)) byId.set(decision.id, decision.index);
  }
  resolved.forEach((decision, position) => {
    const named = sources[position].follows;
    if (typeof named !== "string") return;
    const followedIndex = byId.get(named);
    if (followedIndex === undefined) return;
    const followed = resolved[followedIndex];
    if (followed.afterIndex >= decision.afterIndex) return; // itself too
    for (
      let parent = decision.parent, depth = 0;
      parent >= 0 && depth < resolved.length;
      parent = resolved[parent].parent, depth += 1
    ) {
      if (parent === followed.index) return; // it encloses this decision
    }
    const takes = takesFor(followed, sources[position].routes);
    if (takes === null) return;
    if (takes.includes(-1) && decision.continueAt < 0) return;
    decision.follows = followed.index;
    decision.takes = takes;
  });
}

/**
 * For each route of `followed`, the route among `routes` that takes it; -1
 * where none does. Null when the `when` lists are unsound.
 */
function takesFor(
  followed: ResolvedDecision,
  routes: readonly Route[],
): number[] | null {
  const takes = followed.routes.map(() => -1);
  let rest = -1;
  for (let routeIdx = 0; routeIdx < routes.length; routeIdx += 1) {
    const when = routes[routeIdx].when;
    if (when === undefined) {
      if (rest >= 0) return null; // two routes without `when`
      rest = routeIdx;
      continue;
    }
    if (!Array.isArray(when) || when.length === 0) return null;
    for (const id of when) {
      const at = followed.routes.findIndex((route) => route.id === id);
      if (at < 0 || takes[at] >= 0) return null;
      takes[at] = routeIdx;
    }
  }
  return takes.map((routeIdx) => (routeIdx < 0 ? rest : routeIdx));
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

export {
  AUTO_PICK_MIN_MS,
  AUTO_PICK_SHOW_MS,
  CHOICE_BASE_MS,
  CHOICE_PER_ROW_MS,
  choiceCountdownMs,
} from "./choicetext";

/** Route sets by decision as sorted, frozen `RouteSet`s (empty sets left out). */
function routeSets(
  map: ReadonlyMap<number, ReadonlySet<number>>,
): readonly RouteSet[] {
  return Object.freeze(
    [...map.entries()]
      .filter(([, routes]) => routes.size > 0)
      .sort((a, b) => a[0] - b[0])
      .map(([decision, routes]) =>
        Object.freeze({
          decision,
          routes: Object.freeze([...routes].sort((a, b) => a - b)),
        }),
      ),
  );
}

/**
 * One screen of the timeline walk (docs/plan.md Phase 27): an item, or a
 * decision's choice screen. `next` is the route the walk takes from the
 * choice screen (-1: past a pure choice's menu region), `via` the
 * returning route whose end led back to it (-1: reached from `after`).
 */
type Screen =
  | { readonly kind: "item"; readonly index: number }
  | {
      readonly kind: "choice";
      readonly decision: number;
      readonly next: number;
      readonly via: number;
    };

function itemScreen(index: number): Screen {
  return { kind: "item", index };
}

/**
 * A step into an item from a route of a decision (the timeline's joins): a
 * route end, or a pure choice's screen past its menu region.
 */
interface Join {
  readonly from: Screen;
  readonly decision: number;
  readonly route: number;
}

/**
 * The arrival kind of a forward step (`ArrivalKind`): Space and auto-forward
 * `read`, a skip burst's dwell `skip`. The join or close the step reaches
 * arrives the same way.
 */
type Flow = "read" | "skip";

export function createMachine(options: MachineOptions): Machine {
  const { items } = options;
  // Copied, and copied again on every setSettings(): the caller keeps
  // owning the object it passed (main.ts persists it), and later mutation
  // of it cannot silently retime the timeline.
  let settings: MachineSettings = { ...options.settings };
  const scheduler = options.scheduler ?? defaultScheduler;
  /** The words shown (`setWords`); null for the manifest's own. */
  let words: MachineWords | null = options.words ?? null;
  /** A decision's prompt as drawn. */
  const promptOf = (decision: ResolvedDecision): string =>
    words === null
      ? decision.prompt
      : words.prompt(decision.id, decision.prompt);
  /** A route's label as drawn. */
  const labelOf = (decision: ResolvedDecision, route: ResolvedRoute): string =>
    words === null
      ? route.label
      : words.label(decision.id, route.id, route.label);
  /** The tracks a voice hold reads its length from. */
  const voiceTracks = options.audio?.tracks;
  /** Whether the reader hears voice lines (`setVoiceAudible`). */
  let voiceAudible = false;
  /** The spoken line's hold (`setSpokenHold`), null for none. */
  let spokenHold: { index: number; until: number } | null = null;
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
   * decision and the ends of a continuing route and of a `continue` route
   * rejoin the story, so none of them IS an ending.
   */
  const endings = new Set<number>();
  if (count > 0) endings.add(count - 1);
  for (const decision of decisions) {
    for (const route of decision.routes) {
      if (!route.continuing && route.result === "ending")
        endings.add(route.endIndex);
    }
  }
  /**
   * Every route's first and last item, and every decision's menu-region
   * end (`regionEnd`), for the unseen-content rules (`unseenTarget`).
   */
  const routeStarts = new Set<number>();
  const routeEnds = new Set<number>();
  for (const decision of decisions) {
    for (const route of decision.routes) {
      routeStarts.add(route.startIndex);
      routeEnds.add(route.endIndex);
    }
  }
  const regionEnds = decisions.map(regionEnd);
  /**
   * The decisions deepest first, so each nested decision comes before the
   * one holding it: the order a restore checks completions in (`reachedEnd`).
   */
  const innerFirst = [...decisions].sort((a, b) => depthOf(b) - depthOf(a));
  function depthOf(decision: ResolvedDecision): number {
    let depth = 0;
    for (
      let parent = decision.parent;
      parent >= 0 && depth < decisions.length;
      parent = decisions[parent].parent
    )
      depth += 1;
    return depth;
  }
  /**
   * The innermost route enclosing each item, or null at the top level.
   * Spans nest or are disjoint, so the narrowest span holding an item is
   * the innermost, and the frames around it chain outwards through each
   * decision's own `after` item (`framesAround`).
   */
  const innermost: (Frame | null)[] = new Array<Frame | null>(count).fill(null);
  {
    const width = new Array<number>(count).fill(Infinity);
    for (const decision of decisions) {
      decision.routes.forEach((route, routeIdx) => {
        const span = route.endIndex - route.startIndex;
        for (let i = route.startIndex; i <= route.endIndex; i += 1) {
          if (span < width[i]) {
            width[i] = span;
            innermost[i] = { decision: decision.index, route: routeIdx };
          }
        }
      });
    }
  }

  const listeners = new Set<Listener>();
  let cursor = 0;
  // The kind of the step that made `cursor` current. The start position is an
  // arrival like any other, not an advance — and it is at the seen edge, so
  // the renderer plays it either way.
  let transition: TransitionKind = "nav";
  /**
   * How the screen on show was reached, for the sound (`Machine.arrival`):
   * set by `showItem` and `showScreen`, the only arrivals after the load,
   * which is arrival 1, a jump.
   */
  let arrival: Arrival = Object.freeze({ kind: "jump", number: 1 });
  /** Every item index shown so far, in any route (the seen set). */
  const visited = new Set<number>();
  /**
   * The seen set's join log (docs/plan.md Phase 46, `seenSince`): each
   * index in the order it joined `visited` in this machine. A load's
   * restored set is not in it; a restore's additions are.
   */
  const seenLog: number[] = [];
  /** `max(visited)`, -1 when nothing has been shown: the wheel's ceiling. */
  let highestSeen = -1;
  /**
   * The route LAST PICKED at each decision (header, "Timeline"): a pick,
   * a play-all auto-pick or a `u` landing sets it; the wheel follows it.
   */
  const lastPick = new Map<number, number>();
  /**
   * The music and ambience resolver (machine/sound.ts), built on the first
   * `targetSound()` of a manifest whose items carry audio; null before
   * that and always without audio. It walks the wheel's own path back
   * (`stepBack`), so it forgets its answers when the inputs of that path
   * change: a last pick (`setLastPick`), a replaced seen set, a first sight
   * of an item (`markShown`).
   */
  let sound: SoundResolver | null = null;
  /** Whether any item carries audio: settled by the first `targetSound()`. */
  let audible: boolean | null = null;
  /** The target for the arrival it was resolved at. */
  let soundFor: { arrival: Arrival; target: TargetSound } | null = null;

  /**
   * The played-this-pass record as it stood when the current walk began
   * (the first wheel step or `e` since reading last moved), or null while
   * reading: each walked-to screen shows this record rewound to it
   * (`passAt`), so walking back and forth again loses nothing.
   */
  let passBase: readonly RouteSet[] | null = null;
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
  /**
   * The routes PLAYED THIS PASS, by decision (docs/plan.md Phase 22). `played`
   * and `completed` are cumulative — the rows' seen marks, the return row,
   * the end card and `u` — and never rewind. This record drives only the
   * route FLOW: play-all's next pick, whether a route end re-offers or a
   * pure menu closes (the all-played rule). It grows during forward play,
   * so a pass enters each route of a decision at most once under play-all,
   * and the wheel rewinds it to the screen walked to (`passAt`): reading on
   * from before a decision plays every route again, like the first time.
   */
  const passPlayed = new Map<number, Set<number>>();
  /** `passPlayed` as frozen `RouteSet`s, kept until it changes. */
  let passExport: readonly RouteSet[] | null = null;
  let pendingChoice: PendingChoice | null = null;
  let skipping = false;
  /**
   * Skip mode on while a choice is open (docs/plan.md Phase 43): Tab on the
   * choice, or a burst that a play-all choice carries on through. Nothing
   * runs until the answer; the first item the answer shows (`showItem`)
   * then starts the burst, or turns the mode off when it has nothing seen
   * to run through. Every way of leaving the choice unanswered clears it.
   */
  let skipArmed = false;
  /** The skip mode last reported to `onSkipChange` (off at construction). */
  let skipReported = false;
  const skipListeners = new Set<(on: boolean) => void>();
  let holdElapsed = false;
  /** `mediaEnded()` calls counted for the standalone video under the cursor. */
  let endedCount = 0;
  /**
   * The active segment of the video on screen, an index into its
   * `segments`, or null (docs/plan.md Phase 49): set by a segment step
   * (`showSegment`), cleared wherever `endedCount` restarts, so on every
   * arrival and on every fresh view of the item (skip on or off).
   */
  let segment: number | null = null;
  /** The stage's video clock (`Machine.setVideoClock`); null: none plays. */
  let videoClock: (() => number | null) | null = null;
  let timer: unknown = null;
  // When the timer now running was armed for the item under the cursor.
  // setSettings() re-arms from this instant, so the new settings act as
  // if they had held since the item began (the interface docs). Time
  // enters only through scheduler and Date.now, both fakeable in tests.
  let timerArmedAt = 0;
  // When the item under the cursor first appeared (`beginItem()`): the
  // anchor `a` measures from when it turns auto on (docs/plan.md Phase 20),
  // so the time already shown — help or settings time included, since a
  // pause does not move it — counts toward the item's hold. The start
  // item appears as the machine is built.
  let itemShownAt = Date.now();
  // When the media item that STARTED the current text chain became current
  // (the chain head), or null when the cursor is not inside such a chain:
  // the anchor for a video's `minPlaySeconds` chain-exit floor (Phase 15).
  // Like `timerArmedAt` it is a machine-time instant; the floor's remaining
  // time is derived from it, so a settings re-arm never resets the wait.
  let chainHeadAt: number | null = null;
  // Auto-forward mode (Phase 13b): absent/false is manual — the documented
  // default (docs/player.md, "Reading"): items wait for the reader until `a`.
  let autoAdvance = options.autoAdvance === true;
  const autoListeners = new Set<(on: boolean) => void>();
  // The one writer of `autoAdvance` after construction: a real flip tells
  // the `onAutoAdvanceChange` listeners (the auto-forward pill).
  function setAutoFlag(on: boolean): void {
    if (autoAdvance === on) return;
    autoAdvance = on;
    reportAuto(on);
  }
  function reportAuto(on: boolean): void {
    if (destroyed) return;
    for (const listener of [...autoListeners]) listener(on);
  }
  /**
   * Tells the `onSkipChange` listeners (the skip pill) when skip mode — a
   * burst running or armed on a choice — differs from what they last
   * heard. `emit()` calls it after its subscribers, so a flip is reported
   * once its state is out; the few flips that change no state (Tab on a
   * choice) call it themselves.
   */
  function reportSkip(): void {
    const on = skipping || skipArmed;
    if (on === skipReported || destroyed) return;
    skipReported = on;
    for (const listener of [...skipListeners]) listener(on);
  }
  // The help screen's freeze (Phase 13b): while paused nothing arms.
  let paused = false;
  // Skip's zero-time text steps (docs/plan.md Phase 18) run as a loop inside
  // `runSkip()` rather than as 0 ms timers: `skipStepping` marks that loop,
  // and `zeroStepDue` is set by `armTimer()` when the item just shown wants
  // a zero dwell, so the loop takes the next step at once.
  let skipStepping = false;
  let zeroStepDue = false;
  /**
   * The play-all auto-pick on the open choice (docs/plan.md Phase 18): a
   * countdown, then the picked row highlighted, then its own timer enters
   * the route. Only a live opening has one; a replayed choice screen waits
   * for the reader like any other.
   */
  let autoPick: {
    decision: number;
    toRoute: number;
    /** The route that just ended (a re-offer), or -1 on a first fire. */
    fromRoute: number;
    picked: boolean;
    /**
     * A skip burst was running: no countdown. Whether the entry resumes it
     * is `skipArmed`'s (Tab on the choice can drop or add it).
     */
    resumeSkip: boolean;
    ms: number;
    armId: number;
  } | null = null;
  let autoPickTimer: unknown = null;
  let autoPickArms = 0;
  let destroyed = false;
  // Start position. A stored context is authoritative: its `lastShown`
  // (under its open choice, if any) is where the reader left off. Otherwise a persisted frontier marks a seen
  // prefix, and the load starts on its last shown item. With neither, this is
  // the first-ever load: item 0, shown, so the frontier is one past it.
  // A URL start (`startAt`) replaces only the landing: the restore runs as
  // ever, then the item is entered as `u` enters its target.
  const { startAt } = options;
  const urlStart =
    startAt !== undefined &&
    Number.isInteger(startAt) &&
    startAt >= 0 &&
    startAt < count
      ? startAt
      : -1;
  if (count > 0) {
    if (options.resumeContext !== undefined) {
      applyContext(options.resumeContext, false);
      if (urlStart < 0) {
        reopenChoice(options.resumeContext);
        settled = true; // a resume landing was already read, as with a frontier
        autoPickLiveChoice(); // play-all carries on from a live choice
      }
    } else if (options.resumeFrontier !== undefined) {
      const frontier = clamp(options.resumeFrontier, 1, count);
      for (let index = 0; index < frontier; index += 1) visited.add(index);
      highestSeen = frontier - 1;
      cursor = frontier - 1;
      settled = true;
    } else if (urlStart < 0) {
      markShown(0);
    }
    if (urlStart >= 0) {
      // `showItem` without its emit: nothing listens yet, and the state
      // snapshot below is the first.
      enterRoutesAround(urlStart);
      cursor = urlStart;
      transition = "advance";
      settled = false;
      markShown(urlStart);
    }
  }
  // The start position is an arrival like any other (Phase 15): a chain
  // entered at start — resumed or fresh — measures its floor from now.
  if (count > 0) chainHeadAt = chainHeadMarkFor(cursor, false);
  let state: MachineState = snapshot();
  // The item shown at start: auto mode arms its hold; manual mode (the
  // player's start, Phase 13b) waits for the reader instead. A restored
  // choice screen waits for its pick, and a restored last item stays.
  armHold();

  function snapshot(): MachineState {
    const choice = pendingChoice === null ? null : choiceView(pendingChoice);
    const frontier = highestSeen < 0 ? 0 : Math.min(highestSeen + 1, count);
    // Play-all carries on from a route ending by itself, so the card there
    // is noise; the array end still earns it, and so does any item where
    // the story ends (`nothingFollows`), whatever its route's `result`. A
    // linear manifest has nothing to find, so its all-seen card would only
    // repeat "the end".
    const ending =
      nothingFollows() ||
      (endings.has(cursor) &&
        !(settings.playAllRoutes && cursor !== count - 1));
    const endCard =
      choice === null &&
      ending &&
      (visited.size < count || decisions.length > 0)
        ? endCardView()
        : null;
    return Object.freeze({
      cursor,
      frontier,
      settled,
      skipping,
      transition,
      ...(choice === null ? {} : { choice }),
      ...(endCard === null ? {} : { endCard }),
      ...(skipPlaysVideo() ? { skipVideo: true as const } : {}),
      ...(segment === null ? {} : { segment: segmentView(segment) }),
    });
  }

  /** The state's view of the active segment `index` (`SegmentView`). */
  function segmentView(index: number): SegmentView {
    const visual = items[visualIndexFor(items, cursor)];
    const total = visual.type === "video" ? (visual.segments?.length ?? 0) : 0;
    return Object.freeze({ index, count: total });
  }

  /**
   * The countdown before play-all answers the open choice: the reading time
   * of every word the screen draws plus comprehension time per row
   * (`choiceCountdownMs`, docs/plan.md Phase 20). Inside a skip burst there
   * is none.
   */
  function autoPickCountdownMs(held: {
    decision: number;
    fromRoute: number;
    resumeSkip: boolean;
  }): number {
    if (held.resumeSkip || pendingChoice === null) return 0;
    const view = choiceView(pendingChoice);
    const decision = decisions[held.decision];
    const back =
      held.fromRoute >= 0
        ? labelOf(decision, decision.routes[held.fromRoute])
        : undefined;
    return choiceCountdownMs(
      choiceScreenText(view, back),
      choiceRowCount(view),
      settings,
    );
  }

  /**
   * Puts a play-all auto-pick on the open choice of `decisionIndex`, its
   * countdown armed; false when every route has already played.
   */
  function startAutoPick(
    decisionIndex: number,
    fromRoute: number,
    resumeSkip: boolean,
  ): boolean {
    const toRoute = nextAutoRoute(decisions[decisionIndex]);
    if (toRoute < 0) return false;
    autoPick = {
      decision: decisionIndex,
      toRoute,
      fromRoute,
      picked: false,
      resumeSkip,
      ms: 0,
      armId: 0,
    };
    armAutoPick();
    return true;
  }

  /**
   * Play-all takes over the choice on screen when it is a live one — opened
   * by reading or a reload, not walked onto by the wheel — as when the
   * setting is turned on over it or a reload lands on it; true when it did.
   */
  function autoPickLiveChoice(): boolean {
    if (!settings.playAllRoutes || pendingChoice === null) return false;
    if (pendingChoice.walk !== undefined) return false;
    return startAutoPick(pendingChoice.decision, -1, false);
  }

  /** Arms the current auto-pick phase from now; nothing arms while paused. */
  function armAutoPick(): void {
    if (autoPick === null) return;
    if (autoPickTimer !== null) scheduler.cancel(autoPickTimer);
    autoPickTimer = null;
    if (!autoPick.picked) {
      autoPick.ms = autoPickCountdownMs(autoPick);
      if (autoPick.ms === 0) autoPick.picked = true;
    }
    if (autoPick.picked) autoPick.ms = AUTO_PICK_SHOW_MS;
    autoPickArms += 1;
    autoPick.armId = autoPickArms;
    if (!paused)
      autoPickTimer = scheduler.schedule(autoPickElapsed, autoPick.ms);
  }

  function autoPickElapsed(): void {
    autoPickTimer = null;
    if (autoPick === null) return;
    if (!autoPick.picked) {
      autoPick.picked = true;
      armAutoPick();
      emit();
      return;
    }
    finishAutoPick(true);
  }

  /**
   * Answers the open choice with the auto-pick's route. When the phases
   * ELAPSED (`elapsed`) with skip on — a burst the choice carried on
   * through, or Tab on the choice — the burst runs on from the route
   * entered: play-all with skip-all is the no-interaction path. Space ends
   * it early and leaves skip off.
   */
  function finishAutoPick(elapsed: boolean): void {
    if (autoPick === null) return;
    const held = autoPick;
    cancelAutoPick();
    pendingChoice = null;
    closeFramesFor(held.decision);
    if (!elapsed) skipArmed = false; // Space stops skip, as everywhere
    enterRoute(decisions[held.decision], held.toRoute, "read");
    settleArm();
  }

  /**
   * After an answer (docs/plan.md Phase 43): an arm the answer's first item
   * did not take (`showItem`) waits on a choice the answer opened, or —
   * nothing shown and no choice, the story ended — turns off.
   */
  function settleArm(): void {
    if (skipArmed && pendingChoice === null) skipArmed = false;
    reportSkip();
  }

  /** Drops the auto-pick; the choice it was on stays open. */
  function cancelAutoPick(): void {
    if (autoPickTimer !== null) scheduler.cancel(autoPickTimer);
    autoPickTimer = null;
    autoPick = null;
  }

  /** The overlay content for the open choice: prompt, routes, return offer. */
  function choiceView(pending: PendingChoice): ChoiceView {
    const decision = decisions[pending.decision];
    const routes: ChoiceRoute[] = decision.routes.map((route, index) =>
      Object.freeze({
        routeIdx: index,
        id: route.id,
        label: labelOf(decision, route),
        seen: isPlayed(decision.index, index),
      }),
    );
    const held = autoPick?.decision === pending.decision ? autoPick : null;
    const auto: AutoPickView | null =
      held === null
        ? null
        : Object.freeze({
            routeIdx: held.toRoute,
            picked: held.picked,
            ms: held.ms,
            armId: held.armId,
            ...(held.fromRoute >= 0
              ? {
                  backFromLabel: labelOf(
                    decision,
                    decision.routes[held.fromRoute],
                  ),
                }
              : {}),
          });
    const walk = pending.walk ?? -1;
    const view = {
      decisionId: decision.id,
      prompt: promptOf(decision),
      routes,
      ...(pending.continueOption ? { continueOption: true } : {}),
      ...(auto === null ? {} : { autoPick: auto }),
      ...(walk >= 0 ? { walkRoute: walk } : {}),
    };
    return Object.freeze(view);
  }

  function emit(): void {
    state = snapshot();
    for (const listener of [...listeners]) listener(state);
    reportSkip();
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
      // Skip mode paces by pictures (docs/plan.md Phase 18): a `text` item
      // takes zero time (its caption is hidden while skipping), so a chain of
      // lines over one picture costs that picture's dwell alone. A media
      // item takes one fixed `settings.skipDwellMs`. Media never gates and never plays to completion; the machine
      // only times (docs/content-format.md, "Timing"). A video's dwell is
      // clamped to its own gate, so a short clip is not shown longer than
      // the content describes. The `minPlaySeconds` floor NEVER enters here:
      // a reader in skip mode chose speed, and manual advance and skip stay
      // immediate — the floor exists so AUTO play sees the video (Phase 15).
      // `skipPlaysVideos` (docs/plan.md Phase 18) lifts the clamp for a
      // video: it plays its whole plan — range, passes or `holdSeconds` —
      // timed by the same bound forward play below the edge uses, so a clip
      // that cannot play never stalls the burst. A chain head plays its plan
      // on the head; the chain's lines then take zero time like any other
      // line, so the burst moves on as soon as the plan has played (the
      // lines' captions were hidden under it anyway).
      const item = items[cursor];
      if (item.type === "text") return 0;
      if (item.type === "video") {
        if (settings.skipPlaysVideos) return videoGateMs(item);
        return Math.min(settings.skipDwellMs, videoGateMs(item));
      }
      return settings.skipDwellMs;
    }
    // An active segment meets the media gate (docs/plan.md Phase 49): its
    // loop reports no passes, so the item holds on its text hold alone, as
    // a video under a chain does.
    return Math.max(
      itemHoldMs(
        items[cursor],
        settings,
        nextIsText(cursor) || segment !== null,
        words?.itemText(cursor),
      ),
      chainExitFloorMs(),
      voiceHoldMs(),
    );
  }

  /**
   * How long the voice line of the item under the cursor lasts, in ms,
   * while the reader hears voices (`setVoiceAudible`); 0 otherwise, or
   * when the item has no voice or its track is unknown.
   */
  function voiceHoldMs(): number {
    if (!voiceAudible) return 0;
    // A spoken line's hold is a time, measured here from when the item's
    // timer was armed, as the delay is.
    const spoken =
      spokenHold !== null && spokenHold.index === cursor
        ? spokenHold.until - timerArmedAt
        : 0;
    const track = voiceAt(cursor)?.track;
    if (track === undefined) return spoken;
    return Math.max(
      spoken,
      (track.durationSeconds - (track.startSeconds ?? 0)) * 1000,
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
    if (skipping) runSkip();
    else onHoldElapsed();
  }

  /**
   * One skip step, then at once every further step that a zero-time `text`
   * item asks for (`zeroStepDue`), until the burst reaches an item with a
   * real dwell, stops, or is paused. A loop, not recursion or 0 ms timers:
   * a long chain costs no stack and no timer clamping.
   */
  function runSkip(): void {
    skipStepping = true;
    try {
      do {
        zeroStepDue = false;
        skipTick();
      } while (zeroStepDue && skipping && !paused && !destroyed);
    } finally {
      skipStepping = false;
      zeroStepDue = false;
    }
  }

  /**
   * Arms the current item's wait, measured from `anchor` (default now): the
   * timer covers only what is left of the delay after `anchor`, at least
   * the next tick.
   */
  function armTimer(anchor = Date.now()): void {
    cancelTimer();
    if (destroyed || count === 0) return;
    // Manual mode arms no hold — the reader advances by pressing; skip's
    // dwell is the reader's own command and runs in both modes, and the
    // help screen's pause arms nothing until resume() (Phase 13b).
    if (paused || (!skipping && !autoAdvance)) return;
    timerArmedAt = anchor;
    const delay = Math.max(0, currentDelayMs() - (Date.now() - anchor));
    if (skipping && delay === 0 && skipStepping) {
      zeroStepDue = true; // `runSkip()` takes the next step at once
      return;
    }
    timer = scheduler.schedule(onTimerElapsed, delay);
  }

  /**
   * Re-times the pending timer for a change to what the current item's
   * delay is made of (`setSettings`, `setVoiceAudible`). Only a live
   * auto-advance or skip dwell is re-timed; an item with no pending timer
   * (manual mode, an open choice, a completed item with nothing after it,
   * or one waiting on a video's `ended`) owns none to re-arm. The new delay
   * is measured from when this item's timer was armed, so the time already
   * shown counts toward the new total.
   */
  function retime(): void {
    if (timer === null) return;
    const remainingMs = Math.max(
      0,
      currentDelayMs() - (Date.now() - timerArmedAt),
    );
    cancelTimer();
    timer = scheduler.schedule(onTimerElapsed, remainingMs);
  }

  /**
   * `armTimer()` for the item under the cursor whether or not it is settled
   * (docs/plan.md Phase 43): under auto-forward a settled item — a resume
   * landing, or the item Space stopped a skip burst on — moves on like any
   * other once its hold has passed. Two waits stay: an open choice (it
   * waits for its answer; play-all's auto-pick is its own timer) and a
   * settled item where the story ends (`nothingFollows`).
   */
  function armHold(anchor?: number): void {
    if (settled && (pendingChoice !== null || nothingFollows())) return;
    armTimer(anchor);
  }

  /**
   * Whether the story ends on the item under the cursor: no decision fires
   * on it and no open route ends on it, and it is the last item or the last
   * item of a route that is no longer open — where a pure choice's close
   * ended the story, its menu region running to the last item
   * (`closeIfPureAndComplete`). A step on from such a route end would fall
   * into the next route's items, which the format never does: a route's
   * items are reached only through its decision. So every forward step
   * (Space, the hold, skip's dwell) stops there as at the last item, the
   * end card shows there as at the last item, and `u` counts nothing there
   * as Space's next read (`continuation`).
   */
  function nothingFollows(): boolean {
    if (relevantDecision(cursor) >= 0 || atRouteEnd()) return false;
    return cursor >= count - 1 || routeEnds.has(cursor);
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
    segment = null; // and plays the item's own range, no segment active
    itemShownAt = Date.now();
    armTimer();
  }

  /** The marking rule: shown now, so seen from now on. */
  function markShown(index: number): void {
    if (!visited.has(index)) {
      sound?.seen(index);
      visited.add(index);
      seenLog.push(index);
    }
    if (index > highestSeen) highestSeen = index;
  }

  /** A new arrival of `kind` (`Machine.arrival`). */
  function arrive(kind: ArrivalKind): void {
    arrival = Object.freeze({ kind, number: arrival.number + 1 });
  }

  /** Records the route last picked at a decision (header, "Timeline"). */
  function setLastPick(decisionIndex: number, routeIdx: number): void {
    lastPick.set(decisionIndex, routeIdx);
    sound?.invalidate();
  }

  /**
   * The item before item `index` on the wheel's path back, or -1. A choice
   * screen on the way stands over an item, and its step back is that item.
   */
  function itemBefore(index: number): number {
    let screen = stepBack(itemScreen(index));
    if (screen?.kind === "choice") screen = stepBack(screen);
    return screen?.kind === "item" ? screen.index : -1;
  }

  /**
   * Whether the step back from item `index` is always `index - 1`
   * (`backwardOf`): no route starts there, nothing joins into it, and the
   * step forward from `index - 1` lands on it.
   */
  function linearBack(index: number): boolean {
    const frame = innermost[index];
    if (
      frame !== null &&
      decisions[frame.decision].routes[frame.route].startIndex === index
    )
      return false;
    if (joinsTo(index).length > 0 || passesInto(index).length > 0) return false;
    const step = forwardOf(itemScreen(index - 1));
    return step?.kind === "item" && step.index === index;
  }

  /**
   * Item `index`'s recorded voice line in the language shown
   * (`MachineWords.voice`), else its own `audio.voice`; null for none.
   */
  function voiceAt(
    index: number,
  ): { readonly id: string; readonly track: AudioTrack | undefined } | null {
    if (words?.voice !== undefined) return words.voice(index);
    const id = items[index]?.audio?.voice;
    return id === undefined ? null : { id, track: voiceTracks?.[id] };
  }

  /** The target sound at the cursor (`Machine.targetSound`). */
  function resolveSound(): TargetSound {
    audible ??= hasItemAudio(items);
    if (count === 0) return SILENCE;
    // A language file's recording may voice an item of a manifest
    // without audio.
    const voice = voiceAt(cursor)?.id ?? null;
    if (!audible) {
      return voice === null ? SILENCE : Object.freeze({ ...SILENCE, voice });
    }
    sound ??= createSoundResolver(items, {
      linear: linearBack,
      back: itemBefore,
    });
    const setters = sound.at(cursor);
    const visual = items[visualIndexFor(items, cursor)];
    const own = visual.type === "video" ? visual.audio?.videoSound : undefined;
    return Object.freeze({
      music: musicOf(items, setters.music),
      ambience: ambienceOf(items, setters.ambience),
      voice,
      videoSound:
        own === undefined
          ? null
          : Object.freeze({ track: own.track, duck: own.duck ?? 1 }),
    });
  }

  /** The played-this-pass record now, frozen. */
  function passNow(): readonly RouteSet[] {
    if (passExport === null) passExport = routeSets(passPlayed);
    return passExport;
  }

  /** Puts a recorded played-this-pass record back (docs/plan.md Phase 22). */
  function restorePass(sets: readonly RouteSet[]): void {
    passPlayed.clear();
    for (const set of sets) passPlayed.set(set.decision, new Set(set.routes));
    passExport = sets;
  }

  /** Marks a route played: cumulatively and in this pass. */
  function markPlayed(decisionIndex: number, routeIdx: number): void {
    playedOf(decisionIndex).add(routeIdx);
    let set = passPlayed.get(decisionIndex);
    if (set === undefined) {
      set = new Set<number>();
      passPlayed.set(decisionIndex, set);
    }
    if (!set.has(routeIdx)) {
      set.add(routeIdx);
      passExport = null;
    }
  }

  /**
   * Makes `index` the current item: record how it was reached, mark it shown,
   * restart its timing, and tell the listeners. Every reading route to an
   * item — forward advance, skip step, `choose()`, a join, `goTo()`, a
   * restore — comes through here, which is why showing and seeing are the
   * same moment (the header's marking rule), and why it ends any walk: the
   * played-this-pass record the walk rewound to is the reading's from here.
   * `kind` is the forward step's `advance` or any other route's `nav`
   * arrival (see `TransitionKind`); `arrives` is the arrival kind for the
   * sound (`ArrivalKind`), a different split. A wheel step or `e`
   * (`showScreen`) does not come through here.
   *
   * Skip armed on a choice (docs/plan.md Phase 43) is taken here: only an
   * answer can show an item while it is set (every other way off a choice
   * clears it first), so this is the answer's first item, and the burst
   * starts on it as a Tab pressed there would — or not at all when it has
   * nothing to run through (`skipCanStart`), which turns the mode off. One emit
   * carries the outcome, so the renderer never sees a half-started burst.
   */
  function showItem(
    index: number,
    kind: TransitionKind,
    arrives: ArrivalKind,
  ): void {
    const keepsChain = index === cursor + 1 && chainHeadAt !== null;
    cursor = index;
    transition = kind;
    arrive(arrives);
    chainHeadAt = chainHeadMarkFor(index, keepsChain);
    markShown(index);
    passBase = null;
    if (skipArmed && pendingChoice === null) {
      skipArmed = false;
      skipping = skipCanStart();
    }
    beginItem();
    emit();
  }

  /** Whether an item is the `after` of a decision at its own level. */
  function decisionAt(index: number): number {
    const candidates = byAfter.get(index);
    if (candidates === undefined) return -1;
    const level = innermost[index]?.decision ?? -1;
    return candidates.find((at) => decisions[at].parent === level) ?? -1;
  }

  /** Whether any item of a route has been seen. */
  function routeSeen(route: ResolvedRoute): boolean {
    for (let i = route.startIndex; i <= route.endIndex; i += 1) {
      if (visited.has(i)) return true;
    }
    return false;
  }

  /**
   * The route the walk takes forward through a decision (docs/plan.md
   * Phase 27): the last pick there, else — a following decision — the
   * route taking the pick at the decision it follows, else the longest
   * route (most items, manifest order on a tie) holding seen content; -1
   * when none does.
   */
  function pickFor(decision: ResolvedDecision): number {
    const known = lastPick.get(decision.index);
    if (known !== undefined) return known;
    // A following decision with no pick of its own: the route taking the
    // reader's pick at the decision it follows (docs/content-format.md,
    // "Branches").
    const taken = followedRoute(decision);
    if (taken !== undefined && taken >= 0) return taken;
    let best = -1;
    decision.routes.forEach((route, routeIdx) => {
      if (!routeSeen(route)) return;
      const span = route.endIndex - route.startIndex;
      const bestRoute = decision.routes[best];
      if (best < 0 || span > bestRoute.endIndex - bestRoute.startIndex)
        best = routeIdx;
    });
    return best;
  }

  /** A returning (not continuing, not ending) route. */
  function returns(route: ResolvedRoute): boolean {
    return !route.continuing && route.result === "return";
  }

  /**
   * Where the walk goes after the last item of route `routeIdx` of
   * `decisionIndex`: a continuing route, or a `continue` one, joins at
   * `continueAt` (story order, whatever play-all's flow does there); a
   * returning route leads back to the choice screen and on along the
   * continuing route; an ending route stops (null). A pure choice's routes,
   * whatever their `result`, all lead back to its choice screen and on past
   * the menu region, as the machine's flow closes past it once all have
   * played (the shape the Ren'Py converter writes for every menu).
   */
  function afterRouteEnd(
    decisionIndex: number,
    routeIdx: number,
  ): Screen | null {
    const decision = decisions[decisionIndex];
    const route = decision.routes[routeIdx];
    if (joinsAtContinue(route)) return passOn(decision, decision.continueAt);
    if (decision.continuingRoute >= 0 && !returns(route)) return null;
    return {
      kind: "choice",
      decision: decisionIndex,
      next: decision.continuingRoute,
      via: routeIdx,
    };
  }

  /**
   * Flow leaving a decision for item `target` (a join, or a pure choice's
   * fall-through): past the end of the route holding the decision it
   * leaves that route too (nested routes sharing an ending, as `join`).
   */
  function passOn(decision: ResolvedDecision, target: number): Screen | null {
    const holder = innermost[decision.afterIndex];
    // A holder is an enclosing decision; a malformed table whose route
    // holds its own `after` would loop, so only a parent counts.
    if (holder !== null && holder.decision === decision.parent) {
      const route = decisions[holder.decision].routes[holder.route];
      if (target > route.endIndex)
        return afterRouteEnd(holder.decision, holder.route);
    }
    return target >= 0 && target < count ? itemScreen(target) : null;
  }

  /** The screen after `screen` in story order, or null at a stop. */
  function forwardOf(screen: Screen): Screen | null {
    if (screen.kind === "choice") {
      const decision = decisions[screen.decision];
      if (screen.next >= 0)
        return itemScreen(decision.routes[screen.next].startIndex);
      return passOn(decision, regionEnd(decision) + 1);
    }
    const index = screen.index;
    const fires = decisionAt(index);
    if (fires >= 0) {
      const decision = decisions[fires];
      if (passesFollowing(decision))
        return passOn(decision, decision.continueAt);
      const next = pickFor(decision);
      return next < 0
        ? null
        : { kind: "choice", decision: fires, next, via: -1 };
    }
    const frame = innermost[index];
    if (
      frame !== null &&
      decisions[frame.decision].routes[frame.route].endIndex === index
    )
      return afterRouteEnd(frame.decision, frame.route);
    return index + 1 < count ? itemScreen(index + 1) : null;
  }

  /**
   * The joins into each item: the route ends whose step lands on it (the
   * join of a continuing or `continue` route, nested shared endings
   * included), and the routes of pure choices whose fall-through does, each
   * with the decision and route it comes by. The walk back from that item
   * takes one of them (`backwardOf`). Static; built on first use.
   */
  let joinsInto: Map<number, Join[]> | null = null;
  function joinsTo(index: number): readonly Join[] {
    if (joinsInto === null) {
      const map = new Map<number, Join[]>();
      const add = (target: Screen | null, join: Join) => {
        if (target?.kind !== "item") return;
        const list = map.get(target.index) ?? [];
        list.push(join);
        map.set(target.index, list);
      };
      for (const decision of decisions) {
        decision.routes.forEach((route, routeIdx) => {
          const by = { decision: decision.index, route: routeIdx };
          const end = itemScreen(route.endIndex);
          if (decisionAt(route.endIndex) < 0)
            add(forwardOf(end), { from: end, ...by });
          if (decision.continuingRoute < 0) {
            const past: Screen = {
              kind: "choice",
              decision: decision.index,
              next: -1,
              via: routeIdx,
            };
            add(forwardOf(past), { from: past, ...by });
          }
        });
      }
      joinsInto = map;
    }
    return joinsInto.get(index) ?? [];
  }

  /**
   * The following decisions whose pass (no route taking the pick at the
   * decision they follow) steps into item `index` from their `after` item:
   * the walk's step forward (`forwardOf`), so its step back too. Static,
   * like `joinsTo`; whether a decision passes now is `passesFollowing`.
   */
  let passesTo: Map<number, ResolvedDecision[]> | null = null;
  function passesInto(index: number): readonly ResolvedDecision[] {
    if (passesTo === null) {
      const map = new Map<number, ResolvedDecision[]>();
      for (const decision of decisions) {
        if (!decision.takes.includes(-1)) continue;
        if (decisionAt(decision.afterIndex) !== decision.index) continue;
        const target = passOn(decision, decision.continueAt);
        if (target?.kind !== "item") continue;
        const list = map.get(target.index) ?? [];
        list.push(decision);
        map.set(target.index, list);
      }
      passesTo = map;
    }
    return passesTo.get(index) ?? [];
  }

  /** The item a screen stands on: a choice screen's is the item under it. */
  function anchorOf(screen: Screen): number {
    if (screen.kind === "item") return screen.index;
    const decision = decisions[screen.decision];
    return screen.via >= 0
      ? decision.routes[screen.via].endIndex
      : decision.afterIndex;
  }

  /**
   * Whether a join is the way the reader last came (docs/plan.md Phase
   * 39): its route is the last pick at its decision and holds anything
   * read, and every route around its end is the last pick at its own
   * decision where one is known. A continuing route's end inside a nested
   * decision joins for it too, so the nested last pick decides which of
   * the two ways in is the reader's.
   */
  function lastPickJoin(join: Join): boolean {
    if (lastPick.get(join.decision) !== join.route) return false;
    if (!routeSeen(decisions[join.decision].routes[join.route])) return false;
    return framesAround(anchorOf(join.from)).every(
      (frame) => (lastPick.get(frame.decision) ?? frame.route) === frame.route,
    );
  }

  /**
   * The screen before `screen` in story order, or null at the start. With
   * `seenOnly` every candidate step must come from read content (a join's
   * route end, the item before, a returning route's end before a choice
   * screen), except the join of the reader's last pick, which needs only
   * its route to hold anything read (`lastPickJoin`); without it the same
   * order picks among all of them, seen or not (`seenBehind` walks those
   * over unseen content).
   */
  function backwardOf(screen: Screen, seenOnly: boolean): Screen | null {
    if (screen.kind === "choice") return itemScreen(anchorOf(screen));
    const read = (index: number) => !seenOnly || visited.has(index);
    const index = screen.index;
    const frame = innermost[index];
    if (
      frame !== null &&
      decisions[frame.decision].routes[frame.route].startIndex === index
    ) {
      // The choice screen that leads into this route: after a returning
      // last pick (whose end was read, under `seenOnly`) when this is the
      // continuing route.
      const decision = decisions[frame.decision];
      const picked = lastPick.get(decision.index) ?? -1;
      const via =
        frame.route === decision.continuingRoute &&
        picked >= 0 &&
        picked !== frame.route &&
        returns(decision.routes[picked]) &&
        read(decision.routes[picked].endIndex)
          ? picked
          : -1;
      return {
        kind: "choice",
        decision: decision.index,
        next: frame.route,
        via,
      };
    }
    // A following decision passed on to here (no route takes the pick at
    // the decision it follows) comes back to its `after` item, as the
    // step forward from there leads here.
    for (const passed of passesInto(index)) {
      if (passesFollowing(passed) && read(passed.afterIndex))
        return itemScreen(passed.afterIndex);
    }
    // A join comes back by the route last picked at its decision (a pure
    // choice's fall-through too) whenever that route holds anything read,
    // its end read or not, so the walk passes over an unseen end to the
    // route's last read item (docs/plan.md Phase 39). Else by the
    // continuing route, else by the plain step from the item before, else
    // by the first joining route.
    const all = joinsTo(index);
    const lastPicked = all.find((join) => lastPickJoin(join));
    if (lastPicked !== undefined) return lastPicked.from;
    const joins = all.filter((join) => read(anchorOf(join.from)));
    const preferred =
      joins.find((join) => lastPick.get(join.decision) === join.route) ??
      joins.find(
        (join) => decisions[join.decision].continuingRoute === join.route,
      );
    if (preferred !== undefined) return preferred.from;
    if (index > 0) {
      const step = forwardOf(itemScreen(index - 1));
      if (step?.kind === "item" && step.index === index && read(index - 1))
        return itemScreen(index - 1);
    }
    return joins[0]?.from ?? null;
  }

  /**
   * Whether the wheel may show a screen: only seen content. A choice screen
   * counts as seen when the step on from it was read and the item under it
   * (whose picture it shows) was too.
   */
  function screenSeen(screen: Screen): boolean {
    if (screen.kind === "item") return visited.has(screen.index);
    const onward = forwardOf(screen);
    return (
      onward?.kind === "item" &&
      visited.has(onward.index) &&
      visited.has(anchorOf(screen))
    );
  }

  /** A screen as a key, so a walk can tell one it has passed. */
  function screenKey(screen: Screen): string {
    return screen.kind === "item"
      ? `i${String(screen.index)}`
      : `c${String(screen.decision)}:${String(screen.next)}:${String(screen.via)}`;
  }

  /**
   * One step of the wheel's path back (docs/plan.md Phases 27, 39): the
   * step `backwardOf` takes from read content, when the screen it reaches
   * is seen (a last-picked route's join may reach an unseen end);
   * otherwise the story-order step back taken whether seen or not. Null at
   * the start. The target sound walks this same path (`itemBefore`).
   */
  function stepBack(screen: Screen): Screen | null {
    const seen = backwardOf(screen, true);
    if (seen !== null && screenSeen(seen)) return seen;
    return backwardOf(screen, false);
  }

  /**
   * Where a back notch lands: `stepBack` repeated through unseen screens
   * (content added since the reader passed, or skipped by a jump) to the
   * nearest seen one. Null when no seen screen lies behind. A screen met
   * twice ends the search: a malformed table can make the steps loop, and
   * there are finitely many screens.
   */
  function seenBehind(here: Screen): Screen | null {
    const passed = new Set<string>();
    let screen: Screen | null = here;
    while (screen !== null && !passed.has(screenKey(screen))) {
      passed.add(screenKey(screen));
      screen = stepBack(screen);
      if (screen !== null && screenSeen(screen)) return screen;
    }
    return null;
  }

  /** The screen on show now, as the walk sees it. */
  function currentScreen(): Screen {
    if (pendingChoice === null) return itemScreen(cursor);
    const decision = decisions[pendingChoice.decision];
    const via = pendingChoice.via;
    const next =
      pendingChoice.walk ??
      (via < 0 ? pickFor(decision) : decision.continuingRoute);
    return { kind: "choice", decision: decision.index, next, via };
  }

  /**
   * The played-this-pass record as of item `anchor` in story order
   * (docs/plan.md Phase 27): the walk's starting record without every
   * decision at or after the anchor, plus the routes enclosing it.
   */
  function passAt(anchor: number): readonly RouteSet[] {
    const map = new Map<number, Set<number>>();
    for (const set of passBase ?? passNow()) {
      if (decisions[set.decision].afterIndex < anchor)
        map.set(set.decision, new Set(set.routes));
    }
    for (const frame of framesAround(anchor)) {
      const routes = map.get(frame.decision) ?? new Set<number>();
      routes.add(frame.route);
      map.set(frame.decision, routes);
    }
    return routeSets(map);
  }

  /**
   * The wheel and `e`: show a screen of the walk (header, "Timeline"). Skip
   * mode ends, a burst or one armed on the choice left; an item arrives
   * unsettled with its own hold, a choice screen settled, its walk route
   * highlighted, waiting for a pick. Nothing is marked seen or played; the
   * played-this-pass record rewinds to it.
   */
  function showScreen(screen: Screen, arrives: "walk" | "jump"): void {
    skipping = false;
    skipArmed = false;
    cancelAutoPick();
    if (passBase === null) passBase = passNow();
    const anchor = anchorOf(screen);
    restorePass(passAt(anchor));
    stack.length = 0;
    // A loop, not a spread: the frames are bounded only by the decisions.
    for (const frame of framesAround(
      screen.kind === "item"
        ? screen.index
        : decisions[screen.decision].afterIndex,
    ))
      stack.push(frame);
    cursor = anchor;
    transition = "nav";
    arrive(arrives);
    chainHeadAt = chainHeadMarkFor(cursor, false);
    if (screen.kind === "item") {
      pendingChoice = null;
      beginItem();
    } else {
      pendingChoice = {
        decision: screen.decision,
        continueOption: offersContinue(decisions[screen.decision]),
        via: screen.via,
        walk: screen.next,
      };
      settled = true;
      holdElapsed = false;
      endedCount = 0;
      segment = null;
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
   * so ended counts are irrelevant to it (and `mediaEnded()` ignores it):
   * under auto-forward it moves on at its time bound (Phase 43).
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
   * An active segment (docs/plan.md Phase 49) meets the gate too: the
   * segment's loop reports no passes, and the reader chose the view.
   */
  function mediaGateSatisfied(): boolean {
    if (settled || segment !== null) return true;
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
    if (fireDecision("read")) return;
    if (atRouteEnd()) {
      handleRouteEnd("read");
      return;
    }
    if (nothingFollows()) {
      // The story ends here: the shown item is simply settled.
      settled = true;
      emit();
      return;
    }
    showItem(cursor + 1, "advance", "read");
  }

  /**
   * The segments a step walks, with the stage's time (docs/plan.md Phase
   * 49, "Video segments"), or null when no step can be made here: the
   * cursor must be the last item of its chain — the video item itself when
   * no `text` follows it, else the chain's last `text` item, so the lines
   * come first — its visual a video with `segments`, and the stage playing
   * that video (the clock reports a time; a still or no video reports
   * null). Space's step (`advance`) reads it; Left and Right (Phase 49
   * item 5) step under the same conditions, each with its own target.
   */
  function segmentStage(): {
    segments: readonly VideoSegment[];
    time: number;
  } | null {
    if (videoClock === null || nextIsText(cursor)) return null;
    const visual = items[visualIndexFor(items, cursor)];
    if (visual.type !== "video") return null;
    const { segments } = visual;
    if (segments === undefined || segments.length === 0) return null;
    const time = videoClock();
    return time === null ? null : { segments, time };
  }

  /**
   * The segment a forward step goes to, or -1 when none is left: after a
   * step, the next one by index — never by re-reading the time, since a
   * seek can land a hair before its target — and before any, the first
   * one starting strictly after the stage's time.
   */
  function nextSegment(stage: {
    segments: readonly VideoSegment[];
    time: number;
  }): number {
    if (segment !== null)
      return segment + 1 < stage.segments.length ? segment + 1 : -1;
    return stage.segments.findIndex((view) => view.startSeconds > stage.time);
  }

  /**
   * The segment a backward step goes to, or -1 when there is none: after a
   * step, the one before the active segment by index; before any, the one
   * before the segment the stage's time is in, or, with the time in no
   * segment, the last one starting before the time.
   */
  function previousSegment(stage: {
    segments: readonly VideoSegment[];
    time: number;
  }): number {
    if (segment !== null) return segment - 1;
    const { segments, time } = stage;
    const within = segments.findIndex(
      (view) => view.startSeconds <= time && time < view.endSeconds,
    );
    if (within >= 0) return within - 1;
    let last = -1;
    segments.forEach((view, index) => {
      if (view.startSeconds < time) last = index;
    });
    return last;
  }

  /**
   * Left or Right (Phase 49 item 5): the step `target` picks, made as
   * Space makes it (the item settles, the segment shows), only where
   * Space's own step would be made — manual reading, no choice or
   * auto-pick open, `segmentStage()` non-null. Auto-forward and skip
   * leave the arrows inert: only a manual press steps segments, and an
   * arrow is no Space, so it does not turn either mode off. No target, no
   * change and no emit.
   */
  function arrowStep(
    target: (stage: {
      segments: readonly VideoSegment[];
      time: number;
    }) => number,
  ): void {
    if (destroyed || count === 0) return;
    if (autoPick !== null || pendingChoice !== null) return;
    if (skipping || autoAdvance) return;
    const stage = segmentStage();
    const index = stage === null ? -1 : target(stage);
    if (index < 0) return;
    if (!settled) {
      settled = true;
      cancelTimer();
    }
    showSegment(index);
  }

  /**
   * Makes segment `index` the active one (`MachineState.segment`): a state
   * change, not an arrival — the cursor, seen set, transition, arrival and
   * chain head stay. A pending hold re-times: the media gate is met now.
   */
  function showSegment(index: number): void {
    segment = index;
    retime();
    emit();
  }

  /**
   * Skip-mode dwell elapsed. One step forward: a media item consumes one
   * dwell, a `text` line none (`currentDelayMs`), but every line is still
   * stepped onto here, one at a time, so each is shown, marked seen and
   * recorded, and every stop rule below applies to it. A decision reached is
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
    if (fireDecision("skip")) return;
    if (atRouteEnd()) {
      handleRouteEnd("skip");
      return;
    }
    if (nothingFollows()) {
      // Dwell elapsed where the story ends; nothing is left to skip.
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
    showItem(next, "nav", "skip"); // arms a dwell if skipping, else the item's normal hold
  }

  /**
   * Whether skip's next forward step would SHOW an unseen item with
   * `skipAll` off (docs/plan.md Phase 18): a route end joining at an unseen
   * `continueAt` (`endJoins`), or a plain step onto an unseen item. A
   * decision here opens its overlay instead (no reveal), and a re-offer
   * reveals nothing either; a following decision that shows no choice
   * reveals what it steps to (`followTarget`) when that is unseen.
   */
  function skipWouldReveal(): boolean {
    if (settings.skipAll) return false;
    const fires = relevantDecision(cursor);
    if (fires >= 0) {
      // A following decision opens no choice: its step shows its target.
      const target = followTarget(decisions[fires]);
      return target >= 0 && !visited.has(target);
    }
    if (atRouteEnd()) {
      const frame = stack[stack.length - 1];
      const decision = decisions[frame.decision];
      if (!endJoins(decision, frame.route)) return false;
      return decision.continueAt >= 0 && !visited.has(decision.continueAt);
    }
    return !nothingFollows() && !visited.has(cursor + 1);
  }

  /**
   * Whether Tab here starts a burst: something follows the item under the
   * cursor (`nothingFollows`, docs/plan.md Phase 43: where the story ends a
   * burst would only end itself after one dwell) and the step would not
   * reveal unseen content (`skipWouldReveal`). Otherwise the press does
   * nothing, and an armed answer landing here turns skip off.
   */
  function skipCanStart(): boolean {
    return !nothingFollows() && !skipWouldReveal();
  }

  /**
   * Whether the forward step off route `routeIdx`'s last item joins at the
   * decision's `continueAt` (`handleRouteEnd`): with play-all off, for the
   * continuing route and a `continue` route; under play-all, for the
   * continuing route when it is the one play-all plays last, and for
   * either once no route of the decision is left unplayed this pass (until
   * then play-all re-offers the choice there, as at a `return` route's
   * end, so every route still plays once, the last route last).
   */
  function endJoins(decision: ResolvedDecision, routeIdx: number): boolean {
    const route = decision.routes[routeIdx];
    if (!joinsAtContinue(route)) return false;
    if (!settings.playAllRoutes) return true;
    // Play-all's last route joins; so does the continuing route wherever it
    // is that last one, as for every decision but a following one whose
    // matching route plays last in its place (`lastAutoRoute`).
    if (route.continuing && lastAutoRoute(decision) === routeIdx) return true;
    return nextAutoRoute(decision) < 0;
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

  /** Whether the route has been entered in this pass (`passPlayed`). */
  function isPassPlayed(decisionIndex: number, routeIdx: number): boolean {
    return passPlayed.get(decisionIndex)?.has(routeIdx) === true;
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
   * The route `playAllRoutes` picks next: the shortest route not yet
   * played THIS PASS (fewest items, manifest order on a tie), with the
   * continuing route held last so the alternates each get their play before
   * the story leaves the decision (docs/plan.md Phase 18) — or, at a
   * following decision, the route matching the pick at the decision it
   * follows (`lastAutoRoute`, docs/content-format.md, "Branches"). -1 when every
   * route has played this pass — which is also the all-played rule's test
   * (`closeIfPureAndComplete`). Never the return row.
   */
  function nextAutoRoute(decision: ResolvedDecision): number {
    const last = lastAutoRoute(decision);
    let best = -1;
    decision.routes.forEach((route, index) => {
      if (index === last || isPassPlayed(decision.index, index)) return;
      const span = route.endIndex - route.startIndex;
      const bestRoute = decision.routes[best];
      if (best < 0 || span < bestRoute.endIndex - bestRoute.startIndex)
        best = index;
    });
    if (best >= 0) return best;
    if (last >= 0 && !isPassPlayed(decision.index, last)) return last;
    return -1;
  }

  /**
   * The route play-all holds for last at a decision: the continuing route,
   * or — a following decision with the pick at the decision it follows
   * known and taken by a route — that matching route (docs/content-format.md,
   * "Branches"). -1 for a pure choice.
   */
  function lastAutoRoute(decision: ResolvedDecision): number {
    const taken = followedRoute(decision);
    return taken !== undefined && taken >= 0 ? taken : decision.continuingRoute;
  }

  /**
   * What a following decision takes (docs/content-format.md, "Branches"):
   * the route taking the reader's last pick at the decision it follows, -1
   * where no route takes it (the decision passes on to `continueAt`), or
   * undefined when it follows none or no pick is known there.
   */
  function followedRoute(decision: ResolvedDecision): number | undefined {
    if (decision.follows < 0) return undefined;
    const picked = lastPick.get(decision.follows);
    if (picked === undefined) return undefined;
    return decision.takes[picked] ?? -1;
  }

  /**
   * Where a following decision's firing goes with Play all routes off: its
   * matching route's first item, or `continueAt` where it passes; -1 where
   * it shows its choice screen (play-all on, no pick known, or no
   * `follows`). The forward settle takes it (`fireDecision`); skip's
   * reveal check and `u`'s continuation read it.
   */
  function followTarget(decision: ResolvedDecision): number {
    if (settings.playAllRoutes) return -1;
    const taken = followedRoute(decision);
    if (taken === undefined) return -1;
    return taken >= 0 ? decision.routes[taken].startIndex : decision.continueAt;
  }

  /**
   * Whether the walk passes a following decision straight on to its
   * `continueAt` (docs/content-format.md, "Branches"): it has no pick of
   * its own, and no route takes the pick at the decision it follows.
   */
  function passesFollowing(decision: ResolvedDecision): boolean {
    return !lastPick.has(decision.index) && followedRoute(decision) === -1;
  }

  /**
   * Marks the route played and last picked, pushes its frame, and enters its
   * first item: a `read` arrival from the choice screen, a `jump` from the
   * branch map, the flow's own from a following decision (`fireDecision`).
   */
  function enterRoute(
    decision: ResolvedDecision,
    routeIdx: number,
    arrives: ArrivalKind,
  ): void {
    markPlayed(decision.index, routeIdx);
    setLastPick(decision.index, routeIdx);
    stack.push({ decision: decision.index, route: routeIdx });
    showItem(decision.routes[routeIdx].startIndex, "nav", arrives);
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
   * every later re-opening and walked-to choice screen. A decision with no
   * continuing route is never offered one (unchanged).
   */
  function offersContinue(decision: ResolvedDecision): boolean {
    if (decision.continuingRoute < 0) return false;
    return (
      completed.get(decision.index)?.has(decision.continuingRoute) === true
    );
  }

  /**
   * Shows the overlay for a decision and pauses: the item under the cursor
   * is complete (`settled`), nothing is pending but the reader's pick, and
   * skip mode ends — an overlay is not something to skip past. `via` is the
   * route that just ended (a re-offer), or -1 on a first fire; with `auto`
   * (play-all) the machine answers the choice itself.
   */
  function openChoice(decisionIndex: number, via: number, auto: boolean): void {
    const resumeSkip = skipping;
    closeFramesFor(decisionIndex);
    const decision = decisions[decisionIndex];
    pendingChoice = {
      decision: decisionIndex,
      continueOption: offersContinue(decision),
      via,
    };
    passBase = null; // reading opened it: no walk any more
    // Play all routes (docs/plan.md Phase 18) answers the choice itself, on
    // screen: a countdown, then the picked row, then the route.
    cancelAutoPick();
    if (auto) startAutoPick(decisionIndex, via, resumeSkip);
    // A skip burst pauses at a decision (docs/plan.md Phase 16): the overlay
    // ends the burst, and the pick never restarts it by itself — Tab on the
    // choice arms it for after the pick (Phase 43). Play-all's auto-pick
    // carries the burst on instead: the mode stays on, armed for the route
    // it enters. An answer that opened this choice keeps its arm for it.
    if (auto && resumeSkip) skipArmed = true;
    skipping = false;
    settled = true;
    cancelTimer();
    emit();
  }

  /**
   * The forward settle of a decision's `after` item. Returns true when a
   * decision did fire, so the caller does not move the cursor: the choice
   * pauses (ending any skip burst — docs/plan.md Phase 16), with
   * `playAllRoutes` counting down to its next route in play order, or —
   * every route played — play-all resolves it at once. A following
   * decision with play-all off and the pick it follows known shows no
   * choice (`takeFollowed`).
   */
  function fireDecision(flow: Flow): boolean {
    const index = relevantDecision(cursor);
    if (index < 0) return false;
    const decision = decisions[index];
    if (followTarget(decision) >= 0) {
      takeFollowed(decision, flow);
      return true;
    }
    if (closeIfPureAndComplete(decision, flow)) return true;
    if (settings.playAllRoutes) {
      if (nextAutoRoute(decision) >= 0) openChoice(decision.index, -1, true);
      else autoResolve(decision, flow);
      return true;
    }
    openChoice(decision.index, -1, false);
    return true;
  }

  /**
   * A following decision firing with play-all off and the pick at the
   * decision it follows known (docs/content-format.md, "Branches"): the
   * route taking that pick is entered at once, as a pick — played, last
   * picked, its frame open — or, no route taking it, the decision passes on
   * to `continueAt`. No choice shows, so a skip burst carries on.
   */
  function takeFollowed(decision: ResolvedDecision, flow: Flow): void {
    closeFramesFor(decision.index);
    const taken = followedRoute(decision) ?? -1;
    if (taken >= 0) enterRoute(decision, taken, flow);
    else join(decision, flow);
  }

  /**
   * Play-all at a decision whose every route has played (with one left, the
   * choice shows its auto-pick instead): `continueAt`, else — for a
   * pure-choice decision — the all-played close below.
   */
  function autoResolve(decision: ResolvedDecision, flow: Flow): void {
    closeFramesFor(decision.index);
    if (decision.continueAt >= 0) {
      join(decision, flow);
      return;
    }
    closeIfPureAndComplete(decision, flow);
  }

  /**
   * The all-played rule for a pure-choice decision (docs/plan.md Phase 13):
   * once every route of a decision WITHOUT `continuingRoute` has played, the
   * decision CLOSES — it never re-opens — and author flow continues after the
   * whole menu region: max route end + 1, the Ren'Py fall-through, never
   * inside another route's span (the routes tile the region, so a re-arrival
   * at `after` with all played resumes past every route, not at `after` + 1).
   * Beyond the last item the story ends as before. A nested region that
   * runs to the end of its enclosing route ends that route instead: the
   * enclosing decision's route-end handling runs (re-offer, join or close),
   * never a fall-through into the parent's next route. Returns true when the
   * decision closed, so the caller neither pauses nor re-offers.
   */
  function closeIfPureAndComplete(
    decision: ResolvedDecision,
    flow: Flow,
  ): boolean {
    if (decision.continuingRoute >= 0 || nextAutoRoute(decision) >= 0)
      return false;
    closeFramesFor(decision.index);
    const next = regionEnd(decision) + 1;
    const frame = stack[stack.length - 1];
    if (
      frame !== undefined &&
      frame.decision === decision.parent &&
      next > decisions[frame.decision].routes[frame.route].endIndex
    ) {
      handleRouteEnd(flow);
      return true;
    }
    if (next >= count) {
      settled = true;
      skipping = false;
      emit();
      return true;
    }
    showItem(next, "nav", flow);
    return true;
  }

  /**
   * Proceeds to a decision's `continueAt`, its own frames already closed.
   * A join past the end of the enclosing open route (nested routes sharing
   * an ending: the inner continuing or `continue` route ends on the
   * enclosing route's last item) leaves that route too, so its route-end
   * handling runs — it completes, and joins, re-offers or closes in turn —
   * rather than leaving a stale frame open (docs/plan.md Phase 13, Nested
   * branches).
   */
  function join(decision: ResolvedDecision, flow: Flow): void {
    const frame = stack[stack.length - 1];
    if (
      frame !== undefined &&
      frame.decision === decision.parent &&
      decision.continueAt >
        decisions[frame.decision].routes[frame.route].endIndex
    ) {
      handleRouteEnd(flow);
      return;
    }
    showItem(decision.continueAt, "nav", flow);
  }

  /** True when the cursor is on the last item of the innermost open route. */
  function atRouteEnd(): boolean {
    const frame = stack[stack.length - 1];
    if (frame === undefined) return false;
    return cursor === decisions[frame.decision].routes[frame.route].endIndex;
  }

  /** The route frames enclosing item `index`, outermost first (copies). */
  function framesAround(index: number): Frame[] {
    const found: Frame[] = [];
    for (
      let frame = innermost[index];
      frame !== null && frame !== undefined && found.length < decisions.length;
      frame = innermost[decisions[frame.decision].afterIndex]
    ) {
      found.unshift({ ...frame });
    }
    return found;
  }

  /**
   * Enters item `index` as if each route enclosing it had been picked
   * (`jumpToUnseen`, `MachineOptions.startAt`): skip ends, armed skip too
   * (a jump, not an answer), any open choice is left, and the open frames
   * become the item's own, each route marked played and made its
   * decision's last pick, so a forward press carries on inside the route
   * and the route rows' seen marks agree. The caller shows the item.
   */
  function enterRoutesAround(index: number): void {
    cancelAutoPick();
    skipping = false;
    skipArmed = false;
    pendingChoice = null;
    stack.length = 0;
    for (const frame of framesAround(index)) {
      markPlayed(frame.decision, frame.route);
      setLastPick(frame.decision, frame.route);
      stack.push(frame);
    }
  }

  /**
   * Whether flow has gone past a decision's menu region: a route that joins
   * at its `continueAt` completed (the continuing route, or a `continue`
   * one), or — a pure choice — every route played (the all-played close).
   * A following decision that passes on for the reader's pick (no route
   * takes it) has been passed once its `continueAt` is read.
   */
  function decisionPassed(decision: ResolvedDecision): boolean {
    if (decision.continuingRoute >= 0) {
      const done = completed.get(decision.index);
      return (
        decision.routes.some(
          (route, routeIdx) =>
            joinsAtContinue(route) && done?.has(routeIdx) === true,
        ) ||
        // A following decision no route of which takes the reader's pick
        // passes on to `continueAt`: read there, flow has passed it.
        (followedRoute(decision) === -1 && visited.has(decision.continueAt))
      );
    }
    // `u` reads the cumulative record (seen routes), not this pass's.
    return decision.routes.every((_, routeIdx) =>
      isPlayed(decision.index, routeIdx),
    );
  }

  /**
   * Whether item `index` lies behind an unpassed decision: after its menu
   * region, within the route that holds the decision (anywhere after, for a
   * top-level one).
   */
  function behindDecision(index: number): boolean {
    for (const decision of decisions) {
      if (index <= regionEnds[decision.index]) continue;
      if (decisionPassed(decision)) continue;
      if (decision.parent < 0) return true;
      const holder = decisions[decision.parent].routes.find(
        (route) =>
          decision.afterIndex >= route.startIndex &&
          decision.afterIndex <= route.endIndex,
      );
      if (holder !== undefined && index <= holder.endIndex) return true;
    }
    return false;
  }

  /**
   * What the reader's next forward step reads, which `u` leaves to Space
   * (`jumpToUnseen`): the unseen run a plain step would show — from the
   * next item, or a route end's join (`endJoins`) — up to a route boundary,
   * and the decision the step would open when none of its routes has been
   * played yet (its routes are the reader's pick). A re-offered decision is
   * not excluded: its unplayed routes are what the end card points `u` at.
   */
  function continuation(): { run: Set<number>; decision: number } {
    const run = new Set<number>();
    let decision = -1;
    let start = -1;
    if (pendingChoice !== null) {
      decision = pendingChoice.decision;
    } else if (relevantDecision(cursor) >= 0) {
      decision = relevantDecision(cursor);
      // A following decision showing no choice steps on by itself.
      const target = followTarget(decisions[decision]);
      if (target >= 0) {
        start = target;
        decision = -1;
      }
    } else if (atRouteEnd()) {
      const frame = stack[stack.length - 1];
      const owner = decisions[frame.decision];
      if (endJoins(owner, frame.route)) start = owner.continueAt;
    } else if (!nothingFollows()) {
      start = cursor + 1;
    }
    if (decision >= 0 && (played.get(decision)?.size ?? 0) > 0) decision = -1;
    for (let index = start; index >= 0 && index < count; index += 1) {
      if (visited.has(index)) break;
      run.add(index);
      if (routeEnds.has(index) || routeStarts.has(index + 1)) break;
    }
    return { run, decision };
  }

  /** Whether `u` may land on unseen item `index` (`jumpToUnseen` rules). */
  function reachableUnseen(
    index: number,
    ahead: { run: Set<number>; decision: number },
  ): boolean {
    if (visited.has(index) || ahead.run.has(index)) return false;
    for (const frame of framesAround(index)) {
      if (frame.decision === ahead.decision) return false;
      if (!visited.has(decisions[frame.decision].afterIndex)) return false;
    }
    return !behindDecision(index);
  }

  /** `u`'s landing: the next reachable unseen item, wrapping; -1 if none. */
  function unseenTarget(): number {
    if (visited.size >= count) return -1;
    const ahead = continuation();
    for (let step = 1; step < count; step += 1) {
      const index = (cursor + step) % count;
      if (reachableUnseen(index, ahead)) return index;
    }
    return -1;
  }

  /** An unplayed route of a decision the reader answered otherwise. */
  function declined(frame: Frame): boolean {
    return (
      !isPlayed(frame.decision, frame.route) &&
      (played.get(frame.decision)?.size ?? 0) > 0
    );
  }

  /** The end card's counts (`EndCard`). */
  function endCardView(): EndCard {
    let unseenRoutes = 0;
    for (const decision of decisions) {
      decision.routes.forEach((route, routeIdx) => {
        if (isPlayed(decision.index, routeIdx)) return;
        for (let i = route.startIndex; i <= route.endIndex; i += 1) {
          if (!visited.has(i)) {
            unseenRoutes += 1;
            return;
          }
        }
      });
    }
    let otherUnseen = false;
    for (let i = 0; i < count && !otherUnseen; i += 1) {
      if (visited.has(i)) continue;
      otherUnseen = framesAround(i).every((frame) =>
        isPlayed(frame.decision, frame.route),
      );
    }
    return Object.freeze({
      unseenRoutes,
      otherUnseen,
      nextUnseen: unseenTarget() >= 0,
    });
  }

  /**
   * A forward advance off a route's last item (docs/content-format.md,
   * "Branches"): the route is COMPLETED — recorded in the `completed` set —
   * then pop the frame, and by the route's kind — the continuing route
   * proceeds to `continueAt` (its own completion is recorded right here, at
   * the join), and so does a `continue` route unless play-all still has a
   * route of the decision to play this pass (`endJoins`); any other route
   * re-opens the decision, and that re-offer includes "return to main
   * route" only if the decision's CONTINUING route has already completed
   * (docs/plan.md Phase 18) — the route that just finished opens the row
   * only by being that route, a `continue` route completing only itself. A
   * pure-choice decision whose every route has now played does not re-open:
   * it closes and flow continues past the whole menu region (docs/plan.md
   * Phase 13), ending the story when the region runs to the last item.
   */
  function handleRouteEnd(flow: Flow): void {
    const frame = stack[stack.length - 1];
    const decision = decisions[frame.decision];
    completedOf(decision.index).add(frame.route);
    if (closeIfPureAndComplete(decision, flow)) return;
    stack.pop();
    if (endJoins(decision, frame.route)) {
      join(decision, flow);
      return;
    }
    // The same pause as `fireDecision`: a skip burst stops at this re-offer
    // too (docs/plan.md Phase 16); only `playAllRoutes` answers it itself.
    if (settings.playAllRoutes) {
      if (nextAutoRoute(decision) >= 0)
        openChoice(decision.index, frame.route, true);
      else autoResolve(decision, flow);
      return;
    }
    openChoice(decision.index, frame.route, false);
  }

  /**
   * One wheel notch along the story (`direction` -1 back, +1 forward; header,
   * "Timeline"), onto seen screens only: back passes over unseen screens to
   * the nearest seen one (`seenBehind`), forward stops before an unseen one.
   * Decision (docs/plan.md Phase 4): a step during skip exits skip mode AND
   * performs the step; a step with nowhere to go still ends skip, and the
   * item left behind gets its normal timing — or, skip armed on a choice
   * (Phase 43), the choice stays open with the mode off.
   */
  function stepWalk(direction: -1 | 1): void {
    const here = currentScreen();
    const target = direction < 0 ? seenBehind(here) : forwardOf(here);
    if (target === null || !screenSeen(target)) {
      if (skipping) {
        exitSkip();
        emit();
      } else if (skipArmed) {
        skipArmed = false;
        reportSkip(); // no state moved: the flip is the only news
      }
      return;
    }
    showScreen(target, "walk");
  }

  /** Sorted view of the seen set (`visitedList`, `exportContext`). */
  function visitedSorted(): number[] {
    return [...visited].sort((a, b) => a - b);
  }

  /**
   * Restores a stored context: seen set, played and completed routes, last
   * picks, open stack, and the cursor at `lastShown` — everything but the
   * open choice (`reopenChoice`). Indices outside this manifest are dropped — a save
   * made against different content must degrade to playing, not to a cursor
   * off the end. The seen edge comes back with the seen set: `highestSeen`
   * is the restored maximum, not the landing item — otherwise a resumed
   * reader would find the wheel's forward ceiling (and the persisted
   * frontier) shrunk down to wherever the reading happened to sit.
   * `logJoins` (a restore, not a load) logs the items the context adds to
   * the seen set (`seenSince`), so persistence writes them.
   */
  function applyContext(context: MachineContext, logJoins: boolean): void {
    const next = new Set<number>();
    let seenMax = -1;
    for (const index of context.visited ?? []) {
      const value = asIndex(index, -1);
      if (value >= 0 && value < count) {
        next.add(value);
        if (value > seenMax) seenMax = value;
      }
    }
    if (logJoins) {
      for (const index of next) if (!visited.has(index)) seenLog.push(index);
    }
    visited.clear();
    for (const index of next) visited.add(index);
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
    // Completed routes restore with the same validation, and each only as
    // its route now ends (`reachedEnd`): a completion whose route end the
    // restored seen set has not reached, as after the route was extended to
    // a new end, is dropped while its played mark stays. Nested decisions
    // are checked first, so an enclosing route's check reads their filtered
    // completions. The field is newer than the rest of the context: a
    // legacy save carries none, and its known played routes say nothing
    // about completions — so the restore treats NOTHING as completed (the
    // conservative reading: the return row just stays hidden until the
    // reader finishes the continuing route once, rather than offering a
    // return to an end they may never have reached).
    const storedCompleted = new Map(
      validRouteSets(context.completedRoutes).map((set) => [
        set.decision,
        set.routes,
      ]),
    );
    completed.clear();
    for (const decision of innerFirst) {
      for (const routeIdx of storedCompleted.get(decision.index) ?? []) {
        if (reachedEnd(decision, routeIdx))
          completedOf(decision.index).add(routeIdx);
      }
    }
    // The played-this-pass record; an older save without one reads as its
    // cumulative played routes (the flow it had then).
    restorePass(validRouteSets(context.passRoutes ?? context.playedRoutes));
    passBase = null;
    lastPick.clear();
    sound?.invalidate(); // a new seen set and new picks
    for (const frame of Array.isArray(context.lastPicks)
      ? context.lastPicks
      : []) {
      const decisionIndex = asIndex(frame?.decision, -1);
      const routeIdx = asIndex(frame?.route, -1);
      if (decisionIndex < 0 || decisionIndex >= decisions.length) continue;
      if (routeIdx < 0 || routeIdx >= decisions[decisionIndex].routes.length)
        continue;
      lastPick.set(decisionIndex, routeIdx);
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

  /**
   * Whether a restored completion of route `routeIdx` of `decision` holds
   * for this manifest (docs/content-format.md, "Branches"): completion is of
   * the route as it now ends. Live play completes a route by stepping off
   * its `end` item, which is then seen, or by leaving it past that end
   * through a decision nested directly in it — a join at its `continueAt`
   * (`join`) or a pure choice's close at its fall-through
   * (`closeIfPureAndComplete`) beyond the route's end. So the completion
   * holds when the end item is seen, or when such a decision is passed
   * (`decisionPassed`, over its completions already checked). A route
   * extended to a new, unseen end fails both.
   */
  function reachedEnd(decision: ResolvedDecision, routeIdx: number): boolean {
    const route = decision.routes[routeIdx];
    if (visited.has(route.endIndex)) return true;
    return decisions.some(
      (inner) =>
        inner.parent === decision.index &&
        inner.afterIndex >= route.startIndex &&
        inner.afterIndex <= route.endIndex &&
        (inner.continuingRoute >= 0
          ? inner.continueAt
          : regionEnds[inner.index] + 1) > route.endIndex &&
        decisionPassed(inner),
    );
  }

  /**
   * Stored route sets checked against this manifest — unknown decisions and
   * routes dropped — sorted and frozen.
   */
  function validRouteSets(
    raw: readonly RouteSet[] | undefined,
  ): readonly RouteSet[] {
    const map = new Map<number, Set<number>>();
    for (const entry of Array.isArray(raw) ? raw : []) {
      const decisionIndex = asIndex(entry?.decision, -1);
      if (decisionIndex < 0 || decisionIndex >= decisions.length) continue;
      for (const routeIdx of Array.isArray(entry.routes) ? entry.routes : []) {
        const value = asIndex(routeIdx, -1);
        if (value >= 0 && value < decisions[decisionIndex].routes.length) {
          const set = map.get(decisionIndex) ?? new Set<number>();
          set.add(value);
          map.set(decisionIndex, set);
        }
      }
    }
    return routeSets(map);
  }

  /**
   * The resume's open choice: a stored `choice` whose decision this
   * manifest has is up again over the landing — a re-offer when the
   * landing is the last item of one of its routes — as a live choice.
   */
  function reopenChoice(context: MachineContext): void {
    const decisionIndex = asIndex(context.choice, -1);
    if (decisionIndex < 0 || decisionIndex >= decisions.length) return;
    const decision = decisions[decisionIndex];
    const via =
      cursor === decision.afterIndex
        ? -1
        : decision.routes.findIndex((route) => route.endIndex === cursor);
    closeFramesFor(decisionIndex);
    pendingChoice = {
      decision: decisionIndex,
      continueOption: offersContinue(decision),
      via,
    };
  }

  /**
   * The route-play context without the seen set (`Machine.exportPlace`):
   * every field is bounded by the manifest's decisions, never by how much
   * has been read.
   */
  function exportPlace(): MachinePlace {
    return Object.freeze({
      lastShown: cursor,
      stack: Object.freeze(
        stack.map((frame) =>
          Object.freeze({ decision: frame.decision, route: frame.route }),
        ),
      ),
      playedRoutes: routeSets(played),
      // The Phase 18 completion tracking: which routes were played through
      // to their end. Exported alongside `playedRoutes` even when empty —
      // an ABSENT field (a save written before this shape) restores
      // conservatively: nothing reads as completed, so the return row stays
      // hidden until the continuing route is finished once in the new
      // session.
      completedRoutes: routeSets(completed),
      // Played this pass (docs/plan.md Phase 22): the flow's record.
      passRoutes: passNow(),
      // The timeline's last picks (docs/plan.md Phase 27).
      lastPicks: exportPicks(),
      // A live choice only: a walked-to one is browsing, and a reload
      // lands on the item under it instead.
      ...(pendingChoice === null || pendingChoice.walk !== undefined
        ? {}
        : { choice: pendingChoice.decision }),
    });
  }

  /** The last picks as JSON-safe frames, by decision. */
  function exportPicks(): readonly ContextFrame[] {
    return Object.freeze(
      [...lastPick.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([decision, route]) => Object.freeze({ decision, route })),
    );
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
      const { lastShown, ...rest } = exportPlace();
      return Object.freeze({ lastShown, visited: visitedSorted(), ...rest });
    },

    exportPlace,

    seenSince(from) {
      return Object.freeze(seenLog.slice(Math.max(0, Math.trunc(from) || 0)));
    },

    importContext(context) {
      if (destroyed || count === 0) return;
      cancelAutoPick();
      applyContext(context, true);
      skipping = false; // a restore is manual navigation, like `goTo()`
      skipArmed = false; // and leaves any choice unanswered
      // UNSETTLED arrival: the item replays under its hold.
      showItem(cursor, "nav", "jump");
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    arrival() {
      return arrival;
    },

    targetSound() {
      if (soundFor?.arrival !== arrival)
        soundFor = { arrival, target: resolveSound() };
      return soundFor.target;
    },

    advance() {
      if (destroyed || count === 0) return;
      if (autoPick !== null) {
        finishAutoPick(false); // Space takes the auto-pick now
        return;
      }
      // Only the choice's own inputs answer it, a walked-to one included.
      if (pendingChoice !== null) return;
      if (skipPlaysVideo()) {
        // Space while skip plays a video (`skipPlaysVideos`, docs/plan.md
        // Phase 18) aborts the video and the burst carries on: the dwell
        // elapses now, so the step is skip's own (never-reveal included).
        cancelTimer();
        runSkip();
        return;
      }
      if (skipping) {
        // Space during skip exits skip mode AND stops on the current item:
        // exiting leaves it unset, and this press settles it in place
        // (the reader meant "stop here", not "step past this one"). In
        // auto-forward the stop also returns to manual (docs/plan.md Phase
        // 18), so the next press steps instead of only turning auto off.
        // The flag drops first, so nothing below arms a hold, and is
        // reported last: the skip pill (the emit's report) comes first.
        const wasAuto = autoAdvance;
        autoAdvance = false;
        exitSkip();
        settled = true;
        cancelTimer();
        if (!fireDecision("read")) emit();
        if (wasAuto) reportAuto(false);
        return;
      }
      if (autoAdvance) {
        // Space during auto-forward returns to manual (docs/plan.md Phase
        // 18): auto turns off and the reader stays on this item — the press
        // does not also step, the next one does (the manual rule below).
        // The item keeps its settled state; only the pending hold goes.
        setAutoFlag(false);
        cancelTimer();
        return; // no state moved: no emit (the flip has its own report)
      }
      // Immediate-complete (docs/plan.md Phase 16): one press = one step.
      // The press marks the item done and falls through to moveForward(),
      // which fires any decision before stepping.
      if (!settled) {
        settled = true;
        cancelTimer();
      }
      // Video segments (docs/plan.md Phase 49): on the last item of a
      // video's chain, while the stage plays it, the press steps to the
      // next segment instead; with none left it moves on as ever. Only
      // this manual branch steps: every branch above returned first.
      const stage = segmentStage();
      const next = stage === null ? -1 : nextSegment(stage);
      if (next >= 0) {
        showSegment(next);
        return;
      }
      moveForward();
    },

    segmentForward() {
      arrowStep(nextSegment);
    },

    segmentBack() {
      arrowStep(previousSegment);
    },

    wheelBack() {
      if (destroyed || count === 0) return;
      stepWalk(-1);
    },

    wheelForward() {
      if (destroyed || count === 0) return;
      stepWalk(1);
    },

    toggleSkip() {
      if (destroyed || count === 0) return;
      if (pendingChoice !== null) {
        // On a choice (docs/plan.md Phase 43): arm or disarm for after the
        // answer; nothing moves and no state changes, so no emit.
        skipArmed = !skipArmed;
        reportSkip();
        return;
      }
      if (skipping) {
        exitSkip(); // tab again: manual off, normal timing from here
      } else {
        // Nothing seen ahead (a fresh start, or standing on the last seen
        // item) or nothing ahead at all: the press does nothing.
        if (!skipCanStart()) return;
        skipping = true;
        beginItem(); // the current item gets a fresh dwell too
      }
      emit();
    },

    jumpToEnd() {
      if (destroyed || count === 0) return;
      // The furthest point read; already there, nothing to do.
      if (highestSeen < 0 || cursor === highestSeen) return;
      showScreen(itemScreen(highestSeen), "jump");
    },

    showChoice(decisionIndex) {
      if (destroyed || count === 0) return;
      const decision = decisions[decisionIndex];
      if (decision === undefined || !visited.has(decision.afterIndex)) return;
      showScreen(
        {
          kind: "choice",
          decision: decision.index,
          next: pickFor(decision),
          via: -1,
        },
        "jump",
      );
    },

    jumpToUnseen() {
      if (destroyed || count === 0) return;
      const target = unseenTarget();
      if (target < 0) return;
      enterRoutesAround(target);
      // A read of new content, so its media plays wherever the edge is.
      showItem(target, "advance", "jump");
    },

    hasEarlierUnseen() {
      if (destroyed || count === 0 || visited.size >= count) return false;
      const ahead = continuation();
      for (let index = 0; index < cursor; index += 1) {
        if (!reachableUnseen(index, ahead)) continue;
        if (!framesAround(index).some(declined)) return true;
      }
      return false;
    },

    goTo(index) {
      if (destroyed || count === 0) return;
      if (pendingChoice !== null) return; // a choice owns the timeline
      // A bookmark always points at content the reader had reached, but the
      // list outlives the moment it was written, so clamp defensively to
      // seen content `[0, highestSeen]`: unseen items must be entered by
      // advance() or choose() rather than consumed by a jump. (The cursor
      // may move either way — backward, or forward back to the edge of what
      // has been shown.)
      skipping = false; // manual navigation ends skip mode
      showItem(clamp(index, 0, Math.max(0, highestSeen)), "nav", "jump");
    },

    choose(routeIdx, source) {
      if (destroyed || count === 0 || pendingChoice === null) return;
      const decision = decisions[pendingChoice.decision];
      if (!Number.isInteger(routeIdx) || routeIdx < 0) return;
      if (routeIdx >= decision.routes.length) return;
      cancelAutoPick(); // the reader's own pick wins over play-all's
      pendingChoice = null;
      // The answered decision's open frames close first — a no-op after a
      // fired open, but it keeps a re-entry into the reader's own route
      // from double-pushing the frame.
      closeFramesFor(decision.index);
      // A burst the decision stopped never restarts by itself (docs/plan.md
      // Phase 16); skip armed on the choice (Tab, Phase 43) starts on the
      // route's first item (`showItem`).
      enterRoute(decision, routeIdx, source === "map" ? "jump" : "read");
      settleArm();
    },

    chooseContinue() {
      if (destroyed || count === 0) return;
      const pending = pendingChoice;
      if (pending === null || !pending.continueOption) return;
      const decision = decisions[pending.decision];
      if (decision.continueAt < 0) return;
      cancelAutoPick();
      pendingChoice = null;
      // Joining the aftermath replays none of the continuing route's items,
      // so the route is not marked played by this.
      join(decision, "read");
      settleArm();
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

    setVideoClock(clock) {
      videoClock = clock;
    },

    setSettings(next) {
      const wasSkipVideo = skipPlaysVideo();
      settings = { ...next }; // caller keeps owning its object
      if (destroyed || count === 0) return;
      // `skipVideo` is derived from the settings: tell the renderer when a
      // toggle mid-burst starts or stops the video under the cursor.
      if (skipPlaysVideo() !== wasSkipVideo) emit();
      // Play all routes turned off mid-countdown: the choice waits instead.
      // Turned on over a live choice (not one the wheel walked onto):
      // play-all answers it, counting down from the next resume.
      if (autoPick !== null && !settings.playAllRoutes) {
        cancelAutoPick();
        emit();
      } else if (autoPick === null && autoPickLiveChoice()) {
        emit();
      }
      retime();
    },

    setWords(next) {
      words = next;
      soundFor = null; // the voice may be another language's now
      if (destroyed || count === 0) return;
      emit();
      retime();
    },

    setVoiceAudible(audible) {
      if (audible === voiceAudible) return;
      voiceAudible = audible;
      if (destroyed || count === 0) return;
      retime();
    },

    setSpokenHold(index, untilMs) {
      spokenHold = untilMs === null ? null : { index, until: untilMs };
      if (destroyed || count === 0) return;
      retime();
    },

    setAutoAdvance(on) {
      setAutoFlag(on);
      if (destroyed || count === 0 || paused) return;
      if (on) {
        // Arm what is left of the current item's hold, measured from when
        // it first appeared (docs/plan.md Phase 20): an item already up
        // past its hold moves on at the next tick, a settled one included
        // (Phase 43). Skip's dwell is already running.
        if (!skipping) armHold(itemShownAt);
      } else if (!skipping) {
        cancelTimer(); // manual: no pending hold; skip's dwell keeps running
      }
    },

    isAutoAdvance() {
      return autoAdvance;
    },

    onAutoAdvanceChange(listener) {
      autoListeners.add(listener);
      return () => {
        autoListeners.delete(listener);
      };
    },

    onSkipChange(listener) {
      skipListeners.add(listener);
      return () => {
        skipListeners.delete(listener);
      };
    },

    pause() {
      if (destroyed) return;
      paused = true;
      cancelTimer();
      if (autoPickTimer !== null) scheduler.cancel(autoPickTimer);
      autoPickTimer = null;
    },

    resume() {
      if (destroyed || !paused) return;
      paused = false;
      if (autoPick !== null) {
        armAutoPick(); // the phase restarts fresh
        emit();
      }
      armHold(); // the wait restarts fresh, settled or not (interface docs)
    },

    destroy() {
      destroyed = true;
      cancelTimer();
      cancelAutoPick();
      listeners.clear();
      autoListeners.clear();
      skipListeners.clear();
    },
  };
}
