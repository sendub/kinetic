// The Storage contract (docs/plan.md Phases 8-9) exercised against every
// adapter that needs no browser: the in-memory fake the machine tests use,
// and the no-IndexedDB fallback, which is memory-backed by design. The
// IndexedDB adapter implements the same contract; these tests pin what it
// must do.

import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../machine/types";
import { contentSignature, sanitizeContext, sanitizeSettings } from "./idb";
import { createMemoryStorage } from "./memory";
import { createNoopStorage } from "./noop";
import {
  type Bookmark,
  helpSeenFrom,
  type SavedContext,
  type Storage,
  sanitizeMapView,
} from "./types";

/** An id-keyed route-play context with one open frame. */
function context(lastShown: string, visited: string[]): SavedContext {
  return {
    lastShown,
    visited,
    stack: [{ decision: "d1", route: "r0" }],
    playedRoutes: [{ decision: "d1", routes: ["r2"] }],
    completedRoutes: [],
  };
}

function bookmark(id: string, itemId: string, thumb?: string | null): Bookmark {
  return {
    id,
    timestampMs: 1700000000000 + itemId.length,
    itemId,
    ctx: context(itemId, [itemId]),
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

    it("round-trips the context, and a later save overwrites the slot", async () => {
      const storage = makeStorage();
      await storage.saveState({ ctx: context("x-4", ["x-4"]) });
      expect(await storage.loadState()).toEqual({
        ctx: context("x-4", ["x-4"]),
      });
      await storage.saveState({ ctx: context("x-9", ["x-9"]) });
      // A singleton state, not a log: the resume point is the last save.
      expect(await storage.loadState()).toEqual({
        ctx: context("x-9", ["x-9"]),
      });
    });

    it("persists the contract's fields only — nothing else can ride along", async () => {
      const storage = makeStorage();
      // A caller handing over a fatter object (a cursor, say) still gets a
      // PersistedState back: the contract's fields are the whole record.
      await storage.saveState({ helpSeen: true, cursor: 2 } as never);
      const loaded = await storage.loadState();
      expect(loaded).toEqual({ helpSeen: true });
      expect(Object.keys(loaded ?? {})).toEqual(["helpSeen"]);
    });

    it("hands out copies: mutating a loaded state cannot rewrite storage", async () => {
      const storage = makeStorage();
      await storage.saveState({ helpSeen: true });
      const loaded = (await storage.loadState()) as { helpSeen: boolean };
      loaded.helpSeen = false;
      expect(await storage.loadState()).toEqual({ helpSeen: true });
    });

    it("round-trips the settings a save carries, partial included", async () => {
      const storage = makeStorage();
      await storage.saveState({
        settings: { readingSpeed: 2, skipAll: true, playAllRoutes: true },
      });
      expect(await storage.loadState()).toEqual({
        settings: { readingSpeed: 2, skipAll: true, playAllRoutes: true },
      });
      // The state is a singleton record, settings included: a later save
      // without them overwrites them too — what persists is the last save.
      await storage.saveState({ helpSeen: true });
      const later = await storage.loadState();
      expect(later?.helpSeen).toBe(true);
      expect(later?.settings).toBeUndefined();
    });

    it("copies settings in and out: callers cannot rewrite stored settings", async () => {
      const storage = makeStorage();
      const input = { readingSpeed: 1.5 };
      await storage.saveState({ settings: input });
      // Mutating the caller's object after the save cannot reach in...
      input.readingSpeed = 3;
      // ...and neither can mutating a loaded settings object.
      const loaded = (await storage.loadState()) as {
        settings: { readingSpeed: number };
      };
      loaded.settings.readingSpeed = 0.25;
      expect(await storage.loadState()).toEqual({
        settings: { readingSpeed: 1.5 },
      });
    });

    it("a later save without a ctx drops the stored one", async () => {
      const storage = makeStorage();
      await storage.saveState({ ctx: context("x-7", ["x-0", "x-7"]) });
      // The state is a singleton record, ctx included: a later save
      // without one overwrites it too — what persists is the last save.
      await storage.saveState({ helpSeen: true });
      expect((await storage.loadState())?.ctx).toBeUndefined();
    });

    it("round-trips a context's completed routes, last picks and open choice", async () => {
      const storage = makeStorage();
      const ctx: SavedContext = {
        ...context("x-7", ["x-0", "x-1", "x-4", "x-7"]),
        completedRoutes: [{ decision: "d1", routes: ["r2"] }],
        lastPicks: [
          { decision: "d1", route: "r0" },
          { decision: "d2", route: "r5" },
        ],
        choice: "d1",
      };
      await storage.saveState({ ctx });
      const loaded = await storage.loadState();
      expect(loaded).toEqual({ ctx });
      // Copies out: a caller mutating the loaded record reaches nothing.
      const handedOut = loaded as unknown as {
        ctx: { lastPicks: { route: string }[] };
      };
      handedOut.ctx.lastPicks[0].route = "changed";
      expect((await storage.loadState())?.ctx).toEqual(ctx);
    });

    it("round-trips helpSeen; a save without it grows no field (Phase 13b)", async () => {
      const storage = makeStorage();
      await storage.saveState({ helpSeen: true });
      expect(await storage.loadState()).toEqual({ helpSeen: true });
      await storage.saveState({ helpSeen: false });
      expect(await storage.loadState()).toEqual({ helpSeen: false });
      // A record without the field: none grows back — `helpSeenFrom`
      // reads that shape as "never seen".
      await storage.saveState({ settings: { readingSpeed: 2 } });
      expect(Object.keys((await storage.loadState()) ?? {})).toEqual([
        "settings",
      ]);
    });

    it("round-trips the branch map's view, its place copied in and out (Phase 41)", async () => {
      const storage = makeStorage();
      const view = {
        view: "full" as const,
        layout: "9:x1",
        place: { at: 1200.5, dy: -4.5 },
      };
      await storage.saveState({ helpSeen: true, mapView: view });
      const loaded = await storage.loadState();
      expect(loaded).toEqual({ helpSeen: true, mapView: view });
      (loaded?.mapView?.place as { at: number }).at = 99;
      (view.place as { dy: number }).dy = 7;
      // Neither the caller's record nor the one handed out reaches the store.
      expect((await storage.loadState())?.mapView).toEqual({
        view: "full",
        layout: "9:x1",
        place: { at: 1200.5, dy: -4.5 },
      });
      // "Centred" (no place) and Fit round-trip too.
      for (const other of [
        { view: "full" as const, layout: "9:x1", place: null },
        { view: "fit" as const, layout: "9:x1", place: { at: 3, dy: 0 } },
      ]) {
        await storage.saveState({ mapView: other });
        expect((await storage.loadState())?.mapView).toEqual(other);
      }
    });

    it("copies ctx in and out: callers cannot rewrite the stored context", async () => {
      const storage = makeStorage();
      const visited = ["x-0", "x-1", "x-2"];
      await storage.saveState({ ctx: context("x-2", visited) });
      // Mutating the caller's arrays after the save cannot reach in...
      visited.push("x-99");
      // ...and neither can mutating a loaded context's nested arrays.
      const loaded = (await storage.loadState()) as unknown as {
        ctx: { visited: string[]; stack: unknown[] };
      };
      loaded.ctx.visited.push("x-42");
      loaded.ctx.stack.push({ decision: "d8", route: "r8" });
      expect(await storage.loadState()).toEqual({
        ctx: context("x-2", ["x-0", "x-1", "x-2"]),
      });
    });

    it("appends a bookmark and returns the full list containing it, as summaries", async () => {
      const storage = makeStorage();
      const list = await storage.addBookmark(
        bookmark("a", "x-3", "data:image/jpeg;base64,x"),
      );
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: "a",
        itemId: "x-3",
        timestampMs: bookmark("a", "x-3").timestampMs,
        hasThumb: true,
      });
      expect(await storage.listBookmarks()).toEqual(list);
      expect(await storage.getBookmarks()).toEqual([
        bookmark("a", "x-3", "data:image/jpeg;base64,x"),
      ]);
    });

    it("lists summaries whose key reads the whole bookmark back (the t list)", async () => {
      const storage = makeStorage();
      await storage.addBookmark(
        bookmark("a", "x-1", "data:image/jpeg;base64,A"),
      );
      await storage.addBookmark(bookmark("b", "x-2"));
      const rows = await storage.listBookmarks();
      expect(rows.map((row) => [row.id, row.itemId, row.hasThumb])).toEqual([
        ["a", "x-1", true],
        ["b", "x-2", false],
      ]);
      expect(new Set(rows.map((row) => row.key)).size).toBe(2);
      expect(await storage.getBookmark(rows[0].key)).toEqual(
        bookmark("a", "x-1", "data:image/jpeg;base64,A"),
      );
      expect((await storage.getBookmark(rows[1].key))?.ctx).toEqual(
        context("x-2", ["x-2"]),
      );
      // A deleted row's key reads nothing, and keys are never reused.
      await storage.deleteBookmark("a");
      expect(await storage.getBookmark(rows[0].key)).toBeNull();
      const [added] = (await storage.addBookmark(bookmark("c", "x-3"))).slice(
        -1,
      );
      expect(rows.map((row) => row.key)).not.toContain(added?.key);
    });

    it("keeps appended bookmarks in insertion order, oldest first", async () => {
      const storage = makeStorage();
      await storage.addBookmark(bookmark("a", "x-1"));
      await storage.addBookmark(bookmark("b", "x-7"));
      await storage.addBookmark(bookmark("c", "x-2"));
      const list = await storage.getBookmarks();
      expect(list.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
      // ...and the returned-after-append list agrees with a later read.
      const afterD = await storage.addBookmark(bookmark("d", "x-9"));
      expect(afterD.map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
    });

    it("round-trips every bookmark field, thumb included", async () => {
      const storage = makeStorage();
      const withThumb = bookmark("a", "x-4", "data:,png");
      const withoutThumb = bookmark("b", "x-5");
      await storage.addBookmark(withThumb);
      await storage.addBookmark(withoutThumb);
      const list = await storage.getBookmarks();
      expect(list[0]).toEqual({
        id: "a",
        timestampMs: withThumb.timestampMs,
        itemId: "x-4",
        ctx: context("x-4", ["x-4"]),
        thumbDataUrl: "data:,png",
      });
      // A missing thumb reads as "no picture" (null), never as `undefined`
      // vanishing: the overlay always has a value to branch on.
      expect(list[1].id).toBe("b");
      expect(list[1].itemId).toBe("x-5");
      expect(list[1].timestampMs).toBe(withoutThumb.timestampMs);
      expect(list[1].thumbDataUrl ?? null).toBeNull();
    });

    it("round-trips a bookmark's route context, copied out", async () => {
      const storage = makeStorage();
      const ctx = context("x-7", ["x-0", "x-4", "x-7"]);
      await storage.addBookmark({
        id: "a",
        timestampMs: 1700000007000,
        itemId: "x-7",
        ctx,
      });
      const list = await storage.getBookmarks();
      expect(list[0]?.itemId).toBe("x-7");
      expect(list[0]?.ctx).toEqual(ctx);
      // Mutating a handed-out ctx must not reach the stored record.
      const first = list[0] as Bookmark;
      (first.ctx as unknown as { visited: string[] }).visited.push("x-9");
      expect((await storage.getBookmarks())[0]?.ctx).toEqual(ctx);
    });

    it("deletes one bookmark by id and returns the rest, order kept (Phase 18)", async () => {
      const storage = makeStorage();
      await storage.addBookmark(bookmark("a", "x-1"));
      await storage.addBookmark(bookmark("b", "x-2"));
      await storage.addBookmark(bookmark("c", "x-3"));
      const left = await storage.deleteBookmark("b");
      expect(left.map((entry) => entry.id)).toEqual(["a", "c"]);
      expect(await storage.listBookmarks()).toEqual(left);
      // An unknown id (deleted twice, say) is a no-op.
      const again = await storage.deleteBookmark("b");
      expect(again.map((entry) => entry.id)).toEqual(["a", "c"]);
      // The state record is untouched by a bookmark delete.
      await storage.saveState({ helpSeen: true });
      await storage.deleteBookmark("a");
      expect(await storage.loadState()).toEqual({ helpSeen: true });
      expect((await storage.getBookmarks()).map((entry) => entry.id)).toEqual([
        "c",
      ]);
    });

    it("copies in and out: callers cannot rewrite what the store holds", async () => {
      const storage = makeStorage();
      const input = bookmark("a", "x-1");
      await storage.addBookmark(input);
      // Mutating the caller's object after the append must not reach in...
      (input as { itemId: string }).itemId = "x-42";
      // ...and mutating the returned list must not reach in either.
      const list = await storage.getBookmarks();
      list.push(bookmark("injected", "x-8"));
      const reread = await storage.getBookmarks();
      expect(reread.map((entry) => entry.itemId)).toEqual(["x-1"]);
    });
  });
}

describe("helpSeenFrom — the key-help migration reads absent as not-seen (Phase 13b)", () => {
  it("absent, false and non-true values all say: show the help", () => {
    // The whole migration rule: pre-13b records (and first-ever loads)
    // carry nothing, and nothing means the reader has not seen it —
    // their help shows exactly once more, then `helpSeen: true` persists.
    expect(helpSeenFrom(null)).toBe(false);
    expect(helpSeenFrom({})).toBe(false);
    expect(helpSeenFrom({ helpSeen: false })).toBe(false);
    expect(helpSeenFrom({ helpSeen: "yes" as never })).toBe(false);
  });

  it("a persisted true says: never show it again", () => {
    expect(helpSeenFrom({ helpSeen: true })).toBe(true);
  });
});

describe("sanitizeMapView — the map view the shipped adapter reads back (Phase 41)", () => {
  it("keeps a well-formed view, a fresh copy, and drops anything else (no record: Full size, centred)", () => {
    const view = {
      view: "full",
      layout: "3:a",
      place: { at: 412.25, dy: -18 },
    };
    const kept = sanitizeMapView({ ...view, extra: 1 });
    expect(kept).toEqual(view);
    expect(kept?.place).not.toBe(view.place);
    for (const good of [
      { view: "fit", layout: "3:a", place: null },
      { view: "full", layout: "", place: null },
      { view: "fit", layout: "3:a", place: { at: 0, dy: 0 } },
    ])
      expect(sanitizeMapView(good), JSON.stringify(good)).toEqual(good);
    for (const bad of [
      null,
      "view",
      [],
      { ...view, view: "100%" },
      { ...view, view: undefined },
      { ...view, layout: 3 },
      { ...view, place: undefined },
      { ...view, place: [] },
      { ...view, place: { at: Number.NaN, dy: 0 } },
      { ...view, place: { at: 1, dy: "2" } },
      { ...view, place: { at: Number.POSITIVE_INFINITY, dy: 0 } },
    ])
      expect(sanitizeMapView(bad), JSON.stringify(bad)).toBeUndefined();
  });

  it("reads a record in the older shape (Phase 33: fit, centre and scale) as no record", () => {
    for (const old of [
      { layout: "3:a", fit: true, cx: 1, cy: 2, scale: 0.5 },
      { layout: "12:abc", fit: false, cx: 410.5, cy: 96, scale: 1.7 },
    ])
      expect(sanitizeMapView(old), JSON.stringify(old)).toBeUndefined();
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

  it("keeps the branch map's Spoilers switch (off by default)", () => {
    expect(DEFAULT_SETTINGS.mapSpoilers).toBe(false);
    expect(sanitizeSettings({ mapSpoilers: true })).toEqual({
      mapSpoilers: true,
    });
    expect(sanitizeSettings({ mapSpoilers: "on" })).toBeUndefined();
  });

  it("keeps the browser tab's Display setting (Fullscreen by default)", () => {
    expect(DEFAULT_SETTINGS.fullscreen).toBe(true);
    // Window is a stored false: a real value, not an absent field.
    expect(sanitizeSettings({ fullscreen: false })).toEqual({
      fullscreen: false,
    });
    expect(sanitizeSettings({ fullscreen: "window" })).toBeUndefined();
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
  const base: SavedContext = {
    lastShown: "x-3",
    visited: ["x-0", "x-1", "x-2", "x-3"],
    stack: [],
    playedRoutes: [],
    completedRoutes: [],
  };

  it("keeps the last picks and the open choice; malformed picks are dropped", () => {
    expect(
      sanitizeContext({
        ...base,
        lastPicks: [
          { decision: "d0", route: "r1" },
          { decision: 0, route: "r1" },
          null,
          { decision: "d2", route: "r0" },
        ],
        choice: "d0",
      }),
    ).toEqual({
      ...base,
      lastPicks: [
        { decision: "d0", route: "r1" },
        { decision: "d2", route: "r0" },
      ],
      choice: "d0",
    });
    expect(sanitizeContext({ ...base, choice: 3 })).toEqual(base);
    expect(sanitizeContext(base)).toEqual(base);
  });

  it("migrates an old reading history: the latest route entered per decision, the open frames winning; the record is dropped", () => {
    // docs/plan.md Phase 27: saves from the reading-history days load
    // silently. Each entry's frames name the routes entered; the latest
    // wins, and the frames open now (`stack`) are the present.
    const migrated = sanitizeContext({
      ...base,
      stack: [{ decision: "d1", route: "r9" }],
      passRoutes: [{ decision: "d0", routes: ["r0", "r1"] }],
      history: [
        { item: "x-0", stack: [], passRoutes: [] },
        { item: "x-1", stack: [{ decision: "d0", route: "r0" }] },
        { item: "x-1", stack: [], decision: "d0" },
        {
          item: "x-2",
          stack: [{ decision: "d0", route: "r1" }],
          passRoutes: [{ decision: "d0", routes: ["r0", "r1"] }],
        },
        { item: "x-2", stack: [{ decision: "d1", route: "r3" }] },
        null,
        {
          item: "x-3",
          stack: [{ decision: 4 }, { decision: "d5", route: "r5" }],
        },
        { item: "x-3", stack: [], gap: true },
      ],
      historyPos: 4,
    });
    expect(migrated).toEqual({
      ...base,
      stack: [{ decision: "d1", route: "r9" }],
      passRoutes: [{ decision: "d0", routes: ["r0", "r1"] }],
      lastPicks: [
        { decision: "d0", route: "r1" }, // r0 first, r1 entered later
        { decision: "d1", route: "r9" }, // the open frame wins over r3
        { decision: "d5", route: "r5" }, // a malformed frame beside it skipped
      ],
    });
    expect(migrated).not.toHaveProperty("history");
    expect(migrated).not.toHaveProperty("historyPos");
  });

  it("migrates the old screen showing: a choice screen there becomes the open choice", () => {
    const history = [
      { item: "x-0", stack: [] },
      { item: "x-1", stack: [], decision: "d0" },
      { item: "x-2", stack: [{ decision: "d0", route: "r1" }] },
    ];
    expect(sanitizeContext({ ...base, history, historyPos: 1 })?.choice).toBe(
      "d0",
    );
    // Without a position the last screen shows: an item, so no choice.
    expect(sanitizeContext({ ...base, history })).not.toHaveProperty("choice");
    expect(
      sanitizeContext({ ...base, history: history.slice(0, 2) })?.choice,
    ).toBe("d0");
    // New fields win over anything derived.
    expect(
      sanitizeContext({
        ...base,
        history,
        historyPos: 1,
        lastPicks: [],
        choice: "d9",
      }),
    ).toEqual({ ...base, lastPicks: [], choice: "d9" });
    // A broken record migrates to nothing rather than failing the load.
    expect(sanitizeContext({ ...base, history: "x", historyPos: 2 })).toEqual(
      base,
    );
  });

  it("drops malformed frames and route sets; a missing completedRoutes reads empty", () => {
    const { completedRoutes: _omit, ...withoutCompleted } = base;
    expect(
      sanitizeContext({
        ...withoutCompleted,
        stack: [
          { decision: "d0", route: "r1" },
          { decision: 0, route: 1 },
        ],
        playedRoutes: [
          { decision: "d0", routes: ["r1"] },
          { decision: "d1", routes: [0] },
        ],
      }),
    ).toEqual({
      ...base,
      stack: [{ decision: "d0", route: "r1" }],
      playedRoutes: [{ decision: "d0", routes: ["r1"] }],
      // A save without last picks takes its open frame as one.
      lastPicks: [{ decision: "d0", route: "r1" }],
    });
  });

  it("keeps the played-this-pass record (docs/plan.md Phase 22)", () => {
    expect(
      sanitizeContext({
        ...base,
        passRoutes: [
          { decision: "d0", routes: ["r1"] },
          { decision: "d1", routes: [0] },
        ],
      }),
    ).toEqual({
      ...base,
      passRoutes: [{ decision: "d0", routes: ["r1"] }],
    });
  });

  it("drops an old index-based context whole: no migration, a first boot", () => {
    // Saves before Phase 18 named items by array position. There are no
    // released games to stay compatible with (user, 2026-11-01), so such
    // a context reads as none and the reader starts fresh.
    expect(
      sanitizeContext({
        lastShown: 3,
        visited: [0, 1, 2, 3],
        stack: [{ decision: 0, route: 1 }],
        playedRoutes: [{ decision: 0, routes: [1] }],
        history: [{ index: 3, stack: [] }],
        historyPos: 0,
      }),
    ).toBeUndefined();
    // Half-converted shapes are no better: every visited entry must be an id.
    expect(sanitizeContext({ ...base, visited: ["x-0", 1] })).toBeUndefined();
    expect(sanitizeContext(null)).toBeUndefined();
  });
});
