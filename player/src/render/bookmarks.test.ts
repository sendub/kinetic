// The pure half of the `t` bookmark overlay (docs/plan.md Phases 8, 13):
// the list order, the scroll-to-bottom target, the timestamp and label
// text, the thumbnail source rule, and the bookmark's restore target. The
// DOM panel in bookmarks.ts only applies these; the end-to-end behaviour
// is walked by scripts/verify.mjs.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { Item } from "../machine/types";
import type { Bookmark, BookmarkSummary, SavedContext } from "../storage/types";
import {
  BOOKMARKS_HINT,
  bookmarkItemIndex,
  bookmarkRestoreTarget,
  bottomScrollTop,
  entryLabel,
  entryThumbSrc,
  formatTimestamp,
  keptScrollTop,
  listOrder,
  mergeProgress,
  mountBookmarkOverlay,
  placeholderAspect,
  THUMB_LOADS_AT_ONCE,
  thumbLoadOrder,
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

describe("BOOKMARKS_HINT (separators in words, Phase 24)", () => {
  it('splits its clauses with "; ", never "·"', () => {
    expect(BOOKMARKS_HINT).toBe(
      "click an entry to continue there; its × deletes it; t or Esc closes",
    );
  });
});

// Phase 26, "Bigger bookmark thumbnails in a grid": the list is a grid of
// cards filling across, then down, each a large thumbnail with its time
// and label under it. The layout lives in CSS, so the durable assertion is
// about the shipped CSS (the same kind of guard as fit.test.ts); the DOM
// half is pinned against a minimal fake document, as help.test.ts does.
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "..", "index.html"), "utf8");
const cssRule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`).exec(html)?.[0] ?? ""
  );
};

describe("the t list is a grid of large cards (docs/plan.md Phase 26)", () => {
  it("lays the cards out across, then down: an auto-fill grid like the Esc keys", () => {
    const list = cssRule(".bookmarks-list");
    expect(list).toContain("display: grid");
    expect(list).toMatch(
      /grid-template-columns:\s*repeat\(\s*auto-fill,\s*minmax\(min\(100%,\s*\d+px\),\s*1fr\)\s*\)/,
    );
    const min = Number(
      /minmax\(min\(100%,\s*(\d+)px\)/.exec(list)?.[1] ?? Number.NaN,
    );
    expect(min).toBeGreaterThanOrEqual(240);
    expect(min).toBeLessThanOrEqual(340);
  });

  it("stacks each card: the thumbnail on top, its time and label under it", () => {
    expect(cssRule(".bookmark-entry")).toContain("flex-direction: column");
  });

  it("draws the thumbnail the card's full width at its own aspect ratio", () => {
    const thumb = cssRule(".bookmark-thumb");
    expect(thumb).toContain("width: 100%");
    expect(thumb).toContain("height: auto");
    expect(thumb).toContain("object-fit: contain");
    expect(thumb).not.toMatch(/(?:^|[^-])height:\s*clamp/);
  });
});

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  className = "";
  id = "";
  hidden = false;
  textContent = "";
  type = "";
  src = "";
  alt = "";
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  readonly attributes = new Map<string, string>();
  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}
  get isConnected(): boolean {
    return this.parent !== null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.appendChild(node);
  }
  appendChild(node: FakeElement): FakeElement {
    this.children.push(node);
    node.parent = this;
    return node;
  }
  replaceChildren(...nodes: FakeElement[]): void {
    for (const node of this.children) node.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  replaceWith(node: FakeElement): void {
    const parent = this.parent;
    if (parent === null) return;
    parent.children[parent.children.indexOf(this)] = node;
    node.parent = parent;
    this.parent = null;
  }
  addEventListener(): void {}
}

class FakeDocument {
  defaultView = null;
  createElement(tag: string): FakeElement {
    return new FakeElement(tag.toUpperCase(), this);
  }
}

/** Summaries as `Storage.listBookmarks` hands them, keyed 1, 2, 3... */
function summaries(
  records: readonly Bookmark[],
  withThumb = false,
): BookmarkSummary[] {
  return records.map((record, index) => ({
    key: index + 1,
    id: record.id,
    timestampMs: record.timestampMs,
    itemId: record.itemId,
    hasThumb: withThumb,
  }));
}

function mountList(
  loadThumb: (row: BookmarkSummary) => Promise<string | null> = () =>
    Promise.resolve(null),
) {
  const root = new FakeDocument().createElement("div");
  const overlay = mountBookmarkOverlay({
    root: root as unknown as HTMLElement,
    items,
    stage: { width: 1280, height: 720 },
    loadThumb,
    onPick: () => {},
    onDelete: () => {},
  });
  const [panel] = root.children;
  const list = panel?.children.find((el) => el.className === "bookmarks-list");
  if (panel === undefined || list === undefined) throw new Error("no list");
  return { overlay, panel, list };
}

const thumbOf = (card: FakeElement | undefined) =>
  card?.children[0]?.children[0];

describe("mountBookmarkOverlay cards (Phase 26: order and scroll unchanged)", () => {
  const records = summaries([
    bookmark({ id: "bk-1", itemId: "c-003", timestampMs: 3 }),
    bookmark({ id: "bk-2", itemId: "a-001", timestampMs: 1 }),
    bookmark({ id: "bk-3", itemId: "b-002", timestampMs: 2 }),
  ]);

  it("draws one card per bookmark in the storage order, oldest first", () => {
    const { overlay, list } = mountList();
    overlay.render(records);
    expect(list.children.map((el) => el.getAttribute("data-item-id"))).toEqual([
      "c-003",
      "a-001",
      "b-002",
    ]);
    expect(
      list.children.map((el) => el.getAttribute("data-entry-index")),
    ).toEqual(["0", "1", "2"]);
  });

  it("each card is a button: the thumbnail box (still and ×) over the time and label", () => {
    const { overlay, list } = mountList();
    overlay.render(records);
    for (const card of list.children) {
      expect(card.tagName).toBe("BUTTON");
      expect(card.className).toBe("bookmark-entry");
      expect(card.children.map((el) => el.className)).toEqual([
        "bookmark-thumb-box",
        "bookmark-meta",
      ]);
      const [box, meta] = card.children;
      expect(box?.children.map((el) => el.className)).toEqual([
        "bookmark-thumb",
        "bookmark-delete",
      ]);
      expect(box?.children[1]?.textContent).toBe("×");
      expect(meta?.children.map((el) => el.className)).toEqual([
        "bookmark-time",
        "bookmark-label",
      ]);
    }
  });

  it("opens scrolled to the bottom, so the newest (last) card is in view", () => {
    const { overlay, list } = mountList();
    list.scrollHeight = 1400;
    list.clientHeight = 600;
    overlay.render(records);
    expect(list.scrollTop).toBe(800);
  });

  it("shows the empty message, and no grid, with no bookmarks", () => {
    const { overlay, panel, list } = mountList();
    overlay.render([]);
    const empty = panel.children.find(
      (el) => el.className === "bookmarks-empty",
    );
    expect(list.hidden).toBe(true);
    expect(empty?.hidden).toBe(false);
    expect(empty?.textContent).toBe("No bookmarks yet — press b");
  });
});

// The bookmark-screen speed item (docs/progress.md): the panel shows before
// the list is read, and captured thumbnails load lazily, newest first.
describe("mountBookmarkOverlay opens at once and fills in its pictures", () => {
  const records = [
    bookmark({ id: "bk-1", itemId: "c-003" }),
    bookmark({ id: "bk-2", itemId: "a-001" }),
    bookmark({ id: "bk-3", itemId: "b-002" }),
  ];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("open() shows the panel with no rows and no empty message; the first render then scrolls to the newest", () => {
    const { overlay, panel, list } = mountList();
    list.scrollHeight = 1400;
    list.clientHeight = 600;
    overlay.open();
    const empty = panel.children.find(
      (el) => el.className === "bookmarks-empty",
    );
    expect(overlay.isOpen()).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(list.children).toEqual([]);
    expect(empty?.hidden).toBe(true);
    overlay.render(summaries(records));
    expect(list.children).toHaveLength(3);
    expect(list.scrollTop).toBe(800);
    // A later render of the open list (a delete) keeps the reader's place.
    list.scrollTop = 100;
    overlay.render(summaries(records).slice(1));
    expect(list.scrollTop).toBe(100);
  });

  it("a captured thumbnail starts as a stage-shaped placeholder and is swapped in once read, newest first", async () => {
    const asked: string[] = [];
    const { overlay, panel, list } = mountList((row) => {
      asked.push(row.id);
      return Promise.resolve(`data:image/jpeg;base64,${row.id}`);
    });
    expect(panel.getAttribute("style")).toBe(
      "--bookmark-thumb-aspect: 1280 / 720",
    );
    overlay.render(summaries(records, true));
    for (const card of list.children) {
      expect(thumbOf(card)?.className).toBe(
        "bookmark-thumb bookmark-thumb-empty",
      );
    }
    await settle();
    expect(asked).toEqual(["bk-3", "bk-2", "bk-1"]);
    expect(list.children.map((card) => thumbOf(card)?.src)).toEqual([
      "data:image/jpeg;base64,bk-1",
      "data:image/jpeg;base64,bk-2",
      "data:image/jpeg;base64,bk-3",
    ]);
    expect(thumbOf(list.children[0])?.tagName).toBe("IMG");
    expect(thumbOf(list.children[0])?.getAttribute("decoding")).toBe("async");
    // Decoded before it goes in, so never `lazy` (which would never load
    // outside the page).
    expect(thumbOf(list.children[0])?.getAttribute("loading")).toBeNull();
  });

  it("a row without a capture shows its manifest still at once, never asking storage", () => {
    let asked = 0;
    const { overlay, list } = mountList(() => {
      asked += 1;
      return Promise.resolve(null);
    });
    overlay.render(summaries(records));
    expect(list.children.map((card) => thumbOf(card)?.src)).toEqual([
      "c-003.poster.jpg",
      "a-001.jpg",
      "b-002.f000.jpg",
    ]);
    // A file: fetched only as its card nears the view.
    expect(thumbOf(list.children[0])?.getAttribute("loading")).toBe("lazy");
    expect(asked).toBe(0);
  });

  it("reads a picture once per page: a reopen draws it straight away", async () => {
    let asked = 0;
    const { overlay, list } = mountList((row) => {
      asked += 1;
      return Promise.resolve(`data:image/jpeg;base64,${row.id}`);
    });
    overlay.render(summaries(records, true));
    await settle();
    overlay.close();
    overlay.open();
    overlay.render(summaries(records, true));
    expect(thumbOf(list.children[2])?.src).toBe("data:image/jpeg;base64,bk-3");
    expect(asked).toBe(3);
  });

  it("a capture that cannot be read falls back to the manifest still", async () => {
    const { overlay, list } = mountList(() => Promise.reject(new Error("x")));
    overlay.render(summaries(records, true));
    await settle();
    expect(thumbOf(list.children[1])?.src).toBe("a-001.jpg");
  });

  it("reads at most a few pictures at a time", async () => {
    const many = Array.from({ length: 10 }, (_, n) =>
      bookmark({ id: `bk-${String(n)}`, itemId: "a-001" }),
    );
    const waiting: Array<() => void> = [];
    let live = 0;
    let most = 0;
    const { overlay } = mountList(
      () =>
        new Promise((resolve) => {
          live += 1;
          most = Math.max(most, live);
          waiting.push(() => {
            live -= 1;
            resolve(null);
          });
        }),
    );
    overlay.render(summaries(many, true));
    while (waiting.length > 0) {
      (waiting.shift() as () => void)();
      await settle();
    }
    expect(most).toBe(THUMB_LOADS_AT_ONCE);
  });
});

describe("thumbLoadOrder and placeholderAspect", () => {
  it("loads the newest (last) rows first", () => {
    expect(thumbLoadOrder([1, 2, 3])).toEqual([3, 2, 1]);
  });

  it("shapes a placeholder like the stage, 16 / 9 for an unusable size", () => {
    expect(placeholderAspect(1920, 1080)).toBe("1920 / 1080");
    expect(placeholderAspect(0, 1080)).toBe("16 / 9");
    expect(placeholderAspect(Number.NaN, 5)).toBe("16 / 9");
  });
});
