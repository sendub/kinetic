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
// record because the `c` screen persists them (docs/plan.md Phase 9); they
// are data for main.ts to merge over the defaults — the machine reads no
// storage.
//
// No migration (user, 2026-11-01: there are no released games): a record
// or bookmark written in the old index-based shape — a numeric
// `lastShown` / `itemIndex`, or a bare `frontier` — is dropped at load.
// Its progress reads as a first boot; its settings and help flag, which
// never referred to positions, are kept.
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

/**
 * One reading-history screen by ids (the machine's `HistoryEntry`): the
 * item shown, the frames open over it, and — for a choice screen — the
 * decision whose overlay it was.
 */
export interface SavedHistoryEntry {
  readonly item: string;
  readonly stack: readonly SavedFrame[];
  readonly decision?: string;
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
 * `completedRoutes` per decision, and the reading history with
 * `historyPos` the entry on screen (an index into `history` itself, not
 * into the manifest). Bookmarks store it without the history.
 */
export interface SavedContext {
  readonly lastShown: string;
  readonly visited: readonly string[];
  readonly stack: readonly SavedFrame[];
  readonly playedRoutes: readonly SavedRouteSet[];
  readonly completedRoutes: readonly SavedRouteSet[];
  readonly history?: readonly SavedHistoryEntry[];
  readonly historyPos?: number;
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
   * The reader's settings (README `c` bullet). A partial: a record may
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
   * The route-play context captured with `b`, without its history:
   * restoring it re-enters the item within that route context.
   */
  readonly ctx: SavedContext;
  /** Small JPEG preview, or null/absent when nothing was capturable. */
  readonly thumbDataUrl?: string | null;
}

/**
 * Everything the player stores. `addBookmark` returns the whole list after
 * the append, oldest first — insertion order, never re-sorted by clock — so
 * the caller needs no separate read to know what the list now holds.
 * Methods reject only on real adapter failure; callers must catch and carry
 * on (a storage outage must never break reading).
 */
export interface Storage {
  loadState(): Promise<PersistedState | null>;
  saveState(state: PersistedState): Promise<void>;
  addBookmark(bookmark: Bookmark): Promise<Bookmark[]>;
  getBookmarks(): Promise<Bookmark[]>;
  /**
   * The `t` list's "x" (docs/plan.md Phase 18, "Delete a bookmark"):
   * remove this content's bookmark with that `id` and return the list
   * that remains, oldest first. Resolves once the deletion is COMMITTED;
   * an unknown id deletes nothing and returns the list unchanged.
   */
  deleteBookmark(id: string): Promise<Bookmark[]>;
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
