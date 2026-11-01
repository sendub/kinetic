// IndexedDB adapter (docs/plan.md Phases 8-9): bookmarks, the reading
// frontier, and the `c` screen's settings survive a reload. Raw IndexedDB
// API, no dependency.
//
// Schema — one database for the whole app, `kinetic` (version 1):
//   - store `state`: no keyPath; one record per novel, stored under the
//     novel's content signature, value `{ frontier, ctx?, settings? }`
//     (`ctx` is the Phase 13 route-play context; `settings` is the partial
//     the `c` screen changed; absent or malformed fields simply fall back
//     at load — a malformed `ctx` drops to the legacy frontier resume, a
//     malformed settings field to its default).
//   - store `bookmarks`: keyPath `seq`, autoIncrement, so the key alone
//     orders entries by insertion — the list the README draws bottom-first.
//     Each record carries a `content` field and a non-unique `content`
//     index, so one novel's list is one index query in seq order while all
//     novels share the database. A record may carry `ctx` (Phase 13)
//     beside `itemIndex`; older records without it read as before.
//
// Phase 13 added `ctx` inside these value objects only — no keyPath or
// store changed — so the database stays at version 1 and every existing
// version-1 database keeps working with no upgrade step (see
// `storage/types.ts` for the migration rules).
//
// Content signature = the novel folder's absolute URL (`contentSignature`).
// IndexedDB already isolates by origin, but a path distinguishes novels on
// one origin (several folders on the dev server) and on `file://` alike.

import type {
  ContextFrame,
  HistoryEntry,
  MachineContext,
  MachineSettings,
} from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import type { Bookmark, PersistedState, Storage } from "./types";

export const DB_NAME = "kinetic";
const DB_VERSION = 1;
const STATE_STORE = "state";
const BOOKMARKS_STORE = "bookmarks";
const CONTENT_INDEX = "content";

/**
 * The signature identifying the novel a page belongs to: the directory of
 * `pageUri` (typically `document.baseURI`), absolute. Two open copies of the
 * same folder — `index.html` or the bare directory URL — take the same
 * signature; different folders never do. A URI that cannot be parsed is its
 * own signature rather than a shared empty one.
 */
export function contentSignature(pageUri: string): string {
  try {
    return new URL(".", pageUri).href;
  } catch {
    return pageUri;
  }
}

interface BookmarkRecord extends Bookmark {
  seq: number;
  content: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** Opens (and creates, once) the shared database; the open is cached. */
function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise !== null) return dbPromise;
  const factory = globalThis.indexedDB;
  if (factory === undefined) {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STATE_STORE)) {
        // Out-of-line keys: the key is the novel's content signature.
        db.createObjectStore(STATE_STORE);
      }
      if (!db.objectStoreNames.contains(BOOKMARKS_STORE)) {
        const store = db.createObjectStore(BOOKMARKS_STORE, {
          keyPath: "seq",
          autoIncrement: true,
        });
        store.createIndex(CONTENT_INDEX, CONTENT_INDEX);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () =>
      reject(new Error("IndexedDB open blocked by another connection"));
  });
  return dbPromise;
}

function requestPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function toBookmark(record: BookmarkRecord): Bookmark {
  // Same defensive read as `loadState`: a foreign `ctx` reads as absent —
  // an itemIndex-only bookmark, never a broken entry.
  const ctx = sanitizeContext(record.ctx);
  return {
    id: record.id,
    timestampMs: record.timestampMs,
    itemIndex: record.itemIndex,
    ...(ctx === undefined ? {} : { ctx }),
    thumbDataUrl: record.thumbDataUrl ?? null,
  };
}

/**
 * Read a stored `settings` defensively, field by field: a foreign,
 * half-written, or future-version value yields the well-typed subset it
 * happens to hold (undefined when nothing is trustworthy), and every
 * absent field falls back to its default at merge time. The accepted
 * fields are exactly `DEFAULT_SETTINGS`' own, each with the type its
 * default has — the same rule `mergeSettings` applies at load — so a new
 * settings field is restored without touching this list (a hand-written
 * whitelist once missed `playAllRoutes`, and a stored play-all choice
 * read back absent: off after every reload). Never throws. Exported for
 * `storage.test.ts`: the browser-free adapters pass settings through
 * untouched, so this function is the whole contract for the shipped
 * adapter.
 */
export function sanitizeSettings(
  raw: unknown,
): Partial<MachineSettings> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const source = raw as Record<string, unknown>;
  const settings: Record<string, number | boolean> = {};
  for (const field of Object.keys(
    DEFAULT_SETTINGS,
  ) as (keyof MachineSettings)[]) {
    const value = source[field];
    const kind = typeof DEFAULT_SETTINGS[field];
    if (
      kind === "number" &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      settings[field] = value;
    } else if (kind === "boolean" && typeof value === "boolean") {
      settings[field] = value;
    }
  }
  return Object.keys(settings).length === 0
    ? undefined
    : (settings as Partial<MachineSettings>);
}

/**
 * Read a stored `ctx` defensively: only the `MachineContext` shape
 * survives — a trustworthy `lastShown` and `visited` are required, and
 * malformed stack/playedRoutes/history entries are dropped rather than
 * guessed.
 * Anything else reads as "no context" (undefined), which puts the record
 * on the legacy frontier resume path — the documented migration for
 * pre-Phase-13 records, so never a failure. Never throws. Exported for
 * `storage.test.ts`, like `sanitizeSettings`.
 */
export function sanitizeContext(raw: unknown): MachineContext | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const source = raw as Partial<MachineContext>;
  if (!isFiniteNumber(source.lastShown)) return undefined;
  if (!Array.isArray(source.visited) || !source.visited.every(isFiniteNumber)) {
    return undefined;
  }
  const frames = (raw: unknown): ContextFrame[] => {
    const out: ContextFrame[] = [];
    for (const frame of Array.isArray(raw) ? raw : []) {
      if (typeof frame !== "object" || frame === null) continue;
      const { decision, route } = frame as Partial<ContextFrame>;
      if (isFiniteNumber(decision) && isFiniteNumber(route)) {
        out.push({ decision, route });
      }
    }
    return out;
  };
  const stack = frames(source.stack);
  // The reading history (docs/plan.md, "History rollback spec"): entries
  // without a finite `index` (or with a non-numeric `decision`) are
  // dropped; the machine checks the rest against its manifest. Absent or
  // empty is omitted — a save without one restores a one-entry history at
  // its `lastShown` landing.
  const history: HistoryEntry[] = [];
  for (const entry of Array.isArray(source.history) ? source.history : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Partial<{
      index: unknown;
      stack: unknown;
      decision: unknown;
    }>;
    if (!isFiniteNumber(candidate.index)) continue;
    if (
      candidate.decision !== undefined &&
      !isFiniteNumber(candidate.decision)
    ) {
      continue;
    }
    history.push({
      index: candidate.index,
      stack: frames(candidate.stack),
      ...(candidate.decision === undefined
        ? {}
        : { decision: candidate.decision }),
    });
  }
  const routeSets = (
    entries: readonly { decision: number; routes: readonly number[] }[],
  ): { decision: number; routes: number[] }[] => {
    const out: { decision: number; routes: number[] }[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const candidate = entry as Partial<{ decision: number; routes: unknown }>;
      if (
        isFiniteNumber(candidate.decision) &&
        Array.isArray(candidate.routes) &&
        candidate.routes.every(isFiniteNumber)
      ) {
        out.push({
          decision: candidate.decision,
          routes: [...candidate.routes],
        });
      }
    }
    return out;
  };
  const playedRoutes = routeSets(
    Array.isArray(source.playedRoutes) ? source.playedRoutes : [],
  );
  // `completedRoutes` (docs/plan.md Phase 18) sanitizes exactly like
  // `playedRoutes`. It survives the round trip — the "Return to main route"
  // row depends on it — and an absent/empty field restores as
  // nothing-completed, the documented migration for pre-18 saves, so it is
  // omitted rather than grown back as an empty array.
  const completedRoutes = routeSets(
    Array.isArray(source.completedRoutes) ? source.completedRoutes : [],
  );
  return {
    lastShown: source.lastShown,
    visited: [...source.visited],
    stack,
    playedRoutes,
    ...(completedRoutes.length > 0 ? { completedRoutes } : {}),
    ...(history.length > 0 ? { history } : {}),
    ...(history.length > 0 && isFiniteNumber(source.historyPos)
      ? { historyPos: source.historyPos }
      : {}),
  };
}

/**
 * A Storage scoped to one novel, or null when this host has no IndexedDB at
 * all — the caller falls back to `createNoopStorage()` so the player runs.
 * Methods reject on real adapter failure; they never run against a half-open
 * database.
 */
export function createIdbStorage(contentKey: string): Storage | null {
  if (globalThis.indexedDB === undefined) return null;

  async function getBookmarks(): Promise<Bookmark[]> {
    const db = await openDatabase();
    const tx = db.transaction(BOOKMARKS_STORE, "readonly");
    const index = tx.objectStore(BOOKMARKS_STORE).index(CONTENT_INDEX);
    const records = await requestPromise(
      index.getAll(IDBKeyRange.only(contentKey)),
    );
    return records.map(toBookmark);
  }

  return {
    async loadState(): Promise<PersistedState | null> {
      const db = await openDatabase();
      const tx = db.transaction(STATE_STORE, "readonly");
      const stored = await requestPromise(
        tx.objectStore(STATE_STORE).get(contentKey),
      );
      // Read defensively: a foreign or half-written record reads as no
      // persisted state (a first-ever load), never as a broken resume.
      if (typeof stored === "object" && stored !== null) {
        const frontier = (stored as Partial<PersistedState>).frontier;
        if (typeof frontier === "number" && Number.isFinite(frontier)) {
          const state: {
            frontier: number;
            ctx?: MachineContext;
            settings?: Partial<MachineSettings>;
            helpSeen?: boolean;
          } = { frontier };
          // A pre-Phase-13 record simply has no `ctx`: the legacy
          // frontier resume covers it (storage/types.ts, "Migration").
          const ctx = sanitizeContext((stored as Partial<PersistedState>).ctx);
          if (ctx !== undefined) state.ctx = ctx;
          const settings = sanitizeSettings(
            (stored as Partial<PersistedState>).settings,
          );
          if (settings !== undefined) state.settings = settings;
          // The key-help flag (Phase 13b): a real boolean survives, a
          // foreign value reads as absent — which means "not seen" and
          // shows the help once (helpSeenFrom, storage/types.ts).
          const helpSeen = (stored as Partial<PersistedState>).helpSeen;
          if (typeof helpSeen === "boolean") state.helpSeen = helpSeen;
          return state;
        }
      }
      return null;
    },

    async saveState(state: PersistedState): Promise<void> {
      const db = await openDatabase();
      const tx = db.transaction(STATE_STORE, "readwrite");
      const record: Record<string, unknown> = { frontier: state.frontier };
      // `ctx` is JSON-safe by contract; the structured clone copies it.
      if (state.ctx !== undefined) record.ctx = state.ctx;
      if (state.settings !== undefined) record.settings = { ...state.settings };
      if (state.helpSeen !== undefined) record.helpSeen = state.helpSeen;
      tx.objectStore(STATE_STORE).put(record, contentKey);
      await transactionDone(tx);
    },

    async addBookmark(bookmark: Bookmark): Promise<Bookmark[]> {
      const db = await openDatabase();
      const tx = db.transaction(BOOKMARKS_STORE, "readwrite");
      // `seq` is absent so autoIncrement assigns it; its value orders the list.
      const record: Record<string, unknown> = {
        content: contentKey,
        id: bookmark.id,
        timestampMs: bookmark.timestampMs,
        itemIndex: bookmark.itemIndex,
        thumbDataUrl: bookmark.thumbDataUrl ?? null,
      };
      // The route-play context rides beside the index (Phase 13); older
      // callers pass none and the record simply lacks the field.
      if (bookmark.ctx !== undefined) record.ctx = bookmark.ctx;
      tx.objectStore(BOOKMARKS_STORE).add(record);
      await transactionDone(tx); // durable before the list is read back
      return getBookmarks();
    },

    getBookmarks,

    // "Reset progress" (docs/plan.md Phase 16). Both deletes run in a
    // readwrite transaction whose promise resolves on `transactionDone`,
    // so the deletion is COMMITTED before the caller is handed back
    // control — a `location.reload()` right after can never catch a
    // half-deleted record (the verify-step-40 lesson). This is a plain
    // record delete, not `deleteDatabase`, so the app's own open
    // connection is no obstacle; it closes harmlessly with the page.
    async deleteState(): Promise<void> {
      const db = await openDatabase();
      const tx = db.transaction(STATE_STORE, "readwrite");
      tx.objectStore(STATE_STORE).delete(contentKey);
      await transactionDone(tx);
    },

    async deleteBookmarks(): Promise<void> {
      const db = await openDatabase();
      const tx = db.transaction(BOOKMARKS_STORE, "readwrite");
      // An index cannot delete directly; walk this content's cursor and
      // delete each row through it, then let the transaction commit.
      const index = tx.objectStore(BOOKMARKS_STORE).index(CONTENT_INDEX);
      const cursorRequest = index.openCursor(IDBKeyRange.only(contentKey));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor === null) return;
        cursor.delete();
        cursor.continue();
      };
      // A failed cursor request bubbles and aborts the transaction,
      // which `transactionDone` below reports as a rejection.
      await transactionDone(tx);
    },
  };
}
