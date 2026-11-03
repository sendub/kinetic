// The shipped IndexedDB adapter's story-ID keying and its one-time carry-
// over of progress saved under the folder URL (docs/plan.md Phase 21), run
// against a small in-test IndexedDB fake. The fake implements only what
// idb.ts calls (open/upgrade, get/getKey/put/add/delete, an index's getAll
// and cursor with update/delete/continue, transaction completion) with
// IndexedDB's ordering: requests run in issue order, a transaction
// completes once no request is pending, values are structured-cloned.
// Each test gets a fresh database and re-imports idb.ts; "reloading the
// page" is another import against the same fake database.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMachine } from "../machine/machine";
import type { Branch, Item } from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import { bookmarkRestoreTarget, mergeProgress } from "../render/bookmarks";
import { createContextCodec, resumeOptionsFor } from "./ids";
import { importProgress, parseProgressFile } from "./transfer";
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

// docs/plan.md Phase 27: saves from the reading-history days migrate
// silently. The fixture is a real export written by the player before the
// timeline (commit 7e420b8) on the manifest below: read with both branches,
// a bookmark at m9, one at m12 that still carries its history, then the
// m9 bookmark clicked and the wheel turned back once — so the old record
// put the reader back on m12, reading order rather than story order.
describe("IndexedDB adapter — old reading-history saves migrate (Phase 27)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const oldFile = readFileSync(
    join(here, "fixtures", "old-timeline-progress.json"),
    "utf8",
  );
  const ids = [
    "m0",
    "m1",
    "m2",
    "m3",
    "a1",
    "a2",
    "c1",
    "c2",
    "c3",
    "m4",
    "m5",
    "m6",
    "e1",
    "e2",
    "k1",
    "k2",
    "k3",
    "m7",
    "m8",
    "m9",
    "m10",
    "m11",
    "m12",
    "m13",
    "m14",
  ];
  const items: Item[] = ids.map((id) => ({
    id,
    type: "image",
    file: `${id}.jpg`,
  }));
  const branches: Branch[] = [
    {
      id: "dA",
      after: "m3",
      prompt: "A?",
      routes: [
        {
          id: "aShort",
          label: "Short",
          start: "a1",
          end: "a2",
          result: "return",
        },
        { id: "aCont", label: "Cont", start: "c1", end: "c3" },
      ],
      continuingRoute: "aCont",
      continueAt: "m4",
    },
    {
      id: "dB",
      after: "m6",
      prompt: "B?",
      routes: [
        { id: "bEnd", label: "End", start: "e1", end: "e2" },
        { id: "bCont", label: "Cont", start: "k1", end: "k3" },
      ],
      continuingRoute: "bCont",
      continueAt: "m7",
    },
  ];
  const at = (id: string) => ids.indexOf(id);
  const STORY_KEY = "story:timeline-demo";

  /** The old records as the old player left them in IndexedDB. */
  async function seedOldRecords(): Promise<void> {
    const file = JSON.parse(oldFile) as {
      state: unknown;
      bookmarks: unknown[];
    };
    expect(JSON.stringify(file.state)).toContain('"history"');
    const old = await open(STORY_KEY);
    await old.saveState(file.state as never);
    for (const raw of file.bookmarks) await old.addBookmark(raw as never);
  }

  /** A page load: storage read, codec, machine — as main.ts does it. */
  async function boot() {
    const storage = await open(STORY_KEY);
    const codec = createContextCodec(items, branches);
    const persisted = await storage.loadState();
    const machine = createMachine({
      items,
      branches,
      settings: { ...DEFAULT_SETTINGS, ...persisted?.settings },
      ...resumeOptionsFor(persisted, codec),
    });
    return { storage, codec, persisted, machine };
  }

  it("loads silently: position, seen marks, routes, settings and bookmarks kept; last picks derived; the record dropped", async () => {
    installFakeIndexedDb();
    await seedOldRecords();
    const { storage, codec, persisted, machine } = await boot();
    expect(persisted?.ctx).not.toHaveProperty("history");
    expect(persisted?.ctx).not.toHaveProperty("historyPos");
    expect(persisted?.helpSeen).toBe(true);
    expect(persisted?.settings).toEqual({ playAllRoutes: false });
    // The position the old save was on, and every seen mark.
    expect(machine.getState()).toMatchObject({
      cursor: at("m12"),
      settled: true,
    });
    expect(machine.visitedList().map((i) => ids[i])).toEqual(
      ids.filter((id) => !["e1", "e2", "m13", "m14"].includes(id)),
    );
    const ctx = machine.exportContext();
    expect(ctx.playedRoutes).toEqual([
      { decision: 0, routes: [0, 1] },
      { decision: 1, routes: [1] },
    ]);
    expect(ctx.completedRoutes).toEqual(ctx.playedRoutes);
    // The latest route entered at each decision: aCont (after aShort), bCont.
    expect(ctx.lastPicks).toEqual([
      { decision: 0, route: 1 },
      { decision: 1, route: 1 },
    ]);
    // The wheel walks the story order from there.
    machine.wheelBack();
    expect(machine.getState().cursor).toBe(at("m11"));
    // Both bookmarks are kept, the one with a history included.
    const bookmarks = await storage.getBookmarks();
    expect(bookmarks.map((b) => [b.id, b.itemId])).toEqual([
      ["bm-a", "m9"],
      ["bm-b", "m12"],
    ]);
    expect(bookmarks[1].ctx).not.toHaveProperty("history");
    // Clicking the m9 bookmark lands there; the wheel walks back along the
    // story and the last picks (into bCont through dB's choice screen),
    // never up to m12 as the old record did.
    const target = codec.fromSaved(bookmarkRestoreTarget(bookmarks[0]).ctx);
    if (target === undefined) throw new Error("bookmark did not resolve");
    machine.importContext(mergeProgress(target, machine.exportContext()));
    expect(machine.getState().cursor).toBe(at("m9"));
    const back: string[] = [];
    for (let notch = 0; notch < 6; notch += 1) {
      machine.wheelBack();
      const choice = machine.getState().choice;
      back.push(
        choice === undefined
          ? ids[machine.getState().cursor]
          : `${choice.decisionId}>${String(choice.walkRoute)}`,
      );
    }
    expect(back).toEqual(["m8", "m7", "k3", "k2", "k1", "dB>1"]);
    machine.jumpToEnd();
    expect(machine.getState().cursor).toBe(at("m12"));
    // The next save writes the new shape: no record, never again.
    await storage.saveState({ ctx: codec.toSaved(machine.exportContext()) });
    machine.destroy();
    const again = await boot();
    expect(again.persisted?.ctx?.lastPicks).toEqual([
      { decision: "dA", route: "aCont" },
      { decision: "dB", route: "bCont" },
    ]);
    expect(again.machine.getState().cursor).toBe(at("m12"));
    again.machine.destroy();
  });

  it("an old export file imports through the same migration", async () => {
    installFakeIndexedDb();
    const parsed = parseProgressFile(oldFile, {
      storyId: "timeline-demo",
      title: "Timeline demo",
    });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.state.ctx).not.toHaveProperty("history");
    const storage = await open(STORY_KEY);
    const ok = await importProgress({
      flush: async () => {},
      storage,
      reload: () => {},
      progress: parsed,
    });
    expect(ok).toBe(true);
    const { machine, storage: reloaded } = await boot();
    expect(machine.getState().cursor).toBe(at("m12"));
    expect(machine.exportContext().lastPicks).toEqual([
      { decision: 0, route: 1 },
      { decision: 1, route: 1 },
    ]);
    expect((await reloaded.getBookmarks()).map((b) => b.itemId)).toEqual([
      "m9",
      "m12",
    ]);
    machine.destroy();
  });
});
