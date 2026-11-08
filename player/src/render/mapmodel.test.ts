import { describe, expect, it } from "vitest";
import { createMachine } from "../machine/machine";
import type { Branch, Item, Route } from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import { describeTarget, detailMarkup, skeletonMarkup } from "./branchmap";
import {
  bandOffsets,
  buildMapModel,
  CARD,
  CARD_ABOVE,
  CARD_BELOW,
  type CardSlot,
  cardSlots,
  centreOn,
  FIT_MARGIN_PX,
  fitView,
  fullSizeView,
  HERE_DECISION_GAP,
  HERE_REACH,
  HIDDEN_PROMPT,
  HIDDEN_ROUTE,
  hitTest,
  itemX,
  jumpFor,
  LABEL_MIN_SCALE,
  labelMinScale,
  layoutSignature,
  MAP_GEOMETRY,
  MAX_SCALE,
  type MapModel,
  type MapReader,
  markMap,
  restoreView,
  runAt,
  runJump,
  type SavedMapView,
  SMALL_LABEL_MIN_SCALE,
  saveView,
  viewAfterResize,
  visibleWorld,
  zoomAt,
  zoomLimits,
} from "./mapmodel";

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
    expect(model.rows).toBe(1);
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

describe("buildMapModel: rows like lines of text, endings tucked in", () => {
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

  it("wraps a large game's main line into rows, in reading order, about the viewport's shape", () => {
    const { items, branches } = synthetic(30, 6, 26);
    for (const aspect of [16 / 9, 2, 4 / 3]) {
      const model = buildMapModel(items, branches, aspect);
      expect(model.rows).toBeGreaterThan(2);
      const shape = model.width / model.height;
      expect(shape / aspect).toBeGreaterThan(0.6);
      expect(shape / aspect).toBeLessThan(1.6);
      // Reading order: each top-level decision is right of the one before
      // on its row, or on a lower row, starting again at the left.
      const tops = topLevel(model);
      expect(tops).toHaveLength(30);
      const rowYs = [...new Set(tops.map((d) => d.y))];
      expect(rowYs).toHaveLength(model.rows);
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

  it("never splits a top-level decision's subtree across rows", () => {
    const { items, branches } = synthetic(30, 6, 26);
    const model = buildMapModel(items, branches, 16 / 9);
    const tops = topLevel(model);
    const rowYs = [...new Set(tops.map((d) => d.y))].sort((a, b) => a - b);
    const nextRowY = (y: number) =>
      rowYs.find((r) => r > y) ?? Number.POSITIVE_INFINITY;
    tops.forEach((top, i) => {
      const from = top.afterIndex;
      const to = tops[i + 1]?.afterIndex ?? model.itemCount;
      const right = tops[i + 1]?.y === top.y ? tops[i + 1].x : Infinity;
      const inside = (x: number, y: number) => {
        expect(y).toBeGreaterThanOrEqual(top.y);
        expect(y).toBeLessThan(nextRowY(top.y));
        expect(x).toBeGreaterThanOrEqual(top.x);
        expect(x).toBeLessThan(right);
      };
      for (const route of model.routes)
        if (route.startIndex > from && route.startIndex < to)
          inside(route.x, route.y);
      for (const node of model.decisions)
        if (node.afterIndex > from && node.afterIndex < to)
          inside(node.x, node.y);
    });
  });

  it("draws a continuation connector from each row's end to the next row's start", () => {
    const { items, branches } = synthetic(30, 6, 26);
    const model = buildMapModel(items, branches, 16 / 9);
    const wraps = model.links.filter((l) => l.kind === "wrap");
    expect(wraps).toHaveLength(model.rows - 1);
    const tops = topLevel(model);
    for (const wrap of wraps) {
      // It leaves a row's main line at its end (the last join there)...
      expect(tops.some((d) => d.y === wrap.y0)).toBe(true);
      expect(
        model.joins.some((j) => j.y === wrap.y0 && j.x === wrap.x1 - 28),
      ).toBe(true);
      // ...and enters the next row where its first stretch starts.
      const first = model.runs.find((r) => r.y === wrap.y1 && r.x0 === g.pad);
      expect(first).toBeDefined();
      expect(wrap.d.startsWith(`M${wrap.x1 - 28} ${wrap.y0}`)).toBe(true);
      expect(wrap.d).toContain(`H${g.pad}`);
      expect(wrap.x0).toBeLessThan(g.pad);
    }
    // The story's start dot is on the first row's first stretch.
    expect(model.runs[0].x0).toBe(model.start.x);
    expect(model.runs[0].y).toBe(model.start.y);
  });

  it("keeps boxes and lines apart, tucked endings included", () => {
    const { items, branches } = synthetic(12, 5, 10);
    const model = buildMapModel(items, branches, 16 / 9);
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
    expect(detailMarkup(model, marks)).toMatch(
      new RegExp(
        `data-r="${key}"[^>]*>.*?<text class="map-route-c"[^>]*>3</text>`,
      ),
    );
    expect(describeTarget(model, marks, { kind: "route", key }).title).toBe(
      `3. ${route.label}`,
    );
    // Spoilers off: the number stays, the label is the placeholder.
    expect(
      describeTarget(model, markMap(model, reader), { kind: "route", key })
        .title,
    ).toBe(`3. ${HIDDEN_ROUTE}`);
  });

  it("lays a no-decision story out as one row, and an empty one without failing", () => {
    expect(buildMapModel(["a", "b"].map(image), undefined).rows).toBe(1);
    const empty = buildMapModel([], undefined);
    expect(empty.rows).toBe(1);
    expect(empty.runs).toHaveLength(0);
    expect(empty.height).toBeGreaterThan(0);
  });

  it("keeps 'you are here' and hit testing on the wrapped layout", () => {
    const { items, branches } = synthetic(30, 6, 26);
    const model = buildMapModel(items, branches, 16 / 9);
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
    // With nothing remembered the map opens at Fit, not centred on it.
    expect(restoreView(model, null, 1920, 960, marks.here)).toEqual({
      view: fitView(model, 1920, 960, marks.here),
      fit: true,
    });
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

  it("lays the demo out as before, one row, whatever the viewport's shape", () => {
    for (const aspect of [1, 4 / 3, 16 / 9, 3]) {
      const model = buildMapModel(DEMO_ITEMS, DEMO_BRANCHES, aspect);
      expect(model.rows).toBe(1);
      expect(model.links.some((l) => l.kind === "wrap")).toBe(false);
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

describe("view arithmetic", () => {
  it("zooms around the pointer: the world point under it stays put", () => {
    const view = { x: 40, y: -20, scale: 0.8 };
    const next = zoomAt(view, 1.5, 300, 200, { min: 0.1, max: 3 });
    const before = {
      x: (300 - view.x) / view.scale,
      y: (200 - view.y) / view.scale,
    };
    const after = {
      x: (300 - next.x) / next.scale,
      y: (200 - next.y) / next.scale,
    };
    expect(next.scale).toBeCloseTo(1.2);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("clamps zoom to the limits", () => {
    const view = { x: 0, y: 0, scale: 1 };
    expect(zoomAt(view, 100, 0, 0, { min: 0.1, max: 3 }).scale).toBe(3);
    expect(zoomAt(view, 0.0001, 0, 0, { min: 0.1, max: 3 }).scale).toBe(0.1);
  });

  it("fit shows the whole tree inside the viewport", () => {
    const { items, branches } = synthetic(4, 4, 20);
    const model = buildMapModel(items, branches);
    const view = fitView(model, 1920, 1080);
    const seen = visibleWorld(view, 1920, 1080);
    expect(seen.x0).toBeLessThanOrEqual(model.bounds.x0);
    expect(seen.y0).toBeLessThanOrEqual(model.bounds.y0);
    expect(seen.x1).toBeGreaterThanOrEqual(model.bounds.x1);
    expect(seen.y1).toBeGreaterThanOrEqual(model.bounds.y1);
    expect(zoomLimits(model, 1920, 1080).min).toBeLessThanOrEqual(view.scale);
  });

  it("fit fills the view, less a small margin, at any size, the demo included", () => {
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
    for (const model of [
      demoModel(),
      buildMapModel(items, branches, 1920 / 960),
    ])
      for (const [vw, vh] of sizes) {
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
        // unless the zoom-in limit stops it first (the compact demo in a
        // 4K window).
        const m2 = 2 * FIT_MARGIN_PX;
        const fill = Math.max((sx1 - sx0) / (vw - m2), (sy1 - sy0) / (vh - m2));
        if (view.scale < MAX_SCALE)
          expect(fill, `${vw}x${vh}`).toBeGreaterThan(0.97);
        else expect(fill, `${vw}x${vh}`).toBeLessThanOrEqual(1);
        // Zooming never undoes a fit.
        expect(zoomLimits(model, vw, vh).max).toBeGreaterThanOrEqual(
          view.scale,
        );
      }
    // A one-stretch story is not blown up past the zoom-in limit.
    const tiny = buildMapModel([image("a")], []);
    expect(fitView(tiny, 3840, 1980).scale).toBe(MAX_SCALE);
  });

  it("fit keeps the marker's ring and label inside the view", () => {
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
    for (const [name, model] of [
      ["demo", demoModel()],
      ["synthetic", buildMapModel(items, branches, 16 / 9)],
    ] as const) {
      const last = model.itemCount - 1;
      const all = Array.from({ length: model.itemCount }, (_, i) => i);
      for (const [where, reader] of [
        ["start", { visited: [0], playedRoutes: [], cursor: 0 }],
        ["end", { visited: all, playedRoutes: [], cursor: last }],
      ] as const) {
        const marks = markMap(model, reader);
        for (const [vw, vh] of sizes) {
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
          // (Unless the zoom-in limit stops it: the compact demo.)
          if (fit.scale < MAX_SCALE)
            expect(fill, `fill ${at}`).toBeGreaterThan(0.75);
          expect(zoomLimits(model, vw, vh, marks.here).min).toBeLessThanOrEqual(
            fit.scale,
          );
        }
      }
    }
  });

  it("keeps the world point at the view's centre when the view is resized", () => {
    const view = { x: -300, y: 40, scale: 0.8 };
    const next = viewAfterResize(
      view,
      { w: 1280, h: 630 },
      { w: 2560, h: 1300 },
    );
    expect(next.scale).toBe(0.8);
    expect((1280 - next.x) / next.scale).toBeCloseTo((640 - view.x) / 0.8);
    expect((650 - next.y) / next.scale).toBeCloseTo((315 - view.y) / 0.8);
  });
});

describe("the remembered view (Phase 33)", () => {
  const { items, branches } = synthetic(10, 3, 20);
  const model = buildMapModel(items, branches);
  const marks = markMap(model, {
    visited: [0, 1, 2],
    playedRoutes: [],
    cursor: 2,
  });
  const layout = layoutSignature(model);
  const world = (
    view: { x: number; y: number; scale: number },
    vw: number,
    vh: number,
  ) => ({
    x: (vw / 2 - view.x) / view.scale,
    y: (vh / 2 - view.y) / view.scale,
  });

  it("opens at Fit the first time (nothing remembered), not centred on here", () => {
    for (const saved of [null, undefined]) {
      const opened = restoreView(model, saved, 800, 600, marks.here);
      expect(opened.fit).toBe(true);
      expect(opened.view).toEqual(fitView(model, 800, 600, marks.here));
      expect(opened.view).not.toEqual(
        centreOn(marks.here.x, marks.here.y, 800, 600, opened.view.scale),
      );
    }
  });

  it("reopens a moved view exactly where it was, same window", () => {
    const view = { x: -812.25, y: 133.5, scale: 1.37 };
    const saved = saveView(layout, view, 1280, 640, false);
    const opened = restoreView(model, saved, 1280, 640, marks.here);
    expect(opened.fit).toBe(false);
    expect(opened.view.scale).toBe(1.37);
    expect(opened.view.x).toBeCloseTo(view.x, 9);
    expect(opened.view.y).toBeCloseTo(view.y, 9);
  });

  it("survives a JSON round trip (the stored record) unchanged", () => {
    const saved = saveView(
      layout,
      { x: 10, y: -3, scale: 0.9 },
      900,
      700,
      false,
    );
    const back = JSON.parse(JSON.stringify(saved)) as SavedMapView;
    expect(restoreView(model, back, 900, 700)).toEqual(
      restoreView(model, saved, 900, 700),
    );
  });

  it("a remembered Fit reopens as a fresh Fit for the window now", () => {
    const fit = fitView(model, 800, 600, marks.here);
    const saved = saveView(layout, fit, 800, 600, true);
    const opened = restoreView(model, saved, 1920, 1080, marks.here);
    expect(opened).toEqual({
      view: fitView(model, 1920, 1080, marks.here),
      fit: true,
    });
  });

  it("after a resize keeps the world centre and scale, the scale clamped to the zoom limits", () => {
    const view = { x: -400, y: 50, scale: 1.2 };
    const saved = saveView(layout, view, 1280, 640, false);
    const opened = restoreView(model, saved, 1920, 1080, marks.here);
    expect(opened.fit).toBe(false);
    expect(opened.view.scale).toBe(1.2);
    const before = world(view, 1280, 640);
    const after = world(opened.view, 1920, 1080);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    // Out of range either way: clamped, centre kept.
    const limits = zoomLimits(model, 600, 400, marks.here);
    const huge = restoreView(
      model,
      { ...saved, scale: 50 },
      600,
      400,
      marks.here,
    );
    expect(huge.view.scale).toBe(limits.max);
    const tiny = restoreView(
      model,
      { ...saved, scale: 1e-4 },
      600,
      400,
      marks.here,
    );
    expect(tiny.view.scale).toBe(limits.min);
    expect(world(tiny.view, 600, 400).x).toBeCloseTo(saved.cx, 9);
    expect(world(huge.view, 600, 400).y).toBeCloseTo(saved.cy, 9);
  });

  it("a view taken on another layout (another game version, rows rewrapped) falls back to Fit", () => {
    const saved = saveView(
      layout,
      { x: -400, y: 50, scale: 1.2 },
      1280,
      640,
      false,
    );
    const other = synthetic(11, 3, 20);
    const changed = buildMapModel(other.items, other.branches);
    expect(layoutSignature(changed)).not.toBe(layout);
    expect(restoreView(changed, saved, 1280, 640)).toEqual({
      view: fitView(changed, 1280, 640),
      fit: true,
    });
    const rewrapped = buildMapModel(items, branches, 0.5);
    expect(rewrapped.rows).not.toBe(model.rows);
    expect(layoutSignature(rewrapped)).not.toBe(layout);
    expect(restoreView(rewrapped, saved, 1280, 640).fit).toBe(true);
    // The same manifest laid out again gives the same signature.
    expect(layoutSignature(buildMapModel(items, branches))).toBe(layout);
  });

  it("a reset (no remembered view: the record is gone) opens at Fit", () => {
    // Reset deletes the state record (storage tests); with it the view.
    expect(restoreView(model, undefined, 1024, 700, marks.here)).toEqual({
      view: fitView(model, 1024, 700, marks.here),
      fit: true,
    });
  });
});

describe("level of detail, culling and hit testing", () => {
  it("draws only the nodes near the view when asked to cull", () => {
    const { items, branches } = synthetic(30, 6, 26);
    const model = buildMapModel(items, branches);
    const marks = markMap(model, { visited: [], playedRoutes: [], cursor: 0 });
    const all = detailMarkup(model, marks).match(/<g /g)?.length ?? 0;
    expect(all).toBe(model.decisions.length + model.routes.length);
    // At 100% the compact tree's nodes are small: a view at 2x shows a
    // small part of this large tree.
    const near = visibleWorld(centreOn(800, 400, 1920, 1080, 2), 1920, 1080);
    const culled = detailMarkup(model, marks, near).match(/<g /g)?.length ?? 0;
    expect(culled).toBeGreaterThan(0);
    expect(culled).toBeLessThan(all / 20);
  });

  it("drops labels further out for a small tree than for a large one", () => {
    const small = demoModel();
    const large = buildMapModel(
      synthetic(30, 6, 26).items,
      synthetic(30, 6, 26).branches,
    );
    expect(labelMinScale(small)).toBe(SMALL_LABEL_MIN_SCALE);
    expect(labelMinScale(large)).toBe(LABEL_MIN_SCALE);
    expect(SMALL_LABEL_MIN_SCALE).toBeLessThan(LABEL_MIN_SCALE);
  });

  it("draws the far view as a few paths, one per look, with no text", () => {
    const { items, branches } = synthetic(30, 6, 26);
    const model = buildMapModel(items, branches);
    const marks = markMap(model, { visited: [], playedRoutes: [], cursor: 0 });
    const markup = skeletonMarkup(model, marks);
    expect(markup).not.toContain("<text");
    expect(markup.match(/<path /g)?.length ?? 0).toBeLessThanOrEqual(8);
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
      skeletonMarkup(model, marks),
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
    expect(text).toContain(HIDDEN_PROMPT);
    expect(text).toContain(HIDDEN_ROUTE);
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
    ).toBe(`2. ${HIDDEN_ROUTE}`);
    expect(
      describeTarget(model, marks, { kind: "decision", decision: NESTED })
        .title,
    ).toBe(HIDDEN_PROMPT);
  });

  it("on: everything shows, as before", () => {
    const model = demoModel();
    const reader = { ...readerOf(demoMachine()), spoilers: true };
    expect(markMap(model, reader).hidden).toEqual([false, false]);
    const text = pageText(model, reader);
    for (const real of REAL) expect(text).toContain(real);
    expect(text).not.toContain(HIDDEN_PROMPT);
    expect(text).not.toContain(HIDDEN_ROUTE);
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
    expect(skeletonMarkup(model, off)).toBe(skeletonMarkup(model, on));
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
    const model = buildMapModel(
      items,
      branches,
      16 / 9,
      marks.map((m) => m.itemIndex),
    );
    return { items, branches, model, marks, slots: cardSlots(model, marks) };
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
    // A card is the old t screen's at 100%: 280 px of thumbnail and caption.
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
    expect(layoutSignature(model)).toBe(layoutSignature(demoModel()));
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
      expect(slot.cy).toBe(run.y);
      expect(slot.y + CARD.h / 2).toBe(run.y);
      expect(slot.x + CARD.w / 2).toBe(slot.cx);
      expect(slot.x).toBeGreaterThanOrEqual(run.x0);
      expect(slot.x + CARD.w).toBeLessThanOrEqual(run.x1);
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
    expect(itemX(route2, 8)).toBe(ending?.cx);
  });

  it("orders the cards along each line in story order, two on one screen oldest first", () => {
    const { model, marks, slots } = crowded();
    const byRun = new Map<number, { item: number; t: number; cx: number }[]>();
    marks.forEach((mark, i) => {
      const run = runAt(model.runs, mark.itemIndex);
      const slot = slots[i];
      if (run === undefined || slot === null) throw new Error("unplaced");
      const list = byRun.get(run.start) ?? [];
      list.push({ item: mark.itemIndex, t: mark.timestampMs, cx: slot.cx });
      byRun.set(run.start, list);
    });
    let pairs = 0;
    for (const list of byRun.values()) {
      list.sort((a, b) => a.cx - b.cx);
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
    expect(early?.cx).toBeLessThan(late?.cx ?? -1);
    // A point on the line moves forward through the screens.
    for (const run of model.runs) {
      let last = -Infinity;
      for (let i = run.start; i <= run.end; i += 1) {
        const x = itemX(run, i);
        expect(x).toBeGreaterThanOrEqual(last);
        last = x;
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

  it("gives a route nested in a route its own cards on its own row, moved down by their room", () => {
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
    expect(route2.y).toBe(nestB.y);
    // The card clears the main line's boxes above it.
    expect(slot.y).toBeGreaterThan(main.y + g.decH / 2);
  });

  it("spreads a segment's rows by the room their cards need, and leaves one without cards as it was", () => {
    expect(bandOffsets({ width: 1, rows: 3 })).toEqual({
      off: [0, 0, 0],
      height: 3 * g.rowH,
    });
    expect(
      bandOffsets({ width: 1, rows: 3, bands: [false, true, false] }),
    ).toEqual({
      off: [0, CARD_ABOVE, CARD_ABOVE + CARD_BELOW],
      height: 3 * g.rowH + CARD_ABOVE + CARD_BELOW,
    });
    // Row 0's room above is the wrapped row's (shared), not the segment's.
    expect(bandOffsets({ width: 1, rows: 1, bands: [true] })).toEqual({
      off: [0],
      height: g.rowH + CARD_BELOW,
    });
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
    expect(slot?.cx).toBe(itemX(lead, lead.end));
  });

  it("Fit shows every card scaled down with the tree; 100% is a card at the t screen's size, about the same centre", () => {
    const { model, slots } = crowded();
    const fit = fitView(model, 1920, 1080);
    expect(fit.scale).toBeLessThan(1);
    const seen = visibleWorld(fit, 1920, 1080);
    for (const s of slots) {
      if (s === null) continue;
      expect(s.x).toBeGreaterThanOrEqual(seen.x0);
      expect(s.x + CARD.w).toBeLessThanOrEqual(seen.x1);
      expect(s.y).toBeGreaterThanOrEqual(seen.y0);
      expect(s.y + CARD.h).toBeLessThanOrEqual(seen.y1);
    }
    const limits = zoomLimits(model, 1920, 1080);
    const full = fullSizeView(fit, 1920, 1080, limits);
    expect(full.scale).toBe(1);
    expect(CARD.w * full.scale).toBe(280);
    const centre = (v: { x: number; y: number; scale: number }) => [
      (960 - v.x) / v.scale,
      (540 - v.y) / v.scale,
    ];
    expect(centre(full)[0]).toBeCloseTo(centre(fit)[0]);
    expect(centre(full)[1]).toBeCloseTo(centre(fit)[1]);
    // From further in, 100% zooms back out to the same size.
    expect(
      fullSizeView({ ...full, scale: 2.5 }, 1920, 1080, limits).scale,
    ).toBe(1);
  });

  it("remembers a view across opens with the same bookmarks; another set of bookmarked screens is another layout (Fit)", () => {
    const { items, branches, model, marks } = crowded();
    const layout = layoutSignature(model);
    const view = centreOn(900, 500, 1440, 860, 1);
    const saved = saveView(layout, view, 1440, 860, false);
    // Reopened with the same bookmarks: the same layout, the same view.
    const again = buildMapModel(
      items,
      branches,
      16 / 9,
      marks.map((m) => m.itemIndex),
    );
    expect(layoutSignature(again)).toBe(layout);
    expect(restoreView(again, saved, 1440, 860)).toEqual({
      view,
      fit: false,
    });
    // A bookmark more (or less) moves the stretches: a fresh Fit.
    const more = buildMapModel(items, branches, 16 / 9, [
      ...marks.map((m) => m.itemIndex),
      5,
    ]);
    expect(layoutSignature(more)).not.toBe(layout);
    expect(restoreView(more, saved, 1440, 860)).toEqual({
      view: fitView(more, 1440, 860),
      fit: true,
    });
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
