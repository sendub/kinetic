// The bookmark cards' pure rules on the branch map (docs/plan.md Phase 35):
// which bookmark is the newest, the order their pictures load in, and the
// delete / undo record of one open. No DOM: render/branchmap.ts applies
// them; where each card sits is mapmodel.ts `cardSlots`.

/**
 * The newest bookmark's id: the latest `timestampMs`, the later in the
 * list on a tie (storage order is oldest first). Null for none. An undone
 * delete puts a bookmark back at the end of the stored list, so the clock,
 * not the list position, says which is newest.
 */
export function newestBookmarkId(
  rows: readonly { readonly id: string; readonly timestampMs: number }[],
): string | null {
  let best: { id: string; timestampMs: number } | null = null;
  for (const row of rows)
    if (best === null || row.timestampMs >= best.timestampMs) best = row;
  return best?.id ?? null;
}

/** How many card pictures are read or shrunk at once. */
export const PICTURE_LOADS_AT_ONCE = 4;

/**
 * The order card pictures load in: the cards in or near the view (within
 * half a view of it) first, nearest the view's centre first, so what the
 * reader looks at fills in at once; then every other card newest first,
 * as the old `t` screen did. Pure.
 */
export function pictureOrder<
  T extends {
    readonly timestampMs: number;
    readonly cx: number;
    readonly cy: number;
  },
>(
  cards: readonly T[],
  seen: { x0: number; y0: number; x1: number; y1: number },
): T[] {
  const w = (seen.x1 - seen.x0) / 2;
  const h = (seen.y1 - seen.y0) / 2;
  const mx = (seen.x0 + seen.x1) / 2;
  const my = (seen.y0 + seen.y1) / 2;
  const near = (c: T) =>
    c.cx >= seen.x0 - w &&
    c.cx <= seen.x1 + w &&
    c.cy >= seen.y0 - h &&
    c.cy <= seen.y1 + h;
  const inView = cards.filter(near);
  const rest = cards.filter((c) => !near(c));
  inView.sort(
    (a, b) =>
      Math.hypot(a.cx - mx, a.cy - my) - Math.hypot(b.cx - mx, b.cy - my),
  );
  rest.sort((a, b) => b.timestampMs - a.timestampMs);
  return [...inView, ...rest];
}

/**
 * The bookmarks deleted while the map is open, by id, oldest delete first.
 * Each stays on the map as a ghost with an Undo until the map closes; Z
 * undoes the latest delete still standing, and again the one before.
 */
export type Deletions = readonly string[];

export const NO_DELETIONS: Deletions = [];

/** `deletions` with `id` deleted last (no change when already deleted). */
export function withDeleted(deletions: Deletions, id: string): Deletions {
  return deletions.includes(id) ? deletions : [...deletions, id];
}

/** `deletions` with `id` put back (no change when it was not deleted). */
export function withRestored(deletions: Deletions, id: string): Deletions {
  return deletions.filter((d) => d !== id);
}

/** The delete Z undoes: the latest one still standing, or null. */
export function latestDeleted(deletions: Deletions): string | null {
  return deletions.length === 0 ? null : deletions[deletions.length - 1];
}
