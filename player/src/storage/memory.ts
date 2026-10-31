// In-memory fake of the Storage contract (docs/plan.md Phase 8). The whole
// point is the seam: machine-level tests drive a real `Storage` without a
// browser, and the behaviour matches the IndexedDB adapter — frontier-only
// state, append-ordered bookmarks, and copies in and out so a caller can
// never mutate what the store holds.

import type { Bookmark, PersistedState, Storage } from "./types";

export function createMemoryStorage(): Storage {
  let state: PersistedState | null = null;
  const bookmarks: Bookmark[] = [];

  function readBookmarks(): Bookmark[] {
    return bookmarks.map((bookmark) => ({ ...bookmark }));
  }

  return {
    loadState() {
      return Promise.resolve(state === null ? null : { ...state });
    },

    saveState(next) {
      // Normalise to the contract's fields: nothing but the frontier rides
      // along, so a caller holding a fatter object cannot leak state in.
      state = { frontier: next.frontier };
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
