import { describe, expect, it } from "vitest";
import { createMachine } from "../machine/machine";
import type { Branch, Item, Route } from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import { describeTarget, detailMarkup, skeletonMarkup } from "./branchmap";
import {
  buildMapModel,
  centreOn,
  FIT_MAX_SCALE,
  fitView,
  HERE_DECISION_GAP,
  hitTest,
  jumpFor,
  LABEL_MIN_SCALE,
  labelMinScale,
  MAP_GEOMETRY,
  type MapModel,
  type MapReader,
  markMap,
  openingView,
  runAt,
  runJump,
  SMALL_LABEL_MIN_SCALE,
  truncateLabel,
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
    // The nested decision sits on route 1's row, right of its pill, and
    // its two routes make route 1 two rows tall, so route 2 comes after.
    expect(nested.y).toBe(r1.y);
    expect(nested.x).toBeGreaterThan(r1.x + MAP_GEOMETRY.routeW);
    expect(r2.y - r1.y).toBe(2 * MAP_GEOMETRY.rowH);
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

describe("markMap: the reader's marks", () => {
  it("on a first load: nothing reached, everything unseen, here at the start", () => {
    const model = demoModel();
    const marks = markMap(model, readerOf(demoMachine()));
    expect(marks.reached).toEqual([false, false]);
    expect(new Set(marks.routes)).toEqual(new Set(["unseen"]));
    expect(marks.runs[0]).toBe("partly"); // lead seen, decide not
    expect(marks.here.y).toBe(model.runs[0].y);
    expect(marks.here.x).toBeLessThan(
      (model.runs[0].x0 + model.runs[0].x1) / 2,
    );
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
    expect(seen.x0).toBeLessThanOrEqual(0);
    expect(seen.y0).toBeLessThanOrEqual(0);
    expect(seen.x1).toBeGreaterThanOrEqual(model.width);
    expect(seen.y1).toBeGreaterThanOrEqual(model.height);
    expect(zoomLimits(model, 1920, 1080).min).toBeLessThanOrEqual(view.scale);
    // A small tree is not blown up past the cap.
    expect(fitView(demoModel(), 1920, 1080).scale).toBeLessThanOrEqual(
      FIT_MAX_SCALE,
    );
  });

  it("opens centred on 'you are here' at a readable scale", () => {
    const { items, branches } = synthetic(10, 3, 20);
    const model = buildMapModel(items, branches);
    const marks = markMap(model, {
      visited: [0, 1, 2],
      playedRoutes: [],
      cursor: 2,
    });
    const view = openingView(model, marks, 800, 600);
    expect(view.scale).toBeGreaterThanOrEqual(0.7);
    expect(view).toEqual(
      centreOn(marks.here.x, marks.here.y, 800, 600, view.scale),
    );
  });
});

describe("level of detail, culling and hit testing", () => {
  it("draws only the nodes near the view when asked to cull", () => {
    const { items, branches } = synthetic(30, 6, 26);
    const model = buildMapModel(items, branches);
    const marks = markMap(model, { visited: [], playedRoutes: [], cursor: 0 });
    const all = detailMarkup(model, marks).match(/<g /g)?.length ?? 0;
    expect(all).toBe(model.decisions.length + model.routes.length);
    const near = visibleWorld(centreOn(800, 400, 1920, 1080, 1), 1920, 1080);
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
    expect(hitTest(model, route.x + 100, route.y + 10)).toEqual({
      kind: "route",
      key,
    });
    expect(hitTest(model, 0, 0)).toBe(null);
  });
});

describe("labels and markup", () => {
  it("truncates long labels with an ellipsis and keeps short ones", () => {
    expect(truncateLabel("Short", 10)).toBe("Short");
    expect(truncateLabel("A rather long route label here", 12)).toBe(
      "A rather lo…",
    );
    expect([...truncateLabel("x".repeat(40), 12)]).toHaveLength(12);
  });

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

// ---------------------------------------------------------------------------
// A synthetic game: `top` decisions along the main line, each with three
// routes (continuing, returning, ending); the continuing route nests a
// decision down to `depth`, the returning one down to half of it; every
// stretch is `run` screens.
// ---------------------------------------------------------------------------
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
