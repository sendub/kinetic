// In-memory fake of the Storage contract (docs/plan.md Phases 8-9). The
// whole point is the seam: machine-level tests drive a real `Storage`
// without a browser, and the behaviour matches the IndexedDB adapter —
// frontier + optional settings state, append-ordered bookmarks, and copies
// in and out so a caller can never mutate what the store holds.

import type { Bookmark, PersistedState, Storage } from "./types";

/**
 * Normalise to the contract's fields: nothing but `frontier` and a copied
 * `settings` ride along, so a caller holding a fatter object cannot leak
 * state in, and mutating a handed-out state cannot reach back.
 */
function normalizeState(next: PersistedState): PersistedState {
  return next.settings === undefined
    ? { frontier: next.frontier }
    : { frontier: next.frontier, settings: { ...next.settings } };
}

export function createMemoryStorage(): Storage {
  let state: PersistedState | null = null;
  const bookmarks: Bookmark[] = [];

  function readBookmarks(): Bookmark[] {
    return bookmarks.map((bookmark) => ({ ...bookmark }));
  }

  return {
    loadState() {
      return Promise.resolve(state === null ? null : normalizeState(state));
    },

    saveState(next) {
      state = normalizeState(next);
      return Promise.resolve();
    },

    addBookmark(bookmark) {
      bookmarks.push({ ...bookmark });
      return Promise.resolve(readBookmarks());
    },

    getBookmarks() {
      return Promise.resolve(readBookmarks());
    },
  };
}
