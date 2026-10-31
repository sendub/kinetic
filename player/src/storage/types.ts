// Storage data types and the interface every adapter implements
// (docs/plan.md Phase 8). Pure data: no DOM, no browser globals — the machine
// and its tests read through this seam, and main.ts injects a real adapter.
//
// The frontier is the single persisted source of truth: the resume position
// is always `frontier - 1` (the README's "state the game starts at when
// loaded"), which `createMachine` derives itself via `resumeFrontier`, so
// the cursor needs no storing and can never disagree with it.

/** Everything the player persists about reading progress. */
export interface PersistedState {
  /** The first never-shown item; see the machine's frontier invariant. */
  readonly frontier: number;
}

/** One entry of the `b` bookmark list (README bookmark bullet). */
export interface Bookmark {
  /** Stable identifier, so a later overlay can reference one entry. */
  readonly id: string;
  /** Wall-clock capture time, in epoch milliseconds. */
  readonly timestampMs: number;
  /** The machine's cursor when `b` was pressed; resumes re-open this item. */
  readonly itemIndex: number;
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
}
