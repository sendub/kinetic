// Storage data types and the interface every adapter implements
// (docs/plan.md Phases 8-9). Pure data: no DOM, no browser globals — the
// machine and its tests read through this seam, and main.ts injects a real
// adapter.
//
// Since Phase 13 the machine context (`ctx`, `exportContext()`) is the
// persisted source of truth for reading progress: the seen set, the open
// decision stack, and `lastShown` — the item the next load starts on (the
// README's "state the game starts at when loaded"). `frontier` stays as a
// DERIVED legacy value the writer still includes: pre-ctx readers (an
// older build, or a record from one) resume from it exactly as before.
// Settings ride in the same record because the `c` screen persists them
// (docs/plan.md Phase 9); they are data for main.ts to merge over the
// defaults — the machine reads no storage.
//
// Migration (docs/plan.md Phase 13, "Persistence"):
//   - state WITH ctx  -> resume through `resumeContext` / importContext.
//   - state WITHOUT ctx -> legacy resume, equivalent to
//     `legacyResumeContext(frontier)` below: the machine's own
//     `resumeFrontier` path builds precisely that context (visited = the
//     contiguous prefix `[0, frontier)`, landing on `frontier - 1`), so an
//     old record loads unchanged.
// Load order (main.ts): ctx wins when both are present (`resumeOptionsFor`).
//
// IndexedDB schema note: `ctx` rides inside the value objects the `state`
// and `bookmarks` stores already hold, so no keyPath or store changes are
// needed and the database stays at version 1 — an existing version-1
// database keeps working with no upgrade step.

import type { MachineContext, MachineSettings } from "../machine/types";

/** Everything the player persists about reading progress and pacing. */
export interface PersistedState {
  /**
   * Legacy resume value (the derived frontier, `machine.getState().
   * frontier`). Always written; read only when `ctx` is absent.
   */
  readonly frontier: number;
  /**
   * The route-play context of Phase 13 (`machine.exportContext()`, JSON-
   * safe). Present on every save from a Phase-13 build; absent on records
   * written before routes existed, which take the legacy frontier path.
   */
  readonly ctx?: MachineContext;
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
  /** The machine's cursor when `b` was pressed; resumes re-open this item. */
  readonly itemIndex: number;
  /**
   * The route-play context captured with `b` (Phase 13): restoring it
   * re-enters the item within that route context. Absent on bookmarks
   * saved before routes existed, which restore by `itemIndex` alone.
   */
  readonly ctx?: MachineContext;
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
 * The machine options that resume a persisted state, applying the load
 * order once: ctx wins over frontier when both are present; a record
 * without ctx keeps the legacy frontier path. `createMachine` accepts the
 * result as-is (main.ts spreads it into the options). A null state is the
 * first-ever load: no resume options at all.
 */
export function resumeOptionsFor(state: PersistedState | null): {
  resumeContext?: MachineContext;
  resumeFrontier?: number;
} {
  if (state === null) return {};
  return state.ctx === undefined
    ? { resumeFrontier: state.frontier }
    : { resumeContext: state.ctx };
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

/**
 * The legacy migration rule stated as data (docs/plan.md Phase 13): the
 * context equivalent to an old frontier-only record — visited is the
 * contiguous prefix `[0, frontier)`, `lastShown` is `frontier - 1`, and
 * no route frames. The machine's `resumeFrontier` path constructs exactly
 * this, so the two resumes agree for every old record; a frontier below
 * 1 means nothing was ever seen and there is no context (null — a first
 * load). Mainly for tests and future readers that need a ctx from a
 * frontier number.
 */
export function legacyResumeContext(frontier: number): MachineContext | null {
  if (!Number.isFinite(frontier) || frontier < 1) return null;
  const visited: number[] = [];
  for (let index = 0; index < frontier; index += 1) visited.push(index);
  return Object.freeze({
    lastShown: frontier - 1,
    visited: Object.freeze(visited),
    stack: Object.freeze([]),
    playedRoutes: Object.freeze([]),
  });
}
