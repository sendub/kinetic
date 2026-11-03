// In-memory fake of the Storage contract (docs/plan.md Phases 8-9). The
// whole point is the seam: machine-level tests drive a real `Storage`
// without a browser, and the behaviour matches the IndexedDB adapter —
// optional id-keyed ctx + optional settings + optional helpSeen state,
// append-ordered bookmarks, and copies in and out so a caller can never
// mutate what the store holds.

import type { MachineSettings } from "../machine/types";
import type {
  Bookmark,
  BookmarkSummary,
  PersistedState,
  SavedContext,
  SavedRouteSet,
  Storage,
} from "./types";
import { summarizeBookmark } from "./types";

/**
 * A deep copy of a stored context: the IndexedDB adapter structured-clones
 * the nested arrays on the way in and out, so the fake must not hand the
 * same arrays to caller and store.
 */
function copyContext(context: SavedContext): SavedContext {
  const routeSets = (entries: readonly SavedRouteSet[]) =>
    entries.map((entry) => ({
      decision: entry.decision,
      routes: [...entry.routes],
    }));
  return {
    lastShown: context.lastShown,
    visited: [...context.visited],
    stack: context.stack.map((frame) => ({ ...frame })),
    playedRoutes: routeSets(context.playedRoutes),
    completedRoutes: routeSets(context.completedRoutes),
    ...(context.passRoutes === undefined
      ? {}
      : { passRoutes: routeSets(context.passRoutes) }),
    ...(context.lastPicks === undefined
      ? {}
      : { lastPicks: context.lastPicks.map((frame) => ({ ...frame })) }),
    ...(context.choice === undefined ? {} : { choice: context.choice }),
  };
}

/**
 * Normalise to the contract's fields: nothing but a copied `ctx`, a
 * copied `settings` and the help flag ride along, so a caller holding a fatter
 * object cannot leak state in, and mutating a handed-out state cannot
 * reach back.
 */
function normalizeState(next: PersistedState): PersistedState {
  const state: {
    ctx?: SavedContext;
    settings?: Partial<MachineSettings>;
    helpSeen?: boolean;
  } = {};
  if (next.ctx !== undefined) state.ctx = copyContext(next.ctx);
  if (next.settings !== undefined) state.settings = { ...next.settings };
  // The key-help flag (Phase 13b): a real boolean rides along; a foreign
  // value does not, which reads back as "not seen".
  if (typeof next.helpSeen === "boolean") state.helpSeen = next.helpSeen;
  return state;
}

function copyBookmark(bookmark: Bookmark): Bookmark {
  return { ...bookmark, ctx: copyContext(bookmark.ctx) };
}

export function createMemoryStorage(): Storage {
  let state: PersistedState | null = null;
  // Each bookmark under its key, in insertion order; keys never repeat,
  // like the IndexedDB rows' auto-increment `seq`.
  const bookmarks: { key: number; bookmark: Bookmark }[] = [];
  let nextKey = 1;

  function readBookmarks(): Bookmark[] {
    return bookmarks.map((row) => copyBookmark(row.bookmark));
  }

  function summaries(): BookmarkSummary[] {
    return bookmarks.map((row) => summarizeBookmark(row.key, row.bookmark));
  }

  function append(bookmark: Bookmark): void {
    bookmarks.push({ key: nextKey, bookmark: copyBookmark(bookmark) });
    nextKey += 1;
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
      append(bookmark);
      return Promise.resolve(summaries());
    },

    getBookmarks() {
      return Promise.resolve(readBookmarks());
    },

    listBookmarks() {
      return Promise.resolve(summaries());
    },

    getBookmark(key) {
      const row = bookmarks.find((entry) => entry.key === key);
      return Promise.resolve(
        row === undefined ? null : copyBookmark(row.bookmark),
      );
    },

    deleteBookmark(id) {
      const index = bookmarks.findIndex((row) => row.bookmark.id === id);
      if (index !== -1) bookmarks.splice(index, 1);
      return Promise.resolve(summaries());
    },

    deleteState() {
      state = null;
      return Promise.resolve();
    },

    deleteBookmarks() {
      bookmarks.length = 0;
      return Promise.resolve();
    },

    replaceProgress(next, imported) {
      state = normalizeState(next);
      bookmarks.length = 0;
      for (const bookmark of imported) append(bookmark);
      return Promise.resolve();
    },
  };
}
