// IndexedDB adapter (docs/plan.md Phases 8-9): bookmarks, the reading
// frontier, and the `c` screen's settings survive a reload. Raw IndexedDB
// API, no dependency.
//
// Schema — one database for the whole app, `kinetic` (version 1):
//   - store `state`: no keyPath; one record per novel, stored under the
//     novel's content signature, value `{ frontier, settings? }`
//     (`settings` is the partial the `c` screen changed; absent or
//     malformed fields simply fall back to defaults at load).
//   - store `bookmarks`: keyPath `seq`, autoIncrement, so the key alone
//     orders entries by insertion — the list the README draws bottom-first.
//     Each record carries a `content` field and a non-unique `content`
//     index, so one novel's list is one index query in seq order while all
//     novels share the database.
//
// Content signature = the novel folder's absolute URL (`contentSignature`).
// IndexedDB already isolates by origin, but a path distinguishes novels on
// one origin (several folders on the dev server) and on `file://` alike.

import type { MachineSettings } from "../machine/types";
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

function toBookmark(record: BookmarkRecord): Bookmark {
  return {
    id: record.id,
    timestampMs: record.timestampMs,
    itemIndex: record.itemIndex,
    thumbDataUrl: record.thumbDataUrl ?? null,
  };
}

/** The settings a stored record may carry, and the type each field must have. */
const SETTINGS_FIELDS: ReadonlyArray<
  readonly [keyof MachineSettings, "number" | "boolean"]
> = [
  ["readingSpeed", "number"],
  ["minHoldMs", "number"],
  ["msPerChar", "number"],
  ["skipDwellMs", "number"],
  ["skipAll", "boolean"],
];

/**
 * Read a stored `settings` defensively, field by field: a foreign,
 * half-written, or future-version value yields the well-typed subset it
 * happens to hold (undefined when nothing is trustworthy), and every
 * absent field falls back to its default at merge time. Never throws.
 */
function sanitizeSettings(raw: unknown): Partial<MachineSettings> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const source = raw as Record<string, unknown>;
  const settings: Record<string, number | boolean> = {};
  for (const [field, kind] of SETTINGS_FIELDS) {
    const value = source[field];
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
          const settings = sanitizeSettings(
            (stored as Partial<PersistedState>).settings,
          );
          return settings === undefined ? { frontier } : { frontier, settings };
        }
      }
      return null;
    },

    async saveState(state: PersistedState): Promise<void> {
      const db = await openDatabase();
      const tx = db.transaction(STATE_STORE, "readwrite");
      const record: Record<string, unknown> = { frontier: state.frontier };
      if (state.settings !== undefined) record.settings = { ...state.settings };
      tx.objectStore(STATE_STORE).put(record, contentKey);
      await transactionDone(tx);
    },

    async addBookmark(bookmark: Bookmark): Promise<Bookmark[]> {
      const db = await openDatabase();
      const tx = db.transaction(BOOKMARKS_STORE, "readwrite");
      // `seq` is absent so autoIncrement assigns it; its value orders the list.
      tx.objectStore(BOOKMARKS_STORE).add({
        content: contentKey,
        id: bookmark.id,
        timestampMs: bookmark.timestampMs,
        itemIndex: bookmark.itemIndex,
        thumbDataUrl: bookmark.thumbDataUrl ?? null,
      });
      await transactionDone(tx); // durable before the list is read back
      return getBookmarks();
    },

    getBookmarks,
  };
}
