// Storage data types and the interface every adapter implements
// (docs/plan.md Phases 8-9). Pure data: no DOM, no browser globals — the
// machine and its tests read through this seam, and main.ts injects a real
// adapter.
//
// What storage holds is the id-keyed save (docs/plan.md Phase 18, "Saves
// keyed by id, not position"): `SavedContext` is the machine context with
// every item, decision and route named by its manifest id instead of its
// array position, so a content update — a prequel inserted before
// everything, a new mid-story route, a reorder, an extension — never
// re-points a save. `storage/ids.ts` converts to and from the machine's
// index form against the manifest being played. Settings ride in the same
// record because the Esc screen's settings persist them (docs/plan.md Phase 9); they
// are data for main.ts to merge over the defaults — the machine reads no
// storage.
//
// No migration (user, 2026-11-01: there are no released games): a record
// or bookmark written in the old index-based shape — a numeric
// `lastShown` / `itemIndex`, or a bare `frontier` — is dropped at load.
// Its progress reads as a first boot; its settings and help flag, which
// never referred to positions, are kept.
//
// One migration does exist (docs/plan.md Phase 27, the user is mid-game):
// contexts written while the player kept a reading history (`history`,
// `historyPos`, entries with `passRoutes` / `gap`) load silently. The
// sanitizer (storage/idb.ts) derives the last pick at each decision from
// that record and the open frames, keeps the choice screen that was up,
// and drops the record; nothing writes it again.
//
// IndexedDB schema note: `ctx` rides inside the value objects the `state`
// and `bookmarks` stores already hold, so no keyPath or store changes are
// needed and the database stays at version 1.

import type { MachineSettings } from "../machine/types";

/** An open route frame, by decision id and route id. */
export interface SavedFrame {
  readonly decision: string;
  readonly route: string;
}

/** The routes of one decision, by ids. */
export interface SavedRouteSet {
  readonly decision: string;
  readonly routes: readonly string[];
}

/**
 * The persisted route-play context (the machine's `MachineContext`, keyed
 * by id): `lastShown` the item on screen, `visited` the seen set,
 * `stack` the open frames outermost first, `playedRoutes` /
 * `completedRoutes` per decision, `lastPicks` the route last picked at
 * each decision (one frame per decision), and `choice` the decision whose
 * choice screen is up (docs/plan.md Phase 27).
 */
export interface SavedContext {
  readonly lastShown: string;
  readonly visited: readonly string[];
  readonly stack: readonly SavedFrame[];
  readonly playedRoutes: readonly SavedRouteSet[];
  readonly completedRoutes: readonly SavedRouteSet[];
  /**
   * The routes played this pass (docs/plan.md Phase 22); absent in older
   * saves, which then read as `playedRoutes`.
   */
  readonly passRoutes?: readonly SavedRouteSet[];
  /** Absent in older saves: derived from their history, else none known. */
  readonly lastPicks?: readonly SavedFrame[];
  readonly choice?: string;
}

/**
 * The branch map's remembered view (docs/plan.md Phase 33): the layout it
 * was taken on (render/mapmodel.ts `layoutSignature`), whether it was a
 * Fit, and the world point at the view's centre with the scale. The map
 * reopens there (render/mapmodel.ts `restoreView`): a Fit, or a view taken
 * on another layout, reopens as a fresh Fit.
 */
export interface SavedMapView {
  readonly layout: string;
  readonly fit: boolean;
  readonly cx: number;
  readonly cy: number;
  readonly scale: number;
}

/** Everything the player persists about reading progress and pacing. */
export interface PersistedState {
  /**
   * The id-keyed route-play context (`storage/ids.ts` converts
   * `machine.exportContext()`). Absent when nothing has been saved yet, or
   * when the stored one was unreadable or in the old index-based shape —
   * both resume as a first boot.
   */
  readonly ctx?: SavedContext;
  /**
   * The reader's settings (README Esc bullet). A partial: a record may
   * carry any subset, and the player merges it over `DEFAULT_SETTINGS` at
   * startup (main.ts). Absent means "nothing changed from the defaults".
   */
  readonly settings?: Partial<MachineSettings>;
  /**
   * True once the reader has seen the key help screen (docs/plan.md
   * Phase 13b). It is written when the first-load help closes, and read at
   * startup to decide whether to show it. Absent means false — records
   * written before Phase 13b carry no field, so their readers see the help
   * exactly once more (their first time seeing it), and then never again.
   */
  readonly helpSeen?: boolean;
  /**
   * The branch map's last view (docs/plan.md Phase 33). Absent (a first
   * load, a reset, any record written before it) means Fit.
   */
  readonly mapView?: SavedMapView;
}

/** One entry of the `b` bookmark list (README bookmark bullet). */
export interface Bookmark {
  /** Stable identifier, so a later overlay can reference one entry. */
  readonly id: string;
  /** Wall-clock capture time, in epoch milliseconds. */
  readonly timestampMs: number;
  /**
   * The id of the item on screen when `b` was pressed; restoring re-opens
   * it wherever it now sits in the manifest. A bookmark whose item is no
   * longer in the manifest is not listed (render/bookmarks.ts).
   */
  readonly itemId: string;
  /**
   * The route-play context captured with `b`: restoring it re-enters the
   * item within that route context.
   */
  readonly ctx: SavedContext;
  /** Small JPEG preview, or null/absent when nothing was capturable. */
  readonly thumbDataUrl?: string | null;
}

/**
 * What the `t` list needs to draw a row before anything heavy is read (the
 * bookmark-screen speed item, docs/progress.md): a stored bookmark minus
 * its route context and thumbnail. `key` names the stored record for
 * `getBookmark` (the IndexedDB row's `seq`); `hasThumb` says whether that
 * record carries a captured thumbnail, so a row without one can show its
 * manifest still at once.
 */
export interface BookmarkSummary {
  readonly key: number;
  readonly id: string;
  readonly timestampMs: number;
  readonly itemId: string;
  readonly hasThumb: boolean;
}

/**
 * Everything the player stores. `addBookmark` returns the whole list after
 * the append as summaries, oldest first — insertion order, never re-sorted
 * by clock — so the caller needs no separate read to know what the list
 * now holds. `listBookmarks` is that list on its own: cheap whatever the
 * bookmarks' contexts and thumbnails weigh; `getBookmark` reads one whole
 * record (its thumbnail, its context for a restore); `getBookmarks` reads
 * every whole record (export). Methods reject only on real adapter failure;
 * callers must catch and carry on (a storage outage must never break
 * reading).
 */
export interface Storage {
  loadState(): Promise<PersistedState | null>;
  saveState(state: PersistedState): Promise<void>;
  addBookmark(bookmark: Bookmark): Promise<BookmarkSummary[]>;
  getBookmarks(): Promise<Bookmark[]>;
  listBookmarks(): Promise<BookmarkSummary[]>;
  /** The whole bookmark behind a summary's `key`; null once it is gone. */
  getBookmark(key: number): Promise<Bookmark | null>;
  /**
   * The `t` list's "x" (docs/plan.md Phase 18, "Delete a bookmark"):
   * remove this content's bookmark with that `id` and return the list
   * that remains, oldest first, as summaries. Resolves once the deletion
   * is COMMITTED; an unknown id deletes nothing and returns the list
   * unchanged.
   */
  deleteBookmark(id: string): Promise<BookmarkSummary[]>;
  /**
   * "Reset progress" (docs/plan.md Phase 16): drop this content's state
   * row / rows, as if it had never been read. `deleteState` removes the
   * one `state` record and `deleteBookmarks` every `bookmarks` row of
   * this content; both resolve only once the deletion is COMMITTED, so a
   * caller can reload right after and never see a half-deleted record
   * (the verify-step-40 lesson: an uncommitted delete plus a reload
   * strands the next boot). Deleting again is a no-op.
   */
  deleteState(): Promise<void>;
  deleteBookmarks(): Promise<void>;
  /**
   * "Import progress" (docs/plan.md Phase 21): make this content's
   * progress exactly `state` and `bookmarks` (in that order) — the state
   * record is overwritten and every existing bookmark row removed — in one
   * transaction where the adapter has them, resolving once COMMITTED, so
   * the reload that follows reads the import whole or not at all.
   */
  replaceProgress(
    state: PersistedState,
    bookmarks: readonly Bookmark[],
  ): Promise<void>;
}

/** The `t` list's row for a stored bookmark under `key`. */
export function summarizeBookmark(
  key: number,
  bookmark: Bookmark,
): BookmarkSummary {
  const thumb = bookmark.thumbDataUrl;
  return {
    key,
    id: bookmark.id,
    timestampMs: bookmark.timestampMs,
    itemId: bookmark.itemId,
    hasThumb: typeof thumb === "string" && thumb !== "",
  };
}

/**
 * A stored map view read defensively: the well-formed shape (a string
 * layout, a boolean fit, finite centre, a positive finite scale) or
 * undefined (reads as Fit). Never throws.
 */
export function sanitizeMapView(raw: unknown): SavedMapView | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return undefined;
  const v = raw as Record<string, unknown>;
  const finite = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n);
  if (
    typeof v.layout !== "string" ||
    typeof v.fit !== "boolean" ||
    !finite(v.cx) ||
    !finite(v.cy) ||
    !finite(v.scale) ||
    v.scale <= 0
  )
    return undefined;
  return { layout: v.layout, fit: v.fit, cx: v.cx, cy: v.cy, scale: v.scale };
}

/**
 * The Phase 13b migration rule stated as data: the key help has been seen
 * only when a record says so. A null state (first-ever load) and any
 * pre-13b record both read as false, so their readers see the help once.
 * Anything not exactly `true` — absent, null, a foreign value — is false.
 */
export function helpSeenFrom(state: PersistedState | null): boolean {
  return state !== null && state.helpSeen === true;
}
