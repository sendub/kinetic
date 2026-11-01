// The Storage contract (docs/plan.md Phases 8-9) exercised against every
// adapter that needs no browser: the in-memory fake the machine tests use,
// and the no-IndexedDB fallback, which is memory-backed by design. The
// IndexedDB adapter implements the same contract; these tests pin what it
// must do.

import { describe, expect, it } from "vitest";

import { createMachine } from "../machine/machine";
import type { Item, MachineContext } from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import { contentSignature, sanitizeContext, sanitizeSettings } from "./idb";
import { createMemoryStorage } from "./memory";
import { createNoopStorage } from "./noop";
import {
  type Bookmark,
  helpSeenFrom,
  legacyResumeContext,
  type PersistedState,
  resumeOptionsFor,
  type Storage,
} from "./types";

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

/** A route-play context with one open frame, for ctx round-trip tests. */
function context(lastShown: number, visited: number[]): MachineContext {
  return {
    lastShown,
    visited,
    stack: [{ decision: 1, route: 0 }],
    playedRoutes: [{ decision: 1, routes: [2] }],
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
        settings: { readingSpeed: 2, skipAll: true, playAllRoutes: true },
      });
      expect(await storage.loadState()).toEqual({
        frontier: 4,
        settings: { readingSpeed: 2, skipAll: true, playAllRoutes: true },
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

    it("round-trips the machine context a save carries (Phase 13)", async () => {
      const storage = makeStorage();
      const ctx = context(7, [0, 1, 4, 7]);
      await storage.saveState({ frontier: 5, ctx });
      expect(await storage.loadState()).toEqual({ frontier: 5, ctx });
      // The state is a singleton record, ctx included: a later save
      // without one overwrites it too — what persists is the last save.
      await storage.saveState({ frontier: 6 });
      const later = await storage.loadState();
      expect(later?.frontier).toBe(6);
      expect(later?.ctx).toBeUndefined();
    });

    it("round-trips a context's completed routes and reading history", async () => {
      const storage = makeStorage();
      const ctx: MachineContext = {
        ...context(7, [0, 1, 4, 7]),
        completedRoutes: [{ decision: 1, routes: [2] }],
        history: [
          { index: 0, stack: [] },
          { index: 1, stack: [], decision: 1 },
          { index: 7, stack: [{ decision: 1, route: 0 }] },
        ],
        historyPos: 1,
      };
      await storage.saveState({ frontier: 8, ctx });
      const loaded = await storage.loadState();
      expect(loaded).toEqual({ frontier: 8, ctx });
      // Copies out: a caller mutating the loaded record reaches nothing.
      const handedOut = loaded as unknown as {
        ctx: { history: { stack: unknown[] }[] };
      };
      handedOut.ctx.history[2].stack.push({});
      expect((await storage.loadState())?.ctx).toEqual(ctx);
    });

    it("round-trips helpSeen; a save without it grows no field (Phase 13b)", async () => {
      const storage = makeStorage();
      await storage.saveState({ frontier: 4, helpSeen: true });
      expect(await storage.loadState()).toEqual({
        frontier: 4,
        helpSeen: true,
      });
      await storage.saveState({ frontier: 5, helpSeen: false });
      expect(await storage.loadState()).toEqual({
        frontier: 5,
        helpSeen: false,
      });
      // A record from before Phase 13b: no field at all, and none grows
      // back — `helpSeenFrom` reads that shape as "never seen".
      await storage.saveState({ frontier: 6 });
      expect(Object.keys((await storage.loadState()) ?? {})).toEqual([
        "frontier",
      ]);
    });

    it("copies ctx in and out: callers cannot rewrite the stored context", async () => {
      const storage = makeStorage();
      const visited = [0, 1, 2];
      await storage.saveState({
        frontier: 3,
        ctx: { lastShown: 2, visited, stack: [], playedRoutes: [] },
      });
      // Mutating the caller's arrays after the save cannot reach in...
      visited.push(99);
      // ...and neither can mutating a loaded context's nested arrays.
      const loaded = (await storage.loadState()) as unknown as {
        ctx: { visited: number[]; stack: unknown[] };
      };
      loaded.ctx.visited.push(42);
      loaded.ctx.stack.push({ decision: 8, route: 8 });
      expect(await storage.loadState()).toEqual({
        frontier: 3,
        ctx: { lastShown: 2, visited: [0, 1, 2], stack: [], playedRoutes: [] },
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

    it("round-trips a bookmark's route context, keeping ctx-less bookmarks ctx-less", async () => {
      const storage = makeStorage();
      const ctx = context(7, [0, 4, 7]);
      await storage.addBookmark({
        id: "a",
        timestampMs: 1700000007000,
        itemIndex: 7,
        ctx,
      });
      // A pre-Phase-13 bookmark: itemIndex + timestamp, no context.
      await storage.addBookmark(bookmark("b", 3));
      const list = await storage.getBookmarks();
      expect(list[0]?.itemIndex).toBe(7);
      expect(list[0]?.ctx).toEqual(ctx);
      // Mutating a handed-out ctx must not reach the stored record.
      const first = list[0] as Bookmark;
      (first.ctx as unknown as { visited: number[] }).visited.push(9);
      expect((await storage.getBookmarks())[0]?.ctx).toEqual(ctx);
      // A legacy record reads as itemIndex-only: no ctx field at all,
      // so the restore path sees "importContext absent".
      const legacy = list[1] as Bookmark;
      expect(legacy.itemIndex).toBe(3);
      expect("ctx" in legacy).toBe(false);
    });

    it("deletes one bookmark by id and returns the rest, order kept (Phase 18)", async () => {
      const storage = makeStorage();
      await storage.addBookmark(bookmark("a", 1));
      await storage.addBookmark(bookmark("b", 2));
      await storage.addBookmark(bookmark("c", 3));
      const left = await storage.deleteBookmark("b");
      expect(left.map((entry) => entry.id)).toEqual(["a", "c"]);
      expect(await storage.getBookmarks()).toEqual(left);
      // An unknown id (deleted twice, say) is a no-op.
      const again = await storage.deleteBookmark("b");
      expect(again.map((entry) => entry.id)).toEqual(["a", "c"]);
      // The state record is untouched by a bookmark delete.
      await storage.saveState({ frontier: 2 });
      await storage.deleteBookmark("a");
      expect(await storage.loadState()).toEqual({ frontier: 2 });
      expect((await storage.getBookmarks()).map((entry) => entry.id)).toEqual([
        "c",
      ]);
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

describe("route-aware resume — ctx wins, legacy frontier migrates", () => {
  const items: readonly Item[] = Array.from(
    { length: 10 },
    (_, index) =>
      ({
        id: `x-${String(index)}`,
        type: "image",
        file: `x-${String(index)}.jpg`,
      }) satisfies Item,
  );

  it("legacyResumeContext builds the context the old frontier meant", () => {
    // visited = prefix [0, frontier), lastShown = frontier - 1, no frames.
    expect(legacyResumeContext(4)).toEqual({
      lastShown: 3,
      visited: [0, 1, 2, 3],
      stack: [],
      playedRoutes: [],
    });
    // frontier 0: nothing was ever seen, so there is no context at all.
    expect(legacyResumeContext(0)).toBeNull();
  });

  it("a state without ctx resumes as a prefix-visited machine", () => {
    const legacy: PersistedState = { frontier: 4 };
    // No ctx: the record takes the legacy frontier path.
    expect(resumeOptionsFor(legacy)).toEqual({ resumeFrontier: 4 });
    const machine = createMachine({
      items,
      settings: DEFAULT_SETTINGS,
      ...resumeOptionsFor(legacy),
    });
    expect(machine.visitedList()).toEqual([0, 1, 2, 3]);
    expect(machine.getState().cursor).toBe(3);
    // The documented equivalence: importContext of the legacy context
    // yields the same machine the frontier path builds.
    const restored = createMachine({ items, settings: DEFAULT_SETTINGS });
    restored.importContext(legacyResumeContext(4) as MachineContext);
    expect(restored.visitedList()).toEqual([0, 1, 2, 3]);
    expect(restored.getState().cursor).toBe(3);
  });

  it("ctx wins over frontier when both are present", () => {
    const ctx = context(6, [0, 2, 5, 6]);
    const state: PersistedState = { frontier: 1, ctx };
    const options = resumeOptionsFor(state);
    // The frontier is ignored — the ctx is the resume, route frames and all.
    expect(options).toEqual({ resumeContext: ctx });
    expect("resumeFrontier" in options).toBe(false);
    const machine = createMachine({
      items,
      settings: DEFAULT_SETTINGS,
      ...options,
    });
    // frontier 1 alone would have resumed item 0; the ctx lands on item 6.
    expect(machine.getState().cursor).toBe(6);
    expect(machine.visitedList()).toEqual([0, 2, 5, 6]);
  });
});

describe("helpSeenFrom — the key-help migration reads absent as not-seen (Phase 13b)", () => {
  it("absent, false and non-true values all say: show the help", () => {
    // The whole migration rule: pre-13b records (and first-ever loads)
    // carry nothing, and nothing means the reader has not seen it —
    // their help shows exactly once more, then `helpSeen: true` persists.
    expect(helpSeenFrom(null)).toBe(false);
    expect(helpSeenFrom({ frontier: 4 })).toBe(false);
    expect(helpSeenFrom({ frontier: 4, helpSeen: false })).toBe(false);
    expect(helpSeenFrom({ frontier: 4, helpSeen: "yes" as never })).toBe(false);
  });

  it("a persisted true says: never show it again", () => {
    expect(helpSeenFrom({ frontier: 4, helpSeen: true })).toBe(true);
  });
});

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

describe("sanitizeSettings — the settings the shipped adapter reads back", () => {
  // The browser-free adapters pass settings through, so this is the only
  // test of the IndexedDB read. Its bug: the accepted-field list was
  // hand-written and missed `playAllRoutes`, so a stored play-all choice
  // read back absent and the toggle reset to off on every reload.
  it("keeps playAllRoutes like every other settings field", () => {
    expect(
      sanitizeSettings({
        readingSpeed: 2,
        skipAll: true,
        playAllRoutes: true,
      }),
    ).toEqual({ readingSpeed: 2, skipAll: true, playAllRoutes: true });
    // A stored false is a real value, not an absent field.
    expect(sanitizeSettings({ playAllRoutes: false })).toEqual({
      playAllRoutes: false,
    });
  });

  it("degrades foreign values and unknown fields, like the defaults do", () => {
    // Same rule as every other field: a wrong type drops, a field the
    // machine does not know never rides along, nothing trustworthy is
    // undefined (the merge then falls back to the defaults).
    expect(
      sanitizeSettings({ playAllRoutes: "yes", readingSpeed: "2" }),
    ).toBeUndefined();
    expect(
      sanitizeSettings({ playAllRoutes: true, futureSwitch: true }),
    ).toEqual({ playAllRoutes: true });
  });

  it("accepts exactly the DEFAULT_SETTINGS fields — nothing is missed", () => {
    const all = Object.fromEntries(
      Object.entries(DEFAULT_SETTINGS).map(([field, value]) => [
        field,
        typeof value === "number" ? value + 1 : !value,
      ]),
    );
    expect(sanitizeSettings(all)).toEqual(all);
  });
});

describe("sanitizeContext — the context the shipped adapter reads back", () => {
  const base = {
    lastShown: 3,
    visited: [0, 1, 2, 3],
    stack: [],
    playedRoutes: [],
  };

  it("keeps the reading history and its position (History rollback spec)", () => {
    const history = [
      { index: 0, stack: [] },
      { index: 2, stack: [], decision: 0 },
      { index: 3, stack: [{ decision: 0, route: 1 }] },
    ];
    expect(sanitizeContext({ ...base, history, historyPos: 1 })).toEqual({
      ...base,
      history,
      historyPos: 1,
    });
  });

  it("drops malformed history entries and frames; no history grows no field", () => {
    expect(
      sanitizeContext({
        ...base,
        history: [
          null,
          { index: "2", stack: [] },
          { index: 1, stack: [], decision: "d1" },
          { index: 2, stack: [{ decision: 0 }, { decision: 0, route: 1 }] },
          { index: 3 },
        ],
        historyPos: "1",
      }),
    ).toEqual({
      ...base,
      history: [
        { index: 2, stack: [{ decision: 0, route: 1 }] },
        { index: 3, stack: [] },
      ],
    });
    // A legacy context (no history) reads back without one: the machine
    // then starts a one-entry history at `lastShown`.
    expect(sanitizeContext(base)).toEqual(base);
    expect(sanitizeContext({ ...base, history: "x", historyPos: 2 })).toEqual(
      base,
    );
  });
});
