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
// - Bands like the systems of a music score (docs/plan.md Phase 41, "Band
//   layout"). The tree is laid out once as one long strip (`layOutStrip`),
//   then cut into bands of a given width (`cutBands`): every parallel line
//   cut at the same x, each band under the one before, `wrapGap` apart
//   between what they draw, as tall as what it draws (the rows of each
//   top-level segment in it spread only by the room its own cards there
//   need). A cut falls only where everything crossing it is a straight
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
//   past it. Until the map's two views pass a width, `buildMapModel` uses
//   `bandWidthForAspect`: the width whose whole map comes closest to the
//   view's aspect with even bands (no stub of a last band), so a fit fills
//   the screen.
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
// for the tuck shifts), never in items, whatever the game's size. Cutting
// the strip into bands is linear in what it draws, at any width.

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
  /** Space between bands: from what one draws to what the next draws. */
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
/**
 * The narrowest band `bandWidthForAspect` tries, world units: about a
 * laptop's map view at 100%, so a small map is not cut into bands
 * narrower than a screen.
 */
const MIN_CHOSEN_WIDTH = 1280;
/** The least room a band gets for what it holds, whatever width is asked. */
const MIN_BAND_ROOM = 120;

/**
 * How far things reach above and below their row's line as drawn at 100%,
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

/** The aspect (width / height) a layout aims for when none is given. */
export const DEFAULT_MAP_ASPECT = 16 / 9;

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
 * ends), and from the top to the bottom of what it draws at 100%
 * (`DRAWN_REACH`: its cards with their rings, counts, nodes, ticks, and
 * the "you are here" ring wherever that can sit).
 */
export interface MapBand {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
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

function screensLabel(n: number): string {
  return n === 1 ? "1 screen" : `${n} screens`;
}

/**
 * A stretch's count line: a compact stretch shows its screen count above
 * its line; one holding cards says it under them, with its bookmarks.
 */
export function countText(screens: number, bookmarks: number): string {
  if (bookmarks === 0) return String(screens);
  return `${screensLabel(screens)} · ${bookmarks === 1 ? "1 bookmark" : `${bookmarks} bookmarks`}`;
}

/**
 * How far row `r` of a segment's rows in a band moves down to make room
 * for its cards (Phase 35): the room below every card row above it, and
 * above every card row from row 1 to it. `cards` lists the rows holding
 * cards; without any, rows stay `rowH` apart. Row 0's room above is
 * the band's own top, as what it draws.
 */
export function rowOffset(cards: readonly number[], r: number): number {
  let off = 0;
  for (const q of cards) {
    if (q < r) off += CARD_BELOW;
    if (q >= 1 && q <= r) off += CARD_ABOVE;
  }
  return off;
}

/** Where a strip element sits: its row (0, the main line) and segment. */
interface Placed {
  readonly row: number;
  readonly seg: number;
}

/** A stretch on the strip (`MapStrip`). */
export interface StripRun extends Placed {
  readonly start: number;
  readonly end: number;
  readonly x0: number;
  readonly x1: number;
  readonly bookmarks: readonly number[];
}

/** A decision node on the strip. */
export interface StripNode extends Placed {
  readonly index: number;
  readonly prompt: string;
  readonly afterIndex: number;
  readonly x: number;
  readonly routes: readonly number[];
}

/** A route pill on the strip, its line ending at `endX` on its row. */
export interface StripRoute extends Placed {
  readonly decision: number;
  readonly route: number;
  readonly label: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly outcome: RouteOutcome;
  readonly x: number;
  readonly endX: number;
}

/** A connector on the strip: from (ax, rowA) to (bx, rowB) (`RawLink`). */
export interface StripLink {
  readonly kind: "branch" | "join" | "return";
  readonly ax: number;
  readonly bx: number;
  readonly rowA: number;
  readonly rowB: number;
  readonly seg: number;
}

/** A join dot or end mark on the strip. */
export interface StripPoint extends Placed {
  readonly x: number;
}

/**
 * The tree laid out as one long strip, before it is cut into bands
 * (`cutBands`): every element on a row (0, the main line; rows `rowH`
 * apart before the cards' room spreads them) at an x from the story's start
 * (0), with the top-level segment it belongs to (the stretch before a
 * top-level decision and that decision's whole subtree: the rows that
 * spread together to make room for cards). With it, where a band may be
 * cut and what each band would hold, so cutting it at any width is linear
 * in what it draws. Laid out once per manifest and set of bookmarked
 * screens (`layOutStrip`); never changed after.
 */
export interface MapStrip {
  readonly itemCount: number;
  /** How many decisions the machine resolved (placed or not). */
  readonly decisionCount: number;
  readonly decisionById: ReadonlyMap<string, number>;
  /** Where its drawing ends on the right. */
  readonly length: number;
  /** How many top-level segments it has (at least one). */
  readonly segments: number;
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
   * many windows lie before its left and right ends (no end lies in one),
   * its lowest row and its segment. A band holds what lies between its
   * cuts' windows.
   */
  readonly held: {
    readonly w0: Int32Array;
    readonly w1: Int32Array;
    readonly row: Int32Array;
    readonly seg: Int32Array;
    /** How far it is drawn above and below its row's line (`DRAWN_REACH`). */
    readonly up: Float64Array;
    readonly down: Float64Array;
  };
  /**
   * Every card: how many windows lie before it, its row and segment, and
   * how far it is drawn below its line (above: `DRAWN_REACH.card`).
   */
  readonly cards: {
    readonly w: Int32Array;
    readonly row: Int32Array;
    readonly seg: Int32Array;
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

/**
 * Lays the decision tree out for a view of shape `aspect` (width / height),
 * bookmarks as `layOutStrip` takes them: the strip cut into bands of the
 * width `bandWidthForAspect` chooses for it. Pure; call once per manifest,
 * view shape and set of bookmarked screens.
 */
export function buildMapModel(
  items: readonly Item[],
  branches: readonly Branch[] | undefined,
  aspect: number = DEFAULT_MAP_ASPECT,
  bookmarkItems: readonly number[] = [],
): MapModel {
  const strip = layOutStrip(items, branches, bookmarkItems);
  return cutBands(strip, bandWidthForAspect(strip, aspect));
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

  // Laid out at world y (rows at whole multiples of rowH), each element
  // becomes its own strip record once its row and segment are filled in.
  type Laid<T> = Mutable<T> & { y: number };
  const runs: Laid<StripRun>[] = [];
  const mapDecisions: Laid<StripNode>[] = [];
  const routes: Laid<StripRoute>[] = [];
  const raw: (RawLink & Mutable<StripLink>)[] = [];
  const joins: Laid<StripPoint>[] = [];
  const ends: Laid<StripPoint>[] = [];
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
    runs.push({ start, end, x0: x, x1: x + w, y, bookmarks, row: 0, seg: 0 });
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
      raw.push({
        kind: "branch",
        ax: x + g.decW,
        ay: y,
        bx,
        by: ry,
        rowA: 0,
        rowB: 0,
        seg: 0,
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
        row: 0,
        seg: 0,
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
        ends.push({ x: endX + END_MARK_DX, y: routeY, row: 0, seg: 0 });
        continue;
      }
      joined = true;
      raw.push({
        kind: route.outcome === "continues" ? "join" : "return",
        ax: endX,
        ay: routeY,
        bx: joinX,
        by: y,
        rowA: 0,
        rowB: 0,
        seg: 0,
      });
    }
    const next = continuationOf(decision);
    if (joined || next > decision.afterIndex)
      joins.push({ x: joinX, y, row: 0, seg: 0 });
    mapDecisions.push({
      index: decision.index,
      prompt: decision.prompt,
      afterIndex: decision.afterIndex,
      x,
      y,
      routes: routeKeys,
      row: 0,
      seg: 0,
    });
    const rows = Math.max(1, bottom);
    return {
      x: joinX,
      rows,
      belowLeft: rows > 1 ? x + g.decW : Number.POSITIVE_INFINITY,
    };
  }

  // The main line, one top-level segment after another along row 0 from
  // x 0, the story's tail and end mark on the last.
  const segFrom: Mark[] = [];
  const last = items.length - 1;
  let x = 0;
  let idx = 0;
  for (const decision of children.get(-1) ?? []) {
    if (decision.afterIndex < idx || decision.afterIndex > last) continue;
    if (placed.has(decision.index)) continue;
    segFrom.push(mark());
    x = addRun(idx, decision.afterIndex, x, 0);
    x = layoutDecision(decision, x, 0).x;
    const next = continuationOf(decision);
    if (next <= decision.afterIndex || next > last) {
      idx = last + 1;
      break;
    }
    idx = next;
  }
  let storyEnd = -1;
  if (idx <= last) {
    if (segFrom.length === 0) segFrom.push(mark());
    x = addRun(idx, last, x, 0);
    storyEnd = ends.length;
    ends.push({ x: x + END_MARK_DX, y: 0, row: 0, seg: 0 });
  }

  // Each element's segment (what was added after the segment's mark) and
  // row (laid out from y 0, lines sit at whole multiples of rowH).
  const done = mark();
  segFrom.forEach((from, s) => {
    const to = segFrom[s + 1] ?? done;
    for (let i = from[0]; i < to[0]; i += 1) runs[i].seg = s;
    for (let i = from[1]; i < to[1]; i += 1) mapDecisions[i].seg = s;
    for (let i = from[2]; i < to[2]; i += 1) routes[i].seg = s;
    for (let i = from[3]; i < to[3]; i += 1) raw[i].seg = s;
    for (let i = from[4]; i < to[4]; i += 1) joins[i].seg = s;
    for (let i = from[5]; i < to[5]; i += 1) ends[i].seg = s;
  });
  const rowOf = (y: number) => Math.round(y / g.rowH);
  for (const list of [runs, mapDecisions, routes, joins, ends])
    for (const e of list) e.row = rowOf(e.y);
  for (const l of raw) {
    l.rowA = rowOf(l.ay);
    l.rowB = rowOf(l.by);
  }
  runs.sort((a, b) => a.start - b.start);
  mapDecisions.sort((a, b) => a.index - b.index);
  const stripRuns: readonly StripRun[] = runs;
  const nodes: readonly StripNode[] = mapDecisions;
  const stripRoutes: readonly StripRoute[] = routes;
  const links: readonly StripLink[] = raw;
  const stripJoins: readonly StripPoint[] = joins;
  const stripEnds: readonly StripPoint[] = ends;

  // What a band holds (x extent, lowest row, segment), and where a cut
  // may not fall: open x ranges, so two touching ones (two cards' halves
  // of the gap between them) leave the point they share. Flat lists, as
  // long as they can get.
  let cardCount = 0;
  for (const r of stripRuns) cardCount += r.bookmarks.length;
  const elements = nodes.length + stripJoins.length + stripEnds.length;
  const held = new Float64Array(
    6 * (1 + stripRuns.length + links.length + elements),
  );
  const blocked = new Float64Array(
    2 * (1 + 2 * stripRuns.length + cardCount + 2 * links.length + elements),
  );
  const cards = new Float64Array(4 * cardCount);
  let nHeld = 0;
  let nBlocked = 0;
  let nCards = 0;
  // Each with how far it is drawn above and below its row's line.
  const hold = (
    x0: number,
    x1: number,
    row: number,
    seg: number,
    reach: number,
  ) => {
    const at = 6 * nHeld;
    held[at] = x0;
    held[at + 1] = x1;
    held[at + 2] = row;
    held[at + 3] = seg;
    held[at + 4] = reach;
    held[at + 5] = reach;
    nHeld += 1;
  };
  const block = (x0: number, x1: number) => {
    blocked[2 * nBlocked] = x0;
    blocked[2 * nBlocked + 1] = x1;
    nBlocked += 1;
  };
  const reach = DRAWN_REACH;
  hold(-6, 6, 0, 0, reach.here);
  block(-6 - CUT_CLEAR, 6 + CUT_CLEAR);
  // A stretch's ends need no range of their own: it starts after a pill,
  // a join or the start dot, and ends at a node, an end mark (where no line
  // goes on) or a connector's start, which has one.
  for (const r of stripRuns) {
    // Its count above it (12 px type) lies inside the ring's reach.
    hold(r.x0, r.x1, r.row, r.seg, reach.here);
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
      cards[4 * nCards] = left;
      cards[4 * nCards + 1] = r.row;
      cards[4 * nCards + 2] = r.seg;
      // The first card has the stretch's count line under it.
      cards[4 * nCards + 3] = j === 0 ? reach.cardCount : reach.card;
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
    hold(d.x, d.x + g.decW, d.row, d.seg, reach.decision);
    block(d.x - CUT_CLEAR, d.x + pillsEnd + CUT_CLEAR);
  }
  // A pill and its branch curve need no record: its route's first stretch
  // starts at the pill, on its row, in the same band.
  for (const l of links) {
    if (l.kind === "branch") continue;
    hold(l.ax, l.bx, Math.max(l.rowA, l.rowB), l.seg, reach.tick);
    block(l.ax - CUT_JOINT, l.ax + CUT_JOINT);
    if (l.rowA !== l.rowB) block(l.bx - TURN_R - CUT_CLEAR, l.bx + CUT_CLEAR);
  }
  for (const p of stripJoins) {
    hold(p.x - 5, p.x + 5, p.row, p.seg, reach.join);
    block(p.x - 5 - CUT_CLEAR, p.x + 5 + CUT_CLEAR);
  }
  for (const p of stripEnds) {
    hold(p.x - 7, p.x + 7, p.row, p.seg, reach.here);
    block(p.x - 7 - CUT_CLEAR, p.x + 7 + CUT_CLEAR);
  }
  let length = 6;
  for (let i = 0; i < nHeld; i += 1)
    if (held[6 * i + 1] > length) length = held[6 * i + 1];
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
    row: new Int32Array(nHeld),
    seg: new Int32Array(nHeld),
    up: new Float64Array(nHeld),
    down: new Float64Array(nHeld),
  };
  for (let i = 0; i < nHeld; i += 1) {
    heldColumns.w0[i] = slot(held[6 * i]);
    heldColumns.w1[i] = slot(held[6 * i + 1]);
    heldColumns.row[i] = held[6 * i + 2];
    heldColumns.seg[i] = held[6 * i + 3];
    heldColumns.up[i] = held[6 * i + 4];
    heldColumns.down[i] = held[6 * i + 5];
  }
  const cardColumns = {
    w: new Int32Array(nCards),
    row: new Int32Array(nCards),
    seg: new Int32Array(nCards),
    down: new Float64Array(nCards),
  };
  for (let i = 0; i < nCards; i += 1) {
    cardColumns.w[i] = slot(cards[4 * i]);
    cardColumns.row[i] = cards[4 * i + 1];
    cardColumns.seg[i] = cards[4 * i + 2];
    cardColumns.down[i] = cards[4 * i + 3];
  }

  const decisionById = new Map<string, number>();
  for (const decision of decisions)
    decisionById.set(decision.id, decision.index);
  return {
    itemCount: items.length,
    decisionCount: decisions.length,
    decisionById,
    length,
    segments: Math.max(1, segFrom.length),
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
  /** The rows holding cards, per band and segment (band * segments + seg). */
  readonly cardRows: ReadonlyMap<number, readonly number[]>;
  readonly width: number;
  readonly height: number;
}

/**
 * The bands a strip is cut into for a layout `width` wide, padding
 * included: where each starts and ends, and where its main line sits. Per
 * top-level segment in a band, its rows are spread by the room their cards
 * need (`rowOffset`); the band's top and bottom are the extent of what it
 * draws (`DRAWN_REACH`), and each band sits `wrapGap` under the one before,
 * between those. Linear in what the strip holds.
 */
function planBands(strip: MapStrip, width: number): BandPlan {
  const g = MAP_GEOMETRY;
  const room = Math.max(MIN_BAND_ROOM, width - 2 * g.pad);
  const cut = cutPoints(strip.windows, strip.length, room);
  const from = cut.cuts;
  const bands = from.length;
  const to = from.map((_, b) => (b + 1 < bands ? from[b + 1] : strip.length));
  const segs = strip.segments;
  // The band past the first w windows: the cuts in them, counted.
  const bandPast = new Int32Array(strip.windows.length / 2 + 1);
  for (let b = 1; b < bands; b += 1) bandPast[cut.at[b] + 1] += 1;
  for (let w = 1; w < bandPast.length; w += 1) bandPast[w] += bandPast[w - 1];
  // The rows holding cards, per band and segment: they spread its rows.
  const cardRows = new Map<number, number[]>();
  const cardsIn = strip.cards;
  for (let i = 0; i < cardsIn.w.length; i += 1) {
    const key = bandPast[cardsIn.w[i]] * segs + cardsIn.seg[i];
    const rows = cardRows.get(key) ?? [];
    if (!rows.includes(cardsIn.row[i])) rows.push(cardsIn.row[i]);
    cardRows.set(key, rows);
  }
  // Each band's drawn top and bottom, from its main line: what it holds,
  // on its rows as spread (only a straight line crosses a cut: it is in
  // every band it crosses).
  const above = new Float64Array(bands).fill(Number.POSITIVE_INFINITY);
  const below = new Float64Array(bands).fill(Number.NEGATIVE_INFINITY);
  const lineY = (key: number, row: number) => {
    const cards = cardRows.get(key);
    return row * g.rowH + (cards === undefined ? 0 : rowOffset(cards, row));
  };
  const { w0, w1, row, seg, up, down } = strip.held;
  for (let i = 0; i < w0.length; i += 1) {
    const last = bandPast[w1[i]];
    for (let b = bandPast[w0[i]]; b <= last; b += 1) {
      const y = lineY(b * segs + seg[i], row[i]);
      if (y - up[i] < above[b]) above[b] = y - up[i];
      if (y + down[i] > below[b]) below[b] = y + down[i];
    }
  }
  for (let i = 0; i < cardsIn.w.length; i += 1) {
    const b = bandPast[cardsIn.w[i]];
    const y = lineY(b * segs + cardsIn.seg[i], cardsIn.row[i]);
    if (y - DRAWN_REACH.card < above[b]) above[b] = y - DRAWN_REACH.card;
    if (y + cardsIn.down[i] > below[b]) below[b] = y + cardsIn.down[i];
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
    cardRows,
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
 * The band width whose whole layout comes closest to `aspect` (width /
 * height). For one band, two, three and so on: the narrowest width that
 * still takes that many (the bands come out even), and a wider one, as
 * near the aspect as it gets while the last band stays at least half as
 * long as the others (no stub of a last band); until the even layout is
 * narrower than `aspect` twice or the bands would be under
 * `MIN_CHOSEN_WIDTH`. The first best is kept. Each count is a binary
 * search over cut counts (linear in windows) and two `bandsShape` calls.
 */
export function bandWidthForAspect(strip: MapStrip, aspect: number): number {
  const pad2 = 2 * MAP_GEOMETRY.pad;
  const length = strip.length;
  const floor = Math.max(MIN_BAND_ROOM, MIN_CHOSEN_WIDTH - pad2);
  const count = (room: number) =>
    cutPoints(strip.windows, length, room).cuts.length;
  let best = length + pad2;
  let bestMiss = Number.POSITIVE_INFINITY;
  const consider = (room: number) => {
    const shape = bandsShape(strip, room + pad2);
    const miss = Math.abs(Math.log(shape.width / shape.height / aspect));
    if (miss < bestMiss - 1e-9) {
      best = room + pad2;
      bestMiss = miss;
    }
    return shape;
  };
  let below = 0;
  for (let k = 1; ; k += 1) {
    // k even bands would be under the floor: no more.
    if (k > 1 && length / k < floor) break;
    let lo = Math.max(floor, length / k);
    let hi = Math.max(lo, length);
    if (count(lo) <= k) hi = lo;
    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      if (count(mid) <= k) hi = mid;
      else lo = mid;
    }
    const even = consider(hi);
    const roomy = Math.min(length, length / (k - 0.5));
    const want = aspect * even.height - pad2;
    if (roomy > hi && want > hi) consider(Math.min(roomy, want));
    if (even.width / even.height < aspect) below += 1;
    if (below >= 2) break;
  }
  return best;
}

/**
 * The strip cut into bands for a layout `width` wide, its padding included
 * (at 100% that many CSS pixels; a band wider than asked only where no cut
 * lies within it): each band starts at the left padding, under the one
 * before, and everything is placed in the band that holds it, a line a cut
 * crosses as a piece per band with a "continues" tick pair at each cut.
 * Pure; linear in what the strip holds.
 */
export function cutBands(strip: MapStrip, width: number): MapModel {
  const g = MAP_GEOMETRY;
  const plan = planBands(strip, width);
  const { from, to } = plan;
  const segs = strip.segments;
  const wx = (b: number, x: number) => x - from[b] + g.pad;
  const wy = (b: number, seg: number, row: number) => {
    const cards = plan.cardRows.get(b * segs + seg);
    const y = plan.mainY[b] + row * g.rowH;
    return cards === undefined ? y : y + rowOffset(cards, row);
  };
  const bandOf = (x: number) => bandAt(from, x);
  const ticks: MapTick[] = [];

  const runs: MapRun[] = strip.runs.map((r, i) => {
    const first = bandOf(r.x0);
    const last = bandOf(r.x1);
    const pieces: MapPiece[] = [];
    for (let b = first; b <= last; b += 1) {
      const a = b === first ? r.x0 : from[b];
      const z = b === last ? r.x1 : to[b];
      const y = wy(b, r.seg, r.row);
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
      y: wy(b, d.seg, d.row),
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
      y: wy(b, r.seg, r.row),
      endX: wx(e, r.endX),
      endY: wy(e, r.seg, r.row),
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
      const ay = wy(b, l.seg, l.rowA);
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
          by: wy(b, l.seg, l.rowB),
        }),
      );
    }
  }
  const pointOf = (p: StripPoint) => {
    const b = bandOf(p.x);
    return { x: wx(b, p.x), y: wy(b, p.seg, p.row) };
  };
  const joins = strip.joins.map(pointOf);
  const ends = strip.ends.map(pointOf);
  const start = { x: g.pad, y: plan.mainY[0] };
  const bands: MapBand[] = from.map((_, b) => ({
    x0: g.pad,
    y0: plan.top[b],
    x1: wx(b, to[b]),
    y1: plan.bottom[b],
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
 * A fingerprint of a model's layout: every stretch piece, box and pill
 * position and the item count, each to a hundredth, hashed (FNV-1a over
 * their 16-bit halves, 32 bits; no strings, so it is cheap). Two layouts with
 * the same signature put every world point in the same place, so a view
 * remembered on one is valid on the other; another game version, or bands
 * of another width cut at other places, gives another one (a width that
 * cuts at the same places is the same layout). Linear in runs, decisions
 * and routes.
 */
export function layoutSignature(model: MapModel): string {
  let hash = 0x811c9dc5;
  // Each number to a hundredth, folded in as two 16-bit halves.
  const mix = (n: number) => {
    const v = Math.round(n * 100) | 0;
    hash = Math.imul(hash ^ (v & 0xffff), 0x01000193);
    hash = Math.imul(hash ^ (v >>> 16), 0x01000193);
  };
  mix(model.itemCount);
  for (const r of model.runs) {
    mix(r.start);
    mix(r.end);
    for (const p of r.pieces) {
      mix(p.x0);
      mix(p.x1);
      mix(p.y);
    }
  }
  for (const d of model.decisions) {
    mix(d.index);
    mix(d.x);
    mix(d.y);
  }
  for (const r of model.routes) {
    mix(r.decision);
    mix(r.x);
    mix(r.y);
    mix(r.endX);
    mix(r.endY);
  }
  return `${model.itemCount}:${(hash >>> 0).toString(36)}`;
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

/**
 * Below this scale the map draws its nodes merged into a few paths, one
 * per look, rather than as a focusable group each (render/branchmap.ts
 * `boxesMarkup`, `figuresMarkup`): the same capsules, marks and figures,
 * so the look does not change (docs/plan.md Phase 41), only the cost of a
 * view holding hundreds of nodes. Out there a node takes no keyboard
 * focus and shows no hover ring; clicks and tooltips find it from the
 * layout (`hitTest`) as everywhere.
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
 * How tall the map's tallest digits paint at 100%, in CSS pixels: the
 * node figures' ink (13 px type, render/branchmap.ts
 * `NODE_FIGURE_BASELINE`); the counts' 12 and 11 px digits are smaller.
 */
export const FIGURE_INK_PX = 9.4;

/**
 * Whether the counts and figures are drawn at this scale and device pixel
 * ratio: not where even the tallest digits would paint under one device
 * pixel tall, too small to read as figures (below about 0.106x on a 1x
 * screen: perf:map's 570-decision tree with 180 bookmarks fits at 0.103x).
 * Drawing them there would cost a large tree's open the first
 * rasterisation of thousands of sub-pixel strings (docs/perf.md, Phase
 * 41); at every other scale they are drawn, as at 100%.
 */
export function figuresVisible(scale: number, pixelRatio: number): boolean {
  return scale * pixelRatio * FIGURE_INK_PX >= 1;
}

/**
 * How the map draws its tree at this scale and device pixel ratio, with
 * one look at every zoom (render/branchmap.ts `treeMarkup`): its nodes as
 * focusable groups ("groups"); further out merged into a few paths with
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

/**
 * 100% (key 1, Phase 35): scale 1, where a card is the old `t` screen's
 * size, zoomed about the view's centre (within the zoom limits). Exactly
 * 1, not the view's scale times its reciprocal (0.9999999999999999 for
 * some).
 */
export function fullSizeView(
  view: MapView,
  vw: number,
  vh: number,
  limits: { min: number; max: number },
): MapView {
  const scale = Math.min(limits.max, Math.max(limits.min, 1));
  const k = scale / view.scale;
  return {
    scale,
    x: vw / 2 - (vw / 2 - view.x) * k,
    y: vh / 2 - (vh / 2 - view.y) * k,
  };
}
