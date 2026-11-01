// The `t` bookmark overlay (docs/plan.md Phase 8, README `t` bullet): a
// full-screen panel holding the bookmark list, rendered OLDEST-first at the
// top down to the NEWEST at the bottom, auto-scrolled to the bottom so the
// most recent thumbnail is the one visible. Clicking an entry closes the
// panel and continues the novel from that time point (`machine.goTo`); a
// click anywhere else on the panel is backdrop and only closes it.
//
// Every decision (entry order, thumbnail source, timestamp text, the
// scroll-to-bottom target) is a pure export below; the DOM part only
// applies them. Entries render in the order the Storage contract gives —
// oldest first (insertion order, `storage/types.ts`) — so "top to bottom,
// newest at the bottom" IS that order, and the list scrolls to its bottom.

import { visualIndexFor } from "../machine/machine";
import type { Item, MachineContext } from "../machine/types";
import type { Bookmark } from "../storage/types";

/** The panel's message when the novel has no bookmarks yet. */
export const EMPTY_MESSAGE = "No bookmarks yet — press b";

/**
 * What an entry click asks the player to do: the item to re-open, plus
 * the route-play context captured with the bookmark (Phase 13) — with a
 * `ctx` the restore is `machine.importContext(ctx)` (the arrival lands
 * inside that route context); without one — every bookmark saved before
 * routes existed — it is the plain itemIndex navigation (a fresh
 * navigation with no route frames). Pure: the restore wiring applies it.
 */
export interface BookmarkRestore {
  readonly itemIndex: number;
  readonly ctx?: MachineContext;
}

export function bookmarkRestoreTarget(record: Bookmark): BookmarkRestore {
  // The bookmarked ITEM is the time point. Wheel scrubbing does not move the
  // reading position (docs/plan.md Phase 18), so a bookmark taken after
  // scrolling back has a ctx whose `lastShown` is further on; the restore
  // lands on `itemIndex` (and makes it the reading position).
  return record.ctx === undefined
    ? { itemIndex: record.itemIndex }
    : {
        itemIndex: record.itemIndex,
        ctx: { ...record.ctx, lastShown: record.itemIndex },
      };
}

/**
 * The list's render order: the storage order, oldest first, copied so a
 * later mutation of the caller's array cannot restyle the open panel. This
 * function is where the storage contract ("oldest first, never re-sorted
 * by clock") becomes the visual contract ("oldest at the top").
 */
export function listOrder(bookmarks: readonly Bookmark[]): Bookmark[] {
  return bookmarks.map((bookmark) => ({ ...bookmark }));
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
 * `machine.visualIndex()`. Null when nothing resolvable exists (an index
 * outside the manifest).
 */
export function entryThumbSrc(
  bookmark: Bookmark,
  items: readonly Item[],
): string | null {
  const dataUrl = bookmark.thumbDataUrl;
  if (typeof dataUrl === "string" && dataUrl !== "") return dataUrl;
  const visualIndex = visualIndexFor(items, bookmark.itemIndex);
  const item: Item | undefined = items[visualIndex];
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
   * — `bookmarkRestoreTarget` decides between ctx restore and the legacy
   * itemIndex navigation.
   */
  onPick(target: BookmarkRestore): void;
}

export function mountBookmarkOverlay({
  root,
  items,
  onPick,
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
  hint.textContent = "click an entry to continue there · t or Esc closes";

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
    entry.setAttribute("data-item-index", String(bookmark.itemIndex));
    // Which record of the last-rendered list this row is: the click
    // resolves the full bookmark through it, so the restore can carry the
    // record's ctx (Phase 13) rather than just its itemIndex.
    entry.setAttribute("data-entry-index", String(position));

    const src = entryThumbSrc(bookmark, items);
    if (src !== null) {
      const thumb = doc.createElement("img");
      thumb.className = "bookmark-thumb";
      thumb.src = src; // relative to the page: the content folder's own file
      thumb.alt = "";
      entry.appendChild(thumb);
    } else {
      const placeholder = doc.createElement("span");
      placeholder.className = "bookmark-thumb bookmark-thumb-empty";
      entry.appendChild(placeholder);
    }

    const meta = doc.createElement("span");
    meta.className = "bookmark-meta";
    const time = doc.createElement("span");
    time.className = "bookmark-time";
    time.textContent = formatTimestamp(bookmark.timestampMs);
    const label = doc.createElement("span");
    label.className = "bookmark-label";
    label.textContent = entryLabel(
      bookmark.itemIndex,
      items[bookmark.itemIndex]?.id,
    );
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
      close();
      if (record !== undefined) onPick(bookmarkRestoreTarget(record));
      return;
    }
    if (target instanceof Element && list.contains(target)) return;
    close();
  });

  function render(bookmarks: readonly Bookmark[]): void {
    const ordered = listOrder(bookmarks);
    shown = ordered;
    list.replaceChildren(
      ...ordered.map((bookmark, position) => entryElement(bookmark, position)),
    );
    list.hidden = ordered.length === 0;
    empty.hidden = ordered.length !== 0;
    panel.hidden = false;
    // After the entries are in the DOM, so scrollHeight counts them: the
    // newest entry is what the reader sees first (README `t` bullet).
    list.scrollTop = bottomScrollTop(list.scrollHeight, list.clientHeight);
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
