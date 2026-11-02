// The pure half of the `t` bookmark overlay (docs/plan.md Phases 8, 13):
// the list order, the scroll-to-bottom target, the timestamp and label
// text, the thumbnail source rule, and the bookmark's restore target. The
// DOM panel in bookmarks.ts only applies these; the end-to-end behaviour
// is walked by scripts/verify.mjs.

import { describe, expect, it } from "vitest";

import type { Item } from "../machine/types";
import type { Bookmark, SavedContext } from "../storage/types";
import {
  BOOKMARKS_HINT,
  bookmarkContext,
  bookmarkItemIndex,
  bookmarkRestoreTarget,
  bottomScrollTop,
  entryLabel,
  entryThumbSrc,
  formatTimestamp,
  keptScrollTop,
  listOrder,
  mergeProgress,
} from "./bookmarks";

const items: readonly Item[] = [
  { id: "a-001", type: "image", file: "a-001.jpg" },
  {
    id: "b-002",
    type: "animation",
    frames: ["b-002.f000.jpg", "b-002.f001.jpg"],
    fps: 8,
    loopCount: 2,
  },
  {
    id: "c-003",
    type: "video",
    file: "c-003.mp4",
    poster: "c-003.poster.jpg",
    durationSeconds: 2,
  },
  { id: "line-004", type: "text", text: "A line over the video." },
];

const EMPTY_CTX: SavedContext = {
  lastShown: "a-001",
  visited: [],
  stack: [],
  playedRoutes: [],
  completedRoutes: [],
};

function bookmark(fields: Partial<Bookmark> & { itemId: string }): Bookmark {
  return {
    id: "bk-1",
    timestampMs: new Date(2025, 10, 1, 12, 0, 0).getTime(),
    ctx: { ...EMPTY_CTX, lastShown: fields.itemId },
    ...fields,
  };
}

describe("listOrder (oldest first, top to bottom)", () => {
  it("keeps the storage order (oldest first) as the render order", () => {
    const stored = [
      bookmark({ id: "old", itemId: "c-003" }),
      bookmark({ id: "mid", itemId: "a-001" }),
      bookmark({ id: "new", itemId: "b-002" }),
    ];
    // Never re-sorted by item index or clock: insertion order IS the
    // top-to-bottom order, so the newest stays at the list's bottom.
    expect(listOrder(stored, items).map((b) => b.id)).toEqual([
      "old",
      "mid",
      "new",
    ]);
  });

  it("copies, so a later mutation of the caller's array cannot restyle the panel", () => {
    const stored = [bookmark({ itemId: "a-001" })];
    const rendered = listOrder(stored, items);
    stored.push(bookmark({ id: "late", itemId: "b-002" }));
    expect(rendered).toHaveLength(1);
  });

  it("leaves out a bookmark whose item is no longer in the manifest", () => {
    // Saves are keyed by id (Phase 18): a deleted item's bookmark has
    // nothing to show or restore, so it is not listed; the rest keep
    // their order wherever their items now sit.
    const stored = [
      bookmark({ id: "kept", itemId: "c-003" }),
      bookmark({ id: "orphan", itemId: "gone" }),
      bookmark({ id: "also", itemId: "a-001" }),
    ];
    expect(listOrder(stored, items).map((b) => b.id)).toEqual(["kept", "also"]);
  });
});

describe("bookmarkItemIndex (the id resolved against the manifest)", () => {
  it("finds the item wherever it now sits, -1 when it is gone", () => {
    const prequel: readonly Item[] = [
      { id: "pre-1", type: "image", file: "p.jpg" },
      ...items,
    ];
    const b = bookmark({ itemId: "c-003" });
    expect(bookmarkItemIndex(b, items)).toBe(2);
    expect(bookmarkItemIndex(b, prequel)).toBe(3);
    expect(bookmarkItemIndex(bookmark({ itemId: "gone" }), items)).toBe(-1);
  });
});

describe("bottomScrollTop (scrolled to the newest)", () => {
  it("is the scroll height past the viewport", () => {
    expect(bottomScrollTop(1200, 500)).toBe(700);
  });

  it("is 0 when the list does not overflow", () => {
    expect(bottomScrollTop(300, 500)).toBe(0);
    expect(bottomScrollTop(500, 500)).toBe(0);
  });
});

describe("keptScrollTop (a delete keeps the reader's place, Phase 18)", () => {
  it("keeps the previous scroll while it still fits", () => {
    expect(keptScrollTop(200, 1200, 500)).toBe(200);
  });

  it("clamps to the shorter list's new bottom", () => {
    expect(keptScrollTop(700, 1000, 500)).toBe(500);
    expect(keptScrollTop(300, 400, 500)).toBe(0); // no longer overflows
  });
});

describe("formatTimestamp (YYYY-MM-DD HH:MM:SS)", () => {
  it("pads every field", () => {
    // Built from local fields, so the expectation holds in any zone.
    const ms = new Date(2025, 0, 2, 3, 4, 5).getTime();
    expect(formatTimestamp(ms)).toBe("2025-01-02 03:04:05");
  });

  it("renders a two-digit year-2025 moment with full width", () => {
    const ms = new Date(2025, 10, 30, 23, 59, 58).getTime();
    expect(formatTimestamp(ms)).toBe("2025-11-30 23:59:58");
  });
});

describe("entryThumbSrc (data URL, else the manifest still)", () => {
  it("prefers the captured data URL when present", () => {
    const b = bookmark({
      itemId: "a-001",
      thumbDataUrl: "data:image/jpeg;base64,AA",
    });
    expect(entryThumbSrc(b, items)).toBe("data:image/jpeg;base64,AA");
  });

  it("falls back to the manifest still for each media type", () => {
    expect(entryThumbSrc(bookmark({ itemId: "a-001" }), items)).toBe(
      "a-001.jpg",
    );
    expect(entryThumbSrc(bookmark({ itemId: "b-002" }), items)).toBe(
      "b-002.f000.jpg",
    );
    expect(entryThumbSrc(bookmark({ itemId: "c-003" }), items)).toBe(
      "c-003.poster.jpg",
    );
  });

  it("a text item shows the nearest earlier media item's still", () => {
    // The same visual rule as machine.visualIndex(): line-004 (index 3)
    // played over the video, so its thumbnail is the video's poster.
    expect(entryThumbSrc(bookmark({ itemId: "line-004" }), items)).toBe(
      "c-003.poster.jpg",
    );
  });

  it("treats null and empty thumbs as absent, and an unknown item has none", () => {
    expect(
      entryThumbSrc(bookmark({ itemId: "a-001", thumbDataUrl: null }), items),
    ).toBe("a-001.jpg");
    expect(
      entryThumbSrc(bookmark({ itemId: "a-001", thumbDataUrl: "" }), items),
    ).toBe("a-001.jpg");
    expect(entryThumbSrc(bookmark({ itemId: "gone" }), items)).toBeNull();
  });
});

describe("entryLabel", () => {
  it("shows the item index and its manifest id", () => {
    expect(entryLabel(3, "line-004")).toBe("#3 line-004");
  });

  it("marks an index outside the manifest", () => {
    expect(entryLabel(7, undefined)).toBe("#7 (unknown item)");
  });
});

describe("bookmarkRestoreTarget (ctx restore landing on the item)", () => {
  const ctx: SavedContext = {
    lastShown: "c-003",
    visited: ["a-001", "b-002", "c-003"],
    stack: [{ decision: "pick", route: "left" }],
    playedRoutes: [{ decision: "pick", routes: ["left"] }],
    completedRoutes: [],
  };

  it("hands back the item id plus the recorded route context", () => {
    const record = bookmark({ itemId: "c-003", ctx });
    expect(bookmarkRestoreTarget(record)).toEqual({ itemId: "c-003", ctx });
  });

  it("lands on the bookmarked item even when the ctx names another", () => {
    const target = bookmarkRestoreTarget(bookmark({ itemId: "b-002", ctx }));
    expect(target).toEqual({
      itemId: "b-002",
      ctx: { ...ctx, lastShown: "b-002" },
    });
  });

  it("drops a stored reading history: the restore appends to the current one", () => {
    const withHistory: SavedContext = {
      ...ctx,
      history: [{ item: "c-003", stack: [] }],
      historyPos: 0,
    };
    expect(bookmarkContext(withHistory)).toEqual(ctx);
    expect(
      bookmarkRestoreTarget(bookmark({ itemId: "c-003", ctx: withHistory })),
    ).toEqual({ itemId: "c-003", ctx });
  });
});

describe("mergeProgress (a bookmark restore never forgets progress, Phase 18)", () => {
  it("keeps the bookmark's landing and frames, unions seen and played", () => {
    const bookmark = {
      lastShown: 3,
      visited: [0, 1, 2, 3],
      stack: [{ decision: 0, route: 0 }],
      playedRoutes: [{ decision: 0, routes: [0] }],
      completedRoutes: [],
    };
    const current = {
      lastShown: 9,
      visited: [0, 1, 2, 3, 7, 8, 9],
      stack: [],
      playedRoutes: [{ decision: 0, routes: [1] }],
      completedRoutes: [{ decision: 0, routes: [1] }],
    };
    expect(mergeProgress(bookmark, current)).toEqual({
      lastShown: 3,
      visited: [0, 1, 2, 3, 7, 8, 9],
      stack: [{ decision: 0, route: 0 }],
      playedRoutes: [{ decision: 0, routes: [0, 1] }],
      completedRoutes: [{ decision: 0, routes: [1] }],
      // An older bookmark without a pass record: its own played routes.
      passRoutes: [{ decision: 0, routes: [0] }],
    });
  });

  it("restores the bookmark's own played-this-pass record, unmerged (docs/plan.md Phase 22)", () => {
    const bookmark = {
      lastShown: 2,
      visited: [0, 1, 2],
      stack: [],
      playedRoutes: [{ decision: 0, routes: [0, 1] }],
      completedRoutes: [],
      passRoutes: [],
    };
    const current = {
      lastShown: 9,
      visited: [0, 1, 2, 3, 7, 8, 9],
      stack: [],
      playedRoutes: [{ decision: 0, routes: [0, 1, 2] }],
      completedRoutes: [{ decision: 0, routes: [0, 1, 2] }],
      passRoutes: [{ decision: 0, routes: [0, 1, 2] }],
    };
    const merged = mergeProgress(bookmark, current);
    expect(merged.passRoutes).toEqual([]);
    expect(merged.playedRoutes).toEqual([{ decision: 0, routes: [0, 1, 2] }]);
  });
});

describe("BOOKMARKS_HINT (separators in words, Phase 24)", () => {
  it('splits its clauses with "; ", never "·"', () => {
    expect(BOOKMARKS_HINT).toBe(
      "click an entry to continue there; its × deletes it; t or Esc closes",
    );
  });
});
