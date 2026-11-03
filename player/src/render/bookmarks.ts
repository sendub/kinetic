// The `t` bookmark overlay (docs/plan.md Phase 8, README `t` bullet): a
// full-screen panel holding the bookmarks as a grid of large cards (Phase
// 26: thumbnail over time and label, filling across, then down — the CSS
// in index.html), rendered OLDEST-first at the top left through to the
// NEWEST last, auto-scrolled to the bottom so the most recent card is in
// view. Clicking an entry closes the
// panel and continues the novel from that time point (`machine.importContext`); a
// click anywhere else on the panel is backdrop and only closes it. Each
// thumbnail carries an "x" in its top-right corner (docs/plan.md Phase 18,
// "Delete a bookmark"): clicking it deletes that bookmark — storage
// included — without opening it, and the list re-renders in place.
//
// Every decision (entry order, thumbnail source, timestamp text, the
// scroll-to-bottom target) is a pure export below; the DOM part only
// applies them. Entries render in the order the Storage contract gives —
// oldest first (insertion order, `storage/types.ts`) — so "reading order,
// newest last" IS that order, and the list scrolls to its bottom.
//
// Speed (the bookmark-screen speed item, docs/progress.md): the panel shows
// the instant `t` is pressed and its cards come from the stored rows'
// SUMMARIES (`Storage.listBookmarks`: id, time, item, whether a thumbnail
// was captured) — never from every row's route context and thumbnail.
// Captured thumbnails then load lazily, a few at a time, through
// `loadThumb`: newest first, any card the reader scrolls into view (an
// IntersectionObserver on the list) jumping the queue, each decoded off
// the main thread before it replaces its placeholder,
// which already holds the stage's aspect ratio so the cards do not jump.
// A card without a capture shows its manifest still, SHRUNK: the still is
// the game's full-size file (1920x1080 and up, a lossless PNG or JXL video
// poster), and a grid of those in the page is what kept Safari from
// painting until every visible one had decoded at full size — then all at
// once (the Safari bookmark-screen item). So a still goes through the same
// queue as a capture: decoded once off the page, drawn into a canvas no
// bigger than a capture (`shrinkStill`), and that small copy is what the
// card shows. A canvas, not a re-encoded image: over `file://` the still
// taints it, and a tainted canvas can be drawn but not read back. Loaded
// pictures are kept for the page's life, so a reopen or the re-render
// after a delete draws them straight away. An entry click hands the
// summary back; the caller reads the whole bookmark, then closes the panel
// as it restores it.
//
// A bookmark names its item by id (docs/plan.md Phase 18, "Saves keyed by
// id, not position"): the row resolves it to wherever that item sits in
// the manifest being played, and a bookmark whose item is no longer in it
// is simply not listed — there is nothing left to show or restore.

import { visualIndexFor } from "../machine/machine";
import type { Item, MachineContext } from "../machine/types";
import type { Bookmark, BookmarkSummary, SavedContext } from "../storage/types";
import { thumbSize } from "./capture";

/** The panel's message when the novel has no bookmarks yet. */
export const EMPTY_MESSAGE = "No bookmarks yet — press b";

/** The delete control's glyph and its accessible name. */
export const DELETE_GLYPH = "×";
export const DELETE_LABEL = "Delete this bookmark";

/**
 * What an entry click asks the player to do: restore the context captured
 * with the bookmark, landing on the bookmarked item — `ctx.lastShown` is
 * the bookmark's `itemId`. Still id-keyed: the restore wiring converts it
 * against the manifest (`storage/ids.ts`) and hands it to
 * `machine.importContext`. Pure.
 */
export interface BookmarkRestore {
  readonly itemId: string;
  readonly ctx: SavedContext;
}

/** The panel's hint: separate clauses split by "; " (Phase 24). */
export const BOOKMARKS_HINT =
  "click an entry to continue there; its × deletes it; t or Esc closes";

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
 * The list's render order: the storage order, oldest first, copied so a
 * later mutation of the caller's array cannot restyle the open panel —
 * minus every bookmark whose item `items` no longer holds. This function
 * is where the storage contract ("oldest first, never re-sorted by
 * clock") becomes the visual contract ("oldest first in reading order").
 */
export function listOrder<T extends { readonly itemId: string }>(
  bookmarks: readonly T[],
  items: readonly Item[],
): T[] {
  const ids = new Set(items.map((item) => item.id));
  return bookmarks
    .filter((bookmark) => ids.has(bookmark.itemId))
    .map((bookmark) => ({ ...bookmark }));
}

/**
 * `YYYY-MM-DD HH:MM:SS` in the reader's local time, zero-padded — the
 * timestamp the list shows beside each thumbnail.
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
 * What the entry's thumbnail shows. The `b` capture when there is one
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
 * The scrollTop that puts the list's bottom edge at its viewport's bottom;
 * 0 when the entries do not overflow (nothing to scroll, the newest is
 * already visible).
 */
export function bottomScrollTop(
  scrollHeight: number,
  clientHeight: number,
): number {
  return Math.max(0, scrollHeight - clientHeight);
}

/**
 * The scrollTop for a re-render of the OPEN list (after a delete): the
 * reader's place is kept, clamped to the shorter list's new bottom, so the
 * rows around the deleted one stay where the pointer is. Opening the list
 * scrolls to the bottom instead (`bottomScrollTop`).
 */
export function keptScrollTop(
  previous: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  return Math.min(
    Math.max(0, previous),
    bottomScrollTop(scrollHeight, clientHeight),
  );
}

/** The entry's second line: the item index plus its manifest id, if known. */
export function entryLabel(itemIndex: number, id: string | undefined): string {
  return id === undefined
    ? `#${String(itemIndex)} (unknown item)`
    : `#${String(itemIndex)} ${id}`;
}

/**
 * The order lazily loaded thumbnails are fetched in, before the observer
 * says which cards are in view: the newest first, as the list opens
 * scrolled to the newest. Pure.
 */
export function thumbLoadOrder<T>(pending: readonly T[]): T[] {
  return [...pending].reverse();
}

/** How many captured thumbnails are read from storage at once. */
export const THUMB_LOADS_AT_ONCE = 4;

/**
 * The CSS `aspect-ratio` of a thumbnail still loading: the stage's (the
 * manifest's `width` / `height`), the shape a capture almost always has,
 * so the card keeps its size when the picture arrives; 16 / 9 when the
 * size is unusable. Pure.
 */
export function placeholderAspect(width: number, height: number): string {
  return Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
    ? `${String(width)} / ${String(height)}`
    : "16 / 9";
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

export interface BookmarkOverlay {
  isOpen(): boolean;
  /**
   * Shows the panel now, before the list is read: the title and hint, an
   * empty list until `render` fills it.
   */
  open(): void;
  /**
   * Fills the list and shows the panel; the first fill after opening
   * scrolls it to the bottom, a later one (a delete) keeps the place.
   */
  render(bookmarks: readonly BookmarkSummary[]): void;
  close(): void;
}

export interface BookmarkOverlayOptions {
  /** The `#app` element; the panel is its sibling above stage and overlay. */
  root: HTMLElement;
  /** The manifest, for thumbnails derived from item stills. */
  items: readonly Item[];
  /** The stage size, for the shape of a thumbnail still loading. */
  stage?: { readonly width: number; readonly height: number };
  /**
   * Reads a bookmark's captured thumbnail (a `data:image/` URL), null when
   * there is none; called lazily, for cards in or near view.
   */
  loadThumb(bookmark: BookmarkSummary): Promise<string | null>;
  /**
   * Shrinks a manifest still for a card without a capture; defaults to
   * `shrinkStill` on the panel's document. Called once per still per page.
   */
  shrinkStill?(src: string): Promise<StillPicture | null>;
  /**
   * An entry was clicked: the caller reads the whole bookmark, then closes
   * the panel and restores what it recorded — `bookmarkRestoreTarget`: its
   * context, landing on its item.
   */
  onPick(bookmark: BookmarkSummary): void;
  /**
   * A thumbnail's "x" was clicked: the caller deletes this bookmark from
   * storage and re-renders the list (the panel stays open).
   */
  onDelete(bookmark: BookmarkSummary): void;
}

export function mountBookmarkOverlay({
  root,
  items,
  stage,
  loadThumb,
  shrinkStill: shrink,
  onPick,
  onDelete,
}: BookmarkOverlayOptions): BookmarkOverlay {
  const doc = root.ownerDocument;
  const shrinkOne = shrink ?? ((src: string) => shrinkStill(doc, src));
  const view = doc.defaultView;
  const indexById = new Map(items.map((item, index) => [item.id, index]));

  const panel = doc.createElement("div");
  panel.id = "bookmarks";
  panel.className = "bookmarks";
  panel.hidden = true; // `t` opens; Escape, backdrop or an entry click closes
  panel.setAttribute(
    "style",
    `--bookmark-thumb-aspect: ${placeholderAspect(
      stage?.width ?? 0,
      stage?.height ?? 0,
    )}`,
  );

  const title = doc.createElement("h2");
  title.className = "bookmarks-title";
  title.textContent = "Bookmarks";

  const hint = doc.createElement("p");
  hint.className = "bookmarks-hint";
  hint.textContent = BOOKMARKS_HINT;

  const list = doc.createElement("div");
  list.className = "bookmarks-list";

  const empty = doc.createElement("p");
  empty.className = "bookmarks-empty";
  empty.textContent = EMPTY_MESSAGE;

  panel.append(title, hint, list, empty);
  root.appendChild(panel);

  // Captured thumbnails read so far, by row key (null: the row has none),
  // kept for the page's life: a row's thumbnail never changes.
  const thumbs = new Map<number, string | null>();
  // Manifest stills shrunk so far, by file (null: they could not be, the
  // card shows the file itself), and the shrinks running; page life too.
  const stills = new Map<string, StillPicture | null>();
  const shrinking = new Map<string, Promise<void>>();
  // The placeholders of the rows rendered now whose picture is not ready
  // yet — a capture not read, or a still not shrunk — by key; a render
  // replaces the set.
  let pending = new Map<number, HTMLElement>();
  const rowsByKey = new Map<number, BookmarkSummary>();
  // Requested loads, the next first, and how many are running.
  const queue: number[] = [];
  const queued = new Set<number>();
  const loading = new Set<number>();
  // Until the reader scrolls, the list stays on its newest card while
  // pictures arrive (one shaped unlike the stage changes a card's height).
  let pinned = false;

  // A manifest still is a file: `lazy` leaves it unfetched until its card
  // nears the view. A capture is already in memory and is decoded before
  // it goes into the page — and a lazy image outside the page never loads,
  // so it would never decode.
  function thumbImage(src: string, lazy: boolean): HTMLElement {
    const thumb = doc.createElement("img");
    thumb.className = "bookmark-thumb";
    thumb.alt = "";
    thumb.setAttribute("decoding", "async");
    if (lazy) thumb.setAttribute("loading", "lazy");
    thumb.src = src; // relative to the page: the content folder's own file
    return thumb;
  }

  function placeholder(): HTMLElement {
    const box = doc.createElement("span");
    box.className = "bookmark-thumb bookmark-thumb-empty";
    return box;
  }

  /**
   * The card's picture for `src` once it is ready: a capture as an image,
   * a still as its shrunk copy (the file itself if it could not be).
   */
  function pictureElement(src: string): HTMLElement {
    if (src.startsWith("data:")) return thumbImage(src, false);
    const make = stills.get(src);
    if (make === null || make === undefined) return thumbImage(src, true);
    const picture = make();
    picture.className = "bookmark-thumb";
    picture.setAttribute("data-still-src", src);
    return picture;
  }

  /** Whether `src` can be drawn now, without waiting on a load. */
  function ready(src: string): boolean {
    return src.startsWith("data:") || stills.has(src);
  }

  function stillSrc(row: BookmarkSummary, thumb: string | null): string | null {
    return entryThumbSrc(
      { itemId: row.itemId, thumbDataUrl: thumb },
      items,
      indexById.get(row.itemId) ?? -1,
    );
  }

  /** Swap a row's placeholder for its picture, once it is decoded. */
  function fill(key: number): void {
    const slot = pending.get(key);
    const row = rowsByKey.get(key);
    if (slot === undefined || row === undefined) return;
    pending.delete(key);
    observer?.unobserve(slot);
    const src = stillSrc(row, thumbs.get(key) ?? null);
    if (src === null) {
      slot.removeAttribute("data-thumb-key"); // nothing to show: it stays
      return;
    }
    const picture = pictureElement(src);
    const swap = () => {
      if (!slot.isConnected) return;
      slot.replaceWith(picture);
      if (pinned)
        list.scrollTop = bottomScrollTop(list.scrollHeight, list.clientHeight);
    };
    // A capture is decoded before it goes in; a shrunk still is drawn.
    const image = picture as HTMLImageElement;
    if (src.startsWith("data:") && typeof image.decode === "function") {
      image.decode().then(swap, swap);
    } else {
      swap();
    }
  }

  /** Shrink a still once per page; later callers share the first's work. */
  function shrinkOnce(src: string): Promise<void> {
    if (stills.has(src)) return Promise.resolve();
    let running = shrinking.get(src);
    if (running === undefined) {
      running = shrinkOne(src)
        .catch(() => null)
        .then((picture) => {
          stills.set(src, picture);
          shrinking.delete(src);
        });
      shrinking.set(src, running);
    }
    return running;
  }

  /** Make a row's picture ready: read its capture, else shrink its still. */
  async function prepare(row: BookmarkSummary): Promise<void> {
    if (row.hasThumb && !thumbs.has(row.key)) {
      const thumb = await loadThumb(row).catch(() => null);
      thumbs.set(row.key, thumb);
    }
    const src = stillSrc(row, thumbs.get(row.key) ?? null);
    if (src !== null && !ready(src)) await shrinkOnce(src);
  }

  function pump(): void {
    while (loading.size < THUMB_LOADS_AT_ONCE && queue.length > 0) {
      const key = queue.shift() as number;
      queued.delete(key);
      const row = rowsByKey.get(key);
      if (row === undefined || !pending.has(key)) continue;
      loading.add(key);
      prepare(row)
        .catch(() => undefined)
        .then(() => {
          loading.delete(key);
          fill(key); // into whichever render now shows the row
          pump();
        });
    }
  }

  /** Queue a row's picture; an `urgent` one (in view) goes first. */
  function request(key: number, urgent = false): void {
    if (loading.has(key) || !pending.has(key)) return;
    if (queued.has(key)) {
      if (!urgent) return;
      queue.splice(queue.indexOf(key), 1);
    }
    queued.add(key);
    if (urgent) queue.unshift(key);
    else queue.push(key);
    pump();
  }

  // Cards in view, or within a screen of it, jump the queue; every other
  // card's picture follows, newest first, so scrolling finds them drawn.
  const observer =
    view !== null && view !== undefined && "IntersectionObserver" in view
      ? new view.IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const key = Number(
                (entry.target as HTMLElement).getAttribute("data-thumb-key"),
              );
              if (Number.isInteger(key)) request(key, true);
            }
          },
          { root: list, rootMargin: "100% 0px" },
        )
      : null;

  // The reader taking the scroll ends the pin to the newest card.
  for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
    panel.addEventListener(type, () => {
      pinned = false;
    });
  }

  function entryElement(
    bookmark: BookmarkSummary,
    position: number,
  ): HTMLElement {
    const entry = doc.createElement("button");
    entry.className = "bookmark-entry";
    entry.type = "button";
    const itemIndex = indexById.get(bookmark.itemId) ?? -1;
    entry.setAttribute("data-item-index", String(itemIndex));
    entry.setAttribute("data-item-id", bookmark.itemId);
    // Which record of the last-rendered list this row is: the click
    // resolves the full bookmark through it, so the restore can carry the
    // record's ctx (Phase 13) rather than just its item.
    entry.setAttribute("data-entry-index", String(position));

    // The thumbnail sits in a positioned box so the "x" can take its
    // top-right corner. The "x" is a span with a button role, not a
    // <button>: it lives inside the entry's button, which cannot nest one.
    // A picture not ready yet — a capture not read, a still not shrunk —
    // is a placeholder the loader swaps out.
    const thumbBox = doc.createElement("span");
    thumbBox.className = "bookmark-thumb-box";
    const known = !bookmark.hasThumb || thumbs.has(bookmark.key);
    const src = known
      ? stillSrc(bookmark, thumbs.get(bookmark.key) ?? null)
      : null;
    if (src !== null && ready(src)) {
      thumbBox.appendChild(pictureElement(src));
    } else {
      const slot = placeholder();
      if (!known || src !== null) {
        slot.setAttribute("data-thumb-key", String(bookmark.key));
        pending.set(bookmark.key, slot);
      }
      thumbBox.appendChild(slot);
    }
    const remove = doc.createElement("span");
    remove.className = "bookmark-delete";
    remove.setAttribute("role", "button");
    remove.setAttribute("aria-label", DELETE_LABEL);
    remove.setAttribute("title", DELETE_LABEL);
    remove.setAttribute("data-bookmark-delete", "");
    remove.textContent = DELETE_GLYPH;
    thumbBox.appendChild(remove);
    entry.appendChild(thumbBox);

    const meta = doc.createElement("span");
    meta.className = "bookmark-meta";
    const time = doc.createElement("span");
    time.className = "bookmark-time";
    time.textContent = formatTimestamp(bookmark.timestampMs);
    const label = doc.createElement("span");
    label.className = "bookmark-label";
    label.textContent = entryLabel(itemIndex, items[itemIndex]?.id);
    meta.append(time, label);
    entry.appendChild(meta);
    return entry;
  }

  // The records behind the rows currently rendered, so a click restores
  // the FULL bookmark (ctx and all), not just the position it points at.
  let shown: readonly BookmarkSummary[] = [];
  // Set by `open`: the next render is the opening fill, scrolled to the
  // newest card rather than kept where a previous list was.
  let opening = false;

  // One listener for the whole panel: an entry click picks and closes; a
  // click anywhere outside the scroll list is backdrop and only closes.
  // Clicks inside the list but between entries are left alone — that area
  // is scroll/scrollbar territory, and closing there would fight the scroll.
  panel.addEventListener("click", (event) => {
    const target = event.target;
    const entry =
      target instanceof Element ? target.closest(".bookmark-entry") : null;
    if (entry !== null) {
      const position = Number(entry.getAttribute("data-entry-index"));
      const record =
        Number.isInteger(position) && position >= 0
          ? shown[position]
          : undefined;
      // The "x" deletes and never opens: the panel stays up and the caller
      // re-renders it from what storage holds after the delete.
      if (
        target instanceof Element &&
        target.closest("[data-bookmark-delete]") !== null
      ) {
        if (record !== undefined) onDelete(record);
        return;
      }
      // The caller closes the panel as the restore lands (`onPick`), so
      // the old screen never shows between the two.
      if (record !== undefined) onPick(record);
      else close();
      return;
    }
    if (target instanceof Element && list.contains(target)) return;
    close();
  });

  function clearRows(): void {
    observer?.disconnect();
    pending = new Map();
    rowsByKey.clear();
    queue.length = 0;
    queued.clear();
  }

  function open(): void {
    clearRows();
    shown = [];
    list.replaceChildren();
    list.hidden = false;
    empty.hidden = true;
    panel.hidden = false;
    opening = true;
  }

  function render(bookmarks: readonly BookmarkSummary[]): void {
    const fresh = panel.hidden || opening;
    opening = false;
    const previousScroll = list.scrollTop;
    const ordered = listOrder(bookmarks, items);
    shown = ordered;
    clearRows();
    for (const row of ordered) rowsByKey.set(row.key, row);
    list.replaceChildren(
      ...ordered.map((bookmark, position) => entryElement(bookmark, position)),
    );
    list.hidden = ordered.length === 0;
    empty.hidden = ordered.length !== 0;
    panel.hidden = false;
    // After the entries are in the DOM, so scrollHeight counts them: the
    // newest entry is what the reader sees first (README `t` bullet). A
    // re-render of the open list (a delete) keeps the reader's place.
    list.scrollTop = fresh
      ? bottomScrollTop(list.scrollHeight, list.clientHeight)
      : keptScrollTop(previousScroll, list.scrollHeight, list.clientHeight);
    if (fresh) pinned = true;
    // Then the pictures, newest first (the list opens on the newest); the
    // observer moves whatever is in view to the front of the queue.
    for (const key of thumbLoadOrder([...pending.keys()])) request(key);
    if (observer !== null) {
      for (const slot of pending.values()) observer.observe(slot);
    }
  }

  function close(): void {
    panel.hidden = true;
    opening = false;
    pinned = false;
    clearRows();
  }

  return {
    isOpen() {
      return !panel.hidden;
    },
    open,
    render,
    close,
  };
}
