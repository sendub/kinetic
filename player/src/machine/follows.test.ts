import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachine, resolveDecisions } from "./machine";
import type {
  Branch,
  Item,
  MachineContext,
  MachineSettings,
  MachineState,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

// A decision that follows an earlier one (docs/content-format.md,
// "Branches"; docs/plan.md Phase 60 item 5): with Play all routes off it
// fires with no choice screen and takes the route whose `when` names the
// reader's last pick at the decision it follows (else its `when`-less
// route), or passes on to `continueAt` when no route takes that pick; with
// no pick known it is an ordinary choice. With Play all routes on it is an
// ordinary decision whose matching route plays last.

const OFF: MachineSettings = { ...DEFAULT_SETTINGS, playAllRoutes: false };
const ALL: MachineSettings = { ...DEFAULT_SETTINGS, playAllRoutes: true };

afterEach(() => {
  vi.useRealTimers();
});

function image(id: string): Item {
  return { id, type: "image", file: `${id}.jpg` };
}

// intro d1 | a-1 | b-1 | c-1 | mid | x-1 | y-1 y-2 | z-1 z-2 z-3 | join end
//  0     1 | 2   | 3   | 4   | 5   | 6   | 7   8   | 9   10  11  | 12   13
// d1 off `d1`: A, B, C (the continuing route), each rejoining at `mid`.
// d2 off `mid` follows d1: X takes A, Y takes B, Z (no `when`, the
// continuing route) takes the rest, C; all rejoin at `join`.
const ITEMS = [
  "intro",
  "d1",
  "a-1",
  "b-1",
  "c-1",
  "mid",
  "x-1",
  "y-1",
  "y-2",
  "z-1",
  "z-2",
  "z-3",
  "join",
  "end",
];
const D1: Branch = {
  id: "d1",
  after: "d1",
  prompt: "Which door?",
  routes: [
    {
      id: "r-a",
      label: "Door A",
      start: "a-1",
      end: "a-1",
      result: "continue",
    },
    {
      id: "r-b",
      label: "Door B",
      start: "b-1",
      end: "b-1",
      result: "continue",
    },
    { id: "r-c", label: "Door C", start: "c-1", end: "c-1" },
  ],
  continuingRoute: "r-c",
  continueAt: "mid",
};
const D2: Branch = {
  id: "d2",
  after: "mid",
  prompt: "Which fits your story so far?",
  follows: "d1",
  routes: [
    {
      id: "x",
      label: "After door A",
      start: "x-1",
      end: "x-1",
      result: "continue",
      when: ["r-a"],
    },
    {
      id: "y",
      label: "After door B",
      start: "y-1",
      end: "y-2",
      result: "continue",
      when: ["r-b"],
    },
    { id: "z", label: "After any other", start: "z-1", end: "z-3" },
  ],
  continuingRoute: "z",
  continueAt: "join",
};
const A = 0;
const B = 1;
const C = 2;
const MID = 5;
const JOIN = 12;

// The same story, where d2 has no route for door B: X takes A, Z takes C,
// and a reader who chose B passes d2 on to `join`. A pure choice d3 follows
// (13 `d3`, 14 `p-1`, 15 `q-1`).
const GAP_ITEMS = [...ITEMS.slice(0, 13), "d3", "p-1", "q-1"];
const GAP_D2: Branch = {
  ...D2,
  routes: [
    { ...D2.routes[0], end: "y-2" },
    { id: "z", label: "After door C", start: "z-1", end: "z-3", when: ["r-c"] },
  ],
};
const D3: Branch = {
  id: "d3",
  after: "d3",
  prompt: "Last?",
  routes: [
    { id: "p", label: "P", start: "p-1", end: "p-1" },
    { id: "q", label: "Q", start: "q-1", end: "q-1" },
  ],
};

function machine(
  opts: {
    items?: readonly string[];
    branches?: readonly Branch[];
    settings?: MachineSettings;
    resumeFrontier?: number;
    resumeContext?: MachineContext;
  } = {},
) {
  return createMachine({
    items: (opts.items ?? ITEMS).map(image),
    branches: opts.branches ?? [D1, D2],
    settings: opts.settings ?? OFF,
    resumeFrontier: opts.resumeFrontier,
    resumeContext: opts.resumeContext,
    autoAdvance: false, // manual: one press is one step
  });
}

type M = ReturnType<typeof machine>;

/** Read from the opening, pick `route` at d1, and read on to `mid`. */
function toMid(m: M, route: number): void {
  m.advance(); // 0 -> 1
  m.advance(); // fires d1
  m.choose(route);
  m.advance(); // off the route's one item: joins at `mid`
  expect(m.getState().cursor).toBe(MID);
}

/** Every state the machine emits while `act` runs. */
function statesDuring(m: M, act: () => void): MachineState[] {
  const states: MachineState[] = [];
  const stop = m.subscribe((s) => states.push(s));
  act();
  stop();
  return states;
}

describe("resolving `follows` and `when`", () => {
  it("each route of the followed decision maps to the route that takes it", () => {
    const resolved = resolveDecisions(ITEMS.map(image), [D1, D2]);
    expect(resolved[0].follows).toBe(-1);
    expect(resolved[1].follows).toBe(0);
    expect(resolved[1].takes).toEqual([0, 1, 2]); // C falls to Z
  });

  it("a pick no route takes maps to -1", () => {
    const resolved = resolveDecisions(GAP_ITEMS.map(image), [D1, GAP_D2, D3]);
    expect(resolved[1].takes).toEqual([0, -1, 1]);
  });

  it("an unsound table leaves an ordinary decision, which an older player shows too", () => {
    const cases: Branch[] = [
      { ...D2, follows: "ghost" }, // no such decision
      { ...D2, follows: "d2" }, // itself
      {
        ...D2,
        routes: [
          D2.routes[0],
          { ...D2.routes[1], when: ["r-a"] },
          D2.routes[2],
        ],
      }, // r-a in two routes
      {
        ...D2,
        routes: [
          D2.routes[0],
          { ...D2.routes[1], when: undefined },
          D2.routes[2],
        ],
      }, // two routes without `when`
      {
        ...D2,
        routes: [
          D2.routes[0],
          { ...D2.routes[1], when: ["r-z"] },
          D2.routes[2],
        ],
      }, // a route d1 lacks
      {
        ...GAP_D2,
        continuingRoute: undefined,
        continueAt: undefined,
        routes: GAP_D2.routes.map((route) => ({ ...route, result: undefined })),
      }, // a pick no route takes, and no `continueAt` to pass on to
    ];
    for (const d2 of cases) {
      const resolved = resolveDecisions(GAP_ITEMS.map(image), [D1, d2]);
      expect(resolved[1].id).toBe("d2");
      expect(resolved[1].follows).toBe(-1);
    }
    // A decision whose `after` comes first cannot follow a later one.
    const early = resolveDecisions(ITEMS.map(image), [
      { ...D1, follows: "d2" },
      D2,
    ]);
    expect(early[0].follows).toBe(-1);
  });

  it("a decision cannot follow one that encloses it", () => {
    // o | i-1 i-2 | j-1 | k-1
    // The inner decision off `i-1` lies inside route I of `outer`.
    const items = ["o", "i-1", "i-2", "j-1", "k-1"].map(image);
    const outer: Branch = {
      id: "outer",
      after: "o",
      prompt: "?",
      routes: [
        { id: "i", label: "I", start: "i-1", end: "j-1" },
        { id: "k", label: "K", start: "k-1", end: "k-1" },
      ],
    };
    const inner: Branch = {
      id: "inner",
      after: "i-1",
      prompt: "?",
      follows: "outer",
      routes: [
        { id: "m", label: "M", start: "i-2", end: "i-2", when: ["i"] },
        { id: "n", label: "N", start: "j-1", end: "j-1" },
      ],
    };
    const resolved = resolveDecisions(items, [outer, inner]);
    expect(resolved[1].follows).toBe(-1);
  });
});

describe("Play all routes off: the matching route is entered with no choice screen", () => {
  it("a pick a route's `when` names enters that route at once, as a pick", () => {
    const m = machine();
    toMid(m, B);
    const states = statesDuring(m, () => m.advance());
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((s) => s.choice === undefined)).toBe(true);
    expect(m.getState().cursor).toBe(7); // y-1
    const context = m.exportContext();
    expect(context.stack).toEqual([{ decision: 1, route: 1 }]);
    expect(context.lastPicks).toEqual([
      { decision: 0, route: B },
      { decision: 1, route: 1 },
    ]);
    expect(context.playedRoutes).toEqual([
      { decision: 0, routes: [B] },
      { decision: 1, routes: [1] },
    ]);
    m.advance(); // 7 -> 8
    m.advance(); // off Y's end: a continue route joins
    expect(m.getState().cursor).toBe(JOIN);
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().completedRoutes).toContainEqual({
      decision: 1,
      routes: [1],
    });
    m.destroy();
  });

  it("each pick at d1 takes its own route", () => {
    const m = machine();
    toMid(m, A);
    m.advance();
    expect(m.getState().cursor).toBe(6); // x-1
    expect(m.exportContext().stack).toEqual([{ decision: 1, route: 0 }]);
    m.destroy();
  });

  it("a pick no `when` names takes the `when`-less route", () => {
    const m = machine();
    toMid(m, C);
    m.advance();
    expect(m.getState().cursor).toBe(9); // z-1
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().stack).toEqual([{ decision: 1, route: 2 }]);
    m.advance();
    m.advance();
    m.advance(); // off Z, the continuing route: joins
    expect(m.getState().cursor).toBe(JOIN);
    m.destroy();
  });

  it("a pick no route takes passes the decision: flow goes on at continueAt", () => {
    const m = machine({ items: GAP_ITEMS, branches: [D1, GAP_D2, D3] });
    toMid(m, B);
    const states = statesDuring(m, () => m.advance());
    expect(states.every((s) => s.choice === undefined)).toBe(true);
    expect(m.getState().cursor).toBe(JOIN);
    const context = m.exportContext();
    expect(context.stack).toEqual([]);
    expect(context.lastPicks).toEqual([{ decision: 0, route: B }]);
    expect(context.playedRoutes).toEqual([{ decision: 0, routes: [B] }]);
    m.advance();
    expect(m.getState().cursor).toBe(13);
    m.destroy();
  });

  it("with no pick known at d1 it shows its choice screen", () => {
    const m = machine({ resumeFrontier: MID + 1 }); // a seen prefix, no picks
    expect(m.getState().cursor).toBe(MID);
    m.advance();
    expect(m.getState().cursor).toBe(MID);
    expect(m.getState().choice?.decisionId).toBe("d2");
    expect(m.getState().choice?.autoPick).toBeUndefined();
    m.choose(0);
    expect(m.getState().cursor).toBe(6);
    m.destroy();
  });

  it("the route pill sees an ordinary route entry: a new frame on the route's first item", () => {
    const m = machine();
    toMid(m, B);
    const before = m.getState().cursor;
    m.advance();
    const frames = m.exportContext().stack;
    const frame = frames[frames.length - 1];
    expect(frame).toEqual({ decision: 1, route: 1 });
    expect(m.getState().cursor).toBeGreaterThan(before); // no back jump
    expect(m.getState().cursor).toBe(7); // the route's first item
    m.destroy();
  });

  it("a skip burst runs through a seen matching route, and stops before an unseen one", () => {
    vi.useFakeTimers();
    const m = machine();
    toMid(m, B);
    m.advance(); // into Y
    m.advance();
    m.advance(); // joins at 12
    m.advance(); // 13
    // Back to d1's choice and pick A: X has not been read.
    for (let n = 0; n < 40; n += 1) {
      if (m.getState().choice?.decisionId === "d1") break;
      m.wheelBack();
    }
    expect(m.getState().choice?.decisionId).toBe("d1");
    m.choose(A); // a-1, unseen
    m.advance(); // joins at mid, seen
    expect(m.getState().cursor).toBe(MID);
    // Mid is seen, X is not: skip has nothing to run through.
    m.toggleSkip();
    expect(m.getState().skipping).toBe(false);
    // Back to d1 again and take B: Y is seen.
    for (let n = 0; n < 40; n += 1) {
      if (m.getState().choice?.decisionId === "d1") break;
      m.wheelBack();
    }
    m.choose(B);
    m.toggleSkip();
    expect(m.getState().skipping).toBe(true);
    vi.advanceTimersByTime(10_000);
    // Through `mid` into Y with no choice on the way; the burst ends on
    // y-2, as skip ends before an unseen next item (z-1).
    expect(m.getState().choice).toBeUndefined();
    expect(m.getState().cursor).toBe(8);
    expect(m.exportContext().stack).toEqual([{ decision: 1, route: 1 }]);
    m.destroy();
  });
});

describe("Play all routes on: an ordinary decision, its matching route last", () => {
  /** The routes play-all picks at d2, in order, reading to the end. */
  function picksAtD2(m: M): number[] {
    const picks: number[] = [];
    m.subscribe((s) => {
      if (s.choice?.decisionId === "d2" && s.choice.autoPick?.picked === false)
        picks.push(s.choice.autoPick.routeIdx);
    });
    for (let press = 0; press < 60 && m.getState().cursor !== 13; press += 1)
      m.advance(); // Space takes each auto-pick at once
    return picks;
  }

  it("the matching route plays last, in place of the continuing route", () => {
    vi.useFakeTimers();
    const m = machine();
    toMid(m, B); // picked B with play-all off
    m.setSettings(ALL);
    // Shortest first (X, then Z, the continuing route, no longer held
    // last), then Y, the route taking B; Z's end re-offers the choice.
    expect(picksAtD2(m)).toEqual([0, 2, 1]);
    expect(m.getState().cursor).toBe(13);
    expect(m.exportContext().visited).toEqual([
      0, 1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    m.destroy();
  });

  it("with the continuing route the match, the order is as for any decision", () => {
    vi.useFakeTimers();
    const m = machine();
    toMid(m, C);
    m.setSettings(ALL);
    expect(picksAtD2(m)).toEqual([0, 1, 2]);
    m.destroy();
  });

  it("with no pick known, the order is as for any decision", () => {
    vi.useFakeTimers();
    const m = machine({ settings: ALL, resumeFrontier: MID + 1 });
    expect(picksAtD2(m)).toEqual([0, 1, 2]);
    m.destroy();
  });

  it("a pick no route takes: an ordinary decision, every route once", () => {
    vi.useFakeTimers();
    const m = machine({ items: GAP_ITEMS, branches: [D1, GAP_D2] });
    toMid(m, B);
    m.setSettings(ALL);
    const picks: number[] = [];
    m.subscribe((s) => {
      if (s.choice?.decisionId === "d2" && s.choice.autoPick?.picked === false)
        picks.push(s.choice.autoPick.routeIdx);
    });
    for (let press = 0; press < 60 && m.getState().cursor !== 13; press += 1)
      m.advance();
    expect(picks).toEqual([0, 1]);
    m.destroy();
  });
});

describe("a reload and a rewind at a following decision", () => {
  it("a reload inside the matching route resumes in the route", () => {
    const m = machine();
    toMid(m, B);
    m.advance(); // into Y at 7
    const saved = m.exportContext();
    m.destroy();
    const again = machine({ resumeContext: saved });
    expect(again.getState().cursor).toBe(7);
    expect(again.getState().choice).toBeUndefined();
    again.advance(); // 7 -> 8
    again.advance(); // off Y: joins
    expect(again.getState().cursor).toBe(JOIN);
    again.destroy();
  });

  it("a reload at the after item fires the decision as before", () => {
    const m = machine();
    toMid(m, B);
    const saved = m.exportContext();
    m.destroy();
    const again = machine({ resumeContext: saved });
    expect(again.getState().cursor).toBe(MID);
    again.advance();
    expect(again.getState().cursor).toBe(7);
    expect(again.getState().choice).toBeUndefined();
    again.destroy();
  });

  it("a rewind past the decision and reading on fires it again and enters the match", () => {
    const m = machine();
    toMid(m, B);
    m.advance(); // into Y
    m.advance();
    m.advance(); // joins at 12
    for (let n = 0; n < 20; n += 1) {
      if (m.getState().cursor === MID && m.getState().choice === undefined)
        break;
      m.wheelBack();
    }
    expect(m.getState().cursor).toBe(MID);
    m.advance(); // the forward settle of `mid` again
    expect(m.getState().cursor).toBe(7);
    expect(m.getState().choice).toBeUndefined();
    // Further back, to d1, and another door: d2 follows the new pick.
    for (let n = 0; n < 20; n += 1) {
      if (m.getState().choice?.decisionId === "d1") break;
      m.wheelBack();
    }
    m.choose(A);
    m.advance(); // joins at mid
    m.advance();
    expect(m.getState().cursor).toBe(6); // X now
    expect(m.exportContext().lastPicks).toContainEqual({
      decision: 1,
      route: 0,
    });
    m.destroy();
  });
});

describe("the wheel's walk through a following decision", () => {
  const ALL_SEEN = ITEMS.map((_, index) => index);

  it("with no pick of its own, the walk takes the matching route", () => {
    const m = machine({
      resumeContext: {
        lastShown: MID,
        visited: ALL_SEEN,
        stack: [],
        playedRoutes: [{ decision: 0, routes: [B] }],
        lastPicks: [{ decision: 0, route: B }],
      },
    });
    m.wheelForward(); // d2's choice screen, leading into Y, not Z (longest)
    expect(m.getState().choice).toMatchObject({
      decisionId: "d2",
      walkRoute: 1,
    });
    m.wheelForward();
    expect(m.getState().cursor).toBe(7);
    m.destroy();
  });

  it("its own pick wins", () => {
    const m = machine({
      resumeContext: {
        lastShown: MID,
        visited: ALL_SEEN,
        stack: [],
        playedRoutes: [
          { decision: 0, routes: [B] },
          { decision: 1, routes: [2] },
        ],
        lastPicks: [
          { decision: 0, route: B },
          { decision: 1, route: 2 },
        ],
      },
    });
    m.wheelForward();
    expect(m.getState().choice).toMatchObject({
      decisionId: "d2",
      walkRoute: 2,
    });
    m.destroy();
  });

  it("a passed decision: the walk steps from its after item to continueAt and back", () => {
    const m = machine({ items: GAP_ITEMS, branches: [D1, GAP_D2, D3] });
    toMid(m, B);
    m.advance(); // passes on to 12
    m.advance(); // 13
    m.wheelBack();
    expect(m.getState().cursor).toBe(JOIN);
    m.wheelBack();
    expect(m.getState().cursor).toBe(MID);
    expect(m.getState().choice).toBeUndefined();
    m.wheelForward();
    expect(m.getState().cursor).toBe(JOIN);
    expect(m.getState().choice).toBeUndefined();
    m.destroy();
  });

  it("entering the matching route is a forward step: an advance, below the seen edge too", () => {
    // docs/plan.md Phase 60 item 9d: the route's first item is read now.
    const m = machine();
    toMid(m, A);
    m.advance(); // d2 takes route X at once
    expect(m.getState()).toMatchObject({ cursor: 6, transition: "advance" });
    m.advance(); // off X: joins
    expect(m.getState().cursor).toBe(JOIN);
    for (let notch = 0; notch < 8; notch += 1) {
      const s = m.getState();
      if (s.cursor === MID && s.choice === undefined) break;
      m.wheelBack();
    }
    expect(m.getState()).toMatchObject({ cursor: MID, transition: "nav" });
    m.advance(); // takes X again, below the edge
    expect(m.getState()).toMatchObject({
      cursor: 6,
      frontier: 13,
      transition: "advance",
    });
    m.destroy();
  });

  it("passing on is a forward step: an advance, below the seen edge too", () => {
    // docs/plan.md Phase 60 item 9d: the item at continueAt is read now,
    // so its media plays again (`playbackModeFor`).
    const m = machine({ items: GAP_ITEMS, branches: [D1, GAP_D2, D3] });
    toMid(m, B);
    m.advance(); // passes on to 12
    expect(m.getState()).toMatchObject({ cursor: JOIN, transition: "advance" });
    m.advance(); // 13
    m.wheelBack();
    m.wheelBack();
    expect(m.getState()).toMatchObject({ cursor: MID, transition: "nav" });
    m.advance(); // passes on again, below the edge
    expect(m.getState()).toMatchObject({
      cursor: JOIN,
      frontier: 14,
      transition: "advance",
    });
    m.destroy();
  });

  it("the walked choice screen shows the routes' seen marks, and a pick there is a real pick", () => {
    const m = machine();
    toMid(m, B);
    m.advance(); // into Y
    m.wheelBack(); // d2's choice screen
    expect(m.getState().choice?.decisionId).toBe("d2");
    expect(m.getState().choice?.routes.map((r) => r.seen)).toEqual([
      false,
      true,
      false,
    ]);
    m.choose(2);
    expect(m.getState().cursor).toBe(9);
    expect(m.exportContext().lastPicks).toContainEqual({
      decision: 1,
      route: 2,
    });
    m.destroy();
  });
});

describe("`u` and the end card treat its routes as any decision's", () => {
  it("the end card counts its unplayed routes", () => {
    const m = machine();
    toMid(m, B);
    m.advance(); // Y
    m.advance();
    m.advance(); // 12
    m.advance(); // 13, the end
    // d1's A and C, d2's X and Z: unplayed, unseen.
    expect(m.getState().endCard?.unseenRoutes).toBe(4);
    m.destroy();
  });

  it("a decision passed by a pick no route takes is behind the reader: `u` reaches past it", () => {
    const m = machine({ items: GAP_ITEMS, branches: [D1, GAP_D2, D3] });
    toMid(m, B);
    m.advance(); // passes on to 12
    m.advance(); // 13
    m.advance(); // fires d3
    m.choose(0); // P at 14
    m.advance(); // P's end re-offers d3
    expect(m.getState().choice?.decisionId).toBe("d3");
    m.jumpToUnseen();
    expect(m.getState().cursor).toBe(15); // Q, not back to door A
    m.destroy();
  });
});
