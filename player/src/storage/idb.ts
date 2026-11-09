// IndexedDB adapter (docs/plan.md Phases 8-9): bookmarks, the reading
// position, and the Esc screen's settings survive a reload. Raw IndexedDB
// API, no dependency.
//
// Schema — one database for the whole app, `kinetic` (version 1):
//   - store `state`: no keyPath; one record per novel, stored under the
//     novel's storage key (below), value `{ ctx?, settings?, helpSeen?, mapView? }`
//     (`ctx` is the id-keyed route-play context, `SavedContext`, its
//     `visited` written empty since Phase 46 — the seen set has records of
//     its own, below;
//     `settings` is the partial the Esc screen's settings changed; absent or
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
//   - the bookmark-list cache (the bookmark-screen speed item): one more
//     `state` record per novel, under `bookmark-list:<storage key>`
//     (`listCacheKey`), holding each bookmark row's summary by `seq` — its
//     id, time, item id and whether it has a thumbnail — or a mark that
//     the row is not listable. A row's summary never changes (`seq` is
//     never reused and a row is never rewritten except to retag its
//     novel), so `listBookmarks` reads only this record plus the novel's
//     row keys (`getAllKeys`, no values) and fetches just the rows the
//     cache does not know yet — the first time, every row, once — instead
//     of deserializing every row's route context and thumbnail on each
//     `t`. The cache heals itself: a row added or deleted by any player
//     build (older ones never touch the cache) is noticed from the keys.
//     It lives in the existing `state` store, not a new index or store,
//     because either would need a version-2 upgrade, and an older
//     player's `open("kinetic", 1)` then fails with a VersionError — every
//     older game folder on the origin would lose its progress.
//
//   - the seen records (docs/plan.md Phase 46), also in the `state` store
//     for the same reason: the ids of every item the reader has seen, at
//     most SEEN_CHUNK (500) per record, each an array of ids under the key
//     `["seen", <storage key>, <page>, <n>]`. Until Phase 46 the whole
//     list rode in the state record's `ctx.visited`, so every save on
//     every screen change rewrote it: about 4.5 MB on a 160,000-item game
//     once read, 49 ms per Space at p95 on WebKit (docs/perf.md, "Saves
//     at scale"). Now a save (`saveState`) writes the state record and
//     only this page's seen records that have changed: `<page>` is a name
//     of this adapter's own, new at every load, so a save rewrites at most
//     the 500 ids of the page's newest record, whatever has been read
//     before — and no other page or build ever writes the same record. Array keys sort after
//     every string key, so one key range (`seenRange`) holds a novel's
//     seen records and no one else's. A load (`loadState`) reads the
//     state record and them in one readwrite transaction that also
//     settles them (`settleSeen`), all or nothing:
//       - no state record: they are leftovers (an older build's Reset
//         progress deleted only the record) and are deleted;
//       - a list in the record's `ctx.visited` — a save from before Phase
//         46, one an older build wrote since, or an import — joins them
//         (new records of this page) and the record is rewritten with it
//         empty;
//       - once SEEN_MERGE_AT (32) records are part-filled (one per page
//         load that saw something new), they are merged into full ones.
//     If that transaction fails (a full disk), the load reads without it
//     and the first save moves the list, with the record that drops it.
//     Older builds on the same origin and story key read only
//     `ctx.visited`, which this player leaves empty, so they show fewer
//     items as seen (accepted, docs/plan.md Phase 46); what they write
//     there this player merges at its next load, so moving between builds
//     never loses an item seen in this one. Their Reset and Import cannot
//     see the seen records: with no state record left the next load drops
//     them, but once an older build has saved a new record they are
//     merged with it.
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
// the same story stays where it was). The folder URL's seen records move
// with its record (a manifest without a storyId kept them there), and any
// seen records the story key had without a record go first.

import type { MachineSettings } from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import type {
  Bookmark,
  BookmarkSummary,
  PersistedState,
  SavedContext,
  SavedFrame,
  SavedMapView,
  SavedRouteSet,
  Storage,
} from "./types";
import { sanitizeMapView, summarizeBookmark } from "./types";

export const DB_NAME = "kinetic";
const DB_VERSION = 1;
const STATE_STORE = "state";
const BOOKMARKS_STORE = "bookmarks";
const CONTENT_INDEX = "content";
/** The first element of a seen record's key (header comment). */
const SEEN = "seen";
/** The most ids one seen record holds (header comment). */
export const SEEN_CHUNK = 500;
/** A load merges the story's part-filled seen records once there are this many. */
export const SEEN_MERGE_AT = 32;

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

/** The `state` key of a novel's bookmark-list cache (header comment). */
export function listCacheKey(contentKey: string): string {
  return `bookmark-list:${contentKey}`;
}

/**
 * Every seen record of a novel, as a key range (header comment): the keys
 * `["seen", contentKey, <page>, <n>]`. An array sorts after every string
 * and number, so `["seen", contentKey, []]` bounds them all.
 */
function seenRange(contentKey: string): IDBKeyRange {
  return IDBKeyRange.bound([SEEN, contentKey], [SEEN, contentKey, []]);
}

/** A seen record's ids; anything else in one reads as none. */
function seenIdsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

/**
 * The seen list a state record carries in its `ctx` when its context is
 * one this player reads: an older build's whole list, or an import's; this
 * player writes it empty. Empty for anything else.
 */
function listedSeen(raw: unknown): readonly string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const ctx = sanitizeContext((raw as Record<string, unknown>).ctx);
  return ctx?.visited ?? [];
}

/** A page's own name for its seen records: unique per adapter, per load. */
function newPageName(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A cached row: its summary, or a mark that the row is not listed. */
type CachedRow =
  | BookmarkSummary
  | { readonly key: number; readonly skip: true };

/**
 * A stored bookmark-list cache as rows by `seq`; anything malformed —
 * the whole record or one row — is simply not known, so that row is
 * read again. Never throws.
 */
export function sanitizeListCache(raw: unknown): Map<number, CachedRow> {
  const rows = new Map<number, CachedRow>();
  if (typeof raw !== "object" || raw === null) return rows;
  const list = (raw as Record<string, unknown>).rows;
  if (!Array.isArray(list)) return rows;
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (!isFiniteNumber(row.key)) continue;
    if (row.skip === true) {
      rows.set(row.key, { key: row.key, skip: true });
    } else if (
      isString(row.id) &&
      isFiniteNumber(row.timestampMs) &&
      isString(row.itemId) &&
      typeof row.hasThumb === "boolean"
    ) {
      rows.set(row.key, {
        key: row.key,
        id: row.id,
        timestampMs: row.timestampMs,
        itemId: row.itemId,
        hasThumb: row.hasThumb,
      });
    }
  }
  return rows;
}

/** A bookmark row read in full, as its cache entry. */
function cachedRow(key: number, raw: unknown): CachedRow {
  const bookmark = sanitizeBookmark(raw);
  return bookmark === null
    ? { key, skip: true }
    : summarizeBookmark(key, bookmark);
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
    mapView?: SavedMapView;
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
  // The branch map's view (Phase 41): a malformed or older one reads as
  // none (Full size, centred).
  const mapView = sanitizeMapView(source.mapView);
  if (mapView !== undefined) state.mapView = mapView;
  return state;
}

/**
 * The value a `state` record stores for `state`. A save's `ctx.visited`
 * goes to the seen records, so the record holds it empty (still an array:
 * an older build reads no context without one); an import keeps the whole
 * list (`keepSeen`), which its next load moves (header comment).
 */
function stateValue(
  state: PersistedState,
  keepSeen = false,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  // `ctx` is JSON-safe by contract; the structured clone copies it.
  if (state.ctx !== undefined) {
    record.ctx = keepSeen ? state.ctx : { ...state.ctx, visited: [] };
  }
  if (state.settings !== undefined) record.settings = { ...state.settings };
  if (state.helpSeen !== undefined) record.helpSeen = state.helpSeen;
  // `mapView` is JSON-safe too (plain numbers, strings, null).
  if (state.mapView !== undefined) record.mapView = state.mapView;
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
 * required, and malformed stack / route-set / last-pick frames are dropped
 * rather than guessed (the codec then drops ids the manifest lacks). A
 * context from the reading-history days migrates (`legacyTimeline`).
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
  const lastPicks: SavedFrame[] = [];
  for (const raw of Array.isArray(source.lastPicks) ? source.lastPicks : []) {
    const value = frame(raw);
    if (value !== undefined) lastPicks.push(value);
  }
  const legacy = legacyTimeline(source, stack, frame);
  function routeSets(raw: unknown): SavedRouteSet[] {
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
  }
  return {
    lastShown: source.lastShown,
    visited: [...source.visited],
    stack,
    playedRoutes: routeSets(source.playedRoutes),
    // Which routes were played THROUGH to their end (docs/plan.md Phase
    // 18): the "Return to main route" row depends on it.
    completedRoutes: routeSets(source.completedRoutes),
    // Played this pass (docs/plan.md Phase 22); absent in older saves.
    ...(Array.isArray(source.passRoutes)
      ? { passRoutes: routeSets(source.passRoutes) }
      : {}),
    // The timeline (docs/plan.md Phase 27): the last pick per decision and
    // the open choice screen, from the stored fields or an old history.
    ...(Array.isArray(source.lastPicks)
      ? { lastPicks }
      : legacy.lastPicks.length > 0
        ? { lastPicks: legacy.lastPicks }
        : {}),
    ...(isString(source.choice)
      ? { choice: source.choice }
      : legacy.choice === undefined
        ? {}
        : { choice: legacy.choice }),
  };
}

/**
 * The migration of a context written while the player kept a reading
 * history (docs/plan.md Phase 27): `history` (screens `{ item, stack,
 * decision?, passRoutes?, gap? }`) and `historyPos` (the screen showing,
 * default the last). The LAST PICK at each decision is the route entered
 * last there in the record — the latest frame naming the decision — and
 * the open frames (`stack`) override it, being the present. When the
 * screen showing was a choice screen, its decision is the open `choice`.
 * The record itself is dropped. Malformed entries and frames are skipped.
 */
function legacyTimeline(
  source: Record<string, unknown>,
  stack: readonly SavedFrame[],
  frame: (raw: unknown) => SavedFrame | undefined,
): { lastPicks: SavedFrame[]; choice?: string } {
  const history = Array.isArray(source.history) ? source.history : [];
  const picks = new Map<string, string>();
  for (const entry of history) {
    if (typeof entry !== "object" || entry === null) continue;
    const frames = (entry as Record<string, unknown>).stack;
    for (const raw of Array.isArray(frames) ? frames : []) {
      const value = frame(raw);
      if (value !== undefined) picks.set(value.decision, value.route);
    }
  }
  for (const open of stack) picks.set(open.decision, open.route);
  const lastPicks = [...picks.entries()].map(([decision, route]) => ({
    decision,
    route,
  }));
  const at = isFiniteNumber(source.historyPos)
    ? Math.min(Math.max(Math.trunc(source.historyPos), 0), history.length - 1)
    : history.length - 1;
  const showing: unknown = history[at];
  const decision =
    typeof showing === "object" && showing !== null
      ? (showing as Record<string, unknown>).decision
      : undefined;
  return isString(decision) ? { lastPicks, choice: decision } : { lastPicks };
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

  /**
   * Move `from`'s state record, seen records and bookmarks to this novel's
   * key; seen records this key has without a record of its own (an older
   * build's reset) go first.
   */
  function carryOver(db: IDBDatabase, from: string): Promise<void> {
    const tx = db.transaction([STATE_STORE, BOOKMARKS_STORE], "readwrite");
    const states = tx.objectStore(STATE_STORE);
    const own = states.getKey(contentKey);
    own.onsuccess = () => {
      if (own.result !== undefined) return; // already has its own record
      const old = states.get(from);
      const seenKeys = states.getAllKeys(seenRange(from));
      const seenValues = states.getAll(seenRange(from));
      seenValues.onsuccess = () => {
        if (old.result === undefined) return;
        states.put(old.result, contentKey);
        states.delete(from);
        states.delete(seenRange(contentKey));
        seenKeys.result.forEach((key, i) => {
          const rest = Array.isArray(key) ? key.slice(2) : [];
          states.put(seenValues.result[i], [SEEN, contentKey, ...rest]);
        });
        states.delete(seenRange(from));
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

  const cacheKey = listCacheKey(contentKey);

  // This page's seen records (header comment): the ids handed to it, in
  // records of at most SEEN_CHUNK under this page's own name, so no other
  // page or build ever writes the same record. A record stays `unsaved`
  // until a write of all its ids has committed, and every write puts the
  // unsaved ones again, so a failed write loses nothing.
  interface SeenRecord {
    readonly key: IDBValidKey;
    readonly ids: string[];
    saved: number;
  }
  let page = newPageName();
  let pageRecords = 0;
  let filling: SeenRecord | null = null;
  const unsaved = new Set<SeenRecord>();
  // Ids this page has taken, so a caller handing the same ids again (the
  // whole set, as before Phase 46) stores them once per page.
  const taken = new Set<string>();

  /** Add `ids` to this page's seen records (in memory, unsaved). */
  function takeSeen(ids: readonly string[], fromLoad = false): void {
    for (const id of ids) {
      if (!isString(id)) continue;
      if (!fromLoad) {
        if (taken.has(id)) continue;
        taken.add(id);
      }
      if (filling === null || filling.ids.length >= SEEN_CHUNK) {
        filling = {
          key: [SEEN, contentKey, page, pageRecords],
          ids: [],
          saved: 0,
        };
        pageRecords += 1;
      }
      filling.ids.push(id);
      unsaved.add(filling);
    }
  }

  /**
   * Put every unsaved seen record in `store`'s transaction; the returned
   * function, called once it commits, marks what it wrote as saved.
   */
  function putUnsaved(store: IDBObjectStore): () => void {
    const written = [...unsaved].map((record) => {
      store.put(record.ids, record.key);
      return { record, length: record.ids.length };
    });
    return () => {
      for (const { record, length } of written) {
        if (length > record.saved) record.saved = length;
        if (record.saved >= record.ids.length) unsaved.delete(record);
      }
    };
  }

  /** Forget this page's seen records: the stored ones were replaced. */
  function startPageOver(): void {
    page = newPageName();
    pageRecords = 0;
    filling = null;
    unsaved.clear();
    taken.clear();
  }

  /**
   * A load's work on the seen records, in its own transaction once the
   * record and the seen records are read (header comment): with no state
   * record, any seen records are an older build's leftovers and go; a list
   * in the record (an older build's, an import's) joins the seen records
   * and leaves the record; part-filled records are merged once there are
   * SEEN_MERGE_AT of them. Returns every seen id, once each, and the
   * commit's bookkeeping. With no `store` (a read-only load, after that
   * work failed) nothing is written: the list's ids become this page's
   * unsaved records, so the next save writes them with the record that
   * drops the list, in one transaction.
   */
  function settleSeen(
    store: IDBObjectStore | null,
    raw: unknown,
    keys: readonly IDBValidKey[],
    values: readonly unknown[],
  ): { seen: string[]; committed: () => void } {
    if (raw === undefined) {
      if (keys.length > 0) store?.delete(seenRange(contentKey));
      return { seen: [], committed: () => {} };
    }
    const seen = new Set<string>();
    const partial: { key: IDBValidKey; ids: string[] }[] = [];
    keys.forEach((key, i) => {
      const ids = seenIdsOf(values[i]);
      if (ids.length < SEEN_CHUNK) partial.push({ key, ids });
      else for (const id of ids) seen.add(id);
    });
    const merge = store !== null && partial.length >= SEEN_MERGE_AT;
    const moved: string[] = [];
    for (const record of partial) {
      for (const id of record.ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (merge) moved.push(id);
      }
    }
    const listed = listedSeen(raw);
    for (const id of listed) {
      if (seen.has(id)) continue;
      seen.add(id);
      moved.push(id);
    }
    takeSeen(moved, true);
    let committed = () => {};
    if (store !== null) {
      if (merge) for (const record of partial) store.delete(record.key);
      if (listed.length > 0) {
        const record = raw as Record<string, unknown>;
        const ctx = record.ctx as Record<string, unknown>;
        store.put({ ...record, ctx: { ...ctx, visited: [] } }, contentKey);
      }
      committed = putUnsaved(store);
    }
    // What this page sees from now on starts a record of its own, so a
    // save rewrites only ids this page has seen.
    filling = null;
    return { seen: [...seen], committed };
  }

  /** `loadState`'s read, settling the seen records when `mode` allows. */
  async function readState(
    db: IDBDatabase,
    mode: IDBTransactionMode,
  ): Promise<PersistedState | null> {
    const tx = db.transaction(STATE_STORE, mode);
    const store = tx.objectStore(STATE_STORE);
    const recordRequest = store.get(contentKey);
    const keysRequest = store.getAllKeys(seenRange(contentKey));
    const valuesRequest = store.getAll(seenRange(contentKey));
    let raw: unknown;
    let seen: string[] = [];
    let committed = () => {};
    valuesRequest.onsuccess = () => {
      raw = recordRequest.result;
      ({ seen, committed } = settleSeen(
        mode === "readwrite" ? store : null,
        raw,
        keysRequest.result,
        valuesRequest.result,
      ));
    };
    await transactionDone(tx);
    committed();
    // Read defensively: a foreign or half-written record reads as no
    // persisted state (a first-ever load), never as a broken resume.
    const state = sanitizeState(raw);
    if (state?.ctx === undefined) return state;
    return { ...state, ctx: { ...state.ctx, visited: seen } };
  }

  // One listing at a time: a second waits for the first, then finds the
  // cache it wrote, so rows are never read in full twice over.
  let listing: Promise<unknown> = Promise.resolve();
  function listBookmarks(): Promise<BookmarkSummary[]> {
    const run = listing.then(readListing, readListing);
    listing = run.catch(() => undefined);
    return run;
  }

  async function readListing(): Promise<BookmarkSummary[]> {
    const db = await database();
    const tx = db.transaction([BOOKMARKS_STORE, STATE_STORE], "readonly");
    const store = tx.objectStore(BOOKMARKS_STORE);
    // The novel's row keys only — no row value is deserialized — then the
    // cache; requests complete in order, so both are in hand in the
    // second's success, which fetches the rows the cache lacks.
    const keysRequest = store
      .index(CONTENT_INDEX)
      .getAllKeys(IDBKeyRange.only(contentKey));
    const cacheRequest = tx.objectStore(STATE_STORE).get(cacheKey);
    let keys: number[] = [];
    let cached = new Map<number, CachedRow>();
    const fetched: CachedRow[] = [];
    cacheRequest.onsuccess = () => {
      keys = (keysRequest.result as IDBValidKey[]).filter(
        (key): key is number => typeof key === "number",
      );
      cached = sanitizeListCache(cacheRequest.result);
      for (const key of keys) {
        if (cached.has(key)) continue;
        const row = store.get(key);
        row.onsuccess = () => fetched.push(cachedRow(key, row.result));
      }
    };
    await transactionDone(tx);
    for (const row of fetched) cached.set(row.key, row);
    const rows = keys.flatMap((key) => {
      const row = cached.get(key);
      return row === undefined ? [] : [row];
    });
    // Write the cache back only when it changed: rows read in full, or
    // rows it still lists that are gone.
    if (fetched.length > 0 || cached.size !== rows.length) {
      await writeListCache(db, rows).catch(() => undefined);
    }
    return rows.filter((row): row is BookmarkSummary => !("skip" in row));
  }

  function writeListCache(
    db: IDBDatabase,
    rows: readonly CachedRow[],
  ): Promise<void> {
    const tx = db.transaction(STATE_STORE, "readwrite");
    tx.objectStore(STATE_STORE).put({ rows }, cacheKey);
    commitNow(tx);
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
    // The record and the seen records in one readwrite transaction, which
    // also settles the seen records (`settleSeen`) — all or nothing. Should
    // that fail (a full disk, say), a read-only load still hands back
    // everything: a failed move must never read as a first boot, whose
    // saves would then overwrite the old record and its list.
    async loadState(): Promise<PersistedState | null> {
      const db = await database();
      try {
        return await readState(db, "readwrite");
      } catch {
        startPageOver();
        return readState(db, "readonly");
      }
    },

    // `ctx.visited` holds the ids seen since the last save (storage/
    // saves.ts): they join this page's seen records here, before anything
    // can fail, and go out with the record. A state without a context
    // has no seen set: the stored one goes.
    async saveState(state: PersistedState): Promise<void> {
      if (state.ctx === undefined) startPageOver();
      else takeSeen(state.ctx.visited);
      const db = await database();
      const tx = db.transaction(STATE_STORE, "readwrite");
      const store = tx.objectStore(STATE_STORE);
      store.put(stateValue(state), contentKey);
      if (state.ctx === undefined) store.delete(seenRange(contentKey));
      const committed = putUnsaved(store);
      // Ask for the commit now instead of when the put's success event
      // has made the round trip back to this page (docs/plan.md Phase 18,
      // "Settings survive an immediate reload"): a reload a moment after
      // a change can tear the page down before that round trip, and a
      // transaction whose commit was never requested is then aborted.
      commitNow(tx);
      await transactionDone(tx);
      committed();
    },

    async addBookmark(bookmark: Bookmark): Promise<BookmarkSummary[]> {
      const db = await database();
      const tx = db.transaction(BOOKMARKS_STORE, "readwrite");
      tx.objectStore(BOOKMARKS_STORE).add(bookmarkValue(contentKey, bookmark));
      await transactionDone(tx); // durable before the list is read back
      return listBookmarks();
    },

    getBookmarks,

    listBookmarks,

    async getBookmark(key: number): Promise<Bookmark | null> {
      const db = await database();
      const tx = db.transaction(BOOKMARKS_STORE, "readonly");
      const raw = await requestPromise(
        tx.objectStore(BOOKMARKS_STORE).get(key),
      );
      // Only this novel's rows: a key is not a licence to read another's.
      if (
        typeof raw !== "object" ||
        raw === null ||
        (raw as BookmarkRecord).content !== contentKey
      ) {
        return null;
      }
      return sanitizeBookmark(raw);
    },

    // The `t` list's "x" (docs/plan.md Phase 18): the listed rows carrying
    // `id` (ids are not the store key — `seq` is) are found from the
    // summaries, not by deserializing every row, and deleted, committed
    // before the remaining list is read back.
    async deleteBookmark(id: string): Promise<BookmarkSummary[]> {
      const before = await listBookmarks();
      const keys = before.filter((row) => row.id === id).map((row) => row.key);
      if (keys.length === 0) return before;
      const db = await database();
      const tx = db.transaction(BOOKMARKS_STORE, "readwrite");
      const store = tx.objectStore(BOOKMARKS_STORE);
      for (const key of keys) store.delete(key);
      await transactionDone(tx);
      return listBookmarks();
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
      tx.objectStore(STATE_STORE).delete(seenRange(contentKey));
      await transactionDone(tx);
      startPageOver();
    },

    async deleteBookmarks(): Promise<void> {
      const db = await database();
      const tx = db.transaction([STATE_STORE, BOOKMARKS_STORE], "readwrite");
      tx.objectStore(STATE_STORE).delete(cacheKey);
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
      // The imported seen list stays in the record, where the next load
      // (the reload that follows) finds it and moves it, as for a save an
      // older build wrote; the story's seen records go.
      tx.objectStore(STATE_STORE).put(stateValue(state, true), contentKey);
      tx.objectStore(STATE_STORE).delete(seenRange(contentKey));
      tx.objectStore(STATE_STORE).delete(cacheKey);
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
      startPageOver();
    },
  };
}
