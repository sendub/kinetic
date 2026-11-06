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
// decision's routes. Routes that continue or return meet at a join on the
// decision's row, and the line carries on from there: at `continueAt` for a
// decision with a continuing route, past the whole menu region for a pure
// choice (the machine's own flow, docs/content-format.md "Branches"). An
// ending route stops in an end mark.
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
//   tallest sibling. When that draws a decision's routes out of manifest
//   order, its pills carry their choice numbers (`numbered`).
//
// Every position is computed once, from the resolved decision table the
// machine itself uses (`resolveDecisions`), so map indices ARE machine
// indices; the cost is linear in decisions and routes (times nesting depth
// for the tuck shifts), never in items, whatever the game's size.

import { type ResolvedDecision, resolveDecisions } from "../machine/machine";
import type { Branch, ContextFrame, Item, RouteSet } from "../machine/types";

/** Geometry in world units (CSS pixels at zoom 1). */
export const MAP_GEOMETRY = {
  pad: 60,
  rowH: 84,
  runW: 120,
  decW: 250,
  decH: 56,
  routeW: 230,
  routeH: 36,
  gap: 56,
  /** Space between wrapped rows, which the continuation connector runs through. */
  wrapGap: 64,
} as const;

/** How far right of a line's end its end mark reaches. */
const END_REACH = 17;

/** The aspect (width / height) a layout aims for when none is given. */
export const DEFAULT_MAP_ASPECT = 16 / 9;

/** Characters kept of a question / a route label before "…". */
export const PROMPT_CHARS = 30;
export const LABEL_CHARS = 25;

/** One collapsed stretch of screens between decisions. */
export interface MapRun {
  /** First and last item index of the stretch, inclusive. */
  readonly start: number;
  readonly end: number;
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
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

/** How a route's span ends (docs/content-format.md, "Branches"). */
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
  /**
   * The decision's routes are drawn out of manifest order (an ending
   * tucked in above a taller sibling), so the pill shows its choice number.
   */
  readonly numbered: boolean;
}

export interface MapModel {
  readonly runs: readonly MapRun[];
  readonly decisions: readonly MapDecision[];
  readonly routes: readonly MapRoute[];
  /**
   * The connectors, each with its bounding box (for culling): decision ->
   * route pill curves (`branch`), continuing routes into their join
   * (`join`), returning routes back towards it (`return`), and a row's end
   * to the next row's start (`wrap`).
   */
  readonly links: readonly MapLink[];
  /** Join dots and end marks, world points. */
  readonly joins: readonly { x: number; y: number }[];
  readonly ends: readonly { x: number; y: number }[];
  /** Where the story starts (a dot) and, when the main line ends in a run, ends. */
  readonly start: { x: number; y: number };
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

/** `text` cut to `max` characters, with "…" when cut. */
export function truncateLabel(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  if (chars.length <= max) return chars.join("");
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
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

/**
 * Wraps top-level segments (width, rows tall) into lines of text so the
 * whole layout's aspect comes closest to `aspect`: tries row widths from
 * the widest segment to everything on one row, geometrically spaced.
 */
export function wrapSegments(
  segments: readonly { width: number; rows: number }[],
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
      let rh = 1;
      for (const i of row) {
        rw += widths[i];
        rh = Math.max(rh, segments[i].rows);
      }
      w = Math.max(w, rw);
      h += rh * g.rowH;
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
 * Lays the decision tree out. Pure; call once per manifest and viewport
 * shape (`aspect`, the map view's width / height: the rows wrap to it).
 */
export function buildMapModel(
  items: readonly Item[],
  branches: readonly Branch[] | undefined,
  aspect: number = DEFAULT_MAP_ASPECT,
): MapModel {
  const g = MAP_GEOMETRY;
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
    runs.push({ start, end, x0: x, x1: x + g.runW, y });
    return x + g.runW;
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
    let lastRow = -1;
    let reordered = false;
    let furthest = bx + g.routeW;
    const pending: { key: number; endX: number; y: number }[] = [];
    decision.routes.forEach((route, routeIdx) => {
      const outcome: RouteOutcome = route.continuing
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
      if (row < lastRow) reordered = true;
      lastRow = row;
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
        numbered: false,
      });
      routeKeys.push(key);
      pending.push({ key, endX: inner.x, y: ry });
      if (inner.x > furthest) furthest = inner.x;
    });
    if (reordered) for (const key of routeKeys) routes[key].numbered = true;
    const joinX = furthest + g.gap;
    let joined = false;
    for (const { key, endX, y: routeY } of pending) {
      const route = routes[key];
      if (route.outcome === "ends") {
        ends.push({ x: endX + 10, y: routeY });
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
  const segments: { from: Mark; width: number; rows: number }[] = [];
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
  if (idx <= last) {
    // The story's tail: a stretch and its end mark, on the last segment.
    const tail = segments[segments.length - 1];
    if (tail === undefined) {
      segments.push({ from: mark(), width: addRun(idx, last, 0, 0), rows: 1 });
    } else tail.width = addRun(idx, last, tail.width, 0);
    const end = segments[segments.length - 1];
    ends.push({ x: end.width + 10, y: 0 });
    end.width += END_REACH;
  }

  const wrapped = wrapSegments(segments, aspect);
  const done = mark();
  const wraps: MapLink[] = [];
  let top = g.pad;
  let widest = 0;
  let previous: { endX: number; y: number; bottom: number } | null = null;
  for (const row of wrapped) {
    const rowY = top + g.rowH / 2;
    let x = g.pad;
    let rows = 1;
    for (const i of row) {
      const segment = segments[i];
      shift(segment.from, segments[i + 1]?.from ?? done, x, rowY);
      x += segment.width;
      rows = Math.max(rows, segment.rows);
    }
    if (previous !== null) wraps.push(wrapLink(previous, g.pad, rowY));
    const bottom = top + rows * g.rowH;
    previous = { endX: x, y: rowY, bottom };
    widest = Math.max(widest, x);
    top = bottom + g.wrapGap;
  }
  const height = top - g.wrapGap + g.pad;
  const y0 = g.pad + g.rowH / 2;

  mapDecisions.sort((a, b) => a.index - b.index);
  runs.sort((a, b) => a.start - b.start);
  const decisionAt: (MapDecision | undefined)[] = decisions.map(
    () => undefined,
  );
  for (const node of mapDecisions) decisionAt[node.index] = node;
  const decisionById = new Map<string, number>();
  for (const decision of decisions)
    decisionById.set(decision.id, decision.index);
  return {
    runs,
    decisions: mapDecisions,
    routes,
    links: [...raw.map(linkOf), ...wraps],
    joins,
    ends,
    start: { x: g.pad, y: y0 },
    width: widest + g.pad + 40,
    height,
    rows: Math.max(1, wrapped.length),
    itemCount: items.length,
    decisionAt,
    decisionById,
  };
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
}

/** A route as the reader stands with it. */
export type RouteMark = "unseen" | "partly" | "played";
/** A stretch of screens as the reader stands with it. */
export type RunMark = "unseen" | "partly" | "seen";

export interface MapMarks {
  /** Per decision (by machine index): its `after` item has been seen. */
  readonly reached: readonly boolean[];
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
    playedCount,
    routes,
    lastPick,
    runs,
    here: hereOf(model, reader),
  };
}

/** How far before a decision box the marker sits while its choice is up. */
export const HERE_DECISION_GAP = 22;

/**
 * Where the reader is: just before the decision box while its choice
 * screen is up, otherwise the point along the stretch holding the item on
 * screen.
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
  const run = runAt(model.runs, reader.cursor);
  if (run === undefined) return { ...model.start, decision: -1 };
  const n = run.end - run.start + 1;
  const at = Math.min(Math.max(reader.cursor - run.start, 0), n - 1);
  const x = run.x0 + ((run.x1 - run.x0) * (at + 0.5)) / n;
  return { x, y: run.y, decision: -1 };
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

/** The zoom limits for a model in a viewport: out to the whole tree, in to 3x. */
export function zoomLimits(
  model: MapModel,
  vw: number,
  vh: number,
): { min: number; max: number } {
  const fit = fitView(model, vw, vh).scale;
  return { min: Math.min(fit, 0.25), max: 3 };
}

/** The scale the map opens at: readable labels, a little smaller on a small screen. */
export function readableScale(vw: number, vh: number): number {
  return Math.min(1.1, Math.max(0.7, Math.min(vw / 1700, vh / 950)));
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

/** Fit never blows a small tree up past this. */
export const FIT_MAX_SCALE = 1.4;

/** The view showing the whole tree, centred. */
export function fitView(model: MapModel, vw: number, vh: number): MapView {
  const scale = Math.min(
    FIT_MAX_SCALE,
    Math.min(vw / model.width, vh / model.height) * 0.96,
  );
  return centreOn(model.width / 2, model.height / 2, vw, vh, scale);
}

/** The view the map opens at: the reader's position, readable. */
export function openingView(
  model: MapModel,
  marks: MapMarks,
  vw: number,
  vh: number,
): MapView {
  const scale = readableScale(vw, vh);
  // A tree that fits whole at a readable scale is shown whole, centred.
  if (fitView(model, vw, vh).scale >= scale)
    return centreOn(model.width / 2, model.height / 2, vw, vh, scale);
  return centreOn(marks.here.x, marks.here.y, vw, vh, scale);
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
