// The shipped IndexedDB adapter's story-ID keying and its one-time carry-
// over of progress saved under the folder URL (docs/plan.md Phase 21), run
// against a small in-test IndexedDB fake. The fake implements only what
// idb.ts calls (open/upgrade, get/getKey/put/add/delete, an index's getAll
// and cursor with update/delete/continue, transaction completion) with
// IndexedDB's ordering: requests run in issue order, a transaction
// completes once no request is pending, values are structured-cloned.
// Each test gets a fresh database and re-imports idb.ts; "reloading the
// page" is another import against the same fake database.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bookmark, SavedContext, Storage } from "./types";

type Key = string | number;
type Range = { only: Key };

interface StoreData {
  keyPath?: string;
  autoIncrement: boolean;
  next: number;
  records: Map<Key, unknown>;
  indexes: Map<string, string>;
}

class FakeRequest<T = unknown> {
  result: T | undefined;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}

class FakeTransaction {
  private pending = 0;
  private done = false;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;

  constructor(private readonly db: FakeDatabase) {}

  commit(): void {}

  objectStore(name: string): FakeObjectStore {
    const data = this.db.stores.get(name);
    if (data === undefined) throw new Error(`no store ${name}`);
    return new FakeObjectStore(this, data);
  }

  /** Run `step` as a request in issue order; it returns the result. */
  request<T>(step: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.pending += 1;
    setTimeout(() => {
      request.result = step();
      this.pending -= 1;
      request.onsuccess?.();
      this.settle();
    });
    return request;
  }

  /** A cursor request: `next` yields each step's result until null. */
  cursorRequest<T>(next: () => T | null): FakeRequest<T | null> {
    const request = new FakeRequest<T | null>();
    this.pending += 1;
    const step = () =>
      setTimeout(() => {
        const value = next();
        request.result = value;
        if (value === null) this.pending -= 1;
        request.onsuccess?.();
        this.settle();
      });
    step();
    (request as unknown as { step: () => void }).step = step;
    return request;
  }

  private settle(): void {
    setTimeout(() => {
      if (this.pending === 0 && !this.done) {
        this.done = true;
        this.oncomplete?.();
      }
    });
  }
}

function sortedKeys(records: Map<Key, unknown>): Key[] {
  return [...records.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

class FakeObjectStore {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly data: StoreData,
  ) {}

  get(key: Key) {
    return this.tx.request(() => structuredClone(this.data.records.get(key)));
  }

  getKey(key: Key) {
    return this.tx.request(() =>
      this.data.records.has(key) ? key : undefined,
    );
  }

  put(value: unknown, key?: Key) {
    return this.tx.request(() => this.write(value, key));
  }

  add(value: unknown) {
    return this.tx.request(() => this.write(value));
  }

  delete(key: Key) {
    return this.tx.request(() => {
      this.data.records.delete(key);
      return undefined;
    });
  }

  index(name: string) {
    const field = this.data.indexes.get(name);
    if (field === undefined) throw new Error(`no index ${name}`);
    const matching = (range: Range) =>
      sortedKeys(this.data.records).filter(
        (key) =>
          (this.data.records.get(key) as Record<string, unknown>)[field] ===
          range.only,
      );
    return {
      getAll: (range: Range) =>
        this.tx.request(() =>
          matching(range).map((key) =>
            structuredClone(this.data.records.get(key)),
          ),
        ),
      openCursor: (range: Range) => {
        let keys: Key[] | null = null;
        let request: FakeRequest<unknown> | null = null;
        const next = () => {
          keys ??= matching(range);
          while (keys.length > 0) {
            const key = keys.shift() as Key;
            if (!this.data.records.has(key)) continue;
            return {
              value: structuredClone(this.data.records.get(key)),
              delete: () =>
                this.tx.request(() => this.data.records.delete(key)),
              update: (value: unknown) =>
                this.tx.request(() => this.write(value)),
              continue: () =>
                (request as unknown as { step: () => void }).step(),
            };
          }
          return null;
        };
        request = this.tx.cursorRequest(next);
        return request;
      },
    };
  }

  private write(value: unknown, key?: Key): Key {
    const copy = structuredClone(value) as Record<string, unknown>;
    let storeKey = key;
    if (this.data.keyPath !== undefined) {
      if (copy[this.data.keyPath] === undefined && this.data.autoIncrement) {
        copy[this.data.keyPath] = this.data.next;
      }
      storeKey = copy[this.data.keyPath] as Key;
      if (typeof storeKey === "number" && storeKey >= this.data.next) {
        this.data.next = storeKey + 1;
      }
    }
    if (storeKey === undefined) throw new Error("no key");
    this.data.records.set(storeKey, copy);
    return storeKey;
  }
}

class FakeDatabase {
  readonly stores = new Map<string, StoreData>();
  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };

  createObjectStore(
    name: string,
    options: { keyPath?: string; autoIncrement?: boolean } = {},
  ) {
    const data: StoreData = {
      keyPath: options.keyPath,
      autoIncrement: options.autoIncrement ?? false,
      next: 1,
      records: new Map(),
      indexes: new Map(),
    };
    this.stores.set(name, data);
    return {
      createIndex: (index: string, field: string) =>
        data.indexes.set(index, field),
    };
  }

  transaction(_names: string | string[], _mode?: string) {
    return new FakeTransaction(this);
  }
}

function installFakeIndexedDb(): FakeDatabase {
  const db = new FakeDatabase();
  let created = false;
  vi.stubGlobal("IDBKeyRange", { only: (key: Key): Range => ({ only: key }) });
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request = new FakeRequest<FakeDatabase>();
      setTimeout(() => {
        request.result = db;
        if (!created) {
          created = true;
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    },
  });
  return db;
}

/** A fresh page load: idb.ts re-imported, its open-database cache empty. */
async function loadIdb() {
  vi.resetModules();
  return import("./idb");
}

async function open(key: string, legacyKey?: string): Promise<Storage> {
  const { createIdbStorage } = await loadIdb();
  const storage = createIdbStorage(key, legacyKey);
  if (storage === null) throw new Error("fake IndexedDB not installed");
  return storage;
}

function context(lastShown: string): SavedContext {
  return {
    lastShown,
    visited: [lastShown],
    stack: [],
    playedRoutes: [],
    completedRoutes: [],
  };
}

function bookmark(id: string, itemId: string): Bookmark {
  return {
    id,
    timestampMs: 1700000000000,
    itemId,
    ctx: context(itemId),
    thumbDataUrl: null,
  };
}

const OLD_FOLDER = "file:///Users/me/shelf/dawn/";
const NEW_FOLDER = "file:///Users/me/archive/dawn-renamed/";
const STORY = "story:dawn";

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("storageKeys — progress follows the story, not the folder (Phase 21)", () => {
  it("keys by story ID, with the folder URL as the carry-over source", async () => {
    const { storageKeys } = await loadIdb();
    expect(storageKeys("dawn", `${OLD_FOLDER}index.html`)).toEqual({
      key: STORY,
      legacyKey: OLD_FOLDER,
    });
    // Two folders of one story share one key.
    expect(storageKeys("dawn", `${NEW_FOLDER}index.html`).key).toBe(STORY);
  });

  it("falls back to the folder URL for a manifest with no or a bad storyId", async () => {
    const { storageKeys } = await loadIdb();
    for (const storyId of [
      undefined,
      "",
      "Dawn",
      "two words",
      7,
      "a".repeat(65),
    ]) {
      expect(storageKeys(storyId, `${OLD_FOLDER}index.html`)).toEqual({
        key: OLD_FOLDER,
      });
    }
  });
});

describe("IndexedDB adapter — carry-over from the folder URL (Phase 21)", () => {
  /** Progress the pre-Phase-21 player saved under the folder URL. */
  async function seedLegacy(): Promise<void> {
    const old = await open(OLD_FOLDER);
    await old.saveState({ ctx: context("x-7"), helpSeen: true });
    await old.addBookmark(bookmark("b1", "x-3"));
    await old.addBookmark(bookmark("b2", "x-5"));
  }

  it("carries state and bookmarks over to the story key, then follows a move", async () => {
    installFakeIndexedDb();
    await seedLegacy();

    const story = await open(STORY, OLD_FOLDER);
    expect(await story.loadState()).toEqual({
      ctx: context("x-7"),
      helpSeen: true,
    });
    expect((await story.getBookmarks()).map((b) => b.id)).toEqual(["b1", "b2"]);

    // Moved, not copied: nothing is left under the folder URL.
    const old = await open(OLD_FOLDER);
    expect(await old.loadState()).toBeNull();
    expect(await old.getBookmarks()).toEqual([]);

    // The folder moved: a new URL, the same story, the same progress.
    const moved = await open(STORY, NEW_FOLDER);
    expect((await moved.loadState())?.ctx?.lastShown).toBe("x-7");
    expect((await moved.getBookmarks()).map((b) => b.itemId)).toEqual([
      "x-3",
      "x-5",
    ]);
  });

  it("carries over before a bookmarks read that comes first", async () => {
    installFakeIndexedDb();
    await seedLegacy();
    const story = await open(STORY, OLD_FOLDER);
    expect((await story.getBookmarks()).map((b) => b.id)).toEqual(["b1", "b2"]);
    expect((await story.loadState())?.ctx?.lastShown).toBe("x-7");
  });

  it("never overwrites progress the story key already has", async () => {
    installFakeIndexedDb();
    const story = await open(STORY);
    await story.saveState({ ctx: context("x-9") });
    await seedLegacy();

    const reopened = await open(STORY, OLD_FOLDER);
    expect((await reopened.loadState())?.ctx?.lastShown).toBe("x-9");
    expect(await reopened.getBookmarks()).toEqual([]);
    // The other folder's progress stays where it was.
    expect((await (await open(OLD_FOLDER)).loadState())?.ctx?.lastShown).toBe(
      "x-7",
    );
  });

  it("runs once: Reset progress after the carry-over does not bring it back", async () => {
    installFakeIndexedDb();
    await seedLegacy();
    const story = await open(STORY, OLD_FOLDER);
    expect(await story.loadState()).not.toBeNull();
    await story.deleteState();
    await story.deleteBookmarks();

    const reloaded = await open(STORY, OLD_FOLDER);
    expect(await reloaded.loadState()).toBeNull();
    expect(await reloaded.getBookmarks()).toEqual([]);
  });

  it("a manifest without storyId keeps the folder URL key and its progress", async () => {
    installFakeIndexedDb();
    await seedLegacy();
    const { storageKeys } = await loadIdb();
    const keys = storageKeys(undefined, `${OLD_FOLDER}index.html`);
    const folder = await open(keys.key, keys.legacyKey);
    expect((await folder.loadState())?.ctx?.lastShown).toBe("x-7");
    expect((await folder.getBookmarks()).map((b) => b.id)).toEqual([
      "b1",
      "b2",
    ]);
  });
});

describe("IndexedDB adapter — replaceProgress (Import progress, Phase 21)", () => {
  it("replaces this story's state and bookmarks, leaving other stories alone", async () => {
    installFakeIndexedDb();
    const story = await open(STORY);
    await story.saveState({ ctx: context("x-1"), helpSeen: false });
    await story.addBookmark(bookmark("old-1", "x-1"));
    await story.addBookmark(bookmark("old-2", "x-2"));
    const other = await open("story:night");
    await other.saveState({ ctx: context("n-4") });
    await other.addBookmark(bookmark("n-1", "n-4"));

    await story.replaceProgress(
      { ctx: context("x-9"), settings: { readingSpeed: 2 }, helpSeen: true },
      [bookmark("new-1", "x-5"), bookmark("new-2", "x-8")],
    );

    // What the next page load reads.
    const reloaded = await open(STORY);
    expect(await reloaded.loadState()).toEqual({
      ctx: context("x-9"),
      settings: { readingSpeed: 2 },
      helpSeen: true,
    });
    expect((await reloaded.getBookmarks()).map((b) => b.id)).toEqual([
      "new-1",
      "new-2",
    ]);
    // Bookmarks keep working after the replace: a new one appends.
    const after = await reloaded.addBookmark(bookmark("new-3", "x-9"));
    expect(after.map((b) => b.id)).toEqual(["new-1", "new-2", "new-3"]);
    // Another story's progress is untouched.
    const night = await open("story:night");
    expect((await night.loadState())?.ctx?.lastShown).toBe("n-4");
    expect((await night.getBookmarks()).map((b) => b.id)).toEqual(["n-1"]);
  });

  it("an empty import leaves an empty record and no bookmarks", async () => {
    installFakeIndexedDb();
    const story = await open(STORY);
    await story.saveState({ ctx: context("x-1") });
    await story.addBookmark(bookmark("old-1", "x-1"));
    await story.replaceProgress({}, []);
    const reloaded = await open(STORY);
    expect(await reloaded.loadState()).toEqual({});
    expect(await reloaded.getBookmarks()).toEqual([]);
  });
});
