import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMachine } from "../machine/machine";
import type { Branch, Item, Route } from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import {
  boxesMarkup,
  capsulePath,
  describeTarget,
  detailMarkup,
  figuresMarkup,
  LINE_MIN_SCALE,
  LINE_STEPS_PER_OCTAVE,
  labelsMarkup,
  lineScaleStyle,
  linesMarkup,
  scrollThumb,
  tickClass,
  treeMarkup,
} from "./branchmap";
import {
  CARD,
  CARD_ABOVE,
  CARD_BELOW,
  CARD_COUNT_DY,
  type CardSlot,
  cardSlots,
  cutBands,
  FIGURE_INK_PX,
  FIT_MARGIN_PX,
  FULL_SIZE_INSET,
  figuresVisible,
  fitView,
  fitWidth,
  fullSizeView,
  fullSizeWidth,
  HERE_DECISION_GAP,
  HERE_REACH,
  hitTest,
  itemPoint,
  jumpFor,
  layOutStrip,
  MAP_GEOMETRY,
  MAX_SCALE,
  type MapModel,
  type MapReader,
  type MapRun,
  type MapStrip,
  type MapView,
  mapDrawing,
  markMap,
  NODE_GROUP_MIN_SCALE,
  nodeGroupMinScale,
  openingRecord,
  placeOf,
  placeY,
  pointAlong,
  remember,
  runAt,
  runJump,
  type SavedMapView,
  SMALL_NODE_GROUP_MIN_SCALE,
  scrollView,
  stripSignature,
  tickBox,
  tickPaths,
  viewFor,
  visibleWorld,
} from "./mapmodel";

/**
 * The tree cut into bands for a layout `width` wide, its padding included
 * (by default Full size's cut in a 1920 px map view).
 */
function buildMapModel(
  items: readonly Item[],
  branches: readonly Branch[] | undefined,
  width = fullSizeWidth(1920),
  bookmarkItems: readonly number[] = [],
): MapModel {
  return cutBands(layOutStrip(items, branches, bookmarkItems), width);
}

/** Fit's layout of `strip` for a vw x vh map view (`fitWidth`). */
function fitCut(strip: MapStrip, vw: number, vh: number): MapModel {
  return cutBands(strip, fitWidth(strip, vw, vh));
}

/** Full size's layout of `strip` for a map view `vw` wide. */
function fullCut(strip: MapStrip, vw: number): MapModel {
  return cutBands(strip, fullSizeWidth(vw));
}

// The branch map's pure half (docs/plan.md Phase 31): the tree laid out from
// the decisions the machine resolves, the reader's marks over it, the
// here-marker, the click-to-jump rule run through a REAL machine, and the
// view arithmetic.

function image(id: string): Item {
  return { id, type: "image", file: `${id}.jpg` };
}

// The demo's shape (fixtures/demo, trimmed): a decision whose continuing
// route holds a nested decision, and an ending route.
//  lead decide | r1-start r1-nest | nest-cont | nest-ret | r1-end | r2-start r2-end | after-1 after-2
//  0    1      | 2        3       | 4         | 5        | 6      | 7        8      | 9       10
const DEMO_ITEMS = [
  "lead",
  "decide",
  "r1-start",
  "r1-nest",
  "nest-cont",
  "nest-ret",
  "r1-end",
  "r2-start",
  "r2-end",
  "after-1",
  "after-2",
].map(image);
const DEMO_BRANCHES: Branch[] = [
  {
    id: "nested",
    after: "r1-nest",
    prompt: "Nested decision inside Route 1:",
    routes: [
      {
        id: "nest-a",
        label: "1a: carries on",
        start: "nest-cont",
        end: "nest-cont",
      },
      {
        id: "nest-b",
        label: "1b: comes back",
        start: "nest-ret",
        end: "nest-ret",
        result: "return",
      },
    ],
    continuingRoute: "nest-a",
    continueAt: "r1-end",
  },
  {
    id: "outer",
    after: "decide",
    prompt: "Demo decision: which route?",
    routes: [
      {
        id: "route1",
        label: "Route 1: continues the story",
        start: "r1-start",
        end: "r1-end",
        result: "return",
      },
      {
        id: "route2",
        label: "Route 2: an ending",
        start: "r2-start",
        end: "r2-end",
      },
    ],
    continuingRoute: "route1",
    continueAt: "after-1",
  },
];
// Machine indices follow the branch table: nested = 0, outer = 1.
const NESTED = 0;
const OUTER = 1;

function demoModel(): MapModel {
  return buildMapModel(DEMO_ITEMS, DEMO_BRANCHES);
}

function demoMachine() {
  return createMachine({
    items: DEMO_ITEMS,
    branches: DEMO_BRANCHES,
    settings: { ...DEFAULT_SETTINGS, playAllRoutes: false },
  });
}

type DemoMachine = ReturnType<typeof demoMachine>;

function readerOf(m: DemoMachine): MapReader {
  const ctx = m.exportContext();
  const state = m.getState();
  return {
    visited: ctx.visited,
    playedRoutes: ctx.playedRoutes,
    completedRoutes: ctx.completedRoutes,
    lastPicks: ctx.lastPicks,
    cursor: state.cursor,
    choiceId: state.choice?.decisionId,
  };
}

function routeKey(model: MapModel, decision: number, route: number): number {
  const key = model.routes.findIndex(
    (r) => r.decision === decision && r.route === route,
  );
  if (key < 0) throw new Error(`no route ${decision}/${route}`);
  return key;
}

function opsFor(m: DemoMachine, model: MapModel) {
  return {
    openChoice: () => {
      const open = m.getState().choice;
      return open === undefined
        ? -1
        : (model.decisionById.get(open.decisionId) ?? -1);
    },
    walkedChoice: () => m.getState().choice?.walkRoute !== undefined,
    showChoice: (d: number) => m.showChoice(d),
    choose: (r: number) => m.choose(r),
    enterSpan: (d: number, span: number) => m.enterSpan(d, span),
  };
}

describe("buildMapModel: the tree from the decisions", () => {
  it("draws a linear story as one stretch with no decisions", () => {
    const model = buildMapModel(["a", "b", "c"].map(image), undefined);
    expect(model.decisions).toHaveLength(0);
    expect(model.runs).toEqual([expect.objectContaining({ start: 0, end: 2 })]);
    expect(model.ends).toHaveLength(1); // the story's own end
  });

  it("collapses the screens between decisions into stretches, each item in exactly one", () => {
    const model = demoModel();
    const covered = model.runs.flatMap((run) =>
      Array.from({ length: run.end - run.start + 1 }, (_, i) => run.start + i),
    );
    expect(covered.sort((a, b) => a - b)).toEqual(DEMO_ITEMS.map((_, i) => i));
    // lead..decide, then route 1's r1-start..r1-nest, the nested routes,
    // r1-end, route 2, and the line after the join.
    expect(model.runs.map((r) => [r.start, r.end])).toEqual([
      [0, 1],
      [2, 3],
      [4, 4],
      [5, 5],
      [6, 6],
      [7, 8],
      [9, 10],
    ]);
  });

  it("lays every decision out with its routes, nesting and outcomes", () => {
    const model = demoModel();
    expect(model.decisions.map((d) => d.index)).toEqual([NESTED, OUTER]);
    const outer = model.decisionAt[OUTER];
    const nested = model.decisionAt[NESTED];
    if (outer === undefined || nested === undefined) throw new Error("unset");
    const r1 = model.routes[routeKey(model, OUTER, 0)];
    const r2 = model.routes[routeKey(model, OUTER, 1)];
    // Routes stack down from the decision's row, in table order.
    expect(r1.y).toBe(outer.y);
    expect(r2.y).toBeGreaterThan(r1.y);
    // The nested decision sits on route 1's row, right of its pill; its
    // two routes make route 1 two rows tall, but route 2, an ending, fits
    // in the empty column under route 1's pill, so it tucks in on the next
    // row.
    expect(nested.y).toBe(r1.y);
    expect(nested.x).toBeGreaterThan(r1.x + MAP_GEOMETRY.routeW);
    expect(r2.y - r1.y).toBe(MAP_GEOMETRY.rowH);
    expect(r2.x).toBe(r1.x);
    expect(r2.endX + 17).toBeLessThan(nested.x + MAP_GEOMETRY.decW);
    expect(model.bands).toHaveLength(1);
    expect(model.routes.map((r) => [r.label, r.outcome])).toEqual([
      ["1a: carries on", "continues"],
      ["1b: comes back", "returns"],
      ["Route 1: continues the story", "continues"],
      ["Route 2: an ending", "ends"],
    ]);
    // Two joins (one per decision); end marks for route 2 and the story.
    expect(model.joins).toHaveLength(2);
    expect(model.ends).toHaveLength(2);
    expect(model.links.filter((l) => l.kind === "return")).toHaveLength(1);
    expect(model.links.filter((l) => l.kind === "branch")).toHaveLength(4);
    // The line carries on after the outer join.
    const after = runAt(model.runs, 9);
    expect(after?.x0).toBeGreaterThan(r1.endX);
    expect(after?.y).toBe(outer.y);
  });

  it("draws a continue route's end as a join into the decision's join point, like the continuing route's (docs/plan.md Phase 38)", () => {
    // lead decide | c-1 c-2 | n-1 | p-1 | shared
    const items = ["lead", "decide", "c-1", "c-2", "n-1", "p-1", "shared"].map(
      image,
    );
    const branches: Branch[] = [
      {
        id: "rowan",
        after: "decide",
        prompt: "What does Rowan do?",
        routes: [
          {
            id: "negotiate",
            label: "Negotiate",
            start: "n-1",
            end: "n-1",
            result: "continue",
          },
          {
            id: "pay",
            label: "Pay",
            start: "p-1",
            end: "p-1",
            result: "continue",
          },
          { id: "contract", label: "Contract", start: "c-1", end: "c-2" },
        ],
        continuingRoute: "contract",
        continueAt: "shared",
      },
    ];
    const model = buildMapModel(items, branches);
    const node = model.decisionAt[0];
    if (node === undefined) throw new Error("unset");
    expect(model.routes.map((r) => [r.label, r.outcome])).toEqual([
      ["Negotiate", "continues"],
      ["Pay", "continues"],
      ["Contract", "continues"],
    ]);
    // Three join lines, every one into the one join dot on the decision's
    // row; no return line, and no end mark but the story's own.
    const joins = model.links.filter((l) => l.kind === "join");
    expect(joins).toHaveLength(3);
    expect(model.links.filter((l) => l.kind === "return")).toHaveLength(0);
    expect(model.joins).toHaveLength(1);
    const dot = model.joins[0];
    expect(dot.y).toBe(node.y);
    for (const link of joins) {
      expect(link.x1).toBe(dot.x);
      expect(link.y0).toBe(node.y);
    }
    expect(model.ends).toHaveLength(1);
    expect(model.ends[0]).toEqual(model.storyEnd);
  });

  it("keeps a large, deeply nested game's nodes apart and lays it out fast", () => {
    const { items, branches } = synthetic(30, 6, 26);
    expect(branches.length).toBeGreaterThan(500);
    expect(items.length).toBeGreaterThan(80000);
    const started = performance.now();
    const model = buildMapModel(items, branches);
    const took = performance.now() - started;
    expect(model.decisions).toHaveLength(branches.length);
    expect(took).toBeLessThan(400); // typically a few ms
    // No two route pills share a spot: same row means far enough apart.
    const pills = [...model.routes].sort((a, b) => a.y - b.y || a.x - b.x);
    for (let i = 1; i < pills.length; i += 1) {
      const a = pills[i - 1];
      const b = pills[i];
      if (a.y === b.y)
        expect(b.x - a.x).toBeGreaterThanOrEqual(MAP_GEOMETRY.routeW);
    }
  });
});

describe("buildMapModel: bands like a score's systems, endings tucked in", () => {
  const g = MAP_GEOMETRY;
  type Box = { x0: number; y0: number; x1: number; y1: number };

  function boxesOf(model: MapModel): Box[] {
    return [
      ...model.decisions.map((d) => ({
        x0: d.x,
        y0: d.y - g.decH / 2,
        x1: d.x + g.decW,
        y1: d.y + g.decH / 2,
      })),
      ...model.routes.map((r) => ({
        x0: r.x,
        y0: r.y - g.routeH / 2,
        x1: r.x + g.routeW,
        y1: r.y + g.routeH / 2,
      })),
    ];
  }

  // The top-level decisions (parent -1), in story order.
  function topLevel(model: MapModel, prompt = "at level 1") {
    return model.decisions
      .filter((d) => d.prompt.includes(prompt))
      .sort((a, b) => a.afterIndex - b.afterIndex);
  }

  it("wraps a large game's main line into bands, in reading order, about the view's shape at Fit", () => {
    const { items, branches } = synthetic(30, 6, 26);
    const strip = layOutStrip(items, branches);
    for (const [vw, vh] of [
      [1920, 1080],
      [1920, 960],
      [1440, 1080],
    ]) {
      const model = fitCut(strip, vw, vh);
      expect(model.bands.length).toBeGreaterThan(2);
      const shape = model.width / model.height;
      const aspect = vw / vh;
      expect(shape / aspect).toBeGreaterThan(0.6);
      expect(shape / aspect).toBeLessThan(1.6);
      // Reading order: each top-level decision is right of the one before
      // on its row, or on a lower row, starting again at the left.
      const tops = topLevel(model);
      expect(tops).toHaveLength(30);
      const rowYs = [...new Set(tops.map((d) => d.y))];
      expect(rowYs).toHaveLength(model.bands.length);
      for (let i = 1; i < tops.length; i += 1) {
        const [a, b] = [tops[i - 1], tops[i]];
        if (a.y === b.y) expect(b.x).toBeGreaterThan(a.x);
        else {
          expect(b.y).toBeGreaterThan(a.y);
          expect(b.x).toBeLessThan(a.x);
        }
      }
    }
  });

  it("keeps boxes and lines apart, tucked endings included", () => {
    const { items, branches } = synthetic(12, 5, 10);
    const model = buildMapModel(items, branches);
    const boxes = boxesOf(model).sort((a, b) => a.x0 - b.x0);
    for (let i = 0; i < boxes.length; i += 1)
      for (let j = i + 1; j < boxes.length; j += 1) {
        const [a, b] = [boxes[i], boxes[j]];
        if (b.x0 >= a.x1) break;
        expect(b.y0 >= a.y1 || b.y1 <= a.y0).toBe(true);
      }
    // No stretch or join line runs through a box (they meet at edges).
    const lines = [
      ...model.runs.map((r) => ({ x0: r.x0, x1: r.x1, y: r.y })),
      ...model.links
        .filter((l) => l.kind === "join" || l.kind === "return")
        .map((l) => ({ x0: l.x0, x1: l.x1 - 24, y: l.y1 })),
    ];
    for (const line of lines)
      for (const box of boxes)
        if (line.y > box.y0 && line.y < box.y1)
          expect(line.x1 <= box.x0 + 0.5 || line.x0 >= box.x1 - 0.5).toBe(true);
    // End marks clear every box.
    for (const end of model.ends)
      for (const box of boxes)
        expect(
          end.x + 7 <= box.x0 ||
            end.x - 7 >= box.x1 ||
            end.y + 7 <= box.y0 ||
            end.y - 7 >= box.y1,
        ).toBe(true);
  });

  it("tucks an ending in right under its decision; every pill shows its choice number", () => {
    const { items, branches } = synthetic(30, 6, 26);
    const model = buildMapModel(items, branches);
    for (const node of model.decisions) {
      const [a, b, c] = node.routes.map((key) => model.routes[key]);
      expect(a.y).toBe(node.y);
      // The ending sits on the row after the first route, however tall
      // that route is (its connector spans one row, not the subtree) —
      // or, where all three are one row tall, simply after the detour.
      expect(c.outcome).toBe("ends");
      if (b.y === node.y + g.rowH && c.y === b.y + g.rowH) continue;
      expect(c.y).toBe(node.y + g.rowH);
      // The detour (it draws a line to the join) stays under everything.
      expect(b.y).toBeGreaterThanOrEqual(c.y);
    }
    // In the deep ones the detour comes after the ending, out of manifest
    // order; the pills' numbers (and tooltips) keep it legible.
    const tops = topLevel(model);
    const key = tops[0].routes[2];
    const route = model.routes[key];
    const reader = { visited: [], playedRoutes: [], cursor: 0 };
    const marks = markMap(model, { ...reader, spoilers: true });
    expect(labelsMarkup(model, marks)).toMatch(
      new RegExp(
        `<text class="map-route-c [^"]*" data-pill="${key}"[^>]*>3</text>`,
      ),
    );
    expect(describeTarget(model, marks, { kind: "route", key }).title).toBe(
      `3. ${route.label}`,
    );
    // Spoilers off: the number stays, the label is the placeholder.
    expect(
      describeTarget(model, markMap(model, reader), { kind: "route", key })
        .title,
    ).toBe(`3. Unseen route`);
    // In a shown language (Phase 56): the label through the words, its
    // language on the tooltip; hidden, still the placeholder, unmarked.
    const words = {
      prompt: (_d: number, base: string) => ({ text: base, lang: "en" }),
      label: (_d: number, _r: number, base: string) => ({
        text: `«${base}»`,
        lang: "de",
      }),
    };
    expect(
      describeTarget(
        model,
        markMap(model, { ...reader, spoilers: true, words }),
        {
          kind: "route",
          key,
        },
      ),
    ).toMatchObject({ title: `3. «${route.label}»`, lang: "de" });
    const hidden = describeTarget(model, markMap(model, { ...reader, words }), {
      kind: "route",
      key,
    });
    expect(hidden.title).toBe("3. Unseen route");
    expect(hidden.lang).toBeUndefined();
  });

  it("lays a no-decision story out as one row, and an empty one without failing", () => {
    expect(buildMapModel(["a", "b"].map(image), undefined).bands).toHaveLength(
      1,
    );
    const empty = buildMapModel([], undefined);
    expect(empty.bands).toHaveLength(1);
    expect(empty.runs).toHaveLength(0);
    expect(empty.height).toBeGreaterThan(0);
  });

  it("keeps 'you are here' and hit testing on the wrapped layout", () => {
    const { items, branches } = synthetic(30, 6, 26);
    const model = buildMapModel(items, branches);
    const tops = topLevel(model);
    const deep = tops[tops.length - 1];
    expect(deep.y).toBeGreaterThan(tops[0].y);
    // A reader on the stretch just before the last top-level decision.
    const cursor = deep.afterIndex - 2;
    const marks = markMap(model, {
      visited: [cursor],
      playedRoutes: [],
      cursor,
    });
    const run = runAt(model.runs, cursor);
    expect(marks.here.y).toBe(deep.y);
    expect(run?.x1).toBe(deep.x);
    expect(marks.here.x).toBeGreaterThan(run?.x0 ?? 0);
    expect(marks.here.x).toBeLessThan(deep.x);
    // With nothing remembered the map opens at Full size, centred on it.
    const opened = viewFor(
      model,
      openingRecord(null, "any"),
      marks.here,
      1920,
      960,
    );
    expect(opened).toEqual(fullSizeView(model, 1920, 960, marks.here.y));
    expect(opened.scale).toBe(1);
    // Near the map's bottom: as near the middle as the bottom allows.
    const sy = marks.here.y + opened.y;
    expect(sy).toBeGreaterThanOrEqual(480);
    expect(sy).toBeLessThan(960 - HERE_REACH.down);
    for (const node of model.decisions.slice(0, 50))
      expect(hitTest(model, node.x + 5, node.y)).toEqual({
        kind: "decision",
        decision: node.index,
      });
    for (const [key, route] of model.routes.slice(0, 80).entries())
      expect(hitTest(model, route.x + 5, route.y)).toEqual({
        kind: "route",
        key,
      });
  });

  it("lays the demo out as one row at Full size in a map view 600 px wide or more, and at a Fit that reaches 3x", () => {
    for (const width of [600, 800, 1280, 1920]) {
      const model = buildMapModel(DEMO_ITEMS, DEMO_BRANCHES, width);
      expect(model.bands).toHaveLength(1);
      expect(model.ticks).toEqual([]);
    }
    const strip = layOutStrip(DEMO_ITEMS, DEMO_BRANCHES);
    for (const [vw, vh] of [
      [1920, 1000],
      [2560, 1300],
    ]) {
      const fit = fitCut(strip, vw, vh);
      expect(fit.bands).toHaveLength(1);
      expect(fitView(fit, vw, vh).scale).toBe(MAX_SCALE);
    }
  });
});

describe("markMap: the reader's marks", () => {
  it("on a first load: nothing reached, everything unseen, here at the start", () => {
    const model = demoModel();
    const marks = markMap(model, readerOf(demoMachine()));
    expect(marks.reached).toEqual([false, false]);
    expect(new Set(marks.routes)).toEqual(new Set(["unseen"]));
    expect(marks.runs[0]).toBe("partly"); // lead seen, decide not
    // Exactly on the start dot, not a fraction of the first stretch in.
    expect(marks.here).toEqual({ ...model.start, decision: -1 });
  });

  it("after a reset (a fresh boot on the first screen) here is the start dot exactly", () => {
    const model = demoModel();
    const played = demoMachine();
    played.advance();
    played.advance();
    played.choose(1);
    expect(markMap(model, readerOf(played)).here).not.toEqual({
      ...model.start,
      decision: -1,
    });
    // "Reset progress" deletes the record and reloads: a new machine.
    const marks = markMap(model, readerOf(demoMachine()));
    expect(marks.here).toEqual({ ...model.start, decision: -1 });
    // Nothing seen at all (the cursor before any write) reads the same.
    expect(
      markMap(model, { visited: [], playedRoutes: [], cursor: 0 }).here,
    ).toEqual({ ...model.start, decision: -1 });
    // A one-screen first stretch: still the dot, not that screen's middle.
    const short = buildMapModel(
      [image("a"), image("b"), image("c")],
      [
        {
          id: "d",
          after: "a",
          prompt: "Pick",
          routes: [
            { id: "r1", label: "One", start: "b", end: "b" },
            { id: "r2", label: "Two", start: "c", end: "c" },
          ],
        } as Branch,
      ],
    );
    expect(short.runs[0]).toEqual(
      expect.objectContaining({ start: 0, end: 0 }),
    );
    expect(
      markMap(short, { visited: [0], playedRoutes: [], cursor: 0 }).here,
    ).toEqual({ ...short.start, decision: -1 });
  });

  it("marks reached decisions, played / partly / unseen routes and the last pick", () => {
    const model = demoModel();
    const m = demoMachine();
    m.advance(); // decide
    m.advance(); // the outer choice opens
    expect(markMap(model, readerOf(m)).reached).toEqual([false, true]);
    m.choose(1); // route 2, the ending
    m.advance(); // r2-end
    let marks = markMap(model, readerOf(m));
    expect(marks.routes[routeKey(model, OUTER, 1)]).toBe("played");
    expect(marks.lastPick[routeKey(model, OUTER, 1)]).toBe(true);
    expect(marks.routes[routeKey(model, OUTER, 0)]).toBe("unseen");
    expect(marks.playedCount[OUTER]).toBe(1);
    // Into route 1 from its choice screen: entered, not finished.
    m.showChoice(OUTER);
    m.choose(0);
    marks = markMap(model, readerOf(m));
    expect(marks.routes[routeKey(model, OUTER, 0)]).toBe("partly");
    expect(marks.lastPick[routeKey(model, OUTER, 0)]).toBe(true);
    expect(marks.lastPick[routeKey(model, OUTER, 1)]).toBe(false);
    expect(marks.reached[NESTED]).toBe(false);
    expect(marks.runs[model.runs.findIndex((r) => r.start === 7)]).toBe("seen");
  });

  it("puts 'you are here' on the decision while its choice screen is up", () => {
    const model = demoModel();
    const m = demoMachine();
    m.advance();
    m.advance();
    const marks = markMap(model, readerOf(m));
    const outer = model.decisionAt[OUTER];
    expect(marks.here).toEqual({
      x: (outer?.x ?? 0) - HERE_DECISION_GAP,
      y: outer?.y,
      decision: OUTER,
    });
  });

  it("puts 'you are here' on an ending's end mark at its last screen", () => {
    const model = demoModel();
    const m = demoMachine();
    m.advance();
    m.advance();
    m.choose(1); // route 2, the ending: r2-start
    m.advance(); // r2-end, its last screen
    const route2 = model.routes[routeKey(model, OUTER, 1)];
    const mark = model.ends.find((p) => p.y === route2.y && p.x > route2.endX);
    expect(mark).toBeDefined();
    expect(markMap(model, readerOf(m)).here).toEqual({ ...mark, decision: -1 });
    // One screen earlier it is still on the route's line, before the mark.
    const before = markMap(model, { ...readerOf(m), cursor: 7 }).here;
    expect(before.y).toBe(route2.y);
    expect(before.x).toBeLessThan(route2.endX);
  });

  it("puts 'you are here' on the main line's end mark at the story's last screen", () => {
    const model = demoModel();
    const end = model.storyEnd;
    expect(end).not.toBeNull();
    expect(model.ends).toContainEqual(end);
    const at = (cursor: number) =>
      markMap(model, {
        visited: DEMO_ITEMS.map((_, i) => i),
        playedRoutes: [],
        cursor,
      }).here;
    expect(at(10)).toEqual({ ...end, decision: -1 });
    const tail = runAt(model.runs, 10);
    expect(at(9).x).toBeLessThan(tail?.x1 ?? 0);
    // A story with no decisions ends in its mark too.
    const linear = buildMapModel(["a", "b"].map(image), []);
    expect(
      markMap(linear, { visited: [0, 1], playedRoutes: [], cursor: 1 }).here,
    ).toEqual({ ...linear.storyEnd, decision: -1 });
  });

  it("puts 'you are here' on a nested ending's mark, and keeps a returning route's last screen on its line", () => {
    // lead decide | a-start a-nest | n1 | n2 | a-end | b-1 b-2 | after
    const items = [
      "lead",
      "decide",
      "a-start",
      "a-nest",
      "n1",
      "n2",
      "a-end",
      "b-1",
      "b-2",
      "after",
    ].map(image);
    const branches: Branch[] = [
      {
        id: "inner",
        after: "a-nest",
        prompt: "Inner?",
        routes: [
          { id: "n1", label: "Inner ending", start: "n1", end: "n1" },
          {
            id: "n2",
            label: "Inner carries on",
            start: "n2",
            end: "n2",
          },
        ],
        continuingRoute: "n2",
        continueAt: "a-end",
      },
      {
        id: "outer",
        after: "decide",
        prompt: "Outer?",
        routes: [
          {
            id: "a",
            label: "Returns",
            start: "a-start",
            end: "a-end",
            result: "return",
          },
          { id: "b", label: "Continues", start: "b-1", end: "b-2" },
        ],
        continuingRoute: "b",
        continueAt: "after",
      },
    ];
    const model = buildMapModel(items, branches);
    const here = (cursor: number) =>
      markMap(model, { visited: [0, 1, cursor], playedRoutes: [], cursor })
        .here;
    const inner = model.routes.find((r) => r.label === "Inner ending");
    const innerMark = model.ends.find(
      (p) => p.y === inner?.y && p.x > (inner?.endX ?? 0),
    );
    expect(inner?.outcome).toBe("ends");
    expect(here(4)).toEqual({ ...innerMark, decision: -1 });
    // The returning route's last screen: on its own line, no end mark.
    const ret = model.routes.find((r) => r.label === "Returns");
    const lastRun = runAt(model.runs, 6);
    const at = here(6);
    expect(at.y).toBe(ret?.y);
    expect(lastRun?.x1).toBe(ret?.endX);
    expect(at.x).toBeGreaterThan(lastRun?.x0 ?? 0);
    expect(at.x).toBeLessThan(lastRun?.x1 ?? 0);
    expect(model.ends.some((p) => p.x === at.x && p.y === at.y)).toBe(false);
    // A continuing route's last screen: on its line too.
    const cont = model.routes.find((r) => r.label === "Continues");
    expect(here(8).y).toBe(cont?.y);
    expect(here(8).x).toBeLessThan(cont?.endX ?? 0);
  });

  it("puts 'you are here' on the stretch holding the item on screen", () => {
    const model = demoModel();
    const m = demoMachine();
    m.advance();
    m.advance();
    m.choose(1); // r2-start, item 7
    const marks = markMap(model, readerOf(m));
    const run = model.runs.find((r) => r.start === 7);
    expect(marks.here.y).toBe(run?.y);
    expect(marks.here.x).toBeGreaterThan(run?.x0 ?? 0);
    expect(marks.here.x).toBeLessThan((run?.x1 ?? 0) - 1);
    expect(marks.here.decision).toBe(-1);
  });
});

describe("jumpFor and runJump: clicks move through the machine's own operations", () => {
  it("an unreached decision and its routes are inert", () => {
    const model = demoModel();
    const marks = markMap(model, readerOf(demoMachine()));
    expect(jumpFor(model, marks, { kind: "decision", decision: OUTER })).toBe(
      null,
    );
    expect(
      jumpFor(model, marks, { kind: "route", key: routeKey(model, OUTER, 0) }),
    ).toBe(null);
  });

  it("a reached decision opens its choice screen as the wheel shows it", () => {
    const model = demoModel();
    const m = demoMachine();
    m.advance();
    m.advance();
    m.choose(1);
    m.advance(); // r2-end: the ending
    const marks = markMap(model, readerOf(m));
    const jump = jumpFor(model, marks, { kind: "decision", decision: OUTER });
    expect(jump).toEqual({ kind: "choice", decision: OUTER });
    if (jump === null) throw new Error("inert");
    const before = m.exportContext();
    runJump(jump, opsFor(m, model));
    const state = m.getState();
    expect(state.choice?.decisionId).toBe("outer");
    expect(state.choice?.walkRoute).toBe(1); // the last pick, highlighted
    // Nothing marked: seen set and played routes unchanged.
    expect(m.exportContext().visited).toEqual(before.visited);
    expect(m.exportContext().playedRoutes).toEqual(before.playedRoutes);
  });

  it("a route of a reached decision is entered at its first screen as a pick", () => {
    const model = demoModel();
    const m = demoMachine();
    m.advance();
    m.advance();
    m.choose(1);
    m.advance();
    const marks = markMap(model, readerOf(m));
    const key = routeKey(model, OUTER, 0);
    const jump = jumpFor(model, marks, { kind: "route", key });
    expect(jump).toEqual({ kind: "route", decision: OUTER, route: 0 });
    if (jump === null) throw new Error("inert");
    runJump(jump, opsFor(m, model));
    const state = m.getState();
    expect(state.choice).toBeUndefined();
    expect(state.cursor).toBe(2); // r1-start
    const ctx = m.exportContext();
    expect(ctx.stack).toEqual([{ decision: OUTER, route: 0 }]);
    expect(ctx.visited).toContain(2);
    expect(ctx.playedRoutes).toContainEqual({
      decision: OUTER,
      routes: [0, 1],
    });
    expect(ctx.lastPicks).toContainEqual({ decision: OUTER, route: 0 });
    // Reading on from there is ordinary reading: the nested decision fires.
    m.advance(); // r1-nest
    m.advance();
    expect(m.getState().choice?.decisionId).toBe("nested");
  });

  it("a route of the choice already open is picked in place", () => {
    const model = demoModel();
    const m = demoMachine();
    m.advance();
    m.advance(); // the outer choice, opened by reading
    const calls: string[] = [];
    const ops = opsFor(m, model);
    runJump(
      { kind: "route", decision: OUTER, route: 1 },
      {
        ...ops,
        showChoice: (d) => {
          calls.push(`show ${d}`);
          ops.showChoice(d);
        },
      },
    );
    expect(calls).toEqual([]);
    expect(m.getState().cursor).toBe(7);
    // Its own decision clicked while reading opened it: nothing to do.
    m.wheelBack();
    m.wheelBack(); // back to `decide`: one step past the choice screen
    m.advance(); // re-opened by reading
    runJump(
      { kind: "choice", decision: OUTER },
      {
        ...ops,
        showChoice: (d) => calls.push(`show ${d}`),
      },
    );
    expect(calls).toEqual([]);
  });

  it("a nested decision's route enters with its enclosing frame", () => {
    const model = demoModel();
    const m = demoMachine();
    m.advance();
    m.advance();
    m.choose(0); // route 1
    m.advance(); // r1-nest
    m.advance(); // nested choice
    m.choose(0); // nest-cont
    m.jumpToEnd();
    m.goTo(0); // away, back at the start
    const marks = markMap(model, readerOf(m));
    expect(marks.reached[NESTED]).toBe(true);
    const jump = jumpFor(model, marks, {
      kind: "route",
      key: routeKey(model, NESTED, 1),
    });
    if (jump === null) throw new Error("inert");
    runJump(jump, opsFor(m, model));
    expect(m.getState().cursor).toBe(5); // nest-ret
    expect(m.exportContext().stack).toEqual([
      { decision: OUTER, route: 0 },
      { decision: NESTED, route: 1 },
    ]);
  });

  it("machine.showChoice is inert for a decision not reached", () => {
    const m = demoMachine();
    m.showChoice(OUTER);
    expect(m.getState().choice).toBeUndefined();
    expect(m.getState().cursor).toBe(0);
    m.showChoice(99);
    expect(m.getState().cursor).toBe(0);
  });
});

describe("Fit (docs/plan.md Phase 41, 'Two views')", () => {
  it("shows the whole tree inside the view", () => {
    const { items, branches } = synthetic(4, 4, 20);
    const model = fitCut(layOutStrip(items, branches), 1920, 1080);
    const view = fitView(model, 1920, 1080);
    const seen = visibleWorld(view, 1920, 1080);
    expect(seen.x0).toBeLessThanOrEqual(model.bounds.x0);
    expect(seen.y0).toBeLessThanOrEqual(model.bounds.y0);
    expect(seen.x1).toBeGreaterThanOrEqual(model.bounds.x1);
    expect(seen.y1).toBeGreaterThanOrEqual(model.bounds.y1);
  });

  it("fills the view, less a small margin, at any size, the demo included", () => {
    // What the map draws, measured here from its parts (not `bounds`).
    const g = MAP_GEOMETRY;
    const drawn = (model: MapModel) => {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const d of model.decisions) {
        xs.push(d.x, d.x + g.decW);
        ys.push(d.y - g.decH / 2, d.y + g.decH / 2);
      }
      for (const r of model.routes) {
        xs.push(r.x, r.x + g.routeW);
        ys.push(r.y - g.routeH / 2, r.y + g.routeH / 2);
      }
      // A stretch's line, and its screen count above it (12 px type on a
      // baseline 6 above the line).
      for (const r of model.runs) {
        xs.push(r.x0, r.x1);
        ys.push(r.y - 15);
      }
      for (const p of model.ends) xs.push(p.x + 7);
      // The connectors, the rows' continuation turns included.
      for (const l of model.links) {
        xs.push(l.x0, l.x1);
        ys.push(l.y0, l.y1);
      }
      // The "continues" ticks at band cuts.
      for (const t of model.ticks) {
        const b = tickBox(t);
        xs.push(b.x0, b.x1);
        ys.push(b.y0, b.y1);
      }
      return {
        x0: Math.min(...xs),
        y0: Math.min(...ys),
        x1: Math.max(...xs),
        y1: Math.max(...ys),
      };
    };
    const { items, branches } = synthetic(12, 3, 20);
    // Map views at 16:9 window sizes, under the map's header.
    const sizes = [
      [1280, 630],
      [1920, 960],
      [2560, 1300],
      [3840, 1980],
    ];
    for (const strip of [
      layOutStrip(DEMO_ITEMS, DEMO_BRANCHES),
      layOutStrip(items, branches),
    ])
      for (const [vw, vh] of sizes) {
        const model = fitCut(strip, vw, vh);
        const view = fitView(model, vw, vh);
        const box = drawn(model);
        const sx0 = box.x0 * view.scale + view.x;
        const sx1 = box.x1 * view.scale + view.x;
        const sy0 = box.y0 * view.scale + view.y;
        const sy1 = box.y1 * view.scale + view.y;
        // Inside the view, by at least most of the margin...
        expect(sx0).toBeGreaterThanOrEqual(FIT_MARGIN_PX / 2);
        expect(sy0).toBeGreaterThanOrEqual(FIT_MARGIN_PX / 2);
        expect(sx1).toBeLessThanOrEqual(vw - FIT_MARGIN_PX / 2);
        expect(sy1).toBeLessThanOrEqual(vh - FIT_MARGIN_PX / 2);
        // ...and filling it along the tighter axis, up to the margins,
        // unless the 3x limit stops it first (the compact demo in a big
        // window).
        const m2 = 2 * FIT_MARGIN_PX;
        const fill = Math.max((sx1 - sx0) / (vw - m2), (sy1 - sy0) / (vh - m2));
        if (view.scale < MAX_SCALE)
          expect(fill, `${vw}x${vh}`).toBeGreaterThan(0.97);
        else expect(fill, `${vw}x${vh}`).toBeLessThanOrEqual(1);
      }
    // A one-stretch story is not blown up past 3x.
    const tiny = fitCut(layOutStrip([image("a")], []), 3840, 1980);
    expect(fitView(tiny, 3840, 1980).scale).toBe(MAX_SCALE);
  });

  it("keeps the marker's ring and label inside the view", () => {
    // The marker is drawn in screen space at a fixed size: its ring and its
    // "you are here" label reach HERE_REACH pixels from its point.
    const inside = (
      view: { x: number; y: number; scale: number },
      here: { x: number; y: number },
      vw: number,
      vh: number,
      what: string,
    ) => {
      const sx = here.x * view.scale + view.x;
      const sy = here.y * view.scale + view.y;
      expect(sx - HERE_REACH.side, what).toBeGreaterThanOrEqual(0);
      expect(sx + HERE_REACH.side, what).toBeLessThanOrEqual(vw);
      expect(sy - HERE_REACH.up, what).toBeGreaterThanOrEqual(0);
      expect(sy + HERE_REACH.down, what).toBeLessThanOrEqual(vh);
    };
    const { items, branches } = synthetic(4, 3, 20);
    const sizes = [
      [800, 600],
      [1920, 1080],
      [1280, 630],
      [600, 900],
    ];
    for (const [name, strip] of [
      ["demo", layOutStrip(DEMO_ITEMS, DEMO_BRANCHES)],
      ["synthetic", layOutStrip(items, branches)],
    ] as const) {
      for (const [vw, vh] of sizes) {
        const model = fitCut(strip, vw, vh);
        const last = model.itemCount - 1;
        const all = Array.from({ length: model.itemCount }, (_, i) => i);
        for (const [where, reader] of [
          ["start", { visited: [0], playedRoutes: [], cursor: 0 }],
          ["end", { visited: all, playedRoutes: [], cursor: last }],
        ] as const) {
          const marks = markMap(model, reader);
          const at = `${name} ${where} ${vw}x${vh}`;
          const fit = fitView(model, vw, vh, marks.here);
          inside(fit, marks.here, vw, vh, `fit ${at}`);
          // The tree is still whole, and Fit still fills the view.
          const seen = visibleWorld(fit, vw, vh);
          expect(seen.x0).toBeLessThanOrEqual(model.bounds.x0);
          expect(seen.x1).toBeGreaterThanOrEqual(model.bounds.x1);
          expect(seen.y0).toBeLessThanOrEqual(model.bounds.y0);
          expect(seen.y1).toBeGreaterThanOrEqual(model.bounds.y1);
          const b = model.bounds;
          const fill = Math.max(
            ((b.x1 - b.x0) * fit.scale) / vw,
            ((b.y1 - b.y0) * fit.scale) / vh,
          );
          // (Unless the 3x limit stops it: the compact demo.)
          if (fit.scale < MAX_SCALE)
            expect(fill, `fill ${at}`).toBeGreaterThan(0.75);
        }
      }
    }
  });

  it("chooses the band width and the scale together: no other width shows the whole map larger", () => {
    const big = synthetic(30, 6, 26);
    const cases: [string, MapStrip][] = [
      ["570 decisions", layOutStrip(big.items, big.branches)],
      [
        "570 decisions, 180 bookmarks",
        layOutStrip(big.items, big.branches, spreadOver(big.items, 180)),
      ],
      ["the demo", layOutStrip(DEMO_ITEMS, DEMO_BRANCHES)],
      [
        "the demo, 3 bookmarks",
        layOutStrip(DEMO_ITEMS, DEMO_BRANCHES, [3, 3, 3]),
      ],
      [
        "the demo, 10 bookmarks",
        layOutStrip(DEMO_ITEMS, DEMO_BRANCHES, [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]),
      ],
    ];
    for (const [name, strip] of cases)
      for (const [vw, vh] of [
        [1920, 1000],
        [1280, 650],
        [600, 900],
      ]) {
        const at = `${name} in ${vw}x${vh}`;
        const chosen = fitCut(strip, vw, vh);
        const scale = fitView(chosen, vw, vh).scale;
        expect(scale, at).toBeLessThanOrEqual(MAX_SCALE);
        // Every other band width from 200 px to the whole strip on one
        // band (24 of them, evenly spread in ratio) shows it no larger,
        // within 2%: the chooser scores the laid-out size, Fit fills the
        // drawn box.
        const widest = strip.length + 2 * MAP_GEOMETRY.pad;
        for (let i = 0; i <= 24; i += 1) {
          const width = 200 * (widest / 200) ** (i / 24);
          const other = fitView(cutBands(strip, width), vw, vh).scale;
          expect(scale, `${at} against ${width.toFixed(0)} px`).toBeGreaterThan(
            other * 0.98,
          );
        }
      }
  });

  it("enlarges a small map up to 3x, on one band while that reaches 3x, and cuts it narrower than 1,280 px where that shows it larger", () => {
    // The demo reaches 3x on one band in a big window: no cut (a tie goes
    // to fewer bands).
    const demo = layOutStrip(DEMO_ITEMS, DEMO_BRANCHES);
    const big = fitCut(demo, 1920, 1000);
    expect(big.bands).toHaveLength(1);
    expect(fitView(big, 1920, 1000).scale).toBe(MAX_SCALE);
    // Three cards on one screen in 1280x650: cut narrower than Phase 41's
    // interim chooser allowed (bands of 1,280 px at the least), it shows
    // larger than on one band or at that width.
    const carded = layOutStrip(DEMO_ITEMS, DEMO_BRANCHES, [3, 3, 3]);
    const fit = fitCut(carded, 1280, 650);
    const scale = fitView(fit, 1280, 650).scale;
    expect(fit.bands.length).toBeGreaterThan(1);
    expect(fit.width).toBeLessThan(1280);
    for (const width of [carded.length + 80, 1280])
      expect(scale).toBeGreaterThan(
        1.1 * fitView(cutBands(carded, width), 1280, 650).scale,
      );
  });
});

describe("Full size (docs/plan.md Phase 41, 'Two views')", () => {
  const big = synthetic(30, 6, 26);
  const strip = layOutStrip(
    big.items,
    big.branches,
    spreadOver(big.items, 180),
  );

  it("is scale exactly 1, the bands cut at the view's width so nothing runs off its sides", () => {
    for (const vw of [1280, 1440, 1920]) {
      const model = fullCut(strip, vw);
      const view = fullSizeView(model, vw, 700, 0);
      expect(view.scale).toBe(1);
      expect(model.bands.length).toBeGreaterThan(10);
      // Everything drawn (ticks included) across the view, cards too.
      expect(view.x + model.bounds.x0).toBeGreaterThanOrEqual(0);
      expect(view.x + model.bounds.x1).toBeLessThanOrEqual(vw);
      const cards = model.runs.flatMap((run) =>
        run.bookmarks.map((itemIndex, j) => ({ itemIndex, timestampMs: j })),
      );
      const slots = cardSlots(model, cards);
      expect(slots.every((slot) => slot !== null)).toBe(true);
      for (const slot of slots) {
        expect(view.x + (slot?.x ?? -1)).toBeGreaterThanOrEqual(0);
        expect(view.x + (slot?.x ?? vw) + CARD.w).toBeLessThanOrEqual(vw);
      }
    }
    // The demo and the tree without bookmarks cut to any width from 600 px.
    for (const plain of [
      layOutStrip(DEMO_ITEMS, DEMO_BRANCHES),
      layOutStrip(big.items, big.branches),
    ])
      for (const vw of [600, 800, 1000]) {
        const model = fullCut(plain, vw);
        expect(model.width).toBeLessThanOrEqual(fullSizeWidth(vw));
        expect(fullSizeView(model, vw, 700, 0).scale).toBe(1);
      }
  });

  it("keeps the marker's ring and label inside the view at a band's start and end", () => {
    for (const plain of [
      layOutStrip(DEMO_ITEMS, DEMO_BRANCHES),
      layOutStrip(big.items, big.branches),
    ])
      for (const vw of [800, 1280]) {
        const model = fullCut(plain, vw);
        const last = model.itemCount - 1;
        for (const reader of [
          { visited: [0], playedRoutes: [], cursor: 0 },
          {
            visited: Array.from({ length: last + 1 }, (_, i) => i),
            playedRoutes: [],
            cursor: last,
          },
        ]) {
          const here = markMap(model, reader).here;
          const view = fullSizeView(model, vw, 600, here.y);
          const sx = here.x * view.scale + view.x;
          const sy = here.y * view.scale + view.y;
          expect(sx - HERE_REACH.side).toBeGreaterThanOrEqual(0);
          expect(sx + HERE_REACH.side).toBeLessThanOrEqual(vw);
          expect(sy - HERE_REACH.up).toBeGreaterThanOrEqual(0);
          expect(sy + HERE_REACH.down).toBeLessThanOrEqual(600);
        }
      }
  });

  it("shrinks just enough to bring the widest band inside the view where a stretch has no place to cut within its width", () => {
    // Cards stacked on several rows over one span leave no cut within
    // 800 px: the band runs on to the first place it may be cut.
    const model = fullCut(strip, 800);
    expect(model.width).toBeGreaterThan(fullSizeWidth(800));
    const view = fullSizeView(model, 800, 700, 0);
    expect(view.scale).toBeCloseTo(fullSizeWidth(800) / model.width, 12);
    expect(view.scale).toBeLessThan(1);
    expect(view.x).toBe(FULL_SIZE_INSET);
    expect(view.x + model.bounds.x1 * view.scale).toBeLessThanOrEqual(800);
    // It scrolls at that scale, top to bottom.
    const bottom = scrollView(model, 700, view, Number.NEGATIVE_INFINITY);
    expect(bottom.y).toBeCloseTo(700 - model.height * view.scale, 9);
    // A place there comes back.
    const mid = fullSizeView(model, 800, 700, model.bands[5].line);
    expect(
      fullSizeView(
        model,
        800,
        700,
        placeY(model, placeOf(model, mid, 800, 700)),
      ).y,
    ).toBeCloseTo(mid.y, 9);
  });

  it("scrolls up and down only, never past the map's top or bottom; a map no taller than the view sits still in its middle", () => {
    const model = fullCut(strip, 1440);
    const vh = 800;
    const top = fullSizeView(model, 1440, vh, 0);
    expect(top.y).toBe(0);
    const bottom = scrollView(model, vh, top, Number.NEGATIVE_INFINITY);
    expect(bottom).toEqual({ x: top.x, y: vh - model.height, scale: 1 });
    expect(scrollView(model, vh, top, -1234.5)).toEqual({
      ...top,
      y: -1234.5,
    });
    expect(scrollView(model, vh, bottom, 50).y).toBe(0);
    // The demo is shorter than the view: centred, and it does not move.
    const demo = fullCut(layOutStrip(DEMO_ITEMS, DEMO_BRANCHES), 1280);
    const still = fullSizeView(demo, 1280, 650, 0);
    expect(still.y).toBe(Math.round((650 - demo.height) / 2));
    expect(still.x).toBe(Math.round((1280 - demo.width) / 2));
    expect(scrollView(demo, 650, still, -500)).toEqual(still);
  });

  it("puts a world height in the middle of the view, as near as the map's top and bottom allow", () => {
    const model = fullCut(strip, 1440);
    const cy = Math.round(model.height / 2);
    expect(cy + fullSizeView(model, 1440, 800, cy).y).toBe(400);
    expect(fullSizeView(model, 1440, 800, 10).y).toBe(0);
    expect(fullSizeView(model, 1440, 800, model.height - 10).y).toBe(
      800 - model.height,
    );
  });

  it("keeps what was in the middle of the view there when the bands are cut at another width (a resize)", () => {
    const at1440 = fullCut(strip, 1440);
    // On the model it was taken on, a place comes back exactly, a band
    // shorter than half the view (its middle past its end) too.
    const short = at1440.bands.findIndex((b) => b.x1 - b.x0 < 700);
    expect(short).toBeGreaterThanOrEqual(0);
    for (const band of at1440.bands) {
      const view = fullSizeView(at1440, 1440, 800, band.line + 10);
      const again = placeY(at1440, placeOf(at1440, view, 1440, 800));
      expect(fullSizeView(at1440, 1440, 800, again).y).toBeCloseTo(view.y, 9);
    }
    // Two full bands' main lines in the middle of the view, cut again.
    const full = at1440.bands.filter((b) => b.x1 - b.x0 > 1200);
    expect(full.length).toBeGreaterThan(8);
    const picks = [
      full[Math.floor(full.length / 4)],
      full[Math.floor(full.length * 0.7)],
    ];
    for (const band of picks) {
      const view = fullSizeView(at1440, 1440, 800, band.line + 10);
      const place = placeOf(at1440, view, 1440, 800);
      // The stretch nearest the view's middle, and how far along it.
      const cx = 720 - view.x;
      const cy = 400 - view.y;
      let near = { run: 0, along: 0, d: Number.POSITIVE_INFINITY };
      at1440.runs.forEach((run, i) => {
        for (const p of run.pieces) {
          const x = Math.min(p.x1, Math.max(p.x0, cx));
          const d = Math.hypot(x - cx, p.y - cy);
          if (d < near.d) near = { run: i, along: p.at + x - p.x0, d };
        }
      });
      // (A decision's box and pills may sit right under the middle.)
      expect(near.d).toBeLessThan(3 * MAP_GEOMETRY.rowH);
      for (const vw of [1000, 1920]) {
        const other = fullCut(strip, vw);
        const moved = fullSizeView(other, vw, 800, placeY(other, place));
        // The place's own point is at the middle height of the view...
        const holder = [...other.bands]
          .reverse()
          .find((b) => b.start <= place.at);
        expect(holder).toBeDefined();
        // (At 1000 px a stretch has no cut within the width: Full size is
        // a little under 1x there.)
        const k = moved.scale;
        expect(((holder?.line ?? 0) + place.dy) * k + moved.y).toBeCloseTo(
          400,
          6,
        );
        // ...and the stretch that was in the middle is near it, in view.
        const p = pointAlong(other.runs[near.run], near.along);
        expect(
          Math.abs(p.y * k + moved.y - 400),
          `${band.line} at ${vw}`,
        ).toBeLessThan(200);
        expect(p.x * k + moved.x).toBeGreaterThanOrEqual(0);
        expect(p.x * k + moved.x).toBeLessThanOrEqual(vw);
      }
    }
  });
});

describe("Full size's scroll bar (render/branchmap.ts)", () => {
  it("sizes its thumb by the share of the map in view, never under 28 px, and places it by the scroll", () => {
    expect(scrollThumb(600, 2400, 612, 0)).toEqual({ length: 153, offset: 0 });
    expect(scrollThumb(600, 2400, 612, 612 - 2400)).toEqual({
      length: 153,
      offset: 447,
    });
    expect(scrollThumb(600, 2400, 612, (612 - 2400) / 2).offset).toBe(223.5);
    expect(scrollThumb(600, 90000, 612, 0).length).toBe(28);
    // Nothing to scroll: the thumb fills the track.
    expect(scrollThumb(600, 300, 612, 0)).toEqual({ length: 600, offset: 0 });
  });
});

describe("the remembered view (docs/plan.md Phase 41)", () => {
  const { items, branches } = synthetic(10, 3, 20);
  const bookmarks = [5, 60, 61, 300];
  const strip = layOutStrip(items, branches, bookmarks);
  // Made on first use, inside the tests.
  let made: { layout: string; model: MapModel } | null = null;
  const laid = () => {
    made ??= { layout: stripSignature(strip), model: fullCut(strip, 1280) };
    return made;
  };
  const all = (n: number) => Array.from({ length: n + 1 }, (_, i) => i);
  const hereAt = (on: MapModel, cursor: number) =>
    markMap(on, { visited: all(cursor), playedRoutes: [], cursor }).here;
  // A JSON round trip: how the shell's state record keeps it.
  const stored = (record: SavedMapView) =>
    JSON.parse(JSON.stringify(record)) as SavedMapView;
  const scrolledTo = (cy: number): MapView =>
    fullSizeView(laid().model, 1280, 650, cy);

  it("opens at Full size, centred on 'you are here', with nothing remembered: a first open, or after a reset", () => {
    const { layout, model } = laid();
    for (const saved of [null, undefined]) {
      const record = openingRecord(saved, layout);
      expect(record).toEqual({ view: "full", layout, place: null });
      const here = hereAt(model, 150);
      const view = viewFor(model, record, here, 1280, 650);
      expect(view).toEqual(fullSizeView(model, 1280, 650, here.y));
      expect(view.scale).toBe(1);
    }
  });

  it("C, then a scroll, then C again: centred, the place scrolled to, centred again; a centred open follows the reader", () => {
    const { layout, model } = laid();
    let record = remember(openingRecord(undefined, layout), {
      kind: "centre",
    });
    expect(record).toEqual({ view: "full", layout, place: null });
    // A scroll: the place where the reader left it, which a reopen shows
    // wherever the reader has got to since.
    const scrolled = scrolledTo(model.bands[3].line + 30);
    record = remember(record, {
      kind: "place",
      place: placeOf(model, scrolled, 1280, 650),
    });
    const reopened = openingRecord(stored(record), layout);
    const later = viewFor(model, reopened, hereAt(model, 400), 1280, 650);
    expect(later.y).toBeCloseTo(scrolled.y, 9);
    expect(later.scale).toBe(1);
    // C again: centred, so the next open centres on the reader, wherever
    // they are by then.
    record = remember(reopened, { kind: "centre" });
    expect(record.place).toBe(null);
    for (const cursor of [30, 500]) {
      const here = hereAt(model, cursor);
      expect(
        viewFor(model, openingRecord(stored(record), layout), here, 1280, 650),
      ).toEqual(fullSizeView(model, 1280, 650, here.y));
    }
  });

  it("reopens in the last view: Fit as a Fit for the window now; switching views keeps Full size's place", () => {
    const { layout, model } = laid();
    const scrolled = scrolledTo(model.bands[2].line);
    const place = placeOf(model, scrolled, 1280, 650);
    let record = remember(openingRecord(undefined, layout), {
      kind: "place",
      place,
    });
    record = remember(record, { kind: "view", view: "fit" });
    expect(record).toEqual({ view: "fit", layout, place });
    const opened = openingRecord(stored(record), layout);
    const fit = fitCut(strip, 1920, 1000);
    const here = hereAt(fit, 150);
    expect(viewFor(fit, opened, here, 1920, 1000)).toEqual(
      fitView(fit, 1920, 1000, here),
    );
    // Back to Full size (F): where the reader left it.
    const back = remember(opened, { kind: "view", view: "full" });
    expect(back.view).toBe("full");
    expect(viewFor(model, back, here, 1280, 650).y).toBeCloseTo(scrolled.y, 9);
  });

  it("centres a Full size open on 'you are here' once the layout has changed (a bookmark added or deleted), not for another band width", () => {
    const { layout, model } = laid();
    const place = placeOf(model, scrolledTo(model.bands[4].line), 1280, 650);
    const record = remember(openingRecord(undefined, layout), {
      kind: "place",
      place,
    });
    // Laid out again for the same bookmarks, the same layout: any band
    // width keeps the place.
    const again = layOutStrip(items, branches, [...bookmarks].reverse());
    expect(stripSignature(again)).toBe(layout);
    expect(openingRecord(stored(record), layout).place).toEqual(place);
    // A bookmark more, or one fewer: another layout, centred.
    for (const marked of [
      [...bookmarks, 420],
      [5, 60, 300],
    ]) {
      const other = layOutStrip(items, branches, marked);
      const otherLayout = stripSignature(other);
      expect(otherLayout).not.toBe(layout);
      const opened = openingRecord(stored(record), otherLayout);
      expect(opened).toEqual({
        view: "full",
        layout: otherLayout,
        place: null,
      });
      const cut = fullCut(other, 1280);
      const here = hereAt(cut, 250);
      expect(viewFor(cut, opened, here, 1280, 650)).toEqual(
        fullSizeView(cut, 1280, 650, here.y),
      );
    }
    // A Fit stays a Fit.
    expect(openingRecord({ ...record, view: "fit" }, "other").view).toBe("fit");
    // Another game version is another layout too.
    const changed = synthetic(11, 3, 20);
    expect(
      stripSignature(layOutStrip(changed.items, changed.branches, bookmarks)),
    ).not.toBe(layout);
  });
});

describe("culling and hit testing", () => {
  it("draws only the nodes near the view when asked to cull", () => {
    const { items, branches } = synthetic(30, 6, 26);
    const model = buildMapModel(items, branches);
    const marks = markMap(model, { visited: [], playedRoutes: [], cursor: 0 });
    const all = detailMarkup(model, marks).match(/<g /g)?.length ?? 0;
    expect(all).toBe(model.decisions.length + model.routes.length);
    // At 100% the compact tree's nodes are small: a view at 2x shows a
    // small part of this large tree.
    const near = visibleWorld(
      { scale: 2, x: 960 - 800 * 2, y: 540 - 400 * 2 },
      1920,
      1080,
    );
    const culled = detailMarkup(model, marks, near).match(/<g /g)?.length ?? 0;
    expect(culled).toBeGreaterThan(0);
    expect(culled).toBeLessThan(all / 20);
  });

  it("keeps node groups further out for a small tree than for a large one", () => {
    const small = demoModel();
    const large = buildMapModel(
      synthetic(30, 6, 26).items,
      synthetic(30, 6, 26).branches,
    );
    expect(nodeGroupMinScale(small)).toBe(SMALL_NODE_GROUP_MIN_SCALE);
    expect(nodeGroupMinScale(large)).toBe(NODE_GROUP_MIN_SCALE);
    expect(SMALL_NODE_GROUP_MIN_SCALE).toBeLessThan(NODE_GROUP_MIN_SCALE);
  });

  it("merges a large tree's nodes into a few paths, one per look, with no per-node element", () => {
    const { items, branches } = synthetic(30, 6, 26);
    const model = buildMapModel(items, branches);
    const marks = markMap(model, { visited: [], playedRoutes: [], cursor: 0 });
    const markup = boxesMarkup(model, marks);
    expect(markup).not.toMatch(/<g |<rect |<text /);
    expect(markup.match(/<path /g)?.length ?? 0).toBeLessThanOrEqual(8);
    // Every node is in it, as one capsule (one closed subpath) each.
    expect(markup.match(/Z/g)?.length).toBe(
      model.decisions.length + model.routes.length,
    );
  });

  it("finds the node under a world point, or none", () => {
    const model = demoModel();
    const outer = model.decisionAt[OUTER];
    const key = routeKey(model, OUTER, 1);
    const route = model.routes[key];
    if (outer === undefined) throw new Error("unset");
    expect(hitTest(model, outer.x + 5, outer.y)).toEqual({
      kind: "decision",
      decision: OUTER,
    });
    expect(
      hitTest(model, route.x + MAP_GEOMETRY.routeW / 2, route.y + 5),
    ).toEqual({
      kind: "route",
      key,
    });
    expect(hitTest(model, 0, 0)).toBe(null);
  });
});

describe("labels and markup", () => {
  it("draws reached nodes as buttons, unreached ones inert, text escaped, full text in the label", () => {
    const items = DEMO_ITEMS;
    const branches = DEMO_BRANCHES.map((b) =>
      b.id === "outer"
        ? { ...b, prompt: `Pick <one> & "go" — ${"very ".repeat(10)}long` }
        : b,
    );
    const model = buildMapModel(items, branches);
    const m = createMachine({
      items,
      branches,
      settings: { ...DEFAULT_SETTINGS, playAllRoutes: false },
    });
    m.advance();
    m.advance();
    const marks = markMap(model, readerOf(m));
    const markup = detailMarkup(model, marks);
    expect(markup).toContain('class="map-node map-dec map-reached" data-d="1"');
    expect(markup).toContain('class="map-node map-dec map-inert" data-d="0"');
    expect(markup).toContain("Pick &lt;one&gt; &amp; &quot;go&quot;");
    expect(markup).not.toContain("<one>");
    expect(markup).toContain('data-state="unseen"');
    const { title } = describeTarget(model, marks, {
      kind: "decision",
      decision: OUTER,
    });
    expect(title).toContain("very very");
    expect(title.endsWith("long")).toBe(true);
  });

  it("draws a question and route labels as plain shown text, their tags read (Phase 57)", () => {
    const branches = DEMO_BRANCHES.map((b) =>
      b.id === "outer"
        ? {
            ...b,
            prompt: "Pick {i}one{/i}{w}",
            routes: b.routes.map((r) => ({ ...r, label: `{b}${r.label}{/b}` })),
          }
        : b,
    );
    const model = buildMapModel(DEMO_ITEMS, branches);
    const marks = markMap(model, {
      ...readerOf(demoMachine()),
      spoilers: true,
    });
    expect(
      describeTarget(model, marks, { kind: "decision", decision: OUTER }).title,
    ).toBe("Pick one");
    const outerKey = model.routes.findIndex((r) => r.decision === OUTER);
    const routeTitle = describeTarget(model, marks, {
      kind: "route",
      key: outerKey,
    }).title;
    expect(routeTitle).toContain(DEMO_BRANCHES[OUTER].routes[0].label);
    expect(routeTitle).not.toMatch(/[{}]/);
    const markup = [
      detailMarkup(model, marks),
      labelsMarkup(model, marks),
    ].join("");
    expect(markup).toContain("Pick one");
    expect(markup).not.toMatch(/[{}]/);
  });
});

describe("node status text (Phase 40: no click hints)", () => {
  it("says what a node is, not what a click does; the aria label carries the same text", () => {
    const model = demoModel();
    const m = demoMachine();
    m.advance(); // decide
    m.advance(); // the outer choice opens
    const marks = markMap(model, readerOf(m));
    const status = (target: Parameters<typeof describeTarget>[2]) =>
      describeTarget(model, marks, target).status;
    expect(status({ kind: "decision", decision: OUTER })).toBe(
      "0 of 2 routes played",
    );
    expect(status({ kind: "decision", decision: NESTED })).toBe(
      "not reached yet",
    );
    expect(status({ kind: "route", key: routeKey(model, OUTER, 1) })).toBe(
      "not seen · an ending",
    );
    expect(status({ kind: "route", key: routeKey(model, NESTED, 1) })).toBe(
      "not seen · returns to the choice · decision not reached yet",
    );
    const markup = detailMarkup(model, marks);
    expect(markup).toContain(
      'aria-label="Demo decision: which route?: 0 of 2 routes played"',
    );
    expect(markup).not.toContain("click");
  });
});

describe("Spoilers: text of decisions not reached stays hidden", () => {
  // Every real string the demo's map could show: questions and labels.
  const REAL = DEMO_BRANCHES.flatMap((b) => [
    b.prompt ?? "",
    ...b.routes.map((r) => r.label),
  ]);
  const OUTER_LABELS = DEMO_BRANCHES[1].routes.map((r) => r.label);
  const NESTED_TEXT = [
    DEMO_BRANCHES[0].prompt ?? "",
    ...DEMO_BRANCHES[0].routes.map((r) => r.label),
  ];
  // All the text the map can put on the page for a reader state: both
  // markup layers, every tooltip / aria label.
  function pageText(model: MapModel, reader: MapReader): string {
    const marks = markMap(model, reader);
    const tips = [
      ...model.decisions.map((d) =>
        describeTarget(model, marks, { kind: "decision", decision: d.index }),
      ),
      ...model.routes.map((_, key) =>
        describeTarget(model, marks, { kind: "route", key }),
      ),
    ].map(({ title, status }) => `${title}\n${status}`);
    return [
      detailMarkup(model, marks),
      labelsMarkup(model, marks),
      boxesMarkup(model, marks),
      figuresMarkup(model, marks),
      ...tips,
    ].join("\n");
  }
  // A string, or any 12-character piece of it (truncation keeps a prefix).
  const leaks = (text: string, real: string) =>
    text.includes(real) || text.includes(real.slice(0, 12));

  it("is off by default: a first load hides every question and label", () => {
    const model = demoModel();
    const reader = readerOf(demoMachine());
    expect(reader.spoilers).toBeUndefined();
    const marks = markMap(model, reader);
    expect(marks.hidden).toEqual([true, true]);
    const text = pageText(model, reader);
    for (const real of REAL) expect(leaks(text, real)).toBe(false);
    expect(text).toContain("Decision not reached");
    expect(text).toContain("Unseen route");
    // Counts, marks and status lines are unchanged.
    expect(text).toContain("not reached yet");
    expect(text).toContain('class="map-count"');
  });

  it("shows a reached decision's question and all its routes, unplayed ones too; nested ones stay hidden", () => {
    const model = demoModel();
    const m = demoMachine();
    m.advance(); // decide
    m.advance(); // the outer choice opens
    const reader = readerOf(m);
    const marks = markMap(model, reader);
    expect(marks.hidden).toEqual([true, false]);
    expect(marks.routes.every((r) => r === "unseen")).toBe(true);
    const text = pageText(model, reader);
    expect(text).toContain(DEMO_BRANCHES[1].prompt);
    for (const label of OUTER_LABELS) expect(text).toContain(label);
    for (const real of NESTED_TEXT) expect(leaks(text, real)).toBe(false);
    // A hidden route keeps its choice number (its pill shows it).
    const nestedRoute = routeKey(model, NESTED, 1);
    expect(
      describeTarget(model, marks, { kind: "route", key: nestedRoute }).title,
    ).toBe(`2. Unseen route`);
    expect(
      describeTarget(model, marks, { kind: "decision", decision: NESTED })
        .title,
    ).toBe("Decision not reached");
  });

  it("on: everything shows, as before", () => {
    const model = demoModel();
    const reader = { ...readerOf(demoMachine()), spoilers: true };
    expect(markMap(model, reader).hidden).toEqual([false, false]);
    const text = pageText(model, reader);
    for (const real of REAL) expect(text).toContain(real);
    expect(text).not.toContain("Decision not reached");
    expect(text).not.toContain("Unseen route");
  });

  it("changes no layout, marks or clicks: only the text", () => {
    const model = demoModel();
    const reader = readerOf(demoMachine());
    const off = markMap(model, reader);
    const on = markMap(model, { ...reader, spoilers: true });
    expect({ ...off, hidden: [] }).toEqual({ ...on, hidden: [] });
    const shape = (markup: string) =>
      markup.replace(/>[^<]*</g, "><").replace(/aria-label="[^"]*"/g, "");
    expect(shape(detailMarkup(model, off))).toBe(
      shape(detailMarkup(model, on)),
    );
    expect(labelsMarkup(model, off)).toBe(labelsMarkup(model, on));
    expect(boxesMarkup(model, off)).toBe(boxesMarkup(model, on));
    expect(figuresMarkup(model, off)).toBe(figuresMarkup(model, on));
  });
});

// ---------------------------------------------------------------------------
// A synthetic game: `top` decisions along the main line, each with three
// routes (continuing, returning, ending); the continuing route nests a
// decision down to `depth`, the returning one down to half of it; every
// stretch is `run` screens.
// ---------------------------------------------------------------------------
describe("bookmark cards on the line (docs/plan.md Phase 35)", () => {
  const g = MAP_GEOMETRY;
  const compact = (run: { x0: number; x1: number }) => run.x1 - run.x0;
  const carded = (k: number) => k * CARD.pitch - CARD.gap + 2 * CARD.inset;
  // A bookmark as the map gets it: its item and when it was taken.
  const bm = (itemIndex: number, timestampMs = itemIndex) => ({
    itemIndex,
    timestampMs,
  });
  const box = (s: CardSlot) => ({
    x0: s.x,
    y0: s.y,
    x1: s.x + CARD.w,
    y1: s.y + CARD.h,
  });
  const overlaps = (
    a: { x0: number; y0: number; x1: number; y1: number },
    b: { x0: number; y0: number; x1: number; y1: number },
  ) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  // A large synthetic game with bookmarks on every kind of line: the main
  // line, routes, nested routes several levels down, two on one screen.
  function crowded() {
    const { items, branches } = synthetic(8, 4, 12);
    const marks: { itemIndex: number; timestampMs: number }[] = [];
    for (let i = 3; i < items.length; i += 7) marks.push(bm(i, i * 10));
    marks.push(bm(3, 5)); // a second bookmark on item 3, taken earlier
    const strip = layOutStrip(
      items,
      branches,
      marks.map((m) => m.itemIndex),
    );
    const model = fullCut(strip, 1920);
    return {
      items,
      branches,
      strip,
      model,
      marks,
      slots: cardSlots(model, marks),
    };
  }

  it("keeps stretches without bookmarks compact and grows one with k bookmarks to k cards side by side", () => {
    const plain = demoModel();
    for (const run of plain.runs) {
      expect(run.bookmarks).toEqual([]);
      expect(compact(run)).toBe(g.runW);
    }
    // Two bookmarks on the lead stretch (items 0..1), one on route 2's
    // (items 7..8).
    const model = buildMapModel(
      DEMO_ITEMS,
      DEMO_BRANCHES,
      undefined,
      [1, 0, 8],
    );
    const byStart = new Map(model.runs.map((r) => [r.start, r]));
    expect(byStart.get(0)?.bookmarks).toEqual([0, 1]);
    expect(compact(byStart.get(0) ?? plain.runs[0])).toBe(carded(2));
    expect(byStart.get(7)?.bookmarks).toEqual([8]);
    expect(compact(byStart.get(7) ?? plain.runs[0])).toBe(carded(1));
    for (const run of model.runs)
      if (run.start !== 0 && run.start !== 7) {
        expect(run.bookmarks).toEqual([]);
        expect(compact(run)).toBe(g.runW);
      }
    // A card is the old t screen's thumbnail at 100%: 280 px wide, 16:9.
    expect(CARD.w).toBe(280);
    expect(CARD.thumbH).toBe(Math.round((280 * 9) / 16));
  });

  it("ignores item indices outside the manifest", () => {
    const model = buildMapModel(
      DEMO_ITEMS,
      DEMO_BRANCHES,
      undefined,
      [-1, 99, 2.5],
    );
    expect(model).toEqual(demoModel());
    expect(cardSlots(model, [bm(-1), bm(99), bm(2.5)])).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("puts every card centred on its own stretch's line at its screen's exact place: where the marker stands on that screen", () => {
    const { model, marks, slots } = crowded();
    marks.forEach((mark, i) => {
      const slot = slots[i];
      if (slot === null) throw new Error(`no card for item ${mark.itemIndex}`);
      const run = runAt(model.runs, mark.itemIndex);
      if (run === undefined) throw new Error("no stretch");
      expect(mark.itemIndex).toBeGreaterThanOrEqual(run.start);
      expect(mark.itemIndex).toBeLessThanOrEqual(run.end);
      // On one of its stretch's pieces (a band cut may split the stretch).
      const piece = run.pieces.find(
        (p) => p.y === slot.cy && slot.x >= p.x0 && slot.x + CARD.w <= p.x1,
      );
      expect(piece).toBeDefined();
      expect(slot.y + CARD.h / 2).toBe(slot.cy);
      expect(slot.x + CARD.w / 2).toBe(slot.cx);
    });
    // One bookmark per screen: the point along the line for that screen,
    // where "you are here" sits while it is up, is its card's centre.
    const single = buildMapModel(DEMO_ITEMS, DEMO_BRANCHES, undefined, [4, 8]);
    const [nested, ending] = cardSlots(single, [bm(4), bm(8)]);
    const here = (cursor: number) =>
      markMap(single, { visited: [], playedRoutes: [], cursor }).here;
    expect(here(4)).toMatchObject({ x: nested?.cx, y: nested?.cy });
    const route2 = runAt(single.runs, 8);
    if (route2 === undefined) throw new Error("no stretch");
    expect(itemPoint(route2, 8).x).toBe(ending?.cx);
  });

  it("orders the cards along each line in story order, two on one screen oldest first", () => {
    const { model, marks, slots } = crowded();
    // How far along its stretch a point is (its pieces in story order).
    const alongOn = (run: MapRun, x: number, y: number) => {
      const piece = run.pieces.find((p) => p.y === y && x >= p.x0 && x <= p.x1);
      return piece === undefined ? Number.NaN : piece.at + x - piece.x0;
    };
    const byRun = new Map<number, { item: number; t: number; at: number }[]>();
    marks.forEach((mark, i) => {
      const run = runAt(model.runs, mark.itemIndex);
      const slot = slots[i];
      if (run === undefined || slot === null) throw new Error("unplaced");
      const list = byRun.get(run.start) ?? [];
      const at = alongOn(run, slot.cx, slot.cy);
      list.push({ item: mark.itemIndex, t: mark.timestampMs, at });
      byRun.set(run.start, list);
    });
    let pairs = 0;
    for (const list of byRun.values()) {
      list.sort((a, b) => a.at - b.at);
      for (let i = 1; i < list.length; i += 1) {
        pairs += 1;
        const [a, b] = [list[i - 1], list[i]];
        expect(a.item < b.item || (a.item === b.item && a.t < b.t)).toBe(true);
      }
    }
    expect(pairs).toBeGreaterThan(0);
    // The two on item 3: the earlier one (t 5) left of the later (t 30).
    const on3 = marks
      .map((m, i) => ({ m, s: slots[i] }))
      .filter(({ m }) => m.itemIndex === 3);
    expect(on3).toHaveLength(2);
    const early = on3.find(({ m }) => m.timestampMs === 5)?.s;
    const late = on3.find(({ m }) => m.timestampMs === 30)?.s;
    expect(early?.cy).toBe(late?.cy);
    expect(early?.cx).toBeLessThan(late?.cx ?? -1);
    // A point on the line moves forward through the screens, across a
    // band cut too.
    for (const run of model.runs) {
      let last = -Infinity;
      for (let i = run.start; i <= run.end; i += 1) {
        const point = itemPoint(run, i);
        const at = alongOn(run, point.x, point.y);
        expect(at).toBeGreaterThanOrEqual(last);
        last = at;
      }
    }
  });

  it("never overlaps at 100%: no card on another, on a box, or across another line", () => {
    const { model, slots } = crowded();
    const placed = slots.filter((s): s is CardSlot => s !== null);
    expect(placed.length).toBeGreaterThan(20);
    // Cards ride on routes several levels down, not only the main line.
    expect(new Set(placed.map((s) => s.cy)).size).toBeGreaterThan(3);
    for (let i = 0; i < placed.length; i += 1)
      for (let j = i + 1; j < placed.length; j += 1)
        expect(overlaps(box(placed[i]), box(placed[j]))).toBe(false);
    for (const s of placed) {
      const card = box(s);
      for (const d of model.decisions)
        expect(
          overlaps(card, {
            x0: d.x,
            y0: d.y - g.decH / 2,
            x1: d.x + g.decW,
            y1: d.y + g.decH / 2,
          }),
        ).toBe(false);
      for (const r of model.routes)
        expect(
          overlaps(card, {
            x0: r.x,
            y0: r.y - g.routeH / 2,
            x1: r.x + g.routeW,
            y1: r.y + g.routeH / 2,
          }),
        ).toBe(false);
      // Another row's line never runs through a card.
      for (const run of model.runs)
        if (run.y !== s.cy)
          expect(
            run.x0 < card.x1 &&
              card.x0 < run.x1 &&
              run.y > card.y0 &&
              run.y < card.y1,
          ).toBe(false);
      // Inside what Fit frames.
      expect(card.x0).toBeGreaterThanOrEqual(model.bounds.x0);
      expect(card.x1).toBeLessThanOrEqual(model.bounds.x1);
      expect(card.y0).toBeGreaterThanOrEqual(model.bounds.y0);
      expect(card.y1).toBeLessThanOrEqual(model.bounds.y1);
    }
  });

  it("gives a route nested in a route its own cards on its own line, moved down by their room, and leaves a line beside it where it was", () => {
    // Item 5 is the nested decision's second route (nest-ret), on the row
    // under the main line, beside route 2 (an ending, tucked in there).
    const plain = demoModel();
    const model = buildMapModel(DEMO_ITEMS, DEMO_BRANCHES, undefined, [5]);
    const [slot] = cardSlots(model, [bm(5)]);
    const nestB = model.routes[routeKey(model, NESTED, 1)];
    const route2 = model.routes[routeKey(model, OUTER, 1)];
    const main = model.decisionAt[OUTER];
    if (main === undefined || slot == null) throw new Error("unset");
    expect(runAt(model.runs, 5)?.y).toBe(nestB.y);
    expect(slot.cy).toBe(nestB.y);
    // Without cards the row is a row's height under the main line; with
    // one, the card's room above it too, and everything on it moves along.
    const plainB = plain.routes[routeKey(plain, NESTED, 1)];
    const plainMain = plain.decisionAt[OUTER];
    expect(plainB.y - (plainMain?.y ?? 0)).toBe(g.rowH);
    expect(nestB.y - main.y).toBe(g.rowH + CARD_ABOVE);
    // Route 2 is left of the card, under nothing but the main line: it
    // stays a row's height under it (docs/plan.md Phase 42).
    expect(route2.y - main.y).toBe(g.rowH);
    const plain2 = plain.routes[routeKey(plain, OUTER, 1)];
    expect(plain2.y - (plainMain?.y ?? 0)).toBe(g.rowH);
    // The card clears the main line's boxes above it.
    expect(slot.y).toBeGreaterThan(main.y + g.decH / 2);
  });

  it("puts a bookmark on a screen no stretch holds at the end of the stretch before it", () => {
    // A choice whose routes skip item 2 (a menu screen no route covers).
    const items = ["a", "decide", "menu", "r1", "r2", "after"].map(image);
    const branches: Branch[] = [
      {
        id: "pick",
        after: "decide",
        prompt: "Which?",
        routes: [
          { id: "one", label: "One", start: "r1", end: "r1" },
          { id: "two", label: "Two", start: "r2", end: "r2" },
        ],
      },
    ];
    const plain = buildMapModel(items, branches);
    expect(
      plain.runs.some((r) => r.start <= 2 && r.end >= 2),
      "item 2 is on no stretch",
    ).toBe(false);
    const model = buildMapModel(items, branches, undefined, [2]);
    const lead = model.runs.find((r) => r.start === 0);
    if (lead === undefined) throw new Error("no lead stretch");
    expect(lead.bookmarks).toEqual([lead.end]);
    expect(compact(lead)).toBe(carded(1));
    const [slot] = cardSlots(model, [bm(2)]);
    expect(slot?.cy).toBe(lead.y);
    expect(slot?.cx).toBe(itemPoint(lead, lead.end).x);
  });

  it("Fit shows every card scaled down with the tree; Full size is a card at the t screen's size", () => {
    const { strip, model: full } = crowded();
    const fit = fitCut(strip, 1920, 1080);
    const view = fitView(fit, 1920, 1080);
    expect(view.scale).toBeLessThan(1);
    const seen = visibleWorld(view, 1920, 1080);
    const { marks } = crowded();
    for (const s of cardSlots(fit, marks)) {
      if (s === null) continue;
      expect(s.x).toBeGreaterThanOrEqual(seen.x0);
      expect(s.x + CARD.w).toBeLessThanOrEqual(seen.x1);
      expect(s.y).toBeGreaterThanOrEqual(seen.y0);
      expect(s.y + CARD.h).toBeLessThanOrEqual(seen.y1);
    }
    // Full size: exactly 1, a card 280 px wide, every one across the
    // view (this tree's cards, a bookmark every 7 screens on rows of four
    // depths, leave no cut within 2,400 px: a 2,560 px view).
    const wide = fullCut(strip, 2560);
    const at = fullSizeView(wide, 2560, 1300, 0);
    expect(at.scale).toBe(1);
    expect(CARD.w * at.scale).toBe(280);
    for (const s of cardSlots(wide, marks)) {
      if (s === null) continue;
      expect(at.x + s.x).toBeGreaterThanOrEqual(0);
      expect(at.x + s.x + CARD.w).toBeLessThanOrEqual(2560);
    }
    // At 1920 the same cards make it run past the width: Full size
    // shrinks it to fit (`fullSizeScale`).
    expect(fullSizeView(full, 1920, 1080, 0).scale).toBeCloseTo(
      fullSizeWidth(1920) / full.width,
      12,
    );
  });

  it("remembers a place across opens with the same bookmarks; another set of bookmarked screens is another layout (centred)", () => {
    const { items, branches, strip, model, marks } = crowded();
    const layout = stripSignature(strip);
    const view = fullSizeView(model, 1440, 860, model.bands[1].line);
    const record = remember(openingRecord(undefined, layout), {
      kind: "place",
      place: placeOf(model, view, 1440, 860),
    });
    // Reopened with the same bookmarks: the same layout, the same place.
    const again = layOutStrip(
      items,
      branches,
      marks.map((m) => m.itemIndex),
    );
    expect(stripSignature(again)).toBe(layout);
    expect(openingRecord(record, stripSignature(again))).toEqual(record);
    // A bookmark more (or less) moves the stretches: centred again.
    const more = layOutStrip(items, branches, [
      ...marks.map((m) => m.itemIndex),
      5,
    ]);
    expect(stripSignature(more)).not.toBe(layout);
    expect(openingRecord(record, stripSignature(more)).place).toBe(null);
  });
});

// Phase 40 ("Map layout"): the nodes a size up, the cards their thumbnail
// alone. The type size and the card's box live in CSS, so those assertions
// read the shipped index.html, as fit.test.ts does; the card's DOM is the
// bookmarkmap walk's (no browser here).
const indexHtml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "index.html"),
  "utf8",
);
/** The declarations of the rule whose selector list matches `selector`. */
function cssRule(selector: RegExp): string {
  const found = new RegExp(
    `(?:^|[}\\s])${selector.source}\\s*\\{([^}]*)\\}`,
  ).exec(indexHtml);
  if (found === null) throw new Error(`no rule ${selector}`);
  return found[1];
}

describe("map layout (docs/plan.md Phase 40)", () => {
  const g = MAP_GEOMETRY;

  it("draws decisions 52 x 28 and route pills 32 x 24, their 13 px figures centred, on rows 42 apart", () => {
    const model = demoModel();
    const m = demoMachine();
    m.advance(); // decide
    m.advance(); // the outer choice opens
    const marks = markMap(model, readerOf(m));
    const markup = detailMarkup(model, marks);
    expect(markup).toContain(
      '<rect x="0" y="-14" width="52" height="28" rx="5"/><text class="map-dec-c" x="26" y="4.6">0/2</text>',
    );
    // A pill is its rect; its number, centred on it the same way, is in
    // the labels layer (out of the zoom's restyle).
    const pill = routeKey(model, OUTER, 1);
    const route = model.routes[pill];
    expect(markup).toMatch(
      new RegExp(
        `data-r="${pill}"[^>]*><rect x="0" y="-12" width="32" height="24" rx="12"/></g>`,
      ),
    );
    expect(labelsMarkup(model, marks)).toContain(
      `<text class="map-route-c map-route-unseen map-reached" data-pill="${pill}" aria-hidden="true" x="${route.x + 16}" y="${route.y + 4.6}">2</text>`,
    );
    expect(markup).not.toContain("map-route-c");
    expect(cssRule(/\.map-svg \.map-dec-c,\s*\.map-svg \.map-route-c/)).toMatch(
      /font-size: 13px;/,
    );
    // Merged far out (Phase 41), the nodes are the same size.
    const outerNode = model.decisionAt[OUTER];
    if (outerNode === undefined) throw new Error("no outer decision");
    const boxes = boxesMarkup(model, marks);
    expect(boxes).toContain(capsulePath(outerNode.x, outerNode.y - 14, 52, 28));
    expect(boxes).toContain(capsulePath(route.x, route.y - 12, 32, 24));
    // Rows 42 apart, routes 22 right of their decision's box.
    const outer = model.decisionAt[OUTER];
    if (outer === undefined) throw new Error("no outer decision");
    const r1 = model.routes[routeKey(model, OUTER, 0)];
    const r2 = model.routes[routeKey(model, OUTER, 1)];
    expect(r2.y - r1.y).toBe(42);
    expect(r1.x - (outer.x + 52)).toBe(22);
    // A click lands on the whole bigger box, at any zoom.
    expect(hitTest(model, outer.x + 51, outer.y + 13.5)).toEqual({
      kind: "decision",
      decision: OUTER,
    });
    expect(hitTest(model, r2.x + 31, r2.y - 11.5)).toEqual({
      kind: "route",
      key: routeKey(model, OUTER, 1),
    });
    expect(g).toMatchObject({ pad: 40, runW: 44, wrapGap: 40 });
  });

  it("makes a card its 280 x 158 thumbnail alone, centred on its line, its row only as roomy as that card needs", () => {
    expect([CARD.w, CARD.h]).toEqual([280, 158]);
    expect(CARD.h).toBe(CARD.thumbH);
    // On nested route b's line (item 5), a row under the main line.
    const plain = demoModel();
    const model = buildMapModel(DEMO_ITEMS, DEMO_BRANCHES, undefined, [5]);
    const [slot] = cardSlots(model, [{ itemIndex: 5, timestampMs: 1 }]);
    const run = runAt(model.runs, 5);
    if (slot == null || run === undefined) throw new Error("no card");
    expect(slot).toMatchObject({ y: run.y - 79, cy: run.y });
    // Room for the card: half of it and 10 above the line, half of it and
    // 24 below (the count line), so that row sits 42 + 89 under the main
    // line where it sat 42 under without the card.
    expect([CARD_ABOVE, CARD_BELOW]).toEqual([89, 103]);
    const main = model.decisionAt[OUTER];
    const plainMain = plain.decisionAt[OUTER];
    const plainRun = runAt(plain.runs, 5);
    if (main === undefined || plainMain === undefined || !plainRun)
      throw new Error("unset");
    expect(plainRun.y - plainMain.y).toBe(42);
    expect(run.y - main.y).toBe(42 + 89);
    // The count line (11 px type, baseline CARD_COUNT_DY under the line)
    // starts below the card's bottom edge, and the tree's box holds it.
    expect(CARD_COUNT_DY - 11).toBeGreaterThanOrEqual(CARD.h / 2);
    expect(model.bounds.y1).toBeGreaterThanOrEqual(run.y + CARD_COUNT_DY);
    // The card's box is that thumbnail: no caption strip under it.
    expect(cssRule(/\.bm-card/)).toContain(`height: ${CARD.h}px;`);
    expect(cssRule(/\.bm-thumb/)).toContain("height: 100%;");
    expect(indexHtml).not.toMatch(/\.bm-(cap|time|tag)\b/);
  });
});

// Phase 40 ("Map lines"): the tree's strokes are screen pixels at every
// zoom. The stage's CSS scale scales every stroke (`vector-effect` does
// not undo it in Chrome), so each width and dash is written in --line-px,
// a screen pixel in world units set per zoom step (`lineScaleStyle`); far
// out it stops growing, so the strokes thin with the zoom there.
describe("map lines (docs/plan.md Phase 40)", () => {
  /** Every rule of the shipped styles: its selector list and declarations. */
  const rules = Array.from(
    (/<style>([\s\S]*?)<\/style>/.exec(indexHtml)?.[1] ?? "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/([^{}]+)\{([^{}]*)\}/g),
    (m) => ({ selectors: m[1].trim(), body: m[2] }),
  );
  /** A stroke written in --line-px: its width in screen pixels. */
  const linePx = /^calc\(([\d.]+)px \* var\(--line-px, 1\)\)$/;
  const runRule = rules.find((r) => r.selectors === ".map-run");
  const runPx = Number(
    linePx.exec(
      /stroke-width:\s*([^;]+);/.exec(runRule?.body ?? "")?.[1] ?? "",
    )?.[1],
  );
  const linePxAt = (scale: number) =>
    Number(lineScaleStyle(scale)["--line-px"]);
  /** A stroke of `px` screen pixels as painted at `scale`. */
  const painted = (px: number, scale: number) => px * linePxAt(scale) * scale;
  /** Half a step: the most a stroke strays from its width, as a ratio. */
  const halfStep = 2 ** (1 / (2 * LINE_STEPS_PER_OCTAVE));
  /** Zooms from 0.5x to 3x, 1% apart. */
  const sweep = Array.from(
    { length: Math.ceil(Math.log(6) / Math.log(1.01)) + 1 },
    (_, i) => Math.min(MAX_SCALE, LINE_MIN_SCALE * 1.01 ** i),
  );

  it("paints a stroke at its width in screen pixels from LINE_MIN_SCALE in, within half a step: the same at Fit, 100% and 3x", () => {
    expect(runPx).toBe(5);
    // Exactly at 100% (the approved look) and at LINE_MIN_SCALE.
    expect(lineScaleStyle(1)).toEqual({ "--line-px": "1" });
    expect(painted(runPx, LINE_MIN_SCALE)).toBe(runPx);
    for (const scale of [...sweep, 0.6, 2.44]) {
      expect(painted(runPx, scale)).toBeGreaterThanOrEqual(
        runPx / halfStep - 1e-9,
      );
      expect(painted(runPx, scale)).toBeLessThanOrEqual(
        runPx * halfStep + 1e-9,
      );
    }
    // Eighths of an octave: a 5 px stroke paints 4.8-5.2 px.
    expect(LINE_STEPS_PER_OCTAVE).toBe(8);
    expect(runPx / halfStep).toBeGreaterThan(4.78);
    expect(runPx * halfStep).toBeLessThan(5.23);
  });

  it("changes --line-px only when a zoom crosses a step, so most small zooms restyle nothing", () => {
    for (const scale of sweep) {
      const steps = Math.log2(linePxAt(scale)) * LINE_STEPS_PER_OCTAVE;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
    }
    // 0.5x to 3x is log2(6) = 2.6 octaves: 21 steps crossed, 22 values,
    // over 181 zooms of 1%.
    const changes = sweep.filter(
      (scale, i) => i > 0 && linePxAt(scale) !== linePxAt(sweep[i - 1]),
    ).length;
    expect(sweep.length).toBe(182);
    expect(changes).toBe(21);
    expect(new Set(sweep.map(linePxAt)).size).toBe(22);
  });

  it("thins strokes with the zoom past LINE_MIN_SCALE, a stretch never over a quarter of the space between rows", () => {
    expect(lineScaleStyle(0.25)).toEqual({
      "--line-px": String(1 / LINE_MIN_SCALE),
    });
    for (const scale of [0.05, 0.18, 0.3, 0.45, LINE_MIN_SCALE]) {
      expect(painted(runPx, scale)).toBeCloseTo(
        (runPx * scale) / LINE_MIN_SCALE,
        9,
      );
      expect(painted(runPx, scale)).toBeLessThanOrEqual(
        (MAP_GEOMETRY.rowH * scale) / 4,
      );
    }
  });

  it("keeps the counts and pill numbers out of the nodes, so a zoom's restyle leaves them alone", () => {
    const model = demoModel();
    const marks = markMap(model, readerOf(demoMachine()));
    const nodes = detailMarkup(model, marks);
    const labels = labelsMarkup(model, marks);
    expect(nodes).not.toMatch(/map-count|map-route-c/);
    expect(labels.match(/class="map-count"/g)?.length).toBe(model.runs.length);
    expect(labels.match(/class="map-route-c /g)?.length).toBe(
      model.routes.length,
    );
    // A pill's number is hidden from assistive tech (its label says it).
    expect(labels.match(/aria-hidden="true"/g)?.length).toBe(
      model.routes.length,
    );
    // Labels draw no strokes, so they need no --line-px.
    const labelRules = rules.filter((r) => r.selectors.includes("map-labels"));
    expect(labelRules.length).toBeGreaterThan(0);
    expect(labelRules.some((r) => /stroke/.test(r.body))).toBe(false);
  });

  it("writes every stroke width and dash of the tree in --line-px, with no vector-effect", () => {
    // The tree's rules; not the marker's, which its own transform
    // counter-scales.
    const tree = rules.filter(
      (r) =>
        r.selectors.includes(".map-") && !r.selectors.includes(".map-here"),
    );
    const strokes = tree.flatMap((r) =>
      Array.from(
        r.body.matchAll(/(stroke-width|stroke-dasharray):\s*([^;]+);/g),
        (m) => ({ rule: r.selectors, value: m[2].trim() }),
      ),
    );
    // Lines, stations, end marks, node outlines, hover rings.
    expect(strokes.length).toBeGreaterThanOrEqual(16);
    const unscaled = strokes.filter(
      ({ value }) =>
        value !== "none" &&
        !value.split(/\s+(?=calc|0)/).every((v) => v === "0" || linePx.test(v)),
    );
    expect(unscaled).toEqual([]);
    expect(tree.filter((r) => r.body.includes("vector-effect"))).toEqual([]);
  });
});

describe("one look at every zoom (docs/plan.md Phase 41)", () => {
  const rules = Array.from(
    (/<style>([\s\S]*?)<\/style>/.exec(indexHtml)?.[1] ?? "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/([^{}]+)\{([^{}]*)\}/g),
    (m) => ({
      selectors: m[1]
        .trim()
        .split(/\s*,\s*/)
        .map((sel) => sel.trim()),
      body: m[2],
    }),
  );
  const large = () => {
    const { items, branches } = synthetic(30, 6, 26);
    return buildMapModel(items, branches);
  };
  // The demo with every look: the outer decision reached, its route 2
  // played and the last pick, route 1 unseen; the nested decision and its
  // routes not reached.
  const demoMarks = (model: MapModel) => {
    const m = demoMachine();
    m.advance(); // decide
    m.advance(); // the outer choice opens
    m.choose(1);
    while (m.getState().cursor < DEMO_ITEMS.length - 1 && !m.getState().choice)
      m.advance();
    return markMap(model, readerOf(m));
  };
  const count = (markup: string, re: RegExp) => markup.match(re)?.length ?? 0;

  it("just below the old threshold (0.6x; 0.3x for a small tree) draws capsules with their figures, counts and pill numbers", () => {
    for (const [model, scale] of [
      [large(), 0.59],
      [demoModel(), 0.29],
    ] as const) {
      const marks = markMap(model, {
        visited: [],
        playedRoutes: [],
        cursor: 0,
      });
      const drawing = mapDrawing(model, scale, 1);
      expect(drawing).toBe("merged");
      const { tree, labels } = treeMarkup(model, marks, null, drawing);
      // Capsules (arcs), never the old plain rectangles.
      expect(tree).not.toMatch(/h52v28|h32v24/);
      expect(count(tree, /A14 14 /g)).toBe(2 * model.decisions.length);
      expect(count(tree, /A12 12 /g)).toBe(2 * model.routes.length);
      // Every figure and count, as at 100%.
      expect(count(labels, /class="map-dec-c /g)).toBe(model.decisions.length);
      expect(count(labels, /class="map-route-c /g)).toBe(model.routes.length);
      expect(count(labels, /class="map-count"/g)).toBe(model.runs.length);
      // Just above, the same pieces as groups.
      const near = treeMarkup(
        model,
        marks,
        null,
        mapDrawing(model, scale + 0.02, 1),
      );
      expect(count(near.tree, /<g class="map-node /g)).toBe(
        model.decisions.length + model.routes.length,
      );
    }
  });

  it("traces each merged node as its group's rect outline: the same capsule (radius half the height) and start, with the same look classes", () => {
    const model = demoModel();
    const marks = demoMarks(model);
    const groups = detailMarkup(model, marks);
    const boxes = boxesMarkup(model, marks);
    // The rects' radii: a decision's from index.html (its attribute is
    // overridden), a pill's its own attribute; both half the height.
    const decRx = rules
      .find((r) => r.selectors.includes(".map-dec rect"))
      ?.body.match(/rx:\s*([\d.]+)px/)?.[1];
    expect(Number(decRx)).toBe(MAP_GEOMETRY.decH / 2);
    expect(groups).toContain(`rx="${MAP_GEOMETRY.routeH / 2}"`);
    // A rect's outline starts at (x + rx, top) and runs clockwise, so a
    // dash pattern falls the same on either.
    expect(capsulePath(10, 20, 32, 24)).toBe(
      "M22 20H30A12 12 0 0 1 30 44H22A12 12 0 0 1 22 20Z",
    );
    const looks = new Set<string>();
    const pathOf = (cls: string) =>
      new RegExp(`<path class="map-box ${cls}" d="([^"]*)"`).exec(boxes)?.[1];
    for (const node of model.decisions) {
      const cls = /class="map-node (map-dec [^"]*)" data-d="(\d+)"/g;
      const look = Array.from(groups.matchAll(cls)).find(
        (m) => Number(m[2]) === node.index,
      )?.[1];
      if (look === undefined) throw new Error("no group");
      looks.add(look);
      expect(pathOf(look)).toContain(
        capsulePath(node.x, node.y - MAP_GEOMETRY.decH / 2, 52, 28),
      );
    }
    model.routes.forEach((route, key) => {
      const look = new RegExp(
        `class="map-node (map-route [^"]*)" data-r="${key}"`,
      ).exec(groups)?.[1];
      if (look === undefined) throw new Error("no group");
      looks.add(look);
      expect(pathOf(look)).toContain(
        capsulePath(route.x, route.y - MAP_GEOMETRY.routeH / 2, 32, 24),
      );
    });
    // Every look the demo has: reached and not, played, unseen, last pick.
    expect([...looks].sort()).toEqual([
      "map-dec map-inert",
      "map-dec map-reached",
      "map-route map-route-played map-reached map-last",
      "map-route map-route-unseen map-inert",
      "map-route map-route-unseen map-reached",
    ]);
  });

  it("puts each merged decision figure where its group puts it, with its text and look", () => {
    const model = demoModel();
    const marks = demoMarks(model);
    const groups = detailMarkup(model, marks);
    const figures = figuresMarkup(model, marks);
    for (const node of model.decisions) {
      const group = new RegExp(
        `data-d="${node.index}" transform="translate\\(([-\\d.]+) ([-\\d.]+)\\)"[^>]*>.*?<text class="map-dec-c" x="([-\\d.]+)" y="([-\\d.]+)">([^<]*)</text>`,
      ).exec(groups);
      if (group === null) throw new Error("no group figure");
      const [, tx, ty, x, y, text] = group;
      const look = marks.reached[node.index] ? "map-reached" : "map-inert";
      expect(figures).toContain(
        `<text class="map-dec-c ${look}" x="${Number(tx) + Number(x)}" y="${Number(ty) + Number(y)}">${text}</text>`,
      );
    }
    // The inert figure's colour is the inert group's.
    const inert = rules.find((r) =>
      r.selectors.includes(".map-svg .map-node.map-inert text"),
    );
    expect(inert?.selectors).toContain(".map-svg .map-dec-c.map-inert");
  });

  it("styles every look by one rule for a group's rect and a merged capsule alike, with no far-only rule", () => {
    const tree = rules.filter((r) =>
      r.selectors.some((s) => s.includes(".map-")),
    );
    expect(
      tree.filter((r) =>
        r.selectors.some((s) => /map-far|map-skeleton/.test(s)),
      ),
    ).toEqual([]);
    const boxRules = tree.filter((r) =>
      r.selectors.some((s) => s.includes(".map-box")),
    );
    expect(boxRules.length).toBeGreaterThanOrEqual(6);
    for (const rule of boxRules)
      for (const sel of rule.selectors.filter((s) => s.includes(".map-box"))) {
        // `.map-box.map-route-played` pairs with a rect rule of the same
        // classes: `.map-route.map-route-played rect`, `.map-node... rect`.
        const classes = sel.replace(".map-box", "").split(".").filter(Boolean);
        const twin = rule.selectors.find(
          (other) =>
            other.endsWith(" rect") &&
            classes.every((c) => other.includes(`.${c}`)),
        );
        expect(twin, `${sel} has a rect twin in its rule`).toBeDefined();
      }
  });

  it("leaves the counts and figures out only where their digits paint under a device pixel tall", () => {
    const edge = 1 / FIGURE_INK_PX;
    expect(figuresVisible(edge, 1)).toBe(true);
    expect(figuresVisible(edge * 0.99, 1)).toBe(false);
    expect(figuresVisible(edge / 2, 2)).toBe(true);
    expect(figuresVisible((edge * 0.99) / 2, 2)).toBe(false);
    // The 570-decision tree at Fit in a 1920x1080 window: its digits are
    // about 1.8 px tall, drawn. With perf:map's 180 bookmarks spreading
    // its rows it fits at about 0.1x: under a pixel at 1x, drawn at 2x.
    const model = large();
    const { items, branches } = synthetic(30, 6, 26);
    const fit = fitCut(layOutStrip(items, branches), 1920, 956);
    expect(mapDrawing(fit, fitView(fit, 1920, 956).scale, 1)).toBe("merged");
    expect(mapDrawing(model, 0.1, 1)).toBe("bare");
    expect(mapDrawing(model, 0.1, 2)).toBe("merged");
    const marks = markMap(model, { visited: [], playedRoutes: [], cursor: 0 });
    const bare = treeMarkup(model, marks, null, "bare");
    expect(bare.labels).toBe("");
    expect(bare.tree).toBe(treeMarkup(model, marks, null, "merged").tree);
  });
});

// Phase 41 ("Band layout"): the tree laid out as one strip and cut into
// bands like the systems of a score, every line cut at the same x, each
// band under the one before. A cut crosses only straight lines; each line
// it crosses ends in a "continues" tick and resumes from one.
describe("band layout (docs/plan.md Phase 41)", () => {
  const g = MAP_GEOMETRY;
  type Box = { what: string; x0: number; y0: number; x1: number; y1: number };
  const layOut = (
    items: readonly Item[],
    branches: readonly Branch[] | undefined,
    width: number,
    bookmarks: readonly number[] = [],
  ) => cutBands(layOutStrip(items, branches, bookmarks), width);
  // Bookmarks spread over the whole story (perf:map's way): on routes at
  // every depth, often several on one stretch.
  const spread = (items: readonly Item[], n: number) =>
    Array.from({ length: n - 1 }, (_, i) =>
      Math.floor(((i + 1) * (items.length - 1)) / n),
    );
  const big = synthetic(30, 6, 26);
  const models = (): [string, MapModel][] => {
    const marked = spread(big.items, 180);
    return [
      ["570 decisions at 1440", layOut(big.items, big.branches, 1440)],
      [
        "570 decisions, 180 bookmarks at 1440",
        layOut(big.items, big.branches, 1440, marked),
      ],
      [
        "570 decisions, 180 bookmarks at 1920",
        layOut(big.items, big.branches, 1920, marked),
      ],
      [
        "570 decisions, 180 bookmarks at Fit in 1920x1080",
        fitCut(layOutStrip(big.items, big.branches, marked), 1920, 1080),
      ],
    ];
  };
  // Everything a cut may not cross, each a world box: nodes, pills,
  // cards, counts (their text at a wide 0.62 em a character), curves
  // (branches, and a join or return line's turn), joins, end marks and the
  // start dot.
  function solids(model: MapModel): Box[] {
    const out: Box[] = [];
    const reader = { visited: [], playedRoutes: [], cursor: 0 };
    const marks = markMap(model, reader);
    for (const d of model.decisions)
      out.push({
        what: `decision ${d.index}`,
        x0: d.x,
        y0: d.y - g.decH / 2,
        x1: d.x + g.decW,
        y1: d.y + g.decH / 2,
      });
    model.routes.forEach((r, key) => {
      out.push({
        what: `pill ${key}`,
        x0: r.x,
        y0: r.y - g.routeH / 2,
        x1: r.x + g.routeW,
        y1: r.y + g.routeH / 2,
      });
    });
    const cards = model.runs.flatMap((run) =>
      run.bookmarks.map((itemIndex, j) => ({ itemIndex, timestampMs: j })),
    );
    for (const slot of cardSlots(model, cards))
      if (slot !== null)
        out.push({
          what: `card at ${slot.cx}`,
          x0: slot.x,
          y0: slot.y,
          x1: slot.x + CARD.w,
          y1: slot.y + CARD.h,
        });
    const counts = labelsMarkup(model, marks).matchAll(
      /<text class="map-count( map-count-cards)?" x="([-\d.]+)" y="([-\d.]+)">([^<]*)<\/text>/g,
    );
    for (const [, cardsCount, x, y, text] of counts) {
      const size = cardsCount ? 11 : 12;
      const w = text.length * 0.62 * size;
      const x0 = cardsCount ? Number(x) : Number(x) - w / 2;
      out.push({
        what: `count "${text}"`,
        x0,
        // Its digits' ink, under 10 px tall above the baseline.
        y0: Number(y) - (cardsCount ? size : 10),
        x1: x0 + w,
        y1: Number(y),
      });
    }
    for (const l of model.links)
      if (l.kind === "branch")
        out.push({ what: "branch", x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 });
      else if (l.y0 !== l.y1)
        out.push({
          what: `${l.kind} turn`,
          x0: l.x1 - 24,
          y0: l.y0,
          x1: l.x1,
          y1: l.y1,
        });
    for (const p of model.joins)
      out.push({
        what: "join",
        x0: p.x - 5,
        y0: p.y - 5,
        x1: p.x + 5,
        y1: p.y + 5,
      });
    for (const p of model.ends)
      out.push({
        what: "end",
        x0: p.x - 7,
        y0: p.y - 7,
        x1: p.x + 7,
        y1: p.y + 7,
      });
    const s = model.start;
    out.push({
      what: "start",
      x0: s.x - 6,
      y0: s.y - 6,
      x1: s.x + 6,
      y1: s.y + 6,
    });
    return out;
  }
  // The band a world y lies in (bands never overlap down the page).
  const bandOf = (model: MapModel, y: number) =>
    model.bands.findIndex((b) => y >= b.y0 && y <= b.y1);
  // Whether a box crosses a cut: a band's left edge (not the first's,
  // where the story starts) or its right edge (not the last's).
  const crossesCut = (model: MapModel, box: Box) => {
    const b = bandOf(model, (box.y0 + box.y1) / 2);
    const band = model.bands[b];
    return (
      (b > 0 && box.x0 < band.x0) ||
      (b < model.bands.length - 1 && box.x1 > band.x1)
    );
  };

  it("never cuts through a node, pill, card, count or curve: each lies whole inside one band", () => {
    let inside = 0;
    for (const [name, model] of models()) {
      expect(model.bands.length, name).toBeGreaterThan(2);
      // Not only between top-level segments (where the main line is the one
      // line): count the cuts that cross several lines, or a card stretch.
      model.bands.forEach((_, b) => {
        const outs = model.ticks.filter(
          (t) => t.side === "out" && t.band === b,
        );
        const carded = outs.some(
          (t) => t.line === "run" && model.runs[t.run].bookmarks.length > 0,
        );
        if (outs.length > 1 || carded) inside += 1;
      });
      for (const box of solids(model)) {
        const b = bandOf(model, (box.y0 + box.y1) / 2);
        const band = model.bands[b];
        expect(band, `${name}: ${box.what} in no band`).toBeDefined();
        const at = `${name}: ${box.what} at ${box.x0}..${box.x1}, band ${b} ${band.x0}..${band.x1}`;
        expect(crossesCut(model, box), at).toBe(false);
        expect(box.y0, at).toBeGreaterThanOrEqual(band.y0 - 0.5);
        expect(box.y1, at).toBeLessThanOrEqual(band.y1 + 0.5);
      }
    }
    expect(inside).toBeGreaterThan(5);
  });

  it("continues every line a cut crosses: a tick pair in that line's look, from one band's right edge to the next band's left edge", () => {
    for (const [name, model] of models()) {
      // Read up to half way: stretches seen, partly seen and unseen.
      const half = Math.floor(model.itemCount / 2);
      const visited = Array.from({ length: half }, (_, i) => i);
      const marks = markMap(model, { visited, playedRoutes: [], cursor: half });
      const markup = linesMarkup(model, marks);
      const pathOf = (cls: string) =>
        new RegExp(`<path class="${cls}" d="([^"]*)"`).exec(markup)?.[1] ?? "";
      const classes = new Set<string>();
      for (let b = 0; b + 1 < model.bands.length; b += 1) {
        const edge = model.bands[b].x1;
        const next = model.bands[b + 1].x0;
        const byY = (side: "out" | "in", band: number) =>
          model.ticks
            .filter((t) => t.side === side && t.band === band)
            .sort((p, q) => p.y - q.y);
        const outs = byY("out", b);
        const ins = byY("in", b + 1);
        expect(outs.length, `${name} cut ${b}`).toBeGreaterThan(0);
        expect(ins.length, `${name} cut ${b}`).toBe(outs.length);
        outs.forEach((out, i) => {
          const into = ins[i];
          expect(out.x).toBe(edge);
          expect(into.x).toBe(next);
          // The same line, so the same look on both sides of the cut.
          expect([into.line, into.run]).toEqual([out.line, out.run]);
          const cls = tickClass(marks, out);
          expect(tickClass(marks, into)).toBe(cls);
          classes.add(cls);
          // Its stub drawn in the path of its line's look, beside the
          // line's own pieces (a stretch's by its read state), its slash
          // in that look made solid (map-tick).
          for (const tick of [out, into]) {
            const { stub, slash } = tickPaths(tick);
            expect(pathOf(cls)).toContain(stub);
            expect(pathOf(`${cls} map-tick`)).toContain(slash);
          }
          if (out.line === "run") {
            const run = model.runs[out.run];
            expect(cls).toBe(`map-run map-run-${marks.runs[out.run]}`);
            for (const p of run.pieces)
              expect(pathOf(cls)).toContain(`M${p.x0} ${p.y}H${p.x1}`);
          }
        });
        // Every line that reaches the cut has its tick: a stretch's piece or
        // a connector's straight piece ending at the edge, or starting at
        // the next band's left edge.
        const lines = [
          ...model.runs.flatMap((r) =>
            r.pieces.map((p) => ({ x0: p.x0, x1: p.x1, y: p.y })),
          ),
          ...model.links
            .filter((l) => l.kind !== "branch")
            .map((l) => ({ x0: l.x0, x1: l.x1, y: l.y1 })),
        ];
        for (const l of lines) {
          if (l.x1 === edge && bandOf(model, l.y) === b)
            expect(outs.some((t) => t.y === l.y)).toBe(true);
          if (l.x0 === next && bandOf(model, l.y) === b + 1)
            expect(ins.some((t) => t.y === l.y)).toBe(true);
        }
      }
      if (name.includes("bookmarks")) expect(classes.size).toBeGreaterThan(1);
    }
    // A tick is a stub out past the band's edge and a slash across it, on
    // the far side of the edge from everything the band holds.
    const out = {
      x: 100,
      y: 50,
      side: "out",
      line: "run",
      run: 0,
      band: 0,
    } as const;
    expect(tickPaths(out)).toEqual({
      stub: "M100 50h5",
      slash: "M102 56l6 -12",
    });
    expect(tickPaths({ ...out, x: 40, side: "in" })).toEqual({
      stub: "M35 50h5",
      slash: "M32 56l6 -12",
    });
  });

  it("fits a 2,900 px stretch of 10 bookmarks' cards into 1,440 px bands, every piece and card inside its band", () => {
    // Ten bookmarks on the demo's lead-in (items 0 and 1).
    const marked = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1];
    const model = layOut(DEMO_ITEMS, DEMO_BRANCHES, 1440, marked);
    const lead = runAt(model.runs, 0);
    if (lead === undefined) throw new Error("no lead-in");
    expect(lead.bookmarks).toHaveLength(10);
    expect(lead.length).toBeGreaterThan(2900);
    expect(model.width).toBeLessThanOrEqual(1440);
    for (const band of model.bands)
      expect(band.x1 - band.x0).toBeLessThanOrEqual(1440 - 2 * g.pad);
    expect(lead.pieces.length).toBeGreaterThanOrEqual(3);
    let along = 0;
    for (const p of lead.pieces) {
      const band = model.bands[bandOf(model, p.y)];
      expect(p.x0).toBeGreaterThanOrEqual(band.x0);
      expect(p.x1).toBeLessThanOrEqual(band.x1);
      expect(p.at).toBeCloseTo(along, 9);
      along += p.x1 - p.x0;
    }
    expect(along).toBeCloseTo(lead.length, 9);
    const slots = cardSlots(
      model,
      marked.map((itemIndex, i) => ({ itemIndex, timestampMs: i })),
    );
    for (const slot of slots) {
      if (slot === null) throw new Error("no card");
      const band = model.bands[bandOf(model, slot.cy)];
      expect(slot.x).toBeGreaterThanOrEqual(band.x0);
      expect(slot.x + CARD.w).toBeLessThanOrEqual(band.x1);
      expect(slot.y).toBeGreaterThanOrEqual(band.y0);
      expect(slot.y + CARD.h).toBeLessThanOrEqual(band.y1);
    }
    // In story order down the bands, as they read.
    for (let i = 1; i < slots.length; i += 1) {
      const [a, b] = [slots[i - 1], slots[i]];
      if (a === null || b === null) throw new Error("no card");
      expect(b.cy > a.cy || (b.cy === a.cy && b.cx > a.cx)).toBe(true);
    }
  });

  it("puts 'you are here' on the right piece for a screen past a cut", () => {
    const marked = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1];
    const model = layOut(DEMO_ITEMS, DEMO_BRANCHES, 1440, marked);
    const lead = runAt(model.runs, 1);
    if (lead === undefined) throw new Error("no lead-in");
    // Item 1's five cards (the 6th to 10th) are past the first cut: the
    // marker on item 1 is at their middle, on the piece holding them.
    const here = markMap(model, {
      visited: [0, 1],
      playedRoutes: [],
      cursor: 1,
    }).here;
    const piece = lead.pieces.find(
      (p) => p.y === here.y && here.x >= p.x0 && here.x <= p.x1,
    );
    expect(piece).toBeDefined();
    expect(piece).not.toBe(lead.pieces[0]);
    const middle = cardSlots(
      model,
      marked.map((itemIndex, i) => ({ itemIndex, timestampMs: i })),
    )[7];
    expect(here).toEqual({ x: middle?.cx, y: middle?.cy, decision: -1 });
    expect(itemPoint(lead, 1)).toEqual({ x: here.x, y: here.y });
    // Item 0's are before it: on the first piece.
    expect(itemPoint(lead, 0).y).toBe(lead.pieces[0].y);
  });

  it("stacks the bands wrapGap apart between what they draw, each as tall as what it draws", () => {
    // How far things are drawn round their points at 100%, from the
    // shipped styles: the "you are here" ring (it can sit on any stretch,
    // end mark, the start dot, or a decision's row); a card's hover ring
    // and the newest's outline; a decision's hover stroke.
    const px = (re: RegExp, body: string) => Number(re.exec(body)?.[1]);
    const ringRule = cssRule(/\.map-here-ring/);
    const ring =
      px(/r:\s*([\d.]+)px/, ringRule) +
      px(/stroke-width:\s*([\d.]+)/, ringRule) / 2;
    const cardRing = px(
      /box-shadow:\s*0 0 0 calc\(([\d.]+)px/,
      cssRule(/\.bm-card:hover,\s*\.bm-card\.bm-newest/),
    );
    const hover = px(
      /stroke-width:\s*calc\(([\d.]+)px/,
      cssRule(
        /\.map-node\.map-reached:hover rect,\s*\.map-node\.map-reached:focus-visible rect/,
      ),
    );
    expect([ring, cardRing, hover]).toEqual([17, 3, 3.5]);
    for (const [name, model] of models()) {
      const marks = markMap(model, {
        visited: [],
        playedRoutes: [],
        cursor: 0,
      });
      const top = model.bands.map(() => Infinity);
      const bottom = model.bands.map(() => -Infinity);
      const draw = (y0: number, y1: number) => {
        const b = bandOf(model, (y0 + y1) / 2);
        top[b] = Math.min(top[b], y0);
        bottom[b] = Math.max(bottom[b], y1);
      };
      for (const r of model.runs)
        for (const p of r.pieces) draw(p.y - ring, p.y + ring);
      const cards = model.runs.flatMap((r) =>
        r.bookmarks.map((itemIndex, j) => ({ itemIndex, timestampMs: j })),
      );
      for (const slot of cardSlots(model, cards))
        if (slot !== null) draw(slot.y - cardRing, slot.y + CARD.h + cardRing);
      // Counts: a compact one's digits above its line (baseline 6 above,
      // under 10 tall), a carded one's line under its cards (baseline at
      // CARD_COUNT_DY, as `bounds` holds it, 4 below).
      for (const [, cardsCount, , y] of labelsMarkup(model, marks).matchAll(
        /<text class="map-count( map-count-cards)?" x="([-\d.]+)" y="([-\d.]+)">/g,
      ))
        if (cardsCount) draw(Number(y) - 11, Number(y) + 4);
        else draw(Number(y) - 10, Number(y));
      for (const d of model.decisions) {
        draw(d.y - g.decH / 2 - hover / 2, d.y + g.decH / 2 + hover / 2);
        draw(d.y - ring, d.y + ring);
      }
      for (const r of model.routes)
        draw(r.y - g.routeH / 2 - hover / 2, r.y + g.routeH / 2 + hover / 2);
      for (const p of model.joins) draw(p.y - 6.5, p.y + 6.5);
      for (const p of [...model.ends, model.start])
        draw(p.y - ring, p.y + ring);
      for (const l of model.links) draw(l.y0 - 2, l.y1 + 2);
      for (const t of model.ticks) {
        const box = tickBox(t);
        draw(box.y0 - 2.5, box.y1 + 2.5);
      }
      model.bands.forEach((band, b) => {
        const at = `${name} band ${b}`;
        expect(band.y0, at).toBeCloseTo(top[b], 9);
        expect(band.y1, at).toBeCloseTo(bottom[b], 9);
        if (b > 0)
          expect(band.y0 - model.bands[b - 1].y1, at).toBeCloseTo(g.wrapGap, 9);
      });
      expect(model.bands[0].y0).toBeCloseTo(g.pad, 9);
      const last = model.bands[model.bands.length - 1];
      expect(model.height).toBeCloseTo(last.y1 + g.pad, 9);
    }
    // The ten cards of the demo's lead-in at 1,440 px: a card's ring to the
    // next band's card's ring is wrapGap, its count line in between where
    // the band draws one.
    const ten = layOut(
      DEMO_ITEMS,
      DEMO_BRANCHES,
      1440,
      [0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
    );
    const slots = cardSlots(
      ten,
      [0, 0, 0, 0, 0, 1, 1, 1, 1, 1].map((itemIndex, i) => ({
        itemIndex,
        timestampMs: i,
      })),
    );
    const rows = [...new Set(slots.map((slot) => slot?.y ?? 0))];
    expect(rows).toHaveLength(3);
    // Band 0 has the count line (4 below its baseline, 15 under the
    // cards); band 1 has none.
    expect(rows[1] - (rows[0] + CARD.h)).toBeCloseTo(
      CARD_COUNT_DY + 4 - CARD.h / 2 + g.wrapGap + cardRing,
      9,
    );
    expect(rows[2] - (rows[1] + CARD.h)).toBeCloseTo(
      2 * cardRing + g.wrapGap,
      9,
    );
  });

  it("runs a band past the width only where no cut lies within it, and always ends", () => {
    // Too narrow for anything: still cut only where allowed, and finished.
    // On the demo a cut lies within 120 px everywhere; ten cards on its
    // lead-in leave one only between cards, 290 px apart.
    const plain = layOutStrip(DEMO_ITEMS, DEMO_BRANCHES);
    const carded = layOutStrip(
      DEMO_ITEMS,
      DEMO_BRANCHES,
      [0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
    );
    for (const width of [0, 200, 400])
      for (const strip of [plain, carded]) {
        const model = cutBands(strip, width);
        expect(model.bands.length).toBeGreaterThan(1);
        for (const box of solids(model))
          expect(crossesCut(model, box), box.what).toBe(false);
      }
    // Each card's band is as wide as the card and more: wider than the
    // 120 px a band gets at the least.
    const narrow = cutBands(carded, 0);
    const lead = runAt(narrow.runs, 0);
    expect(lead?.pieces.length).toBeGreaterThanOrEqual(10);
    const slots = cardSlots(
      narrow,
      (lead?.bookmarks ?? []).map((itemIndex, i) => ({
        itemIndex,
        timestampMs: i,
      })),
    );
    expect(new Set(slots.map((slot) => slot?.cy)).size).toBe(10);
    for (const slot of slots) {
      const band = narrow.bands[bandOf(narrow, slot?.cy ?? -1)];
      expect(band.x1 - band.x0).toBeGreaterThan(CARD.w);
    }
    // Wide enough for all of it: one band, nothing cut.
    const whole = cutBands(plain, 4000);
    expect(whole.bands).toHaveLength(1);
    expect(whole.ticks).toEqual([]);
    expect(whole.runs.every((r) => r.pieces.length === 1)).toBe(true);
  });

  it("gives a strip one signature whatever width it is cut at, so a remembered place survives a resize", () => {
    const strip = layOutStrip(big.items, big.branches, spread(big.items, 60));
    const layout = stripSignature(strip);
    expect(
      stripSignature(
        layOutStrip(big.items, big.branches, spread(big.items, 60)),
      ),
    ).toBe(layout);
    expect(
      stripSignature(
        layOutStrip(big.items, big.branches, spread(big.items, 61)),
      ),
    ).not.toBe(layout);
    // A place taken at 1440 is restored at 1920, in the band holding it.
    const at1440 = cutBands(strip, 1440);
    const place = placeOf(
      at1440,
      fullSizeView(at1440, 1440, 800, at1440.bands[7].line),
      1440,
      800,
    );
    const record = remember(openingRecord(undefined, layout), {
      kind: "place",
      place,
    });
    expect(openingRecord(record, layout).place).toEqual(place);
    const at1920 = cutBands(strip, 1920);
    const band = at1920.bands.findIndex(
      (b) => b.start <= place.at && place.at <= b.end,
    );
    expect(band).toBeGreaterThan(0);
    expect(placeY(at1920, place)).toBe(at1920.bands[band].line + place.dy);
  });

  it("cuts even bands at Fit: no stub of a last band", () => {
    const strip = layOutStrip(big.items, big.branches, spread(big.items, 180));
    for (const [vw, vh] of [
      [1920, 1080],
      [1920, 960],
      [1440, 1080],
      [1000, 1000],
    ]) {
      const model = fitCut(strip, vw, vh);
      const widths = model.bands.map((b) => b.x1 - b.x0);
      expect(model.bands.length).toBeGreaterThan(1);
      expect(widths[widths.length - 1]).toBeGreaterThanOrEqual(
        Math.max(...widths) / 2,
      );
    }
  });
});

describe("even route spacing (docs/plan.md Phase 42)", () => {
  const g = MAP_GEOMETRY;
  // A decision with three one-row routes, cards on the main line before it
  // (two on the lead-in) and after it (one past the join).
  const threeRoutes = (() => {
    const items = ["lead", "decide", "r1", "r2", "r3", "after", "tail"].map(
      image,
    );
    const branches: Branch[] = [
      {
        id: "d",
        after: "decide",
        prompt: "Which way?",
        routes: [
          { id: "r1", label: "One", start: "r1", end: "r1" },
          {
            id: "r2",
            label: "Two",
            start: "r2",
            end: "r2",
            result: "return",
          },
          { id: "r3", label: "Three", start: "r3", end: "r3" },
        ],
        continuingRoute: "r1",
        continueAt: "after",
      },
    ];
    return { items, branches, bookmarks: [0, 0, 5] };
  })();
  // A decision whose second route holds a card on its first stretch and
  // runs on past two nested decisions, so a cut can fall on it right of
  // the card; its first route is one stretch and its join line.
  //  lead decide | r1 | c n-at | na | nb | s2 m-at | ma | mb | s3 | after
  //  0    1      | 2  | 3 4    | 5  | 6  | 7  8    | 9  | 10 | 11 | 12
  const longRoute = (() => {
    const items = [
      "lead",
      "decide",
      "r1",
      "c",
      "n-at",
      "na",
      "nb",
      "s2",
      "m-at",
      "ma",
      "mb",
      "s3",
      "after",
    ].map(image);
    const nested = (
      id: string,
      at: string,
      a: string,
      b: string,
      continueAt: string,
    ): Branch => ({
      id,
      after: at,
      prompt: `Nested ${id}?`,
      routes: [
        { id: `${id}a`, label: "On", start: a, end: a },
        { id: `${id}b`, label: "Back", start: b, end: b, result: "return" },
      ],
      continuingRoute: `${id}a`,
      continueAt,
    });
    const branches: Branch[] = [
      nested("n", "n-at", "na", "nb", "s2"),
      nested("m", "m-at", "ma", "mb", "s3"),
      {
        id: "d",
        after: "decide",
        prompt: "Which way?",
        routes: [
          { id: "r1", label: "One", start: "r1", end: "r1" },
          {
            id: "r2",
            label: "Two",
            start: "c",
            end: "s3",
            result: "return",
          },
        ],
        continuingRoute: "r1",
        continueAt: "after",
      },
    ];
    const strip = layOutStrip(items, branches, [3]);
    // The first cut in s2 (items 7-8), right of the card and of n.
    const s2 = strip.runs.find((r) => r.start === 7);
    if (s2 === undefined) throw new Error("no s2");
    let cut = -1;
    for (let i = 0; i < strip.windows.length; i += 2)
      if (strip.windows[i] > s2.x0 && strip.windows[i + 1] < s2.x1) {
        cut = strip.windows[i];
        break;
      }
    if (cut < 0) throw new Error("no window in s2");
    return { items, branches, strip, width: cut + 0.01 + 2 * g.pad };
  })();
  const big = synthetic(30, 6, 26);
  const bigStrip = layOutStrip(
    big.items,
    big.branches,
    spreadOver(big.items, 180),
  );
  const ten = layOutStrip(
    DEMO_ITEMS,
    DEMO_BRANCHES,
    [0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
  );
  const everyItem = layOutStrip(
    DEMO_ITEMS,
    DEMO_BRANCHES,
    DEMO_ITEMS.map((_, i) => i),
  );
  const crowded = (): [string, MapModel][] => [
    ["the demo, 10 bookmarks, Full size in 1440", fullCut(ten, 1440)],
    ["the demo, 10 bookmarks, Full size in 1920", fullCut(ten, 1920)],
    ["the demo, 10 bookmarks, Fit in 1920x1080", fitCut(ten, 1920, 1080)],
    ["the demo, a bookmark on every screen", fullCut(everyItem, 1920)],
    [
      "570 decisions, 180 bookmarks, Full size in 1440",
      fullCut(bigStrip, 1440),
    ],
    [
      "570 decisions, 180 bookmarks, Full size in 1920",
      fullCut(bigStrip, 1920),
    ],
    [
      "570 decisions, 180 bookmarks, Fit in 1920x1080",
      fitCut(bigStrip, 1920, 1080),
    ],
    ["570 decisions, 180 bookmarks, uncut", cutBands(bigStrip, 1e7)],
  ];
  const bandAt = (model: MapModel, y: number) =>
    model.bands.findIndex((b) => y >= b.y0 && y <= b.y1);
  // How far below its band's main line a world y is.
  const fromMain = (model: MapModel, y: number) =>
    y - model.bands[bandAt(model, y)].line;

  it("keeps a decision's routes rowH apart where its routes hold no card, though the main line before and after it does", () => {
    const { items, branches, bookmarks } = threeRoutes;
    const strip = layOutStrip(items, branches, bookmarks);
    for (const model of [
      cutBands(strip, 1e6),
      fullCut(strip, 1920),
      fullCut(strip, 1280),
      fitCut(strip, 1920, 1080),
      fitCut(strip, 1280, 720),
    ]) {
      const d = model.decisionAt[0];
      if (d === undefined) throw new Error("no decision");
      const [a, b, c] = d.routes.map((key) => model.routes[key]);
      expect(a.y).toBe(d.y);
      expect(b.y - a.y).toBe(g.rowH);
      expect(c.y - b.y).toBe(g.rowH);
    }
    // The cards are on the main line, one before the decision's box and
    // one past its join, as the reader sees them.
    const whole = cutBands(strip, 1e6);
    const d = whole.decisionAt[0];
    const slots = cardSlots(
      whole,
      bookmarks.map((itemIndex, i) => ({ itemIndex, timestampMs: i })),
    );
    if (d === undefined || slots.some((s) => s === null))
      throw new Error("unset");
    const [first, , last] = slots as CardSlot[];
    expect(first.cy).toBe(d.y);
    expect(first.x + CARD.w).toBeLessThan(d.x);
    expect(last.cy).toBe(d.y);
    expect(last.x).toBeGreaterThan(Math.max(...whole.joins.map((p) => p.x)));
  });

  it("gives every line a cut crosses the same height under its band's main line on both sides of the cut", () => {
    const cases: [string, MapModel][] = [
      ...crowded(),
      [
        "a card's route cut right of its card",
        cutBands(longRoute.strip, longRoute.width),
      ],
    ];
    let inside = 0;
    for (const [name, model] of cases) {
      // Each out tick is followed by its in tick, one band on.
      model.ticks.forEach((out, i) => {
        if (out.side !== "out") return;
        const into = model.ticks[i + 1];
        const at = `${name}: tick ${i}`;
        expect(into.side, at).toBe("in");
        expect(into.band, at).toBe(out.band + 1);
        expect([into.line, into.run], at).toEqual([out.line, out.run]);
        expect(into.y - model.bands[into.band].line, at).toBeCloseTo(
          out.y - model.bands[out.band].line,
          9,
        );
        if (out.y !== model.bands[out.band].line) inside += 1;
      });
      // And every stretch's pieces.
      for (const run of model.runs)
        for (const p of run.pieces)
          expect(fromMain(model, p.y), name).toBeCloseTo(
            fromMain(model, run.pieces[0].y),
            9,
          );
    }
    // Cuts fall inside decisions, crossing lines under the main line.
    expect(inside).toBeGreaterThan(20);
  });

  it("overlaps no card, count, node or pill with another, nor runs a line through one, on the demo with bookmarks and on 570 decisions with 180", () => {
    type Box = { what: string; x0: number; y0: number; x1: number; y1: number };
    const ring = 3; // a card's hover ring and the newest's outline
    for (const [name, model] of crowded()) {
      const boxes: Box[] = [];
      for (const d of model.decisions)
        boxes.push({
          what: `decision ${d.index}`,
          x0: d.x,
          y0: d.y - g.decH / 2,
          x1: d.x + g.decW,
          y1: d.y + g.decH / 2,
        });
      model.routes.forEach((r, key) => {
        boxes.push({
          what: `pill ${key}`,
          x0: r.x,
          y0: r.y - g.routeH / 2,
          x1: r.x + g.routeW,
          y1: r.y + g.routeH / 2,
        });
      });
      const cards = model.runs.flatMap((run) =>
        run.bookmarks.map((itemIndex, j) => ({ itemIndex, timestampMs: j })),
      );
      for (const s of cardSlots(model, cards))
        if (s !== null)
          boxes.push({
            what: `card at ${s.cx},${s.cy}`,
            x0: s.x - ring,
            y0: s.y - ring,
            x1: s.x + CARD.w + ring,
            y1: s.y + CARD.h + ring,
          });
      const marks = markMap(model, {
        visited: [],
        playedRoutes: [],
        cursor: 0,
      });
      for (const [, carded, x, y, text] of labelsMarkup(model, marks).matchAll(
        /<text class="map-count( map-count-cards)?" x="([-\d.]+)" y="([-\d.]+)">([^<]*)<\/text>/g,
      )) {
        const size = carded ? 11 : 12;
        const w = text.length * 0.62 * size;
        const x0 = carded ? Number(x) : Number(x) - w / 2;
        boxes.push({
          what: `count "${text}" at ${x},${y}`,
          x0,
          y0: Number(y) - (carded ? size : 10),
          x1: x0 + w,
          y1: Number(y),
        });
      }
      expect(boxes.some((b) => b.what.startsWith("card"))).toBe(true);
      // Pairs within a band (bands never overlap down the page).
      const byBand = new Map<number, Box[]>();
      for (const b of boxes) {
        const band = bandAt(model, (b.y0 + b.y1) / 2);
        byBand.set(band, [...(byBand.get(band) ?? []), b]);
      }
      const lines = [
        ...model.runs.flatMap((r) => r.pieces),
        ...model.links
          .filter((l) => l.kind !== "branch")
          .map((l) => ({
            x0: l.x0,
            x1: l.x1 - (l.y0 === l.y1 ? 0 : 24),
            y: l.y1,
          })),
      ];
      for (const [band, list] of byBand) {
        list.sort((a, b) => a.x0 - b.x0);
        for (let i = 0; i < list.length; i += 1)
          for (
            let j = i + 1;
            j < list.length && list[j].x0 < list[i].x1;
            j += 1
          ) {
            const [a, b] = [list[i], list[j]];
            expect(
              a.y0 < b.y1 && b.y0 < a.y1,
              `${name}, band ${band}: ${a.what} on ${b.what}`,
            ).toBe(false);
          }
        // A line runs through only what sits on it.
        for (const l of lines)
          for (const b of list)
            if (l.x0 < b.x1 && b.x0 < l.x1 && l.y > b.y0 && l.y < b.y1)
              expect(
                b.what.startsWith("count") ? false : l.y === (b.y0 + b.y1) / 2,
                `${name}: line at ${l.y} through ${b.what}`,
              ).toBe(true);
      }
    }
  });

  it("clears the line above a route holding a card by the card's room, in every band its line crosses", () => {
    // A cut right of the card: the route's line, in the band without its
    // card, keeps the card's room under the line above it.
    const model = cutBands(longRoute.strip, longRoute.width);
    expect(model.bands).toHaveLength(2);
    const d = model.decisionAt[2];
    if (d === undefined) throw new Error("no decision");
    const two = model.routes[d.routes[1]];
    const room = g.rowH + CARD_ABOVE;
    expect(bandAt(model, two.y)).toBe(0);
    expect(two.y - d.y).toBe(room);
    const [slot] = cardSlots(model, [{ itemIndex: 3, timestampMs: 0 }]);
    expect(slot?.cy).toBe(two.y);
    const s2 = runAt(model.runs, 7);
    const m = model.decisionAt[1];
    if (s2 === undefined || m === undefined) throw new Error("unset");
    expect(s2.pieces).toHaveLength(2);
    const later = s2.pieces[1];
    expect(bandAt(model, later.y)).toBe(1);
    expect(later.y - model.bands[1].line).toBe(room);
    expect(m.y - model.bands[1].line).toBe(room);
    // The line above it there is route 1's join line, on the main line.
    expect(
      model.links.some(
        (l) =>
          l.kind === "join" &&
          l.y0 === model.bands[1].line &&
          l.x0 === model.bands[1].x0,
      ),
    ).toBe(true);
    // And on 570 decisions with 180 bookmarks, uncut: every line over or
    // under a card keeps the card's room from its line.
    const whole = cutBands(bigStrip, 1e7);
    const cards = whole.runs.flatMap((run) =>
      run.bookmarks.map((itemIndex, j) => ({ itemIndex, timestampMs: j })),
    );
    const lines = [
      ...whole.runs.flatMap((r) => r.pieces),
      ...whole.links
        .filter((l) => l.kind !== "branch")
        .map((l) => ({
          x0: l.x0,
          x1: l.x1 - (l.y0 === l.y1 ? 0 : 24),
          y: l.y1,
        })),
    ];
    let checked = 0;
    for (const s of cardSlots(whole, cards)) {
      if (s === null) throw new Error("no card");
      for (const l of lines) {
        if (l.y === s.cy || l.x1 <= s.x || l.x0 >= s.x + CARD.w) continue;
        checked += 1;
        if (l.y < s.cy) expect(s.cy - l.y).toBeGreaterThanOrEqual(room);
        else expect(l.y - s.cy).toBeGreaterThanOrEqual(g.rowH + CARD_BELOW);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("brings a remembered place on a route's line back on that line at another width, and signs a strip by its lines' heights", () => {
    // A place taken at Full size in 1440 with a pill under the main line in
    // the middle of the view comes back on that pill at 1920.
    const at1440 = fullCut(bigStrip, 1440);
    const at1920 = fullCut(bigStrip, 1920);
    let checked = 0;
    for (const key of [40, 400, 900, 1500]) {
      const pill = at1440.routes[key];
      const band = at1440.bands[bandAt(at1440, pill.y)];
      if (pill.y === band.line) continue;
      // Scrolled so the pill is in the middle of a 2,000 px tall view.
      const view = { x: 0, y: 1000 - pill.y, scale: 1 };
      const place = placeOf(at1440, view, 1440, 2000, pill.x);
      expect(placeY(at1920, place)).toBeCloseTo(at1920.routes[key].y, 9);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(2);
    // Another height for one line is another layout.
    const lower = {
      ...bigStrip,
      runs: bigStrip.runs.map((r, i) => (i === 7 ? { ...r, y: r.y + 1 } : r)),
    };
    expect(stripSignature(lower)).not.toBe(stripSignature(bigStrip));
  });
});

function synthetic(
  top: number,
  depth: number,
  run: number,
): { items: Item[]; branches: Branch[] } {
  const items: Item[] = [];
  const branches: Branch[] = [];
  let n = 0;
  const add = (count: number): [string, string] => {
    const first = `i${n}`;
    for (let i = 0; i < count; i += 1) items.push(image(`i${n++}`));
    return [first, `i${n - 1}`];
  };
  // Appends one route body; returns its first and last item ids.
  const body = (level: number, nest: boolean): [string, string] => {
    const [first] = add(run);
    if (nest && level < depth) decision(level + 1);
    const [, last] = add(run);
    return [first, last];
  };
  const decision = (level: number): void => {
    const after = `i${n - 1}`;
    const id = `d${branches.length}`;
    const entry: Branch = {
      id,
      after,
      prompt: `Decision ${id} at level ${level}?`,
      routes: [],
    };
    branches.push(entry);
    const a = body(level, true);
    const b = body(level, level < depth / 2);
    const c = body(level, false);
    const routes: Route[] = [
      { id: "a", label: `Carry on from ${id}`, start: a[0], end: a[1] },
      {
        id: "b",
        label: `Detour from ${id}`,
        start: b[0],
        end: b[1],
        result: "return",
      },
      { id: "c", label: `End it at ${id}`, start: c[0], end: c[1] },
    ];
    Object.assign(entry, {
      routes,
      continuingRoute: "a",
      continueAt: `i${n}`,
    });
    add(1); // the continueAt item
  };
  for (let t = 0; t < top; t += 1) {
    add(run);
    decision(1);
  }
  add(run);
  return { items, branches };
}

/**
 * `n - 1` bookmarks spread over the whole story (perf:map's way): on
 * routes at every depth, often several on one stretch.
 */
function spreadOver(items: readonly Item[], n: number): number[] {
  return Array.from({ length: n - 1 }, (_, i) =>
    Math.floor(((i + 1) * (items.length - 1)) / n),
  );
}

describe("shared spans (docs/plan.md Phase 60 item 9h)", () => {
  // lead decide | a0 a1 | b0 [x0 | y0] b2 | c0 | f0 f1 | j0 end
  //  0   1      | 2  3  | 4    5    6   7  | 8  | 9  10 | 11 12
  // fight's routes a and, nested in b, sneak's route x go on to fight's
  // shared span fail, an ending.
  const ITEMS = [
    "lead",
    "decide",
    "a0",
    "a1",
    "b0",
    "x0",
    "y0",
    "b2",
    "c0",
    "f0",
    "f1",
    "j0",
    "end",
  ].map(image);
  const BRANCHES: Branch[] = [
    {
      id: "fight",
      after: "decide",
      prompt: "What now?",
      routes: [
        { id: "a", label: "Attack", start: "a0", end: "a1", then: "fail" },
        {
          id: "b",
          label: "Sneak",
          start: "b0",
          end: "b2",
          result: "continue",
        },
        { id: "c", label: "Talk", start: "c0", end: "c0" },
      ],
      continuingRoute: "c",
      continueAt: "j0",
      shared: [{ id: "fail", start: "f0", end: "f1" }],
    },
    {
      id: "sneak",
      after: "b0",
      prompt: "Where?",
      routes: [
        { id: "x", label: "Run", start: "x0", end: "x0", then: "fail" },
        { id: "y", label: "Wait", start: "y0", end: "y0" },
      ],
      continuingRoute: "y",
      continueAt: "b2",
    },
  ];
  const FIGHT = 0;
  const SNEAK = 1;
  const spanModel = (width?: number) => buildMapModel(ITEMS, BRANCHES, width);
  const spanMachine = () =>
    createMachine({
      items: ITEMS,
      branches: BRANCHES,
      settings: { ...DEFAULT_SETTINGS, playAllRoutes: false },
    });

  it("draws a span once, as a box after its decision's routes, each route with then feeding it, a nested one too", () => {
    const model = spanModel();
    expect(model.spans).toHaveLength(1);
    const [span] = model.spans;
    expect(span).toEqual(
      expect.objectContaining({
        decision: FIGHT,
        span: 0,
        id: "fail",
        startIndex: 9,
        endIndex: 10,
        outcome: "ends",
      }),
    );
    expect(model.decisionAt[FIGHT]?.spans).toEqual([0]);
    const a = model.routes[routeKey(model, FIGHT, 0)];
    const x = model.routes[routeKey(model, SNEAK, 0)];
    expect([a.outcome, x.outcome]).toEqual(["shared", "shared"]);
    expect([a.span, x.span]).toEqual([0, 0]);
    expect(span.leads).toEqual([
      routeKey(model, FIGHT, 0),
      routeKey(model, SNEAK, 0),
    ]);
    // After every route's line and below every route of its decision.
    for (const route of model.routes) {
      expect(span.x).toBeGreaterThan(route.endX);
      expect(span.y).toBeGreaterThan(route.y);
    }
    // Its items are one stretch on its own line, from the box.
    const run = runAt(model.runs, 9);
    expect(run).toEqual(expect.objectContaining({ start: 9, end: 10 }));
    expect(run?.x0).toBe(span.x + MAP_GEOMETRY.routeW);
    expect(run?.y).toBe(span.y);
    expect(span.endX).toBe(run?.x1);
    // A feed line from each leading route's end to the box, and no end
    // mark at those ends: the span's own, and the story's. Its own
    // route's runs along its row, then down a column by the box; the
    // nested one's turns down at once (its row goes on past it) and runs
    // along the span's row into the box.
    const feeds = model.links.filter((l) => l.kind === "feed");
    expect(feeds).toEqual([
      expect.objectContaining({
        x0: a.endX,
        y0: a.y,
        x1: span.x,
        y1: span.y,
      }),
      expect.objectContaining({
        x0: x.endX,
        y0: x.y,
        x1: x.endX + MAP_GEOMETRY.gap,
        y1: span.y,
      }),
      expect.objectContaining({
        x0: x.endX + MAP_GEOMETRY.gap,
        y0: span.y,
        x1: span.x,
        y1: span.y,
      }),
    ]);
    for (const route of [a, x])
      expect(model.ends.some((p) => p.x === route.endX + 10)).toBe(false);
    expect(model.ends).toHaveLength(2);
    expect(model.ends).toContainEqual({ x: span.endX + 10, y: span.y });
    // b and c join fight's join, y sneak's.
    expect(model.links.filter((l) => l.kind === "join")).toHaveLength(3);
  });

  it("joins a returning or continuing span at its decision's join; a pure choice's line carries on past its spans", () => {
    // lead ask | u1 | u2 | t0 | after
    const items = ["lead", "ask", "u1", "u2", "t0", "after"].map(image);
    const branches: Branch[] = [
      {
        id: "look",
        after: "ask",
        prompt: "Look at?",
        routes: [
          { id: "sea", label: "Sea", start: "u1", end: "u1", then: "tail" },
          { id: "sky", label: "Sky", start: "u2", end: "u2" },
        ],
        shared: [{ id: "tail", start: "t0", end: "t0", result: "return" }],
      },
    ];
    const model = buildMapModel(items, branches);
    const [span] = model.spans;
    expect(span.outcome).toBe("returns");
    const node = model.decisionAt[0];
    if (node === undefined) throw new Error("unset");
    const back = model.links.filter((l) => l.kind === "return");
    expect(back).toEqual([
      expect.objectContaining({ x0: span.endX, y1: span.y, y0: node.y }),
    ]);
    expect(model.joins).toEqual([{ x: back[0].x1, y: node.y }]);
    // The main line goes on at `after`, past the span, not into it.
    expect(model.runs.map((r) => [r.start, r.end])).toEqual([
      [0, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ]);
    expect(runAt(model.runs, 5)?.y).toBe(node.y);
    expect(runAt(model.runs, 4)?.y).toBe(span.y);
  });

  it("keeps a span's box, its feed lines' turns and its line whole at any band width", () => {
    const strip = layOutStrip(ITEMS, BRANCHES);
    for (let width = 200; width <= 1400; width += 37) {
      const model = cutBands(strip, width);
      const [span] = model.spans;
      const band = model.bands.find(
        (b) => span.y >= b.y0 && span.y <= b.y1 && span.x >= b.x0,
      );
      expect(band).toBeDefined();
      expect(span.x + MAP_GEOMETRY.routeW).toBeLessThanOrEqual(band?.x1 ?? 0);
      // Each feed line's turns lie in one band, ending at the span's line
      // there (a nested route's feed may turn in a band before the box's).
      const turns = model.links.filter(
        (l) => l.kind === "feed" && l.y1 !== l.y0,
      );
      expect(turns).toHaveLength(2);
      for (const turn of turns) {
        const holder = model.bands.find(
          (b) => turn.y0 >= b.y0 && turn.y1 <= b.y1,
        );
        if (holder === undefined || band === undefined)
          throw new Error("a turn across bands");
        expect(turn.y1 - holder.line).toBe(span.y - band.line);
        expect(turn.x0).toBeGreaterThanOrEqual(holder.x0);
        expect(turn.x1).toBeLessThanOrEqual(holder.x1);
      }
    }
  });

  it("marks a span as its items are read and puts 'you are here' on it, then on its end mark", () => {
    const model = spanModel();
    const m = spanMachine();
    const marks = () => markMap(model, readerOf(m));
    const [span] = model.spans;
    expect(marks().spans).toEqual(["unseen"]);
    m.advance();
    m.advance(); // fight's choice
    m.choose(0); // a0
    m.advance(); // a1
    m.advance(); // f0: into the span
    expect(m.getState().cursor).toBe(9);
    expect(marks().spans).toEqual(["partly"]);
    const run = runAt(model.runs, 9);
    if (run === undefined) throw new Error("unset");
    expect(marks().here).toEqual({ ...itemPoint(run, 9), decision: -1 });
    m.advance(); // f1, the span's last screen: its end mark
    expect(marks().spans).toEqual(["played"]);
    expect(marks().here).toEqual({
      x: span.endX + 10,
      y: span.y,
      decision: -1,
    });
    // At a's own last screen the reader is on a's line, not an end mark.
    const a = model.routes[routeKey(model, FIGHT, 0)];
    expect(markMap(model, { ...readerOf(m), cursor: 3 }).here.y).toBe(a.y);
  });

  it("a click on the span box of a reached decision enters it at its first screen, by a route leading in", () => {
    const model = spanModel();
    const m = spanMachine();
    expect(
      jumpFor(model, markMap(model, readerOf(m)), { kind: "span", key: 0 }),
    ).toBe(null);
    m.enterSpan(FIGHT, 0); // inert: not reached
    expect(m.getState().cursor).toBe(0);
    m.advance();
    m.advance();
    m.choose(2); // c0, the continuing route
    const [span] = model.spans;
    expect(
      hitTest(model, span.x + MAP_GEOMETRY.routeW / 2, span.y + 3),
    ).toEqual({ kind: "span", key: 0 });
    const marks = markMap(model, readerOf(m));
    const jump = jumpFor(model, marks, { kind: "span", key: 0 });
    expect(jump).toEqual({ kind: "span", decision: FIGHT, span: 0 });
    if (jump === null) throw new Error("inert");
    runJump(jump, opsFor(m, model));
    expect(m.getState().cursor).toBe(9);
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().stack).toEqual([{ decision: FIGHT, route: 0 }]);
    // Reading on: the span's end is an ending, so fight's choice again.
    m.advance();
    m.advance();
    expect(m.getState().choice?.decisionId).toBe("fight");
  });

  it("says what a span box and a route going on to it are", () => {
    const model = spanModel();
    const m = spanMachine();
    m.advance();
    m.advance();
    const marks = markMap(model, readerOf(m));
    expect(describeTarget(model, marks, { kind: "span", key: 0 })).toEqual({
      title: "Shared scene",
      status: "not seen · an ending",
    });
    expect(
      describeTarget(model, marks, {
        kind: "route",
        key: routeKey(model, FIGHT, 0),
      }).status,
    ).toBe("not seen · goes on to a shared scene");
    const markup = detailMarkup(model, marks);
    expect(markup).toContain(
      'data-s="0" data-state="unseen" transform="translate(',
    );
    expect(markup).toContain('aria-label="Shared scene: not seen · an ending"');
    expect(boxesMarkup(model, marks)).toContain("map-span");
    expect(linesMarkup(model, marks)).toContain('class="map-feed"');
  });
});
