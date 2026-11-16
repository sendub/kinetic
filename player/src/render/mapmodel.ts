// The branch map's pure half (docs/plan.md Phase 31): the decision tree laid
// out once per manifest, the reader's marks laid over it on each open, the
// arithmetic of its two views (Full size and Fit, docs/plan.md Phase 41) and
// the remembered view, and the click-to-jump rule. No DOM: the screen
// (render/branchmap.ts) only draws what these return.
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
// - Bands like the systems of a music score (docs/plan.md Phase 41, "Band
//   layout"). The tree is laid out once as one long strip (`layOutStrip`),
//   then cut into bands of a given width (`cutBands`): every parallel line
//   cut at the same x, each band under the one before, `wrapGap` apart
//   between what they draw, as tall as what it draws. A band only moves
//   what it holds: every line keeps the height below the main line it has
//   on the strip, so the two sides of a cut would join edge to edge. A cut
//   falls only where everything crossing it is a straight
//   horizontal line (a stretch, or the straight run of a join or return
//   line): never through a node, a pill, a card, a count, an end mark, a
//   station or a curve, though between two cards of a stretch is fine.
//   Each line a cut crosses leaves its band in a
//   "continues" tick (a stub out past the band's edge, crossed by a slash in
//   the line's colour and weight) and resumes from a matching tick at the
//   next band's left edge (`MapModel.ticks`); a stretch it crosses is drawn
//   as a piece per band (`MapRun.pieces`), and everything else, the "you are
//   here" point and the cards included, follows its piece into its band.
//   Where no cut lies within the width, the band runs on to the first one
//   past it. The two views pass the width: Full size the map view's own
//   width, so nothing runs off its sides; Fit the width at which the whole
//   map shows largest in the view (`fitWidth`).
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
// by side; stretches without bookmarks keep the compact geometry.
//
// Lines are spaced by what lies between them (docs/plan.md Phase 42). The
// layout stacks every route's line on a row of the decision it leaves,
// then gives each line, once for the whole strip, its height below the
// main line (`lineOffsets`): `rowH` below the lowest line above it that
// overlaps it in x, more only where a card on one of the two lies over the
// other (`CARD_ABOVE`, `CARD_BELOW`). A card anywhere along a line sets
// that line's height along its whole length, in every band; a card under
// one decision moves nothing under another.
//
// Every position is computed once, from the resolved decision table the
// machine itself uses (`resolveDecisions`), so map indices ARE machine
// indices; the cost is linear in decisions and routes (times nesting depth
// for the tuck shifts, and a logarithm for the lines' spacing), never in
// items, whatever the game's size. Cutting the strip into bands is linear
// in what it draws, at any width.

import { formatNumber, t } from "../i18n/catalogue.ts";
import {
  joinsAtContinue,
  type ResolvedDecision,
  resolveDecisions,
} from "../machine/machine";
import type { Branch, ContextFrame, Item, RouteSet } from "../machine/types";
import type { MapPlace, SavedMapView } from "../storage/types";

export type { MapPlace, SavedMapView };

/** A map text as drawn: its text and the language it is in. */
export interface MapShownText {
  readonly text: string;
  readonly lang: string;
}

/**
 * The game's words in the shown language for the map (docs/plan.md Phase
 * 54 item 3), by the machine's decision index and a route's index in it;
 * `base` is the manifest's text, the fallback.
 */
export interface MapWords {
  prompt(decision: number, base: string): MapShownText;
  label(decision: number, route: number, base: string): MapShownText;
}

/**
 * Geometry in world units (CSS pixels at scale 1, Full size). Compact
 * (docs/plan.md Phase 35; a size up in Phase 40, the figures 13 px in
 * index.html): at Full size a world unit is a screen pixel sized by the
 * bookmark cards, so a
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
  /** Space between bands: from what one draws to what the next draws. */
  wrapGap: 40,
} as const;

/**
 * A bookmark's card (Phase 35), world units: at Full size the old `t`
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
 * The room a line's cards take past a row's height (`lineOffsets`): above
 * the line, half a card and a margin; below it, half a card, a margin and
 * the stretch's count line under the cards. Two lines `rowH` apart get
 * this much more between them where a card on one lies over the other.
 */
export const CARD_ABOVE = CARD.h / 2 + 10;
export const CARD_BELOW = CARD.h / 2 + 24;
/** Where a carded stretch's count line sits, below its line. */
export const CARD_COUNT_DY = CARD.h / 2 + 15;

/** How far right of a line's end its end mark reaches. */
const END_REACH = 17;
/** How far right of a line's end its end mark's centre sits. */
const END_MARK_DX = 10;

/**
 * A "continues" tick (docs/plan.md Phase 41, "Band layout"), where a band
 * cut crosses a line: the line runs `reach` on past the band's edge, out
 * into its margin, and a slash crosses it there, `rise` above and below the
 * line and `lean` to each side. Out at a band's right edge, the matching
 * one in at the next band's left; both lie outside what the band holds, so
 * they touch nothing in it (`tickPaths`).
 */
export const TICK = { reach: 5, rise: 6, lean: 3 } as const;

/**
 * How far a band cut keeps from a node, a station, an end mark, a curve or
 * a count; between two cards it falls in the middle of their gap.
 */
const CUT_CLEAR = 4;
/** How far a band cut keeps from where two lines meet on one row. */
const CUT_JOINT = 3;
/** A count's width per character, a share of its type size (a wide digit). */
const COUNT_EM = 0.62;
/** The least room a band gets for what it holds, whatever width is asked. */
const MIN_BAND_ROOM = 120;

/**
 * How far things reach above and below their row's line as drawn at scale 1,
 * which is what a band's top and bottom are (bands sit `wrapGap` apart
 * between what they draw). The "you are here" ring (index.html
 * `.map-here-ring`: r 15, a 4 px stroke) can sit on any stretch, end mark
 * or the start dot; a card's hover ring and the newest's outline are 3 px
 * out of it (`.bm-card`); a decision's hover stroke is 3.5 px; a tick's
 * slash has round caps half a stretch's 5 px.
 */
export const DRAWN_REACH = {
  here: 17,
  card: CARD.h / 2 + 3,
  cardCount: CARD_COUNT_DY + 4,
  decision: MAP_GEOMETRY.decH / 2 + 1.75,
  join: 6.5,
  tick: TICK.rise + 2.5,
} as const;

/** One collapsed stretch of screens between decisions. */
export interface MapRun {
  /** First and last item index of the stretch, inclusive. */
  readonly start: number;
  readonly end: number;
  /**
   * Its first piece's left end, right end and line: the whole stretch,
   * unless a band cut falls inside it (then `pieces` has the rest).
   */
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
  /**
   * The item indices of the bookmarks drawn on this stretch, ascending
   * (one per bookmark: two on one screen appear twice). Empty: the compact
   * `runW` stretch; else it is as long as its cards side by side.
   */
  readonly bookmarks: readonly number[];
  /** How long it is along its line, all pieces together. */
  readonly length: number;
  /**
   * The pieces it is drawn as, in story order: one, or one per band where
   * band cuts fall inside it (a "continues" tick at each cut,
   * `MapModel.ticks`). Points along it map onto them (`pointAlong`).
   */
  readonly pieces: readonly MapPiece[];
}

/** One band's piece of a stretch, world units. */
export interface MapPiece {
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
  /** How far along its stretch it starts (0 for the first piece). */
  readonly at: number;
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
  /**
   * Where the route's own line ends: on the pill's row, in a later band
   * when a band cut crosses the line.
   */
  readonly endX: number;
  readonly endY: number;
}

/**
 * A "continues" tick (`TICK`): where a band cut crosses a line, `out` at
 * the band's right edge and `in` at the next band's left edge, at the
 * line's height in each. Drawn in that line's own look: a stretch's (by
 * position in `MapModel.runs`, its read state) or a connector kind's.
 */
export interface MapTick {
  /** Where the line meets the band's edge. */
  readonly x: number;
  readonly y: number;
  readonly side: "out" | "in";
  readonly line: "run" | "join" | "return";
  /** The stretch, by position in `MapModel.runs`; -1 for a connector. */
  readonly run: number;
  /** The band it is drawn in, by position in `MapModel.bands`. */
  readonly band: number;
}

/**
 * One band's box, world units: from its left edge (where the story starts,
 * or its lines resume) to its right edge (where they are cut, or the story
 * ends), and from the top to the bottom of what it draws at scale 1
 * (`DRAWN_REACH`: its cards with their rings, counts, nodes, ticks, and
 * the "you are here" ring wherever that can sit).
 */
export interface MapBand {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** Where along the strip it starts and ends (`MapStrip`, x from 0). */
  readonly start: number;
  readonly end: number;
  /**
   * Its main line, world y: every line in it sits as far below this as it
   * does below the main line on the strip (`MapStrip`), in every band.
   */
  readonly line: number;
}

export interface MapModel {
  readonly runs: readonly MapRun[];
  readonly decisions: readonly MapDecision[];
  readonly routes: readonly MapRoute[];
  /**
   * The connectors, each with its bounding box (for culling): decision ->
   * route pill curves (`branch`), continuing and `continue` routes into
   * their join (`join`), returning routes back towards it (`return`). A
   * join or return line a band cut crosses is one link per band.
   */
  readonly links: readonly MapLink[];
  /** The "continues" ticks, an out and an in for every line a cut crosses. */
  readonly ticks: readonly MapTick[];
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
  /** The layout's size, its padding included. */
  readonly width: number;
  readonly height: number;
  /** The bands, top to bottom (one when nothing is cut). */
  readonly bands: readonly MapBand[];
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
 * block laid out once can be moved (tucked in, then placed in its band) by
 * adding offsets.
 */
interface RawLink {
  kind: "branch" | "join" | "return";
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** The radius of a join or return line's turn up to its decision's row. */
const TURN_R = 24;

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
  const r = Math.min(TURN_R, ay - by);
  const d =
    ay === by
      ? `M${ax} ${ay}H${bx}`
      : `M${ax} ${ay}H${bx - r}Q${bx} ${ay} ${bx} ${ay - r}V${by}`;
  return { kind, d, x0: ax, y0: by, x1: bx, y1: ay };
}

/** A join or return line's straight piece in a band it only crosses. */
function straightLink(
  kind: "join" | "return",
  x0: number,
  x1: number,
  y: number,
): MapLink {
  return { kind, d: `M${x0} ${y}H${x1}`, x0, y0: y, x1, y1: y };
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
 * A stretch's count line: a compact stretch shows its screen count above
 * its line; one holding cards says it under them, with its bookmarks, in
 * the UI language (its length spaces the cards, so a new language lays the
 * map out again: render/branchmap.ts).
 */
export function countText(screens: number, bookmarks: number): string {
  if (bookmarks === 0) return formatNumber(screens);
  return `${t("map.count.screens", { count: screens })} · ${t("map.count.bookmarks", { count: bookmarks })}`;
}

/**
 * Where a strip element sits across: how far below the main line its line
 * is (0 on the main line; `lineOffsets`), the same in every band.
 */
interface OnLine {
  readonly y: number;
}

/** A stretch on the strip (`MapStrip`). */
export interface StripRun extends OnLine {
  readonly start: number;
  readonly end: number;
  readonly x0: number;
  readonly x1: number;
  readonly bookmarks: readonly number[];
}

/** A decision node on the strip. */
export interface StripNode extends OnLine {
  readonly index: number;
  readonly prompt: string;
  readonly afterIndex: number;
  readonly x: number;
  readonly routes: readonly number[];
}

/** A route pill on the strip, its line ending at `endX` at its height. */
export interface StripRoute extends OnLine {
  readonly decision: number;
  readonly route: number;
  readonly label: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly outcome: RouteOutcome;
  readonly x: number;
  readonly endX: number;
}

/** A connector on the strip: from (ax, ay) to (bx, by) (`RawLink`). */
export interface StripLink {
  readonly kind: "branch" | "join" | "return";
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}

/** A join dot or end mark on the strip. */
export interface StripPoint extends OnLine {
  readonly x: number;
}

/**
 * The tree laid out as one long strip, before it is cut into bands
 * (`cutBands`): every element at an x from the story's start (0) and a
 * height below the main line (0), its line's (`lineOffsets`), which a band
 * keeps. With it, where a band may be cut and what each band would hold,
 * so cutting it at any width is linear in what it draws. Laid out once per
 * manifest and set of bookmarked screens (`layOutStrip`); never changed
 * after.
 */
export interface MapStrip {
  readonly itemCount: number;
  /** How many decisions the machine resolved (placed or not). */
  readonly decisionCount: number;
  readonly decisionById: ReadonlyMap<string, number>;
  /** Where its drawing ends on the right. */
  readonly length: number;
  /** Its stretches, by `start`. */
  readonly runs: readonly StripRun[];
  /** Its decision nodes, by machine index. */
  readonly nodes: readonly StripNode[];
  /** Its route pills (what `StripNode.routes` and `MapModel.routes` index). */
  readonly routes: readonly StripRoute[];
  readonly links: readonly StripLink[];
  readonly joins: readonly StripPoint[];
  readonly ends: readonly StripPoint[];
  /** The main line's end mark, by position in `ends`; -1 when none. */
  readonly storyEnd: number;
  /**
   * Where a band cut may fall: [from, to] pairs, ascending and apart (a pair
   * may be a single point: the middle of the gap between two cards).
   * Everything a cut there crosses is a straight horizontal line.
   */
  readonly windows: Float64Array;
  /**
   * What a band holds: for every element (but pills and branch curves,
   * which their routes' first stretches stand for, reaching less far), how
   * many windows lie before its left and right ends (no end lies in one)
   * and its lowest line's height. A band holds what lies between its cuts'
   * windows.
   */
  readonly held: {
    readonly w0: Int32Array;
    readonly w1: Int32Array;
    readonly y: Float64Array;
    /** How far it is drawn above and below its line (`DRAWN_REACH`). */
    readonly up: Float64Array;
    readonly down: Float64Array;
  };
  /**
   * Every card: how many windows lie before it, its line's height, and how
   * far it is drawn below its line (above: `DRAWN_REACH.card`).
   */
  readonly cards: {
    readonly w: Int32Array;
    readonly y: Float64Array;
    readonly down: Float64Array;
  };
}

/**
 * Lays the decision tree out as one strip (see `MapStrip`), with a card's
 * room for each bookmarked item in `bookmarkItems` (item indices; one per
 * bookmark, so a screen bookmarked twice is listed twice). Pure; call once
 * per manifest and set of bookmarked screens, then `cutBands` at each
 * width.
 *
 * A bookmark sits on the stretch holding its screen. A screen no stretch
 * holds (say, one between a choice's routes that no route covers) goes at
 * the end of the stretch `runAt` names for it, the nearest one before it,
 * as the "you are here" marker does: never dropped from the map.
 */
export function layOutStrip(
  items: readonly Item[],
  branches: readonly Branch[] | undefined,
  bookmarkItems: readonly number[] = [],
): MapStrip {
  const valid = bookmarkItems.filter(
    (i) => Number.isInteger(i) && i >= 0 && i < items.length,
  );
  const strip = stripOf(items, branches, valid);
  // Stretches never depend on the bookmarks (only their lengths do), so
  // a second pass with the stray screens moved onto a stretch's last one
  // gives the same stretches; it runs only when there is a stray.
  const held = (i: number) => {
    const run = runAt(strip.runs, i);
    return run !== undefined && i >= run.start && i <= run.end;
  };
  if (valid.every(held)) return strip;
  return stripOf(
    items,
    branches,
    valid.map((i) => {
      if (held(i)) return i;
      const run = runAt(strip.runs, i);
      if (run === undefined) return i;
      return i < run.start ? run.start : run.end;
    }),
  );
}

function stripOf(
  items: readonly Item[],
  branches: readonly Branch[] | undefined,
  bookmarkItems: readonly number[],
): MapStrip {
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

  // Laid out on rows (y at whole multiples of rowH), each element on a
  // line: the main line (0), or a route's that leaves its decision's line
  // for a row below (a decision's first route carries its line on). Once
  // laid out, every line gets its height (`lineOffsets`) and each element
  // its line's.
  type Laid<T> = Mutable<T> & { line: number };
  const runs: Laid<StripRun>[] = [];
  const mapDecisions: Laid<StripNode>[] = [];
  const routes: Laid<StripRoute>[] = [];
  const raw: (RawLink & { lineA: number; lineB: number })[] = [];
  const joins: Laid<StripPoint>[] = [];
  const ends: Laid<StripPoint>[] = [];
  const placed = new Set<number>();
  let lineCount = 1;

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

  const addRun = (
    start: number,
    end: number,
    x: number,
    y: number,
    ln: number,
  ) => {
    const bookmarks = marked.slice(
      firstAtOrAfter(start),
      firstAtOrAfter(end + 1),
    );
    const w =
      bookmarks.length === 0
        ? g.runW
        : bookmarks.length * CARD.pitch - CARD.gap + 2 * CARD.inset;
    runs.push({ start, end, x0: x, x1: x + w, y, bookmarks, line: ln });
    return x + w;
  };

  // One line of story from item `start` to `end` inside decision `parent`'s
  // route, starting at world x, on row centre y, on line `ln`.
  function line(
    start: number,
    end: number,
    parent: number,
    x0: number,
    y: number,
    ln: number,
  ): Block {
    let x = x0;
    let rows = 1;
    let belowLeft = Number.POSITIVE_INFINITY;
    let idx = start;
    for (const decision of children.get(parent) ?? []) {
      if (decision.afterIndex < idx || decision.afterIndex > end) continue;
      if (placed.has(decision.index)) continue;
      x = addRun(idx, decision.afterIndex, x, y, ln);
      const block = layoutDecision(decision, x, y, ln);
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
    if (idx <= end) x = addRun(idx, end, x, y, ln);
    return { x, rows, belowLeft };
  }

  function layoutDecision(
    decision: ResolvedDecision,
    x: number,
    y: number,
    ln: number,
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
      const own = routeIdx === 0 ? ln : lineCount++;
      const before = mark();
      const inner = line(
        route.startIndex,
        route.endIndex,
        decision.index,
        bx + g.routeW,
        y + bottom * g.rowH,
        own,
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
      raw.push({
        kind: "branch",
        ax: x + g.decW,
        ay: y,
        bx,
        by: ry,
        lineA: ln,
        lineB: own,
      });
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
        line: own,
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
        ends.push({ x: endX + END_MARK_DX, y: routeY, line: route.line });
        continue;
      }
      joined = true;
      raw.push({
        kind: route.outcome === "continues" ? "join" : "return",
        ax: endX,
        ay: routeY,
        bx: joinX,
        by: y,
        lineA: route.line,
        lineB: ln,
      });
    }
    const next = continuationOf(decision);
    if (joined || next > decision.afterIndex)
      joins.push({ x: joinX, y, line: ln });
    mapDecisions.push({
      index: decision.index,
      prompt: decision.prompt,
      afterIndex: decision.afterIndex,
      x,
      y,
      routes: routeKeys,
      line: ln,
    });
    const rows = Math.max(1, bottom);
    return {
      x: joinX,
      rows,
      belowLeft: rows > 1 ? x + g.decW : Number.POSITIVE_INFINITY,
    };
  }

  // The main line along row 0 from x 0, one top-level decision after
  // another, the story's tail and end mark after the last.
  const last = items.length - 1;
  let x = 0;
  let idx = 0;
  for (const decision of children.get(-1) ?? []) {
    if (decision.afterIndex < idx || decision.afterIndex > last) continue;
    if (placed.has(decision.index)) continue;
    x = addRun(idx, decision.afterIndex, x, 0, 0);
    x = layoutDecision(decision, x, 0, 0).x;
    const next = continuationOf(decision);
    if (next <= decision.afterIndex || next > last) {
      idx = last + 1;
      break;
    }
    idx = next;
  }
  let storyEnd = -1;
  if (idx <= last) {
    x = addRun(idx, last, x, 0, 0);
    storyEnd = ends.length;
    ends.push({ x: x + END_MARK_DX, y: 0, line: 0 });
  }

  // Each line's row (where its pill was laid out), the x it spans (from
  // its decision's box, over the branch curves, to its join or past its
  // end mark by the "you are here" ring that can sit there) and its cards;
  // then its height, and every element's.
  const rows = new Int32Array(lineCount);
  const from = new Float64Array(lineCount).fill(Number.POSITIVE_INFINITY);
  const to = new Float64Array(lineCount).fill(Number.NEGATIVE_INFINITY);
  const span = (ln: number, x0: number, x1: number) => {
    if (x0 < from[ln]) from[ln] = x0;
    if (x1 > to[ln]) to[ln] = x1;
  };
  const cardRanges: number[] = [];
  const ring = DRAWN_REACH.card - CARD.h / 2;
  for (const r of runs) {
    span(r.line, r.x0, r.x1);
    if (r.bookmarks.length > 0)
      cardRanges.push(
        r.line,
        r.x0 + CARD.inset - ring,
        r.x1 - CARD.inset + ring,
      );
  }
  for (const d of mapDecisions) span(d.line, d.x, d.x + g.decW);
  for (const r of routes) {
    rows[r.line] = Math.round(r.y / g.rowH);
    span(r.line, r.x - g.gap, r.x + g.routeW);
  }
  for (const l of raw) if (l.kind !== "branch") span(l.lineA, l.ax, l.bx);
  for (const p of joins) span(p.line, p.x - 5, p.x + 5);
  for (const p of ends) span(p.line, p.x - 7, p.x + DRAWN_REACH.here);
  rows[0] = 0;
  const offset = lineOffsets(rows, from, to, cardRanges);
  for (const list of [runs, mapDecisions, routes, joins, ends])
    for (const e of list) e.y = offset[e.line];
  for (const l of raw) {
    l.ay = offset[l.lineA];
    l.by = offset[l.lineB];
  }
  runs.sort((a, b) => a.start - b.start);
  mapDecisions.sort((a, b) => a.index - b.index);
  const stripRuns: readonly StripRun[] = runs;
  const nodes: readonly StripNode[] = mapDecisions;
  const stripRoutes: readonly StripRoute[] = routes;
  const links: readonly StripLink[] = raw;
  const stripJoins: readonly StripPoint[] = joins;
  const stripEnds: readonly StripPoint[] = ends;

  // What a band holds (x extent, lowest line's height), and where a cut
  // may not fall: open x ranges, so two touching ones (two cards' halves
  // of the gap between them) leave the point they share. Flat lists, as
  // long as they can get.
  let cardCount = 0;
  for (const r of stripRuns) cardCount += r.bookmarks.length;
  const elements = nodes.length + stripJoins.length + stripEnds.length;
  const held = new Float64Array(
    4 * (1 + stripRuns.length + links.length + elements),
  );
  const blocked = new Float64Array(
    2 * (1 + 2 * stripRuns.length + cardCount + 2 * links.length + elements),
  );
  const cards = new Float64Array(3 * cardCount);
  let nHeld = 0;
  let nBlocked = 0;
  let nCards = 0;
  // Each with how far it is drawn above and below its line.
  const hold = (x0: number, x1: number, y: number, reach: number) => {
    const at = 4 * nHeld;
    held[at] = x0;
    held[at + 1] = x1;
    held[at + 2] = y;
    held[at + 3] = reach;
    nHeld += 1;
  };
  const block = (x0: number, x1: number) => {
    blocked[2 * nBlocked] = x0;
    blocked[2 * nBlocked + 1] = x1;
    nBlocked += 1;
  };
  const reach = DRAWN_REACH;
  hold(-6, 6, 0, reach.here);
  block(-6 - CUT_CLEAR, 6 + CUT_CLEAR);
  // A stretch's ends need no range of their own: it starts after a pill,
  // a join or the start dot, and ends at a node, an end mark (where no line
  // goes on) or a connector's start, which has one.
  for (const r of stripRuns) {
    // Its count above it (12 px type) lies inside the ring's reach.
    hold(r.x0, r.x1, r.y, reach.here);
    const screens = r.end - r.start + 1;
    const n = r.bookmarks.length;
    if (n === 0) {
      const mid = (r.x0 + r.x1) / 2;
      const half = (countText(screens, 0).length * COUNT_EM * 12) / 2;
      block(mid - half - CUT_CLEAR, mid + half + CUT_CLEAR);
      continue;
    }
    for (let j = 0; j < n; j += 1) {
      const left = r.x0 + CARD.inset + j * CARD.pitch;
      cards[3 * nCards] = left;
      cards[3 * nCards + 1] = r.y;
      // The first card has the stretch's count line under it.
      cards[3 * nCards + 2] = j === 0 ? reach.cardCount : reach.card;
      nCards += 1;
      block(left - CARD.gap / 2, left + CARD.w + CARD.gap / 2);
    }
    const text = countText(screens, n).length * COUNT_EM * 11;
    block(r.x0 + CARD.inset - CUT_CLEAR, r.x0 + CARD.inset + text + CUT_CLEAR);
  }
  // A decision's box, its branch curves and its pills (all at one x) as
  // one range.
  const pillsEnd = g.decW + g.gap + g.routeW;
  for (const d of nodes) {
    hold(d.x, d.x + g.decW, d.y, reach.decision);
    block(d.x - CUT_CLEAR, d.x + pillsEnd + CUT_CLEAR);
  }
  // A pill and its branch curve need no record: its route's first stretch
  // starts at the pill, on its line, in the same band.
  for (const l of links) {
    if (l.kind === "branch") continue;
    hold(l.ax, l.bx, Math.max(l.ay, l.by), reach.tick);
    block(l.ax - CUT_JOINT, l.ax + CUT_JOINT);
    if (l.ay !== l.by) block(l.bx - TURN_R - CUT_CLEAR, l.bx + CUT_CLEAR);
  }
  for (const p of stripJoins) {
    hold(p.x - 5, p.x + 5, p.y, reach.join);
    block(p.x - 5 - CUT_CLEAR, p.x + 5 + CUT_CLEAR);
  }
  for (const p of stripEnds) {
    hold(p.x - 7, p.x + 7, p.y, reach.here);
    block(p.x - 7 - CUT_CLEAR, p.x + 7 + CUT_CLEAR);
  }
  let length = 6;
  for (let i = 0; i < nHeld; i += 1)
    if (held[4 * i + 1] > length) length = held[4 * i + 1];
  // The windows: the free points between blocked ranges, from their
  // starts and their ends each in order (an end first at a tie: a point two
  // ranges only touch is free).
  const starts = new Float64Array(nBlocked);
  const stops = new Float64Array(nBlocked);
  for (let i = 0; i < nBlocked; i += 1) {
    starts[i] = blocked[2 * i];
    stops[i] = blocked[2 * i + 1];
  }
  starts.sort();
  stops.sort();
  const windows: number[] = [];
  let open = 0;
  let free = Number.NEGATIVE_INFINITY;
  for (let i = 0, j = 0; i < nBlocked; )
    if (j < nBlocked && stops[j] <= starts[i]) {
      open -= 1;
      if (open === 0) free = stops[j];
      j += 1;
    } else {
      if (open === 0 && free > 0) windows.push(free, starts[i]);
      open += 1;
      i += 1;
    }
  // Every element's ends, and every card's left edge, lie in blocked
  // ranges, so how many windows come before one says which band holds it
  // once the cuts are known (`planBands`).
  const nWindows = windows.length / 2;
  const slot = (x: number) => {
    let lo = 0;
    let hi = nWindows;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (windows[2 * mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const heldColumns = {
    w0: new Int32Array(nHeld),
    w1: new Int32Array(nHeld),
    y: new Float64Array(nHeld),
    up: new Float64Array(nHeld),
    down: new Float64Array(nHeld),
  };
  for (let i = 0; i < nHeld; i += 1) {
    heldColumns.w0[i] = slot(held[4 * i]);
    heldColumns.w1[i] = slot(held[4 * i + 1]);
    heldColumns.y[i] = held[4 * i + 2];
    heldColumns.up[i] = held[4 * i + 3];
    heldColumns.down[i] = held[4 * i + 3];
  }
  const cardColumns = {
    w: new Int32Array(nCards),
    y: new Float64Array(nCards),
    down: new Float64Array(nCards),
  };
  for (let i = 0; i < nCards; i += 1) {
    cardColumns.w[i] = slot(cards[3 * i]);
    cardColumns.y[i] = cards[3 * i + 1];
    cardColumns.down[i] = cards[3 * i + 2];
  }

  const decisionById = new Map<string, number>();
  for (const decision of decisions)
    decisionById.set(decision.id, decision.index);
  return {
    itemCount: items.length,
    decisionCount: decisions.length,
    decisionById,
    length,
    runs: stripRuns,
    nodes,
    routes: stripRoutes,
    links,
    joins: stripJoins,
    ends: stripEnds,
    storyEnd,
    windows: Float64Array.from(windows),
    held: heldColumns,
    cards: cardColumns,
  };
}

/** A line's room above and below it where it holds no card. */
const LINE_ROOM = MAP_GEOMETRY.rowH / 2;

/**
 * Each line's height below the main line (docs/plan.md Phase 42), from
 * `rows` (the row each line was laid out on: line 0, the main line, on row
 * 0), the x each spans (`from`..`to`) and its cards (`cards`: line, x0, x1
 * in threes). A line takes `LINE_ROOM` above and below it, and over a card
 * `CARD_ABOVE` more above and `CARD_BELOW` more below; it sits just low
 * enough that its room clears, at every x it spans, the room of the lines
 * above it there. So two lines overlapping in x are `rowH` apart unless a
 * card on one of them lies over the other. A skyline, row by row: the
 * lowest room so far at each x (a max tree over the spans' ends), read
 * over a line's span and raised to its own room. Lines on one row never
 * overlap in x (the layout keeps them apart), and those on lower rows lie
 * under them, so the rows' order is the lines' order down. Linear in lines
 * and cards, times a sort and a logarithm.
 */
function lineOffsets(
  rows: Int32Array,
  from: Float64Array,
  to: Float64Array,
  cards: readonly number[],
): Float64Array {
  const n = rows.length;
  const offset = new Float64Array(n);
  // Each line's cards, by x: a linked list through `nextCard`.
  const nCards = cards.length / 3;
  const firstCard = new Int32Array(n).fill(-1);
  const nextCard = new Int32Array(nCards).fill(-1);
  const byX = Array.from({ length: nCards }, (_, i) => i).sort(
    (a, b) => cards[3 * b + 1] - cards[3 * a + 1],
  );
  for (const c of byX) {
    const ln = cards[3 * c];
    nextCard[c] = firstCard[ln];
    firstCard[ln] = c;
  }
  // The x every span and card starts and ends at, in order: the tree's
  // leaves are the gaps between them.
  const xs: number[] = [];
  for (let ln = 0; ln < n; ln += 1)
    if (from[ln] < to[ln]) xs.push(from[ln], to[ln]);
  for (let c = 0; c < nCards; c += 1)
    xs.push(cards[3 * c + 1], cards[3 * c + 2]);
  const sorted = Float64Array.from(xs).sort();
  let m = 0;
  for (let i = 0; i < sorted.length; i += 1)
    if (m === 0 || sorted[i] !== sorted[m - 1]) sorted[m++] = sorted[i];
  const at = (x: number) => {
    let lo = 0;
    let hi = m - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  let size = 1;
  while (size < m) size *= 2;
  // `low[k]`: the lowest room raised anywhere under node k; `all[k]`: the
  // room raised over all of it. Raising only ever lowers a room (a line
  // sits below the rooms it reads), so a raise is a max.
  const low = new Float64Array(2 * size).fill(Number.NEGATIVE_INFINITY);
  const all = new Float64Array(2 * size).fill(Number.NEGATIVE_INFINITY);
  const read = (
    k: number,
    k0: number,
    k1: number,
    a: number,
    b: number,
  ): number => {
    if (b <= k0 || k1 <= a) return Number.NEGATIVE_INFINITY;
    if (a <= k0 && k1 <= b) return low[k];
    const mid = (k0 + k1) >> 1;
    return Math.max(
      all[k],
      read(2 * k, k0, mid, a, b),
      read(2 * k + 1, mid, k1, a, b),
    );
  };
  const raise = (
    k: number,
    k0: number,
    k1: number,
    a: number,
    b: number,
    v: number,
  ) => {
    if (b <= k0 || k1 <= a) return;
    if (v > low[k]) low[k] = v;
    if (a <= k0 && k1 <= b) {
      if (v > all[k]) all[k] = v;
      return;
    }
    const mid = (k0 + k1) >> 1;
    raise(2 * k, k0, mid, a, b, v);
    raise(2 * k + 1, mid, k1, a, b, v);
  };
  // A line's pieces, left to right: between its cards (no card), and its
  // cards; `visit` gets each piece's leaves and whether it is a card's.
  const pieces = (
    ln: number,
    visit: (a: number, b: number, card: boolean) => void,
  ) => {
    let x = from[ln];
    for (let c = firstCard[ln]; c >= 0; c = nextCard[c]) {
      const c0 = Math.max(x, cards[3 * c + 1]);
      const c1 = Math.min(to[ln], cards[3 * c + 2]);
      if (c0 > x) visit(at(x), at(c0), false);
      if (c1 > c0) visit(at(c0), at(c1), true);
      x = Math.max(x, c1);
    }
    if (to[ln] > x) visit(at(x), at(to[ln]), false);
  };
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => rows[a] - rows[b] || from[a] - from[b],
  );
  for (const ln of order) {
    if (!(from[ln] < to[ln])) {
      offset[ln] = rows[ln] * MAP_GEOMETRY.rowH;
      continue;
    }
    let y = Number.NEGATIVE_INFINITY;
    if (ln !== 0)
      pieces(ln, (a, b, card) => {
        const above = read(1, 0, size, a, b);
        const up = card ? LINE_ROOM + CARD_ABOVE : LINE_ROOM;
        if (above + up > y) y = above + up;
      });
    if (ln === 0 || y === Number.NEGATIVE_INFINITY)
      y = rows[ln] * MAP_GEOMETRY.rowH;
    offset[ln] = y;
    pieces(ln, (a, b, card) =>
      raise(1, 0, size, a, b, y + (card ? LINE_ROOM + CARD_BELOW : LINE_ROOM)),
    );
  }
  return offset;
}

/**
 * Where the bands start along the strip for bands `room` wide: band 0 at
 * the story's start (0), each next one at the furthest window point within
 * `room` of the last; where none lies within it, at the first one past it
 * (that band is wider than asked). A window the last cut lies in is used
 * again only for a full band, so no band holds nothing but lines. Linear
 * in windows (and bands); always ends, every cut being past the last.
 */
function cutPoints(
  windows: Float64Array,
  length: number,
  room: number,
): { cuts: number[]; at: number[] } {
  const cuts = [0];
  // The window each cut lies in (-1 for band 0's start).
  const where = [-1];
  const n = windows.length / 2;
  let c = 0;
  let at = -1;
  let next = 0;
  while (length > c + room) {
    const limit = c + room;
    while (next < n && windows[2 * next] <= limit) next += 1;
    const last = next - 1;
    let x: number;
    if (last > at) {
      x = Math.min(windows[2 * last + 1], limit);
      at = last;
    } else if (at >= 0 && windows[2 * at + 1] >= limit) x = limit;
    else if (at + 1 < n) {
      at += 1;
      x = windows[2 * at];
    } else break;
    cuts.push(x);
    where.push(at);
    c = x;
  }
  return { cuts, at: where };
}

/** The band of strip x: the last one starting before it. */
function bandAt(from: readonly number[], x: number): number {
  let lo = 0;
  let hi = from.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (from[mid] < x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** How a strip is cut into bands at one width (`planBands`). */
interface BandPlan {
  /** Where each band starts and ends along the strip. */
  readonly from: readonly number[];
  readonly to: readonly number[];
  /** Each band's main line, and the top and bottom of what it draws. */
  readonly mainY: readonly number[];
  readonly top: readonly number[];
  readonly bottom: readonly number[];
  readonly width: number;
  readonly height: number;
}

/**
 * The bands a strip is cut into for a layout `width` wide, padding
 * included: where each starts and ends, and where its main line sits. A
 * band's top and bottom are the extent of what it draws (`DRAWN_REACH`),
 * every line at its strip height below the band's main line, and each band
 * sits `wrapGap` under the one before, between those. Linear in what the
 * strip holds.
 */
function planBands(strip: MapStrip, width: number): BandPlan {
  const g = MAP_GEOMETRY;
  const room = Math.max(MIN_BAND_ROOM, width - 2 * g.pad);
  const cut = cutPoints(strip.windows, strip.length, room);
  const from = cut.cuts;
  const bands = from.length;
  const to = from.map((_, b) => (b + 1 < bands ? from[b + 1] : strip.length));
  // The band past the first w windows: the cuts in them, counted.
  const bandPast = new Int32Array(strip.windows.length / 2 + 1);
  for (let b = 1; b < bands; b += 1) bandPast[cut.at[b] + 1] += 1;
  for (let w = 1; w < bandPast.length; w += 1) bandPast[w] += bandPast[w - 1];
  // Each band's drawn top and bottom, from its main line: what it holds
  // (only a straight line crosses a cut: it is in every band it crosses).
  const above = new Float64Array(bands).fill(Number.POSITIVE_INFINITY);
  const below = new Float64Array(bands).fill(Number.NEGATIVE_INFINITY);
  const { w0, w1, up, down } = strip.held;
  const lineY = strip.held.y;
  for (let i = 0; i < w0.length; i += 1) {
    const last = bandPast[w1[i]];
    const top = lineY[i] - up[i];
    const bottom = lineY[i] + down[i];
    for (let b = bandPast[w0[i]]; b <= last; b += 1) {
      if (top < above[b]) above[b] = top;
      if (bottom > below[b]) below[b] = bottom;
    }
  }
  const cardsIn = strip.cards;
  for (let i = 0; i < cardsIn.w.length; i += 1) {
    const b = bandPast[cardsIn.w[i]];
    const cy = cardsIn.y[i];
    if (cy - DRAWN_REACH.card < above[b]) above[b] = cy - DRAWN_REACH.card;
    if (cy + cardsIn.down[i] > below[b]) below[b] = cy + cardsIn.down[i];
  }
  // Each band under the one before, wrapGap between what they draw.
  const mainY: number[] = [];
  const top: number[] = [];
  const bottom: number[] = [];
  let y = g.pad;
  let widest = 0;
  for (let b = 0; b < bands; b += 1) {
    if (above[b] > below[b]) {
      above[b] = -g.rowH / 2;
      below[b] = g.rowH / 2;
    }
    top.push(y);
    mainY.push(y - above[b]);
    bottom.push(y - above[b] + below[b]);
    y = bottom[b] + g.wrapGap;
    widest = Math.max(widest, to[b] - from[b]);
  }
  return {
    from,
    to,
    mainY,
    top,
    bottom,
    width: widest + 2 * g.pad,
    height: bottom[bands - 1] + g.pad,
  };
}

/**
 * The size of the layout `cutBands` makes of `strip` at `width`, its
 * padding included, without making it: what a chooser of widths compares.
 */
export function bandsShape(
  strip: MapStrip,
  width: number,
): { width: number; height: number; bands: number } {
  const plan = planBands(strip, width);
  return { width: plan.width, height: plan.height, bands: plan.from.length };
}

/**
 * The band width (the layout's, its padding included) at which the whole
 * of `strip` shows largest in a vw x vh view: Fit's (docs/plan.md Phase
 * 41, "Two views"), the width and the scale chosen together. A width is
 * scored by the scale at which its layout's size, less its padding (plus
 * the ticks' reach past the bands' edges where it is cut), fits the view
 * less `FIT_MARGIN_PX` a side, up to `MAX_SCALE`; a tie goes to
 * the wider width (fewer bands, so a small map stays on one line once it
 * reaches 3x). First, for one band, two, three and so on, the narrowest
 * width that still takes that many (the bands come out even, the layout
 * as narrow as that count allows); each band more makes the layout
 * narrower and deeper, so once the scale its depth allows has fallen short
 * of the best twice, no later count can win. Then, as where a cut falls
 * moves cards and deep segments between bands (and so their heights), a
 * few widths inside the best count's range and its neighbours' are tried
 * too. Each count is a binary search over cut counts (linear in windows);
 * each width tried one `bandsShape`. Pure.
 */
export function fitWidth(strip: MapStrip, vw: number, vh: number): number {
  const pad2 = 2 * MAP_GEOMETRY.pad;
  const m2 = 2 * FIT_MARGIN_PX;
  const length = strip.length;
  const across = Math.max(1, vw - m2);
  const down = Math.max(1, vh - m2);
  const count = (room: number) =>
    cutPoints(strip.windows, length, room).cuts.length;
  let best = length + pad2;
  let bestScale = 0;
  // The scale bands `room` wide show the map at, and that its depth allows.
  // Cut, the ticks reach past the bands' edges on both sides (`tickBox`).
  const ticks = 2 * (TICK.reach + TICK.lean);
  const score = (room: number) => {
    const shape = bandsShape(strip, room + pad2);
    const deep = down / Math.max(1, shape.height - pad2);
    const wide = shape.width - pad2 + (shape.bands > 1 ? ticks : 0);
    const scale = Math.min(MAX_SCALE, across / Math.max(1, wide), deep);
    if (scale > bestScale * (1 + 1e-9)) {
      best = room + pad2;
      bestScale = scale;
    }
    return { scale, deep };
  };
  // Each count's narrowest room, widest (one band) first.
  const rooms: number[] = [];
  const most = count(MIN_BAND_ROOM);
  let short = 0;
  let at = -1;
  for (let k = 1; k <= most && short < 2; k += 1) {
    let lo = Math.max(MIN_BAND_ROOM, length / k);
    let hi = Math.max(lo, length);
    if (count(lo) <= k) hi = lo;
    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      if (count(mid) <= k) hi = mid;
      else lo = mid;
    }
    // No width takes exactly k bands: the same layout as a count before.
    if (hi === rooms[rooms.length - 1]) continue;
    rooms.push(hi);
    const was = bestScale;
    const { deep } = score(hi);
    if (bestScale > was) {
      at = rooms.length - 1;
      short = 0;
    } else if (deep < bestScale) short += 1;
  }
  // Inside the best count's range of widths, and its neighbours': from
  // its narrowest up to the next fewer bands' narrowest (one band's is
  // the whole strip: wider is the same layout).
  const tries = 4;
  for (let i = Math.max(1, at - 1); i <= at + 1 && i < rooms.length; i += 1)
    for (let j = 1; j <= tries; j += 1)
      score(rooms[i] * (rooms[i - 1] / rooms[i]) ** (j / (tries + 1)));
  return best;
}

/**
 * The strip cut into bands for a layout `width` wide, its padding included
 * (at scale 1 that many CSS pixels; a band wider than asked only where no cut
 * lies within it): each band starts at the left padding, under the one
 * before, and everything is placed in the band that holds it, a line a cut
 * crosses as a piece per band with a "continues" tick pair at each cut.
 * Pure; linear in what the strip holds.
 */
export function cutBands(strip: MapStrip, width: number): MapModel {
  const g = MAP_GEOMETRY;
  const plan = planBands(strip, width);
  const { from, to } = plan;
  const wx = (b: number, x: number) => x - from[b] + g.pad;
  const wy = (b: number, y: number) => plan.mainY[b] + y;
  const bandOf = (x: number) => bandAt(from, x);
  const ticks: MapTick[] = [];

  const runs: MapRun[] = strip.runs.map((r, i) => {
    const first = bandOf(r.x0);
    const last = bandOf(r.x1);
    const pieces: MapPiece[] = [];
    for (let b = first; b <= last; b += 1) {
      const a = b === first ? r.x0 : from[b];
      const z = b === last ? r.x1 : to[b];
      const y = wy(b, r.y);
      pieces.push({ x0: wx(b, a), x1: wx(b, z), y, at: a - r.x0 });
      if (b > first)
        ticks.push({ x: g.pad, y, side: "in", line: "run", run: i, band: b });
      if (b < last)
        ticks.push({
          x: wx(b, z),
          y,
          side: "out",
          line: "run",
          run: i,
          band: b,
        });
    }
    return {
      start: r.start,
      end: r.end,
      x0: pieces[0].x0,
      x1: pieces[0].x1,
      y: pieces[0].y,
      bookmarks: r.bookmarks,
      length: r.x1 - r.x0,
      pieces,
    };
  });
  const decisions: MapDecision[] = strip.nodes.map((d) => {
    const b = bandOf(d.x);
    return {
      index: d.index,
      prompt: d.prompt,
      afterIndex: d.afterIndex,
      x: wx(b, d.x),
      y: wy(b, d.y),
      routes: d.routes,
    };
  });
  const routes: MapRoute[] = strip.routes.map((r) => {
    const b = bandOf(r.x);
    const e = bandOf(r.endX);
    return {
      decision: r.decision,
      route: r.route,
      label: r.label,
      startIndex: r.startIndex,
      endIndex: r.endIndex,
      outcome: r.outcome,
      x: wx(b, r.x),
      y: wy(b, r.y),
      endX: wx(e, r.endX),
      endY: wy(e, r.y),
    };
  });
  // A branch curve is never cut. A join or return line is cut only along
  // its straight run: a straight piece per band it crosses, its turn up
  // to the decision's row in the last.
  const links: MapLink[] = [];
  for (const l of strip.links) {
    const first = bandOf(l.ax);
    const last = l.kind === "branch" ? first : bandOf(l.bx);
    for (let b = first; b <= last; b += 1) {
      const a = b === first ? l.ax : from[b];
      const ay = wy(b, l.ay);
      if (l.kind !== "branch" && b > first)
        ticks.push({
          x: g.pad,
          y: ay,
          side: "in",
          line: l.kind,
          run: -1,
          band: b,
        });
      if (l.kind !== "branch" && b < last) {
        links.push(straightLink(l.kind, wx(b, a), wx(b, to[b]), ay));
        ticks.push({
          x: wx(b, to[b]),
          y: ay,
          side: "out",
          line: l.kind,
          run: -1,
          band: b,
        });
        continue;
      }
      links.push(
        linkOf({
          kind: l.kind,
          ax: wx(b, a),
          ay,
          bx: wx(b, l.bx),
          by: wy(b, l.by),
        }),
      );
    }
  }
  const pointOf = (p: StripPoint) => {
    const b = bandOf(p.x);
    return { x: wx(b, p.x), y: wy(b, p.y) };
  };
  const joins = strip.joins.map(pointOf);
  const ends = strip.ends.map(pointOf);
  const start = { x: g.pad, y: plan.mainY[0] };
  const bands: MapBand[] = from.map((_, b) => ({
    x0: g.pad,
    y0: plan.top[b],
    x1: wx(b, to[b]),
    y1: plan.bottom[b],
    start: from[b],
    end: to[b],
    line: plan.mainY[b],
  }));
  const decisionAt: (MapDecision | undefined)[] = Array.from(
    { length: strip.decisionCount },
    () => undefined,
  );
  for (const node of decisions) decisionAt[node.index] = node;
  return {
    runs,
    decisions,
    routes,
    links,
    ticks,
    joins,
    ends,
    start,
    storyEnd: strip.storyEnd >= 0 ? ends[strip.storyEnd] : null,
    bounds: boundsOf(runs, decisions, routes, links, joins, ends, start, ticks),
    width: plan.width,
    height: plan.height,
    bands,
    itemCount: strip.itemCount,
    decisionAt,
    decisionById: strip.decisionById,
  };
}

/** Above a stretch's line, its screen count's text reaches this far. */
const COUNT_REACH = 16;

/** The world box a tick's stub and slash lie in. */
export function tickBox(tick: MapTick): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} {
  const span = TICK.reach + TICK.lean;
  const x0 = tick.side === "out" ? tick.x : tick.x - span;
  return { x0, y0: tick.y - TICK.rise, x1: x0 + span, y1: tick.y + TICK.rise };
}

/**
 * A tick's path data (`TICK`): its line's stub out past the band's edge
 * (right of an out tick, left of an in tick), drawn as the line is, and
 * the slash across the stub's end, drawn solid in the line's colour and
 * weight (render/branchmap.ts `linesMarkup`), so a dotted or dashed line's
 * tick reads as a tick too.
 */
export function tickPaths(tick: MapTick): { stub: string; slash: string } {
  const { reach, rise, lean } = TICK;
  const out = tick.side === "out";
  const cx = out ? tick.x + reach : tick.x - reach;
  return {
    stub: `M${out ? tick.x : cx} ${tick.y}h${reach}`,
    slash: `M${cx - lean} ${tick.y + rise}l${2 * lean} ${-2 * rise}`,
  };
}

/** The world box everything drawn lies in (see `MapModel.bounds`). */
function boundsOf(
  runs: readonly MapRun[],
  decisions: readonly MapDecision[],
  routes: readonly MapRoute[],
  links: readonly MapLink[],
  joins: readonly { x: number; y: number }[],
  ends: readonly { x: number; y: number }[],
  start: { x: number; y: number },
  ticks: readonly MapTick[],
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
    for (const p of r.pieces)
      if (r.bookmarks.length === 0) add(p.x0, p.y - COUNT_REACH, p.x1, p.y);
      else add(p.x0, p.y - CARD.h / 2, p.x1, p.y + CARD_COUNT_DY + 4);
  for (const d of decisions)
    add(d.x, d.y - g.decH / 2, d.x + g.decW, d.y + g.decH / 2);
  for (const r of routes)
    add(r.x, r.y - g.routeH / 2, r.x + g.routeW, r.y + g.routeH / 2);
  for (const l of links) add(l.x0, l.y0, l.x1, l.y1);
  for (const p of joins) add(p.x - 5, p.y - 5, p.x + 5, p.y + 5);
  for (const p of ends) add(p.x - 7, p.y - 7, p.x + 7, p.y + 7);
  for (const t of ticks) {
    const b = tickBox(t);
    add(b.x0, b.y0, b.x1, b.y1);
  }
  return box;
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
  /** The words shown (Phase 54); absent: the manifest's. */
  readonly words?: MapWords;
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
  /** The words shown (`MapReader.words`); absent: the manifest's. */
  readonly words?: MapWords;
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
    ...(reader.words === undefined ? {} : { words: reader.words }),
  };
}

/**
 * The placeholders shown, with Spoilers off, for text the reader has not
 * met: the catalogue's `map.hidden.prompt` and `map.hidden.route`.
 */

/** A decision's question as the map may show it (full, untruncated). */
export function promptText(
  model: MapModel,
  marks: MapMarks,
  decision: number,
): string {
  if (marks.hidden[decision]) return t("map.hidden.prompt");
  return promptShown(model, marks, decision)?.text ?? "";
}

/**
 * A decision's question in the shown language and the language it is in,
 * or null while it is hidden (or not in the model).
 */
export function promptShown(
  model: MapModel,
  marks: MapMarks,
  decision: number,
): MapShownText | null {
  if (marks.hidden[decision]) return null;
  const base = model.decisionAt[decision]?.prompt;
  if (base === undefined) return null;
  return marks.words?.prompt(decision, base) ?? { text: base, lang: "" };
}

/**
 * A route's label in the shown language and the language it is in, or
 * null while it is hidden.
 */
export function routeShown(
  model: MapModel,
  marks: MapMarks,
  key: number,
): MapShownText | null {
  const route = model.routes[key];
  if (route === undefined || marks.hidden[route.decision]) return null;
  return (
    marks.words?.label(route.decision, route.route, route.label) ?? {
      text: route.label,
      lang: "",
    }
  );
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
  return marks.hidden[route.decision]
    ? t("map.hidden.route")
    : (routeShown(model, marks, key)?.text ?? route.label);
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
  return { ...itemPoint(run, reader.cursor), decision: -1 };
}

/** How far along its stretch a stretch's `j`-th card's centre is. */
function cardAlong(j: number): number {
  return CARD.inset + j * CARD.pitch + CARD.w / 2;
}

/**
 * The world point `at` along a stretch: on the piece holding it (the later
 * one exactly at a cut), so a point past a band cut is in the next band.
 */
export function pointAlong(run: MapRun, at: number): { x: number; y: number } {
  const pieces = run.pieces;
  let piece = pieces[0];
  for (let i = 1; i < pieces.length && pieces[i].at <= at; i += 1)
    piece = pieces[i];
  return { x: piece.x0 + at - piece.at, y: piece.y };
}

/**
 * Where item `index` sits on `run`'s line (clamped into the stretch), on
 * the piece holding that place (`pointAlong`). Without cards, its share of
 * the stretch. With cards, the place is exact for a bookmarked screen —
 * its card's centre (several cards on one screen: their middle) — and the
 * screens between run evenly from one card to the next, so a point on the
 * line and the cards always agree on story order.
 */
export function itemPoint(
  run: MapRun,
  index: number,
): { x: number; y: number } {
  return pointAlong(run, itemAlong(run, index));
}

function itemAlong(run: MapRun, index: number): number {
  const n = run.end - run.start + 1;
  const u = Math.min(Math.max(index - run.start, 0), n - 1) + 0.5;
  const marks = run.bookmarks;
  if (marks.length === 0) return (run.length * u) / n;
  let pu = 0;
  let px = 0;
  for (let j = 0; j < marks.length; ) {
    let k = j;
    while (k + 1 < marks.length && marks[k + 1] === marks[j]) k += 1;
    const au = marks[j] - run.start + 0.5;
    const ax = (cardAlong(j) + cardAlong(k)) / 2;
    if (u <= au) return u === au ? ax : px + ((ax - px) * (u - pu)) / (au - pu);
    pu = au;
    px = ax;
    j = k + 1;
  }
  return px + ((run.length - px) * (u - pu)) / (n - pu);
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
  const last = run.pieces[run.pieces.length - 1];
  for (const route of model.routes)
    if (
      route.outcome === "ends" &&
      route.endIndex === cursor &&
      route.endX === last.x1 &&
      route.endY === last.y
    )
      return { x: route.endX + END_MARK_DX, y: route.endY };
  if (cursor === model.itemCount - 1 && model.storyEnd !== null)
    return model.storyEnd;
  return null;
}

/** The run holding item `index`, else the nearest one before it. */
export function runAt<R extends { readonly start: number }>(
  runs: readonly R[],
  index: number,
): R | undefined {
  let low = 0;
  let high = runs.length - 1;
  let found: R | undefined;
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
 * The largest Fit enlarges a small map: 3x, where a card is three times
 * its Full size (scale 1, the old `t` screen's size), so a tiny story (one
 * stretch) is not blown up further.
 */
export const MAX_SCALE = 3;

/** Screen pixels Fit leaves between the tree and each edge of the view. */
export const FIT_MARGIN_PX = 32;

/**
 * How far the "you are here" marker reaches from its point, in screen
 * pixels at any scale: its ring (r 13) above, its centred "you are here"
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

/**
 * The whole-tree framing at `scale`, centred on what it keeps in view, at
 * a whole screen pixel (so the still picture is not drawn between pixels).
 */
function framed(
  axes: { x: Axis; y: Axis },
  vw: number,
  vh: number,
  scale: number,
): MapView {
  return {
    scale,
    x: Math.round(axisOffset(axes.x, scale, vw)),
    y: Math.round(axisOffset(axes.y, scale, vh)),
  };
}

/**
 * The view showing the whole tree, centred, as large as the view allows:
 * the tree's drawn box (`bounds`, not the layout's padding) fills the
 * view less `FIT_MARGIN_PX` a side along its tighter axis. With `here`
 * (the marker's world point), the marker's fixed-size ring and label stay
 * inside the view too: where it sits by an edge of the tree, the scale is
 * solved with its pixel reach as the extra margin on that side. Only
 * `MAX_SCALE` caps it, so a tiny story (one stretch) is not blown up
 * further. Fit's layout is cut at `fitWidth`'s width.
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
 * A Full size view scrolled to `y` (the screen y of the layout's top; its
 * x and scale kept): never past the map's top or bottom, and a map no
 * taller than the view sits still in the middle of it.
 */
export function scrollView(
  model: MapModel,
  vh: number,
  view: MapView,
  y: number,
): MapView {
  const room = vh - model.height * view.scale;
  return {
    ...view,
    y: room >= 0 ? Math.round(room / 2) : Math.min(0, Math.max(room, y)),
  };
}

/**
 * Screen pixels Full size keeps between the layout and each side of the
 * view, past its own padding: room for the "you are here" marker's label
 * (`HERE_REACH`) where the marker sits at a band's very start or end.
 */
export const FULL_SIZE_INSET =
  HERE_REACH.side + HERE_MARGIN_PX - MAP_GEOMETRY.pad;

/**
 * The layout width Full size cuts the bands at in a map view `vw` wide:
 * the view's width less `FULL_SIZE_INSET` a side.
 */
export function fullSizeWidth(vw: number): number {
  return vw - 2 * FULL_SIZE_INSET;
}

/**
 * Full size's scale in a map view `vw` wide: exactly 1 (a card at the old
 * `t` screen's size), the bands being cut to the view's width
 * (`fullSizeWidth`). Where some stretch of the map has no place to cut
 * within that width (the bands run past it: cards stacked on several rows
 * over one span, in a narrow window), the scale that brings the widest
 * band inside it, so nothing runs off the view's sides and nothing has to
 * move sideways.
 */
export function fullSizeScale(model: MapModel, vw: number): number {
  const room = fullSizeWidth(vw);
  return model.width <= room ? 1 : room / model.width;
}

/**
 * The Full size view (docs/plan.md Phase 41, "Two views"): at
 * `fullSizeScale` (1 but where the layout cannot be cut to the view's
 * width), the layout (cut at `fullSizeWidth`, `cutBands`) centred across
 * the view, and scrolled so world y `cy` is at the view's middle, as near
 * as its top and bottom allow (`scrollView`).
 */
export function fullSizeView(
  model: MapModel,
  vw: number,
  vh: number,
  cy: number,
): MapView {
  const scale = fullSizeScale(model, vw);
  const x = Math.max(0, Math.round((vw - model.width * scale) / 2));
  return scrollView(model, vh, { x, y: 0, scale }, vh / 2 - cy * scale);
}

/**
 * Where a Full size view's middle is (`MapPlace`): the band nearest it,
 * the place along the strip at world x `wx` (by default the view's middle
 * across; N passes its card's), kept within that band, which may be
 * shorter than half the view, and how far below the band's main line the
 * middle is.
 */
export function placeOf(
  model: MapModel,
  view: MapView,
  vw: number,
  vh: number,
  wx: number = (vw / 2 - view.x) / view.scale,
): MapPlace {
  const cy = (vh / 2 - view.y) / view.scale;
  let band = model.bands[0];
  let gap = Number.POSITIVE_INFINITY;
  for (const b of model.bands) {
    const d = cy < b.y0 ? b.y0 - cy : cy > b.y1 ? cy - b.y1 : 0;
    if (d < gap) {
      gap = d;
      band = b;
    }
  }
  // Within the band: its end is the next band's start.
  const at = Math.min(
    band.end - 0.5,
    Math.max(band.start, band.start + wx - band.x0),
  );
  return { at, dy: cy - band.line };
}

/**
 * The world y a place is at on `model`, cut at any width: in the band
 * holding its place along the strip, as far below that band's main line
 * (every line keeps its strip height in every band, so a place on a line
 * comes back on it), kept within the band and half the gap to its
 * neighbours (a band cut elsewhere may be shallower).
 */
export function placeY(model: MapModel, place: MapPlace): number {
  let band = model.bands[0];
  for (const b of model.bands) if (b.start <= place.at) band = b;
  const half = MAP_GEOMETRY.wrapGap / 2;
  return Math.min(
    band.y1 + half,
    Math.max(band.y0 - half, band.line + place.dy),
  );
}

/**
 * A fingerprint of a strip (`layOutStrip`): every stretch, box and pill
 * position on it (its x and its line's height) and the item count, each
 * to a hundredth, hashed (FNV-1a
 * over their 16-bit halves, 32 bits; no strings, so it is cheap). Another
 * game version, or another set of bookmarked screens, gives another one;
 * the band width does not enter it, so a remembered place (`MapPlace`)
 * stays valid across window sizes. Linear in stretches, decisions and
 * routes.
 */
export function stripSignature(strip: MapStrip): string {
  let hash = 0x811c9dc5;
  // Each number to a hundredth, folded in as two 16-bit halves.
  const mix = (n: number) => {
    const v = Math.round(n * 100) | 0;
    hash = Math.imul(hash ^ (v & 0xffff), 0x01000193);
    hash = Math.imul(hash ^ (v >>> 16), 0x01000193);
  };
  mix(strip.itemCount);
  for (const r of strip.runs) {
    mix(r.start);
    mix(r.end);
    mix(r.x0);
    mix(r.x1);
    mix(r.y);
  }
  for (const d of strip.nodes) {
    mix(d.index);
    mix(d.x);
    mix(d.y);
  }
  for (const r of strip.routes) {
    mix(r.decision);
    mix(r.x);
    mix(r.y);
    mix(r.endX);
  }
  return `${strip.itemCount}:${(hash >>> 0).toString(36)}`;
}

/**
 * The view memory an open starts from (docs/plan.md Phase 41,
 * "Remembered view"), on the layout whose signature is `layout`: nothing
 * remembered (a first open, a reset, an older record) is Full size,
 * centred on "you are here"; else the remembered view, with its Full size
 * place only if it was taken on this layout (a bookmark added or deleted
 * since makes a Full size open centre on "you are here").
 */
export function openingRecord(
  saved: SavedMapView | null | undefined,
  layout: string,
): SavedMapView {
  if (saved == null) return { view: "full", layout, place: null };
  return {
    view: saved.view,
    layout,
    place: saved.layout === layout ? saved.place : null,
  };
}

/**
 * A reader's move on the map: C ("centre": Full size, centred on "you are
 * here"), a scroll, a drag or N ("place": Full size, its middle there),
 * and F or the header's halves ("view").
 */
export type MapMove =
  | { readonly kind: "centre" }
  | { readonly kind: "place"; readonly place: MapPlace }
  | { readonly kind: "view"; readonly view: "full" | "fit" };

/**
 * The view memory after a move: C and a place go to Full size, C as
 * "centred" (null), so the next Full size open centres on "you are here"
 * again; switching views keeps Full size's place, for when the reader
 * comes back to it.
 */
export function remember(record: SavedMapView, move: MapMove): SavedMapView {
  if (move.kind === "centre") return { ...record, view: "full", place: null };
  if (move.kind === "place")
    return { ...record, view: "full", place: move.place };
  return { ...record, view: move.view };
}

/**
 * The view `record` shows on `model` (cut for its view) in a vw x vh map
 * view: Fit's (`fitView`, the marker kept inside), or Full size at its
 * place, or centred on "you are here" (`here`) when it has none.
 */
export function viewFor(
  model: MapModel,
  record: SavedMapView,
  here: { x: number; y: number },
  vw: number,
  vh: number,
): MapView {
  if (record.view === "fit") return fitView(model, vw, vh, here);
  const cy = record.place === null ? here.y : placeY(model, record.place);
  return fullSizeView(model, vw, vh, cy);
}

/**
 * Below this scale the map draws its nodes merged into a few paths, one
 * per look, rather than as a focusable group each (render/branchmap.ts
 * `boxesMarkup`, `figuresMarkup`): the same capsules, marks and figures,
 * so the look does not change (docs/plan.md Phase 41), only the cost of a
 * view holding hundreds of nodes (a Fit of a large map). There a node
 * takes no keyboard focus and shows no hover ring; clicks and tooltips
 * find it from the layout (`hitTest`) as everywhere.
 */
export const NODE_GROUP_MIN_SCALE = 0.6;
/**
 * A tree this small (decisions plus routes) keeps its node groups further
 * out, down to `SMALL_NODE_GROUP_MIN_SCALE`: they cost little, and its
 * fitted view is often just under the normal threshold.
 */
export const SMALL_TREE_NODES = 200;
export const SMALL_NODE_GROUP_MIN_SCALE = 0.3;

/** The scale below which this model's nodes are drawn merged. */
export function nodeGroupMinScale(model: MapModel): number {
  return model.decisions.length + model.routes.length <= SMALL_TREE_NODES
    ? SMALL_NODE_GROUP_MIN_SCALE
    : NODE_GROUP_MIN_SCALE;
}

/**
 * How tall the map's tallest digits paint at scale 1, in CSS pixels: the
 * node figures' ink (13 px type, render/branchmap.ts
 * `NODE_FIGURE_BASELINE`); the counts' 12 and 11 px digits are smaller.
 */
export const FIGURE_INK_PX = 9.4;

/**
 * Whether the counts and figures are drawn at this scale and device pixel
 * ratio: not where even the tallest digits would paint under one device
 * pixel tall, too small to read as figures (below about 0.106x on a 1x
 * screen: perf:map's 570-decision tree with 180 bookmarks fits at 0.105x
 * in 1920x1080). Drawing them there would cost a large tree's open the
 * first rasterisation of thousands of sub-pixel strings (docs/perf.md,
 * Phase 41); at every other scale they are drawn, as at Full size.
 */
export function figuresVisible(scale: number, pixelRatio: number): boolean {
  return scale * pixelRatio * FIGURE_INK_PX >= 1;
}

/**
 * How the map draws its tree at this scale and device pixel ratio, with
 * one look at every scale (render/branchmap.ts `treeMarkup`): its nodes as
 * focusable groups ("groups"); smaller, merged into a few paths with
 * their counts and figures beside them ("merged"); and where those could
 * not be seen (`figuresVisible`), without them ("bare").
 */
export type MapDrawing = "groups" | "merged" | "bare";

export function mapDrawing(
  model: MapModel,
  scale: number,
  pixelRatio: number,
): MapDrawing {
  if (scale >= nodeGroupMinScale(model)) return "groups";
  return figuresVisible(scale, pixelRatio) ? "merged" : "bare";
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
 * The node under world point (wx, wy), or null: what a click or hover
 * lands on, at any scale (a merged drawing has no per-node element).
 * Linear in nodes.
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
 * Each bookmark's card, in the order given: on the stretch `layOutStrip`
 * sized for it (the one holding its item, else the nearest before it),
 * side by side in story order (item order; on one screen, oldest first),
 * centred on the line, each on the piece of a cut stretch holding it
 * (`pointAlong`). Null for an item outside the manifest, or a
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
      const c = pointAlong(run, cardAlong(j));
      out[i] = { x: c.x - CARD.w / 2, y: c.y - CARD.h / 2, cx: c.x, cy: c.y };
    });
  }
  return out;
}
