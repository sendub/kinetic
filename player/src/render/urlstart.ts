// Opening at an item from the URL (docs/plan.md Phase 46, item 3):
// `index.html#start=<id>` opens the game at item `<id>` for this load, so a
// creator, or the testing library, can check late content without walking
// everything before it. main.ts hands the item's position to the machine
// (`MachineOptions.startAt`), which enters it as `u` does. The hash is
// removed as it is read, keeping the path and query, so a reload resumes the
// saved place; an id the manifest lacks opens the game as usual with one
// console warning. Any other hash is not this module's and is left alone.

import type { Item } from "../machine/types";

const PREFIX = "#start=";

/** A `#start=` request: the decoded id and its position, -1 when unknown. */
export interface UrlStart {
  id: string;
  index: number;
}

/** The parts of `window` the start reads and changes. */
export interface UrlStartPage {
  location: Pick<Location, "hash" | "pathname" | "search">;
  history: { state: unknown; replaceState: History["replaceState"] };
}

/**
 * The start a URL hash asks for, or null when the hash is not a
 * `#start=<id>` request (none, another hash, no id). The id is
 * URL-decoded; one that does not decode, or that no item has, is an
 * unknown start (`index` -1), named as written.
 */
export function parseUrlStart(
  hash: string,
  items: readonly Item[],
): UrlStart | null {
  if (!hash.startsWith(PREFIX) || hash.length === PREFIX.length) return null;
  const raw = hash.slice(PREFIX.length);
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return { id: raw, index: -1 };
  }
  return { id, index: items.findIndex((item) => item.id === id) };
}

/**
 * Reads the page's `#start=` request (`parseUrlStart`) and consumes it:
 * the hash goes (`history.replaceState`, same path and query, history
 * state kept), and an unknown id gets one console warning. A history that
 * refuses the change leaves the hash, which only means a reload starts
 * there again. Null, with nothing changed, when there is no request.
 */
export function takeUrlStart(
  page: UrlStartPage,
  items: readonly Item[],
): UrlStart | null {
  const start = parseUrlStart(page.location.hash, items);
  if (start === null) return null;
  try {
    page.history.replaceState(
      page.history.state,
      "",
      page.location.pathname + page.location.search,
    );
  } catch {
    // Kept hash: a reload opens at the item again instead of resuming.
  }
  if (start.index < 0) {
    console.warn(
      `[kinetic] #start: no item "${start.id}" in this game; opening as usual`,
    );
  }
  return start;
}
