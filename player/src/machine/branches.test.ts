import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachine } from "./machine";
import type {
  Branch,
  Item,
  MachineContext,
  MachineSettings,
  Manifest,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

// Branch engine tests (docs/plan.md Phase 13, docs/content-format.md
// "Branches"): decision firing, route spans, the nesting stack, route-end
// overlays, play-all-routes, and the visited set that seen tracking now runs
// on. Linear behaviour is guarded by machine.test.ts, which these manifests
// must not change.

const SETTINGS: MachineSettings = { ...DEFAULT_SETTINGS };

function image(id: string): Item {
  return { id, type: "image", file: `${id}.jpg` };
}

interface Shape {
  items: readonly string[];
  branches: readonly Branch[];
}

function manifest(shape: Shape): Manifest {
  return {
    schemaVersion: 1,
    width: 1280,
    height: 720,
    items: shape.items.map(image),
    branches: shape.branches,
  };
}

function machine(
  shape: Shape,
  opts: {
    resumeFrontier?: number;
    resumeContext?: MachineContext;
    settings?: MachineSettings;
  } = {},
) {
  const m = manifest(shape);
  return createMachine({
    items: m.items,
    branches: m.branches,
    settings: opts.settings ?? SETTINGS,
    resumeFrontier: opts.resumeFrontier,
    resumeContext: opts.resumeContext,
    // The branch tests ride the AUTO-timed path (a hold firing on the
    // timer is half the branch flow); manual is the player's start and
    // the machine default (Phase 13b), pinned in machine.test.ts.
    autoAdvance: true,
  });
}

// lead-1 lead-2 decide | a-1 a-2 | b-1 b-2 | cont-1 cont-2 | after-1 after-2
//  0      1      2     | 3   4   | 5   6   | 7      8      | 9       10
// One decision off `decide`: route A returns to the main line, route B is an
// ending, route C is the continuing route rejoining at `after-1`.
const CANON: Shape = {
  items: [
    "lead-1",
    "lead-2",
    "decide",
    "a-1",
    "a-2",
    "b-1",
    "b-2",
    "cont-1",
    "cont-2",
    "after-1",
    "after-2",
  ],
  branches: [
    {
      id: "d1",
      after: "decide",
      prompt: "Which road?",
      routes: [
        {
          id: "r-a",
          label: "Route A",
          start: "a-1",
          end: "a-2",
          result: "return",
        },
        { id: "r-b", label: "Route B", start: "b-1", end: "b-2" },
        { id: "r-c", label: "Route C", start: "cont-1", end: "cont-2" },
      ],
      continuingRoute: "r-c",
      continueAt: "after-1",
    },
  ],
};

// lead-1 decide | a-1 a-decide | x-1 x-2 | y-1 y-2 | a-cont a-2 | b-1 b-2 | c-1 | after-1
//  0      1     | 2   3        | 4   5   | 6   7   | 8      9   | 10  11  | 12  | 13
// Route A of `d1` contains the decision `d2`, whose continuing route Y rejoins
// A at `a-cont`, so A runs on to its own end after `d2` closes.
const NESTED: Shape = {
  items: [
    "lead-1",
    "decide",
    "a-1",
    "a-decide",
    "x-1",
    "x-2",
    "y-1",
    "y-2",
    "a-cont",
    "a-2",
    "b-1",
    "b-2",
    "c-1",
    "after-1",
  ],
  branches: [
    {
      id: "d1",
      after: "decide",
      prompt: "Outer?",
      routes: [
        {
          id: "r-a",
          label: "Route A",
          start: "a-1",
          end: "a-2",
          result: "return",
        },
        { id: "r-b", label: "Route B", start: "b-1", end: "b-2" },
        { id: "r-c", label: "Route C", start: "c-1", end: "c-1" },
      ],
      continuingRoute: "r-c",
      continueAt: "after-1",
    },
    {
      id: "d2",
      after: "a-decide",
      prompt: "Inner?",
      routes: [
        { id: "r-x", label: "Route X", start: "x-1", end: "x-2" },
        { id: "r-y", label: "Route Y", start: "y-1", end: "y-2" },
      ],
      continuingRoute: "r-y",
      continueAt: "a-cont",
    },
  ],
};

// lead-1 decide | p-1 p-2 | q-1 q-2 | tail-1 tail-2
//  0      1     | 2   3   | 4   5   | 6      7
// A pure-choice decision: no continuing route, so no `continueAt` and no
// "return to main route" is ever offered.
const PURE: Shape = {
  items: ["lead-1", "decide", "p-1", "p-2", "q-1", "q-2", "tail-1", "tail-2"],
  branches: [
    {
      id: "d1",
      after: "decide",
      prompt: "Which ending?",
      routes: [
        { id: "r-p", label: "Route P", start: "p-1", end: "p-2" },
        { id: "r-q", label: "Route Q", start: "q-1", end: "q-2" },
      ],
    },
  ],
};

/** Settle and move, the two presses that carry the cursor past one item. */
function step(m: ReturnType<typeof machine>): void {
  m.advance();
  m.advance();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a decision fires on the forward settle of its after item", () => {
  it("settling the after item opens the choice with its prompt and routes", () => {
    vi.useFakeTimers();
    const m = machine(CANON);
    step(m); // 0 -> 1
    step(m); // 1 -> 2, the after item: entering it fires nothing
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice).toBeUndefined();
    m.advance(); // settling it is the forward settle the decision hangs off
    const state = m.getState();
    expect(state.cursor).toBe(2);
    expect(state.settled).toBe(true);
    expect(state.choice).toEqual({
      decisionId: "d1",
      prompt: "Which road?",
      routes: [
        { routeIdx: 0, id: "r-a", label: "Route A", seen: false },
        { routeIdx: 1, id: "r-b", label: "Route B", seen: false },
        { routeIdx: 2, id: "r-c", label: "Route C", seen: false },
      ],
    });
    m.destroy();
  });

  it("a manual press on the after item fires it in the same press", () => {
    // Manual is the player's start, and docs/plan.md Phase 16 makes one
    // press one step: the forward settle a decision hangs off IS that
    // press, so the reader gets the choice with no settle-only press first.
    const shape = manifest(CANON);
    const m = createMachine({
      items: shape.items,
      branches: shape.branches,
      settings: SETTINGS,
    }); // manual: the machine's own default
    m.advance(); // 0 -> 1
    expect(m.getState().cursor).toBe(1);
    m.advance(); // 1 -> 2, the after item: entering it fires nothing
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice).toBeUndefined();
    m.advance(); // the press that would step on fires the decision instead
    const state = m.getState();
    expect(state.cursor).toBe(2);
    expect(state.settled).toBe(true);
    expect(state.choice).toEqual(
      expect.objectContaining({ decisionId: "d1", prompt: "Which road?" }),
    );
    m.advance(); // inert while a choice is open
    expect(m.getState().cursor).toBe(2);
    m.choose(0);
    expect(m.getState().cursor).toBe(3);
    m.destroy();
  });

  it("an auto-advance off the after item opens the choice instead of moving", () => {
    vi.useFakeTimers();
    const m = machine(CANON);
    step(m);
    step(m); // cursor 2, unsettled
    vi.advanceTimersByTime(1500); // its hold elapses: the decision takes over
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: true,
      skipping: false,
      transition: "advance",
      choice: expect.objectContaining({ decisionId: "d1" }),
    });
    m.destroy();
  });

  it("navigating onto the after item SHOWS it unconsumed, and forward re-fires it", () => {
    // Adapted (docs/plan.md Phase 16): navigation onto an unresolved
    // decision's `after` item used to pass through invisibly; it now SHOWS
    // the decision as an arrival view and closes on the way away — still
    // firing nothing, the decision stays unconsumed.
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires
    m.choose(0); // into route A
    expect(m.getState().cursor).toBe(3);
    const stackBefore = m.exportContext().stack;
    m.wheelBack(); // back onto the after item: the arrival view shows d1
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.arrival).toBe(true);
    m.wheelForward(); // stepping away closes it; navigation consumes nothing
    expect(m.getState().cursor).toBe(3);
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().stack).toEqual(stackBefore); // no stack change
    m.wheelBack();
    m.advance(); // space over the arrival view: it fires the decision, no move
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.arrival).toBeUndefined(); // now a fired choice
    m.destroy();
  });

  it("every command but choose and chooseContinue is inert while a choice is open", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires
    const before = m.getState();
    m.advance();
    m.advance();
    m.wheelBack();
    m.wheelForward();
    m.toggleSkip();
    m.jumpToUnseen();
    m.goTo(0);
    m.chooseContinue(); // not offered here
    m.choose(9); // out of range
    expect(m.getState()).toBe(before);
    m.destroy();
  });

  it("a decision whose references do not resolve is dropped, not guessed", () => {
    const ghost: Shape = {
      items: CANON.items,
      branches: [{ ...CANON.branches[0], after: "not-here" }],
    };
    const m = machine(ghost);
    for (let press = 0; press < 24; press += 1) m.advance();
    expect(m.getState().cursor).toBe(10); // played straight through, linearly
    expect(m.getState().choice).toBeUndefined();
    m.destroy();
  });
});

describe("navigation arrivals show unresolved decisions (docs/plan.md Phase 16)", () => {
  it("a wheel arrival opens the decision; the pick enters the route like a fired choice", () => {
    const shape = manifest(CANON);
    const m = createMachine({
      items: shape.items,
      branches: shape.branches,
      settings: SETTINGS,
    }); // manual: the player's start
    m.advance(); // 0 -> 1
    m.advance(); // 1 -> 2: a forward STEP arrives quietly (firing stays on the settle)
    expect(m.getState().choice).toBeUndefined();
    m.wheelBack(); // 2 -> 1
    m.wheelForward(); // 1 -> 2: a navigation arrival SHOWS d1
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.arrival).toBe(true);
    expect(m.getState().settled).toBe(true); // timing paused: the item waits
    m.choose(1); // pick route B from the arrival view
    expect(m.getState().cursor).toBe(5); // route B's first item
    expect(m.getState().choice).toBeUndefined();
    const context = m.exportContext();
    expect(context.stack).toEqual([{ decision: 0, route: 1 }]); // route ctx pushed
    expect(context.playedRoutes).toEqual([{ decision: 0, routes: [1] }]);
    m.destroy();
  });

  it("goTo lands open and leaving closes it, stack and played set unchanged", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires
    m.choose(0); // inside route A at 3
    const context = m.exportContext();
    m.goTo(2); // a bookmark onto the after item shows the decision
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.arrival).toBe(true);
    m.goTo(0); // and jumping away just closes it
    expect(m.getState().cursor).toBe(0);
    expect(m.getState().choice).toBeUndefined();
    const after = m.exportContext(); // nothing was consumed by the visit
    expect(after.stack).toEqual(context.stack);
    expect(after.playedRoutes).toEqual(context.playedRoutes);
    m.destroy();
  });

  it("an e-jump landing on the after item shows the decision", () => {
    const m = machine(CANON, { resumeFrontier: 2 });
    m.jumpToUnseen(); // item 2: the first unseen, the after item
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.arrival).toBe(true);
    m.destroy();
  });

  it("an arrival view offers the return only once the CONTINUING route has completed", () => {
    // The arrival-open view follows the same rule as a fired re-offer
    // (docs/plan.md Phase 18, Branches): the row exists only once the
    // decision's continuing route has been played through to its end — a
    // completion of any OTHER route does not open it.
    const m = machine(CANON);
    step(m);
    step(m); // cursor 2 (`decide`), no route played yet
    m.wheelBack();
    m.wheelForward(); // arrival at `decide`: no offer to show yet
    expect(m.getState().choice?.arrival).toBe(true);
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.choose(1); // route B, an ending
    m.advance();
    m.advance();
    m.advance();
    m.advance(); // off B's end
    // Phase 18: B completed but C (the continuing route) has not, so the
    // re-offer is routes-only — picking C is the way forward.
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.choose(2); // route C, the continuing route: rejoins the main line at 9
    expect(m.getState().cursor).toBe(7);
    for (let press = 0; press < 2; press += 1) step(m); // 7 -> 8, then off C's
    expect(m.getState().cursor).toBe(9); // continuing: main line, no overlay
    expect(m.getState().choice).toBeUndefined();
    for (let back = 0; back < 7; back += 1) m.wheelBack(); // back to `decide`
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice?.arrival).toBe(true);
    expect(m.getState().choice?.continueOption).toBe(true);
    m.destroy();
  });

  it("a pure-choice decision never offers a return, arrival or re-offer", () => {
    const m = machine(PURE);
    step(m); // 0 -> 1
    m.wheelBack();
    m.wheelForward(); // arrival at `decide`
    expect(m.getState().choice?.arrival).toBe(true);
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.choose(0); // route P
    step(m); // 2 -> 3
    step(m); // P's end: Q unplayed, so the decision re-opens
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.destroy();
  });

  it("a pending auto timer cannot pass through an arrival: timing is paused", () => {
    vi.useFakeTimers();
    const m = machine(CANON); // auto: the arrival's own hold IS armed
    step(m);
    step(m); // cursor 2 with a 1500 ms hold pending
    m.wheelBack(); // 2 -> 1
    m.wheelForward(); // 1 -> 2: the arrival view cancels that hold
    expect(m.getState().choice?.arrival).toBe(true);
    vi.advanceTimersByTime(SETTINGS.minHoldMs * 10);
    expect(m.getState().cursor).toBe(2); // the cancelled timer carried nothing past
    expect(m.getState().choice?.decisionId).toBe("d1");
    m.destroy();
  });

  it("playAllRoutes: an arrival auto-resolves the decision on the spot", () => {
    // docs/plan.md Phase 16, Branches: play-all is the no-stop path, so an
    // arrival at an UNRESOLVED decision answers it at once — waiting for
    // the hold (or a press) over a screen play-all never shows was the
    // stall the user reported as "play all routes played no branches".
    const auto = { ...SETTINGS, playAllRoutes: true };
    const m = machine(CANON, { settings: auto });
    step(m);
    step(m); // cursor 2 (the play-all path shows no overlay anywhere)
    m.wheelBack();
    m.wheelForward(); // arrival onto `decide`: resolved on arrival, no wait
    expect(m.getState().choice).toBeUndefined();
    expect(m.getState().cursor).toBe(3); // route A entered
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: 0, routes: [0] },
    ]);
    m.destroy();
  });

  it("playAllRoutes: an e-jump onto the after item resolves it too", () => {
    const auto = { ...SETTINGS, playAllRoutes: true };
    const m = machine(CANON, { settings: auto, resumeFrontier: 2 });
    m.jumpToUnseen(); // lands on `decide`, the first unseen item
    expect(m.getState().choice).toBeUndefined();
    expect(m.getState().cursor).toBe(3); // route A entered, not an arrival view
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: 0, routes: [0] },
    ]);
    m.destroy();
  });

  it("playAllRoutes: arrival at an answered decision does not resurrect it", () => {
    // A decision with a played route keeps its resolved history: an
    // arrival neither opens the overlay nor auto-plays a route. Its unseen
    // routes stay `e`-visible items, and a forward step off `after`
    // re-fires the decision — the documented re-fire path, which play-all
    // then answers the same way as any other fire.
    const shape = manifest(CANON);
    const m = createMachine({
      items: shape.items,
      branches: shape.branches,
      settings: SETTINGS,
    }); // manual, play-all off: the reader answers the decision themselves
    step(m);
    step(m); // cursor 2 (`decide`)
    m.advance(); // its settle fires the decision; answered with route A
    m.choose(0);
    expect(m.getState().cursor).toBe(3);
    m.setSettings({ ...SETTINGS, playAllRoutes: true }); // play-all from here
    m.wheelBack(); // back onto `decide` with route A already played
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice).toBeUndefined();
    const context = m.exportContext();
    expect(context.playedRoutes).toEqual([{ decision: 0, routes: [0] }]);
    expect(context.stack).toEqual([{ decision: 0, route: 0 }]); // untouched
    m.destroy();
  });
});

describe("choosing a route and ending one", () => {
  it("choose marks the route played and enters its first item fresh", () => {
    vi.useFakeTimers();
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires
    m.choose(1); // route B
    expect(m.getState()).toEqual({
      cursor: 5,
      frontier: 6,
      settled: false, // a fresh entry: the route's first item plays normally
      skipping: false,
      transition: "nav",
    });
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: 0, routes: [1] },
    ]);
    vi.advanceTimersByTime(1500); // and its own hold carries it on
    expect(m.getState().cursor).toBe(6);
    m.destroy();
  });

  it("the continuing route proceeds to continueAt past its end", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(2); // route C is the continuing route
    expect(m.getState().cursor).toBe(7);
    m.advance();
    m.advance(); // 7 -> 8, its last item
    expect(m.getState().cursor).toBe(8);
    m.advance();
    m.advance(); // off the end: join the aftermath, no overlay
    expect(m.getState()).toEqual({
      cursor: 9,
      frontier: 10,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    m.destroy();
  });

  it("a return route ends by offering the unseen routes — no return row yet", () => {
    // Phase 18: finishing route A completes a NON-continuing route, which no
    // longer opens "Return to main route"; the re-offer is routes-only.
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(0); // route A, result "return"
    m.advance();
    m.advance(); // 3 -> 4
    m.advance();
    m.advance(); // off the span's last item
    expect(m.getState().cursor).toBe(4);
    expect(m.getState().choice).toEqual({
      decisionId: "d1",
      prompt: "Which road?",
      routes: [
        { routeIdx: 0, id: "r-a", label: "Route A", seen: true },
        { routeIdx: 1, id: "r-b", label: "Route B", seen: false },
        { routeIdx: 2, id: "r-c", label: "Route C", seen: false },
      ],
    });
    m.chooseContinue(); // not offered: inert (docs/plan.md Phase 18)
    expect(m.getState().cursor).toBe(4);
    m.choose(2); // pick the continuing route to advance...
    step(m); // 7 -> 8
    step(m); // ...and finishing it joins the aftermath at `continueAt`
    expect(m.getState().cursor).toBe(9);
    m.destroy();
  });

  it("an ending route re-opens the decision with no return row yet", () => {
    // Adapted for docs/plan.md Phase 18 (Branches): the Phase 16 rule offered
    // the return once ANY route had completed, "so the ending loop is
    // escapable". Now the row needs the CONTINUING route completed — an
    // ending-only re-offer is routes-only, and the escape is picking the
    // continuing route; finishing it once makes every later re-offer carry
    // the row.
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(1); // route B is an ending (the schema default)
    m.advance();
    m.advance(); // 5 -> 6
    m.advance();
    m.advance(); // off the span's last item
    const choice = m.getState().choice;
    expect(choice?.decisionId).toBe("d1");
    expect(choice?.continueOption).toBeUndefined(); // B completed, C not
    expect(choice?.routes.map((r) => r.seen)).toEqual([false, true, false]);
    m.choose(1); // re-pick the ending; still no offer after another pass
    m.advance();
    m.advance();
    m.advance();
    m.advance();
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.choose(2); // the continuing route: its end joins the aftermath once
    step(m); // 7 -> 8
    step(m); // off C's end: continuing route completed, joined at continueAt
    expect(m.getState().cursor).toBe(9);
    expect(m.exportContext().stack).toEqual([]); // C's frame popped at its end
    expect(m.getState().choice).toBeUndefined();
    m.destroy();
  });

  it("an ending route can also be reselected into another route", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(1); // route B, an ending
    m.advance();
    m.advance(); // 5 -> 6
    m.advance();
    m.advance(); // off the span's last item
    expect(m.getState().choice?.decisionId).toBe("d1");
    m.choose(0); // reselect into another route
    expect(m.getState().cursor).toBe(3);
    m.destroy();
  });

  it("chooseContinue needs the completed continuing route, and marks nothing new", () => {
    // Phase 18 rework: the row exists only after the continuing route
    // completes once (the old flow — pick A, re-offer, continue — no longer
    // offers it). Once it does answer, it still marks nothing: the played
    // set is untouched by the join.
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(2); // route C, the continuing route
    step(m); // 7 -> 8
    step(m); // C completes: joins the aftermath, the row unlocks
    expect(m.getState().cursor).toBe(9);
    for (let back = 0; back < 7; back += 1) m.wheelBack(); // back to `decide`
    expect(m.getState().choice?.arrival).toBe(true);
    expect(m.getState().choice?.continueOption).toBe(true); // C completed once
    m.choose(0); // route A again from the arrival view
    step(m); // 3 -> 4
    step(m); // A's end: the re-offer keeps the row
    expect(m.getState().choice?.continueOption).toBe(true);
    const before = m.exportContext().playedRoutes;
    m.chooseContinue(); // joins the aftermath, marks nothing
    expect(m.getState().cursor).toBe(9);
    expect(m.exportContext().playedRoutes).toEqual(before);
    m.destroy();
  });

  it("an unsettle of a decision's after item inside a route is the inner one", () => {
    // `a-decide` is route A's own decision: the outer one is not offered
    // again while the reader is inside the route.
    const m = machine(NESTED);
    step(m); // 0 -> 1 (`decide`)
    m.advance(); // fires d1
    expect(m.getState().choice?.decisionId).toBe("d1");
    m.choose(0);
    step(m); // 2 -> 3 (`a-decide`)
    m.advance(); // fires d2, not d1
    expect(m.getState().choice?.decisionId).toBe("d2");
    m.destroy();
  });

  it("a pure choice re-opens while a route is unplayed, then closes past the region", () => {
    // Route Q (later in the array) first, then route P: P's end is NOT
    // the region end, so the close proves it targets region end + 1 (tail-1,
    // 6), not route end + 1 (4). Q's items cannot be skipped on the way —
    // they lie inside the region, which is only left once all-played.
    const m = machine(PURE);
    step(m); // 0 -> 1 (`decide`)
    m.advance(); // fires d1
    m.choose(1); // route Q: 4..5
    step(m); // 4 -> 5
    step(m); // Q's end: P is unplayed, so the decision re-opens with seen flags
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.routes.map((r) => r.seen)).toEqual([
      false,
      true,
    ]);
    m.choose(0); // route P: 2..3
    step(m); // 2 -> 3
    const cursors: number[] = [];
    m.subscribe((s) => cursors.push(s.cursor));
    m.advance(); // settle P's last item
    m.advance(); // every route played now: the decision CLOSES
    // 3 -> 6 directly: a route-end+1 close would have landed on q-1.
    expect([...new Set(cursors)]).toEqual([3, 6]);
    expect(m.getState().choice).toBeUndefined();
    m.destroy();
  });
});

describe("the seen mark means the route was PLAYED (docs/plan.md Phase 16)", () => {
  // The rule (docs/plan.md Phase 16, Branches; `ChoiceRoute.seen`): a route
  // row's mark means the reader was ROUTED INTO that route — `choose()` or a
  // play-all auto-pick, whose first item then became current. Firing, viewing
  // or dismissing a decision marks nothing; the other route's items being seen
  // marks nothing; a restored position marks nothing.
  //
  // The decision this block pins (the Phase 16 item asked for the call):
  // NAVIGATION does not mark a route. It cannot here — finishing the demo's
  // hire route and wheeling back to its decision walks the cursor over the
  // refuse route's items, so a mark read from `visited ∩ span` would show the
  // route the reader never played as seen, which is the sighting the item
  // reports. `visited` stays the source for ITEM marks (the `e` jump, skip,
  // bookmarks, frontier resume); the row mark stays the played set, so these
  // tests fail the moment the row mark starts reading `visited`.
  const manual = (shape: Shape) => {
    const m = manifest(shape);
    return createMachine({
      items: m.items,
      branches: m.branches,
      settings: SETTINGS,
    }); // manual: the player's start (one press = one step)
  };
  const seenFlags = (m: ReturnType<typeof manual>) =>
    m.getState().choice?.routes.map((r) => r.seen);

  it("one route played to the end: the back-scroll past the others marks them nothing", () => {
    // The user's flow on the demo: take the continuing route, finish, wheel
    // back to the branch. The back-scroll PASSES the other spans — their items
    // become visited — and the overlay still marks only the route taken.
    const m = manual(CANON);
    m.advance(); // 0 -> 1
    m.advance(); // 1 -> 2 (`decide`)
    m.advance(); // the forward settle fires d1
    m.choose(2); // route C, the continuing route
    m.advance(); // 7 -> 8
    m.advance(); // off C's end: the continuing route proceeds to `after-1`
    expect(m.getState().cursor).toBe(9);
    for (let back = 0; back < 7; back += 1) m.wheelBack(); // onto `decide`
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice?.arrival).toBe(true);
    expect(seenFlags(m)).toEqual([false, false, true]);
    // The pass-through did mark those ITEMS seen — route A's span (3, 4) and
    // route B's (5, 6) — and none of it reaches the rows.
    for (const index of [3, 4, 5, 6]) expect(m.visitedList()).toContain(index);
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: 0, routes: [2] },
    ]);
    m.destroy();
  });

  it("the same view fired by a press after the back-scroll marks the same", () => {
    const m = manual(CANON);
    m.advance();
    m.advance();
    m.advance(); // fires d1
    m.choose(2);
    m.advance();
    m.advance(); // -> 9, `after-1`
    for (let back = 0; back < 8; back += 1) m.wheelBack(); // 9 -> 1
    expect(m.getState().choice).toBeUndefined();
    m.advance(); // a forward step ONTO the after item arrives quietly
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice).toBeUndefined();
    m.advance(); // its forward settle FIRES the decision
    expect(m.getState().choice?.arrival).toBeUndefined();
    expect(seenFlags(m)).toEqual([false, false, true]);
    m.destroy();
  });

  it("firing, viewing and dismissing a decision mark no route", () => {
    const fired = manual(CANON);
    fired.advance(); // 0 -> 1
    fired.advance(); // 1 -> 2
    fired.advance(); // fired: no route has been played, so nothing is marked
    expect(seenFlags(fired)).toEqual([false, false, false]);
    fired.wheelBack(); // a fired choice owns the timeline: nothing moved
    expect(fired.getState().cursor).toBe(2);
    fired.chooseContinue(); // no offer yet, so this answers nothing
    expect(fired.getState().choice?.decisionId).toBe("d1");
    fired.destroy();
    const arrival = manual(CANON);
    arrival.advance();
    arrival.advance(); // 1 -> 2, an arrival like any other
    arrival.wheelBack();
    arrival.wheelForward(); // an arrival view, then dismissed by moving away
    expect(seenFlags(arrival)).toEqual([false, false, false]);
    arrival.wheelBack();
    expect(arrival.getState().choice).toBeUndefined();
    expect(arrival.exportContext().playedRoutes).toEqual([]);
    arrival.destroy();
  });

  it("wheeling into another route's span marks it nothing; playing it marks it", () => {
    const m = manual(CANON);
    m.advance();
    m.advance();
    m.advance(); // fires d1
    m.choose(2); // route C at 7
    m.wheelBack(); // 6: route B's last item, shown by navigation
    expect(m.visitedList()).toContain(6);
    m.wheelForward(); // 7: back inside the played route
    for (let back = 0; back < 5; back += 1) m.wheelBack(); // onto `decide`
    expect(seenFlags(m)).toEqual([false, false, true]); // B stays unmarked
    m.choose(1); // now the reader plays route B for real
    expect(m.getState().cursor).toBe(5);
    m.advance(); // 5 -> 6
    m.advance(); // off B's end: the re-offer marks the route just played
    expect(seenFlags(m)).toEqual([false, true, true]);
    m.destroy();
  });

  it("a restored position inside a route marks no route seen", () => {
    // The rule's other half: the mark comes from play, so a save landing
    // inside a span the reader never entered marks nothing — even though every
    // item of the region is in the restored seen set.
    const shape = manifest(CANON);
    const m = createMachine({
      items: shape.items,
      branches: shape.branches,
      settings: SETTINGS,
      resumeContext: {
        lastShown: 5, // route B's first item
        visited: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        stack: [],
        playedRoutes: [],
      },
    });
    expect(m.getState().cursor).toBe(5);
    for (let back = 0; back < 3; back += 1) m.wheelBack(); // onto `decide`
    expect(m.getState().choice?.arrival).toBe(true);
    expect(seenFlags(m)).toEqual([false, false, false]);
    m.destroy();
  });
});

describe("the return row needs the CONTINUING route completed (docs/plan.md Phase 18)", () => {
  // The rule: "Return to main route" exists only once the decision's
  // continuing route has COMPLETED — been played through to its route end
  // (`handleRouteEnd`). Entered-and-abandoned does not count: a continuation
  // the reader has not reached the end of is not a place to "return" to;
  // picking the continuing route is the way forward there. A decision with
  // NO continuing route never has the row (unchanged, pinned by PURE).
  const manual = (shape: Shape) => {
    const m = manifest(shape);
    return createMachine({
      items: m.items,
      branches: m.branches,
      settings: SETTINGS,
    }); // manual: the player's start (one press = one step)
  };

  it("enter the continuing route and wheel away: re-offers carry no return row", () => {
    // The user's flow: enter the continuing route (the demo's `hire`),
    // abandon it mid-span, come back. Entry is not completion — every view
    // of the decision, arrival or fired, stays routes-only.
    const m = manual(CANON);
    m.advance(); // 0 -> 1
    m.advance(); // 1 -> 2 (`decide`)
    m.advance(); // fires d1
    m.choose(2); // enter route C (the continuing route) at 7
    expect(m.getState().cursor).toBe(7);
    for (let back = 0; back < 5; back += 1) m.wheelBack(); // 7 -> 2, abandoning it
    expect(m.getState().choice?.arrival).toBe(true);
    expect(m.getState().choice?.continueOption).toBeUndefined(); // entry ≠ completion
    m.advance(); // over the arrival view: the press FIRES the decision
    expect(m.getState().choice?.arrival).toBeUndefined();
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.destroy();
  });

  it("finish the continuing route once: every later re-offer and arrival has the row", () => {
    const m = manual(CANON);
    m.advance();
    m.advance();
    m.advance(); // fires d1
    m.choose(2); // route C at 7
    m.advance(); // 7 -> 8
    m.advance(); // C completes: joins the aftermath at 9
    expect(m.getState().cursor).toBe(9);
    for (let back = 0; back < 7; back += 1) m.wheelBack(); // back to `decide`
    expect(m.getState().choice?.arrival).toBe(true);
    expect(m.getState().choice?.continueOption).toBe(true); // arrival view
    m.choose(0); // route A from the arrival view...
    m.advance(); // 3 -> 4
    m.advance(); // ...A's end: the fired re-offer keeps the row (Phase 18:
    expect(m.getState().choice?.continueOption).toBe(true); // completion is permanent)
    m.destroy();
  });

  it("finish an ending route first: no row — picking the continuing route advances", () => {
    // Fresh save, refuse-style: play an ENDING route to its end first. The
    // re-offer is routes-only; the way forward is the continuing route.
    const m = manual(CANON);
    m.advance();
    m.advance();
    m.advance(); // fires d1
    m.choose(1); // route B, an ending
    m.advance(); // 5 -> 6
    m.advance(); // B's end: re-offer
    const choice = m.getState().choice;
    expect(choice?.routes.every((r) => r.routeIdx !== -1)).toBe(true);
    expect(choice?.continueOption).toBeUndefined(); // an ending done ≠ a return
    m.choose(2); // so pick the continuing route...
    expect(m.getState().cursor).toBe(7); // ...and it plays — the way forward
    m.destroy();
  });

  it("inner early return after a LATE completion carries the row", () => {
    // NESTED: the inner decision d2 is re-opened by X's end with no row;
    // only when d2's continuing route Y completes (late, on the way out)
    // do later arrivals at d2 carry the inner return row. The outer d1 row
    // stays gated by ITS own continuing route: A was entered and left.
    const m = machine(NESTED);
    step(m); // 0 -> 1 (`decide`)
    m.advance(); // d1
    m.choose(0); // route A, which contains d2
    step(m); // 2 -> 3 (`a-decide`)
    m.advance(); // d2
    m.choose(0); // route X, an ending
    step(m); // 4 -> 5
    step(m); // off X's end: d2 re-opens, routes-only
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.choose(1); // route Y: d2's continuing route is the way forward
    step(m); // 6 -> 7
    step(m); // off Y's end: pop d2, rejoin A at `a-cont` — Y now COMPLETED
    expect(m.getState().cursor).toBe(8);
    for (let back = 0; back < 5; back += 1) m.wheelBack(); // 8 -> 3, back early
    expect(m.getState().cursor).toBe(3); // `a-decide`
    expect(m.getState().choice?.decisionId).toBe("d2");
    expect(m.getState().choice?.continueOption).toBe(true); // the late completion opened it
    m.wheelBack(); // 3 -> 2, closing the inner view as it steps away
    m.wheelBack(); // 2 -> 1 (`decide`)
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.continueOption).toBeUndefined(); // A entered-and-left
  });

  it("completedRoutes round-trips through ctx; a legacy save reads as nothing-completed", () => {
    const first = machine(CANON);
    step(first);
    step(first);
    first.advance(); // fires d1
    first.choose(2); // route C
    step(first); // 7 -> 8
    step(first); // C completes -> 9
    const stored = JSON.parse(
      JSON.stringify(first.exportContext()),
    ) as MachineContext;
    expect(stored.completedRoutes).toEqual([{ decision: 0, routes: [2] }]);
    first.destroy();

    // The completion survives the round trip: the restored save still offers
    // the row at the decision.
    const resumed = machine(CANON, { resumeContext: stored });
    for (let back = 0; back < 7; back += 1) resumed.wheelBack(); // 9 -> 2
    expect(resumed.getState().choice?.continueOption).toBe(true);
    resumed.destroy();

    // Legacy migration: the same save without the field restores
    // conservatively — the row stays hidden — until the reader finishes the
    // continuing route once in this session.
    const legacy = { ...stored } as MachineContext;
    delete legacy.completedRoutes;
    const old = machine(CANON, { resumeContext: legacy });
    for (let back = 0; back < 7; back += 1) old.wheelBack(); // 9 -> 2
    expect(old.getState().choice?.continueOption).toBeUndefined();
    old.choose(2); // finish route C once, here...
    step(old); // 7 -> 8
    step(old); // ...its end joins at 9 and unlocks the row
    for (let back = 0; back < 7; back += 1) old.wheelBack(); // 9 -> 2
    expect(old.getState().choice?.continueOption).toBe(true);
    expect(old.exportContext().completedRoutes).toEqual([
      { decision: 0, routes: [2] },
    ]);
    old.destroy();
  });

  it("Enter with no row is a silent no-op", () => {
    // The key path: `enterActionFor` answers "none" without a row (pinned in
    // render/choice.test.ts), and the machine's `chooseContinue` — what
    // Enter would call — is inert with no offer: no move, no state change,
    // no re-emit.
    const m = manual(CANON);
    m.advance();
    m.advance();
    m.advance(); // fires d1, no rows played: no row
    expect(m.getState().choice?.continueOption).toBeUndefined();
    const before = m.getState();
    m.chooseContinue();
    expect(m.getState()).toBe(before);
    expect(m.getState().choice?.decisionId).toBe("d1"); // the decision still waits
    m.destroy();
  });
});

describe("nested decisions", () => {
  it("a nested decision fires inside its route; its continuing route returns there", () => {
    // Phase 18 rework: the inner X route completing no longer opens d2's
    // return row — the reader advances by picking d2's continuing route Y,
    // and Y's end is what rejoins route A at `a-cont`.
    const m = machine(NESTED);
    step(m); // 0 -> 1
    m.advance(); // d1 fires
    m.choose(0); // route A
    expect(m.getState().cursor).toBe(2);
    step(m); // 2 -> 3, the nested decision's after item
    m.advance(); // d2 fires inside route A
    expect(m.getState().choice?.decisionId).toBe("d2");
    m.choose(0); // route X, an ending
    expect(m.getState().cursor).toBe(4);
    step(m); // 4 -> 5
    step(m); // off X's end: back to d2, routes-only (X completed, Y not)
    const choice = m.getState().choice;
    expect(choice?.decisionId).toBe("d2");
    expect(choice?.continueOption).toBeUndefined();
    expect(choice?.routes.map((r) => r.seen)).toEqual([true, false]);
    m.choose(1); // route Y, d2's continuing route
    expect(m.getState().cursor).toBe(6);
    step(m); // 6 -> 7
    step(m); // Y's end: join d2's `continueAt` (`a-cont`, 8)
    expect(m.getState().cursor).toBe(8);
    m.destroy();
  });

  it("a nested continuing route rejoins its route, which then ends itself", () => {
    const m = machine(NESTED);
    step(m);
    m.advance(); // d1
    m.choose(0); // route A
    step(m); // 2 -> 3
    m.advance(); // d2
    m.choose(1); // route Y is d2's continuing route
    expect(m.getState().cursor).toBe(6);
    step(m); // 6 -> 7
    step(m); // off Y's end: pop d2, rejoin A at `a-cont`
    expect(m.getState().cursor).toBe(8);
    expect(m.getState().choice).toBeUndefined();
    step(m); // 8 -> 9, A's last item
    step(m); // off A's end: pop d1's A frame, re-offer
    expect(m.getState().cursor).toBe(9);
    expect(m.getState().choice?.decisionId).toBe("d1");
    // Phase 18: A completed but d1's continuing route C never ran, so the
    // outer re-offer is routes-only — C is the way onward.
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.choose(2); // route C: its end joins d1's `continueAt` (13)
    expect(m.getState().cursor).toBe(12);
    step(m); // 12 is C's whole span; its end joins the aftermath
    expect(m.getState().cursor).toBe(13);
    m.destroy();
  });

  it("the stack closes outer decisions last, so nesting cannot lose a route", () => {
    const m = machine(NESTED);
    step(m);
    m.advance();
    m.choose(0); // A
    step(m);
    m.advance(); // d2
    m.choose(1); // Y continuing -> rejoins A at 8
    step(m); // 6 -> 7
    step(m); // off Y's end: pop d2 and rejoin A at 8
    step(m); // 8 -> 9, A's last item
    step(m); // off A's end: d1 re-opens (routes-only, Phase 18)
    m.choose(1); // reselect route B
    expect(m.getState().cursor).toBe(10);
    expect(m.exportContext().stack).toEqual([{ decision: 0, route: 1 }]);
    step(m); // 10 -> 11
    step(m); // off B's end: an ending, re-offer — still no return row (C unplayed)
    expect(m.getState().choice?.continueOption).toBeUndefined();
    expect(m.exportContext().stack).toEqual([]); // B's frame popped at its end
    m.choose(2); // the continuing route leaves d1 for good, advancing itself
    expect(m.getState().cursor).toBe(12);
    step(m); // 12 is C's whole span; its end joins the main line at 13
    expect(m.getState().cursor).toBe(13);
    m.destroy();
  });
});

describe("playAllRoutes (docs/plan.md Phase 13)", () => {
  const auto: MachineSettings = { ...SETTINGS, playAllRoutes: true };

  it("plays every route in manifest order, the continuing route last", () => {
    vi.useFakeTimers();
    const m = machine(CANON, { settings: auto });
    const choices: unknown[] = [];
    m.subscribe((s) => choices.push(s.choice));
    // Walk with presses so the whole decision block is traversed.
    for (let press = 0; press < 40; press += 1) m.advance();
    const seen = m.exportContext();
    expect(seen.playedRoutes).toEqual([{ decision: 0, routes: [0, 1, 2] }]);
    // Route A (return), then B (ending), then C (continuing) joined at 9.
    expect(seen.visited).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(choices.every((c) => c === undefined)).toBe(true);
    expect(m.getState().cursor).toBe(10);
    m.destroy();
  });

  it("an all-played decision with a continuing route proceeds to continueAt", () => {
    const m = machine(CANON, { settings: auto });
    for (let press = 0; press < 40; press += 1) m.advance();
    expect(m.getState().cursor).toBe(10); // content end, nothing replayed
    m.goTo(2); // back to the decision's after item
    expect(m.getState().choice).toBeUndefined();
    m.advance(); // settle: every route played, so continue past the decision
    expect(m.getState().cursor).toBe(9); // to continueAt, not into a route
    expect(m.getState().choice).toBeUndefined();
    m.destroy();
  });

  it("a pure-choice decision plays each alternate, then closes past the region", () => {
    // Was "stops at its ending": the old auto walk stalled on Q's last
    // item, so the tail never played. Under the all-played rule
    // (docs/plan.md Phase 13) the closed decision lets the walk flow on.
    const m = machine(PURE, { settings: auto });
    for (let press = 0; press < 30; press += 1) m.advance();
    // P, then Q; Q completing plays every route, so the decision closes
    // at region end + 1 and the tail items play through to the content end.
    expect(m.getState().cursor).toBe(7);
    expect(m.getState().settled).toBe(true);
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().visited).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    m.destroy();
  });

  it("an all-played pure choice re-arrives at after to past the region", () => {
    // Was "stepped past at after plus one": after + 1 lands INSIDE route
    // P's span — the old micro-rule, superseded. Re-arrival at `after`
    // with every route played resumes past the whole menu region.
    const m = machine(PURE, { settings: auto });
    for (let press = 0; press < 30; press += 1) m.advance();
    expect(m.getState().cursor).toBe(7);
    m.goTo(1); // the decision's after item, everything already played
    m.advance(); // settle: the decision is closed, so the lead-in continues
    expect(m.getState().cursor).toBe(6); // region end + 1, not after + 1 = 2
    expect(m.getState().choice).toBeUndefined();
    m.destroy();
  });

  it("the setting takes effect at the next decision and an open choice stays", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // the choice is open under the old settings
    m.setSettings(auto);
    expect(m.getState().choice?.decisionId).toBe("d1"); // already asked: answer it
    m.choose(2); // route C, so the whole block plays out
    step(m); // 7 -> 8
    step(m); // C's end: playAllRoutes is on now, so the join is taken
    expect(m.getState().cursor).toBe(9); // straight to continueAt
    m.goTo(2);
    m.advance(); // firing again: no choice — A has never played, so it runs
    expect(m.getState().choice).toBeUndefined();
    expect(m.getState().cursor).toBe(3);
    m.destroy();
  });

  it("a nested decision auto-plays its own routes before the outer one goes on", () => {
    const m = machine(NESTED, { settings: auto });
    for (let press = 0; press < 60; press += 1) m.advance();
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: 0, routes: [0, 1, 2] },
      { decision: 1, routes: [0, 1] },
    ]);
    // A (with X then Y inside it, rejoining at 8), B, then C to `after-1`.
    expect(m.exportContext().visited).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    expect(m.getState().cursor).toBe(13);
    m.destroy();
  });
});

describe("skip mode with branches", () => {
  it("a skip pauses at a decision even with skipAll on (was: never stops)", () => {
    // Adapted (docs/plan.md Phase 16): the burst used to auto-resolve
    // every decision in play order and never stop for a choice; `skipAll`
    // governs only unseen stops now, so the decision takes the pause.
    vi.useFakeTimers();
    const m = machine(CANON, { settings: { ...SETTINGS, skipAll: true } });
    const seen: (string | undefined)[] = [];
    m.subscribe((s) => seen.push(s.choice?.decisionId));
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs * 3); // 0->1->2, dwell on `decide`
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().skipping).toBe(false); // the burst ENDED at the decision
    expect(seen).toContain("d1");
    expect(m.visitedList()).toEqual([0, 1, 2]);
    m.destroy();
  });

  it("skipAll off still ends on the first item the reader had not seen", () => {
    vi.useFakeTimers();
    const m = machine(CANON, { resumeFrontier: 2 });
    expect(m.getState().cursor).toBe(1);
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs); // onto item 2, unseen
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    // Shown normally from there, and its own hold is what fires the decision.
    vi.advanceTimersByTime(1500);
    expect(m.getState().choice?.decisionId).toBe("d1");
    m.destroy();
  });

  it("a decision reached during a skip stops the burst; the pick stays manual", () => {
    // Adapted (docs/plan.md Phase 16): a decision reached during a skip
    // used to resolve itself without stopping. It now opens the overlay,
    // ends the burst, and — the reader's part — the pick never restarts
    // the burst: reading continues in manual mode.
    vi.useFakeTimers();
    const shape = manifest(CANON);
    const m = createMachine({
      items: shape.items,
      branches: shape.branches,
      settings: SETTINGS,
      resumeFrontier: 3,
    }); // manual: the player's start
    m.toggleSkip();
    const dwell = SETTINGS.skipDwellMs;
    vi.advanceTimersByTime(dwell); // the dwell on `decide` stops the burst
    expect(m.getState().cursor).toBe(2); // ON the after item, not past it
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().skipping).toBe(false);
    m.choose(0); // the pick lands on route A's first item...
    expect(m.getState().cursor).toBe(3);
    expect(m.getState().skipping).toBe(false); // ...and NO burst resumes
    vi.advanceTimersByTime(dwell * 10);
    expect(m.getState().cursor).toBe(3); // manual: nothing moves by itself
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: 0, routes: [0] },
    ]);
    m.destroy();
  });

  it("a skip burst flows past a CLOSED pure choice to the tail", () => {
    // The all-played close still flows through a burst (Phase 13 rule,
    // unchanged); only an UNRESOLVED decision stops it now (Phase 16), so
    // the routes are pre-played and `decide` closes past the region.
    vi.useFakeTimers();
    const context: MachineContext = {
      lastShown: 0,
      visited: [0],
      stack: [],
      playedRoutes: [{ decision: 0, routes: [0, 1] }],
    };
    const m = machine(PURE, {
      settings: { ...SETTINGS, skipAll: true },
      resumeContext: context,
    });
    const seen: (string | undefined)[] = [];
    m.subscribe((s) => seen.push(s.choice?.decisionId));
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs * 12);
    expect(seen.every((c) => c === undefined)).toBe(true);
    expect(m.visitedList()).toEqual([0, 1, 6, 7]); // past the whole region
    expect(m.getState().skipping).toBe(false);
    expect(m.getState().cursor).toBe(7);
    m.destroy();
  });
});

describe("the visited set, the derived frontier, and the wheel", () => {
  it("frontier is the old number while the seen set is a prefix", () => {
    const m = machine(CANON);
    expect(m.getState().frontier).toBe(1);
    step(m);
    expect(m.getState().frontier).toBe(2);
    expect(m.visitedList()).toEqual([0, 1]);
    m.destroy();
  });

  it("frontier keeps 1 past the highest shown item when a route leaves holes", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(2); // route C is far ahead in the array: 7, 8
    step(m); // 7 -> 8
    expect(m.visitedList()).toEqual([0, 1, 2, 7, 8]);
    // The seen set has holes (3..6 unseen), so the prefix rule would report
    // 3; the derived value keeps the legacy one (docs/plan.md Phase 13).
    expect(m.getState().frontier).toBe(9);
    expect(m.visitedList().filter((i) => i < 9).length).toBe(5);
    m.destroy();
  });

  it("wheel forward clamps at the highest shown item, not at the array end", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(2); // route C
    step(m); // 7 -> 8, so the ceiling is 8
    m.wheelBack();
    m.wheelBack(); // 8 -> 6
    for (let press = 0; press < 6; press += 1) m.wheelForward(); // 6 -> 8 plus clamps
    expect(m.getState().cursor).toBe(8);
    m.wheelForward(); // beyond the ceiling: blocked
    expect(m.getState().cursor).toBe(8);
    m.destroy();
  });

  it("a wheel step onto a decision SHOWS it; across it is still navigation", () => {
    // Adapted (docs/plan.md Phase 16): the invisible pass-through became
    // an arrival view; crossing over the decision still consumes nothing.
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(0); // inside route A at 3
    m.wheelBack(); // onto `decide`, the after item: shown, not fired
    expect(m.getState().choice?.arrival).toBe(true);
    m.wheelForward(); // over it into the route again: closed
    expect(m.getState().choice).toBeUndefined();
    const played = m.exportContext().playedRoutes;
    m.wheelBack();
    expect(m.getState().choice?.decisionId).toBe("d1"); // shown again, unanswered
    expect(m.exportContext().playedRoutes).toEqual(played); // consumed nothing
    m.destroy();
  });

  it("navigation marks what it shows, so a seen item cannot become unseen", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(2); // 7
    step(m); // 8
    const before = m.visitedList();
    m.wheelBack(); // 7, then 6 — an item never played, now shown
    m.wheelBack();
    expect(m.visitedList()).toEqual([...before, 6].sort((a, b) => a - b));
    m.wheelForward(); // back onto 7: still seen, still marked
    expect(m.visitedList()).toContain(7);
    m.destroy();
  });

  it("marking happens on a wheel step into another route's items", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(2); // route C at 7
    m.wheelBack(); // 6: route B's last item, shown now
    expect(m.getState().cursor).toBe(6);
    expect(m.getState().settled).toBe(false); // an arrival replays, like goTo
    expect(m.visitedList()).toContain(6);
    m.destroy();
  });
});

describe("jumpToUnseen targets (the three cases, docs/plan.md Phase 13)", () => {
  it("case a: the first unseen item of the current route span", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(0); // route A at 3, span 3..4
    m.wheelBack(); // back to 2, then 1: outside the span
    m.wheelBack();
    expect(m.getState().cursor).toBe(1);
    m.jumpToUnseen(); // Phase 18 resume step: back to the reading position first
    expect(m.getState().cursor).toBe(3);
    m.jumpToUnseen(); // a: route A's own unseen item 4, not a global scan
    expect(m.getState().cursor).toBe(4);
    expect(m.getState().settled).toBe(false);
    expect(m.visitedList()).toContain(4);
    m.destroy();
  });

  it("case b: an unplayed route of the open decision", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(2); // route C at 7, span 7..8
    step(m); // 7 -> 8: the span is fully seen, C is still the open frame
    expect(m.visitedList().filter((i) => i >= 7)).toEqual([7, 8]);
    // b: the open decision has unplayed routes, and route A is the first of
    // them in manifest order — so `e` steps back to its unseen item.
    m.jumpToUnseen();
    expect(m.getState().cursor).toBe(3);
    expect(m.getState().choice).toBeUndefined(); // entering is navigation
    m.destroy();
  });

  it("case c: the first unseen item in array order", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(0); // route A, whose result is "return"
    step(m); // 3 -> 4
    step(m); // the route end re-opens — routes-only (Phase 18: C uncompleted)
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.choose(2); // picking the continuing route is the way forward...
    step(m); // 7 -> 8
    step(m); // ...and its end joins the main line at after-1 (9)
    step(m); // 9 -> 10, content end, no frame open
    expect(m.getState().cursor).toBe(10);
    m.jumpToUnseen(); // c: nothing ahead, so the first unseen in the array
    expect(m.getState().cursor).toBe(5);
    m.destroy();
  });

  it("with nothing unseen left the jump is a no-op", () => {
    const m = machine(CANON, {
      settings: { ...SETTINGS, playAllRoutes: true },
    });
    for (let press = 0; press < 40; press += 1) m.advance();
    const before = m.getState();
    m.jumpToUnseen();
    expect(m.getState()).toBe(before);
    m.destroy();
  });

  it("an e-jump is a fresh entry, not a settled landing", () => {
    vi.useFakeTimers();
    const m = machine(CANON);
    m.jumpToUnseen(); // item 1 is the first unseen
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    vi.advanceTimersByTime(1500); // its own hold carries it on
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });
});

describe('`e` with everything seen: the most recently seen ending (docs/plan.md Phase 16, "Machine bugs")', () => {
  // CANON's ending items are `b-2` (index 6, the only route whose `result`
  // is `ending`) and `after-2` (index 10, the array end). Route A is a
  // `return` route and route C is the continuing route: neither of their
  // span ends (4, 8) is an ending, so viewing them leaves the remembered
  // ending untouched.
  const ALL_SEEN = {
    lastShown: 0,
    visited: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    stack: [],
    playedRoutes: [{ decision: 0, routes: [0, 1, 2] }],
  } satisfies MachineContext;

  it("user-flow regression: unseen content still wins — a hire-only run at the end `e`-jumps to the first unseen item, never to the ending", () => {
    // The demo shape: take ONLY the continuing route at the decision
    // (play-all OFF), reach the final item, press `e`. Unseen routes are
    // still open (refuse/early on the demo; A and B here), so `e` lands on
    // the first unseen item in array order — the ending it just showed
    // must not preempt that.
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(2); // the continuing route at 7
    step(m); // 7 -> 8
    step(m); // the route end proceeds to after-1 (9)
    step(m); // 9 -> 10, the content end
    expect(m.getState().cursor).toBe(10);
    m.jumpToUnseen();
    expect(m.getState().cursor).toBe(3); // the first unseen, not the ending
    expect(m.getState().choice).toBeUndefined(); // entering is navigation
    expect(m.exportContext().lastEnding).toBe(10); // the ending was seen last
    m.destroy();
  });

  it("all seen: `e` shows the most recently seen ending; a repeat press stays put", () => {
    const m = machine(CANON, {
      settings: { ...SETTINGS, playAllRoutes: true },
    });
    for (let press = 0; press < 40; press += 1) m.advance();
    expect(m.visitedList().length).toBe(11); // everything has been seen
    // View the ending route's final beat last. Route A's end (4) is a
    // `return` route's item: viewing it must not register an ending.
    m.goTo(6);
    m.goTo(4);
    m.goTo(6);
    m.wheelBack(); // 5; nothing unseen is left anywhere
    m.jumpToUnseen();
    expect(m.getState().cursor).toBe(6); // the most recently seen ending
    m.jumpToUnseen(); // repeat: stay put, no cycle
    expect(m.getState().cursor).toBe(6);
    // Then view the main ending last — it wins from then on.
    m.goTo(10);
    m.wheelBack();
    m.jumpToUnseen();
    expect(m.getState().cursor).toBe(10);
    m.destroy();
  });

  it("the ending is re-shown like any `e` landing: fresh entry, hold armed", () => {
    const m = machine(CANON, { resumeContext: ALL_SEEN });
    expect(m.getState().cursor).toBe(0);
    m.jumpToUnseen(); // no ending known in this ctx: the array end
    expect(m.getState().cursor).toBe(10);
    expect(m.getState().settled).toBe(false); // a fresh entry, like every jump
    expect(m.exportContext().lastEnding).toBe(10); // landing registers it
    m.destroy();
  });

  it("ctx round-trips lastEnding through export and resume", () => {
    const m = machine(CANON, {
      resumeContext: { ...ALL_SEEN, lastEnding: 6 },
    });
    expect(m.exportContext().lastEnding).toBe(6);
    m.jumpToUnseen(); // all seen: straight to the remembered ending
    expect(m.getState().cursor).toBe(6);
    const ctx = m.exportContext();
    expect(ctx.lastEnding).toBe(6);
    const resumed = machine(CANON, { resumeContext: ctx });
    expect(resumed.getState().cursor).toBe(6);
    expect(resumed.exportContext().lastEnding).toBe(6);
    m.destroy();
    resumed.destroy();
  });

  it("a legacy ctx without the field restores, and `e` falls back to the array end only when all seen", () => {
    const m = machine(CANON, { resumeContext: ALL_SEEN });
    expect(m.exportContext().lastEnding).toBeUndefined(); // no known ending
    m.jumpToUnseen(); // all seen: the array end
    expect(m.getState().cursor).toBe(10);
    // With content still unseen the unseen rules win untouched: the same
    // legacy context one item short of complete still jumps to the hole.
    const partial = machine(CANON, {
      resumeContext: { ...ALL_SEEN, visited: [0, 1, 2, 3, 4, 5, 7, 8, 9, 10] },
    });
    partial.jumpToUnseen();
    expect(partial.getState().cursor).toBe(6); // the first unseen, as before
    m.destroy();
    partial.destroy();
  });
});

describe("route-play context for storage", () => {
  it("exportContext reports lastShown, visited, the stack, and route play", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(0); // route A at 3
    expect(m.exportContext()).toEqual({
      lastShown: 3,
      visited: [0, 1, 2, 3],
      stack: [{ decision: 0, route: 0 }],
      playedRoutes: [{ decision: 0, routes: [0] }],
      // Phase 18 shape: completion tracking rides alongside, empty here —
      // A is entered, nothing has been played through to its end.
      completedRoutes: [],
    });
    m.destroy();
  });

  it("a round trip through a plain JSON copy restores the route context", () => {
    const first = machine(CANON);
    step(first);
    step(first);
    first.advance();
    first.choose(0);
    step(first); // 3 -> 4
    const stored = JSON.parse(JSON.stringify(first.exportContext()));
    first.destroy();

    const second = machine(CANON, {
      resumeContext: stored as MachineContext,
    });
    expect(second.getState()).toEqual({
      cursor: 4,
      frontier: 5,
      settled: true, // a resume landing was already read
      skipping: false,
      transition: "nav",
    });
    expect(second.visitedList()).toEqual([0, 1, 2, 3, 4]);
    step(second); // the restored frame still ends the route it is inside
    expect(second.getState().cursor).toBe(4);
    expect(second.getState().choice?.decisionId).toBe("d1");
    // Phase 18: A's completion does not open the return row — the continuing
    // route C has never been played. (The stored ctx is also pre-completion
    // tracking: it round-trips as "nothing completed", the migration read.)
    expect(second.getState().choice?.continueOption).toBeUndefined();
    expect(second.getState().choice?.routes.map((r) => r.seen)).toEqual([
      true,
      false,
      false,
    ]);
    second.destroy();
  });

  it("resuming inside an unplayed route fires no decision", () => {
    const context: MachineContext = {
      lastShown: 5,
      visited: [0, 1, 2, 5],
      stack: [],
      playedRoutes: [],
    };
    const m = machine(CANON, { resumeContext: context });
    expect(m.getState()).toEqual({
      cursor: 5,
      frontier: 6,
      settled: true, // the resume landing, as with a persisted frontier
      skipping: false,
      transition: "nav",
    });
    expect(m.getState().choice).toBeUndefined();
    m.advance(); // the press moves on, and nothing fires on the way
    expect(m.getState().cursor).toBe(6);
    expect(m.getState().choice).toBeUndefined();
    m.destroy();
  });

  it("a resume onto an all-played pure choice's after item flows past the region", () => {
    vi.useFakeTimers();
    const context: MachineContext = {
      lastShown: 1, // the resume lands on `decide`, the after item
      visited: [0, 1, 2, 3, 4, 5],
      stack: [],
      playedRoutes: [{ decision: 0, routes: [0, 1] }],
    };
    const m = machine(PURE, { resumeContext: context });
    expect(m.getState().cursor).toBe(1);
    m.advance(); // forward settle: every route played, so no overlay
    expect(m.getState().cursor).toBe(6); // region end + 1, the tail
    expect(m.getState().choice).toBeUndefined();
    m.destroy();
  });

  it("importContext lands unsettled and replaces the seen set", () => {
    const context: MachineContext = {
      lastShown: 8,
      visited: [0, 1, 2, 7, 8],
      stack: [{ decision: 0, route: 2 }],
      playedRoutes: [{ decision: 0, routes: [2] }],
    };
    const m = machine(CANON);
    m.importContext(context);
    expect(m.getState()).toEqual({
      cursor: 8,
      frontier: 9,
      settled: false, // a restore replays the item, like a bookmark click
      skipping: false,
      transition: "nav",
    });
    expect(m.visitedList()).toEqual([0, 1, 2, 7, 8]);
    step(m); // off route C's end: the imported frame joins at continueAt
    expect(m.getState().cursor).toBe(9);
    m.destroy();
  });

  it("a context made against other content degrades instead of misplacing the cursor", () => {
    const m = machine(CANON);
    m.importContext({
      lastShown: 99,
      visited: [0, 1, 40],
      stack: [{ decision: 7, route: 3 }],
      playedRoutes: [{ decision: 7, routes: [9] }],
    });
    expect(m.getState().cursor).toBe(10); // clamped into this manifest
    expect(m.visitedList()).toEqual([0, 1, 10]); // indices that do not exist dropped
    expect(m.exportContext().stack).toEqual([]); // so does a frame that cannot be
    expect(m.exportContext().playedRoutes).toEqual([]);
    m.destroy();
  });

  it("a resume frontier alone still yields the seen prefix it used to", () => {
    const m = machine(CANON, { resumeFrontier: 4 });
    expect(m.visitedList()).toEqual([0, 1, 2, 3]);
    expect(m.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: true,
      skipping: false,
      transition: "nav",
    });
    m.destroy();
  });
});
