// Bookmarks' helpers (docs/plan.md Phases 8, 13, 29, 35): the timestamp
// text, the thumbnail source rule and where a card's picture comes from,
// and the bookmark's restore target. The cards on the branch map apply
// these; the end-to-end behaviour is walked by
// scripts/scenarios/bookmarkmap.scenario.mjs.

import { describe, expect, it } from "vitest";

import type { Item } from "../machine/types";
import type { Bookmark, BookmarkSummary, SavedContext } from "../storage/types";
import {
  bookmarkItemIndex,
  bookmarkRestoreTarget,
  cardPictures,
  entryThumbSrc,
  formatTimestamp,
  mergeProgress,
  type StillPicture,
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

  it("a text item after a held animation shows its last frame (Phase 60 item 7)", () => {
    const held: readonly Item[] = [
      {
        id: "a-001",
        type: "animation",
        frames: ["a.f000.jpg", "a.f001.jpg", "a.f002.jpg"],
        fps: 4,
        loopCount: 1,
        holdLastFrame: true,
      },
      { id: "t-002", type: "text", text: "Under it." },
    ];
    // The animation's own item keeps frames[0]; its lines, the held frame.
    expect(entryThumbSrc(bookmark({ itemId: "a-001" }), held)).toBe(
      "a.f000.jpg",
    );
    expect(entryThumbSrc(bookmark({ itemId: "t-002" }), held)).toBe(
      "a.f002.jpg",
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
      // Neither knew a last pick (docs/plan.md Phase 27).
      lastPicks: [],
    });
  });

  it("keeps the reader's last picks; the bookmark's fill decisions picked at nowhere since (docs/plan.md Phase 27)", () => {
    const bookmark = {
      lastShown: 3,
      visited: [0, 1, 2, 3],
      stack: [{ decision: 0, route: 0 }],
      playedRoutes: [{ decision: 0, routes: [0] }],
      lastPicks: [
        { decision: 0, route: 0 },
        { decision: 2, route: 1 },
      ],
    };
    const current = {
      lastShown: 9,
      visited: [0, 1, 2, 3, 7, 8, 9],
      stack: [],
      playedRoutes: [{ decision: 0, routes: [0, 1] }],
      lastPicks: [
        { decision: 0, route: 1 },
        { decision: 1, route: 0 },
      ],
    };
    expect(mergeProgress(bookmark, current).lastPicks).toEqual([
      { decision: 0, route: 1 },
      { decision: 1, route: 0 },
      { decision: 2, route: 1 },
    ]);
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

describe("cardPictures (a card's picture: capture, else the still shrunk)", () => {
  class FakeElement {
    alt = "";
    decoding = "";
    src = "";
    readonly attributes = new Map<string, string>();
    constructor(readonly tagName: string) {}
    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
    }
    getAttribute(name: string): string | null {
      return this.attributes.get(name) ?? null;
    }
    decode(): Promise<void> {
      return Promise.resolve();
    }
  }
  const doc = {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
  } as unknown as Document;
  const row = (
    id: string,
    itemId: string,
    hasThumb = false,
    key = 1,
  ): BookmarkSummary => ({ key, id, timestampMs: 0, itemId, hasThumb });
  // A still shrinker standing in for the canvas one: every still shrinks
  // (to a CANVAS) unless `fails` names it; `shrunk` logs the asks.
  function setup(
    readCapture: (r: BookmarkSummary) => Promise<string | null> = () =>
      Promise.resolve(null),
    fails: readonly string[] = [],
  ) {
    const shrunk: string[] = [];
    const reads: string[] = [];
    const picture = cardPictures({
      doc,
      items,
      itemIndex: (r) => items.findIndex((item) => item.id === r.itemId),
      readCapture: (r) => {
        reads.push(r.id);
        return readCapture(r);
      },
      shrink: (src): Promise<StillPicture | null> => {
        shrunk.push(src);
        if (fails.includes(src)) return Promise.resolve(null);
        return Promise.resolve(
          () => new FakeElement("CANVAS") as unknown as HTMLElement,
        );
      },
    });
    const of = (r: BookmarkSummary) =>
      picture(r) as unknown as Promise<FakeElement | null>;
    return { of, shrunk, reads };
  }

  it("shows a capture, decoded before it goes in, read only when the summary has one", async () => {
    const { of, reads, shrunk } = setup((r) =>
      Promise.resolve(`data:image/jpeg;base64,${r.id}`),
    );
    const img = await of(row("bk-1", "a-001", true));
    expect(img?.tagName).toBe("IMG");
    expect(img?.src).toBe("data:image/jpeg;base64,bk-1");
    expect(img?.decoding).toBe("async");
    expect(shrunk).toEqual([]);
    // No capture: storage is never asked.
    await of(row("bk-2", "a-001", false));
    expect(reads).toEqual(["bk-1"]);
  });

  it("without a capture shows the item's still SHRUNK (the Safari item), naming its file", async () => {
    const { of, shrunk } = setup();
    const still = await of(row("bk-1", "c-003"));
    expect(still?.tagName).toBe("CANVAS");
    expect(still?.getAttribute("data-still-src")).toBe("c-003.poster.jpg");
    // A text item shows the nearest earlier media item's still.
    await of(row("bk-2", "line-004"));
    expect(shrunk).toEqual(["c-003.poster.jpg"]);
  });

  it("shrinks a still once per page: two cards on one still, or a reopen, share it", async () => {
    const { of, shrunk } = setup();
    const [a, b] = await Promise.all([
      of(row("bk-1", "a-001")),
      of(row("bk-2", "a-001")),
    ]);
    await of(row("bk-1", "a-001"));
    expect(shrunk).toEqual(["a-001.jpg"]);
    // Each card gets its own element.
    expect(a).not.toBe(b);
  });

  it("shows the file itself when a still cannot be shrunk", async () => {
    const { of } = setup(undefined, ["a-001.jpg"]);
    const img = await of(row("bk-1", "a-001"));
    expect(img?.tagName).toBe("IMG");
    expect(img?.src).toBe("a-001.jpg");
  });

  it("falls back to the still when a capture cannot be read", async () => {
    const { of } = setup(() => Promise.reject(new Error("storage down")));
    const still = await of(row("bk-1", "b-002", true));
    expect(still?.getAttribute("data-still-src")).toBe("b-002.f000.jpg");
  });

  it("has nothing to show for an item no longer in the manifest", async () => {
    const { of } = setup();
    expect(await of(row("bk-1", "gone"))).toBeNull();
  });
});
