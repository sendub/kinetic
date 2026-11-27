// Manifest and machine data types. Mirrors docs/content-schema.json; the
// semantics live in docs/content-format.md. Pure data: no DOM, no runtime
// dependencies, and no code in this module.

export type ItemType = "image" | "animation" | "video" | "text";

/** Shared overlay fields. Empty or absent `text` means a bare visual. */
interface OverlayFields {
  speaker?: string;
  /**
   * The line. It may hold Ren'Py text tags (docs/content-format.md, "Text
   * tags"); the same rule applies to decision prompts, route labels and
   * their translations.
   */
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

/**
 * A sound file the items name by id (docs/content-format.md, "Tracks").
 * Several ids may share one file.
 */
export interface AudioTrack {
  /** A media path (Naming conventions) with an audio extension. */
  file: string;
  /** Authoritative length: the player never reads the element's own. */
  durationSeconds: number;
  /** Where a play starts, default 0. */
  startSeconds?: number;
  /** Where a loop restarts, default `startSeconds`. */
  loopStartSeconds?: number;
  /** Music and ambience only: whether the track loops, default true. */
  loop?: boolean;
  /** The author's level, 0 to 1, default 1. */
  volume?: number;
}

/** The manifest's top-level `audio` (docs/content-format.md, "Audio"). */
export interface ManifestAudio {
  /** Track id to track. */
  tracks: Readonly<Record<string, AudioTrack>>;
}

/**
 * A character's voice (docs/content-format.md, "Voices"): the reference
 * clip spoken lines in that voice are generated from on the reader's
 * machine.
 */
export interface ManifestVoice {
  /**
   * The reference clip: a media path (Naming conventions) with an audio
   * extension, read from the script beside it as a track's file is.
   */
  file: string;
  /** What the clip says. */
  text?: string;
  /** The description the voice was designed from. */
  description?: string;
}

/** One one-shot of an item (`ItemAudio.sfx`). */
export interface SfxCue {
  track: string;
  /** Wait before it starts, in ms, default 0. */
  delayMs?: number;
  /** A one-shot on a channel stops the one already playing on it. */
  channel?: string;
}

/** A video item's own soundtrack, played as a separate synced track. */
export interface VideoSound {
  track: string;
  /** Scales music and ambience while it plays, 0 to 1, default 1. */
  duck?: number;
}

/**
 * An item's sound (docs/content-format.md, "Item audio"). Music and
 * ambience carry on to later items (`Machine.targetSound`); one-shots and
 * voice belong to this item alone.
 */
export interface ItemAudio {
  /** The music from this item on: a track id, or null to stop it. */
  music?: string | null;
  /** The whole set of ambience loops from this item on; `[]` stops them. */
  ambience?: readonly string[];
  /** The fade for this item's music and ambience changes, ms, default 1000. */
  fadeMs?: number;
  sfx?: readonly SfxCue[];
  /** Track id of the item's voice line. */
  voice?: string;
}

/** A video item's sound: the common fields plus its own soundtrack. */
export interface VideoItemAudio extends ItemAudio {
  videoSound?: VideoSound;
}

/**
 * How a visual item's picture replaces the one before it
 * (docs/content-format.md, "Transitions"): `dissolve` fades the new
 * picture in over the old over `seconds` (above 0, at most 5); `fade`
 * takes the old to black over `out`, holds black for `hold`, and brings the
 * new in over `in` (each 0 to 5, `out` or `in` above 0). Only the picture
 * changes over time: the item's text and speaker show at once, and skip,
 * the wheel, back, jumps and reduced motion cut. The content validator
 * enforces the ranges, which the player trusts.
 */
export type Transition =
  | { kind: "dissolve"; seconds: number }
  | { kind: "fade"; out: number; hold: number; in: number };

/**
 * The colours one speaker is drawn in (docs/content-format.md,
 * "Characters"), each `#rrggbb` in either case; absent, the player's own.
 */
export interface CharacterStyle {
  /** The speaker's name. */
  nameColor?: string;
  /** The speaker's lines. */
  textColor?: string;
}

export interface ImageItem extends OverlayFields {
  id: string;
  type: "image";
  file: string;
  audio?: ItemAudio;
  transition?: Transition;
}

export interface AnimationItem extends OverlayFields {
  id: string;
  type: "animation";
  audio?: ItemAudio;
  transition?: Transition;
  /** Ordered frames, at least two. */
  frames: readonly string[];
  /**
   * Frames per second, greater than 0: the even pace without
   * `frameSeconds`, and an older player's pace with it.
   */
  fps: number;
  /**
   * Each frame's display time in seconds, one per frame, each greater than
   * 0, in place of even timing at `fps` (docs/content-format.md, "Items").
   * Ignored when it does not fit `frames` (the validator refuses it).
   */
  frameSeconds?: readonly number[];
  /** Times the sequence plays before auto-advance, at least 1. */
  loopCount: number;
  /**
   * After `loopCount` loops the last frame stays, under the `text` items
   * after it too, instead of looping on; their stills show it
   * (docs/content-format.md, "Text items").
   */
  holdLastFrame?: boolean;
}

export interface VideoItem extends OverlayFields {
  id: string;
  type: "video";
  file: string;
  poster: string;
  /**
   * The still of the range's last frame (docs/content-format.md, "Text
   * items"), shown in place of the poster on the lines after a video that
   * holds it (`holdLastFrame`). Ignored without `holdLastFrame`.
   */
  lastFrame?: string;
  /**
   * After `loopCount` passes the video holds paused at its end, under the
   * `text` items after it too, instead of looping on; their stills show
   * `lastFrame` (docs/content-format.md, "Text items"). Its holds are a
   * looping video's.
   */
  holdLastFrame?: boolean;
  durationSeconds: number;
  audio?: VideoItemAudio;
  transition?: Transition;
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
  /**
   * The file's camera views in order, at least one (docs/content-format.md,
   * "Video segments"). Space after the item's lines steps through them
   * before leaving the item. Times are file times, compared exactly and
   * free of the item's own range; the content validator enforces their
   * order and bounds, which the player trusts.
   */
  segments?: readonly VideoSegment[];
}

/**
 * One view of a video item's file (`VideoItem.segments`), in exact
 * fractional seconds.
 */
export interface VideoSegment {
  /** Where the view starts, at least 0, at or after the previous view's end. */
  startSeconds: number;
  /**
   * Where the view's loop restarts, at least 0 and less than `endSeconds`,
   * default `startSeconds`; below `startSeconds` is legal.
   */
  loopStartSeconds?: number;
  /** Where the view ends: after `startSeconds`, at most `durationSeconds`. */
  endSeconds: number;
}

/**
 * Dialogue over a visual already on screen. Carries no media fields: the
 * visual displayed is the nearest earlier media-bearing item's, which keeps
 * playing underneath the chain (docs/content-format.md, "Text items").
 */
export interface TextItem extends OverlayFields {
  id: string;
  type: "text";
  audio?: ItemAudio;
}

export type Item = ImageItem | AnimationItem | VideoItem | TextItem;

/**
 * What happens when a route's span completes (docs/content-format.md,
 * "Branches"). `"ending"` — the default — means the span's last item IS the
 * ending, so afterwards the overlay offers only route reselection; `"return"`
 * means the overlay also offers "return to main route", which proceeds to the
 * decision's `continueAt`; `"continue"` means flow proceeds to the decision's
 * `continueAt` after the route, as the continuing route's does (under Play
 * all routes it re-offers as a `"return"` route does while a route of the
 * decision is unplayed this pass). A continuing route's own `result` is moot.
 */
export type RouteResult = "return" | "ending" | "continue";

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
  /**
   * Defaults to `"ending"`: there is no implicit join into the main line;
   * `"continue"` is the explicit one, and needs `continuingRoute`.
   */
  result?: RouteResult;
  /**
   * On a decision with `follows`: the routes of the followed decision this
   * route takes (docs/content-format.md, "Branches"). With Play all routes
   * off, the reader's last pick there enters this route with no choice
   * screen. Absent on at most one route, which takes every followed route
   * no other route names.
   */
  when?: readonly string[];
  /**
   * Id of a shared span read after this route's end (docs/content-format.md,
   * "Branches"): a span of this route's decision or of one enclosing it. The
   * span's `result` then acts in place of this route's, and the route
   * completes when its span does. A player older than 1.15.0 ignores it:
   * the route acts on its own `result`.
   */
  then?: string;
}

/**
 * A stretch of items several routes read after their ends, laid out once
 * (docs/content-format.md, "Branches"): a decision's `shared` entry.
 */
export interface SharedSpan {
  /** Unique among its decision's route and span ids. */
  id: string;
  /** Id of the span's first item. */
  start: string;
  /** Id of the span's last item. */
  end: string;
  /** What happens at the span's end, as a route's result; `"ending"` by default. */
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
  /**
   * Id of an earlier decision this one follows (docs/content-format.md,
   * "Branches"): its routes' `when` name that decision's routes. With Play
   * all routes off it takes the route matching the reader's last pick
   * there, with no choice screen, or passes on to `continueAt` when no
   * route takes it; with no pick known, and under Play all routes, it is
   * an ordinary choice (the match played last).
   */
  follows?: string;
  /** Spans its routes (or those of decisions it encloses) read via `then`. */
  shared?: readonly SharedSpan[];
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
  /**
   * Optional release of the game as its author names it, such as `1.2`
   * or `0.9 beta` (docs/content-format.md): shown after the title on the
   * Esc help screen. Not the format's `schemaVersion`. Absent: none.
   */
  version?: string;
  /**
   * Optional BCP 47 tag of the manifest's own text, the base every
   * language file translates (docs/content-format.md, "Translations").
   * Absent: `en`.
   */
  language?: string;
  /**
   * Optional tags of the folder's language files, `lang/<tag>.json` and
   * its `lang/<tag>.js` each; never the base `language`.
   */
  languages?: readonly string[];
  width: number;
  height: number;
  /** Position in the array is position in the novel. */
  items: readonly Item[];
  /** Optional branch decisions over the same item array; absent is linear. */
  branches?: readonly Branch[];
  /** Optional sound; absent plays silent (docs/content-format.md, "Audio"). */
  audio?: ManifestAudio;
  /**
   * Optional speaker name, exactly as items' `speaker` gives it, to that
   * character's voice (docs/content-format.md, "Voices").
   */
  voices?: Readonly<Record<string, ManifestVoice>>;
  /** Optional voice for items with text and no speaker. */
  narrator?: ManifestVoice;
  /**
   * Optional speaker name, exactly as items' `speaker` gives it, to the
   * colours that speaker's name and lines are drawn in
   * (docs/content-format.md, "Characters"). A language file's `speakers`
   * table changes only the name drawn, so a translated name keeps them.
   */
  characters?: Readonly<Record<string, CharacterStyle>>;
}

/**
 * One translated string of a language file (docs/content-format.md,
 * "Translations"): the text drawn in that language, and the hash of the
 * base text it was made from.
 */
export interface Translation {
  text: string;
  /** First 8 lowercase hex digits of the base string's SHA-256. */
  from?: string;
}

/** A decision's prompt and route labels in one language. */
export interface TranslatedDecision {
  prompt?: Translation;
  /** Route id, unique within its decision, to its label. */
  routes?: Readonly<Record<string, Translation>>;
}

/**
 * A language file, `lang/<tag>.json`, which its script `lang/<tag>.js`
 * hands the player (docs/content-format.md, "Translations"). Every
 * string falls back to the manifest's own when absent.
 */
export interface LanguageFile {
  /** The file's tag, equal to its name and listed in `languages`. */
  language: string;
  /** The language's name in itself; absent: `Intl.DisplayNames`. */
  name?: string;
  title?: Translation;
  version?: Translation;
  /** Item id to its text. */
  items?: Readonly<Record<string, Translation>>;
  /** Speaker exactly as the manifest gives it to the name drawn. */
  speakers?: Readonly<Record<string, string>>;
  /** Decision id to its prompt and labels. */
  decisions?: Readonly<Record<string, TranslatedDecision>>;
  /**
   * This language's own recorded voice lines (docs/plan.md Phase 56 item
   * 6): its tracks, ids of its own, and item id to the track speaking the
   * item's translated text.
   */
  voice?: {
    tracks?: Readonly<Record<string, AudioTrack>>;
    items?: Readonly<Record<string, string>>;
  };
  /** Base voice recordings play under this language's text; default false. */
  keepOriginalVoice?: boolean;
}

/**
 * The manifest's words as the reader is shown them (docs/plan.md Phase 56
 * item 3): a game's language file may translate an item's text, a
 * decision's prompt and a route's label. The machine times and counts
 * what is drawn, so it reads them through this; without it, the
 * manifest's own. The renderer builds it from the language in use
 * (render/gamewords.ts).
 */
export interface MachineWords {
  /**
   * Item `index`'s text as drawn and the reading-time factor of the
   * language it is drawn in (1 for most; docs/content-format.md "Timing").
   */
  itemText(index: number): {
    readonly text: string | undefined;
    readonly factor: number;
  };
  /** A decision's prompt as drawn; `base` is the manifest's. */
  prompt(decisionId: string, base: string): string;
  /** A route's label as drawn; `base` is the manifest's. */
  label(decisionId: string, routeId: string, base: string): string;
  /**
   * Item `index`'s recorded voice line in the language shown (docs/plan.md
   * Phase 56 item 6; render/linevoice.ts): the track's key in the sound's
   * table and the track, undefined when no table has it; null for none
   * (a translation's line spoken live, or silent). Absent: the item's own
   * `audio.voice` and the manifest's tracks.
   */
  voice?(index: number): {
    readonly id: string;
    readonly track: AudioTrack | undefined;
  } | null;
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
  /**
   * The browser tab's Display setting (docs/plan.md Phase 43): Fullscreen
   * (true, the default) or Window, set on the Esc screen. While on, a key
   * or click made while windowed asks for fullscreen again
   * (render/fullscreen.ts).
   * A game app owns its own display mode instead (render/host.ts), so
   * there the page neither reads nor changes it. Stored with the others
   * (so it persists and travels with exported progress; a record or file
   * from before it reads as Fullscreen); the machine never reads it.
   */
  fullscreen: boolean;
  /**
   * Sound on or off (docs/plan.md Phase 47); default true. Off, nothing
   * sounds; turned on, the screen's music and ambience start, with no
   * one-shots and no voice restart (render/audio.ts). A game without audio
   * ignores it. The machine reads none of the sound settings.
   */
  soundOn: boolean;
  /** The Music group's volume, music and ambience, 0 to 1; default 1. */
  musicVolume: number;
  /** The Effects group's volume, one-shots and video sound, 0 to 1; default 1. */
  effectsVolume: number;
  /**
   * The Voice group's volume, 0 to 1; default 1. At 0 no spoken line is
   * asked of the voice engine (docs/plan.md Phase 52 item 10; there is no
   * Spoken lines switch).
   */
  voiceVolume: number;
  /**
   * The game language the reader picked on the Esc screen's Language
   * control (docs/plan.md Phase 56 item 3), a tag of the base or one of
   * the manifest's `languages`; "" (the default) for none picked, when
   * the game opens in the browser's language if it has it. A reader
   * setting stored with the others, per story; the machine never reads it.
   */
  language: string;
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
  fullscreen: true,
  soundOn: true,
  musicVolume: 1,
  effectsVolume: 1,
  voiceVolume: 1,
  language: "",
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
   * here. A restored completion counts only while its route's current end
   * has been reached (machine.ts `reachedEnd`), so one whose route was
   * extended to an unseen end is dropped. The field is newer than the rest
   * of the context: absent (a legacy save) restores as nothing-completed,
   * the conservative reading — the row simply stays hidden until the reader
   * finishes the continuing route once.
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
   * opens it again (a play-all countdown restarts), however it opened: by
   * reading, at a route's end, or by the wheel walking onto it (docs/
   * plan.md Phase 60, item 9c; it reopens as a live choice). Absent: no
   * choice.
   */
  choice?: number;
}

/**
 * The route-play context without its seen set (docs/plan.md Phase 46,
 * `Machine.exportPlace`): the reader's place, open frames, route records
 * and picks. Its size is bounded by the manifest's decisions, so a save on
 * every screen change can carry it whatever has been read.
 */
export type MachinePlace = Omit<MachineContext, "visited">;

/**
 * How the item under the cursor became current. `advance` is a forward step
 * the reader took or the auto timer took — a space press or the auto-advance
 * firing, onto the next item or the join, close or route entry it reaches
 * (a route's end at `continueAt`, a decision passing on, a route picked on
 * the choice screen, play-all's auto-pick, a following decision's route;
 * docs/plan.md Phase 60 item 9d) — so the item is being READ now and its
 * media plays. `nav` is an arrival at content the reader already has on
 * the map: the wheel, a bookmark `goTo()`, a bookmark restore, `e`, a
 * branch-map jump into a route, skip's dwell step, and the load-time
 * landing. Scrubbing
 * stays fast, so a nav arrival below the seen edge holds the poster. The
 * renderer reads this with `cursor`/`frontier` to decide whether a video
 * replays (docs/content-format.md, "Timing"; `playbackModeFor`).
 */
export type TransitionKind = "advance" | "nav";

/**
 * How the reader reached the screen on show (docs/plan.md Phase 47, item
 * 4), for the sound: a different split from `TransitionKind`, which it
 * leaves as it is.
 *
 * - `read`: Space, auto-forward, a pick on a choice screen (a number key,
 *   Enter, a click, `0`'s return row, play-all's pick) entering where it
 *   leads, and a join or a pure choice's close reached by reading on.
 * - `skip`: each step of a Tab skip burst, a join or close it passes
 *   included.
 * - `walk`: a wheel step.
 * - `jump`: `e`, `u`, a bookmark, a branch-map click (a decision, or a
 *   route: `choose(route, "map")`), and the load, which a reload, Import
 *   and Reset all go through.
 */
export type ArrivalKind = "read" | "skip" | "walk" | "jump";

/**
 * One arrival (`Machine.arrival`). `number` grows by one on every arrival,
 * a re-arrival at the same item or a wheel step onto the choice screen
 * over it included, and never on a re-emit (a settle, a choice opening, a
 * skip or settings flip). The load is arrival 1.
 */
export interface Arrival {
  readonly kind: ArrivalKind;
  readonly number: number;
}

/**
 * What should sound on the screen on show (`Machine.targetSound`;
 * docs/content-format.md, "What plays at an item").
 */
export interface TargetSound {
  /** The music track id, or null for none. */
  readonly music: string | null;
  /**
   * The ambience loops, as the item that set them lists them (the same
   * array object for the same set); empty for none.
   */
  readonly ambience: readonly string[];
  /** The voice line of the item on show; null when it has none. */
  readonly voice: string | null;
  /**
   * The soundtrack of the video the screen shows (the item's own, or the
   * one under its text chain), `duck` defaulted to 1; null when the
   * visual is no video or the video has none.
   */
  readonly videoSound: { readonly track: string; readonly duck: number } | null;
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
 * resume landing on an item that was read before), so the next
 * `advance()` moves on. `skipping` means a skip burst (tab) is running: the
 * machine advances every picture after `settings.skipDwellMs` regardless
 * of media and every `text` item after zero time (skip turned on over an
 * open choice waits for the answer and is not `skipping` until it runs;
 * `Machine.onSkipChange` reports the mode). While it is true the
 * renderer hides the caption (docs/plan.md Phase 18) and must show an animation's first
 * frame and a video's poster as stills and never play media (unless
 * `skipVideo` says skip is playing the video) — the machine
 * only times, it cannot stop a playing element. `choice` is present while a
 * branch decision awaits the reader: it is the overlay's content, and while
 * it is set space and bookmark jumps are inert, and tab only switches skip
 * on or off for after the answer, until `choose()` or `chooseContinue()`
 * answers it; the wheel and `e` walk on and leave it.
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
   * Present while the cursor stands on an ENDING — the array end, an
   * ending route's last item, or a route's last item where a pure choice's
   * close ended the story (Phase 43) — with no choice open (docs/plan.md
   * Phase 18, "End card"): the render layer
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
  /**
   * Present while a segment of the video on screen is active (docs/plan.md
   * Phase 49, docs/content-format.md "Video segments"): a manual Space on
   * the last item of the video's chain stepped to it, and the stage plays
   * that segment instead of the item's own range. Absent on every arrival
   * at an item, and whenever no step has been made since.
   */
  readonly segment?: SegmentView;
  /**
   * Present (true) while the skip burst running is a shared span's own
   * (docs/content-format.md, "Branches"): under Play all routes a route
   * reaching a span another route of this pass has reached already skips
   * through it, and the pill says it was read already. `skipping` is true
   * with it; Space stops the burst as it stops Tab's.
   */
  readonly readAgain?: true;
}

/**
 * The active segment (`MachineState.segment`): which of the video item's
 * `segments` is on, for the stage to play and for a "View n of m" note
 * (n is `index + 1`, m is `count`).
 */
export interface SegmentView {
  /** Index into the video item's `segments`, from 0. */
  readonly index: number;
  /** The number of the item's `segments`. */
  readonly count: number;
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
