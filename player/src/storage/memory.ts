// In-memory fake of the Storage contract (docs/plan.md Phases 8-9). The
// whole point is the seam: machine-level tests drive a real `Storage`
// without a browser, and the behaviour matches the IndexedDB adapter —
// frontier + optional ctx + optional settings + optional helpSeen state,
// append-ordered bookmarks, and copies in and out so a caller can never
// mutate what the store holds.

import type { MachineContext, MachineSettings } from "../machine/types";
import type { Bookmark, PersistedState, Storage } from "./types";

/**
 * A deep copy of a stored context: the IndexedDB adapter structured-clones
 * the nested arrays on the way in and out, so the fake must not hand the
 * same arrays to caller and store.
 */
function copyContext(context: MachineContext): MachineContext {
  const routeSets = (
    entries: readonly { decision: number; routes: readonly number[] }[],
  ) =>
    entries.map((entry) => ({
      decision: entry.decision,
      routes: [...entry.routes],
    }));
  return {
    lastShown: context.lastShown,
    visited: [...context.visited],
    stack: context.stack.map((frame) => ({ ...frame })),
    playedRoutes: routeSets(context.playedRoutes),
    ...(context.completedRoutes === undefined
      ? {}
      : { completedRoutes: routeSets(context.completedRoutes) }),
    ...(context.history === undefined
      ? {}
      : {
          history: context.history.map((entry) => ({
            ...entry,
            stack: entry.stack.map((frame) => ({ ...frame })),
          })),
        }),
    ...(context.historyPos === undefined
      ? {}
      : { historyPos: context.historyPos }),
  };
}

/**
 * Normalise to the contract's fields: nothing but `frontier`, a copied
 * `ctx`, and a copied `settings` ride along, so a caller holding a fatter
 * object cannot leak state in, and mutating a handed-out state cannot
 * reach back.
 */
function normalizeState(next: PersistedState): PersistedState {
  const state: {
    frontier: number;
    ctx?: MachineContext;
    settings?: Partial<MachineSettings>;
    helpSeen?: boolean;
  } = { frontier: next.frontier };
  if (next.ctx !== undefined) state.ctx = copyContext(next.ctx);
  if (next.settings !== undefined) state.settings = { ...next.settings };
  // The key-help flag (Phase 13b): a real boolean rides along; a foreign
  // value does not, which reads back as "not seen".
  if (typeof next.helpSeen === "boolean") state.helpSeen = next.helpSeen;
  return state;
}

function copyBookmark(bookmark: Bookmark): Bookmark {
  const copy = { ...bookmark };
  if (bookmark.ctx !== undefined) copy.ctx = copyContext(bookmark.ctx);
  return copy;
}

export function createMemoryStorage(): Storage {
  let state: PersistedState | null = null;
  const bookmarks: Bookmark[] = [];

  function readBookmarks(): Bookmark[] {
    return bookmarks.map(copyBookmark);
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
      bookmarks.push(copyBookmark(bookmark));
      return Promise.resolve(readBookmarks());
    },

    getBookmarks() {
      return Promise.resolve(readBookmarks());
    },

    deleteState() {
      state = null;
      return Promise.resolve();
    },

    deleteBookmarks() {
      bookmarks.length = 0;
      return Promise.resolve();
    },
  };
}
