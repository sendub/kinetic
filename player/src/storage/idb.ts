// IndexedDB adapter (docs/plan.md Phases 8-9): bookmarks, the reading
// position, and the `c` screen's settings survive a reload. Raw IndexedDB
// API, no dependency.
//
// Schema — one database for the whole app, `kinetic` (version 1):
//   - store `state`: no keyPath; one record per novel, stored under the
//     novel's storage key (below), value `{ ctx?, settings?, helpSeen? }`
//     (`ctx` is the id-keyed route-play context, `SavedContext`;
//     `settings` is the partial the `c` screen changed; absent or
//     malformed fields simply fall back at load — a malformed or
//     index-based `ctx` reads as no progress (a first boot), a malformed
//     settings field as its default).
//   - store `bookmarks`: keyPath `seq`, autoIncrement, so the key alone
//     orders entries by insertion — the list the README draws bottom-first.
//     Each record carries a `content` field and a non-unique `content`
//     index, so one novel's list is one index query in seq order while all
//     novels share the database. A record carries `itemId` and its
//     id-keyed `ctx`; an index-based record (`itemIndex`) is not listed.
//
// The stored values changed shape over time but no keyPath or store did,
// so the database stays at version 1 with no upgrade step; old-shape
// values are dropped at read (`storage/types.ts`, "No migration").
//
// Storage key (`storageKeys`, docs/plan.md Phase 21): `story:<storyId>`
// when the manifest names its story, so moving, renaming or copying the
// folder keeps progress; otherwise the content signature = the novel
// folder's absolute URL (`contentSignature`), as before Phase 21.
// IndexedDB already isolates by origin, but a path distinguishes novels on
// one origin (several folders on the dev server) and on `file://` alike.
// The two forms cannot collide: a folder URL never has the `story:` scheme.
//
// Carry-over (one-time, idempotent): a novel keyed by story ID whose key
// has no `state` record yet takes over what its current folder URL holds
// — the state record is MOVED to the story key (the folder-URL record is
// deleted) and that folder's bookmarks are retagged to it, all in one
// readwrite transaction before the adapter's first read or write. Moved
// rather than copied: a leftover folder-URL record would be carried over
// again after "Reset progress" deletes the story's record, resurrecting
// the progress the reader just cleared. Once a story key has a record the
// carry-over never runs again for it (a second old folder's progress of
// the same story stays where it was).

import type { MachineSettings } from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import type {
  Bookmark,
  PersistedState,
  SavedContext,
  SavedFrame,
  SavedHistoryEntry,
  SavedRouteSet,
  Storage,
} from "./types";

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

/** A manifest `storyId` the player keys progress by (docs/content-format.md). */
const STORY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * The story ID progress is keyed by: the manifest's `storyId` when it is a
 * valid story slug, else null (the folder URL keys it instead). Export and
 * import (storage/transfer.ts) name the story by the same rule.
 */
export function storyIdOf(storyId: unknown): string | null {
  return typeof storyId === "string" && STORY_ID_PATTERN.test(storyId)
    ? storyId
    : null;
}

/**
 * Where a novel's progress lives: `key` is `story:<storyId>` when the
 * manifest's `storyId` is a valid story slug, with `legacyKey` the folder
 * URL its progress may have been saved under before; otherwise (absent or
 * malformed) `key` is the folder URL, as before story IDs existed.
 */
export function storageKeys(
  storyId: unknown,
  pageUri: string,
): { key: string; legacyKey?: string } {
  const folder = contentSignature(pageUri);
  const story = storyIdOf(storyId);
  if (story !== null) return { key: `story:${story}`, legacyKey: folder };
  return { key: folder };
}

interface BookmarkRecord {
  seq: number;
  content: string;
  id: string;
  timestampMs: number;
  itemId?: unknown;
  ctx?: unknown;
  thumbDataUrl?: string | null;
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

/**
 * `IDBTransaction.commit()` where the engine has it (Chrome 76+, Firefox
 * 74+, Safari 15+): no more requests will be made, so the backend may
 * commit without waiting on this page. Older engines auto-commit as before.
 */
function commitNow(tx: IDBTransaction): void {
  if (typeof tx.commit === "function") tx.commit();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * A stored bookmark row — or an imported one (storage/transfer.ts) — as a
 * `Bookmark`, or null for one without a string `id`, a finite
 * `timestampMs`, a string `itemId` and a readable id-keyed `ctx`: an
 * index-based row written before saves were keyed by id, or a foreign
 * one. Such a row is left in place (Reset progress clears it) but never
 * listed. A thumbnail survives only as an inline `data:image/` URL — the
 * player only ever writes those, and anything else (a remote URL from a
 * hand-edited file) would be fetched by the list's <img>. Never throws.
 */
export function sanitizeBookmark(raw: unknown): Bookmark | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const ctx = sanitizeContext(record.ctx);
  if (
    !isString(record.id) ||
    !isFiniteNumber(record.timestampMs) ||
    !isString(record.itemId) ||
    ctx === undefined
  ) {
    return null;
  }
  const thumb = record.thumbDataUrl;
  return {
    id: record.id,
    timestampMs: record.timestampMs,
    itemId: record.itemId,
    ctx,
    thumbDataUrl:
      isString(thumb) && thumb.startsWith("data:image/") ? thumb : null,
  };
}

/**
 * A stored — or imported — state record read defensively: a foreign or
 * half-written value is null (a first-ever load); otherwise each field
 * survives only in its well-formed shape (`sanitizeContext`,
 * `sanitizeSettings`, a real boolean help flag). Never throws.
 */
export function sanitizeState(raw: unknown): PersistedState | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const source = raw as Record<string, unknown>;
  const state: {
    ctx?: SavedContext;
    settings?: Partial<MachineSettings>;
    helpSeen?: boolean;
  } = {};
  // An index-based ctx (written before saves were keyed by id) reads
  // as absent: that progress is a first boot (storage/types.ts).
  const ctx = sanitizeContext(source.ctx);
  if (ctx !== undefined) state.ctx = ctx;
  const settings = sanitizeSettings(source.settings);
  if (settings !== undefined) state.settings = settings;
  // The key-help flag (Phase 13b): a real boolean survives, a foreign
  // value reads as absent — which means "not seen" and shows the help
  // once (helpSeenFrom, storage/types.ts).
  if (typeof source.helpSeen === "boolean") state.helpSeen = source.helpSeen;
  return state;
}

/** The value a `state` record stores for `state`. */
function stateValue(state: PersistedState): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  // `ctx` is JSON-safe by contract; the structured clone copies it.
  if (state.ctx !== undefined) record.ctx = state.ctx;
  if (state.settings !== undefined) record.settings = { ...state.settings };
  if (state.helpSeen !== undefined) record.helpSeen = state.helpSeen;
  return record;
}

/** The value a `bookmarks` row stores for `bookmark` under `content`. */
function bookmarkValue(
  content: string,
  bookmark: Bookmark,
): Record<string, unknown> {
  // `seq` is absent so autoIncrement assigns it; its value orders the list.
  return {
    content,
    id: bookmark.id,
    timestampMs: bookmark.timestampMs,
    itemId: bookmark.itemId,
    ctx: bookmark.ctx,
    thumbDataUrl: bookmark.thumbDataUrl ?? null,
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
 * Read a stored `ctx` defensively: only the id-keyed `SavedContext` shape
 * survives — a string `lastShown` and an all-string `visited` are
 * required, and malformed stack / route-set / history entries are dropped
 * rather than guessed (the codec then drops ids the manifest lacks).
 * Anything else reads as "no context" (undefined) — including every
 * index-based context written before saves were keyed by id (numeric
 * `lastShown`), which is the documented no-migration rule: that progress
 * reads as a first boot. Never throws. Exported for `storage.test.ts`,
 * like `sanitizeSettings`.
 */
export function sanitizeContext(raw: unknown): SavedContext | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const source = raw as Record<string, unknown>;
  if (!isString(source.lastShown)) return undefined;
  if (!Array.isArray(source.visited) || !source.visited.every(isString)) {
    return undefined;
  }
  const frame = (raw: unknown): SavedFrame | undefined => {
    if (typeof raw !== "object" || raw === null) return undefined;
    const { decision, route } = raw as Record<string, unknown>;
    return isString(decision) && isString(route)
      ? { decision, route }
      : undefined;
  };
  const stack: SavedFrame[] = [];
  for (const raw of Array.isArray(source.stack) ? source.stack : []) {
    const value = frame(raw);
    if (value !== undefined) stack.push(value);
  }
  // The reading history: an entry without a string `item`, with a
  // non-string `decision`, or with any malformed frame is dropped whole
  // (its screen cannot be rebuilt). Absent or empty is omitted — the
  // restore then lands on `lastShown` with a one-entry history.
  const history: SavedHistoryEntry[] = [];
  for (const entry of Array.isArray(source.history) ? source.history : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (!isString(candidate.item)) continue;
    if (candidate.decision !== undefined && !isString(candidate.decision)) {
      continue;
    }
    const frames = (Array.isArray(candidate.stack) ? candidate.stack : []).map(
      frame,
    );
    if (frames.some((value) => value === undefined)) continue;
    history.push({
      item: candidate.item,
      stack: frames as SavedFrame[],
      ...(candidate.decision === undefined
        ? {}
        : { decision: candidate.decision }),
    });
  }
  const routeSets = (raw: unknown): SavedRouteSet[] => {
    const out: SavedRouteSet[] = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (typeof entry !== "object" || entry === null) continue;
      const candidate = entry as Record<string, unknown>;
      if (
        isString(candidate.decision) &&
        Array.isArray(candidate.routes) &&
        candidate.routes.every(isString)
      ) {
        out.push({
          decision: candidate.decision,
          routes: [...candidate.routes],
        });
      }
    }
    return out;
  };
  return {
    lastShown: source.lastShown,
    visited: [...source.visited],
    stack,
    playedRoutes: routeSets(source.playedRoutes),
    // Which routes were played THROUGH to their end (docs/plan.md Phase
    // 18): the "Return to main route" row depends on it.
    completedRoutes: routeSets(source.completedRoutes),
    ...(history.length > 0 ? { history } : {}),
    ...(history.length > 0 && isFiniteNumber(source.historyPos)
      ? { historyPos: source.historyPos }
      : {}),
  };
}

/**
 * A Storage scoped to one novel (`contentKey`, from `storageKeys`), or null
 * when this host has no IndexedDB at all. With a `legacyKey`, progress saved
 * under it is carried over once before the first read or write (header
 * comment). Null means no IndexedDB at
 * all — the caller falls back to `createNoopStorage()` so the player runs.
 * Methods reject on real adapter failure; they never run against a half-open
 * database.
 */
export function createIdbStorage(
  contentKey: string,
  legacyKey?: string,
): Storage | null {
  if (globalThis.indexedDB === undefined) return null;

  let carried: Promise<IDBDatabase> | null = null;
  /**
   * The open database, after the one-time carry-over from `legacyKey`
   * (header comment) has committed. A failed carry-over is not fatal:
   * the novel then simply starts from its own key.
   */
  function database(): Promise<IDBDatabase> {
    if (carried !== null) return carried;
    carried = openDatabase().then(async (db) => {
      if (legacyKey === undefined || legacyKey === contentKey) return db;
      await carryOver(db, legacyKey).catch(() => undefined);
      return db;
    });
    return carried;
  }

  /** Move `from`'s state record and bookmarks to this novel's key. */
  function carryOver(db: IDBDatabase, from: string): Promise<void> {
    const tx = db.transaction([STATE_STORE, BOOKMARKS_STORE], "readwrite");
    const states = tx.objectStore(STATE_STORE);
    const own = states.getKey(contentKey);
    own.onsuccess = () => {
      if (own.result !== undefined) return; // already has its own record
      const old = states.get(from);
      old.onsuccess = () => {
        if (old.result === undefined) return;
        states.put(old.result, contentKey);
        states.delete(from);
      };
      const index = tx.objectStore(BOOKMARKS_STORE).index(CONTENT_INDEX);
      const cursorRequest = index.openCursor(IDBKeyRange.only(from));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor === null) return;
        cursor.update({
          ...(cursor.value as BookmarkRecord),
          content: contentKey,
        });
        cursor.continue();
      };
    };
    return transactionDone(tx);
  }

  async function getBookmarks(): Promise<Bookmark[]> {
    const db = await database();
    const tx = db.transaction(BOOKMARKS_STORE, "readonly");
    const index = tx.objectStore(BOOKMARKS_STORE).index(CONTENT_INDEX);
    const records = await requestPromise(
      index.getAll(IDBKeyRange.only(contentKey)),
    );
    return records
      .map((record) => sanitizeBookmark(record))
      .filter((bookmark): bookmark is Bookmark => bookmark !== null);
  }

  return {
    async loadState(): Promise<PersistedState | null> {
      const db = await database();
      const tx = db.transaction(STATE_STORE, "readonly");
      const stored = await requestPromise(
        tx.objectStore(STATE_STORE).get(contentKey),
      );
      // Read defensively: a foreign or half-written record reads as no
      // persisted state (a first-ever load), never as a broken resume.
      return sanitizeState(stored);
    },

    async saveState(state: PersistedState): Promise<void> {
      const db = await database();
      const tx = db.transaction(STATE_STORE, "readwrite");
      tx.objectStore(STATE_STORE).put(stateValue(state), contentKey);
      // Ask for the commit now instead of when the put's success event
      // has made the round trip back to this page (docs/plan.md Phase 18,
      // "Settings survive an immediate reload"): a reload a moment after
      // a change can tear the page down before that round trip, and a
      // transaction whose commit was never requested is then aborted.
      commitNow(tx);
      await transactionDone(tx);
    },

    async addBookmark(bookmark: Bookmark): Promise<Bookmark[]> {
      const db = await database();
      const tx = db.transaction(BOOKMARKS_STORE, "readwrite");
      tx.objectStore(BOOKMARKS_STORE).add(bookmarkValue(contentKey, bookmark));
      await transactionDone(tx); // durable before the list is read back
      return getBookmarks();
    },

    getBookmarks,

    // The `t` list's "x" (docs/plan.md Phase 18): walk this content's rows
    // and delete the one carrying `id` (ids are not the store key — `seq`
    // is), committed before the remaining list is read back.
    async deleteBookmark(id: string): Promise<Bookmark[]> {
      const db = await database();
      const tx = db.transaction(BOOKMARKS_STORE, "readwrite");
      const index = tx.objectStore(BOOKMARKS_STORE).index(CONTENT_INDEX);
      const cursorRequest = index.openCursor(IDBKeyRange.only(contentKey));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor === null) return;
        if ((cursor.value as BookmarkRecord).id === id) cursor.delete();
        cursor.continue();
      };
      await transactionDone(tx);
      return getBookmarks();
    },

    // "Reset progress" (docs/plan.md Phase 16). Both deletes run in a
    // readwrite transaction whose promise resolves on `transactionDone`,
    // so the deletion is COMMITTED before the caller is handed back
    // control — a `location.reload()` right after can never catch a
    // half-deleted record (the verify-step-40 lesson). This is a plain
    // record delete, not `deleteDatabase`, so the app's own open
    // connection is no obstacle; it closes harmlessly with the page.
    async deleteState(): Promise<void> {
      const db = await database();
      const tx = db.transaction(STATE_STORE, "readwrite");
      tx.objectStore(STATE_STORE).delete(contentKey);
      await transactionDone(tx);
    },

    async deleteBookmarks(): Promise<void> {
      const db = await database();
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

    // "Import progress" (docs/plan.md Phase 21): one readwrite transaction
    // over both stores — the state record overwritten, this content's
    // bookmark rows deleted through the cursor, the imported rows added
    // once the cursor is done (in file order, so `seq` keeps that order).
    // All or nothing: a failure aborts the transaction and the old
    // progress stands; success resolves on commit, before any reload.
    async replaceProgress(
      state: PersistedState,
      bookmarks: readonly Bookmark[],
    ): Promise<void> {
      const db = await database();
      const tx = db.transaction([STATE_STORE, BOOKMARKS_STORE], "readwrite");
      tx.objectStore(STATE_STORE).put(stateValue(state), contentKey);
      const store = tx.objectStore(BOOKMARKS_STORE);
      const cursorRequest = store
        .index(CONTENT_INDEX)
        .openCursor(IDBKeyRange.only(contentKey));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor !== null) {
          cursor.delete();
          cursor.continue();
          return;
        }
        for (const bookmark of bookmarks) {
          store.add(bookmarkValue(contentKey, bookmark));
        }
      };
      await transactionDone(tx);
    },
  };
}
