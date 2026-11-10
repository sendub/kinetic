// The branch map screen (docs/plan.md Phases 31, 33, 35, 41): `m` opens the
// decision tree with the reader's marks and the bookmarks as cards on the
// story line, in one of two views (Phase 41), chosen by the header's
// two-part "Full size | Fit" button, whose pressed half is the view on
// show, or F, which switches:
//
// - Full size: scale 1 (a card at the old `t` screen's size), the tree cut
//   into bands as wide as the map view, so nothing runs off its sides. A
//   map taller than the view scrolls up and down: the wheel or trackpad,
//   the scroll bar drawn at its right edge, a drag, the up and down arrows,
//   Page Up / Page Down, Home and End. Nothing moves sideways.
// - Fit: the whole map at once, its band width and scale chosen together
//   so it shows as large as fits, up to 3x (mapmodel.ts `fitWidth`). It
//   does not move (no scroll, no drag, the wheel does nothing), so it is
//   drawn once, whole, as a still picture.
//
// Nothing zooms or pans otherwise: a pinch, + and - and the left and right
// arrows do nothing. C switches to Full size centred on "you are here", N
// to Full size centred on the newest bookmark; S (or the header's switch)
// flips Spoilers, off by default, which hides the text of decisions not
// reached (mapmodel.ts `MapMarks.hidden`). Esc or M closes. The header is
// the title and its buttons (Spoilers, Newest bookmark, Centre, Full size,
// Fit), each naming its key in a hover/focus hint (index.html
// `[data-hint]`). A click on a reached decision or one of its routes asks
// the shell to jump there (the machine does the moving; see mapmodel.ts
// `runJump`).
//
// Bookmarks (Phase 35, replacing the `t` screen): each is a card centred
// on its stretch's line at its screen's place (mapmodel.ts `cardSlots`),
// its thumbnail alone (its time in the hover tooltip and its label), the
// newest outlined. A click opens it (the shell restores it and closes the
// map); a drag that starts on a card scrolls. Its × deletes it in either
// view (drawn at a fixed screen size, so it stays usable at Fit); the card
// stays as a ghost with an Undo (a click anywhere on it undoes too) until
// the map closes, and Z undoes the latest delete. No key acts on a card.
// Pictures load lazily, a few at a time, the cards in view first
// (mapcards.ts `pictureOrder`); the shell shrinks a manifest still before
// a card shows it (bookmarks.ts `shrinkStill`), as Safari needs.
//
// The view is remembered (mapmodel.ts `openingRecord`, `remember`): the
// first open is Full size centred on "you are here"; after that the map
// reopens in the view it was left in and, at Full size, where the reader
// scrolled to, or centred on "you are here" again when their last move was
// C, across closes and, through the shell's state record, reloads. A
// window resize cuts the bands again for the new width: Full size keeps
// what was in the middle of the view there, Fit fits again.
//
// Rendering: everything that moves with the view — the tree's SVG, the
// cards and the marker — lives in ONE stage element carrying the view's
// transform, so lines and cards can never drift apart (a separately
// transformed card layer once did, in Safari). The strip is laid out once
// per manifest and set of bookmarked screens and cut into bands once per
// view and view size (mapmodel.ts); each open lays the reader's marks over
// it. A scroll rewrites the stage's transform, once per animation frame.
// The tree looks the same at any scale (docs/plan.md Phase 41): Fit is the
// Full size drawing scaled. Two things keep a game with hundreds of
// decisions quick:
//
// - culling at Full size: only the lines, nodes, counts and figures within
//   half a view's margin of the visible area exist, redrawn (one string,
//   one parse) when a scroll leaves that area. Culling the lines matters as
//   much as the nodes: a dashed stroke over a whole large tree's connectors
//   costs its full length in dashes;
// - a Fit of a large map (scale < `nodeGroupMinScale`), where hundreds of
//   nodes are in view, draws them merged into a few paths, one per look,
//   with their figures beside them (`boxesMarkup`, `figuresMarkup`), not as
//   a focusable group each (`detailMarkup`): the same capsules, classes and
//   figures, so nothing changes but the cost. Where even the figures'
//   digits would paint under a device pixel tall (`figuresVisible`), the
//   counts and figures are left out: there they cannot be seen.
//
// Clicks and hovers find their node from the layout (`hitTest`), so they
// work in either view. The "you are here" marker is drawn at a fixed
// screen size (scaled by the inverse of the scale), so it stays findable
// at Fit. The tree's strokes keep their screen width down to
// `LINE_MIN_SCALE` and thin with the scale past it (`lineScaleStyle`, set
// on the world group; the counts and pill numbers sit beside it,
// `labelsMarkup`, so it leaves them alone).
//
// All decisions are pure exports of mapmodel.ts and mapcards.ts; this file
// only applies them.

import type { BookmarkSummary } from "../storage/types";
import { DELETE_CROSS, DELETE_LABEL, formatTimestamp } from "./bookmarks";
import {
  type Deletions,
  latestDeleted,
  NO_DELETIONS,
  newestBookmarkId,
  PICTURE_LOADS_AT_ONCE,
  pictureOrder,
  withDeleted,
  withRestored,
} from "./mapcards";
import {
  CARD,
  CARD_COUNT_DY,
  type CardSlot,
  cardSlots,
  countText,
  cutBands,
  fitWidth,
  fullSizeView,
  fullSizeWidth,
  hitTest,
  jumpFor,
  MAP_GEOMETRY,
  type MapDecision,
  type MapDrawing,
  type MapJump,
  type MapMarks,
  type MapModel,
  type MapMove,
  type MapReader,
  type MapStrip,
  type MapTarget,
  type MapTick,
  type MapView,
  mapDrawing,
  markMap,
  openingRecord,
  placeOf,
  pointAlong,
  promptText,
  remember,
  routeText,
  type SavedMapView,
  scrollView,
  stripSignature,
  tickBox,
  tickPaths,
  viewFor,
  visibleWorld,
} from "./mapmodel";

export const MAP_TITLE = "Branch map";

/**
 * The header's buttons, in order: what each does, its text and the key its
 * hint names (the only help the header carries). The last two are the
 * halves of one "Full size | Fit" button, the pressed half the view on
 * show; F switches between them, so both name it.
 */
export const MAP_TOOLS = [
  { act: "spoil", text: spoilersLabel(false), key: "S" },
  { act: "newest", text: "Newest bookmark", key: "N" },
  { act: "here", text: "Centre", key: "C" },
  { act: "full", text: "Full size", key: "F" },
  { act: "fit", text: "Fit", key: "F" },
] as const;

/** What the map needs to show and act on the bookmarks (the shell's storage). */
export interface MapBookmarks {
  /** The bookmarks now (summaries, storage order); read on every open. */
  list(): Promise<readonly BookmarkSummary[]>;
  /** Where a bookmark's item sits in the manifest; -1 when it is gone. */
  itemIndex(row: BookmarkSummary): number;
  /** The card's picture, ready to place (a decoded image or a canvas). */
  picture(row: BookmarkSummary): Promise<HTMLElement | null>;
  /** A card was clicked: the shell closes the map and restores the bookmark. */
  open(row: BookmarkSummary): void;
  /**
   * Its × was clicked: the shell deletes it from storage; resolves to an
   * undo that stores it again (resolving to its new summary), or to null
   * when the delete failed (the card comes back).
   */
  remove(
    row: BookmarkSummary,
  ): Promise<(() => Promise<BookmarkSummary | null>) | null>;
}

/**
 * Below this scale a ghost's words (14 px type, so under 10 px here) are
 * unreadable: a ghost is just its dashed outline (index.html
 * `.map-cards-small`).
 */
export const CARD_SMALL_SCALE = 0.7;

/**
 * The size of a card's × in screen pixels at `scale`: 24 px, smaller on a
 * card under about 80 px wide (Fit on a large game), never under 14 px, so
 * it stays a usable target at any scale without hiding a small card.
 */
export function deleteButtonPx(scale: number): number {
  return Math.max(14, Math.min(24, CARD.w * 0.3 * scale));
}

/**
 * The card layer's per-scale style (index.html `.bm-card`, `.bm-del`): a
 * screen pixel in world units (`--px`, for the hover ring and the newest's
 * outline), the × scaled to `deleteButtonPx` on screen (`--del-scale`; it
 * is 24 world units), and its hint brought back to its usual size
 * (`--hint-scale`).
 */
export function cardScaleStyle(scale: number): Record<string, string> {
  const del = deleteButtonPx(scale);
  return {
    "--px": String(1 / scale),
    "--del-scale": String(del / 24 / scale),
    "--hint-scale": String(24 / del),
  };
}

/**
 * The scale below which the map's strokes thin with it (docs/plan.md Phase
 * 40, map lines). From here up, a stroke is its index.html width in screen
 * pixels; further out it keeps the world width it had here, so a stretch
 * (5 px) never takes more than about a quarter of the space between rows
 * (42 world units, 21 px here), and a large tree at Fit looks as it did
 * with world-unit widths doubled far out.
 */
export const LINE_MIN_SCALE = 0.5;

/**
 * `--line-px` moves in steps of 2^(1/8) (9%), so a change of scale
 * restyles the tree only when it crosses one: a stroke paints within 4.5%
 * of its width (a 5 px line 4.8-5.2 px), and exactly at Full size.
 */
export const LINE_STEPS_PER_OCTAVE = 8;

/**
 * The tree's per-scale style (index.html `.map-world`): a line's screen
 * pixel in world units (`--line-px`, in `LINE_STEPS_PER_OCTAVE` steps), in
 * which every stroke width and dash of the lines, stations, end marks and
 * node outlines is written, so it keeps its screen width under the stage's
 * CSS scale in any browser (`vector-effect: non-scaling-stroke` does not
 * undo that scale in Chrome).
 */
export function lineScaleStyle(scale: number): Record<string, string> {
  const octaves = Math.log2(1 / Math.max(scale, LINE_MIN_SCALE));
  const step =
    Math.round(octaves * LINE_STEPS_PER_OCTAVE) / LINE_STEPS_PER_OCTAVE;
  return { "--line-px": String(2 ** step) };
}

/** A card's accessible name. */
export function cardLabel(timestampMs: number, newest: boolean): string {
  return `Bookmark ${formatTimestamp(timestampMs)}${newest ? " (newest)" : ""}`;
}

/**
 * A header button's hint, shown at once on hover or keyboard focus by
 * index.html's `[data-hint]` rule. Not a native `title`: Chrome shows that
 * late and Safari not at all in fullscreen.
 */
export function shortcutHint(key: string): string {
  return `shortcut: ${key}`;
}

/**
 * The Spoilers switch's text, mirroring its aria-pressed value: off (the
 * default) hides the text of decisions not reached (mapmodel.ts
 * `MapMarks.hidden`).
 */
export function spoilersLabel(on: boolean): string {
  return on ? "Spoilers: On" : "Spoilers: Off";
}

/** Full size's scroll per up or down arrow press, in screen pixels. */
const KEY_SCROLL_PX = 80;
/**
 * Page Up / Page Down scroll Full size by this share of the view's height,
 * keeping a strip of what was in view, as a browser page does.
 */
const PAGE_SHARE = 0.875;
/** Pointer travel that makes a press a drag rather than a click. */
const DRAG_PX = 5;

export interface BranchMapOptions {
  /** The `#app` element; the panel is a sibling of the other panels. */
  root: HTMLElement;
  /**
   * The tree laid out as one strip around these bookmarked screens (item
   * indices; mapmodel.ts `layOutStrip`); called on the first open, and
   * again only when the bookmarked screens change. The map cuts it into
   * bands for each view.
   */
  strip: (bookmarkItems: readonly number[]) => MapStrip;
  /** The bookmarks, drawn as cards on their stretches (Phase 35). */
  bookmarks?: MapBookmarks;
  /** The reader's state now; called on every open. */
  reader: () => MapReader;
  /** A reached decision or route was clicked: the shell jumps (and closes). */
  onJump(jump: MapJump): void;
  /** The map opened (true) or closed (false). */
  onOpenChange?(open: boolean): void;
  /** The Spoilers setting in force (`mapSpoilers`); read on every open. */
  spoilers(): boolean;
  /** The reader flipped Spoilers (button or S): the shell persists it. */
  onSpoilersChange(on: boolean): void;
  /** The remembered view (`PersistedState.mapView`); read on every open. */
  view(): SavedMapView | null | undefined;
  /**
   * The view now, as it would be remembered: on every painted change while
   * open. The shell keeps it (no write); it persists on close.
   */
  onViewChange(view: SavedMapView): void;
}

export interface BranchMap {
  isOpen(): boolean;
  open(): void;
  close(): void;
  /** Over the map the wheel is the map's (no story step behind it). */
  ownsWheel(): boolean;
}

/** One route's status word, as the tooltip and aria label say it. */
const ROUTE_WORD = {
  unseen: "not seen",
  partly: "partly seen",
  played: "played",
} as const;
const OUTCOME_WORD = {
  continues: "continues the story",
  returns: "returns to the choice",
  ends: "an ending",
} as const;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The full text and status a node's tooltip and aria label carry. */
export function describeTarget(
  model: MapModel,
  marks: MapMarks,
  target: MapTarget,
): { title: string; status: string } {
  if (target.kind === "decision") {
    const node = model.decisionAt[target.decision];
    const total = node?.routes.length ?? 0;
    const status = marks.reached[target.decision]
      ? `${marks.playedCount[target.decision]} of ${total} routes played`
      : "not reached yet";
    return { title: promptText(model, marks, target.decision), status };
  }
  const route = model.routes[target.key];
  const parts: string[] = [
    ROUTE_WORD[marks.routes[target.key]],
    OUTCOME_WORD[route.outcome],
  ];
  if (marks.lastPick[target.key]) parts.push("your last pick");
  if (!marks.reached[route.decision]) parts.push("decision not reached yet");
  const title = `${route.route + 1}. ${routeText(model, marks, target.key)}`;
  return { title, status: parts.join(" · ") };
}

/** A world rectangle (culling); null means everything. */
export type WorldRect = { x0: number; y0: number; x1: number; y1: number };

function within(
  rect: WorldRect | null,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  return (
    rect === null ||
    (x1 >= rect.x0 && x0 <= rect.x1 && y1 >= rect.y0 && y0 <= rect.y1)
  );
}

/** A connector kind's look (index.html). */
const LINK_CLASS = {
  branch: "map-conn",
  join: "map-join",
  return: "map-return",
} as const;

/**
 * The look of the line a "continues" tick ends (mapmodel.ts `MapTick`): a
 * stretch's by how much of it is read, or the connector kind's. Its stub
 * is drawn in that look, dashes and all; its slash in that look with
 * `map-tick`, solid (index.html), so it reads as a tick on any line.
 */
export function tickClass(marks: MapMarks, tick: MapTick): string {
  return tick.line === "run"
    ? `map-run map-run-${marks.runs[tick.run]}`
    : LINK_CLASS[tick.line];
}

/**
 * The lines: connectors, the stretches' pieces by mark, the "continues"
 * ticks where band cuts cross them (each in its line's look), joins and end
 * marks touching `rect` (all of them for null), merged into one path
 * element per look, so even a whole large tree is a handful of elements.
 * Pure.
 */
export function linesMarkup(
  model: MapModel,
  marks: MapMarks,
  rect: WorldRect | null = null,
): string {
  const paths: Record<string, string[]> = {
    "map-conn": [],
    "map-join": [],
    "map-return": [],
    "map-run map-run-unseen": [],
    "map-run map-run-partly": [],
    "map-run map-run-seen": [],
    "map-dot": [],
    "map-end": [],
  };
  for (const link of model.links) {
    const y0 = Math.min(link.y0, link.y1);
    const y1 = Math.max(link.y0, link.y1);
    if (within(rect, link.x0, y0, link.x1, y1))
      paths[LINK_CLASS[link.kind]].push(link.d);
  }
  model.runs.forEach((run, i) => {
    for (const p of run.pieces)
      if (within(rect, p.x0, p.y, p.x1, p.y))
        paths[`map-run map-run-${marks.runs[i]}`].push(
          `M${p.x0} ${p.y}H${p.x1}`,
        );
  });
  for (const tick of model.ticks) {
    const b = tickBox(tick);
    if (!within(rect, b.x0, b.y0, b.x1, b.y1)) continue;
    const cls = tickClass(marks, tick);
    const { stub, slash } = tickPaths(tick);
    paths[cls].push(stub);
    paths[`${cls} map-tick`] ??= [];
    paths[`${cls} map-tick`].push(slash);
  }
  for (const p of model.joins)
    if (within(rect, p.x - 5, p.y - 5, p.x + 5, p.y + 5))
      paths["map-dot"].push(
        `M${p.x - 5} ${p.y}a5 5 0 1 0 10 0a5 5 0 1 0 -10 0`,
      );
  const s = model.start;
  paths["map-dot"].push(`M${s.x - 6} ${s.y}a6 6 0 1 0 12 0a6 6 0 1 0 -12 0`);
  for (const p of model.ends)
    if (within(rect, p.x - 7, p.y - 7, p.x + 7, p.y + 7))
      paths["map-end"].push(`M${p.x - 7} ${p.y - 7}h14v14h-14z`);
  return Object.entries(paths)
    .filter(([, d]) => d.length > 0)
    .map(([cls, d]) => `<path class="${cls}" d="${d.join("")}"/>`)
    .join("");
}

/**
 * A node's outline as a path: the capsule a `<rect>` of this box draws
 * with `rx` half its height (index.html `.map-dec rect`; a pill's own
 * `rx`), traced as the rect's outline is (from (x + r, top), clockwise),
 * so a dash pattern falls on it exactly as on the rect. Pure.
 */
export function capsulePath(
  x: number,
  top: number,
  w: number,
  h: number,
): string {
  const r = h / 2;
  return `M${x + r} ${top}H${x + w - r}A${r} ${r} 0 0 1 ${x + w - r} ${top + h}H${x + r}A${r} ${r} 0 0 1 ${x + r} ${top}Z`;
}

/**
 * The nodes touching `rect` (all of them for null) as a few paths, one per
 * look, with no per-node element: what the map draws out where per-node
 * groups would cost too much (`nodeGroupMinScale`). The same capsules,
 * classes and so styles as `detailMarkup`'s, so it looks the same; their
 * figures are `figuresMarkup`'s. Pure.
 */
export function boxesMarkup(
  model: MapModel,
  marks: MapMarks,
  rect: WorldRect | null = null,
): string {
  const g = MAP_GEOMETRY;
  const paths: Record<string, string[]> = {};
  const add = (cls: string, x: number, y: number, w: number, h: number) => {
    if (!within(rect, x, y - h / 2, x + w, y + h / 2)) return;
    paths[cls] ??= [];
    paths[cls].push(capsulePath(x, y - h / 2, w, h));
  };
  for (const node of model.decisions)
    add(
      `map-dec ${marks.reached[node.index] ? "map-reached" : "map-inert"}`,
      node.x,
      node.y,
      g.decW,
      g.decH,
    );
  model.routes.forEach((route, key) => {
    add(
      `map-route ${routeClasses(marks, key, route.decision)}`,
      route.x,
      route.y,
      g.routeW,
      g.routeH,
    );
  });
  return Object.entries(paths)
    .map(([cls, d]) => `<path class="map-box ${cls}" d="${d.join("")}"/>`)
    .join("");
}

/** A decision node's figure: "played/total", or "?" when not reached. */
function decisionFigure(marks: MapMarks, node: MapDecision): string {
  return marks.reached[node.index]
    ? `${marks.playedCount[node.index]}/${node.routes.length}`
    : "?";
}

/**
 * The baseline of a node's figure (index.html `.map-dec-c`, `.map-route-c`,
 * 13 px), below the node's centre line: its digits' ink is 9.2-9.4 px
 * tall in the system UI font (measured with canvas `measureText` in
 * Chrome), so this centres them in the node.
 */
export const NODE_FIGURE_BASELINE = 4.6;

/**
 * The nodes that touch `rect` (all of them for null) as groups, the
 * drawing from `nodeGroupMinScale` in (mapmodel.ts): decision nodes
 * ("played/total", or "?" when not reached) and route pills, each a
 * focusable group with its full text in its label (and the hover
 * tooltip). A route pill's number is drawn by `labelsMarkup`, out of the
 * restyle a change of scale brings (`lineScaleStyle`); a decision keeps
 * its figure, which turns gold on its hover and focus. Pure.
 */
export function detailMarkup(
  model: MapModel,
  marks: MapMarks,
  rect: WorldRect | null = null,
): string {
  const g = MAP_GEOMETRY;
  const out: string[] = [];
  for (const node of model.decisions) {
    const top = node.y - g.decH / 2;
    if (!within(rect, node.x, top, node.x + g.decW, top + g.decH)) continue;
    const reached = marks.reached[node.index];
    const target: MapTarget = { kind: "decision", decision: node.index };
    const { title, status } = describeTarget(model, marks, target);
    out.push(
      `<g class="map-node map-dec${reached ? " map-reached" : " map-inert"}" data-d="${node.index}" transform="translate(${node.x} ${node.y})"${reached ? ' tabindex="0" role="button"' : ""} aria-label="${escapeXml(`${title}: ${status}`)}">` +
        `<rect x="0" y="${-g.decH / 2}" width="${g.decW}" height="${g.decH}" rx="5"/>` +
        `<text class="map-dec-c" x="${g.decW / 2}" y="${NODE_FIGURE_BASELINE}">${decisionFigure(marks, node)}</text></g>`,
    );
  }
  model.routes.forEach((route, key) => {
    const top = route.y - g.routeH / 2;
    if (!within(rect, route.x, top, route.x + g.routeW, top + g.routeH)) return;
    const state = marks.routes[key];
    const { title, status } = describeTarget(model, marks, {
      kind: "route",
      key,
    });
    out.push(
      `<g class="map-node map-route ${routeClasses(marks, key, route.decision)}" data-r="${key}" data-state="${state}" transform="translate(${route.x} ${route.y})"${marks.reached[route.decision] ? ' tabindex="0" role="button"' : ""} aria-label="${escapeXml(`${title}: ${status}`)}">` +
        `<rect x="0" y="${-g.routeH / 2}" width="${g.routeW}" height="${g.routeH}" rx="${g.routeH / 2}"/></g>`,
    );
  });
  return out.join("");
}

/** A route's state classes: how much is read, reached or not, last pick. */
function routeClasses(marks: MapMarks, key: number, decision: number): string {
  const classes = [
    `map-route-${marks.routes[key]}`,
    marks.reached[decision] ? "map-reached" : "map-inert",
  ];
  if (marks.lastPick[key]) classes.push("map-last");
  return classes.join(" ");
}

/**
 * The text outside the node groups, touching `rect` (all of it for
 * null): the stretches' counts and the route pills' numbers (each with its
 * route's state classes, its key in `data-pill`, hidden from assistive
 * tech: the pill's label says it), drawn over the nodes, outside the
 * element `lineScaleStyle` restyles, so a change of scale leaves them
 * alone. Pure.
 */
export function labelsMarkup(
  model: MapModel,
  marks: MapMarks,
  rect: WorldRect | null = null,
): string {
  const g = MAP_GEOMETRY;
  const out: string[] = [];
  // A count sits where its stretch's middle (or, with cards, its first
  // card's left edge) is, on whichever piece of a cut stretch holds that:
  // band cuts never cross a count (mapmodel.ts `layOutStrip`).
  for (const run of model.runs) {
    const screens = run.end - run.start + 1;
    const cards = run.bookmarks.length;
    if (cards === 0) {
      const at = pointAlong(run, run.length / 2);
      const half = run.length / 2;
      if (!within(rect, at.x - half, at.y - 16, at.x + half, at.y)) continue;
      out.push(
        `<text class="map-count" x="${at.x}" y="${at.y - 6}">${countText(screens, 0)}</text>`,
      );
    } else {
      const at = pointAlong(run, CARD.inset);
      const y = at.y + CARD_COUNT_DY;
      if (!within(rect, at.x, y - 12, at.x + CARD.w, y)) continue;
      out.push(
        `<text class="map-count map-count-cards" x="${at.x}" y="${y}">${countText(screens, cards)}</text>`,
      );
    }
  }
  model.routes.forEach((route, key) => {
    const top = route.y - g.routeH / 2;
    if (!within(rect, route.x, top, route.x + g.routeW, top + g.routeH)) return;
    out.push(
      `<text class="map-route-c ${routeClasses(marks, key, route.decision)}" data-pill="${key}" aria-hidden="true" x="${route.x + g.routeW / 2}" y="${route.y + NODE_FIGURE_BASELINE}">${route.route + 1}</text>`,
    );
  });
  return out.join("");
}

/**
 * The decision figures touching `rect` (all of them for null), for
 * `boxesMarkup`'s nodes, which have no group to carry them: each where
 * `detailMarkup` puts it in its node, in its node's reached or inert
 * colour. Pure.
 */
export function figuresMarkup(
  model: MapModel,
  marks: MapMarks,
  rect: WorldRect | null = null,
): string {
  const g = MAP_GEOMETRY;
  const out: string[] = [];
  for (const node of model.decisions) {
    const top = node.y - g.decH / 2;
    if (!within(rect, node.x, top, node.x + g.decW, top + g.decH)) continue;
    const look = marks.reached[node.index] ? "map-reached" : "map-inert";
    out.push(
      `<text class="map-dec-c ${look}" x="${node.x + g.decW / 2}" y="${node.y + NODE_FIGURE_BASELINE}">${decisionFigure(marks, node)}</text>`,
    );
  }
  return out.join("");
}

/**
 * The tree touching `rect` (all of it for null) as `drawing` draws it: the
 * lines and nodes (the world group, which a change of scale restyles) and
 * the counts and figures (beside it). Nodes as focusable groups, or merged
 * into a few paths with their figures beside them; with the same look
 * either way, the counts and figures left out only where they cannot be
 * seen (mapmodel.ts `mapDrawing`). Pure.
 */
export function treeMarkup(
  model: MapModel,
  marks: MapMarks,
  rect: WorldRect | null,
  drawing: MapDrawing,
): { tree: string; labels: string } {
  const lines = linesMarkup(model, marks, rect);
  if (drawing === "groups")
    return {
      tree: lines + detailMarkup(model, marks, rect),
      labels: labelsMarkup(model, marks, rect),
    };
  return {
    tree: lines + boxesMarkup(model, marks, rect),
    labels:
      drawing === "merged"
        ? labelsMarkup(model, marks, rect) + figuresMarkup(model, marks, rect)
        : "",
  };
}

/** The node a DOM event landed on, as a map target. */
function targetOf(element: Element | null): {
  node: Element;
  target: MapTarget;
} | null {
  const node = element?.closest("[data-d],[data-r]") ?? null;
  if (node === null) return null;
  const d = node.getAttribute("data-d");
  if (d !== null)
    return { node, target: { kind: "decision", decision: Number(d) } };
  return {
    node,
    target: { kind: "route", key: Number(node.getAttribute("data-r")) },
  };
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** One bookmark's card while the map is open. */
interface Card {
  row: BookmarkSummary;
  readonly index: number;
  /** Its bookmark's place in the open's list (what `cardSlots` returns by). */
  readonly listedAt: number;
  /** Where it sits on the model on show (a view's cut moves it). */
  slot: CardSlot;
  readonly el: HTMLElement;
  deleted: boolean;
  /** The delete in flight or done: resolves to its undo (null: it failed). */
  removing: Promise<(() => Promise<BookmarkSummary | null>) | null> | null;
}

/** Which part of a card a press landed on. */
type CardPart = "del" | "undo" | "card";

/**
 * Full size's scroll bar (index.html `.map-scroll`): drawn by the map, as
 * the view moves by its transform rather than by native scrolling. Its
 * track keeps `inset` from the view's top and bottom; its thumb is never
 * shorter than `minThumb` (all screen pixels).
 */
const SCROLL_BAR = { inset: 6, minThumb: 28 } as const;

/**
 * The scroll bar's thumb in a track `track` pixels long, for a map
 * `height` tall in a view `vh` tall, scrolled to `y` (the layout top's
 * screen y, 0 down to vh - height): its length, proportional to the share
 * of the map in view, and its offset down the track. Pure.
 */
export function scrollThumb(
  track: number,
  height: number,
  vh: number,
  y: number,
): { length: number; offset: number } {
  const length = Math.min(
    track,
    Math.max(SCROLL_BAR.minThumb, (track * vh) / height),
  );
  const range = height - vh;
  const share = range > 0 ? Math.min(1, Math.max(0, -y / range)) : 0;
  return { length, offset: (track - length) * share };
}

export function mountBranchMap({
  root,
  strip: layOutFor,
  bookmarks: bm,
  reader,
  onJump,
  onOpenChange,
  spoilers: spoilersSetting,
  onSpoilersChange,
  view: rememberedView,
  onViewChange,
}: BranchMapOptions): BranchMap {
  const doc = root.ownerDocument;
  const win = doc.defaultView;

  const panel = doc.createElement("div");
  panel.id = "branchmap";
  panel.className = "branchmap";
  panel.hidden = true;

  const head = doc.createElement("div");
  head.className = "map-head";
  const title = doc.createElement("h2");
  title.className = "map-title";
  title.textContent = MAP_TITLE;
  const tools = doc.createElement("div");
  tools.className = "map-tools";
  const buttons = new Map<string, HTMLButtonElement>();
  for (const { act, text, key } of MAP_TOOLS) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "map-tool";
    button.dataset.act = act;
    button.textContent = text;
    const hint = shortcutHint(key);
    button.dataset.hint = hint;
    button.setAttribute("aria-keyshortcuts", key);
    // The drawn hint is hidden from assistive tech (index.html); this
    // hidden twin carries the same text as the button's description.
    const described = doc.createElement("span");
    described.id = `map-hint-${act}`;
    described.hidden = true;
    described.textContent = hint;
    button.setAttribute("aria-describedby", described.id);
    tools.append(button, described);
    buttons.set(act, button);
  }
  const spoilButton = buttons.get("spoil") as HTMLButtonElement;
  spoilButton.classList.add("map-spoil");
  spoilButton.setAttribute("aria-pressed", "false");
  const newestButton = buttons.get("newest") as HTMLButtonElement;
  // "Full size | Fit": each half pressed while its view is on show.
  const viewButtons = {
    full: buttons.get("full") as HTMLButtonElement,
    fit: buttons.get("fit") as HTMLButtonElement,
  };
  head.append(title, tools);

  const viewport = doc.createElement("div");
  viewport.className = "map-view";
  // The stage: everything that moves with the view, under one transform.
  const stage = doc.createElement("div");
  stage.className = "map-stage";
  const svgOf = (cls: string) => {
    const el = doc.createElementNS(SVG_NS, "svg");
    el.setAttribute("class", cls);
    return el;
  };
  const svg = svgOf("map-svg");
  const group = (cls: string) => {
    const g = doc.createElementNS(SVG_NS, "g");
    g.setAttribute("class", cls);
    return g;
  };
  // The world: the drawn lines and nodes, which a change of scale
  // restyles (`lineScaleStyle`); beside it the counts and figures, which
  // it does not; over them the cards, and over those the marker.
  const world = group("map-world");
  const detail = group("map-detail");
  const labels = group("map-labels");
  world.append(detail);
  svg.append(world, labels);
  const cardLayer = doc.createElement("div");
  cardLayer.className = "map-cards";
  const top = svgOf("map-svg map-top");
  const here = group("map-here");
  here.innerHTML =
    '<circle class="map-here-ring" r="13"/><circle class="map-here-dot" r="6"/>' +
    '<text class="map-here-label" y="32">you are here</text>';
  top.append(here);
  stage.append(svg, cardLayer, top);
  // Full size's scroll bar (`SCROLL_BAR`), hidden from assistive tech: the
  // keys scroll as well.
  const bar = doc.createElement("div");
  bar.className = "map-scroll";
  bar.hidden = true;
  bar.setAttribute("aria-hidden", "true");
  const thumb = doc.createElement("div");
  thumb.className = "map-thumb";
  bar.append(thumb);
  const tip = doc.createElement("div");
  tip.className = "map-tip";
  tip.hidden = true;
  const toast = doc.createElement("div");
  toast.className = "map-toast";
  toast.setAttribute("role", "status");
  toast.hidden = true;
  const toastText = doc.createElement("span");
  toastText.textContent = "Bookmark deleted";
  const toastUndo = doc.createElement("button");
  toastUndo.type = "button";
  toastUndo.className = "map-undo";
  toastUndo.textContent = "Undo (Z)";
  toast.append(toastText, toastUndo);
  viewport.append(stage, bar, tip, toast);
  panel.append(head, viewport);
  root.appendChild(panel);

  // The strip, laid out for the bookmarked screens in `stripItems` (a
  // sorted list), and its signature (what a remembered place is checked
  // against), computed once per strip.
  let strip: MapStrip | null = null;
  let stripItems = "";
  let layout = "";
  // The strip cut for each view, kept until what it was cut for changes:
  // Full size at the view's width, Fit for the view's size (`fitWidth`).
  // `model` is the one on show.
  let fullCut: { vw: number; model: MapModel } | null = null;
  let fitCut: { vw: number; vh: number; model: MapModel } | null = null;
  let model: MapModel | null = null;
  // The view memory (mapmodel.ts `remember`): the view on show and Full
  // size's place (null: centred on "you are here").
  let record: SavedMapView = { view: "full", layout: "", place: null };
  let marks: MapMarks | null = null;
  // Spoilers, as read at the open and flipped since (the marks carry it).
  let spoilers = false;
  const showSpoilers = () => {
    spoilButton.textContent = spoilersLabel(spoilers);
    spoilButton.setAttribute("aria-pressed", String(spoilers));
  };
  const markNow = (m: MapModel) => markMap(m, { ...reader(), spoilers });
  let view: MapView = { x: 0, y: 0, scale: 1 };
  let frame = 0;
  // How the tree is drawn at this scale (`mapDrawing`; none yet).
  let drawnAs: MapDrawing | null = null;
  let small = false;
  // The scale the card layer's per-scale style was last set for.
  let styledScale = 0;
  // The world rectangle the tree is drawn for: "all" for the whole of it
  // (Fit), null for none drawn.
  let drawn: WorldRect | "all" | null = null;
  // The viewport size, read once per open and on resize: reading it per
  // frame would force a layout each time.
  let vw = 800;
  let vh = 600;
  const measure = () => {
    vw = viewport.clientWidth || win?.innerWidth || 800;
    vh = viewport.clientHeight || win?.innerHeight || 600;
  };

  // The bookmarks of this open: listed (item still in the manifest) and
  // their cards once placed; the deletes made since the open.
  let listed: { row: BookmarkSummary; index: number }[] = [];
  let cards: Card[] = [];
  const cardById = new Map<string, Card>();
  let deletions: Deletions = NO_DELETIONS;
  // Pictures read so far, by bookmark id (null: none to show), kept for
  // the page's life; the reads running.
  const pictures = new Map<string, HTMLElement | null>();
  const loading = new Set<string>();
  // Each open's list read, so a stale one (closed or reopened since) is
  // dropped.
  let opening = 0;

  /** Lays the strip out again when the bookmarked screens have changed. */
  function stripNow(): MapStrip {
    const items = listed.map((l) => l.index).sort((a, b) => a - b);
    const key = items.join(",");
    if (strip === null || key !== stripItems) {
      strip = layOutFor(items);
      stripItems = key;
      layout = stripSignature(strip);
      fullCut = null;
      fitCut = null;
    }
    return strip;
  }

  /**
   * The strip cut for a view at the view's size now: Full size to its
   * width (no chooser), Fit at the width that shows it largest.
   */
  function cutFor(which: "full" | "fit", from: MapStrip): MapModel {
    if (which === "full") {
      if (fullCut === null || fullCut.vw !== vw)
        fullCut = { vw, model: cutBands(from, fullSizeWidth(vw)) };
      return fullCut.model;
    }
    if (fitCut === null || fitCut.vw !== vw || fitCut.vh !== vh)
      fitCut = { vw, vh, model: cutBands(from, fitWidth(from, vw, vh)) };
    return fitCut.model;
  }

  /**
   * Puts `next` on show: the reader's marks laid over it, the stage sized
   * to it, the cards moved to their places on it, the tree to be drawn.
   */
  function useModel(next: MapModel): void {
    if (next === model) return;
    model = next;
    marks = markNow(next);
    for (const el of [svg, top]) {
      el.setAttribute("width", String(next.width));
      el.setAttribute("height", String(next.height));
    }
    stage.style.width = `${next.width}px`;
    stage.style.height = `${next.height}px`;
    positionCards();
    drawn = null;
    hideTip();
  }

  /** The halves of "Full size | Fit" say which view is on show. */
  function showPressed(): void {
    viewButtons.full.setAttribute(
      "aria-pressed",
      String(record.view === "full"),
    );
    viewButtons.fit.setAttribute("aria-pressed", String(record.view === "fit"));
  }

  /**
   * Shows what the view memory says, at the view's size now: its view's
   * cut, and Fit, or Full size at its place or centred on "you are here"
   * (mapmodel.ts `viewFor`).
   */
  function showRecord(): void {
    if (strip === null) return;
    useModel(cutFor(record.view, strip));
    if (model === null || marks === null) return;
    showPressed();
    setView(viewFor(model, record, marks.here, vw, vh));
  }

  /** A switch of view, C or the like: remembered, then shown. */
  function move(next: MapMove): void {
    record = remember(record, next);
    showRecord();
  }

  // The view changed size while open (a window resize, entering or leaving
  // fullscreen, the header rewrapping): the bands are cut again for the
  // new size; Full size keeps its place (the middle of the view, as the
  // reader left it) or stays centred on "you are here", and Fit fits again.
  // The viewport's own size is watched, so its final size after a
  // fullscreen change is the one used.
  const resized = () => {
    if (panel.hidden || panel.dataset.ready !== "true") return;
    const from = { w: vw, h: vh };
    measure();
    if (vw !== from.w || vh !== from.h) showRecord();
  };
  const Observer = win?.ResizeObserver as typeof ResizeObserver | undefined;
  if (Observer !== undefined) new Observer(resized).observe(viewport);
  else win?.addEventListener("resize", resized);

  /** How tall the map is on screen now. */
  const shownHeight = () => (model === null ? 0 : model.height * view.scale);

  /** Whether the view scrolls: Full size, on a map taller than the view. */
  function scrolls(): boolean {
    return record.view === "full" && shownHeight() > vh;
  }

  /** The scroll bar's thumb, where the view is now. */
  function placeBar(): void {
    const on = scrolls();
    bar.hidden = !on;
    viewport.classList.toggle("map-scrolls", on);
    if (!on || model === null) return;
    const { length, offset } = scrollThumb(
      vh - 2 * SCROLL_BAR.inset,
      shownHeight(),
      vh,
      view.y,
    );
    thumb.style.height = `${length}px`;
    thumb.style.transform = `translateY(${offset}px)`;
  }

  function paint(): void {
    frame = 0;
    if (model === null || marks === null) return;
    const s = view.scale;
    // One transform moves the lines, the cards and the marker together.
    stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${s})`;
    stage.dataset.view = `${view.x} ${view.y} ${s}`;
    here.setAttribute(
      "transform",
      `translate(${marks.here.x} ${marks.here.y}) scale(${1 / s})`,
    );
    // Only a change of scale (a switch of view) restyles the cards and the
    // tree's strokes: a scroll leaves their style alone.
    if (s !== styledScale) {
      styledScale = s;
      for (const [name, value] of Object.entries(cardScaleStyle(s)))
        cardLayer.style.setProperty(name, value);
      for (const [name, value] of Object.entries(lineScaleStyle(s)))
        if (world.style.getPropertyValue(name) !== value)
          world.style.setProperty(name, value);
    }
    const nowSmall = s < CARD_SMALL_SCALE;
    if (nowSmall !== small) {
      small = nowSmall;
      cardLayer.classList.toggle("map-cards-small", small);
    }
    // How this scale draws the tree (`mapDrawing`): a change redraws.
    const nowAs = mapDrawing(model, s, win?.devicePixelRatio || 1);
    if (nowAs !== drawnAs) {
      drawnAs = nowAs;
      drawn = null;
    }
    if (record.view === "fit") {
      // Fit is a still picture: the whole tree, drawn once.
      if (drawn !== "all") {
        drawTree(null, nowAs);
        drawn = "all";
      }
    } else {
      // Full size culls: the tree is drawn for the view plus a margin of
      // half a view each way, and drawn again only once a scroll leaves
      // that.
      const seen = visibleWorld(view, vw, vh);
      if (drawn === null || drawn === "all" || !containsRect(drawn, seen)) {
        const w = (seen.x1 - seen.x0) / 2;
        const h = (seen.y1 - seen.y0) / 2;
        drawn = {
          x0: seen.x0 - w,
          y0: seen.y0 - h,
          x1: seen.x1 + w,
          y1: seen.y1 + h,
        };
        drawTree(drawn, nowAs);
      }
    }
    svg.setAttribute("data-scale", String(s));
    placeBar();
    loadPictures();
    onViewChange(record);
  }

  function drawTree(rect: WorldRect | null, as: MapDrawing): void {
    if (model === null || marks === null) return;
    const markup = treeMarkup(model, marks, rect, as);
    detail.innerHTML = markup.tree;
    labels.innerHTML = markup.labels;
  }

  function setView(next: MapView): void {
    view = next;
    if (frame === 0 && win !== null) frame = win.requestAnimationFrame(paint);
    else if (win === null) paint();
  }

  /** F, or a half of "Full size | Fit": that view, as it was left. */
  function showView(which: "full" | "fit"): void {
    if (record.view !== which) move({ kind: "view", view: which });
  }

  /**
   * Full size scrolled to `y` (the layout top's screen y; mapmodel.ts
   * `scrollView` keeps it within the map), remembered as the reader's
   * place. Nothing at Fit, which does not move.
   */
  function scrollTo(y: number): void {
    if (record.view !== "full" || model === null) return;
    const next = scrollView(model, vh, view, y);
    if (next.y === view.y) return;
    record = remember(record, {
      kind: "place",
      place: placeOf(model, next, vw, vh),
    });
    setView(next);
  }
  const scrollBy = (dy: number) => scrollTo(view.y - dy);

  // Spoilers flipped: the same layout and view (the boxes' sizes never
  // depend on their text), only the text redrawn.
  function toggleSpoilers(): void {
    spoilers = !spoilers;
    showSpoilers();
    onSpoilersChange(spoilers);
    if (panel.hidden || model === null) return;
    marks = markNow(model);
    drawn = null;
    hideTip();
    if (frame === 0 && win !== null) frame = win.requestAnimationFrame(paint);
    else if (win === null) paint();
  }

  /** N (and the button): Full size, the newest bookmark's card centred. */
  function showNewest(): void {
    const id = newestBookmarkId(
      cards.filter((c) => !c.deleted).map((c) => c.row),
    );
    const card = id === null ? undefined : cardById.get(id);
    if (card === undefined || strip === null) return;
    useModel(cutFor("full", strip));
    if (model === null) return;
    // Its place is the card's own, so a resize keeps the card there.
    const next = fullSizeView(model, vw, vh, card.slot.cy);
    record = remember(record, {
      kind: "place",
      place: placeOf(model, next, vw, vh, card.slot.cx),
    });
    showPressed();
    setView(next);
  }

  function activate(target: MapTarget): void {
    if (model === null || marks === null) return;
    const jump = jumpFor(model, marks, target);
    if (jump !== null) onJump(jump);
  }

  // ---- Bookmark cards ----------------------------------------------------

  function cardElement(row: BookmarkSummary, index: number, newest: boolean) {
    const el = doc.createElement("div");
    el.className = newest ? "bm-card bm-newest" : "bm-card";
    el.dataset.bm = row.id;
    el.dataset.itemId = row.itemId;
    el.dataset.itemIndex = String(index);
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", cardLabel(row.timestampMs, newest));
    const thumb = doc.createElement("div");
    thumb.className = "bm-thumb";
    const picture = pictures.get(row.id);
    if (picture) thumb.append(picture);
    // Pointer controls only: no key acts on a card (Phase 35), so neither
    // button takes focus (a press never focuses: pointerdown is cancelled).
    const del = doc.createElement("button");
    del.type = "button";
    del.className = "bm-del";
    del.tabIndex = -1;
    del.setAttribute("aria-label", DELETE_LABEL);
    del.dataset.hint = DELETE_LABEL;
    const cross = doc.createElementNS(SVG_NS, "svg");
    cross.setAttribute("viewBox", "0 0 24 24");
    cross.setAttribute("aria-hidden", "true");
    const strokes = doc.createElementNS(SVG_NS, "path");
    strokes.setAttribute("d", DELETE_CROSS);
    cross.append(strokes);
    del.append(cross);
    const ghost = doc.createElement("div");
    ghost.className = "bm-ghost";
    const gone = doc.createElement("span");
    gone.textContent = "Deleted";
    const undo = doc.createElement("button");
    undo.type = "button";
    undo.className = "bm-undo";
    undo.tabIndex = -1;
    undo.textContent = "Undo";
    ghost.append(gone, undo);
    el.append(thumb, del, ghost);
    return el;
  }

  /** Each listed bookmark's card slot on `on` (null: none on the map). */
  function slotsOn(on: MapModel): (CardSlot | null)[] {
    return cardSlots(
      on,
      listed.map((l) => ({
        itemIndex: l.index,
        timestampMs: l.row.timestampMs,
      })),
    );
  }

  /**
   * The cards for the bookmarks listed, once per open, at their places on
   * the model on show; a switch of view moves them (`positionCards`), so a
   * ghost stays a ghost in either view. Which bookmarks have a card is the
   * strip's to say, so it is the same on every cut.
   */
  function makeCards(): void {
    cards = [];
    cardById.clear();
    if (model === null) return;
    const slots = slotsOn(model);
    const newest = newestBookmarkId(listed.map((l) => l.row));
    listed.forEach((l, i) => {
      const slot = slots[i];
      if (slot === null) return;
      const card: Card = {
        row: l.row,
        index: l.index,
        listedAt: i,
        slot,
        el: cardElement(l.row, l.index, l.row.id === newest),
        deleted: false,
        removing: null,
      };
      placeCard(card);
      cards.push(card);
      cardById.set(l.row.id, card);
    });
    // DOM order: story order, as they read along the lines (bands keep it).
    const ordered = [...cards].sort(
      (a, b) => a.slot.cy - b.slot.cy || a.slot.cx - b.slot.cx,
    );
    // Through a fragment, not a spread: one argument per bookmark throws
    // past about 120,000 in Chrome.
    const layer = doc.createDocumentFragment();
    for (const card of ordered) layer.append(card.el);
    cardLayer.replaceChildren(layer);
    newestButton.disabled = cards.length === 0;
  }

  function placeCard(card: Card): void {
    card.el.style.left = `${card.slot.x}px`;
    card.el.style.top = `${card.slot.y}px`;
  }

  /** The cards moved to their places on the model now on show. */
  function positionCards(): void {
    if (model === null || cards.length === 0) return;
    const slots = slotsOn(model);
    for (const card of cards) {
      const slot = slots[card.listedAt];
      if (slot === null) continue;
      card.slot = slot;
      placeCard(card);
    }
  }

  /**
   * Starts the next picture reads, a few at a time: the cards in or near
   * the view first, then the rest newest first (mapcards.ts).
   */
  function loadPictures(): void {
    if (bm === undefined || loading.size >= PICTURE_LOADS_AT_ONCE) return;
    const todo = cards.filter(
      (c) => !pictures.has(c.row.id) && !loading.has(c.row.id),
    );
    if (todo.length === 0) return;
    const order = pictureOrder(
      todo.map((c) => ({
        card: c,
        timestampMs: c.row.timestampMs,
        cx: c.slot.cx,
        cy: c.slot.cy,
      })),
      visibleWorld(view, vw, vh),
    );
    for (const { card } of order) {
      if (loading.size >= PICTURE_LOADS_AT_ONCE) break;
      const id = card.row.id;
      loading.add(id);
      bm.picture(card.row)
        .catch(() => null)
        .then((picture) => {
          loading.delete(id);
          if (picture !== null) {
            picture.classList.add("bm-pic");
            // A dragged image would start the browser's own drag.
            if (picture instanceof HTMLImageElement) picture.draggable = false;
          }
          pictures.set(id, picture);
          const now = cardById.get(id);
          if (picture !== null && now !== undefined)
            now.el.querySelector(".bm-thumb")?.replaceChildren(picture);
          if (!panel.hidden) loadPictures();
        });
    }
  }

  function cardOf(element: Element | null): Card | null {
    const el = element?.closest(".bm-card") ?? null;
    if (!(el instanceof HTMLElement)) return null;
    return cardById.get(el.dataset.bm ?? "") ?? null;
  }

  function partOf(element: Element | null): CardPart {
    if (element?.closest(".bm-del")) return "del";
    if (element?.closest(".bm-undo")) return "undo";
    return "card";
  }

  let toastTimer = 0;
  function showToast(on: boolean): void {
    toast.hidden = !on;
    if (win === null) return;
    win.clearTimeout(toastTimer);
    if (on)
      toastTimer = win.setTimeout(() => {
        toast.hidden = true;
      }, 8000);
  }

  function setDeleted(card: Card, deleted: boolean): void {
    card.deleted = deleted;
    card.el.classList.toggle("bm-deleted", deleted);
    deletions = deleted
      ? withDeleted(deletions, card.row.id)
      : withRestored(deletions, card.row.id);
    showToast(latestDeleted(deletions) !== null && deleted);
  }

  function deleteCard(card: Card): void {
    if (card.deleted || bm === undefined) return;
    setDeleted(card, true);
    card.removing = bm.remove(card.row).then(
      (undo) => {
        // The delete failed: the bookmark is still stored, so is its card.
        if (undo === null && card.deleted) setDeleted(card, false);
        return undo;
      },
      () => {
        if (card.deleted) setDeleted(card, false);
        return null;
      },
    );
  }

  async function undoCard(card: Card | null | undefined): Promise<void> {
    if (card == null || !card.deleted || card.removing === null) return;
    const removing = card.removing;
    card.removing = null;
    const undo = await removing;
    if (undo === null) return;
    const row = await undo().catch(() => null);
    if (row === null) {
      // Not stored again: it stays deleted, its undo still offered.
      card.removing = Promise.resolve(undo);
      return;
    }
    card.row = row;
    if (!panel.hidden) setDeleted(card, false);
  }

  function undoLatest(): void {
    const id = latestDeleted(deletions);
    if (id !== null) void undoCard(cardById.get(id));
  }

  toastUndo.addEventListener("click", undoLatest);
  // Never the browser's own drag of a picture: a drag scrolls.
  viewport.addEventListener("dragstart", (event) => event.preventDefault());

  // ---- Tooltip -----------------------------------------------------------

  /** The node under a client point, from the layout (either view). */
  function hitAt(clientX: number, clientY: number): MapTarget | null {
    if (model === null) return null;
    const outer = viewport.getBoundingClientRect();
    return hitTest(
      model,
      (clientX - outer.left - view.x) / view.scale,
      (clientY - outer.top - view.y) / view.scale,
    );
  }

  let tipFor = "";
  // The tip's first line, and its dimmer second line if it has one.
  function placeTip(
    key: string,
    fill: () => [string, string?],
    clientX: number,
    clientY: number,
  ): void {
    if (tip.hidden || tipFor !== key) {
      const [full, status] = fill();
      tip.textContent = "";
      const strong = doc.createElement("strong");
      strong.textContent = full;
      tip.append(strong);
      if (status !== undefined) {
        const line = doc.createElement("span");
        line.textContent = status;
        tip.append(line);
      }
      tip.hidden = false;
      tipFor = key;
    }
    const outer = viewport.getBoundingClientRect();
    const x = clientX - outer.left;
    const y = clientY - outer.top;
    const left = Math.min(x + 14, Math.max(8, vw - tip.offsetWidth - 8));
    const top =
      y + 22 + tip.offsetHeight > vh ? y - tip.offsetHeight - 14 : y + 22;
    tip.style.transform = `translate(${left}px, ${Math.max(top, 4)}px)`;
  }

  function showTip(target: MapTarget, clientX: number, clientY: number): void {
    if (model === null || marks === null) return;
    const m = model;
    const k = marks;
    const key =
      target.kind === "decision" ? `d${target.decision}` : `r${target.key}`;
    placeTip(
      key,
      () => {
        const { title: full, status } = describeTarget(m, k, target);
        return [full, status];
      },
      clientX,
      clientY,
    );
  }

  // A card's tip, the same in either view and on a ghost (Phase 36): only
  // when the bookmark was made (a card has no caption, Phase 40).
  function showCardTip(card: Card, clientX: number, clientY: number): void {
    placeTip(
      `b${card.row.id}`,
      () => [formatTimestamp(card.row.timestampMs)],
      clientX,
      clientY,
    );
  }

  // A hidden tip keeps no text: after Spoilers goes off, nothing it said
  // may linger in the DOM.
  function hideTip(): void {
    tip.hidden = true;
    tip.textContent = "";
  }

  // ---- Pointer -----------------------------------------------------------

  // A press that moves DRAG_PX is a drag, which scrolls Full size (and
  // does nothing at Fit); one that does not is a click on the node or card
  // it started on.
  let press: {
    id: number;
    x: number;
    y: number;
    view: MapView;
    hit: MapTarget | null;
    card: Card | null;
    part: CardPart;
    dragged: boolean;
  } | null = null;
  // A press on the map never starts a text selection (a drag scrolls, a
  // double click does nothing): `user-select: none` on the panel, and the
  // press's default (selection, in Safari too) prevented. Nothing in the
  // view takes focus from a press (the nodes are reached by Tab; a click
  // on one jumps), so focus and the keys are unaffected.
  viewport.addEventListener("selectstart", (event) => event.preventDefault());
  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (toast.contains(target) || bar.contains(target)) return;
    event.preventDefault();
    const card = cardOf(target);
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      view,
      hit: card === null ? hitAt(event.clientX, event.clientY) : null,
      card,
      part: partOf(target),
      dragged: false,
    };
    try {
      viewport.setPointerCapture(event.pointerId);
    } catch {
      // synthetic pointers cannot be captured; the drag still works
    }
  });
  viewport.addEventListener("pointermove", (event) => {
    if (press === null || press.id !== event.pointerId) {
      const target = event.target as Element;
      const off = toast.contains(target) || bar.contains(target);
      const card = off ? null : cardOf(target);
      const hit =
        off || card !== null ? null : hitAt(event.clientX, event.clientY);
      // Over a card's × or Undo, their own hint speaks (no card tooltip
      // under it).
      if (card !== null && partOf(target) === "card")
        showCardTip(card, event.clientX, event.clientY);
      else if (card !== null || hit === null) hideTip();
      else showTip(hit, event.clientX, event.clientY);
      viewport.classList.toggle(
        "map-pointing",
        card !== null ||
          (hit !== null &&
            model !== null &&
            marks !== null &&
            jumpFor(model, marks, hit) !== null),
      );
      return;
    }
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (!press.dragged && Math.hypot(dx, dy) < DRAG_PX) return;
    if (!press.dragged) {
      press.dragged = true;
      hideTip();
      if (scrolls()) viewport.classList.add("map-dragging");
    }
    scrollTo(press.view.y + dy);
  });
  const endPress = (event: PointerEvent, click: boolean) => {
    if (press === null || press.id !== event.pointerId) return;
    const done = press;
    press = null;
    viewport.classList.remove("map-dragging");
    if (!click || done.dragged) return;
    const card = done.card;
    if (card !== null) {
      // A ghost is its own Undo: anywhere on it (at Fit its button is
      // too small to aim at).
      if (done.part === "del") deleteCard(card);
      else if (done.part === "undo" || card.deleted) void undoCard(card);
      else if (bm !== undefined) bm.open(card.row);
      return;
    }
    if (done.hit !== null) activate(done.hit);
  };
  viewport.addEventListener("pointerup", (event) => endPress(event, true));
  viewport.addEventListener("pointercancel", (event) => endPress(event, false));
  viewport.addEventListener("pointerleave", () => {
    if (press === null) hideTip();
  });

  // The scroll bar: its thumb drags (the map follows it, the thumb's
  // travel standing for the map's), and a press on the track either side
  // of it scrolls a page that way. Its presses are its own, never a
  // press on the map.
  let barPress: { id: number; y: number; from: number } | null = null;
  bar.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    if (event.button !== 0 || model === null) return;
    event.preventDefault();
    if (event.target !== thumb) {
      const above = event.clientY < thumb.getBoundingClientRect().top;
      scrollBy((above ? -1 : 1) * vh * PAGE_SHARE);
      return;
    }
    barPress = { id: event.pointerId, y: event.clientY, from: view.y };
    bar.classList.add("map-scroll-held");
    try {
      bar.setPointerCapture(event.pointerId);
    } catch {
      // synthetic pointers cannot be captured; the drag still works
    }
  });
  bar.addEventListener("pointermove", (event) => {
    if (barPress === null || barPress.id !== event.pointerId || model === null)
      return;
    event.stopPropagation();
    const track = vh - 2 * SCROLL_BAR.inset;
    const height = shownHeight();
    const { length } = scrollThumb(track, height, vh, view.y);
    const travel = Math.max(1, track - length);
    const dy = event.clientY - barPress.y;
    scrollTo(barPress.from - (dy * (height - vh)) / travel);
  });
  const endBar = (event: PointerEvent) => {
    event.stopPropagation();
    if (barPress === null || barPress.id !== event.pointerId) return;
    barPress = null;
    bar.classList.remove("map-scroll-held");
  };
  bar.addEventListener("pointerup", endBar);
  bar.addEventListener("pointercancel", endBar);

  // The wheel or a trackpad scrolls Full size (a trackpad's momentum
  // arrives as more wheel events); Fit does not move. Neither zooms: a
  // trackpad pinch arrives as a ctrl+wheel (Chrome, Firefox) and as
  // gesture events (Safari), and does nothing, the page not zooming
  // either. Every wheel event over the panel is the map's: the story never
  // scrolls behind it.
  panel.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (event.ctrlKey || record.view !== "full") return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? vh : 1;
      hideTip();
      scrollBy(event.deltaY * unit);
    },
    { passive: false },
  );
  for (const type of ["gesturestart", "gesturechange", "gestureend"])
    panel.addEventListener(type, (event) => event.preventDefault());

  tools.addEventListener("click", (event) => {
    const act = (event.target as Element)
      .closest("[data-act]")
      ?.getAttribute("data-act");
    if (act === "spoil") toggleSpoilers();
    else if (act === "newest") showNewest();
    else if (act === "here") move({ kind: "centre" });
    else if (act === "full" || act === "fit") showView(act);
  });

  svg.addEventListener("focusin", (event) => {
    const hit = targetOf(event.target as Element);
    if (hit === null) return;
    const box = hit.node.getBoundingClientRect();
    showTip(hit.target, box.left, box.bottom - 16);
  });
  svg.addEventListener("focusout", hideTip);

  // The map's own keys, live only while it is open. None of them is in the
  // story key table (render/keys.ts): like a choice's digits they belong to
  // this one screen, and its buttons' hints name theirs. The scrolling keys
  // move Full size only; nothing moves sideways or zooms. No key acts on a
  // bookmark card (Phase 35): a card is clicked, its × deletes it, Z undoes.
  doc.addEventListener("keydown", (event) => {
    if (panel.hidden) return;
    const key = event.key;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    let handled = true;
    if (key === "ArrowUp") scrollBy(-KEY_SCROLL_PX);
    else if (key === "ArrowDown") scrollBy(KEY_SCROLL_PX);
    else if (key === "PageUp") scrollBy(-vh * PAGE_SHARE);
    else if (key === "PageDown") scrollBy(vh * PAGE_SHARE);
    else if (key === "Home") scrollTo(0);
    else if (key === "End") scrollTo(Number.NEGATIVE_INFINITY);
    else if ((key === "f" || key === "F") && plain)
      showView(record.view === "full" ? "fit" : "full");
    else if ((key === "c" || key === "C") && plain) move({ kind: "centre" });
    else if ((key === "n" || key === "N") && plain) showNewest();
    else if ((key === "z" || key === "Z") && plain) undoLatest();
    else if ((key === "s" || key === "S") && plain) toggleSpoilers();
    else if (key === "Enter") {
      const hit = targetOf(doc.activeElement);
      if (hit !== null && panel.contains(hit.node)) activate(hit.target);
      else handled = false;
    } else handled = false;
    if (handled) event.preventDefault();
  });

  function close(): void {
    if (panel.hidden) return;
    panel.hidden = true;
    opening += 1;
    hideTip();
    showToast(false);
    press = null;
    barPress = null;
    bar.classList.remove("map-scroll-held");
    if (frame !== 0 && win !== null) win.cancelAnimationFrame(frame);
    frame = 0;
    // Drop the drawn nodes and cards: a closed map holds no DOM worth
    // styling. The deletes made are final now; the next open reads the
    // list again.
    detail.textContent = "";
    labels.textContent = "";
    drawn = null;
    cardLayer.replaceChildren();
    cards = [];
    cardById.clear();
    deletions = NO_DELETIONS;
    onOpenChange?.(false);
  }

  /** The open's second half, once the bookmark list is read. */
  function show(rows: readonly BookmarkSummary[]): void {
    listed = [];
    for (const row of rows) {
      const index = bm?.itemIndex(row) ?? -1;
      if (index >= 0) listed.push({ row, index });
    }
    measure();
    const laid = stripNow();
    spoilers = spoilersSetting();
    showSpoilers();
    // The remembered view (mapmodel.ts `openingRecord`): Full size
    // centred on "you are here" when there is none, or its place came
    // from another layout. The marks are read afresh for this open, so
    // the model is put on show anew even when its cut is the last open's.
    record = openingRecord(rememberedView(), layout);
    model = null;
    useModel(cutFor(record.view, laid));
    makeCards();
    if (model === null || marks === null) return;
    showPressed();
    view = viewFor(model, record, marks.here, vw, vh);
    paint();
    panel.dataset.ready = "true";
  }

  return {
    isOpen() {
      return !panel.hidden;
    },
    ownsWheel() {
      return !panel.hidden;
    },
    open() {
      onOpenChange?.(true);
      drawn = null;
      detail.textContent = "";
      labels.textContent = "";
      cardLayer.replaceChildren();
      deletions = NO_DELETIONS;
      showToast(false);
      delete panel.dataset.ready;
      panel.hidden = false;
      opening += 1;
      const read = opening;
      const list =
        bm === undefined
          ? Promise.resolve([])
          : bm.list().catch(() => [] as readonly BookmarkSummary[]);
      void list.then((rows) => {
        if (read === opening && !panel.hidden) show(rows);
      });
    },
    close,
  };
}

function containsRect(outer: WorldRect, inner: WorldRect): boolean {
  return (
    inner.x0 >= outer.x0 &&
    inner.y0 >= outer.y0 &&
    inner.x1 <= outer.x1 &&
    inner.y1 <= outer.y1
  );
}
