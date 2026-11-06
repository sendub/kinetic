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
// ending route stops in an end mark. Every position is computed once, from
// the resolved decision table the machine itself uses (`resolveDecisions`),
// so map indices ARE machine indices; the cost is linear in decisions and
// routes, never in items, whatever the game's size.

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
} as const;

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
  readonly kind: "branch" | "join" | "return";
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
}

export interface MapModel {
  readonly runs: readonly MapRun[];
  readonly decisions: readonly MapDecision[];
  readonly routes: readonly MapRoute[];
  /**
   * The connectors, each with its bounding box (for culling): decision ->
   * route pill curves (`branch`), continuing routes into their join
   * (`join`), returning routes back towards it (`return`).
   */
  readonly links: readonly MapLink[];
  /** Join dots and end marks, world points. */
  readonly joins: readonly { x: number; y: number }[];
  readonly ends: readonly { x: number; y: number }[];
  /** Where the story starts (a dot) and, when the main line ends in a run, ends. */
  readonly start: { x: number; y: number };
  readonly width: number;
  readonly height: number;
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

/** Lays the decision tree out. Pure; call once per manifest. */
export function buildMapModel(
  items: readonly Item[],
  branches: readonly Branch[] | undefined,
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

  const runs: MapRun[] = [];
  const mapDecisions: MapDecision[] = [];
  const routes: MapRoute[] = [];
  const links: MapLink[] = [];
  const joins: { x: number; y: number }[] = [];
  const ends: { x: number; y: number }[] = [];
  let width = 0;
  let maxY = g.rowH / 2;
  const placed = new Set<number>();

  const addRun = (start: number, end: number, x: number, y: number) => {
    runs.push({ start, end, x0: x, x1: x + g.runW, y });
    return x + g.runW;
  };

  // One line of story from item `start` to `end` inside decision `parent`'s
  // route (-1: the main line), starting at world x, on row centre y.
  // Returns where it ends and how many rows it takes.
  function line(
    start: number,
    end: number,
    parent: number,
    x0: number,
    y: number,
  ): { x: number; rows: number } {
    let x = x0;
    let rows = 1;
    let idx = start;
    for (const decision of children.get(parent) ?? []) {
      if (decision.afterIndex < idx || decision.afterIndex > end) continue;
      if (placed.has(decision.index)) continue;
      x = addRun(idx, decision.afterIndex, x, y);
      const block = layoutDecision(decision, x, y);
      x = block.x;
      rows = Math.max(rows, block.rows);
      const next = continuationOf(decision);
      if (next <= decision.afterIndex || next > end) {
        idx = end + 1;
        break;
      }
      idx = next;
    }
    if (idx <= end) x = addRun(idx, end, x, y);
    if (y > maxY) maxY = y;
    if (x > width) width = x;
    return { x, rows };
  }

  function layoutDecision(
    decision: ResolvedDecision,
    x: number,
    y: number,
  ): { x: number; rows: number } {
    placed.add(decision.index);
    const routeKeys: number[] = [];
    const bx = x + g.decW + g.gap;
    const midX = x + g.decW + g.gap / 2;
    let ry = y;
    let furthest = bx + g.routeW;
    const pending: { key: number; endX: number; y: number }[] = [];
    decision.routes.forEach((route, routeIdx) => {
      links.push({
        kind: "branch",
        d: `M${x + g.decW} ${y}C${midX} ${y} ${midX} ${ry} ${bx} ${ry}`,
        x0: x + g.decW,
        y0: y,
        x1: bx,
        y1: ry,
      });
      const inner = line(
        route.startIndex,
        route.endIndex,
        decision.index,
        bx + g.routeW,
        ry,
      );
      const outcome: RouteOutcome = route.continuing
        ? "continues"
        : route.result === "return"
          ? "returns"
          : "ends";
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
      ry += inner.rows * g.rowH;
    });
    const joinX = furthest + g.gap;
    let joined = false;
    for (const { key, endX, y: routeY } of pending) {
      const route = routes[key];
      if (route.outcome === "ends") {
        ends.push({ x: endX + 10, y: routeY });
        continue;
      }
      joined = true;
      const r = Math.min(24, routeY - y);
      const d =
        routeY === y
          ? `M${endX} ${y}H${joinX}`
          : `M${endX} ${routeY}H${joinX - r}Q${joinX} ${routeY} ${joinX} ${routeY - r}V${y}`;
      links.push({
        kind: route.outcome === "continues" ? "join" : "return",
        d,
        x0: endX,
        y0: y,
        x1: joinX,
        y1: routeY,
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
    if (joinX > width) width = joinX;
    return { x: joinX, rows: Math.max(1, (ry - y) / g.rowH) };
  }

  const y0 = g.pad + g.rowH / 2;
  const main =
    items.length > 0
      ? line(0, items.length - 1, -1, g.pad, y0)
      : { x: g.pad, rows: 1 };
  const lastRun = runs[runs.length - 1];
  if (lastRun !== undefined && lastRun.y === y0 && lastRun.x1 === main.x)
    ends.push({ x: main.x + 10, y: y0 });
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
    links,
    joins,
    ends,
    start: { x: g.pad, y: y0 },
    width: width + g.pad + 40,
    height: maxY + g.rowH / 2 + g.pad,
    itemCount: items.length,
    decisionAt,
    decisionById,
  };
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
