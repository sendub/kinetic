import { describe, expect, it } from "vitest";
import {
  latestDeleted,
  NO_DELETIONS,
  newestBookmarkId,
  pictureOrder,
  withDeleted,
  withRestored,
} from "./mapcards";

// The bookmark cards' pure rules on the branch map (docs/plan.md Phase 35).

describe("newestBookmarkId (the card marked NEWEST)", () => {
  it("is the latest clock, whatever the list order; none for no bookmarks", () => {
    expect(newestBookmarkId([])).toBeNull();
    expect(
      newestBookmarkId([
        { id: "a", timestampMs: 300 },
        { id: "b", timestampMs: 100 },
        { id: "c", timestampMs: 200 },
      ]),
    ).toBe("a");
  });

  it("an undone delete goes back at the end of the stored list but is not newest for it", () => {
    // Storage is oldest first; an undo appends the old record again.
    expect(
      newestBookmarkId([
        { id: "b", timestampMs: 200 },
        { id: "a", timestampMs: 100 },
      ]),
    ).toBe("b");
  });

  it("takes the later in the list on a tie", () => {
    expect(
      newestBookmarkId([
        { id: "a", timestampMs: 100 },
        { id: "b", timestampMs: 100 },
      ]),
    ).toBe("b");
  });
});

describe("pictureOrder (cards in view first, then newest first)", () => {
  const card = (id: string, cx: number, cy: number, timestampMs: number) => ({
    id,
    cx,
    cy,
    timestampMs,
  });
  const view = { x0: 0, y0: 0, x1: 1000, y1: 500 };

  it("loads the cards in or near the view first, nearest its centre first", () => {
    const order = pictureOrder(
      [
        card("edge", 950, 250, 1),
        card("centre", 510, 240, 2),
        card("near", -300, 250, 3), // within half a view of it
        card("far", 5000, 250, 9),
      ],
      view,
    ).map((c) => c.id);
    expect(order).toEqual(["centre", "edge", "near", "far"]);
  });

  it("then the rest newest first, as the t screen did", () => {
    const order = pictureOrder(
      [
        card("old", 9000, 9000, 1),
        card("newest", 8000, 9000, 30),
        card("mid", -9000, 9000, 20),
      ],
      view,
    ).map((c) => c.id);
    expect(order).toEqual(["newest", "mid", "old"]);
  });

  it("leaves its input as it was", () => {
    const cards = [card("b", 9000, 0, 1), card("a", 500, 250, 2)];
    pictureOrder(cards, view);
    expect(cards.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("the deletes of one open (× and Z)", () => {
  it("starts with none, and Z has nothing to undo", () => {
    expect(NO_DELETIONS).toEqual([]);
    expect(latestDeleted(NO_DELETIONS)).toBeNull();
  });

  it("Z undoes the latest delete still standing, then the one before", () => {
    let d = withDeleted(NO_DELETIONS, "a");
    d = withDeleted(d, "b");
    d = withDeleted(d, "c");
    expect(latestDeleted(d)).toBe("c");
    d = withRestored(d, "c");
    expect(latestDeleted(d)).toBe("b");
    // A ghost's own Undo can put back one from the middle.
    d = withRestored(d, "a");
    expect(d).toEqual(["b"]);
    d = withRestored(d, "b");
    expect(latestDeleted(d)).toBeNull();
  });

  it("deleting twice or restoring one never deleted changes nothing", () => {
    const d = withDeleted(withDeleted(NO_DELETIONS, "a"), "a");
    expect(d).toEqual(["a"]);
    expect(withRestored(d, "zzz")).toEqual(["a"]);
  });
});
