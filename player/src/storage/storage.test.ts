// The Storage contract (docs/plan.md Phases 8-9) exercised against every
// adapter that needs no browser: the in-memory fake the machine tests use,
// and the no-IndexedDB fallback, which is memory-backed by design. The
// IndexedDB adapter implements the same contract; these tests pin what it
// must do.

import { describe, expect, it } from "vitest";

import { contentSignature } from "./idb";
import { createMemoryStorage } from "./memory";
import { createNoopStorage } from "./noop";
import type { Bookmark, Storage } from "./types";

function bookmark(
  id: string,
  itemIndex: number,
  thumb?: string | null,
): Bookmark {
  return {
    id,
    timestampMs: 1700000000000 + itemIndex,
    itemIndex,
    ...(thumb === undefined ? {} : { thumbDataUrl: thumb }),
  };
}

/**
 * One contract, run against every browser-free adapter, so a fake can never
 * quietly drift from the IndexedDB implementation the player ships with.
 */
const ADAPTERS: ReadonlyArray<readonly [string, () => Storage]> = [
  ["memory fake", createMemoryStorage],
  ["noop fallback", createNoopStorage],
];

for (const [name, makeStorage] of ADAPTERS) {
  describe(`Storage contract — ${name}`, () => {
    it("starts with no persisted state and no bookmarks", async () => {
      const storage = makeStorage();
      expect(await storage.loadState()).toBeNull();
      expect(await storage.getBookmarks()).toEqual([]);
    });

    it("round-trips the frontier, and a later save overwrites the slot", async () => {
      const storage = makeStorage();
      await storage.saveState({ frontier: 4 });
      expect(await storage.loadState()).toEqual({ frontier: 4 });
      await storage.saveState({ frontier: 9 });
      // A singleton state, not a log: the resume point is the last save.
      expect(await storage.loadState()).toEqual({ frontier: 9 });
    });

    it("persists the frontier only — nothing else can ride along", async () => {
      const storage = makeStorage();
      // A caller handing over a fatter object (a cursor, say) still gets a
      // PersistedState back: the contract's fields are the whole record.
      await storage.saveState({ frontier: 5, cursor: 2 } as never);
      const loaded = await storage.loadState();
      expect(loaded).toEqual({ frontier: 5 });
      expect(Object.keys(loaded ?? {})).toEqual(["frontier"]);
    });

    it("hands out copies: mutating a loaded state cannot rewrite storage", async () => {
      const storage = makeStorage();
      await storage.saveState({ frontier: 6 });
      const loaded = (await storage.loadState()) as { frontier: number };
      loaded.frontier = 99;
      expect(await storage.loadState()).toEqual({ frontier: 6 });
    });

    it("round-trips the settings a save carries, partial included", async () => {
      const storage = makeStorage();
      await storage.saveState({
        frontier: 4,
        settings: { readingSpeed: 2, skipAll: true },
      });
      expect(await storage.loadState()).toEqual({
        frontier: 4,
        settings: { readingSpeed: 2, skipAll: true },
      });
      // The state is a singleton record, settings included: a later save
      // without them overwrites them too — what persists is the last save.
      await storage.saveState({ frontier: 5 });
      const later = await storage.loadState();
      expect(later?.frontier).toBe(5);
      expect(later?.settings).toBeUndefined();
    });

    it("copies settings in and out: callers cannot rewrite stored settings", async () => {
      const storage = makeStorage();
      const input = { readingSpeed: 1.5 };
      await storage.saveState({ frontier: 6, settings: input });
      // Mutating the caller's object after the save cannot reach in...
      input.readingSpeed = 3;
      // ...and neither can mutating a loaded settings object.
      const loaded = (await storage.loadState()) as {
        settings: { readingSpeed: number };
      };
      loaded.settings.readingSpeed = 0.25;
      expect(await storage.loadState()).toEqual({
        frontier: 6,
        settings: { readingSpeed: 1.5 },
      });
    });

    it("appends a bookmark and returns the full list containing it", async () => {
      const storage = makeStorage();
      const list = await storage.addBookmark(
        bookmark("a", 3, "data:image/jpeg;base64,x"),
      );
      expect(list).toEqual([bookmark("a", 3, "data:image/jpeg;base64,x")]);
      expect(await storage.getBookmarks()).toEqual(list);
    });

    it("keeps appended bookmarks in insertion order, oldest first", async () => {
      const storage = makeStorage();
      await storage.addBookmark(bookmark("a", 1));
      await storage.addBookmark(bookmark("b", 7));
      await storage.addBookmark(bookmark("c", 2));
      const list = await storage.getBookmarks();
      expect(list.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
      // ...and the returned-after-append list agrees with a later read.
      const afterD = await storage.addBookmark(bookmark("d", 9));
      expect(afterD.map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
    });

    it("round-trips every bookmark field, thumb included", async () => {
      const storage = makeStorage();
      const withThumb = bookmark("a", 4, "data:,png");
      const withoutThumb = bookmark("b", 5);
      await storage.addBookmark(withThumb);
      await storage.addBookmark(withoutThumb);
      const list = await storage.getBookmarks();
      expect(list[0]).toEqual({
        id: "a",
        timestampMs: withThumb.timestampMs,
        itemIndex: 4,
        thumbDataUrl: "data:,png",
      });
      // A missing thumb reads as "no picture" (null), never as `undefined`
      // vanishing: the overlay always has a value to branch on.
      expect(list[1].id).toBe("b");
      expect(list[1].itemIndex).toBe(5);
      expect(list[1].timestampMs).toBe(withoutThumb.timestampMs);
      expect(list[1].thumbDataUrl ?? null).toBeNull();
    });

    it("copies in and out: callers cannot rewrite what the store holds", async () => {
      const storage = makeStorage();
      const input = bookmark("a", 1);
      await storage.addBookmark(input);
      // Mutating the caller's object after the append must not reach in...
      (input as { itemIndex: number }).itemIndex = 42;
      // ...and mutating the returned list must not reach in either.
      const list = await storage.getBookmarks();
      list.push(bookmark("injected", 8));
      const reread = await storage.getBookmarks();
      expect(reread.map((entry) => entry.itemIndex)).toEqual([1]);
    });
  });
}

describe("contentSignature — novels never share state", () => {
  it("keys a novel by its folder, index.html or bare directory alike", () => {
    expect(contentSignature("https://read.test/novels/dawn/index.html")).toBe(
      "https://read.test/novels/dawn/",
    );
    expect(contentSignature("https://read.test/novels/dawn/")).toBe(
      "https://read.test/novels/dawn/",
    );
    expect(contentSignature("file:///Users/me/shelf/dawn/index.html")).toBe(
      "file:///Users/me/shelf/dawn/",
    );
  });

  it("separates two novels on one origin, and survives an unparseable URI", () => {
    expect(contentSignature("http://127.0.0.1:5173/dawn/index.html")).not.toBe(
      contentSignature("http://127.0.0.1:5173/dusk/index.html"),
    );
    expect(contentSignature("not a uri")).toBe("not a uri");
  });
});
