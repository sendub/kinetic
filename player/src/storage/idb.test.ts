// The shipped IndexedDB adapter's story-ID keying and its one-time carry-
// over of progress saved under the folder URL (docs/plan.md Phase 21), run
// against a small in-test IndexedDB fake, and (Phase 46) the seen set's
// own records. The fake implements only what idb.ts calls (open/upgrade,
// get/getKey/put/add/delete, a store's getAll/getAllKeys and a delete over
// a key range, an index's getAll and cursor with update/delete/continue,
// transaction completion, array keys in IndexedDB's key order) with
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
import { resetProgress } from "../render/confirm";
import { createContextCodec, resumeOptionsFor } from "./ids";
import { createStateWriter } from "./saves";
import { importProgress, parseProgressFile } from "./transfer";
import type { Bookmark, SavedContext, Storage } from "./types";

type Key = string | number | Key[];
/** A key range: `only(key)` is a range from the key to itself. */
interface Range {
  lower: Key;
  upper: Key;
  lowerOpen: boolean;
  upperOpen: boolean;
}

/**
 * IndexedDB's key order: numbers before strings before arrays; arrays
 * element by element, a prefix first.
 */
function compareKeys(a: Key, b: Key): number {
  const rank = (k: Key) =>
    typeof k === "number" ? 0 : typeof k === "string" ? 1 : 2;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      const c = compareKeys(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function inRange(key: Key, range: Range): boolean {
  const low = compareKeys(key, range.lower);
  const high = compareKeys(key, range.upper);
  return (
    (range.lowerOpen ? low > 0 : low >= 0) &&
    (range.upperOpen ? high < 0 : high <= 0)
  );
}

const isRange = (value: unknown): value is Range =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  "lower" in value;

// The records map holds a string or number key as itself (so a test can
// read `records.get("bookmark-list:...")`) and an array key encoded.
const ARRAY_KEY = "\u0001array:";
const storedKey = (key: Key): string | number =>
  Array.isArray(key) ? `${ARRAY_KEY}${JSON.stringify(key)}` : key;
const keyOf = (stored: string | number): Key =>
  typeof stored === "string" && stored.startsWith(ARRAY_KEY)
    ? (JSON.parse(stored.slice(ARRAY_KEY.length)) as Key)
    : stored;

interface StoreData {
  /** How many record values were read (and so deserialized). */
  reads: number;
  /** Every value written, in order, with its key: what a save wrote. */
  writes: { key: Key; value: unknown }[];
  keyPath?: string;
  autoIncrement: boolean;
  next: number;
  records: Map<string | number, unknown>;
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
  /** Each store's records as they were, when this transaction is to fail. */
  private readonly before: Map<StoreData, Map<string | number, unknown>> | null;

  constructor(private readonly db: FakeDatabase) {
    this.before = db.failNext
      ? new Map([...db.stores.values()].map((d) => [d, new Map(d.records)]))
      : null;
    db.failNext = false;
  }

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
        if (this.before === null) {
          this.oncomplete?.();
          return;
        }
        // Aborted: nothing it wrote stays.
        for (const [data, records] of this.before) data.records = records;
        this.error = new Error("aborted (test)");
        this.onabort?.();
      }
    });
  }
}

function sortedKeys(records: Map<string | number, unknown>): Key[] {
  return [...records.keys()].map(keyOf).sort(compareKeys);
}

class FakeObjectStore {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly data: StoreData,
  ) {}

  get(key: Key) {
    return this.tx.request(() => this.read(key));
  }

  private read(key: Key): unknown {
    const stored = storedKey(key);
    if (this.data.records.has(stored)) this.data.reads += 1;
    return structuredClone(this.data.records.get(stored));
  }

  private keysIn(range?: Range): Key[] {
    return sortedKeys(this.data.records).filter(
      (key) => range === undefined || inRange(key, range),
    );
  }

  getKey(key: Key) {
    return this.tx.request(() =>
      this.data.records.has(storedKey(key)) ? key : undefined,
    );
  }

  getAll(range?: Range) {
    return this.tx.request(() =>
      this.keysIn(range).map((key) => this.read(key)),
    );
  }

  getAllKeys(range?: Range) {
    return this.tx.request(() => this.keysIn(range));
  }

  put(value: unknown, key?: Key) {
    return this.tx.request(() => this.write(value, key));
  }

  add(value: unknown) {
    return this.tx.request(() => this.write(value));
  }

  delete(key: Key | Range) {
    return this.tx.request(() => {
      const keys = isRange(key) ? this.keysIn(key) : [key];
      for (const one of keys) this.data.records.delete(storedKey(one));
      return undefined;
    });
  }

  clear() {
    return this.tx.request(() => {
      this.data.records.clear();
      return undefined;
    });
  }

  index(name: string) {
    const field = this.data.indexes.get(name);
    if (field === undefined) throw new Error(`no index ${name}`);
    const matching = (range: Range) =>
      sortedKeys(this.data.records).filter((key) =>
        inRange(
          (this.data.records.get(storedKey(key)) as Record<string, Key>)[field],
          range,
        ),
      );
    return {
      getAll: (range: Range) =>
        this.tx.request(() => matching(range).map((key) => this.read(key))),
      // Primary keys only: no value is read.
      getAllKeys: (range: Range) => this.tx.request(() => matching(range)),
      openCursor: (range: Range) => {
        let keys: Key[] | null = null;
        let request: FakeRequest<unknown> | null = null;
        const next = () => {
          keys ??= matching(range);
          while (keys.length > 0) {
            const key = keys.shift() as Key;
            if (!this.data.records.has(storedKey(key))) continue;
            return {
              value: this.read(key),
              delete: () =>
                this.tx.request(() => this.data.records.delete(storedKey(key))),
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
    this.data.records.set(storedKey(storeKey), copy);
    this.data.writes.push({ key: storeKey, value: copy });
    return storeKey;
  }
}

class FakeDatabase {
  readonly stores = new Map<string, StoreData>();
  /** The next transaction aborts, keeping nothing it wrote. */
  failNext = false;
  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };

  createObjectStore(
    name: string,
    options: { keyPath?: string; autoIncrement?: boolean } = {},
  ) {
    const data: StoreData = {
      reads: 0,
      writes: [],
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
  vi.stubGlobal("IDBKeyRange", {
    only: (key: Key): Range => ({
      lower: key,
      upper: key,
      lowerOpen: false,
      upperOpen: false,
    }),
    bound: (
      lower: Key,
      upper: Key,
      lowerOpen = false,
      upperOpen = false,
    ): Range => ({ lower, upper, lowerOpen, upperOpen }),
  });
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

describe("IndexedDB adapter — the branch map's view (Phase 41)", () => {
  const view = {
    view: "full" as const,
    layout: "12:abc",
    place: { at: 410.5, dy: 96 },
  };

  it("survives a reload in the state record, beside the progress", async () => {
    installFakeIndexedDb();
    const before = await open(STORY);
    await before.saveState({ ctx: context("x-3"), mapView: view });
    const after = await open(STORY);
    expect((await after.loadState())?.mapView).toEqual(view);
  });

  it("reads one an older build wrote (Phase 33's fit, centre and scale) as none, the progress kept", async () => {
    installFakeIndexedDb();
    const before = await open(STORY);
    const old = { layout: "12:abc", fit: false, cx: 410.5, cy: 96, scale: 1.7 };
    await before.saveState({ ctx: context("x-3"), mapView: old as never });
    const loaded = await (await open(STORY)).loadState();
    expect(loaded?.mapView).toBeUndefined();
    expect(loaded?.ctx).toEqual(context("x-3"));
  });

  it("a reset deletes it with the record: the next load has none (Full size, centred)", async () => {
    installFakeIndexedDb();
    const story = await open(STORY);
    await story.saveState({ ctx: context("x-3"), mapView: view });
    await story.deleteState();
    const after = await open(STORY);
    expect((await after.loadState())?.mapView).toBeUndefined();
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

// The bookmark-screen speed item (docs/progress.md): `t` lists bookmarks
// from their summaries, cached in a `state` record, so a listing reads no
// bookmark row in full once the cache knows it. Bookmarks saved before
// the cache existed — in the existing format, history-carrying ones
// included — are listed from a one-time full read that writes the cache.
describe("IndexedDB adapter — the t list reads summaries, not whole rows", () => {
  const KEY = "story:speed";
  const thumb = "data:image/jpeg;base64,/9j/AAAA";

  function rows(db: FakeDatabase) {
    const data = db.stores.get("bookmarks");
    if (data === undefined) throw new Error("no bookmarks store");
    return data;
  }

  /** A row exactly as the player before this change stored it. */
  function oldRow(id: string, itemId: string, withThumb: boolean) {
    return {
      content: KEY,
      id,
      timestampMs: 1700000000000 + id.length,
      itemId,
      ctx: {
        ...context(itemId),
        // A reading-history-era context (docs/plan.md Phase 27): heavy.
        history: Array.from({ length: 50 }, (_, n) => ({
          item: `h-${String(n)}`,
          stack: [],
        })),
        historyPos: 49,
      },
      thumbDataUrl: withThumb ? thumb : null,
    };
  }

  async function seed(db: FakeDatabase, records: unknown[]): Promise<void> {
    // Written straight into the store, as an older build's addBookmark did.
    const storage = await open(KEY);
    await storage.loadState(); // opens (and creates) the database
    const data = rows(db);
    for (const record of records) {
      const seq = data.next;
      data.next += 1;
      data.records.set(seq, { ...(record as object), seq });
    }
  }

  it("lists existing bookmarks (the old format) once in full, then from the cache alone", async () => {
    const db = installFakeIndexedDb();
    await seed(db, [
      oldRow("a", "x-1", true),
      oldRow("b", "x-2", false),
      // Not listable (an index-based row): skipped, and remembered as such.
      { content: KEY, id: "old", timestampMs: 1, itemIndex: 3 },
      oldRow("c", "x-3", true),
    ]);
    const first = await open(KEY);
    const listed = await first.listBookmarks();
    expect(listed.map((row) => [row.id, row.itemId, row.hasThumb])).toEqual([
      ["a", "x-1", true],
      ["b", "x-2", false],
      ["c", "x-3", true],
    ]);
    expect(rows(db).reads).toBe(4); // the one-time full read
    // A later page load lists the same rows reading no row at all.
    const second = await open(KEY);
    rows(db).reads = 0;
    expect(await second.listBookmarks()).toEqual(listed);
    expect(rows(db).reads).toBe(0);
    // A summary's key reads the whole bookmark, migrated as before.
    const whole = await second.getBookmark(listed[0].key);
    expect(whole).toMatchObject({
      id: "a",
      itemId: "x-1",
      thumbDataUrl: thumb,
    });
    expect(whole?.ctx).not.toHaveProperty("history");
    expect(await second.getBookmarks()).toHaveLength(3);
  });

  it("notices rows another build added or deleted behind the cache", async () => {
    const db = installFakeIndexedDb();
    await seed(db, [oldRow("a", "x-1", true), oldRow("b", "x-2", true)]);
    const storage = await open(KEY);
    const before = await storage.listBookmarks();
    // An older build (no cache) deletes "a" and appends "c".
    rows(db).records.delete(before[0].key);
    await seed(db, [oldRow("c", "x-3", false)]);
    rows(db).reads = 0;
    const after = await (await open(KEY)).listBookmarks();
    expect(after.map((row) => row.id)).toEqual(["b", "c"]);
    expect(rows(db).reads).toBe(1); // only the new row
    expect(await storage.getBookmark(before[0].key)).toBeNull();
  });

  it("b and the x keep the list current without reading the other rows", async () => {
    const db = installFakeIndexedDb();
    const storage = await open(KEY);
    await storage.addBookmark(bookmark("a", "x-1"));
    await storage.addBookmark(bookmark("b", "x-2"));
    rows(db).reads = 0;
    const added = await storage.addBookmark(bookmark("c", "x-3"));
    expect(added.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(rows(db).reads).toBe(1); // the new row only
    rows(db).reads = 0;
    const left = await storage.deleteBookmark("b");
    expect(left.map((row) => row.id)).toEqual(["a", "c"]);
    expect(rows(db).reads).toBe(0);
    expect((await storage.getBookmarks()).map((b) => b.id)).toEqual(["a", "c"]);
  });

  it("never reads another novel's row by key", async () => {
    installFakeIndexedDb();
    const other = await open("story:other");
    const [row] = await other.addBookmark(bookmark("o", "x-1"));
    const mine = await open(KEY);
    expect(await mine.getBookmark(row.key)).toBeNull();
    expect(await mine.listBookmarks()).toEqual([]);
  });

  it("reset and import drop the cache with the rows", async () => {
    const db = installFakeIndexedDb();
    const storage = await open(KEY);
    await storage.addBookmark(bookmark("a", "x-1"));
    const states = db.stores.get("state");
    expect(states?.records.has(`bookmark-list:${KEY}`)).toBe(true);
    await storage.deleteBookmarks();
    expect(states?.records.has(`bookmark-list:${KEY}`)).toBe(false);
    expect(await storage.listBookmarks()).toEqual([]);
    await storage.replaceProgress({}, [bookmark("i", "x-4")]);
    expect(states?.records.has(`bookmark-list:${KEY}`)).toBe(false);
    expect((await storage.listBookmarks()).map((row) => row.id)).toEqual(["i"]);
  });

  it("a malformed cache record or row is read again, never trusted", async () => {
    const { sanitizeListCache } = await loadIdb();
    expect(sanitizeListCache(null).size).toBe(0);
    expect(sanitizeListCache({ rows: "x" }).size).toBe(0);
    const parsed = sanitizeListCache({
      rows: [
        { key: 1, id: "a", timestampMs: 5, itemId: "x-1", hasThumb: true },
        { key: 2, skip: true },
        { key: "3", id: "c", timestampMs: 5, itemId: "x", hasThumb: false },
        { key: 4, id: "d", timestampMs: 5, itemId: "x" },
      ],
    });
    expect([...parsed.keys()]).toEqual([1, 2]);
  });
});

// docs/plan.md Phase 46, item 1: the seen set lives in its own `state`
// records, a few hundred ids each, keyed by story; the state record keeps
// the place with an empty `ctx.visited`. A save writes the place and the
// ids newly seen, so it costs the same however much has been read; an old
// save (the whole seen list in the record) moves over at its first load.
// The fixture is a progress file in the layout the player wrote before
// this phase: 650 items seen of an 800-item story with one decision, two
// bookmarks; its `state` is also the old state record itself.
describe("IndexedDB adapter — the seen set in its own records (Phase 46)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixtureText = readFileSync(
    join(here, "fixtures", "pre46-progress.json"),
    "utf8",
  );
  const fixture = JSON.parse(fixtureText) as {
    state: { ctx: SavedContext; settings: object; helpSeen: boolean };
    bookmarks: Bookmark[];
  };
  const KEY46 = "story:pre46";
  const ids = Array.from(
    { length: 800 },
    (_, n) => `line-${String(n).padStart(4, "0")}`,
  );
  const imageItems = (list: readonly string[]): Item[] =>
    list.map((id) => ({ id, type: "image", file: `${id}.jpg` }));
  const items = imageItems(ids);
  const branches: Branch[] = [
    {
      id: "d1",
      after: "line-0009",
      prompt: "Which way?",
      routes: [
        { id: "r-a", label: "A", start: "line-0010", end: "line-0019" },
        {
          id: "r-b",
          label: "B",
          start: "line-0020",
          end: "line-0029",
          result: "return",
        },
      ],
      continuingRoute: "r-a",
      continueAt: "line-0030",
    },
  ];
  const oldSeen = [...fixture.state.ctx.visited].sort();

  /** The state record as an older player left it, written straight in. */
  async function seedRecord(
    db: FakeDatabase,
    key: string,
    record: unknown,
  ): Promise<void> {
    await (await open(key)).loadState(); // opens (and creates) the database
    db.stores.get("state")?.records.set(key, structuredClone(record));
  }

  /** The story's seen records, in key order: each record's ids. */
  function seenRecords(db: FakeDatabase, key: string): string[][] {
    const data = db.stores.get("state");
    if (data === undefined) return [];
    return sortedKeys(data.records)
      .filter((k) => Array.isArray(k) && k[0] === "seen" && k[1] === key)
      .map((k) => data.records.get(storedKey(k)) as string[]);
  }

  /**
   * A page load as main.ts does it: storage read, codec, machine, and the
   * state writer; `save()` is the write a screen change issues.
   */
  async function boot(
    key = KEY46,
    list: readonly Item[] = items,
    table: readonly Branch[] = branches,
  ) {
    const storage = await open(key);
    const codec = createContextCodec(list, table);
    const persisted = await storage.loadState();
    const machine = createMachine({
      items: list,
      branches: table,
      settings: { ...DEFAULT_SETTINGS, ...persisted?.settings },
      ...resumeOptionsFor(persisted, codec),
    });
    const write = createStateWriter({ storage, machine, codec });
    const save = () =>
      write({
        ctx: codec.toSaved(machine.exportPlace()),
        settings: persisted?.settings ?? {},
        helpSeen: true,
      });
    const seenIds = () => machine.visitedList().map((i) => list[i].id);
    return { storage, codec, persisted, machine, save, seenIds };
  }

  it("a save writes the place and the newly seen ids, never the seen list: the same at 100 and at 10,000 seen", async () => {
    const padded = Array.from(
      { length: 10_200 },
      (_, n) => `s${String(n).padStart(7, "0")}-route-segment-line-xx`,
    );
    const big = imageItems(padded);
    const written: string[][] = [];
    for (const seen of [100, 10_000]) {
      const db = installFakeIndexedDb();
      await seedRecord(db, KEY46, {
        ctx: {
          lastShown: padded[seen - 1],
          visited: padded.slice(0, seen),
          stack: [],
          playedRoutes: [],
          completedRoutes: [],
        },
        helpSeen: true,
      });
      const { machine, save } = await boot(KEY46, big, []);
      machine.advance();
      await save();
      const states = db.stores.get("state");
      if (states === undefined) throw new Error("no state store");
      states.writes.length = 0;
      machine.advance();
      await save();
      // One state record, with the place and no seen list, and one seen
      // record: this page's, holding the ids it has seen.
      const [record, seenRecord, ...rest] = states.writes;
      expect(rest).toEqual([]);
      expect(record.key).toBe(KEY46);
      expect(record.value).toMatchObject({
        ctx: { lastShown: padded[seen + 1], visited: [] },
      });
      expect(Array.isArray(seenRecord.key)).toBe(true);
      expect(seenRecord.value).toEqual([padded[seen], padded[seen + 1]]);
      written.push(states.writes.map((write) => JSON.stringify(write.value)));
      machine.destroy();
    }
    // The same bytes whatever had been read before.
    expect(written[1].map((v) => v.length)).toEqual(
      written[0].map((v) => v.length),
    );
  });

  it("an old save loads with every seen id, moves to its own records, and the next save and reload keep the set", async () => {
    const db = installFakeIndexedDb();
    await seedRecord(db, KEY46, fixture.state);
    const first = await boot();
    expect([...(first.persisted?.ctx?.visited ?? [])].sort()).toEqual(oldSeen);
    expect(first.seenIds().sort()).toEqual(oldSeen);
    expect(first.machine.getState().cursor).toBe(ids.indexOf("line-0649"));
    expect(first.persisted?.settings).toEqual(fixture.state.settings);
    // Moved at the load: the record keeps everything but the list, and
    // the ids sit in seen records of at most 500.
    const record = db.stores.get("state")?.records.get(KEY46) as {
      ctx: SavedContext;
      settings: object;
    };
    expect(record.ctx).toEqual({ ...fixture.state.ctx, visited: [] });
    expect(record.settings).toEqual(fixture.state.settings);
    const chunks = seenRecords(db, KEY46);
    expect(chunks.map((chunk) => chunk.length)).toEqual([500, 150]);
    expect(chunks.flat().sort()).toEqual(oldSeen);

    first.machine.advance();
    await first.save();
    first.machine.destroy();
    const second = await boot();
    expect(second.seenIds().sort()).toEqual([...oldSeen, "line-0650"].sort());
    expect(second.machine.getState().cursor).toBe(ids.indexOf("line-0650"));
    // Nothing moved twice: the old ids are stored once.
    expect(seenRecords(db, KEY46).flat().sort()).toEqual(
      [...oldSeen, "line-0650"].sort(),
    );
    second.machine.destroy();
  });

  it("a save that fails loses no seen id: the next one writes it again", async () => {
    const db = installFakeIndexedDb();
    await seedRecord(db, KEY46, fixture.state);
    const first = await boot();
    first.machine.advance(); // line-0650
    db.failNext = true;
    await expect(first.save()).rejects.toThrow();
    first.machine.advance(); // line-0651
    await first.save();
    first.machine.destroy();
    const second = await boot();
    expect(second.seenIds().sort()).toEqual(
      [...oldSeen, "line-0650", "line-0651"].sort(),
    );
    expect(second.machine.getState().cursor).toBe(ids.indexOf("line-0651"));
    second.machine.destroy();
    // A failed write that filled a record: the next write, which starts a
    // new record, puts the full one again too.
    const story = await open("story:fill");
    const place = (visited: string[]): SavedContext => ({
      ...context(ids[0]),
      visited,
    });
    db.failNext = true;
    await expect(
      story.saveState({ ctx: place(ids.slice(0, 500)) }),
    ).rejects.toThrow();
    await story.saveState({ ctx: place([ids[500]]) });
    const reloaded = await (await open("story:fill")).loadState();
    expect(reloaded?.ctx?.visited).toEqual(ids.slice(0, 501));
  });

  it("a load whose move fails (a full disk) still reads every seen id, and the next save moves them with the record", async () => {
    const db = installFakeIndexedDb();
    await seedRecord(db, KEY46, fixture.state);
    db.failNext = true; // the load's own transaction
    const first = await boot();
    expect(first.seenIds().sort()).toEqual(oldSeen);
    // Nothing moved: the old record still holds its list.
    const untouched = db.stores.get("state")?.records.get(KEY46) as {
      ctx: SavedContext;
    };
    expect(untouched.ctx.visited).toEqual(fixture.state.ctx.visited);
    expect(seenRecords(db, KEY46)).toEqual([]);
    first.machine.advance();
    await first.save();
    first.machine.destroy();
    const stored = db.stores.get("state")?.records.get(KEY46) as {
      ctx: SavedContext;
    };
    expect(stored.ctx.visited).toEqual([]);
    const second = await boot();
    expect(second.seenIds().sort()).toEqual([...oldSeen, "line-0650"].sort());
    second.machine.destroy();
  });

  it("merges the seen list an older build wrote after this one", async () => {
    const db = installFakeIndexedDb();
    await seedRecord(db, KEY46, fixture.state);
    const first = await boot();
    first.machine.advance();
    await first.save();
    first.machine.destroy();
    // An older build opens the story: it reads an empty list (it shows
    // fewer seen marks, the accepted cost), reads on, and saves its own.
    const record = db.stores.get("state")?.records.get(KEY46) as {
      ctx: SavedContext;
    };
    db.stores.get("state")?.records.set(KEY46, {
      ...record,
      ctx: {
        ...record.ctx,
        lastShown: "line-0652",
        visited: ["line-0650", "line-0651", "line-0652"],
      },
    });
    const second = await boot();
    expect(second.seenIds().sort()).toEqual(
      [...oldSeen, "line-0650", "line-0651", "line-0652"].sort(),
    );
    expect(second.machine.getState().cursor).toBe(ids.indexOf("line-0652"));
    const rewritten = db.stores.get("state")?.records.get(KEY46) as
      | { ctx: SavedContext }
      | undefined;
    expect(rewritten?.ctx.visited).toEqual([]);
    second.machine.destroy();
  });

  it("a progress file exported before the change imports with every seen id, then saves in the new layout", async () => {
    const db = installFakeIndexedDb();
    const parsed = parseProgressFile(fixtureText, {
      storyId: "pre46",
      title: "Before Phase 46",
    });
    if (!parsed.ok) throw new Error(parsed.message);
    const ok = await importProgress({
      flush: async () => {},
      storage: await open(KEY46),
      reload: () => {},
      progress: parsed,
    });
    expect(ok).toBe(true);
    const first = await boot();
    expect(first.seenIds().sort()).toEqual(oldSeen);
    expect(first.machine.getState().cursor).toBe(ids.indexOf("line-0649"));
    expect(seenRecords(db, KEY46).flat().sort()).toEqual(oldSeen);
    // Its bookmarks restore, their own seen lists merged with the reader's.
    const bookmarks = await first.storage.getBookmarks();
    expect(bookmarks.map((b) => b.id)).toEqual(["bm-early", "bm-route"]);
    const target = first.codec.fromSaved(
      bookmarkRestoreTarget(bookmarks[1]).ctx,
    );
    if (target === undefined) throw new Error("bookmark did not resolve");
    first.machine.importContext(
      mergeProgress(target, first.machine.exportContext()),
    );
    expect(first.machine.getState().cursor).toBe(ids.indexOf("line-0015"));
    expect(first.seenIds().sort()).toEqual(oldSeen);
    first.machine.advance();
    await first.save();
    first.machine.destroy();
    const second = await boot();
    expect(second.seenIds().sort()).toEqual(oldSeen);
    expect(second.machine.getState().cursor).toBe(ids.indexOf("line-0016"));
    second.machine.destroy();
  });

  it("a bookmark taken now carries no seen list, and restoring it keeps everything seen", async () => {
    const db = installFakeIndexedDb();
    await seedRecord(db, KEY46, fixture.state);
    const first = await boot();
    first.machine.goTo(ids.indexOf("line-0100"));
    // What main.ts's `b` stores.
    const ctx = first.codec.toSaved(first.machine.exportPlace());
    await first.storage.addBookmark({
      id: "bm-new",
      timestampMs: 1,
      itemId: ctx.lastShown,
      ctx,
      thumbDataUrl: null,
    });
    first.machine.jumpToEnd();
    first.machine.advance(); // line-0650, newly seen after the bookmark
    await first.save();
    first.machine.destroy();
    const second = await boot();
    const [stored] = await second.storage.getBookmarks();
    expect(stored.ctx.visited).toEqual([]);
    const target = second.codec.fromSaved(bookmarkRestoreTarget(stored).ctx);
    if (target === undefined) throw new Error("bookmark did not resolve");
    second.machine.importContext(
      mergeProgress(target, second.machine.exportContext()),
    );
    expect(second.machine.getState().cursor).toBe(ids.indexOf("line-0100"));
    expect(second.seenIds().sort()).toEqual([...oldSeen, "line-0650"].sort());
    second.machine.destroy();
  });

  it("items a content update inserts into read content stay unseen: the notice, u, skip and the end card find them", async () => {
    installFakeIndexedDb();
    const before = Array.from(
      { length: 20 },
      (_, n) => `a-${String(n).padStart(2, "0")}`,
    );
    const first = await boot(KEY46, imageItems(before), []);
    await first.save();
    for (let n = 1; n < before.length; n += 1) {
      first.machine.advance();
      await first.save();
    }
    expect(first.machine.getState().endCard).toBeUndefined(); // all seen
    first.machine.destroy();
    // The update: two items inside what was read, between a-09 and a-10.
    const after = imageItems([
      ...before.slice(0, 10),
      "new-1",
      "new-2",
      ...before.slice(10),
    ]);
    const at = (id: string) => after.findIndex((item) => item.id === id);
    const second = await boot(KEY46, after, []);
    expect(second.machine.getState().cursor).toBe(at("a-19"));
    // The resume notice's question (main.ts shows the notice on it).
    expect(second.machine.hasEarlierUnseen()).toBe(true);
    // The end card counts them: unseen content outside any route, and `u`
    // has somewhere to go.
    expect(second.machine.getState().endCard).toEqual({
      unseenRoutes: 0,
      otherUnseen: true,
      nextUnseen: true,
    });
    second.machine.jumpToUnseen();
    expect(second.machine.getState().cursor).toBe(at("new-1"));
    second.machine.destroy();
    // Skip from earlier read content stops at them: on the last item read
    // before them (skip never reveals, docs/plan.md Phase 18), and Space
    // then shows the first inserted item.
    const third = await boot(KEY46, after, []);
    third.machine.goTo(at("a-05"));
    vi.useFakeTimers();
    try {
      third.machine.toggleSkip();
      vi.advanceTimersByTime(DEFAULT_SETTINGS.skipDwellMs * 20);
      expect(third.machine.getState()).toMatchObject({
        cursor: at("a-09"),
        skipping: false,
      });
      third.machine.advance();
      expect(third.machine.getState().cursor).toBe(at("new-1"));
    } finally {
      vi.useRealTimers();
      third.machine.destroy();
    }
  });

  it("Reset progress clears the seen records; an older build's reset leaves none to come back", async () => {
    const db = installFakeIndexedDb();
    await seedRecord(db, KEY46, fixture.state);
    const first = await boot();
    first.machine.advance();
    await first.save();
    first.machine.destroy();
    expect(seenRecords(db, KEY46).length).toBeGreaterThan(0);
    await resetProgress({
      flush: async () => {},
      storage: first.storage,
      reload: () => {},
    });
    expect(seenRecords(db, KEY46)).toEqual([]);
    expect(await (await open(KEY46)).loadState()).toBeNull();

    // An older build's Reset deletes only the state record: the next load
    // drops the seen records it could not see, so a fresh read starts
    // with nothing seen.
    await seedRecord(db, KEY46, fixture.state);
    const again = await boot();
    again.machine.destroy();
    expect(seenRecords(db, KEY46).length).toBeGreaterThan(0);
    db.stores.get("state")?.records.delete(KEY46);
    const fresh = await boot();
    expect(fresh.persisted).toBeNull();
    expect(seenRecords(db, KEY46)).toEqual([]);
    await fresh.save();
    fresh.machine.destroy();
    const reloaded = await boot();
    expect(reloaded.seenIds()).toEqual(["line-0000"]);
    reloaded.machine.destroy();
  });

  it("the carry-over to the story key moves the seen records too", async () => {
    const db = installFakeIndexedDb();
    // A folder without a storyId keyed its progress by the folder URL.
    const folder = await boot(OLD_FOLDER);
    await folder.save();
    for (let n = 0; n < 12; n += 1) {
      folder.machine.advance();
      await folder.save();
    }
    const read = folder.seenIds();
    folder.machine.destroy();
    expect(seenRecords(db, OLD_FOLDER).flat()).toEqual(read);
    // The content update named the story.
    const storage = await open(STORY, OLD_FOLDER);
    const persisted = await storage.loadState();
    expect([...(persisted?.ctx?.visited ?? [])].sort()).toEqual(
      [...read].sort(),
    );
    expect(seenRecords(db, OLD_FOLDER)).toEqual([]);
    expect(seenRecords(db, STORY).flat().sort()).toEqual([...read].sort());
  });

  it("keeps the seen set's contract as the memory fake does (storage.test.ts)", async () => {
    installFakeIndexedDb();
    const seenCtx = (lastShown: string, visited: string[]): SavedContext => ({
      ...context(lastShown),
      visited,
    });
    const storage = await open(KEY46);
    await storage.saveState({ ctx: seenCtx("x-4", ["x-4"]) });
    await storage.saveState({ ctx: seenCtx("x-9", ["x-4", "x-9"]) });
    await storage.saveState({ ctx: seenCtx("x-2", []) });
    expect((await (await open(KEY46)).loadState())?.ctx).toEqual(
      seenCtx("x-2", ["x-4", "x-9"]),
    );
    // A save without a context drops the seen set with it.
    const later = await open(KEY46);
    await later.loadState();
    await later.saveState({ helpSeen: true });
    await later.saveState({ ctx: seenCtx("x-1", ["x-1"]) });
    expect((await (await open(KEY46)).loadState())?.ctx?.visited).toEqual([
      "x-1",
    ]);
  });

  it("many short sessions' seen records are merged at a load, none lost", async () => {
    const db = installFakeIndexedDb();
    const first = await boot(KEY46, items, []);
    await first.save();
    first.machine.destroy();
    // Forty page loads, each reading one new item: each page writes a
    // record of its own, and the load that finds 32 part-filled ones
    // merges them into one.
    const counts: number[] = [];
    for (let n = 0; n < 40; n += 1) {
      const page = await boot(KEY46, items, []);
      page.machine.advance();
      await page.save();
      page.machine.destroy();
      counts.push(seenRecords(db, KEY46).length);
    }
    const { SEEN_MERGE_AT } = await loadIdb();
    expect(Math.max(...counts)).toBe(SEEN_MERGE_AT);
    const lengths = seenRecords(db, KEY46).map((record) => record.length);
    expect(lengths.sort((a, b) => b - a)).toEqual([
      32, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    ]);
    const after = await boot(KEY46, items, []);
    expect(after.seenIds()).toEqual(ids.slice(0, 41));
    after.machine.destroy();
  });
});
