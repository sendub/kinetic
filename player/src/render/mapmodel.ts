// The branch map's pure half (docs/plan.md Phase 31): the decision tree laid
// out once per manifest, the reader's marks laid over it on each open, the
// view arithmetic of zoom and pan, and the click-to-jump rule. No DOM: the
// screen (render/branchmap.ts) only draws what these return.
//
// Layout, a "subway map": the story runs left to right along a line. A
// stretch of screens with no decision is ONE edge with its screen count. A
// decision is a box; its routes stack downward from the decision's own row,
// each a pill followed by the route's own line (nested decisions included,
// recursively), so a route that holds a nested decision is as tall as that
// decision's routes. Routes that continue (the continuing route, and every
// `continue` route) or return meet at a join on the decision's row, and the
// line carries on from there: at `continueAt` for a decision with a
// continuing route, past the whole menu region for a pure choice (the
// machine's own flow, docs/content-format.md "Branches"). An ending route
// stops in an end mark.
//
// Two rules keep a large game screen-shaped and its connectors short:
//
// - Rows like lines of text. The main line is cut into top-level SEGMENTS
//   (the stretch before a top-level decision plus that decision's whole
//   subtree; a decision is never split), and the segments fill rows left to
//   right, then down. The row width is the one whose whole layout comes
//   closest to the viewport's aspect, so a fit fills the screen. A
//   continuation connector runs from each row's end, through the gap under
//   it, back to the next row's start.
// - Endings tuck in. Everything a route nests lies right of its nested
//   decision's box, so the column under a tall route's pill is empty. An
//   ending route (it draws no line to the join) goes on the first row under
//   its decision where it fits in that empty column, instead of under the
//   tallest sibling. Every pill shows its choice number, so the order
//   stays legible either way.
//
// Bookmarks ride on the lines (docs/plan.md Phase 35): each bookmark's card
// sits centred on the line at its screen's place, like beads on a string,
// in story order. A stretch holding bookmarks is as long as its cards side
// by side, and every line holding cards gets the vertical room they need
// (`CARD_ABOVE`, `CARD_BELOW`); stretches without bookmarks keep the
// compact geometry.
//
// Every position is computed once, from the resolved decision table the
// machine itself uses (`resolveDecisions`), so map indices ARE machine
// indices; the cost is linear in decisions and routes (times nesting depth
// for the tuck shifts), never in items, whatever the game's size.

import {
  joinsAtContinue,
  type ResolvedDecision,
  resolveDecisions,
} from "../machine/machine";
import type { Branch, ContextFrame, Item, RouteSet } from "../machine/types";
import type { SavedMapView } from "../storage/types";

export type { SavedMapView };

/**
 * Geometry in world units (CSS pixels at zoom 1). Compact (docs/plan.md
 * Phase 35; a size up in Phase 40, the figures 13 px in index.html): at
 * 100% a world unit is a screen pixel sized by the bookmark cards, so a
 * decision is a small "played/total" node and a route a numbered pill;
 * their full text is in the hover tooltip.
 */
export const MAP_GEOMETRY = {
  pad: 40,
  rowH: 42,
  runW: 44,
  decW: 52,
  decH: 28,
  routeW: 32,
  routeH: 24,
  gap: 22,
  /** Space between wrapped rows, which the continuation connector runs through. */
  wrapGap: 40,
} as const;

/**
 * A bookmark's card (Phase 35), world units: at 100% zoom the old `t`
 * screen's thumbnail, 280 x 158, and nothing else (Phase 40: no caption;
 * its time is in the hover tooltip and its label). Cards sit centred on
 * their stretch's line, side by side in story order, `gap` apart, `inset`
 * in from the stretch's ends.
 */
export const CARD = {
  w: 280,
  h: 158,
  thumbH: 158,
  gap: 10,
  pitch: 290,
  inset: 14,
} as const;

/**
 * The room a line holding cards gets: above it, half a card and a margin;
 * below it, half a card, a margin and the stretch's count line under the
 * cards.
 */
export const CARD_ABOVE = CARD.h / 2 + 10;
export const CARD_BELOW = CARD.h / 2 + 24;
/** Where a carded stretch's count line sits, below its line. */
export const CARD_COUNT_DY = CARD.h / 2 + 15;

/** How far right of a line's end its end mark reaches. */
const END_REACH = 17;
/** How far right of a line's end its end mark's centre sits. */
const END_MARK_DX = 10;

/** The aspect (width / height) a layout aims for when none is given. */
export const DEFAULT_MAP_ASPECT = 16 / 9;

/** One collapsed stretch of screens between decisions. */
export interface MapRun {
  /** First and last item index of the stretch, inclusive. */
  readonly start: number;
  readonly end: number;
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
  /**
   * The item indices of the bookmarks drawn on this stretch, ascending
   * (one per bookmark: two on one screen appear twice). Empty: the compact
   * `runW` stretch; else it is as long as its cards side by side.
   */
  readonly bookmarks: readonly number[];
}

/** One decision node. `index` is the machine's resolved-table position. */
export interface MapDecision {
  readonly index: number;
  readonly prompt: string;
  readonly afterIndex: number;
  /** Left edge and row centre of the node box. */
  readonly x: number;
  readonly y: number;
  /** Positions in `MapModel.routes` of this decision's routes, in order. */
  readonly routes: readonly number[];
}

/** One connector's SVG path data, its kind and its bounding box. */
export interface MapLink {
  readonly kind: "branch" | "join" | "return" | "wrap";
  readonly d: string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * How a route's span ends (docs/content-format.md, "Branches"):
 * `continues` for the continuing route and a `continue` route (both join
 * at `continueAt`), `returns` for a `return` route, `ends` otherwise.
 */
export type RouteOutcome = "continues" | "returns" | "ends";

/** One route pill and the line after it. */
export interface MapRoute {
  readonly decision: number;
  /** Index into the decision's routes: what `choose()` takes. */
  readonly route: number;
  readonly label: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly outcome: RouteOutcome;
  /** Left edge and row centre of the pill. */
  readonly x: number;
  readonly y: number;
  /** Where the route's own line ends. */
  readonly endX: number;
}

export interface MapModel {
  readonly runs: readonly MapRun[];
  readonly decisions: readonly MapDecision[];
  readonly routes: readonly MapRoute[];
  /**
   * The connectors, each with its bounding box (for culling): decision ->
   * route pill curves (`branch`), continuing and `continue` routes into
   * their join (`join`), returning routes back towards it (`return`), and a
   * row's end to the next row's start (`wrap`).
   */
  readonly links: readonly MapLink[];
  /** Join dots and end marks, world points. */
  readonly joins: readonly { x: number; y: number }[];
  readonly ends: readonly { x: number; y: number }[];
  /** Where the story starts (a dot). */
  readonly start: { x: number; y: number };
  /** The main line's end mark, when the main line ends in a run (else null). */
  readonly storyEnd: { x: number; y: number } | null;
  /**
   * The world box everything drawn lies in (boxes, lines, end marks, screen
   * counts), without the layout's padding: what Fit fills the view with.
   */
  readonly bounds: { x0: number; y0: number; x1: number; y1: number };
  readonly width: number;
  readonly height: number;
  /** How many rows the main line wraps into (1: no wrap). */
  readonly rows: number;
  readonly itemCount: number;
  /**
   * Decision nodes by machine index (`undefined` for a decision the layout
   * could not place: one whose `after` lies where no story line reaches).
   */
  readonly decisionAt: readonly (MapDecision | undefined)[];
  /** Decision index by decision id (the choice view names it by id). */
  readonly decisionById: ReadonlyMap<string, number>;
}

function regionEndOf(decision: ResolvedDecision): number {
  let end = -1;
  for (const route of decision.routes)
    if (route.endIndex > end) end = route.endIndex;
  return end;
}

/** Where a decision's line carries on after it (the machine's flow). */
function continuationOf(decision: ResolvedDecision): number {
  return decision.continuingRoute >= 0
    ? decision.continueAt
    : regionEndOf(decision) + 1;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * A connector before its path data is written: a branch curve from (ax, ay)
 * to (bx, by), or a route's line from its end (ax, ay) along its row to the
 * join column bx, then up to the decision's row by. Kept as numbers so a
 * block laid out once can be moved (tucked in, wrapped) by adding offsets.
 */
interface RawLink {
  kind: "branch" | "join" | "return";
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

function linkOf(raw: RawLink): MapLink {
  const { kind, ax, ay, bx, by } = raw;
  if (kind === "branch") {
    const midX = (ax + bx) / 2;
    return {
      kind,
      d: `M${ax} ${ay}C${midX} ${ay} ${midX} ${by} ${bx} ${by}`,
      x0: ax,
      y0: Math.min(ay, by),
      x1: bx,
      y1: Math.max(ay, by),
    };
  }
  const r = Math.min(24, ay - by);
  const d =
    ay === by
      ? `M${ax} ${ay}H${bx}`
      : `M${ax} ${ay}H${bx - r}Q${bx} ${ay} ${bx} ${ay - r}V${by}`;
  return { kind, d, x0: ax, y0: by, x1: bx, y1: ay };
}

/** One placed block's extent: its line's end, rows, and what lies below. */
interface Block {
  /** Where the block's line ends (its right edge). */
  x: number;
  /** Rows it takes, its own included. */
  rows: number;
  /**
   * The leftmost x of anything it draws below its own row (Infinity when
   * it is one row): its first nested decision box's right edge, where that
   * decision's branch curves start.
   */
  belowLeft: number;
}

/**
 * The rows to wrap segments of widths `widths` into: as many as fit
 * `limit` each, in order, at least one per row.
 */
function packRows(widths: readonly number[], limit: number): number[][] {
  const rows: number[][] = [];
  let current: number[] = [];
  let used = 0;
  widths.forEach((w, i) => {
    if (current.length > 0 && used + w > limit) {
      rows.push(current);
      current = [];
      used = 0;
    }
    current.push(i);
    used += w;
  });
  if (current.length > 0) rows.push(current);
  return rows;
}

/** A top-level segment as the wrapping sees it. */
export interface SegmentShape {
  readonly width: number;
  /** Rows it takes (lines under its own, nested decisions' routes). */
  readonly rows: number;
  /** Per row (0: its own), whether a line there holds bookmark cards. */
  readonly bands?: readonly boolean[];
}

/**
 * How a segment's rows spread apart to make room for its cards: each row's
 * downward offset (`off[r]`, row 0 none) and the segment's height from its
 * row 0's top (row 0's own room above, shared across a wrapped row, not
 * included). A segment without cards is `rows * rowH` tall, unmoved.
 */
export function bandOffsets(segment: SegmentShape): {
  off: number[];
  height: number;
} {
  const g = MAP_GEOMETRY;
  const bands = segment.bands ?? [];
  const off = [0];
  for (let r = 1; r < segment.rows; r += 1)
    off.push(
      off[r - 1] +
        (bands[r - 1] === true ? CARD_BELOW : 0) +
        (bands[r] === true ? CARD_ABOVE : 0),
    );
  const last = segment.rows - 1;
  return {
    off,
    height:
      segment.rows * g.rowH +
      off[last] +
      (bands[last] === true ? CARD_BELOW : 0),
  };
}

/** The room above a wrapped row's main line: cards on it need it. */
function aboveOf(
  segments: readonly SegmentShape[],
  row: readonly number[],
): number {
  return row.some((i) => segments[i].bands?.[0] === true) ? CARD_ABOVE : 0;
}

/**
 * Wraps top-level segments (width, rows tall, cards) into lines of text so
 * the whole layout's aspect comes closest to `aspect`: tries row widths
 * from the widest segment to everything on one row, geometrically spaced.
 */
export function wrapSegments(
  segments: readonly SegmentShape[],
  aspect: number,
): number[][] {
  const g = MAP_GEOMETRY;
  const widths = segments.map((s) => s.width);
  if (segments.length <= 1) return [segments.map((_, i) => i)];
  const total = widths.reduce((a, b) => a + b, 0);
  const widest = Math.max(...widths);
  const shapeOf = (rows: number[][]) => {
    let w = 0;
    let h = 2 * g.pad + (rows.length - 1) * g.wrapGap;
    for (const row of rows) {
      let rw = 0;
      let rh: number = g.rowH;
      for (const i of row) {
        rw += widths[i];
        rh = Math.max(rh, bandOffsets(segments[i]).height);
      }
      w = Math.max(w, rw);
      h += aboveOf(segments, row) + rh;
    }
    return (w + 2 * g.pad + 40) / h;
  };
  const steps = 48;
  let best = packRows(widths, total);
  let bestMiss = Math.abs(Math.log(shapeOf(best) / aspect));
  for (let i = 0; i < steps; i += 1) {
    const limit = widest * (total / widest) ** (i / steps);
    const rows = packRows(widths, limit);
    const miss = Math.abs(Math.log(shapeOf(rows) / aspect));
    if (miss < bestMiss - 1e-9) {
      best = rows;
      bestMiss = miss;
    }
  }
  return best;
}

/**
 * Lays the decision tree out, with a card's room for each bookmarked item
 * in `bookmarkItems` (item indices; one per bookmark, so a screen
 * bookmarked twice is listed twice). Pure; call once per manifest, viewport
 * shape (`aspect`, the map view's width / height: the rows wrap to it) and
 * set of bookmarked screens.
 *
 * A bookmark sits on the stretch holding its screen. A screen no stretch
 * holds (say, one between a choice's routes that no route covers) goes at
 * the end of the stretch `runAt` names for it, the nearest one before it,
 * as the "you are here" marker does: never dropped from the map.
 */
export function buildMapModel(
  items: readonly Item[],
  branches: readonly Branch[] | undefined,
  aspect: number = DEFAULT_MAP_ASPECT,
  bookmarkItems: readonly number[] = [],
): MapModel {
  const valid = bookmarkItems.filter(
    (i) => Number.isInteger(i) && i >= 0 && i < items.length,
  );
  const model = layOutMap(items, branches, aspect, valid);
  // Stretches never depend on the bookmarks (only their lengths do), so
  // a second pass with the stray screens moved onto a stretch's last one
  // gives the same stretches; it runs only when there is a stray.
  const held = (i: number) => {
    const run = runAt(model.runs, i);
    return run !== undefined && i >= run.start && i <= run.end;
  };
  if (valid.every(held)) return model;
  return layOutMap(
    items,
    branches,
    aspect,
    valid.map((i) => {
      if (held(i)) return i;
      const run = runAt(model.runs, i);
      if (run === undefined) return i;
      return i < run.start ? run.start : run.end;
    }),
  );
}

function layOutMap(
  items: readonly Item[],
  branches: readonly Branch[] | undefined,
  aspect: number,
  bookmarkItems: readonly number[],
): MapModel {
  const g = MAP_GEOMETRY;
  // The bookmarks' item indices, ascending: a stretch takes the ones in its
  // range (binary search), so the cost stays linear in stretches.
  const marked = [...bookmarkItems].sort((a, b) => a - b);
  const firstAtOrAfter = (index: number) => {
    let lo = 0;
    let hi = marked.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (marked[mid] < index) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const decisions = resolveDecisions(items, branches ?? []);
  const children = new Map<number, ResolvedDecision[]>();
  for (const decision of decisions) {
    const list = children.get(decision.parent) ?? [];
    list.push(decision);
    children.set(decision.parent, list);
  }
  for (const list of children.values())
    list.sort((a, b) => a.afterIndex - b.afterIndex);

  const runs: Mutable<MapRun>[] = [];
  const mapDecisions: Mutable<MapDecision>[] = [];
  const routes: Mutable<MapRoute>[] = [];
  const raw: RawLink[] = [];
  const joins: { x: number; y: number }[] = [];
  const ends: { x: number; y: number }[] = [];
  const placed = new Set<number>();

  // Everything is laid out where its block starts and then moved as a
  // block: `mark` notes how much of each list exists, `shift` moves what
  // was added between two marks.
  type Mark = readonly number[];
  const mark = (): Mark => [
    runs.length,
    mapDecisions.length,
    routes.length,
    raw.length,
    joins.length,
    ends.length,
  ];
  function shift(from: Mark, to: Mark, dx: number, dy: number): void {
    for (let i = from[0]; i < to[0]; i += 1) {
      runs[i].x0 += dx;
      runs[i].x1 += dx;
      runs[i].y += dy;
    }
    for (let i = from[1]; i < to[1]; i += 1) {
      mapDecisions[i].x += dx;
      mapDecisions[i].y += dy;
    }
    for (let i = from[2]; i < to[2]; i += 1) {
      routes[i].x += dx;
      routes[i].endX += dx;
      routes[i].y += dy;
    }
    for (let i = from[3]; i < to[3]; i += 1) {
      raw[i].ax += dx;
      raw[i].bx += dx;
      raw[i].ay += dy;
      raw[i].by += dy;
    }
    for (let i = from[4]; i < to[4]; i += 1) {
      joins[i].x += dx;
      joins[i].y += dy;
    }
    for (let i = from[5]; i < to[5]; i += 1) {
      ends[i].x += dx;
      ends[i].y += dy;
    }
  }

  const addRun = (start: number, end: number, x: number, y: number) => {
    const bookmarks = marked.slice(
      firstAtOrAfter(start),
      firstAtOrAfter(end + 1),
    );
    const w =
      bookmarks.length === 0
        ? g.runW
        : bookmarks.length * CARD.pitch - CARD.gap + 2 * CARD.inset;
    runs.push({ start, end, x0: x, x1: x + w, y, bookmarks });
    return x + w;
  };

  // One line of story from item `start` to `end` inside decision `parent`'s
  // route, starting at world x, on row centre y.
  function line(
    start: number,
    end: number,
    parent: number,
    x0: number,
    y: number,
  ): Block {
    let x = x0;
    let rows = 1;
    let belowLeft = Number.POSITIVE_INFINITY;
    let idx = start;
    for (const decision of children.get(parent) ?? []) {
      if (decision.afterIndex < idx || decision.afterIndex > end) continue;
      if (placed.has(decision.index)) continue;
      x = addRun(idx, decision.afterIndex, x, y);
      const block = layoutDecision(decision, x, y);
      x = block.x;
      rows = Math.max(rows, block.rows);
      belowLeft = Math.min(belowLeft, block.belowLeft);
      const next = continuationOf(decision);
      if (next <= decision.afterIndex || next > end) {
        idx = end + 1;
        break;
      }
      idx = next;
    }
    if (idx <= end) x = addRun(idx, end, x, y);
    return { x, rows, belowLeft };
  }

  function layoutDecision(
    decision: ResolvedDecision,
    x: number,
    y: number,
  ): Block {
    placed.add(decision.index);
    const routeKeys: number[] = [];
    const bx = x + g.decW + g.gap;
    // Per row under the decision (0: its own), the leftmost x anything
    // placed so far draws there; rows past the end are free.
    const left: number[] = [];
    const occupy = (row: number, from: number) => {
      left[row] = Math.min(left[row] ?? Number.POSITIVE_INFINITY, from);
    };
    const fits = (row: number, rows: number, reach: number) => {
      for (let j = row; j < row + rows; j += 1)
        if ((left[j] ?? Number.POSITIVE_INFINITY) < reach) return false;
      return true;
    };
    let bottom = 0;
    let furthest = bx + g.routeW;
    const pending: { key: number; endX: number; y: number }[] = [];
    decision.routes.forEach((route, routeIdx) => {
      const outcome: RouteOutcome = joinsAtContinue(route)
        ? "continues"
        : route.result === "return"
          ? "returns"
          : "ends";
      // Laid out under everything so far, then, for an ending, moved up
      // to the first row where it clears what is already there.
      const before = mark();
      const inner = line(
        route.startIndex,
        route.endIndex,
        decision.index,
        bx + g.routeW,
        y + bottom * g.rowH,
      );
      let row = bottom;
      if (outcome === "ends" && routeIdx > 0) {
        const reach = inner.x + END_REACH + g.gap;
        for (let r = 1; r < bottom; r += 1)
          if (fits(r, inner.rows, reach)) {
            row = r;
            break;
          }
        if (row !== bottom) shift(before, mark(), 0, (row - bottom) * g.rowH);
      }
      occupy(row, bx);
      for (let j = 1; j < inner.rows; j += 1) occupy(row + j, inner.belowLeft);
      bottom = Math.max(bottom, row + inner.rows);
      const ry = y + row * g.rowH;
      raw.push({ kind: "branch", ax: x + g.decW, ay: y, bx, by: ry });
      const key = routes.length;
      routes.push({
        decision: decision.index,
        route: routeIdx,
        label: route.label,
        startIndex: route.startIndex,
        endIndex: route.endIndex,
        outcome,
        x: bx,
        y: ry,
        endX: inner.x,
      });
      routeKeys.push(key);
      pending.push({ key, endX: inner.x, y: ry });
      if (inner.x > furthest) furthest = inner.x;
    });
    const joinX = furthest + g.gap;
    let joined = false;
    for (const { key, endX, y: routeY } of pending) {
      const route = routes[key];
      if (route.outcome === "ends") {
        ends.push({ x: endX + END_MARK_DX, y: routeY });
        continue;
      }
      joined = true;
      raw.push({
        kind: route.outcome === "continues" ? "join" : "return",
        ax: endX,
        ay: routeY,
        bx: joinX,
        by: y,
      });
    }
    const next = continuationOf(decision);
    if (joined || next > decision.afterIndex) joins.push({ x: joinX, y });
    mapDecisions.push({
      index: decision.index,
      prompt: decision.prompt,
      afterIndex: decision.afterIndex,
      x,
      y,
      routes: routeKeys,
    });
    const rows = Math.max(1, bottom);
    return {
      x: joinX,
      rows,
      belowLeft: rows > 1 ? x + g.decW : Number.POSITIVE_INFINITY,
    };
  }

  // The main line, one top-level segment at a time, each laid out from
  // (0, 0) and then moved to its place in the rows.
  const segments: {
    from: Mark;
    width: number;
    rows: number;
    bands?: boolean[];
  }[] = [];
  const last = items.length - 1;
  let idx = 0;
  for (const decision of children.get(-1) ?? []) {
    if (decision.afterIndex < idx || decision.afterIndex > last) continue;
    if (placed.has(decision.index)) continue;
    const from = mark();
    const x = addRun(idx, decision.afterIndex, 0, 0);
    const block = layoutDecision(decision, x, 0);
    segments.push({ from, width: block.x, rows: block.rows });
    const next = continuationOf(decision);
    if (next <= decision.afterIndex || next > last) {
      idx = last + 1;
      break;
    }
    idx = next;
  }
  // The story's end mark, by position in `ends` (it moves with its segment).
  let storyEndAt = -1;
  if (idx <= last) {
    // The story's tail: a stretch and its end mark, on the last segment.
    const tail = segments[segments.length - 1];
    if (tail === undefined) {
      segments.push({ from: mark(), width: addRun(idx, last, 0, 0), rows: 1 });
    } else tail.width = addRun(idx, last, tail.width, 0);
    const end = segments[segments.length - 1];
    storyEndAt = ends.length;
    ends.push({ x: end.width + END_MARK_DX, y: 0 });
    end.width += END_REACH;
  }

  const done = mark();
  // Which of each segment's rows hold cards (laid out from y 0, its lines
  // sit at whole multiples of rowH).
  const rowOf = (y: number) => Math.round(y / g.rowH);
  segments.forEach((segment, i) => {
    const to = segments[i + 1]?.from ?? done;
    const bands: boolean[] = [];
    for (let k = segment.from[0]; k < to[0]; k += 1)
      if (runs[k].bookmarks.length > 0) bands[rowOf(runs[k].y)] = true;
    segment.bands = bands;
  });
  // Moves a segment's rows apart (still in its own coordinates): row r goes
  // down by off[r], everything on it with it.
  function spread(from: Mark, to: Mark, off: readonly number[]): void {
    const f = (y: number) => y + (off[rowOf(y)] ?? 0);
    for (let i = from[0]; i < to[0]; i += 1) runs[i].y = f(runs[i].y);
    for (let i = from[1]; i < to[1]; i += 1)
      mapDecisions[i].y = f(mapDecisions[i].y);
    for (let i = from[2]; i < to[2]; i += 1) routes[i].y = f(routes[i].y);
    for (let i = from[3]; i < to[3]; i += 1) {
      raw[i].ay = f(raw[i].ay);
      raw[i].by = f(raw[i].by);
    }
    for (let i = from[4]; i < to[4]; i += 1) joins[i].y = f(joins[i].y);
    for (let i = from[5]; i < to[5]; i += 1) ends[i].y = f(ends[i].y);
  }

  const wrapped = wrapSegments(segments, aspect);
  const wraps: MapLink[] = [];
  let top = g.pad;
  let widest = 0;
  let firstY = g.pad + g.rowH / 2;
  let previous: { endX: number; y: number; bottom: number } | null = null;
  for (const row of wrapped) {
    const rowY = top + aboveOf(segments, row) + g.rowH / 2;
    if (previous === null) firstY = rowY;
    let x = g.pad;
    let height: number = g.rowH;
    for (const i of row) {
      const segment = segments[i];
      const to = segments[i + 1]?.from ?? done;
      const shape = bandOffsets(segment);
      spread(segment.from, to, shape.off);
      shift(segment.from, to, x, rowY);
      x += segment.width;
      height = Math.max(height, shape.height);
    }
    if (previous !== null) wraps.push(wrapLink(previous, g.pad, rowY));
    const bottom = rowY - g.rowH / 2 + height;
    previous = { endX: x, y: rowY, bottom };
    widest = Math.max(widest, x);
    top = bottom + g.wrapGap;
  }
  const height = top - g.wrapGap + g.pad;

  mapDecisions.sort((a, b) => a.index - b.index);
  runs.sort((a, b) => a.start - b.start);
  const decisionAt: (MapDecision | undefined)[] = decisions.map(
    () => undefined,
  );
  for (const node of mapDecisions) decisionAt[node.index] = node;
  const decisionById = new Map<string, number>();
  for (const decision of decisions)
    decisionById.set(decision.id, decision.index);
  const links = [...raw.map(linkOf), ...wraps];
  const start = { x: g.pad, y: firstY };
  return {
    runs,
    decisions: mapDecisions,
    routes,
    links,
    joins,
    ends,
    start,
    storyEnd: storyEndAt >= 0 ? ends[storyEndAt] : null,
    bounds: boundsOf(runs, mapDecisions, routes, links, joins, ends, start),
    width: widest + g.pad + 40,
    height,
    rows: Math.max(1, wrapped.length),
    itemCount: items.length,
    decisionAt,
    decisionById,
  };
}

/** Above a stretch's line, its screen count's text reaches this far. */
const COUNT_REACH = 16;

/** The world box everything drawn lies in (see `MapModel.bounds`). */
function boundsOf(
  runs: readonly MapRun[],
  decisions: readonly MapDecision[],
  routes: readonly MapRoute[],
  links: readonly MapLink[],
  joins: readonly { x: number; y: number }[],
  ends: readonly { x: number; y: number }[],
  start: { x: number; y: number },
): { x0: number; y0: number; x1: number; y1: number } {
  const g = MAP_GEOMETRY;
  const box = {
    x0: start.x - 6,
    y0: start.y - 6,
    x1: start.x + 6,
    y1: start.y + 6,
  };
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    if (x0 < box.x0) box.x0 = x0;
    if (y0 < box.y0) box.y0 = y0;
    if (x1 > box.x1) box.x1 = x1;
    if (y1 > box.y1) box.y1 = y1;
  };
  for (const r of runs)
    if (r.bookmarks.length === 0) add(r.x0, r.y - COUNT_REACH, r.x1, r.y);
    else add(r.x0, r.y - CARD.h / 2, r.x1, r.y + CARD_COUNT_DY + 4);
  for (const d of decisions)
    add(d.x, d.y - g.decH / 2, d.x + g.decW, d.y + g.decH / 2);
  for (const r of routes)
    add(r.x, r.y - g.routeH / 2, r.x + g.routeW, r.y + g.routeH / 2);
  for (const l of links) add(l.x0, l.y0, l.x1, l.y1);
  for (const p of joins) add(p.x - 5, p.y - 5, p.x + 5, p.y + 5);
  for (const p of ends) add(p.x - 7, p.y - 7, p.x + 7, p.y + 7);
  return box;
}

/** How far the continuation connector turns outside the rows' ends. */
const WRAP_TURN = 28;
const WRAP_R = 14;

/**
 * The continuation connector from a row's end, out right, down into the
 * gap under that row, back left past the rows' start, and down into the
 * next row's start (`startX`, `y`), with a small arrowhead there.
 */
function wrapLink(
  from: { endX: number; y: number; bottom: number },
  startX: number,
  y: number,
): MapLink {
  const xr = from.endX + WRAP_TURN;
  const xl = startX - WRAP_TURN;
  const ym = from.bottom + MAP_GEOMETRY.wrapGap / 2;
  const r = WRAP_R;
  const d =
    `M${from.endX} ${from.y}H${xr - r}Q${xr} ${from.y} ${xr} ${from.y + r}` +
    `V${ym - r}Q${xr} ${ym} ${xr - r} ${ym}H${xl + r}` +
    `Q${xl} ${ym} ${xl} ${ym + r}V${y - r}Q${xl} ${y} ${xl + r} ${y}H${startX}` +
    `M${startX - 9} ${y - 5}L${startX - 1} ${y}L${startX - 9} ${y + 5}`;
  return { kind: "wrap", d, x0: xl, y0: from.y, x1: xr, y1: y };
}

/** What the reader's state says, as the map needs it. */
export interface MapReader {
  /** Every item index seen (any order). */
  readonly visited: readonly number[];
  /** Routes ever entered, per decision (the choice rows' seen marks). */
  readonly playedRoutes: readonly RouteSet[];
  /** Routes played through to their end, per decision. */
  readonly completedRoutes?: readonly RouteSet[];
  /** The route last picked at each decision (the wheel follows it). */
  readonly lastPicks?: readonly ContextFrame[];
  /** The item on screen. */
  readonly cursor: number;
  /** The decision whose choice screen is up, by id; absent: none. */
  readonly choiceId?: string;
  /**
   * The map's Spoilers toggle (the `mapSpoilers` setting); absent or false:
   * the text of every decision not reached is hidden (`MapMarks.hidden`).
   */
  readonly spoilers?: boolean;
}

/** A route as the reader stands with it. */
export type RouteMark = "unseen" | "partly" | "played";
/** A stretch of screens as the reader stands with it. */
export type RunMark = "unseen" | "partly" | "seen";

export interface MapMarks {
  /** Per decision (by machine index): its `after` item has been seen. */
  readonly reached: readonly boolean[];
  /**
   * Per decision: its question and its routes' labels are new to the
   * reader and Spoilers is off, so the map shows placeholders instead
   * (`promptText`, `routeText`). A decision not reached; nested ones under
   * it are not reached either, so their text is hidden too.
   */
  readonly hidden: readonly boolean[];
  /** Per decision: how many of its routes are played. */
  readonly playedCount: readonly number[];
  /** Per `MapModel.routes` entry. */
  readonly routes: readonly RouteMark[];
  /** Per `MapModel.routes` entry: the last pick at its decision. */
  readonly lastPick: readonly boolean[];
  /** Per `MapModel.runs` entry. */
  readonly runs: readonly RunMark[];
  /** The "you are here" point, in world units. */
  readonly here: { x: number; y: number; decision: number };
}

/**
 * The marks for one reader state. A route is PLAYED once the reader went
 * all the way through it (completed, or entered and its last screen seen),
 * PARTLY seen when they entered it or saw any of its screens, else unseen.
 * A decision is REACHED once its `after` item has been seen: then it and
 * its routes can be jumped to. Linear in runs and routes, plus one pass
 * over the seen set.
 */
export function markMap(model: MapModel, reader: MapReader): MapMarks {
  const count = model.itemCount;
  const seen = new Uint8Array(count);
  for (const index of reader.visited)
    if (index >= 0 && index < count) seen[index] = 1;
  const prefix = new Int32Array(count + 1);
  for (let i = 0; i < count; i += 1) prefix[i + 1] = prefix[i] + seen[i];
  const seenIn = (start: number, end: number) =>
    prefix[end + 1] - prefix[start];

  const setOf = (sets: readonly RouteSet[] | undefined) => {
    const map = new Map<number, Set<number>>();
    for (const set of sets ?? []) map.set(set.decision, new Set(set.routes));
    return map;
  };
  const played = setOf(reader.playedRoutes);
  const completed = setOf(reader.completedRoutes);
  const picks = new Map<number, number>();
  for (const frame of reader.lastPicks ?? [])
    picks.set(frame.decision, frame.route);

  const reached = model.decisionAt.map(
    (d) => d !== undefined && seen[d.afterIndex] === 1,
  );
  const hidden = reached.map((r) => !r && reader.spoilers !== true);
  const playedCount = model.decisionAt.map(() => 0);
  const routes: RouteMark[] = model.routes.map((route) => {
    const entered = played.get(route.decision)?.has(route.route) === true;
    const done =
      completed.get(route.decision)?.has(route.route) === true ||
      (entered && seen[route.endIndex] === 1);
    if (done) {
      playedCount[route.decision] += 1;
      return "played";
    }
    return entered || seenIn(route.startIndex, route.endIndex) > 0
      ? "partly"
      : "unseen";
  });
  const lastPick = model.routes.map(
    (route) => picks.get(route.decision) === route.route,
  );
  const runs: RunMark[] = model.runs.map((run) => {
    const n = seenIn(run.start, run.end);
    if (n === 0) return "unseen";
    return n === run.end - run.start + 1 ? "seen" : "partly";
  });
  return {
    reached,
    hidden,
    playedCount,
    routes,
    lastPick,
    runs,
    here: hereOf(model, reader),
  };
}

/** The placeholders shown, with Spoilers off, for text the reader has not met. */
export const HIDDEN_PROMPT = "Decision not reached";
export const HIDDEN_ROUTE = "Unseen route";

/** A decision's question as the map may show it (full, untruncated). */
export function promptText(
  model: MapModel,
  marks: MapMarks,
  decision: number,
): string {
  if (marks.hidden[decision]) return HIDDEN_PROMPT;
  return model.decisionAt[decision]?.prompt ?? "";
}

/**
 * A route's label as the map may show it (full, untruncated, no choice
 * number). A hidden one is the placeholder whatever the real label is, so
 * nothing about it reaches the page.
 */
export function routeText(
  model: MapModel,
  marks: MapMarks,
  key: number,
): string {
  const route = model.routes[key];
  return marks.hidden[route.decision] ? HIDDEN_ROUTE : route.label;
}

/** How far before a decision box the marker sits while its choice is up. */
export const HERE_DECISION_GAP = 22;

/**
 * Where the reader is: just before the decision box while its choice
 * screen is up; on the start dot while the story's first screen is up (a
 * first load, and every boot after "Reset progress"); on an end mark while
 * the item on screen is the last one of the line that mark ends (an ending
 * route's, or the story's: its last screen, and the end state after it,
 * which stays there); otherwise the point along the stretch holding the
 * item on screen.
 */
function hereOf(
  model: MapModel,
  reader: MapReader,
): { x: number; y: number; decision: number } {
  if (reader.choiceId !== undefined) {
    const index = model.decisionById.get(reader.choiceId);
    const node = index === undefined ? undefined : model.decisionAt[index];
    if (node !== undefined)
      return { x: node.x - HERE_DECISION_GAP, y: node.y, decision: node.index };
  }
  // The first screen is the story's start: the marker sits on the start
  // dot itself, not a fraction of the first stretch to its right (with a
  // short first stretch that fraction is half the stretch).
  if (reader.cursor <= 0) return { ...model.start, decision: -1 };
  const run = runAt(model.runs, reader.cursor);
  if (run === undefined) return { ...model.start, decision: -1 };
  const end = endMarkAt(model, run, reader.cursor);
  if (end !== null) return { ...end, decision: -1 };
  return { x: itemX(run, reader.cursor), y: run.y, decision: -1 };
}

/** The centre x of a stretch's `j`-th card (story order). */
function cardCentre(run: MapRun, j: number): number {
  return run.x0 + CARD.inset + j * CARD.pitch + CARD.w / 2;
}

/**
 * Where item `index` sits along `run`'s line (clamped into the stretch).
 * Without cards, its share of the stretch. With cards, the place is exact
 * for a bookmarked screen — its card's centre (several cards on one
 * screen: their middle) — and the screens between run evenly from one
 * card to the next, so a point on the line and the cards always agree on
 * story order.
 */
export function itemX(run: MapRun, index: number): number {
  const n = run.end - run.start + 1;
  const u = Math.min(Math.max(index - run.start, 0), n - 1) + 0.5;
  const marks = run.bookmarks;
  if (marks.length === 0) return run.x0 + ((run.x1 - run.x0) * u) / n;
  let pu = 0;
  let px = run.x0;
  for (let j = 0; j < marks.length; ) {
    let k = j;
    while (k + 1 < marks.length && marks[k + 1] === marks[j]) k += 1;
    const au = marks[j] - run.start + 0.5;
    const ax = (cardCentre(run, j) + cardCentre(run, k)) / 2;
    if (u <= au) return u === au ? ax : px + ((ax - px) * (u - pu)) / (au - pu);
    pu = au;
    px = ax;
    j = k + 1;
  }
  return px + ((run.x1 - px) * (u - pu)) / (n - pu);
}

/**
 * The end mark the reader stands on, or null: `cursor` is the last item of
 * `run` (the stretch holding it), and that stretch is the last of a line
 * ending in a mark — an ending route's own line (nested ones included), or
 * the main line. A route whose line ends in a nested decision's join has
 * no stretch ending there, so its mark is never matched by one inside.
 */
function endMarkAt(
  model: MapModel,
  run: MapRun,
  cursor: number,
): { x: number; y: number } | null {
  if (run.end !== cursor) return null;
  for (const route of model.routes)
    if (
      route.outcome === "ends" &&
      route.endIndex === cursor &&
      route.endX === run.x1 &&
      route.y === run.y
    )
      return { x: route.endX + END_MARK_DX, y: route.y };
  if (cursor === model.itemCount - 1 && model.storyEnd !== null)
    return model.storyEnd;
  return null;
}

/** The run holding item `index`, else the nearest one before it. */
export function runAt(
  runs: readonly MapRun[],
  index: number,
): MapRun | undefined {
  let low = 0;
  let high = runs.length - 1;
  let found: MapRun | undefined;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (runs[mid].start <= index) {
      found = runs[mid];
      low = mid + 1;
    } else high = mid - 1;
  }
  return found ?? runs[0];
}

/** Something on the map the reader clicked. */
export type MapTarget =
  | { readonly kind: "decision"; readonly decision: number }
  | { readonly kind: "route"; readonly key: number };

/** What a click asks the machine for, or null for an inert target. */
export type MapJump =
  | { readonly kind: "choice"; readonly decision: number }
  | {
      readonly kind: "route";
      readonly decision: number;
      readonly route: number;
    };

/**
 * The click rule: a reached decision opens its choice screen; a route of a
 * reached decision is entered at its first screen, as a pick would. Anything
 * else — an unreached decision, its routes — is inert (null).
 */
export function jumpFor(
  model: MapModel,
  marks: MapMarks,
  target: MapTarget,
): MapJump | null {
  if (target.kind === "decision") {
    if (marks.reached[target.decision] !== true) return null;
    return { kind: "choice", decision: target.decision };
  }
  const route = model.routes[target.key];
  if (route === undefined || marks.reached[route.decision] !== true)
    return null;
  return { kind: "route", decision: route.decision, route: route.route };
}

/** The machine operations a jump uses (render/../machine Machine). */
export interface JumpOps {
  /** The decision index whose choice screen is up, or -1. */
  openChoice(): number;
  /** Whether that open choice is one the wheel walked onto. */
  walkedChoice(): boolean;
  showChoice(decision: number): void;
  choose(route: number): void;
}

/**
 * Runs a jump through the machine's own operations: the choice screen as a
 * wheel step shows it (`showChoice`), and a route entered by a real pick
 * from that screen (`choose`), so seen marks, played routes and last picks
 * move exactly as they would for a reader who wheeled there and picked.
 * A choice the reading itself opened is left as it is (answered in place).
 */
export function runJump(jump: MapJump, ops: JumpOps): void {
  const open = ops.openChoice();
  if (jump.kind === "choice") {
    if (open === jump.decision && !ops.walkedChoice()) return;
    ops.showChoice(jump.decision);
    return;
  }
  if (open !== jump.decision) ops.showChoice(jump.decision);
  ops.choose(jump.route);
}

// ---------------------------------------------------------------------------
// View arithmetic: screen = world * scale + (x, y).
// ---------------------------------------------------------------------------

export interface MapView {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/**
 * The furthest the map zooms in, Fit included: 3x, where a card is three
 * times the old `t` screen's (100% is scale 1) and a tiny story (one
 * stretch) is not blown up further.
 */
export const MAX_SCALE = 3;

/**
 * The zoom limits for a model in a viewport: out to the whole tree (with
 * the marker at `here`, when given, as Fit shows it), in to `MAX_SCALE`.
 */
export function zoomLimits(
  model: MapModel,
  vw: number,
  vh: number,
  here?: { x: number; y: number },
): { min: number; max: number } {
  const fit = fitView(model, vw, vh, here).scale;
  return { min: Math.min(fit, 0.25), max: MAX_SCALE };
}

/** Zoom by `factor` keeping the world point under screen (px, py) still. */
export function zoomAt(
  view: MapView,
  factor: number,
  px: number,
  py: number,
  limits: { min: number; max: number },
): MapView {
  const scale = Math.min(limits.max, Math.max(limits.min, view.scale * factor));
  const k = scale / view.scale;
  return { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

/** The view that shows world point (wx, wy) at the viewport centre. */
export function centreOn(
  wx: number,
  wy: number,
  vw: number,
  vh: number,
  scale: number,
): MapView {
  return { scale, x: vw / 2 - wx * scale, y: vh / 2 - wy * scale };
}

/** Screen pixels Fit leaves between the tree and each edge of the view. */
export const FIT_MARGIN_PX = 32;

/**
 * How far the "you are here" marker reaches from its point, in screen
 * pixels at any zoom: its ring (r 13) above, its centred "you are here"
 * label (13 px, letter-spaced, 4 px halo, baseline 32 px below) to each
 * side and below, with a few pixels' slack. The branch map draws it in
 * screen space, so Fit leaves this room around it.
 */
export const HERE_REACH = { side: 58, up: 18, down: 42 } as const;

/** Screen pixels kept between the marker's reach and the view's edge. */
const HERE_MARGIN_PX = 6;

/** One edge of what a view must show, on one axis: screen = a * scale + c. */
interface Edge {
  readonly a: number;
  readonly c: number;
}

/** The low and high edges a framed view keeps inside [0, room] on one axis. */
interface Axis {
  readonly lo: readonly Edge[];
  readonly hi: readonly Edge[];
}

/** The largest scale at which every lo..hi span fits in `room`. */
function axisScale(axis: Axis, room: number): number {
  let scale = Infinity;
  for (const hi of axis.hi)
    for (const lo of axis.lo) {
      const da = hi.a - lo.a;
      if (da > 0) scale = Math.min(scale, Math.max(1, room - hi.c + lo.c) / da);
    }
  return scale;
}

/** The offset that centres the axis's extent at `scale` in `room`. */
function axisOffset(axis: Axis, scale: number, room: number): number {
  const lo = Math.min(...axis.lo.map((e) => e.a * scale + e.c));
  const hi = Math.max(...axis.hi.map((e) => e.a * scale + e.c));
  return room / 2 - (lo + hi) / 2;
}

/**
 * What a whole-tree view keeps inside the viewport: the tree's drawn box
 * (`bounds`) with `FIT_MARGIN_PX` a side and, when `here` is given, the
 * marker's screen-space reach (`HERE_REACH`) around that point.
 */
function wholeAxes(
  model: MapModel,
  here: { x: number; y: number } | undefined,
): { x: Axis; y: Axis } {
  const b = model.bounds;
  const m = FIT_MARGIN_PX;
  const r = HERE_REACH;
  const k = HERE_MARGIN_PX;
  const x: Axis = {
    lo: [{ a: b.x0, c: -m }],
    hi: [{ a: b.x1, c: m }],
  };
  const y: Axis = {
    lo: [{ a: b.y0, c: -m }],
    hi: [{ a: b.y1, c: m }],
  };
  if (here === undefined) return { x, y };
  return {
    x: {
      lo: [...x.lo, { a: here.x, c: -r.side - k }],
      hi: [...x.hi, { a: here.x, c: r.side + k }],
    },
    y: {
      lo: [...y.lo, { a: here.y, c: -r.up - k }],
      hi: [...y.hi, { a: here.y, c: r.down + k }],
    },
  };
}

/** The whole-tree framing at `scale`, centred on what it keeps in view. */
function framed(
  axes: { x: Axis; y: Axis },
  vw: number,
  vh: number,
  scale: number,
): MapView {
  return {
    scale,
    x: axisOffset(axes.x, scale, vw),
    y: axisOffset(axes.y, scale, vh),
  };
}

/**
 * The view showing the whole tree, centred, as large as the view allows:
 * the tree's drawn box (`bounds`, not the layout's padding) fills the
 * view less `FIT_MARGIN_PX` a side along its tighter axis. With `here`
 * (the marker's world point), the marker's fixed-size ring and label stay
 * inside the view too: where it sits by an edge of the tree, the scale is
 * solved with its pixel reach as the extra margin on that side. Only the
 * zoom-in limit caps it, so a tiny story (one stretch) is not blown up
 * past `MAX_SCALE`.
 */
export function fitView(
  model: MapModel,
  vw: number,
  vh: number,
  here?: { x: number; y: number },
): MapView {
  const axes = wholeAxes(model, here);
  const scale = Math.min(
    MAX_SCALE,
    axisScale(axes.x, vw),
    axisScale(axes.y, vh),
  );
  return framed(axes, vw, vh, scale);
}

/**
 * The view after the viewport went from `from` to `to` (a resize, or
 * entering or leaving fullscreen) with the map open: the world point at
 * the old view's centre stays at the centre, at the same scale. (A fitted
 * view is fitted again instead; the screen decides.)
 */
export function viewAfterResize(
  view: MapView,
  from: { w: number; h: number },
  to: { w: number; h: number },
): MapView {
  const wx = (from.w / 2 - view.x) / view.scale;
  const wy = (from.h / 2 - view.y) / view.scale;
  return centreOn(wx, wy, to.w, to.h, view.scale);
}

/**
 * A fingerprint of a model's layout: every stretch, box and pill position
 * and the item count, hashed (FNV-1a, 32 bits). Two layouts with the same
 * signature put every world point in the same place, so a view remembered
 * on one is valid on the other; another game version, or the rows wrapped
 * differently for a very different window shape, gives another one.
 * Linear in runs, decisions and routes.
 */
export function layoutSignature(model: MapModel): string {
  let hash = 0x811c9dc5;
  const mix = (n: number) => {
    const text = `${Math.round(n * 100)},`;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  mix(model.itemCount);
  for (const r of model.runs)
    for (const n of [r.start, r.end, r.x0, r.x1, r.y]) mix(n);
  for (const d of model.decisions) for (const n of [d.index, d.x, d.y]) mix(n);
  for (const r of model.routes)
    for (const n of [r.decision, r.x, r.y, r.endX]) mix(n);
  return `${model.itemCount}:${hash.toString(36)}`;
}

/**
 * The view to remember for `view` in a vw x vh viewport, on the layout
 * whose signature is `layout`.
 */
export function saveView(
  layout: string,
  view: MapView,
  vw: number,
  vh: number,
  fit: boolean,
): SavedMapView {
  return {
    layout,
    fit,
    cx: (vw / 2 - view.x) / view.scale,
    cy: (vh / 2 - view.y) / view.scale,
    scale: view.scale,
  };
}

/**
 * The view the map opens at: a fresh Fit for this window (nothing
 * remembered, a remembered Fit, or one taken on another layout), else the
 * remembered world centre and scale, the scale clamped to the zoom limits
 * here (the window may have changed size since). `fit` says which, so a
 * resize of a fitted view fits again. The marker's place does not move the
 * view: C does that.
 */
export function restoreView(
  model: MapModel,
  saved: SavedMapView | null | undefined,
  vw: number,
  vh: number,
  here?: { x: number; y: number },
  layout: string = layoutSignature(model),
): { view: MapView; fit: boolean } {
  if (saved == null || saved.fit || saved.layout !== layout)
    return { view: fitView(model, vw, vh, here), fit: true };
  const limits = zoomLimits(model, vw, vh, here);
  const scale = Math.min(limits.max, Math.max(limits.min, saved.scale));
  return { view: centreOn(saved.cx, saved.cy, vw, vh, scale), fit: false };
}

/** Below this scale labels are not drawn (level of detail). */
export const LABEL_MIN_SCALE = 0.6;
/**
 * A tree this small (decisions plus routes) keeps its labels further out,
 * down to `SMALL_LABEL_MIN_SCALE`: it costs nothing to draw, and its fitted
 * view is often just under the normal threshold.
 */
export const SMALL_TREE_NODES = 200;
export const SMALL_LABEL_MIN_SCALE = 0.3;

/** The scale below which this model is drawn without labels. */
export function labelMinScale(model: MapModel): number {
  return model.decisions.length + model.routes.length <= SMALL_TREE_NODES
    ? SMALL_LABEL_MIN_SCALE
    : LABEL_MIN_SCALE;
}

/** The world rectangle a view shows, for culling. */
export function visibleWorld(
  view: MapView,
  vw: number,
  vh: number,
): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: -view.x / view.scale,
    y0: -view.y / view.scale,
    x1: (vw - view.x) / view.scale,
    y1: (vh - view.y) / view.scale,
  };
}

/**
 * The node under world point (wx, wy), or null: what a click or hover at a
 * far zoom, where no per-node element is drawn, lands on. Linear in nodes.
 */
export function hitTest(
  model: MapModel,
  wx: number,
  wy: number,
): MapTarget | null {
  const g = MAP_GEOMETRY;
  for (const node of model.decisions) {
    if (
      wx >= node.x &&
      wx <= node.x + g.decW &&
      Math.abs(wy - node.y) <= g.decH / 2
    )
      return { kind: "decision", decision: node.index };
  }
  for (let key = 0; key < model.routes.length; key += 1) {
    const route = model.routes[key];
    if (
      wx >= route.x &&
      wx <= route.x + g.routeW &&
      Math.abs(wy - route.y) <= g.routeH / 2
    )
      return { kind: "route", key };
  }
  return null;
}

/** One bookmark's card on the map, world units. */
export interface CardSlot {
  /** The card's left and top edges. */
  readonly x: number;
  readonly y: number;
  /** Its centre, on its stretch's line at its screen's place. */
  readonly cx: number;
  readonly cy: number;
}

/**
 * Each bookmark's card, in the order given: on the stretch `buildMapModel`
 * sized for it (the one holding its item, else the nearest before it),
 * side by side in story order (item order; on one screen, oldest first),
 * centred on the line. Null for an item outside the manifest, or a
 * bookmark beyond those the model was built with. Linear in bookmarks
 * (plus a sort).
 */
export function cardSlots(
  model: MapModel,
  bookmarks: readonly { itemIndex: number; timestampMs: number }[],
): (CardSlot | null)[] {
  const out: (CardSlot | null)[] = bookmarks.map(() => null);
  const byRun = new Map<MapRun, number[]>();
  bookmarks.forEach((b, i) => {
    const index = b.itemIndex;
    if (!Number.isInteger(index) || index < 0 || index >= model.itemCount)
      return;
    const run = runAt(model.runs, index);
    if (run === undefined) return;
    const list = byRun.get(run) ?? [];
    list.push(i);
    byRun.set(run, list);
  });
  for (const [run, list] of byRun) {
    list.sort(
      (a, b) =>
        bookmarks[a].itemIndex - bookmarks[b].itemIndex ||
        bookmarks[a].timestampMs - bookmarks[b].timestampMs ||
        a - b,
    );
    list.forEach((i, j) => {
      if (j >= run.bookmarks.length) return;
      const cx = cardCentre(run, j);
      out[i] = { x: cx - CARD.w / 2, y: run.y - CARD.h / 2, cx, cy: run.y };
    });
  }
  return out;
}

/**
 * 100% (key 1, Phase 35): scale 1, where a card is the old `t` screen's
 * size, zoomed about the view's centre (within the zoom limits).
 */
export function fullSizeView(
  view: MapView,
  vw: number,
  vh: number,
  limits: { min: number; max: number },
): MapView {
  return zoomAt(view, 1 / view.scale, vw / 2, vh / 2, limits);
}
