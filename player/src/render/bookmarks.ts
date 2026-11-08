// Bookmarks' pure helpers (docs/plan.md Phases 8, 18, 29, 35): what a
// bookmark restores and how, its timestamp text, and its thumbnail —
// the `b` capture, else the manifest still, shrunk. Since Phase 35 the
// bookmarks show as cards on the branch map (render/branchmap.ts); the `t`
// screen that once listed them is gone.
//
// Speed (the Safari bookmark-screen item, Phase 29, carried to the map): a
// card without a capture shows its manifest still SHRUNK. The still is the
// game's full-size file (1920x1080 and up, a lossless PNG or JXL video
// poster), and a board of those in the page is what kept Safari from
// painting until every visible one had decoded at full size — then all at
// once. So a still is decoded once off the page and drawn into a canvas no
// bigger than a capture (`shrinkStill`), and that small copy is what the
// card shows. A canvas, not a re-encoded image: over `file://` the still
// taints it, and a tainted canvas can be drawn but not read back.
//
// A bookmark names its item by id (docs/plan.md Phase 18, "Saves keyed by
// id, not position"): it resolves to wherever that item sits in the
// manifest being played, and a bookmark whose item is no longer in it is
// simply not drawn — there is nothing left to show or restore.

import { visualIndexFor } from "../machine/machine";
import type { Item, MachineContext } from "../machine/types";
import type { Bookmark, BookmarkSummary, SavedContext } from "../storage/types";
import { thumbSize } from "./capture";

/**
 * The delete control's x and its accessible name. The x is drawn, not a
 * font's "×", whose ink sits off its circle's centre (by a different
 * amount in each font and size): an SVG path in a 24-unit box, symmetric
 * about the box's centre, which is the circle's (index.html `.bm-del`).
 */
export const DELETE_CROSS = "M8.75 8.75 15.25 15.25M15.25 8.75 8.75 15.25";
export const DELETE_LABEL = "Delete this bookmark";

/**
 * What a card click asks the player to do: restore the context captured
 * with the bookmark, landing on the bookmarked item — `ctx.lastShown` is
 * the bookmark's `itemId`. Still id-keyed: the restore wiring converts it
 * against the manifest (`storage/ids.ts`) and hands it to
 * `machine.importContext`. Pure.
 */
export interface BookmarkRestore {
  readonly itemId: string;
  readonly ctx: SavedContext;
}

export function bookmarkRestoreTarget(record: Bookmark): BookmarkRestore {
  // The bookmarked ITEM is the time point: the restore lands on it, not on
  // any other `lastShown` a stored context might carry.
  return {
    itemId: record.itemId,
    ctx: { ...record.ctx, lastShown: record.itemId },
  };
}

/**
 * A bookmark restore never forgets progress (docs/plan.md Phase 18): the
 * landing and route frames come from the bookmark, but the seen set and the
 * played / completed routes are the UNION of the bookmark's and the
 * reader's current ones, so opening an old bookmark cannot make content
 * read since then count as unseen again. The played-this-pass record is
 * NOT merged: it is the bookmark's own, so the route flow (play-all's next
 * pick, re-offer or close) continues as of the bookmark (docs/plan.md
 * Phase 22). The last picks are the reader's current ones, the bookmark's
 * filling only decisions picked at nowhere since (docs/plan.md Phase 27):
 * the wheel keeps following the path last taken.
 */
export function mergeProgress(
  bookmark: MachineContext,
  current: MachineContext,
): MachineContext {
  const unionRoutes = (
    a: MachineContext["completedRoutes"],
    b: MachineContext["completedRoutes"],
  ) => {
    const byDecision = new Map<number, Set<number>>();
    for (const entry of [...(a ?? []), ...(b ?? [])]) {
      const set = byDecision.get(entry.decision) ?? new Set<number>();
      for (const route of entry.routes) set.add(route);
      byDecision.set(entry.decision, set);
    }
    return [...byDecision.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([decision, routes]) => ({
        decision,
        routes: [...routes].sort((x, y) => x - y),
      }));
  };
  return {
    ...bookmark,
    visited: [...new Set([...bookmark.visited, ...current.visited])].sort(
      (a, b) => a - b,
    ),
    playedRoutes: unionRoutes(bookmark.playedRoutes, current.playedRoutes),
    completedRoutes: unionRoutes(
      bookmark.completedRoutes,
      current.completedRoutes,
    ),
    // The route FLOW is the bookmark's own (docs/plan.md Phase 22): its
    // played-this-pass record — for a bookmark from before that record, the
    // routes it had played — so continuing from it plays on as it did then.
    passRoutes: bookmark.passRoutes ?? bookmark.playedRoutes,
    lastPicks: [
      ...(bookmark.lastPicks ?? []).filter(
        (pick) =>
          !(current.lastPicks ?? []).some(
            (newer) => newer.decision === pick.decision,
          ),
      ),
      ...(current.lastPicks ?? []),
    ].sort((a, b) => a.decision - b.decision),
  };
}

/** Where a bookmark's item now sits in `items`; -1 when it is gone. */
export function bookmarkItemIndex(
  bookmark: { readonly itemId: string },
  items: readonly Item[],
): number {
  return items.findIndex((item) => item.id === bookmark.itemId);
}

/**
 * `YYYY-MM-DD HH:MM:SS` in the reader's local time, zero-padded — the
 * timestamp a bookmark's card shows under its thumbnail.
 */
export function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number, width = 2): string =>
    String(value).padStart(width, "0");
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-` +
    `${pad(date.getDate())} ${pad(date.getHours())}:` +
    `${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * What a bookmark's thumbnail shows. The `b` capture when there is one
 * (`thumbDataUrl`); otherwise the still of the content that was visible at
 * that index — image file, animation `frames[0]`, video poster, and for a
 * `text` item the nearest earlier media item's, the same visual rule as
 * `machine.visualIndex()`. Null when nothing resolvable exists (an item
 * no longer in the manifest).
 */
export function entryThumbSrc(
  bookmark: { readonly itemId: string; readonly thumbDataUrl?: string | null },
  items: readonly Item[],
  index: number = bookmarkItemIndex(bookmark, items),
): string | null {
  const dataUrl = bookmark.thumbDataUrl;
  if (typeof dataUrl === "string" && dataUrl !== "") return dataUrl;
  if (index < 0) return null;
  const item: Item | undefined = items[visualIndexFor(items, index)];
  if (item === undefined) return null;
  if (item.type === "image") return item.file;
  if (item.type === "animation") return item.frames[0] ?? null;
  if (item.type === "video") return item.poster;
  return null;
}

/**
 * A manifest still shrunk to thumbnail size: each call makes a fresh
 * element showing it (a card per bookmark, and two bookmarks can share a
 * still), already drawn.
 */
export type StillPicture = () => HTMLElement;

/**
 * The browser's still shrinker: loads `src`, decodes it off the page, and
 * draws it once into a canvas no wider than a capture (`thumbSize`); each
 * card then gets a copy of that small canvas. Null when it cannot (no 2D
 * canvas, or the file does not decode) — the card then shows the file as
 * an image, as before.
 */
export async function shrinkStill(
  doc: Document,
  src: string,
): Promise<StillPicture | null> {
  const image = doc.createElement("img");
  image.decoding = "async";
  image.src = src;
  try {
    await image.decode();
  } catch {
    return null;
  }
  const { width, height } = thumbSize(image.naturalWidth, image.naturalHeight);
  if (width === 0 || height === 0) return null;
  const canvasOf = (): HTMLCanvasElement | null => {
    const canvas = doc.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas.getContext("2d") === null ? null : canvas;
  };
  const small = canvasOf();
  const smallCtx = small?.getContext("2d");
  if (small === null || smallCtx === null || smallCtx === undefined) {
    return null;
  }
  smallCtx.imageSmoothingQuality = "high";
  try {
    smallCtx.drawImage(image, 0, 0, width, height);
  } catch {
    return null;
  }
  // The full-size image is dropped here; only the small copy is kept.
  return () => {
    const canvas = canvasOf();
    if (canvas === null) return doc.createElement("canvas");
    canvas.getContext("2d")?.drawImage(small, 0, 0);
    return canvas;
  };
}

/**
 * Where a card's picture comes from (the branch map's bookmark cards,
 * Phase 35; the `t` screen's before it, Phases 26 and 29): its `b` capture,
 * read from storage only when the summary says it has one and decoded
 * before it goes in; else the manifest still (`entryThumbSrc`) SHRUNK, once
 * per file for the page's life, so two cards on one still share the work
 * and a reopen draws at once; the file itself when it cannot be shrunk. A
 * capture that cannot be read falls back to the still. Null when there is
 * nothing to show.
 */
export function cardPictures({
  doc,
  items,
  itemIndex,
  readCapture,
  shrink = (src) => shrinkStill(doc, src),
}: {
  doc: Document;
  items: readonly Item[];
  /** Where the bookmark's item sits in `items`; -1 when it is gone. */
  itemIndex(row: BookmarkSummary): number;
  /** The capture's data URL, read from storage (null: none). */
  readCapture(row: BookmarkSummary): Promise<string | null>;
  shrink?: (src: string) => Promise<StillPicture | null>;
}): (row: BookmarkSummary) => Promise<HTMLElement | null> {
  const stills = new Map<string, Promise<StillPicture | null>>();
  const image = (src: string): HTMLImageElement => {
    const img = doc.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.src = src; // a file is relative to the content folder
    return img;
  };
  return async (row) => {
    const capture = row.hasThumb
      ? await readCapture(row).catch(() => null)
      : null;
    const src = entryThumbSrc(
      { itemId: row.itemId, thumbDataUrl: capture },
      items,
      itemIndex(row),
    );
    if (src === null) return null;
    if (src.startsWith("data:")) {
      const img = image(src);
      await img.decode().catch(() => undefined);
      return img;
    }
    let shrunk = stills.get(src);
    if (shrunk === undefined) {
      shrunk = shrink(src).catch(() => null);
      stills.set(src, shrunk);
    }
    const make = await shrunk;
    const picture = make === null ? image(src) : make();
    picture.setAttribute("data-still-src", src);
    return picture;
  };
}
