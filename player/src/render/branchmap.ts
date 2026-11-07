// The branch map screen (docs/plan.md Phases 31, 33, 35): `m` opens the
// decision tree with the reader's marks and the bookmarks as cards on the
// story line; drag pans, the wheel or a pinch zooms around the pointer, the
// arrow keys pan and +/- zoom, F (or 0) fits the whole tree, 1 shows it at
// 100% (a card at the old `t` screen's size), C centres on "you are here"
// and N on the newest bookmark; S (or the header's switch) flips Spoilers,
// off by default, which hides the text of decisions not reached
// (mapmodel.ts `MapMarks.hidden`). Esc or M closes. The header is the title
// and its buttons (Spoilers, Newest bookmark, Centre, 100%, Fit), each
// naming its key in a hover/focus hint (index.html `[data-hint]`). A click
// on a reached decision or one of its routes asks the shell to jump there
// (the machine does the moving; see mapmodel.ts `runJump`).
//
// Bookmarks (Phase 35, replacing the `t` screen): each is a card centred
// on its stretch's line at its screen's place (mapmodel.ts `cardSlots`),
// its thumbnail over its timestamp, the newest outlined and tagged. A click
// opens it (the shell restores it and closes the map); a drag that starts
// on a card pans. Its × deletes it at any zoom (drawn at a fixed screen
// size, so it stays usable at Fit); the card stays as a ghost with an Undo
// (a click anywhere on it undoes too) until the map closes, and Z undoes
// the latest delete. No key acts on a card. Pictures load lazily, a few at
// a time, the cards in view first (mapcards.ts `pictureOrder`); the shell
// shrinks a manifest still before a card shows it (bookmarks.ts
// `shrinkStill`), as Safari needs.
//
// The view is remembered (Phase 33): the first open is a Fit; after that
// the map reopens where it was left — a Fit as a fresh Fit for the window,
// anything else at the same world centre and zoom — across closes and,
// through the shell's state record, reloads (mapmodel.ts `restoreView`).
//
// Rendering: everything that moves with the view — the tree's SVG, the
// cards and the marker — lives in ONE stage element carrying the view's
// transform, so lines and cards can never drift apart (a separately
// transformed card layer once did, in Safari). The layout is computed once
// per manifest, view shape and set of bookmarked screens (mapmodel.ts);
// each open lays the reader's marks over it. Pan and zoom rewrite the
// stage's transform, once per animation frame. Two levels keep a game with
// hundreds of decisions at frame rate:
//
// - near (scale >= `labelMinScale`): the decision nodes, route pills and
//   screen counts as focusable groups with text, and the lines, CULLED —
//   only what lies within half a view's margin of the visible area exists,
//   redrawn (one string, one parse) when the view leaves that area. Culling
//   the lines matters as much as the nodes: a dashed stroke over a whole
//   large tree's connectors costs its full length in dashes every frame;
// - far (level of detail): no text and no per-node element; the whole tree
//   as one path per look (lines undashed, every box a rectangle).
//
// Clicks and hovers find their node from the layout (`hitTest`), so they
// work at any zoom. The "you are here" marker is drawn at a fixed screen
// size (scaled by the inverse of the zoom), so it stays findable at any
// zoom.
//
// All decisions are pure exports of mapmodel.ts and mapcards.ts; this file
// only applies them.

import type { BookmarkSummary } from "../storage/types";
import { DELETE_GLYPH, DELETE_LABEL, formatTimestamp } from "./bookmarks";
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
  centreOn,
  fitView,
  fullSizeView,
  hitTest,
  jumpFor,
  labelMinScale,
  layoutSignature,
  MAP_GEOMETRY,
  MAX_SCALE,
  type MapJump,
  type MapMarks,
  type MapModel,
  type MapReader,
  type MapTarget,
  type MapView,
  markMap,
  promptText,
  restoreView,
  routeText,
  type SavedMapView,
  saveView,
  viewAfterResize,
  visibleWorld,
  zoomAt,
  zoomLimits,
} from "./mapmodel";

export const MAP_TITLE = "Branch map";

/**
 * The header's buttons, in order: what each does, its text and the key its
 * hint names (the only help the header carries).
 */
export const MAP_TOOLS = [
  { act: "spoil", text: spoilersLabel(false), key: "S" },
  { act: "newest", text: "Newest bookmark", key: "N" },
  { act: "here", text: "Centre", key: "C" },
  { act: "full", text: "100%", key: "1" },
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
 * Below this scale a card's caption (13 px type, so under 9 px here) is
 * unreadable: the thumbnail fills the card, its time left to the hover
 * tooltip (which gives it at every zoom).
 */
export const CARD_SMALL_SCALE = 0.7;

/**
 * The size of a card's × in screen pixels at `scale`: 24 px, smaller on a
 * card under about 80 px wide (Fit on a large game), never under 14 px, so
 * it stays a usable target at any zoom without hiding a small card.
 */
export function deleteButtonPx(scale: number): number {
  return Math.max(14, Math.min(24, CARD.w * 0.3 * scale));
}

/**
 * The card layer's per-zoom style (index.html `.bm-card`, `.bm-del`): a
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

/** Pan per arrow press, in screen pixels; zoom per +/- press. */
const KEY_PAN_PX = 90;
const KEY_ZOOM = 1.25;
/** Pointer travel that makes a press a drag rather than a click. */
const DRAG_PX = 5;

export interface BranchMapOptions {
  /** The `#app` element; the panel is a sibling of the other panels. */
  root: HTMLElement;
  /**
   * The tree laid out for a view of this aspect (width / height); called on
   * the first open, and again only when the view's shape has changed a lot
   * since (the rows wrap to it).
   */
  model: (aspect: number, bookmarkItems: readonly number[]) => MapModel;
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

function screensLabel(n: number): string {
  return n === 1 ? "1 screen" : `${n} screens`;
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
      ? `${marks.playedCount[target.decision]} of ${total} routes played · click to go to this choice`
      : "not reached yet";
    return { title: promptText(model, marks, target.decision), status };
  }
  const route = model.routes[target.key];
  const parts: string[] = [
    ROUTE_WORD[marks.routes[target.key]],
    OUTCOME_WORD[route.outcome],
  ];
  if (marks.lastPick[target.key]) parts.push("your last pick");
  parts.push(
    marks.reached[route.decision]
      ? "click to play it from its start"
      : "decision not reached yet",
  );
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

/**
 * The lines: connectors, the stretches by mark, joins and end marks
 * touching `rect` (all of them for null), merged into one path element per
 * look, so even a whole large tree is a handful of elements. Pure.
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
    "map-wrap": [],
    "map-run map-run-unseen": [],
    "map-run map-run-partly": [],
    "map-run map-run-seen": [],
    "map-dot": [],
    "map-end": [],
  };
  const linkClass = {
    branch: "map-conn",
    join: "map-join",
    return: "map-return",
    wrap: "map-wrap",
  } as const;
  for (const link of model.links) {
    const y0 = Math.min(link.y0, link.y1);
    const y1 = Math.max(link.y0, link.y1);
    if (within(rect, link.x0, y0, link.x1, y1))
      paths[linkClass[link.kind]].push(link.d);
  }
  model.runs.forEach((run, i) => {
    if (within(rect, run.x0, run.y, run.x1, run.y))
      paths[`map-run map-run-${marks.runs[i]}`].push(
        `M${run.x0} ${run.y}H${run.x1}`,
      );
  });
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
 * The far view's nodes (level of detail): every box as plain rectangles
 * in a few paths, one per look — no text, no per-node element — so a whole
 * large tree paints in a few draw calls. Pure.
 */
export function skeletonMarkup(model: MapModel, marks: MapMarks): string {
  const g = MAP_GEOMETRY;
  const paths: Record<string, string[]> = {};
  const add = (cls: string, x: number, y: number, w: number, h: number) => {
    paths[cls] ??= [];
    paths[cls].push(`M${x} ${y - h / 2}h${w}v${h}h${-w}z`);
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
    const cls = [
      "map-route",
      `map-route-${marks.routes[key]}`,
      marks.reached[route.decision] ? "map-reached" : "map-inert",
    ];
    if (marks.lastPick[key]) cls.push("map-last");
    add(cls.join(" "), route.x, route.y, g.routeW, g.routeH);
  });
  return Object.entries(paths)
    .map(([cls, d]) => `<path class="map-box ${cls}" d="${d.join("")}"/>`)
    .join("");
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
 * The near view's nodes: decision nodes ("played/total", or "?" when not
 * reached), route pills (their choice number) and the stretches' counts
 * that touch `rect` (all of them for null), each node a focusable group
 * with its full text in its label (and the hover tooltip). Pure.
 */
export function detailMarkup(
  model: MapModel,
  marks: MapMarks,
  rect: WorldRect | null = null,
): string {
  const g = MAP_GEOMETRY;
  const out: string[] = [];
  for (const run of model.runs) {
    const screens = run.end - run.start + 1;
    const cards = run.bookmarks.length;
    if (cards === 0) {
      if (!within(rect, run.x0, run.y - 16, run.x1, run.y)) continue;
      out.push(
        `<text class="map-count" x="${(run.x0 + run.x1) / 2}" y="${run.y - 6}">${countText(screens, 0)}</text>`,
      );
    } else {
      const y = run.y + CARD_COUNT_DY;
      if (!within(rect, run.x0, y - 12, run.x1, y)) continue;
      out.push(
        `<text class="map-count map-count-cards" x="${run.x0 + CARD.inset}" y="${y}">${countText(screens, cards)}</text>`,
      );
    }
  }
  for (const node of model.decisions) {
    const top = node.y - g.decH / 2;
    if (!within(rect, node.x, top, node.x + g.decW, top + g.decH)) continue;
    const reached = marks.reached[node.index];
    const target: MapTarget = { kind: "decision", decision: node.index };
    const { title, status } = describeTarget(model, marks, target);
    const text = reached
      ? `${marks.playedCount[node.index]}/${node.routes.length}`
      : "?";
    out.push(
      `<g class="map-node map-dec${reached ? " map-reached" : " map-inert"}" data-d="${node.index}" transform="translate(${node.x} ${node.y})"${reached ? ' tabindex="0" role="button"' : ""} aria-label="${escapeXml(`${title}: ${status}`)}">` +
        `<rect x="0" y="${-g.decH / 2}" width="${g.decW}" height="${g.decH}" rx="5"/>` +
        `<text class="map-dec-c" x="${g.decW / 2}" y="4">${text}</text></g>`,
    );
  }
  model.routes.forEach((route, key) => {
    const top = route.y - g.routeH / 2;
    if (!within(rect, route.x, top, route.x + g.routeW, top + g.routeH)) return;
    const state = marks.routes[key];
    const reached = marks.reached[route.decision];
    const classes = [
      "map-node",
      "map-route",
      `map-route-${state}`,
      reached ? "map-reached" : "map-inert",
    ];
    if (marks.lastPick[key]) classes.push("map-last");
    const { title, status } = describeTarget(model, marks, {
      kind: "route",
      key,
    });
    out.push(
      `<g class="${classes.join(" ")}" data-r="${key}" data-state="${state}" transform="translate(${route.x} ${route.y})"${reached ? ' tabindex="0" role="button"' : ""} aria-label="${escapeXml(`${title}: ${status}`)}">` +
        `<rect x="0" y="${-g.routeH / 2}" width="${g.routeW}" height="${g.routeH}" rx="${g.routeH / 2}"/>` +
        `<text class="map-route-c" x="${g.routeW / 2}" y="4">${route.route + 1}</text></g>`,
    );
  });
  return out.join("");
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
  readonly slot: CardSlot;
  readonly el: HTMLElement;
  deleted: boolean;
  /** The delete in flight or done: resolves to its undo (null: it failed). */
  removing: Promise<(() => Promise<BookmarkSummary | null>) | null> | null;
}

/** Which part of a card a press landed on. */
type CardPart = "del" | "undo" | "card";

export function mountBranchMap({
  root,
  model: buildModel,
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
  // The world: the far view's whole tree (lines and skeleton boxes) and
  // the near view's culled lines and nodes; over it the cards, and over
  // them the marker.
  const world = group("map-world");
  const skeleton = group("map-skeleton");
  const detail = group("map-detail");
  world.append(skeleton, detail);
  svg.append(world);
  const cardLayer = doc.createElement("div");
  cardLayer.className = "map-cards";
  const top = svgOf("map-svg map-top");
  const here = group("map-here");
  here.innerHTML =
    '<circle class="map-here-ring" r="13"/><circle class="map-here-dot" r="6"/>' +
    '<text class="map-here-label" y="32">you are here</text>';
  top.append(here);
  stage.append(svg, cardLayer, top);
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
  viewport.append(stage, tip, toast);
  panel.append(head, viewport);
  root.appendChild(panel);

  let model: MapModel | null = null;
  let modelAspect = 0;
  // The bookmarked screens the model was laid out for (a sorted list).
  let modelItems = "";
  // The model's layout signature (what a remembered view is checked
  // against), computed once per layout.
  let layout = "";
  let marks: MapMarks | null = null;
  // Spoilers, as read at the open and flipped since (the marks carry it).
  let spoilers = false;
  const showSpoilers = () => {
    spoilButton.textContent = spoilersLabel(spoilers);
    spoilButton.setAttribute("aria-pressed", String(spoilers));
  };
  const markNow = (m: MapModel) => markMap(m, { ...reader(), spoilers });
  let view: MapView = { x: 0, y: 0, scale: 1 };
  // The view is Fit's (F, the button, or the opening Fit) and nothing has
  // moved it since: a resize fits again rather than keeping the old size,
  // and it is remembered as a Fit.
  let fitted = false;
  let frame = 0;
  let far = false;
  let small = false;
  // The scale the card layer's per-zoom style was last set for.
  let styledScale = 0;
  // The world rectangle the near nodes are drawn for (null: none drawn),
  // and whether the skeleton is drawn for the current marks.
  let drawn: WorldRect | null = null;
  let skeletonDrawn = false;
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

  /**
   * Lays the tree out again when the view's shape has moved well away from
   * the one it was laid out for (the rows wrap to it), or the bookmarked
   * screens changed; true when it did.
   */
  function layOut(): boolean {
    const aspect = vw / Math.max(1, vh);
    const items = listed.map((l) => l.index).sort((a, b) => a - b);
    const itemsKey = items.join(",");
    if (
      model !== null &&
      itemsKey === modelItems &&
      Math.abs(Math.log(aspect / modelAspect)) <= 0.25
    )
      return false;
    model = buildModel(aspect, items);
    modelAspect = aspect;
    modelItems = itemsKey;
    layout = layoutSignature(model);
    const size = (el: Element) => {
      el.setAttribute("width", String(model?.width ?? 0));
      el.setAttribute("height", String(model?.height ?? 0));
    };
    size(svg);
    size(top);
    stage.style.width = `${model.width}px`;
    stage.style.height = `${model.height}px`;
    placeCards();
    return true;
  }

  // The view changed size while open (a window resize, entering or leaving
  // fullscreen, the header rewrapping): a fitted view fits the new size, any
  // other keeps the world point at its centre (or, laid out anew, centres
  // on "you are here"). The viewport's own size is watched, so its final
  // size after a fullscreen change is the one used.
  const resized = () => {
    if (panel.hidden || model === null || marks === null) return;
    const from = { w: vw, h: vh };
    measure();
    if (vw === from.w && vh === from.h) return;
    if (layOut() && model !== null) {
      marks = markNow(model);
      drawn = null;
      skeletonDrawn = false;
      if (!fitted)
        view = centreOn(marks.here.x, marks.here.y, vw, vh, view.scale);
    } else if (!fitted) view = viewAfterResize(view, from, { w: vw, h: vh });
    if (fitted) showWhole();
    else setView(view);
  };
  const Observer = win?.ResizeObserver as typeof ResizeObserver | undefined;
  if (Observer !== undefined) new Observer(resized).observe(viewport);
  else win?.addEventListener("resize", resized);

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
    // Only a zoom restyles the cards: a pan leaves their style alone.
    if (s !== styledScale) {
      styledScale = s;
      for (const [name, value] of Object.entries(cardScaleStyle(s)))
        cardLayer.style.setProperty(name, value);
    }
    const nowSmall = s < CARD_SMALL_SCALE;
    if (nowSmall !== small) {
      small = nowSmall;
      cardLayer.classList.toggle("map-cards-small", small);
    }
    const nowFar = s < labelMinScale(model);
    if (nowFar !== far) {
      far = nowFar;
      svg.classList.toggle("map-far", far);
    }
    if (far) {
      if (!skeletonDrawn) {
        skeleton.innerHTML =
          linesMarkup(model, marks) + skeletonMarkup(model, marks);
        skeletonDrawn = true;
      }
    } else {
      // Culling: the near nodes are drawn for the view plus a margin of
      // half a view each way, and redrawn only once the view leaves that.
      const seen = visibleWorld(view, vw, vh);
      if (drawn === null || !containsRect(drawn, seen)) {
        const w = (seen.x1 - seen.x0) / 2;
        const h = (seen.y1 - seen.y0) / 2;
        drawn = {
          x0: seen.x0 - w,
          y0: seen.y0 - h,
          x1: seen.x1 + w,
          y1: seen.y1 + h,
        };
        detail.innerHTML =
          linesMarkup(model, marks, drawn) + detailMarkup(model, marks, drawn);
      }
    }
    svg.setAttribute("data-scale", String(s));
    loadPictures();
    onViewChange(saveView(layout, view, vw, vh, fitted));
  }

  function setView(next: MapView, fit = false): void {
    view = next;
    fitted = fit;
    if (frame === 0 && win !== null) frame = win.requestAnimationFrame(paint);
    else if (win === null) paint();
  }

  function limits() {
    return model === null
      ? { min: 0.1, max: MAX_SCALE }
      : zoomLimits(model, vw, vh, marks?.here);
  }

  function zoomBy(factor: number, px?: number, py?: number): void {
    setView(zoomAt(view, factor, px ?? vw / 2, py ?? vh / 2, limits()));
  }

  function showWhole(): void {
    if (model === null) return;
    setView(fitView(model, vw, vh, marks?.here), true);
  }

  function fullSize(): void {
    if (model !== null) setView(fullSizeView(view, vw, vh, limits()));
  }

  // Spoilers flipped: the same layout and view (the boxes' sizes never
  // depend on their text), only the text redrawn.
  function toggleSpoilers(): void {
    spoilers = !spoilers;
    showSpoilers();
    onSpoilersChange(spoilers);
    if (panel.hidden || model === null) return;
    marks = markNow(model);
    drawn = null;
    skeletonDrawn = false;
    hideTip();
    if (frame === 0 && win !== null) frame = win.requestAnimationFrame(paint);
    else if (win === null) paint();
  }

  function recentre(): void {
    if (marks !== null)
      setView(centreOn(marks.here.x, marks.here.y, vw, vh, view.scale));
  }

  /** N (and the button): the newest bookmark's card, centred at 100%. */
  function showNewest(): void {
    const id = newestBookmarkId(
      cards.filter((c) => !c.deleted).map((c) => c.row),
    );
    const card = id === null ? undefined : cardById.get(id);
    if (card === undefined || model === null) return;
    const scale = Math.min(limits().max, Math.max(limits().min, 1));
    setView(centreOn(card.slot.cx, card.slot.cy, vw, vh, scale));
  }

  function activate(target: MapTarget): void {
    if (model === null || marks === null) return;
    const jump = jumpFor(model, marks, target);
    if (jump !== null) onJump(jump);
  }

  // ---- Bookmark cards ----------------------------------------------------

  function cardElement(
    row: BookmarkSummary,
    index: number,
    slot: CardSlot,
    newest: boolean,
  ) {
    const el = doc.createElement("div");
    el.className = newest ? "bm-card bm-newest" : "bm-card";
    el.dataset.bm = row.id;
    el.dataset.itemId = row.itemId;
    el.dataset.itemIndex = String(index);
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", cardLabel(row.timestampMs, newest));
    el.style.left = `${slot.x}px`;
    el.style.top = `${slot.y}px`;
    const thumb = doc.createElement("div");
    thumb.className = "bm-thumb";
    const picture = pictures.get(row.id);
    if (picture) thumb.append(picture);
    const caption = doc.createElement("div");
    caption.className = "bm-cap";
    const time = doc.createElement("span");
    time.className = "bm-time";
    time.textContent = formatTimestamp(row.timestampMs);
    caption.append(time);
    if (newest) {
      const tag = doc.createElement("span");
      tag.className = "bm-tag";
      tag.textContent = "Newest";
      caption.append(tag);
    }
    // Pointer controls only: no key acts on a card (Phase 35), so neither
    // button takes focus (a press never focuses: pointerdown is cancelled).
    const del = doc.createElement("button");
    del.type = "button";
    del.className = "bm-del";
    del.tabIndex = -1;
    del.setAttribute("aria-label", DELETE_LABEL);
    del.dataset.hint = DELETE_LABEL;
    del.textContent = DELETE_GLYPH;
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
    el.append(thumb, caption, del, ghost);
    return el;
  }

  /** The cards for the bookmarks listed, on the model laid out for them. */
  function placeCards(): void {
    cards = [];
    cardById.clear();
    if (model === null) return;
    const slots = cardSlots(
      model,
      listed.map((l) => ({
        itemIndex: l.index,
        timestampMs: l.row.timestampMs,
      })),
    );
    const newest = newestBookmarkId(listed.map((l) => l.row));
    listed.forEach((l, i) => {
      const slot = slots[i];
      if (slot === null) return;
      const card: Card = {
        row: l.row,
        index: l.index,
        slot,
        el: cardElement(l.row, l.index, slot, l.row.id === newest),
        deleted: false,
        removing: null,
      };
      cards.push(card);
      cardById.set(l.row.id, card);
    });
    // DOM order: story order, as they read along the lines.
    const ordered = [...cards].sort(
      (a, b) => a.slot.cy - b.slot.cy || a.slot.cx - b.slot.cx,
    );
    cardLayer.replaceChildren(...ordered.map((c) => c.el));
    newestButton.disabled = cards.length === 0;
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
  // Never the browser's own drag of a picture: a drag pans.
  viewport.addEventListener("dragstart", (event) => event.preventDefault());

  // ---- Tooltip -----------------------------------------------------------

  /** The node under a client point, from the layout (any zoom). */
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

  // A card's tip, the same at every zoom and on a ghost (Phase 36): only
  // when the bookmark was made, the caption's text.
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

  // A press that moves pans; one that does not is a click on the node or
  // card it started on.
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
  // A press on the map never starts a text selection (a drag pans, a
  // double click zooms nothing): `user-select: none` on the panel, and the
  // press's default (selection, in Safari too) prevented. Nothing in the
  // view takes focus from a press (the nodes are reached by Tab; a click
  // on one jumps), so focus and the keys are unaffected.
  viewport.addEventListener("selectstart", (event) => event.preventDefault());
  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (toast.contains(target)) return;
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
      const card = toast.contains(target) ? null : cardOf(target);
      const hit = card === null ? hitAt(event.clientX, event.clientY) : null;
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
      viewport.classList.add("map-dragging");
      hideTip();
    }
    setView({ ...press.view, x: press.view.x + dx, y: press.view.y + dy });
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

  // The wheel zooms around the pointer; a trackpad pinch arrives as a
  // ctrl+wheel (Chrome, Firefox) — finer steps, and the page must not zoom —
  // and a sideways trackpad swipe pans. Every wheel event over the panel is
  // the map's: the story never scrolls behind it.
  panel.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (model === null) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? vh : 1;
      const dy = event.deltaY * unit;
      const dx = event.deltaX * unit;
      const outer = viewport.getBoundingClientRect();
      hideTip();
      if (Math.abs(dx) > Math.abs(dy)) {
        setView({ ...view, x: view.x - dx });
        return;
      }
      const rate = event.ctrlKey ? 0.01 : 0.0018;
      const factor = Math.exp(-Math.max(-300, Math.min(300, dy)) * rate);
      zoomBy(factor, event.clientX - outer.left, event.clientY - outer.top);
    },
    { passive: false },
  );
  // Safari's pinch: gesture events with a running scale.
  let gestureScale = 1;
  const gesture = (event: Event & { scale?: number; clientX?: number }) => {
    event.preventDefault();
    const scale = typeof event.scale === "number" ? event.scale : 1;
    if (event.type === "gesturestart") {
      gestureScale = 1;
      return;
    }
    const outer = viewport.getBoundingClientRect();
    zoomBy(
      scale / gestureScale,
      typeof event.clientX === "number" ? event.clientX - outer.left : vw / 2,
      vh / 2,
    );
    gestureScale = scale;
  };
  for (const type of ["gesturestart", "gesturechange", "gestureend"])
    panel.addEventListener(type, gesture as EventListener);

  tools.addEventListener("click", (event) => {
    const act = (event.target as Element)
      .closest("[data-act]")
      ?.getAttribute("data-act");
    if (act === "spoil") toggleSpoilers();
    else if (act === "newest") showNewest();
    else if (act === "here") recentre();
    else if (act === "full") fullSize();
    else if (act === "fit") showWhole();
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
  // this one screen, and its buttons' hints name theirs. No key acts on a
  // bookmark card (Phase 35): a card is clicked, its × deletes it, Z undoes.
  doc.addEventListener("keydown", (event) => {
    if (panel.hidden) return;
    const key = event.key;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    const pan = event.shiftKey ? KEY_PAN_PX * 3 : KEY_PAN_PX;
    let handled = true;
    if (key === "ArrowLeft") setView({ ...view, x: view.x + pan });
    else if (key === "ArrowRight") setView({ ...view, x: view.x - pan });
    else if (key === "ArrowUp") setView({ ...view, y: view.y + pan });
    else if (key === "ArrowDown") setView({ ...view, y: view.y - pan });
    else if (key === "+" || key === "=") zoomBy(KEY_ZOOM);
    else if (key === "-" || key === "_") zoomBy(1 / KEY_ZOOM);
    else if (key === "f" || key === "F" || key === "0") showWhole();
    else if (key === "1") fullSize();
    else if (key === "c" || key === "C") recentre();
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
    if (frame !== 0 && win !== null) win.cancelAnimationFrame(frame);
    frame = 0;
    // Drop the drawn nodes and cards: a closed map holds no DOM worth
    // styling. The deletes made are final now; the next open reads the
    // list again.
    detail.textContent = "";
    skeleton.textContent = "";
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
    if (!layOut()) placeCards();
    spoilers = spoilersSetting();
    showSpoilers();
    if (model === null) return;
    marks = markNow(model);
    // The remembered view, or a Fit (mapmodel.ts `restoreView`). The
    // marker shows wherever it is; only C centres on it.
    const start = restoreView(
      model,
      rememberedView(),
      vw,
      vh,
      marks.here,
      layout,
    );
    view = start.view;
    fitted = start.fit;
    far = view.scale < labelMinScale(model);
    svg.classList.toggle("map-far", far);
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
      skeletonDrawn = false;
      detail.textContent = "";
      skeleton.textContent = "";
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
