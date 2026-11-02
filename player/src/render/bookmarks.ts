// The `t` bookmark overlay (docs/plan.md Phase 8, README `t` bullet): a
// full-screen panel holding the bookmark list, rendered OLDEST-first at the
// top down to the NEWEST at the bottom, auto-scrolled to the bottom so the
// most recent thumbnail is the one visible. Clicking an entry closes the
// panel and continues the novel from that time point (`machine.importContext`); a
// click anywhere else on the panel is backdrop and only closes it. Each
// thumbnail carries an "x" in its top-right corner (docs/plan.md Phase 18,
// "Delete a bookmark"): clicking it deletes that bookmark — storage
// included — without opening it, and the list re-renders in place.
//
// Every decision (entry order, thumbnail source, timestamp text, the
// scroll-to-bottom target) is a pure export below; the DOM part only
// applies them. Entries render in the order the Storage contract gives —
// oldest first (insertion order, `storage/types.ts`) — so "top to bottom,
// newest at the bottom" IS that order, and the list scrolls to its bottom.
//
// A bookmark names its item by id (docs/plan.md Phase 18, "Saves keyed by
// id, not position"): the row resolves it to wherever that item sits in
// the manifest being played, and a bookmark whose item is no longer in it
// is simply not listed — there is nothing left to show or restore.

import { visualIndexFor } from "../machine/machine";
import type { Item, MachineContext } from "../machine/types";
import type { Bookmark, SavedContext } from "../storage/types";

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
    ctx: { ...bookmarkContext(record.ctx), lastShown: record.itemId },
  };
}

/**
 * The context a bookmark stores: the context without its reading history
 * (docs/plan.md, "History rollback spec"). A bookmark restore is a jump
 * that appends to the CURRENT history, so the record would only be dead
 * weight — up to `HISTORY_CAP` entries in every bookmark.
 */
export function bookmarkContext<T extends MachineContext | SavedContext>(
  context: T,
): Omit<T, "history" | "historyPos"> {
  const { history: _history, historyPos: _historyPos, ...rest } = context;
  return rest;
}

/**
 * A bookmark restore never forgets progress (docs/plan.md Phase 18): the
 * landing and route frames come from the bookmark, but the seen set and the
 * played / completed routes are the UNION of the bookmark's and the
 * reader's current ones, so opening an old bookmark cannot make content
 * read since then count as unseen again. The played-this-pass record is
 * NOT merged: it is the bookmark's own, so the route flow (play-all's next
 * pick, re-offer or close) continues as of the bookmark (docs/plan.md
 * Phase 22).
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
  };
}

/** Where a bookmark's item now sits in `items`; -1 when it is gone. */
export function bookmarkItemIndex(
  bookmark: Bookmark,
  items: readonly Item[],
): number {
  return items.findIndex((item) => item.id === bookmark.itemId);
}

/**
 * The list's render order: the storage order, oldest first, copied so a
 * later mutation of the caller's array cannot restyle the open panel —
 * minus every bookmark whose item `items` no longer holds. This function
 * is where the storage contract ("oldest first, never re-sorted by
 * clock") becomes the visual contract ("oldest at the top").
 */
export function listOrder(
  bookmarks: readonly Bookmark[],
  items: readonly Item[],
): Bookmark[] {
  return bookmarks
    .filter((bookmark) => bookmarkItemIndex(bookmark, items) >= 0)
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
  bookmark: Bookmark,
  items: readonly Item[],
): string | null {
  const dataUrl = bookmark.thumbDataUrl;
  if (typeof dataUrl === "string" && dataUrl !== "") return dataUrl;
  const index = bookmarkItemIndex(bookmark, items);
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

export interface BookmarkOverlay {
  isOpen(): boolean;
  /** Fills the list, shows the panel, and scrolls it to the bottom. */
  render(bookmarks: readonly Bookmark[]): void;
  close(): void;
}

export interface BookmarkOverlayOptions {
  /** The `#app` element; the panel is its sibling above stage and overlay. */
  root: HTMLElement;
  /** The manifest, for thumbnails derived from item stills. */
  items: readonly Item[];
  /**
   * An entry was clicked: the caller restores what the bookmark recorded
   * — `bookmarkRestoreTarget`: its context, landing on its item.
   */
  onPick(target: BookmarkRestore): void;
  /**
   * A thumbnail's "x" was clicked: the caller deletes this bookmark from
   * storage and re-renders the list (the panel stays open).
   */
  onDelete(bookmark: Bookmark): void;
}

export function mountBookmarkOverlay({
  root,
  items,
  onPick,
  onDelete,
}: BookmarkOverlayOptions): BookmarkOverlay {
  const doc = root.ownerDocument;

  const panel = doc.createElement("div");
  panel.id = "bookmarks";
  panel.className = "bookmarks";
  panel.hidden = true; // `t` opens; Escape, backdrop or an entry click closes

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

  function entryElement(bookmark: Bookmark, position: number): HTMLElement {
    const entry = doc.createElement("button");
    entry.className = "bookmark-entry";
    entry.type = "button";
    const itemIndex = bookmarkItemIndex(bookmark, items);
    entry.setAttribute("data-item-index", String(itemIndex));
    entry.setAttribute("data-item-id", bookmark.itemId);
    // Which record of the last-rendered list this row is: the click
    // resolves the full bookmark through it, so the restore can carry the
    // record's ctx (Phase 13) rather than just its item.
    entry.setAttribute("data-entry-index", String(position));

    // The thumbnail sits in a positioned box so the "x" can take its
    // top-right corner. The "x" is a span with a button role, not a
    // <button>: it lives inside the entry's button, which cannot nest one.
    const thumbBox = doc.createElement("span");
    thumbBox.className = "bookmark-thumb-box";
    const src = entryThumbSrc(bookmark, items);
    if (src !== null) {
      const thumb = doc.createElement("img");
      thumb.className = "bookmark-thumb";
      thumb.src = src; // relative to the page: the content folder's own file
      thumb.alt = "";
      thumbBox.appendChild(thumb);
    } else {
      const placeholder = doc.createElement("span");
      placeholder.className = "bookmark-thumb bookmark-thumb-empty";
      thumbBox.appendChild(placeholder);
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
  let shown: readonly Bookmark[] = [];

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
      close();
      if (record !== undefined) onPick(bookmarkRestoreTarget(record));
      return;
    }
    if (target instanceof Element && list.contains(target)) return;
    close();
  });

  function render(bookmarks: readonly Bookmark[]): void {
    const wasOpen = !panel.hidden;
    const previousScroll = list.scrollTop;
    const ordered = listOrder(bookmarks, items);
    shown = ordered;
    list.replaceChildren(
      ...ordered.map((bookmark, position) => entryElement(bookmark, position)),
    );
    list.hidden = ordered.length === 0;
    empty.hidden = ordered.length !== 0;
    panel.hidden = false;
    // After the entries are in the DOM, so scrollHeight counts them: the
    // newest entry is what the reader sees first (README `t` bullet). A
    // re-render of the open list (a delete) keeps the reader's place.
    list.scrollTop = wasOpen
      ? keptScrollTop(previousScroll, list.scrollHeight, list.clientHeight)
      : bottomScrollTop(list.scrollHeight, list.clientHeight);
  }

  function close(): void {
    panel.hidden = true;
  }

  return {
    isOpen() {
      return !panel.hidden;
    },
    render,
    close,
  };
}
