// The branch map screen (docs/plan.md Phases 31, 33): `m` opens the
// decision tree with the reader's marks; drag pans, the wheel or a pinch
// zooms around the pointer, the arrow keys pan and +/- zoom, F (or 0) fits
// the whole tree and C centres on "you are here"; S (or the header's
// switch) flips Spoilers, off by default, which hides the text of
// decisions not reached (mapmodel.ts `MapMarks.hidden`). Esc or M closes.
// The header is the title and three buttons (Spoilers, Centre, Fit), each
// naming its key in a hover/focus hint (index.html `[data-hint]`). A click on a reached decision or one
// of its routes asks the shell to jump there (the machine does the moving;
// see mapmodel.ts `runJump`).
//
// The view is remembered (Phase 33): the first open is a Fit; after that
// the map reopens where it was left — a Fit as a fresh Fit for the window,
// anything else at the same world centre and zoom — across closes and,
// through the shell's state record, reloads (mapmodel.ts `restoreView`).
//
// Rendering: one SVG. The layout is computed once per manifest
// (mapmodel.ts); each open lays the reader's marks over it. Pan and zoom
// rewrite the world group's transform, once per animation frame. Three
// layers keep a game with hundreds of decisions at frame rate:
//
// - near (scale >= `labelMinScale`): the decision boxes, route pills and
//   screen counts as focusable groups with text, and the lines, CULLED —
//   only what lies within half a view's margin of the visible area exists,
//   redrawn (one string, one parse) when the view leaves that area. Culling
//   the lines matters as much as the nodes: a dashed stroke over a whole
//   large tree's connectors costs its full length in dashes every frame;
// - far (level of detail): no text and no per-node element; the whole tree
//   as one path per look (lines undashed, every box a rectangle).
//
// Clicks and hovers find their node from the layout (`hitTest`), so they
// work at any zoom. The "you are here" marker lives in screen space, so it
// keeps its size and stays findable at any zoom.
//
// All decisions are pure exports of mapmodel.ts; this file only applies them.

import {
  centreOn,
  fitView,
  hitTest,
  jumpFor,
  LABEL_CHARS,
  labelMinScale,
  layoutSignature,
  MAP_GEOMETRY,
  type MapJump,
  type MapMarks,
  type MapModel,
  type MapReader,
  type MapTarget,
  type MapView,
  markMap,
  PROMPT_CHARS,
  promptText,
  restoreView,
  routeText,
  type SavedMapView,
  saveView,
  truncateLabel,
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
  { act: "here", text: "Centre", key: "C" },
  { act: "fit", text: "Fit", key: "F" },
] as const;

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
  model: (aspect: number) => MapModel;
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
const ROUTE_GLYPH = { unseen: "○", partly: "◐", played: "●" } as const;
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
  const text = routeText(model, marks, target.key);
  const title = route.numbered ? `${route.route + 1}. ${text}` : text;
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
 * The near view's nodes: decision boxes, route pills and the stretches'
 * screen counts that touch `rect` (all of them for null), each node a
 * focusable group with its full text in its label. Pure.
 */
export function detailMarkup(
  model: MapModel,
  marks: MapMarks,
  rect: WorldRect | null = null,
): string {
  const g = MAP_GEOMETRY;
  const out: string[] = [];
  for (const run of model.runs) {
    if (!within(rect, run.x0, run.y - 20, run.x1, run.y)) continue;
    out.push(
      `<text class="map-count" x="${(run.x0 + run.x1) / 2}" y="${run.y - 9}">${screensLabel(run.end - run.start + 1)}</text>`,
    );
  }
  for (const node of model.decisions) {
    const top = node.y - g.decH / 2;
    if (!within(rect, node.x, top, node.x + g.decW, top + g.decH)) continue;
    const reached = marks.reached[node.index];
    const label = escapeXml(
      truncateLabel(promptText(model, marks, node.index), PROMPT_CHARS),
    );
    const target: MapTarget = { kind: "decision", decision: node.index };
    const { title, status } = describeTarget(model, marks, target);
    const sub = reached
      ? `${marks.playedCount[node.index]} of ${node.routes.length} routes played`
      : "not reached yet";
    out.push(
      `<g class="map-node map-dec${reached ? " map-reached" : " map-inert"}" data-d="${node.index}" transform="translate(${node.x} ${node.y})"${reached ? ' tabindex="0" role="button"' : ""} aria-label="${escapeXml(`${title}: ${status}`)}">` +
        `<rect x="0" y="${-g.decH / 2}" width="${g.decW}" height="${g.decH}" rx="8"/>` +
        `<text class="map-dec-q" x="14" y="-4">${label}</text>` +
        `<text class="map-dec-sub" x="14" y="16">${sub}</text></g>`,
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
    // Drawn out of manifest order: the choice number says which is which.
    const text = routeText(model, marks, key);
    const label = escapeXml(
      route.numbered
        ? `${route.route + 1}. ${truncateLabel(text, LABEL_CHARS - 3)}`
        : truncateLabel(text, LABEL_CHARS),
    );
    out.push(
      `<g class="${classes.join(" ")}" data-r="${key}" data-state="${state}" transform="translate(${route.x} ${route.y})"${reached ? ' tabindex="0" role="button"' : ""} aria-label="${escapeXml(`${title}: ${status}`)}">` +
        `<rect x="0" y="${-g.routeH / 2}" width="${g.routeW}" height="${g.routeH}" rx="${g.routeH / 2}"/>` +
        `<text x="14" y="5">${ROUTE_GLYPH[state]} ${label}</text></g>`,
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

export function mountBranchMap({
  root,
  model: buildModel,
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
  }
  const spoilButton = tools.firstElementChild as HTMLButtonElement;
  spoilButton.classList.add("map-spoil");
  spoilButton.setAttribute("aria-pressed", "false");
  head.append(title, tools);

  const viewport = doc.createElement("div");
  viewport.className = "map-view";
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "map-svg");
  const group = (cls: string) => {
    const g = doc.createElementNS(SVG_NS, "g");
    g.setAttribute("class", cls);
    return g;
  };
  // The world: the far view's whole tree (lines and skeleton boxes) and
  // the near view's culled lines and nodes. The marker sits outside it, in
  // screen space.
  const world = group("map-world");
  const skeleton = group("map-skeleton");
  const detail = group("map-detail");
  world.append(skeleton, detail);
  const here = group("map-here");
  here.innerHTML =
    '<circle class="map-here-ring" r="13"/><circle class="map-here-dot" r="6"/>' +
    '<text class="map-here-label" y="32">you are here</text>';
  svg.append(world, here);
  const tip = doc.createElement("div");
  tip.className = "map-tip";
  tip.hidden = true;
  viewport.append(svg, tip);
  panel.append(head, viewport);
  root.appendChild(panel);

  let model: MapModel | null = null;
  let modelAspect = 0;
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

  /**
   * Lays the tree out again when the view's shape has moved well away from
   * the one it was laid out for (the rows wrap to it); true when it did.
   */
  function layOut(): boolean {
    const aspect = vw / Math.max(1, vh);
    if (model !== null && Math.abs(Math.log(aspect / modelAspect)) <= 0.25)
      return false;
    model = buildModel(aspect);
    modelAspect = aspect;
    layout = layoutSignature(model);
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
    world.setAttribute(
      "transform",
      `translate(${view.x} ${view.y}) scale(${view.scale})`,
    );
    here.setAttribute(
      "transform",
      `translate(${marks.here.x * view.scale + view.x} ${marks.here.y * view.scale + view.y})`,
    );
    const nowFar = view.scale < labelMinScale(model);
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
    svg.setAttribute("data-scale", String(view.scale));
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
      ? { min: 0.1, max: 3 }
      : zoomLimits(model, vw, vh, marks?.here);
  }

  function zoomBy(factor: number, px?: number, py?: number): void {
    setView(zoomAt(view, factor, px ?? vw / 2, py ?? vh / 2, limits()));
  }

  function showWhole(): void {
    if (model === null) return;
    setView(fitView(model, vw, vh, marks?.here), true);
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

  function activate(target: MapTarget): void {
    if (model === null || marks === null) return;
    const jump = jumpFor(model, marks, target);
    if (jump !== null) onJump(jump);
  }

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
  function showTip(target: MapTarget, clientX: number, clientY: number): void {
    if (model === null || marks === null) return;
    const key =
      target.kind === "decision" ? `d${target.decision}` : `r${target.key}`;
    if (tip.hidden || tipFor !== key) {
      const { title: full, status } = describeTarget(model, marks, target);
      tip.textContent = "";
      const strong = doc.createElement("strong");
      strong.textContent = full;
      const line = doc.createElement("span");
      line.textContent = status;
      tip.append(strong, line);
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

  // A hidden tip keeps no text: after Spoilers goes off, nothing it said
  // may linger in the DOM.
  function hideTip(): void {
    tip.hidden = true;
    tip.textContent = "";
  }

  // Pointer: a press that moves pans; one that does not is a click on the
  // node it started on.
  let press: {
    id: number;
    x: number;
    y: number;
    view: MapView;
    hit: MapTarget | null;
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
    event.preventDefault();
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      view,
      hit: hitAt(event.clientX, event.clientY),
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
      const hit = hitAt(event.clientX, event.clientY);
      if (hit === null) hideTip();
      else showTip(hit, event.clientX, event.clientY);
      viewport.classList.toggle(
        "map-pointing",
        hit !== null &&
          model !== null &&
          marks !== null &&
          jumpFor(model, marks, hit) !== null,
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
    if (click && !done.dragged && done.hit !== null) activate(done.hit);
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
    else if (act === "here") recentre();
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
  // this one screen, and its buttons' hints name theirs.
  doc.addEventListener("keydown", (event) => {
    if (panel.hidden) return;
    const key = event.key;
    const pan = event.shiftKey ? KEY_PAN_PX * 3 : KEY_PAN_PX;
    let handled = true;
    if (key === "ArrowLeft") setView({ ...view, x: view.x + pan });
    else if (key === "ArrowRight") setView({ ...view, x: view.x - pan });
    else if (key === "ArrowUp") setView({ ...view, y: view.y + pan });
    else if (key === "ArrowDown") setView({ ...view, y: view.y - pan });
    else if (key === "+" || key === "=") zoomBy(KEY_ZOOM);
    else if (key === "-" || key === "_") zoomBy(1 / KEY_ZOOM);
    else if (key === "f" || key === "F" || key === "0") showWhole();
    else if (key === "c" || key === "C") recentre();
    else if (
      (key === "s" || key === "S") &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    )
      toggleSpoilers();
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
    hideTip();
    press = null;
    if (frame !== 0 && win !== null) win.cancelAnimationFrame(frame);
    frame = 0;
    // Drop the drawn nodes: a closed map holds no DOM worth styling.
    detail.textContent = "";
    skeleton.textContent = "";
    onOpenChange?.(false);
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
      panel.hidden = false;
      measure();
      layOut();
      spoilers = spoilersSetting();
      showSpoilers();
      if (model === null) return;
      marks = markNow(model);
      // The remembered view, or a Fit (mapmodel.ts `restoreView`). The
      // marker shows wherever it is; only C centres on it.
      const opening = restoreView(
        model,
        rememberedView(),
        vw,
        vh,
        marks.here,
        layout,
      );
      view = opening.view;
      fitted = opening.fit;
      far = view.scale < labelMinScale(model);
      svg.classList.toggle("map-far", far);
      paint();
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
