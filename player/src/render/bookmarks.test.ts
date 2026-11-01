// The pure half of the `t` bookmark overlay (docs/plan.md Phases 8, 13):
// the list order, the scroll-to-bottom target, the timestamp and label
// text, the thumbnail source rule, and the bookmark's restore target. The
// DOM panel in bookmarks.ts only applies these; the end-to-end behaviour
// is walked by scripts/verify.mjs.

import { describe, expect, it } from "vitest";

import type { Item, MachineContext } from "../machine/types";
import type { Bookmark } from "../storage/types";
import {
  bookmarkContext,
  bookmarkRestoreTarget,
  bottomScrollTop,
  entryLabel,
  entryThumbSrc,
  formatTimestamp,
  listOrder,
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

function bookmark(fields: Partial<Bookmark> & { itemIndex: number }): Bookmark {
  return {
    id: "bk-1",
    timestampMs: new Date(2025, 10, 1, 12, 0, 0).getTime(),
    ...fields,
  };
}

describe("listOrder (oldest first, top to bottom)", () => {
  it("keeps the storage order (oldest first) as the render order", () => {
    const stored = [
      bookmark({ id: "old", itemIndex: 2 }),
      bookmark({ id: "mid", itemIndex: 0 }),
      bookmark({ id: "new", itemIndex: 1 }),
    ];
    // Never re-sorted by item index or clock: insertion order IS the
    // top-to-bottom order, so the newest stays at the list's bottom.
    expect(listOrder(stored).map((b) => b.id)).toEqual(["old", "mid", "new"]);
  });

  it("copies, so a later mutation of the caller's array cannot restyle the panel", () => {
    const stored = [bookmark({ itemIndex: 0 })];
    const rendered = listOrder(stored);
    stored.push(bookmark({ id: "late", itemIndex: 1 }));
    expect(rendered).toHaveLength(1);
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
      itemIndex: 0,
      thumbDataUrl: "data:image/jpeg;base64,AA",
    });
    expect(entryThumbSrc(b, items)).toBe("data:image/jpeg;base64,AA");
  });

  it("falls back to the manifest still for each media type", () => {
    expect(entryThumbSrc(bookmark({ itemIndex: 0 }), items)).toBe("a-001.jpg");
    expect(entryThumbSrc(bookmark({ itemIndex: 1 }), items)).toBe(
      "b-002.f000.jpg",
    );
    expect(entryThumbSrc(bookmark({ itemIndex: 2 }), items)).toBe(
      "c-003.poster.jpg",
    );
  });

  it("a text item shows the nearest earlier media item's still", () => {
    // The same visual rule as machine.visualIndex(): line-004 (index 3)
    // played over the video, so its thumbnail is the video's poster.
    expect(entryThumbSrc(bookmark({ itemIndex: 3 }), items)).toBe(
      "c-003.poster.jpg",
    );
  });

  it("treats null and empty thumbs as absent, and an unknown index has none", () => {
    expect(
      entryThumbSrc(bookmark({ itemIndex: 0, thumbDataUrl: null }), items),
    ).toBe("a-001.jpg");
    expect(
      entryThumbSrc(bookmark({ itemIndex: 0, thumbDataUrl: "" }), items),
    ).toBe("a-001.jpg");
    expect(entryThumbSrc(bookmark({ itemIndex: 99 }), items)).toBeNull();
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

describe("bookmarkRestoreTarget (ctx-aware restore, Phase 13)", () => {
  const ctx: MachineContext = {
    lastShown: 4,
    visited: [0, 3, 4],
    stack: [{ decision: 0, route: 1 }],
    playedRoutes: [{ decision: 0, routes: [1] }],
  };

  it("hands back the itemIndex plus the recorded route context", () => {
    const record = bookmark({ itemIndex: 4, ctx });
    // With a ctx the restore is `machine.importContext(ctx)` inside
    // `bookmarkRestoreTarget`'s hands: the caller re-enters the item
    // within that route context.
    expect(bookmarkRestoreTarget(record)).toEqual({ itemIndex: 4, ctx });
  });

  it("lands on the bookmarked item even when the ctx names a later one", () => {
    // A bookmark written before the history existed could carry a reading
    // position (4) past the bookmarked item (3); the click lands on 3.
    const target = bookmarkRestoreTarget(bookmark({ itemIndex: 3, ctx }));
    expect(target).toEqual({ itemIndex: 3, ctx: { ...ctx, lastShown: 3 } });
  });

  it("drops a stored reading history: the restore appends to the current one", () => {
    const withHistory: MachineContext = {
      ...ctx,
      history: [{ index: 4, stack: [] }],
      historyPos: 0,
    };
    expect(bookmarkContext(withHistory)).toEqual(ctx);
    expect(
      bookmarkRestoreTarget(bookmark({ itemIndex: 4, ctx: withHistory })),
    ).toEqual({ itemIndex: 4, ctx });
  });

  it("restores a pre-Phase-13 bookmark by itemIndex alone — no ctx key", () => {
    const target = bookmarkRestoreTarget(bookmark({ itemIndex: 2 }));
    expect(target).toEqual({ itemIndex: 2 });
    // Absent, not undefined: the caller's `ctx === undefined` branch is
    // the plain itemIndex navigation, a fresh nav with no route frames.
    expect("ctx" in target).toBe(false);
  });
});
