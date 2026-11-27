import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeProgress } from "../render/bookmarks";
import { createContextCodec, resumeOptionsFor } from "../storage/ids";
import { createMemoryStorage } from "../storage/memory";
import { AUTO_PICK_MIN_MS, AUTO_PICK_SHOW_MS, createMachine } from "./machine";
import type {
  Branch,
  Item,
  MachineContext,
  MachineSettings,
  MachineState,
  Manifest,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

// Branch engine tests (docs/plan.md Phase 13, docs/content-format.md
// "Branches"): decision firing, route spans, the nesting stack, route-end
// overlays, play-all-routes, and the visited set that seen tracking now runs
// on. Linear behaviour is guarded by machine.test.ts, which these manifests
// must not change.

// Manual choices: play all routes is on by default (docs/plan.md Phase 24),
// so the baseline turns it off and the play-all tests turn it back on.
const SETTINGS: MachineSettings = { ...DEFAULT_SETTINGS, playAllRoutes: false };

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
    /** The URL start (`index.html#start=<id>`, docs/plan.md Phase 46). */
    startAt?: number;
    settings?: MachineSettings;
    /** Opt into AUTO-forward, for the tests a hold firing on the timer drives. */
    auto?: boolean;
  } = {},
) {
  const m = manifest(shape);
  return createMachine({
    items: m.items,
    branches: m.branches,
    settings: opts.settings ?? SETTINGS,
    resumeFrontier: opts.resumeFrontier,
    resumeContext: opts.resumeContext,
    startAt: opts.startAt,
    // Manual — the player's start and the machine default (Phase 13b):
    // one press is one step, and a press on a decision's after item fires
    // it. Tests a hold firing on the timer drives opt into auto.
    autoAdvance: opts.auto === true,
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
  // A Space press in auto-forward turns auto off (docs/plan.md Phase 18),
  // so an auto test's step presses in manual and turns auto back on.
  const auto = m.isAutoAdvance();
  if (auto) m.setAutoAdvance(false);
  m.advance();
  if (auto) m.setAutoAdvance(true);
}

/**
 * Wheel back until the cursor reaches `index`. The wheel walks the story,
 * choice screens included, so the notch count depends on the path; the
 * tests name the target instead of counting notches. A choice screen over
 * `index` is reached before the item itself.
 */
function wheelBackTo(
  m: { wheelBack(): void; getState(): { cursor: number } },
  index: number,
): void {
  for (let notch = 0; notch < 64 && m.getState().cursor !== index; notch += 1) {
    m.wheelBack();
  }
}

/** Wheel back until `done` holds for the state on screen (64 notches max). */
function wheelBackUntil(
  m: { wheelBack(): void; getState(): MachineState },
  done: (state: MachineState) => boolean,
): void {
  for (let notch = 0; notch < 64 && !done(m.getState()); notch += 1) {
    m.wheelBack();
  }
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
    const m = machine(CANON, { auto: true });
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

  it("navigating onto the after item fires nothing; the forward settle there fires it", () => {
    // A bookmark jump onto `decide` shows the item only: decisions fire on
    // the forward settle of their `after` item, never on navigation.
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires
    m.choose(0); // into route A
    expect(m.getState().cursor).toBe(3);
    const before = m.exportContext();
    m.goTo(2); // a bookmark onto the after item
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().stack).toEqual(before.stack); // nothing consumed
    expect(m.exportContext().playedRoutes).toEqual(before.playedRoutes);
    m.advance(); // auto mode: the press settles it, which fires the decision
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.exportContext().stack).toEqual([]); // the answered frames close
    m.destroy();
  });

  it("every key command but choose, chooseContinue, Tab and the wheel and `e` is inert while a choice is open", () => {
    // The wheel and `e` walk the story (docs/plan.md Phase 27), and Tab
    // arms skip for after the pick (Phase 43) — pinned in their own
    // describes below.
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires
    const before = m.getState();
    m.advance();
    m.advance();
    m.jumpToEnd(); // `decide` IS the furthest point: a no-op
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

describe("the wheel walks the story through decisions (docs/plan.md Phase 27)", () => {
  it("back from a route: its choice screen with the route taken highlighted, then `after`", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires
    m.choose(0); // route A at 3
    const played = m.exportContext().playedRoutes;
    m.wheelBack(); // the choice screen, walked onto
    expect(m.getState()).toMatchObject({ cursor: 2, settled: true });
    expect(m.getState().choice).toEqual({
      decisionId: "d1",
      prompt: "Which road?",
      routes: [
        // the CURRENT seen marks: route A has been played since
        { routeIdx: 0, id: "r-a", label: "Route A", seen: true },
        { routeIdx: 1, id: "r-b", label: "Route B", seen: false },
        { routeIdx: 2, id: "r-c", label: "Route C", seen: false },
      ],
      walkRoute: 0, // going back: the route that had been taken
    });
    expect(m.exportContext().stack).toEqual([]);
    m.wheelBack(); // `decide` itself
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice).toBeUndefined();
    m.wheelForward(); // the choice screen again
    expect(m.getState().choice).toMatchObject({
      decisionId: "d1",
      walkRoute: 0,
    });
    m.wheelForward(); // route A's first item, inside route A again
    expect(m.getState().cursor).toBe(3);
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().stack).toEqual([{ decision: 0, route: 0 }]);
    // Nothing was answered or marked played by any of it.
    expect(m.exportContext().playedRoutes).toEqual(played);
    m.destroy();
  });

  it("Space from a walked-back `after` fires the decision again, live", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires
    m.choose(0); // route A at 3
    step(m); // 3 -> 4
    wheelBackUntil(m, (state) => state.cursor === 2 && !state.choice);
    m.advance(); // settle `decide`: the decision fires, a live choice
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.walkRoute).toBeUndefined();
    m.choose(0);
    expect(m.getState().cursor).toBe(3);
    step(m); // 3 -> 4
    expect(m.getState().cursor).toBe(4);
    m.destroy();
  });

  it("a pick at a walked choice screen is a real pick and becomes the last pick", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires
    m.choose(0); // route A
    step(m); // 3 -> 4
    wheelBackUntil(m, (state) => state.choice !== undefined);
    expect(m.getState()).toMatchObject({ cursor: 2 });
    m.choose(1); // route B
    expect(m.getState().cursor).toBe(5);
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: 0, routes: [0, 1] },
    ]);
    expect(m.exportContext().lastPicks).toEqual([{ decision: 0, route: 1 }]);
    m.wheelForward(); // b-2 was never read: nothing seen ahead
    expect(m.getState().cursor).toBe(5);
    m.wheelBack(); // the choice screen now leads into route B
    expect(m.getState().choice?.walkRoute).toBe(1);
    m.destroy();
  });

  it("a walked choice screen holds timing and is inert to Space, tab and bookmarks", () => {
    vi.useFakeTimers();
    const m = machine(CANON); // auto: holds fire on the timer
    step(m);
    step(m);
    m.advance(); // fires
    m.choose(0); // route A, its 1500 ms hold armed
    m.wheelBack(); // the choice screen
    const shown = m.getState();
    vi.advanceTimersByTime(SETTINGS.minHoldMs * 10);
    m.advance();
    m.toggleSkip();
    m.goTo(0);
    expect(m.getState()).toBe(shown);
    m.destroy();
  });

  it("`e` from before a live choice goes to the furthest item; Space fires it again", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires over `decide`, the furthest item
    m.wheelBack(); // `decide`
    m.wheelBack(); // item 1
    expect(m.getState().cursor).toBe(1);
    m.jumpToEnd();
    const end = m.getState();
    expect(end.cursor).toBe(2);
    expect(end.choice).toBeUndefined();
    m.jumpToEnd();
    expect(m.getState()).toBe(end);
    m.advance();
    expect(m.getState().choice?.decisionId).toBe("d1");
    m.destroy();
  });

  it("a walked choice screen applies the return-row rule as it stands now", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires: no row yet
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.choose(1); // route B, an ending
    step(m);
    step(m); // off B's end: the re-offer, still no row
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.choose(2); // route C, the continuing route
    step(m);
    step(m); // off C's end: joins the aftermath at 9
    expect(m.getState().cursor).toBe(9);
    // Back along the last pick: C's items, then the choice leading into C.
    wheelBackUntil(m, (state) => state.choice !== undefined);
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice).toMatchObject({
      walkRoute: 2,
      continueOption: true,
    });
    m.chooseContinue(); // a real answer: the join
    expect(m.getState().cursor).toBe(9);
    m.destroy();
  });

  it("a pure-choice decision never offers a return, live or walked", () => {
    const m = machine(PURE);
    step(m); // 0 -> 1
    m.advance(); // fires
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.choose(0); // route P
    step(m); // 2 -> 3
    step(m); // P's end: Q unplayed, so the decision re-opens
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.wheelBack(); // P's last item
    expect(m.getState().cursor).toBe(3);
    wheelBackUntil(m, (state) => state.choice !== undefined);
    expect(m.getState().cursor).toBe(1);
    expect(m.getState().choice?.continueOption).toBeUndefined();
    expect(m.getState().choice?.walkRoute).toBe(0);
    m.destroy();
  });

  it("playAllRoutes: a walked choice screen shows the walk's route and waits", () => {
    vi.useFakeTimers();
    const auto = { ...SETTINGS, playAllRoutes: true };
    const m = machine(CANON, { settings: auto });
    step(m);
    step(m); // cursor 2
    m.advance(); // fires: the choice opens, counting down
    const countdown = m.getState().choice?.autoPick?.ms ?? 0;
    vi.advanceTimersByTime(countdown + AUTO_PICK_SHOW_MS); // route A
    expect(m.getState().cursor).toBe(3);
    m.wheelBack(); // the choice screen leading into A
    expect(m.getState().choice).toMatchObject({
      decisionId: "d1",
      walkRoute: 0,
    });
    expect(m.getState().choice?.autoPick).toBeUndefined();
    vi.advanceTimersByTime(60_000); // nothing counts down
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice?.walkRoute).toBe(0);
    m.destroy();
  });
});

describe("choosing a route and ending one", () => {
  it("choose marks the route played and enters its first item fresh", () => {
    vi.useFakeTimers();
    const m = machine(CANON, { auto: true });
    step(m);
    step(m);
    step(m); // fires
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
    m.advance(); // 7 -> 8, its last item
    expect(m.getState().cursor).toBe(8);
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
    wheelBackTo(m, 2); // back to the walked choice screen over `decide`
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.continueOption).toBe(true); // C completed once
    m.choose(0); // route A again from the walked screen
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
    m.advance(); // off P's last item: every route played, the decision CLOSES
    // 3 -> 6 directly: a route-end+1 close would have landed on q-1.
    expect([...new Set(cursors)]).toEqual([6]);
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
  // NAVIGATION does not mark a route: a wheel step onto a choice screen, or
  // a restored position inside a span, marks nothing. `visited` stays the
  // source for ITEM marks (skip, bookmarks, frontier resume); the row mark
  // stays the played set, so these tests fail the moment the row mark
  // starts reading `visited`.
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
    // back to the branch. The walk follows the route taken, and the walked
    // overlay marks only that route.
    const m = manual(CANON);
    m.advance(); // 0 -> 1
    m.advance(); // 1 -> 2 (`decide`)
    m.advance(); // the forward settle fires d1
    m.choose(2); // route C, the continuing route
    m.advance(); // 7 -> 8
    m.advance(); // off C's end: the continuing route proceeds to `after-1`
    expect(m.getState().cursor).toBe(9);
    wheelBackTo(m, 2); // onto the walked choice screen over `decide`
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(seenFlags(m)).toEqual([false, false, true]);
    // The wheel shows only seen screens: route A's items (3, 4) and
    // route B's (5, 6) stay unseen, unrevealed.
    for (const index of [3, 4, 5, 6])
      expect(m.visitedList()).not.toContain(index);
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
    wheelBackTo(m, 1); // 9 -> 1
    expect(m.getState().choice).toBeUndefined();
    m.advance(); // a forward step ONTO the after item arrives quietly
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice).toBeUndefined();
    m.advance(); // its forward settle FIRES the decision
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(seenFlags(m)).toEqual([false, false, true]);
    m.destroy();
  });

  it("firing, viewing and dismissing a decision mark no route", () => {
    const fired = manual(CANON);
    fired.advance(); // 0 -> 1
    fired.advance(); // 1 -> 2
    fired.advance(); // fired: no route has been played, so nothing is marked
    expect(seenFlags(fired)).toEqual([false, false, false]);
    fired.chooseContinue(); // no offer yet, so this answers nothing
    expect(fired.getState().choice?.decisionId).toBe("d1");
    fired.wheelBack(); // the wheel leaves it for the previous screen: no pick
    expect(fired.getState().cursor).toBe(2);
    expect(fired.getState().choice).toBeUndefined();
    expect(fired.exportContext().playedRoutes).toEqual([]);
    // No route past the choice holds seen content: the walk stays here.
    fired.wheelForward();
    expect(fired.getState().cursor).toBe(2);
    expect(fired.getState().choice).toBeUndefined();
    expect(fired.exportContext().playedRoutes).toEqual([]);
    fired.destroy();
  });

  it("wheeling back shows the choice screen, not another route's span; playing it marks it", () => {
    const m = manual(CANON);
    m.advance();
    m.advance();
    m.advance(); // fires d1
    m.choose(2); // route C at 7
    m.wheelBack(); // the choice screen leading into C: B's and A's spans unseen
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.visitedList()).not.toContain(6);
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
    m.goTo(2); // onto `decide`
    m.advance(); // its forward settle fires the decision
    expect(m.getState().choice?.decisionId).toBe("d1");
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
    // of the decision, walked or fired, stays routes-only.
    const m = manual(CANON);
    m.advance(); // 0 -> 1
    m.advance(); // 1 -> 2 (`decide`)
    m.advance(); // fires d1
    m.choose(2); // enter route C (the continuing route) at 7
    expect(m.getState().cursor).toBe(7);
    wheelBackTo(m, 2); // the walked choice screen, abandoning route C
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.continueOption).toBeUndefined(); // entry ≠ completion
    m.wheelBack(); // `decide` before the overlay
    expect(m.getState().choice).toBeUndefined();
    m.advance(); // the press FIRES the decision again
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.destroy();
  });

  it("finish the continuing route once: every later re-offer and walked screen has the row", () => {
    const m = manual(CANON);
    m.advance();
    m.advance();
    m.advance(); // fires d1
    m.choose(2); // route C at 7
    m.advance(); // 7 -> 8
    m.advance(); // C completes: joins the aftermath at 9
    expect(m.getState().cursor).toBe(9);
    wheelBackTo(m, 2); // back to the walked choice screen
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.continueOption).toBe(true); // the rule as it stands now
    m.choose(0); // route A from the walked screen...
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
    // do later views of d2 carry the inner return row. The outer d1 row
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
    // Back to d2's FIRST screen over `a-decide`, past X's re-offer.
    wheelBackUntil(
      m,
      (state) => state.cursor === 3 && state.choice !== undefined,
    );
    expect(m.getState().choice?.decisionId).toBe("d2");
    expect(m.getState().choice?.continueOption).toBe(true); // the late completion opened it
    m.wheelBack(); // leaving the inner screen for `a-decide` itself
    wheelBackUntil(m, (state) => state.choice !== undefined); // d1's screen
    expect(m.getState().cursor).toBe(1); // `decide`
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
    wheelBackTo(resumed, 2); // 9 -> 2
    expect(resumed.getState().choice?.continueOption).toBe(true);
    resumed.destroy();

    // Legacy migration: the same save without the field restores
    // conservatively — the row stays hidden — until the reader finishes the
    // continuing route once in this session.
    const legacy = { ...stored } as MachineContext;
    delete legacy.completedRoutes;
    const old = machine(CANON, { resumeContext: legacy });
    wheelBackTo(old, 2); // 9 -> 2
    expect(old.getState().choice?.continueOption).toBeUndefined();
    old.choose(2); // finish route C once, here...
    step(old); // 7 -> 8
    step(old); // ...its end joins at 9 and unlocks the row
    wheelBackTo(old, 2); // 9 -> 2
    expect(old.getState().choice?.continueOption).toBe(true);
    expect(old.exportContext().completedRoutes).toEqual([
      { decision: 0, routes: [2] },
    ]);
    old.destroy();
  });

  it("0 with no row is a silent no-op", () => {
    // The key path: main.ts takes `0` to `chooseContinue` only when the row
    // is drawn, and the machine's `chooseContinue` is inert with no offer
    // anyway: no move, no state change, no re-emit.
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

// decide | a-decide x-1 y-1 | c-1 | after-1
//  0     | 1        2   3   | 4   | 5
// Route A of `d1` holds the pure choice `d2` (X, Y), whose region runs to
// A's own last item: closing `d2` IS route A ending.
const NESTED_PURE_AT_END: Shape = {
  items: ["decide", "a-decide", "x-1", "y-1", "c-1", "after-1"],
  branches: [
    {
      id: "d1",
      after: "decide",
      prompt: "Outer?",
      routes: [
        {
          id: "r-a",
          label: "Route A",
          start: "a-decide",
          end: "y-1",
          result: "return",
        },
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
        { id: "r-x", label: "Route X", start: "x-1", end: "x-1" },
        { id: "r-y", label: "Route Y", start: "y-1", end: "y-1" },
      ],
    },
  ],
};

describe("a nested pure choice ending its enclosing route", () => {
  it("closing the inner choice re-offers the parent, never entering its continuing route", () => {
    const m = machine(NESTED_PURE_AT_END);
    m.advance(); // d1 fires on `decide`
    m.choose(0); // route A
    m.advance(); // d2 fires on `a-decide`
    m.choose(0); // route X
    m.advance(); // off X's end: Y unplayed, d2 re-opens
    expect(m.getState().choice?.decisionId).toBe("d2");
    m.choose(1); // route Y, ending on A's last item
    expect(m.getState().cursor).toBe(3);
    m.advance(); // d2 closes, and that ends route A: d1 re-opens
    const choice = m.getState().choice;
    expect(choice?.decisionId).toBe("d1");
    expect(choice?.routes.map((r) => r.seen)).toEqual([true, false]);
    expect(choice?.continueOption).toBeUndefined();
    expect(m.getState().cursor).toBe(3);
    expect(m.exportContext().stack).toEqual([]);
    expect(m.exportContext().visited).not.toContain(4);
    m.choose(1); // route C, picked
    expect(m.getState().cursor).toBe(4);
    m.advance(); // C's end joins `after-1`
    expect(m.getState().cursor).toBe(5);
    m.destroy();
  });

  it("playAllRoutes: the parent's continuing route follows its re-offer", () => {
    vi.useFakeTimers();
    const m = machine(NESTED_PURE_AT_END, {
      settings: { ...SETTINGS, playAllRoutes: true },
    });
    for (let press = 0; press < 20; press += 1) m.advance();
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: 0, routes: [0, 1] },
      { decision: 1, routes: [0, 1] },
    ]);
    expect(m.getState().cursor).toBe(5);
    m.destroy();
  });
});

describe("playAllRoutes (docs/plan.md Phase 13)", () => {
  const auto: MachineSettings = { ...SETTINGS, playAllRoutes: true };

  it("plays every route once, the continuing route last", () => {
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
    // Every choice it showed was one it was answering itself.
    const shown = choices.filter(
      (c) => c !== undefined,
    ) as MachineState["choice"][];
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((c) => c?.autoPick !== undefined)).toBe(true);
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
    m.advance(); // firing again: A has never played, so play-all picks it
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(0);
    m.advance(); // Space takes the pick now
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

  it("a decision hanging off a zero-time line stops the burst ON that line", () => {
    // docs/plan.md Phase 18, skip paces by pictures: `lead-2` and `decide`
    // are lines of `lead-1`'s chain, so the burst walks them in zero time —
    // yet the decision on `decide` still fires and the burst stops there.
    vi.useFakeTimers();
    const shape = manifest(CANON);
    const items: Item[] = shape.items.map((item, index) =>
      index === 1 || index === 2
        ? { id: item.id, type: "text", text: `line ${item.id}` }
        : item,
    );
    const m = createMachine({
      items,
      branches: shape.branches,
      settings: { ...SETTINGS, skipAll: true },
    });
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs - 1);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1); // one picture's dwell, then the lines at once
    expect(m.getState()).toMatchObject({ cursor: 2, skipping: false });
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.visitedList()).toEqual([0, 1, 2]);
    m.destroy();
  });

  it("skipAll off: tab on the last seen item does nothing; the reader's own hold fires the decision", () => {
    // docs/plan.md Phase 18: skip never reveals unseen content.
    vi.useFakeTimers();
    const m = machine(CANON, { resumeFrontier: 2 });
    expect(m.getState().cursor).toBe(1);
    const before = m.getState();
    m.toggleSkip(); // item 2 is unseen: nothing to skip through
    expect(m.getState()).toBe(before);
    vi.advanceTimersByTime(SETTINGS.skipDwellMs);
    expect(m.getState().frontier).toBe(2); // item 2 stayed unseen
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

  it("wheel forward clamps at the furthest point read, not at the array end", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(2); // route C
    step(m); // 7 -> 8, the furthest point
    m.wheelBack();
    m.wheelBack(); // 8 -> 7 -> the choice screen over `decide`
    for (let press = 0; press < 6; press += 1) m.wheelForward(); // -> 8 plus clamps
    expect(m.getState().cursor).toBe(8);
    m.wheelForward(); // beyond the ceiling: blocked
    expect(m.getState().cursor).toBe(8);
    m.destroy();
  });

  it("a wheel step back from a route shows the walked choice screen; crossing it consumes nothing", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(0); // inside route A at 3
    m.wheelBack(); // the choice screen over `decide`: shown, unanswered
    expect(m.getState().choice?.decisionId).toBe("d1");
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
    m.wheelBack(); // 7, then the walked choice screen over 2
    m.wheelBack();
    expect(m.getState().cursor).toBe(2);
    expect(m.visitedList()).toEqual(before); // nothing unseen was revealed
    m.wheelForward(); // back onto 7: still seen, still marked
    expect(m.visitedList()).toContain(7);
    m.destroy();
  });

  it("the wheel never enters another route's unseen items, either direction", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(0); // route A at 3..4
    step(m); // 3 -> 4
    m.wheelBack(); // 3
    m.wheelBack(); // the choice screen over 2
    m.wheelBack(); // 2 (`decide`)
    m.wheelForward(); // the choice screen
    m.wheelForward(); // 3
    m.wheelForward(); // 4: A's end
    m.wheelForward(); // A returns, but C (7, 8) and B (5, 6) were never shown
    expect(m.getState().cursor).toBe(4);
    for (const index of [5, 6, 7, 8])
      expect(m.visitedList()).not.toContain(index);
    m.destroy();
  });
});

describe("`e` goes to the furthest point read (docs/plan.md Phase 27)", () => {
  // `e` shows the highest seen item with its enclosing route frames, a
  // no-op there. It never jumps to unseen content or looks up an ending.
  it("from a walked-back point outside a route, `e` returns inside it and reveals nothing", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(0); // route A at 3, span 3..4
    m.wheelBack(); // the choice screen
    m.wheelBack(); // `decide`: outside the span
    expect(m.getState().cursor).toBe(2);
    expect(m.exportContext().stack).toEqual([]);
    m.jumpToEnd();
    expect(m.getState().cursor).toBe(3);
    expect(m.exportContext().stack).toEqual([{ decision: 0, route: 0 }]);
    m.jumpToEnd(); // at the end: route A's next item stays unseen
    expect(m.getState().cursor).toBe(3);
    expect(m.visitedList()).not.toContain(4);
    m.destroy();
  });

  it("at the end of a fully seen span, unplayed routes are not jumped to", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(2); // route C at 7, span 7..8
    step(m); // 7 -> 8: the span is fully seen, A and B unplayed
    const before = m.getState();
    m.jumpToEnd();
    expect(m.getState()).toBe(before);
    m.destroy();
  });

  it("at the content end with routes unseen, `e` stays put; the hint shows", () => {
    // The demo shape: take ONLY the continuing route (play-all OFF) and
    // reach the final item. `e` used to jump to the first unseen item; it
    // now stays, and the ending hint says some content is unseen.
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(2); // the continuing route at 7
    step(m); // 7 -> 8
    step(m); // the route end proceeds to after-1 (9)
    step(m); // 9 -> 10, the content end
    expect(m.getState().cursor).toBe(10);
    expect(m.getState().endCard?.unseenRoutes).toBe(2);
    const before = m.getState();
    m.jumpToEnd();
    expect(m.getState()).toBe(before);
    m.destroy();
  });

  it("with nothing unseen left the jump is a no-op", () => {
    const m = machine(CANON, {
      settings: { ...SETTINGS, playAllRoutes: true },
    });
    for (let press = 0; press < 40; press += 1) m.advance();
    const before = m.getState();
    m.jumpToEnd();
    expect(m.getState()).toBe(before);
    m.destroy();
  });

  it("an `e` landing is a fresh entry, not a settled landing", () => {
    vi.useFakeTimers();
    const m = machine(CANON, { auto: true });
    step(m); // 0 -> 1: the furthest point
    m.wheelBack(); // walk back to 0
    m.jumpToEnd(); // a fresh entry on 1
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

  it("an all-seen save landing at the start: `e` goes to the highest seen item, no ending lookup", () => {
    const allSeen = {
      lastShown: 0,
      visited: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      stack: [],
      playedRoutes: [{ decision: 0, routes: [0, 1, 2] }],
      // A pre-history save's remembered ending: ignored, and not exported.
      lastEnding: 6,
    } as MachineContext;
    const m = machine(CANON, { resumeContext: allSeen });
    expect(m.getState().cursor).toBe(0);
    m.jumpToEnd();
    expect(m.getState().cursor).toBe(10);
    expect(m.exportContext().stack).toEqual([]);
    expect(m.exportContext()).not.toHaveProperty("lastEnding");
    m.destroy();
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
      // Played this pass (docs/plan.md Phase 22): the flow's record.
      passRoutes: [{ decision: 0, routes: [0] }],
      // The last pick at each decision (docs/plan.md Phase 27).
      lastPicks: [{ decision: 0, route: 0 }],
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

describe("the timeline persists (docs/plan.md Phase 27)", () => {
  /** Read CANON into route A's last item: 0, 1, 2, the choice, 3, 4. */
  const readIntoRouteA = (m: ReturnType<typeof machine>) => {
    step(m);
    step(m);
    m.advance(); // fires
    m.choose(0);
    step(m); // 3 -> 4
  };

  it("a JSON round trip keeps the position and last picks; the wheel walks on across it", () => {
    const first = machine(CANON);
    readIntoRouteA(first);
    first.wheelBack(); // walk back to 3 before saving
    const stored = JSON.parse(JSON.stringify(first.exportContext()));
    first.destroy();

    const second = machine(CANON, { resumeContext: stored as MachineContext });
    expect(second.getState()).toEqual({
      cursor: 3,
      frontier: 5,
      settled: true, // a resume landing was already read
      skipping: false,
      transition: "nav",
    });
    expect(second.exportContext().stack).toEqual([{ decision: 0, route: 0 }]);
    expect(second.exportContext().lastPicks).toEqual([
      { decision: 0, route: 0 },
    ]);
    second.wheelBack(); // the choice screen, across the reload
    expect(second.getState().choice).toMatchObject({
      decisionId: "d1",
      walkRoute: 0,
    });
    second.jumpToEnd(); // the furthest point read
    expect(second.getState().cursor).toBe(4);
    second.destroy();
  });

  it("a save on a choice screen resumes showing it, timing held until the pick", () => {
    vi.useFakeTimers();
    const first = machine(CANON);
    step(first);
    step(first);
    first.advance(); // fires
    const stored = first.exportContext();
    expect(stored.choice).toBe(0);
    first.destroy();
    const second = machine(CANON, { resumeContext: stored }); // auto mode
    expect(second.getState()).toMatchObject({ cursor: 2, settled: true });
    expect(second.getState().choice?.decisionId).toBe("d1");
    vi.advanceTimersByTime(SETTINGS.minHoldMs * 10);
    expect(second.getState().choice?.decisionId).toBe("d1");
    second.choose(1);
    expect(second.getState().cursor).toBe(5);
    second.destroy();
  });

  it("a save on a re-offer resumes it over the route's last item; the wheel goes back into the route", () => {
    const first = machine(CANON);
    step(first);
    step(first);
    first.advance(); // fires
    first.choose(1); // route B
    step(first);
    step(first); // off B's end: the re-offer over b-2
    const stored = JSON.parse(JSON.stringify(first.exportContext()));
    first.destroy();
    const second = machine(CANON, { resumeContext: stored as MachineContext });
    expect(second.getState()).toMatchObject({ cursor: 6, settled: true });
    expect(second.getState().choice?.decisionId).toBe("d1");
    expect(second.exportContext().stack).toEqual([]);
    second.wheelBack(); // b-2, inside route B
    expect(second.getState().cursor).toBe(6);
    expect(second.getState().choice).toBeUndefined();
    expect(second.exportContext().stack).toEqual([{ decision: 0, route: 1 }]);
    second.destroy();
  });

  it("a save on a choice screen the wheel walked back onto resumes showing it, waiting for a pick", () => {
    const first = machine(CANON);
    step(first);
    step(first);
    first.advance(); // fires
    first.choose(0); // route A, at a-1
    first.wheelBack(); // back onto the choice screen
    expect(first.getState().choice).toMatchObject({
      decisionId: "d1",
      walkRoute: 0,
    });
    // The place a save writes records the open choice.
    expect(first.exportPlace().choice).toBe(0);
    const stored = JSON.parse(JSON.stringify(first.exportContext()));
    first.destroy();
    const second = machine(CANON, { resumeContext: stored as MachineContext });
    expect(second.getState()).toMatchObject({ cursor: 2, settled: true });
    expect(second.getState().choice?.decisionId).toBe("d1");
    second.advance(); // Space leaves it open
    expect(second.getState().choice?.decisionId).toBe("d1");
    second.choose(1); // a digit picks
    expect(second.getState().cursor).toBe(5);
    second.destroy();
  });

  it("a choice closed by a second notch back stays closed across a reload", () => {
    const first = machine(CANON);
    step(first);
    step(first);
    first.advance(); // fires
    first.choose(0); // route A, at a-1
    first.wheelBack(); // the choice screen
    first.wheelBack(); // `decide` under it: the choice closed
    expect(first.getState()).toMatchObject({ cursor: 2 });
    expect(first.getState().choice).toBeUndefined();
    expect(first.exportPlace().choice).toBeUndefined();
    const stored = JSON.parse(JSON.stringify(first.exportContext()));
    first.destroy();
    const second = machine(CANON, { resumeContext: stored as MachineContext });
    expect(second.getState().cursor).toBe(2);
    expect(second.getState().choice).toBeUndefined();
    second.destroy();
  });

  it("a save without last picks lands on its position; the walk takes the longest seen route", () => {
    const m = machine(CANON, {
      resumeContext: {
        lastShown: 8,
        visited: [0, 1, 2, 3, 4, 7, 8],
        stack: [{ decision: 0, route: 2 }],
        playedRoutes: [{ decision: 0, routes: [0, 2] }],
      },
    });
    expect(m.getState().cursor).toBe(8);
    m.wheelBack();
    m.wheelBack();
    expect(m.getState().choice).toMatchObject({ walkRoute: 2 });
    m.wheelBack();
    expect(m.getState()).toMatchObject({ cursor: 2 });
    m.wheelForward(); // no pick known: A and C are both 2 items, A first
    expect(m.getState().choice?.walkRoute).toBe(0);
    m.destroy();
  });

  it("foreign last picks and a foreign choice are dropped", () => {
    const m = machine(CANON, {
      resumeContext: {
        lastShown: 4,
        visited: [0, 1, 2, 3, 4],
        stack: [{ decision: 0, route: 0 }],
        playedRoutes: [{ decision: 0, routes: [0] }],
        lastPicks: [
          { decision: 7, route: 0 },
          { decision: 0, route: 9 },
        ],
        choice: 5,
      },
    });
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().lastPicks).toEqual([]);
    m.destroy();
  });

  it("a bookmark restore keeps the reader's last picks, the bookmark's filling the rest", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires
    m.choose(0); // A
    const mark = m.exportContext(); // last pick A
    step(m);
    step(m); // off A's end: the re-offer
    m.choose(2); // C: the reader's last pick now
    m.importContext(mergeProgress(mark, m.exportContext()));
    expect(m.getState().cursor).toBe(3);
    expect(m.exportContext().lastPicks).toEqual([{ decision: 0, route: 2 }]);
    m.destroy();
  });
});

describe("walking back shows each choice screen on the path (docs/plan.md Phase 27)", () => {
  // The wheel walks the story along the last picks: every decision on the
  // path shows its choice screen as a waypoint (nested ones included), with
  // the current seen marks and return-row rule and the walk's route
  // highlighted — and answers nothing: a wheel step is browsing.
  const manual = (shape: Shape) => {
    const m = manifest(shape);
    return createMachine({
      items: m.items,
      branches: m.branches,
      settings: SETTINGS,
    }); // manual: one press = one step, the player's own navigation
  };
  const view = (m: ReturnType<typeof manual>) => {
    const choice = m.getState().choice;
    return {
      cursor: m.getState().cursor,
      id: choice?.decisionId,
      seen: choice?.routes.map((r) => r.seen),
      returns: choice?.continueOption === true,
      walk: choice?.walkRoute,
      stack: m.exportContext().stack,
    };
  };
  /** Wheel back as far as it goes, collecting every choice screen. */
  const choiceScreensBack = (m: ReturnType<typeof manual>) => {
    const opened: unknown[] = [];
    for (let notch = 0; notch < 64; notch += 1) {
      const before = m.getState();
      m.wheelBack();
      if (m.getState() === before) break;
      if (m.getState().choice !== undefined) opened.push(view(m));
    }
    return opened;
  };

  it("a completed outer decision's screen shows with seen marks and the return row", () => {
    const m = manual(CANON);
    m.advance(); // 0 -> 1
    m.advance(); // 1 -> 2 (`decide`)
    m.advance(); // the forward settle fires d1
    m.choose(2); // route C, the continuing route: 7..8
    m.advance(); // 7 -> 8
    m.advance(); // C completes and joins at `after-1`, 9
    expect(m.getState().cursor).toBe(9);
    m.wheelBack(); // 9 -> 8
    m.wheelBack(); // 8 -> 7, no screen yet
    expect(view(m).id).toBeUndefined();
    m.wheelBack(); // the choice screen over `decide`, leading into C
    expect(view(m)).toEqual({
      cursor: 2,
      id: "d1",
      seen: [false, false, true],
      returns: true, // C completed once: the row is offered here too
      walk: 2,
      stack: [],
    });
    m.wheelBack(); // stepping away consumes nothing
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: 0, routes: [2] },
    ]);
    m.destroy();
  });

  it("nested: the walk follows the last picks through both levels", () => {
    const m = manual(NESTED);
    m.advance();
    m.advance(); // 0 -> 1 (`decide`)
    m.advance(); // fires d1
    m.choose(0); // route A: 2..9
    m.advance(); // 2 -> 3 (`a-decide`)
    m.advance(); // fires d2
    m.choose(0); // route X: 4..5, an ending
    m.advance(); // 4 -> 5
    m.advance(); // X's end re-opens d2
    m.choose(1); // route Y: 6..7, the last pick at d2
    m.advance(); // 6 -> 7
    m.advance(); // Y completes and rejoins A at `a-cont`, 8
    m.advance(); // 8 -> 9
    m.advance(); // A's end re-opens d1 (live)
    expect(m.getState()).toMatchObject({ cursor: 9 });
    const outer = { seen: [true, false, false], returns: false, stack: [] };
    const inner = {
      seen: [true, true],
      returns: true, // Y, the inner continuing route, completed
      stack: [{ decision: 0, route: 0 }], // inside route A
    };
    expect(choiceScreensBack(m)).toEqual([
      { cursor: 3, id: "d2", walk: 1, ...inner }, // into Y, not X
      { cursor: 1, id: "d1", walk: 0, ...outer }, // into A
    ]);
    expect(m.getState().cursor).toBe(0);
    // And forward again along the same path, through both choice screens,
    // ending at A's last item: C, past A's re-offer, was never read.
    const path: string[] = [];
    for (let notch = 0; notch < 64; notch += 1) {
      const before = m.getState();
      m.wheelForward();
      if (m.getState() === before) break;
      const choice = m.getState().choice;
      path.push(
        choice === undefined
          ? String(m.getState().cursor)
          : `${choice.decisionId}>${String(choice.walkRoute)}`,
      );
    }
    expect(path).toEqual(["1", "d1>0", "2", "3", "d2>1", "6", "7", "8", "9"]);
    m.destroy();
  });

  it("an all-played pure choice that CLOSED: back from past its region by the last pick", () => {
    const m = manual(PURE);
    m.advance(); // 0 -> 1 (`decide`)
    m.advance(); // fires d1
    m.choose(1); // route Q: 4..5
    m.advance(); // 4 -> 5
    m.advance(); // Q's end re-opens d1: P is unplayed
    m.choose(0); // route P: 2..3, the last pick
    m.advance(); // 2 -> 3
    m.advance(); // P's end, all routes played: the decision CLOSES past the region
    expect(m.getState().cursor).toBe(6);
    expect(m.getState().choice).toBeUndefined();
    const closed = { id: "d1", seen: [true, true], returns: false, stack: [] };
    expect(choiceScreensBack(m)).toEqual([
      { cursor: 3, walk: undefined, ...closed }, // after P, on past the region
      { cursor: 1, walk: 0, ...closed }, // into P
    ]);
    m.destroy();
  });

  it("a pick from a walked completed screen enters the route exactly like a re-selection", () => {
    const m = manual(PURE);
    m.advance(); // 0 -> 1 (`decide`)
    m.advance(); // its forward settle fires d1
    m.choose(1); // route Q: 4..5
    m.advance(); // 4 -> 5
    m.advance(); // Q's end: re-opens with P unplayed
    m.choose(0); // route P: 2..3
    m.advance(); // 2 -> 3
    m.advance(); // P's end closes the decision past the region, 6
    wheelBackUntil(
      m,
      (state) => state.cursor === 1 && state.choice !== undefined,
    );
    m.choose(1); // route Q again from the walked first screen
    expect(m.getState().cursor).toBe(4); // Q's first item, entered
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().stack).toEqual([{ decision: 0, route: 1 }]);
    m.destroy();
  });

  it("playAllRoutes: a walked choice screen resolves nothing", () => {
    // Play-all answers only decisions that FIRE, never a walked screen.
    const m = manual(CANON);
    m.advance();
    m.advance();
    m.advance(); // fires d1
    m.choose(2); // route C, the continuing route
    m.advance(); // 7 -> 8
    m.advance(); // joins at `after-1`, 9
    m.setSettings({ ...SETTINGS, playAllRoutes: true });
    wheelBackTo(m, 2); // the walked screen over `decide`
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.exportContext()).toMatchObject({
      playedRoutes: [{ decision: 0, routes: [2] }],
      stack: [],
    });
    m.wheelBack(); // `decide` itself: nothing auto-resolved
    expect(m.getState()).toMatchObject({ cursor: 2 });
    expect(m.getState().choice).toBeUndefined();
    m.destroy();
  });
});

describe("the wheel leaves any choice screen for the neighbouring screen", () => {
  // User report (Phase 18): scroll wheel back did nothing on a fired choice
  // and on a route-end re-offer. Only keys choose; a wheel notch walks on
  // (docs/plan.md Phase 27), answering nothing.
  const manual = (shape: Shape) => {
    const m = manifest(shape);
    return createMachine({
      items: m.items,
      branches: m.branches,
      settings: SETTINGS,
    });
  };

  it("a fired choice: a wheel back shows `decide`; nothing read past it, forward stays", () => {
    const m = manual(CANON);
    m.advance(); // 0 -> 1
    m.advance(); // 1 -> 2 (`decide`)
    m.advance(); // fires d1
    m.wheelBack();
    expect(m.getState().cursor).toBe(2); // `decide` without the overlay
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().playedRoutes).toEqual([]);
    m.wheelForward(); // no route holds seen content: nowhere to walk
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice).toBeUndefined();
    m.advance(); // reading on fires it again
    expect(m.getState().choice?.decisionId).toBe("d1");
    m.destroy();
  });

  it("a fired choice at the furthest point: a wheel forward is blocked and it stays", () => {
    const m = manual(CANON);
    m.advance();
    m.advance();
    m.advance(); // fires d1: the last entry
    const before = m.getState();
    m.wheelForward();
    expect(m.getState()).toBe(before);
    m.choose(1); // still answerable
    expect(m.getState().cursor).toBe(5);
    m.destroy();
  });

  it("a route-end re-offer: a wheel back puts the reader back inside the route", () => {
    const m = manual(CANON);
    m.advance();
    m.advance();
    m.advance(); // fires d1
    m.choose(0); // route A: 3..4
    m.advance(); // 3 -> 4
    m.advance(); // off A's end: the re-offer
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.exportContext().stack).toEqual([]);
    m.wheelBack(); // A's last item, inside route A again
    expect(m.getState().cursor).toBe(4);
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().stack).toEqual([{ decision: 0, route: 0 }]);
    m.wheelForward(); // A returns: its choice screen, on to C (unread)…
    expect(m.getState()).toMatchObject({ cursor: 4 });
    expect(m.getState().choice).toBeUndefined(); // …so the walk stays
    m.advance(); // reading on: A's end re-offers again
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().cursor).toBe(4);
    m.destroy();
  });
});

describe("skip never reveals across a route end (docs/plan.md Phase 18, bullet 5)", () => {
  it("a continuing route's end with an unseen join: the burst stops on the route's last item and tab stays inert", () => {
    vi.useFakeTimers();
    const shape = manifest(CANON);
    const m = createMachine({
      items: shape.items,
      branches: shape.branches,
      settings: SETTINGS,
    });
    m.advance();
    m.advance();
    m.advance(); // fires d1
    m.choose(2); // route C, the continuing route: 7..8, joins at 9 (unseen)
    m.advance(); // 7 -> 8
    m.wheelBack(); // 8 -> 7
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs);
    expect(m.getState()).toMatchObject({ cursor: 8, skipping: false });
    const before = m.getState();
    m.toggleSkip(); // the only step from here would join at the unseen 9
    expect(m.getState()).toBe(before);
    expect(m.visitedList()).not.toContain(9);
    m.destroy();
  });
});

describe("the end card (docs/plan.md Phase 18, End card)", () => {
  const manual = (shape: Shape) => {
    const m = manifest(shape);
    return createMachine({
      items: m.items,
      branches: m.branches,
      settings: SETTINGS,
    });
  };

  it("shows the unseen counts on an ending, hides under a choice, and says all seen at the end", () => {
    const m = manual(PURE);
    m.advance(); // 0 -> 1
    m.advance(); // fires d1
    m.choose(1); // route Q: 4..5, an ending route
    expect(m.getState().endCard).toBeUndefined(); // not an ending item
    m.advance(); // 4 -> 5: Q's last item, an ending
    // P unplayed; the tail is main-line content behind the decision.
    expect(m.getState().endCard).toEqual({
      unseenRoutes: 1,
      otherUnseen: true,
      nextUnseen: true,
    });
    m.advance(); // the re-offer opens: the overlay owns the screen
    expect(m.getState().choice).toBeDefined();
    expect(m.getState().endCard).toBeUndefined();
    m.choose(0); // route P: 2..3
    m.advance(); // 2 -> 3: P's end, also an ending; the tail is unseen
    expect(m.getState().endCard).toEqual({
      unseenRoutes: 0,
      otherUnseen: true,
      nextUnseen: true,
    });
    m.advance(); // all routes played: closes past the region, onto 6
    m.advance(); // 6 -> 7, the array end: now everything has been seen
    expect(m.getState().cursor).toBe(7);
    expect(m.getState().endCard).toEqual({
      unseenRoutes: 0,
      otherUnseen: false,
      nextUnseen: false,
    });
    m.destroy();
  });

  it("the array end with unplayed routes behind it counts them", () => {
    const m = manual(CANON);
    m.advance();
    m.advance();
    m.advance(); // fires d1
    m.choose(2); // route C, continuing: joins at 9
    m.advance(); // 7 -> 8
    m.advance(); // joins at 9
    m.advance(); // 9 -> 10, the array end; A and B are unseen
    expect(m.getState().cursor).toBe(10);
    expect(m.getState().endCard).toEqual({
      unseenRoutes: 2,
      otherUnseen: false,
      nextUnseen: true,
    });
    m.destroy();
  });
});

describe("play all routes shows the choice and picks on screen (docs/plan.md Phase 18)", () => {
  const ALL: MachineSettings = { ...SETTINGS, playAllRoutes: true };
  const playAll = (shape: Shape, settings: MachineSettings = ALL) => {
    const m = manifest(shape);
    return createMachine({ items: m.items, branches: m.branches, settings });
  }; // manual presses: each step is explicit
  // Every word on the screen at 60 ms/char, plus 1.5 s + 1 s per row to
  // take the choice in (docs/plan.md Phase 20), written out longhand.
  const countdown = (screen: string, rows: number) =>
    Math.max(
      AUTO_PICK_MIN_MS,
      [...screen].length * SETTINGS.msPerChar + 1500 + 1000 * rows,
    );
  const FIRST =
    "Which road? Play all routes picks in 0 s Route A Route B Route C";

  it("a fired decision counts down, highlights the pick, then enters it", () => {
    vi.useFakeTimers();
    const m = playAll(CANON);
    m.advance(); // 0 -> 1
    m.advance(); // 1 -> 2 (`decide`)
    m.advance(); // fires: the choice opens with the auto-pick counting down
    const ms = countdown(FIRST, 3);
    expect(ms).toBe(64 * 60 + 4500); // 8340 ms, not the old 2500 floor
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice?.autoPick).toMatchObject({
      routeIdx: 0,
      picked: false,
      ms,
    });
    expect(m.getState().choice?.autoPick?.backFromLabel).toBeUndefined();
    vi.advanceTimersByTime(ms - 1);
    expect(m.getState().choice?.autoPick?.picked).toBe(false);
    vi.advanceTimersByTime(1); // the pick is shown before the route starts
    expect(m.getState().choice?.autoPick).toMatchObject({
      routeIdx: 0,
      picked: true,
      ms: AUTO_PICK_SHOW_MS,
    });
    vi.advanceTimersByTime(AUTO_PICK_SHOW_MS);
    expect(m.getState().choice).toBeUndefined();
    expect(m.getState().cursor).toBe(3);
    expect(m.exportContext().stack).toEqual([{ decision: 0, route: 0 }]);
    m.destroy();
  });

  it("the countdown is the screen's reading and comprehension time at the reader's speed", () => {
    vi.useFakeTimers();
    const long: Shape = {
      ...CANON,
      branches: [
        {
          ...CANON.branches[0],
          prompt:
            "A much longer question that takes real time to read before anything is picked?",
        },
      ],
    };
    const m = playAll(long, { ...ALL, readingSpeed: 0.5 });
    m.advance();
    m.advance();
    m.advance();
    const b = long.branches[0];
    const screen = `${b.prompt} Play all routes picks in 0 s Route A Route B Route C`;
    expect(m.getState().choice?.autoPick?.ms).toBe(
      ([...screen].length * SETTINGS.msPerChar + 1500 + 3000) / 0.5,
    );
    m.destroy();
  });

  it("a route end re-offers the choice saying which route just ended", () => {
    vi.useFakeTimers();
    const m = playAll(CANON);
    for (let press = 0; press < 3; press += 1) m.advance(); // the choice
    m.advance(); // Space takes the pick now: route A at 3
    expect(m.getState().cursor).toBe(3);
    m.advance(); // 3 -> 4
    m.advance(); // off A's end: the re-offer
    const choice = m.getState().choice;
    expect(m.getState().cursor).toBe(4);
    expect(choice?.routes.map((r) => r.seen)).toEqual([true, false, false]);
    expect(choice?.autoPick).toMatchObject({
      routeIdx: 1,
      picked: false,
      backFromLabel: "Route A",
      ms: countdown(
        "Which road? Back in time: “Route A” is done. Play all routes picks in 0 s" +
          " Route A seen Route B Route C",
        3,
      ),
    });
    m.destroy();
  });

  it("the countdown counts the seen markers and the return row", () => {
    vi.useFakeTimers();
    const m = machine(CANON);
    for (let press = 0; press < 3; press += 1) m.advance(); // the choice
    m.choose(2); // route C, the continuing route
    m.advance(); // 7 -> 8
    m.advance(); // C completes: joins at 9, the return row unlocks
    for (let n = 0; n < 20 && m.getState().cursor !== 2; n += 1) m.wheelBack();
    m.choose(0); // route A from the walked screen
    m.advance(); // 3 -> 4
    m.advance(); // A's end: the live re-offer, with the return row
    expect(m.getState().choice?.continueOption).toBe(true);
    m.setSettings(ALL); // play-all takes over the live choice
    expect(m.getState().choice?.autoPick).toMatchObject({ routeIdx: 1 });
    expect(m.getState().choice?.autoPick?.ms).toBe(
      countdown(
        "Which road? Play all routes picks in 0 s" +
          " Route A seen Route B Route C seen Return to main route",
        4,
      ),
    );
    m.destroy();
  });

  it("picks the shortest unplayed route first, the continuing route last", () => {
    vi.useFakeTimers();
    // decide | l-1 l-2 l-3 | s-1 | m-1 m-2 | c-1 | after-1
    const shape: Shape = {
      items: [
        "decide",
        "l-1",
        "l-2",
        "l-3",
        "s-1",
        "m-1",
        "m-2",
        "c-1",
        "after-1",
      ],
      branches: [
        {
          id: "d1",
          after: "decide",
          prompt: "Which?",
          routes: [
            {
              id: "long",
              label: "Long",
              start: "l-1",
              end: "l-3",
              result: "return",
            },
            {
              id: "short",
              label: "Short",
              start: "s-1",
              end: "s-1",
              result: "return",
            },
            {
              id: "mid",
              label: "Mid",
              start: "m-1",
              end: "m-2",
              result: "return",
            },
            { id: "cont", label: "Cont", start: "c-1", end: "c-1" },
          ],
          continuingRoute: "cont",
          continueAt: "after-1",
        },
      ],
    };
    const m = playAll(shape);
    const picks: number[] = [];
    m.subscribe((state) => {
      const pick = state.choice?.autoPick;
      if (
        pick !== undefined &&
        !pick.picked &&
        picks[picks.length - 1] !== pick.routeIdx
      )
        picks.push(pick.routeIdx);
    });
    for (let press = 0; press < 30; press += 1) m.advance();
    expect(picks).toEqual([1, 2, 0, 3]);
    expect(m.getState().cursor).toBe(8);
    m.destroy();
  });

  it("a digit picks another route; pause freezes the countdown and resume restarts it", () => {
    vi.useFakeTimers();
    const m = playAll(CANON);
    for (let press = 0; press < 3; press += 1) m.advance(); // the choice
    const first = m.getState().choice?.autoPick?.armId;
    m.pause();
    vi.advanceTimersByTime(60_000);
    expect(m.getState().choice?.autoPick?.picked).toBe(false); // frozen
    m.resume();
    expect(m.getState().choice?.autoPick?.armId).not.toBe(first); // fresh
    m.choose(2); // the reader's own pick wins
    expect(m.getState().cursor).toBe(7);
    vi.advanceTimersByTime(60_000); // the cancelled auto-pick fires nothing
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: 0, routes: [2] },
    ]);
    m.destroy();
  });

  it("the wheel leaves the countdown; nothing picks behind it", () => {
    vi.useFakeTimers();
    const m = playAll(CANON);
    for (let press = 0; press < 3; press += 1) m.advance(); // the choice
    m.wheelBack(); // to `decide`
    expect(m.getState().choice).toBeUndefined();
    m.wheelForward(); // no route read yet: the walk stays on `decide`
    expect(m.getState().choice).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect(m.getState().cursor).toBe(2);
    expect(m.exportContext().playedRoutes).toEqual([]);
    m.destroy();
  });

  it("turning play-all off mid-countdown leaves the choice waiting", () => {
    vi.useFakeTimers();
    const m = playAll(CANON);
    for (let press = 0; press < 3; press += 1) m.advance();
    m.setSettings(SETTINGS);
    expect(m.getState().choice?.autoPick).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect(m.getState().choice?.decisionId).toBe("d1");
    m.destroy();
  });

  it("a reload landing on the live choice counts down again", () => {
    vi.useFakeTimers();
    const first = playAll(CANON);
    for (let press = 0; press < 3; press += 1) first.advance(); // the choice
    const stored = first.exportContext();
    first.destroy();
    const m = machine(CANON, { resumeContext: stored, settings: ALL });
    expect(m.getState().choice?.autoPick).toMatchObject({
      routeIdx: 0,
      picked: false,
    });
    vi.advanceTimersByTime(60_000);
    expect(m.getState().cursor).toBe(3); // route A entered, no press
    m.destroy();
  });

  it("a reload on a walked choice screen shows the choice and counts down again", () => {
    vi.useFakeTimers();
    const first = playAll(CANON);
    for (let press = 0; press < 3; press += 1) first.advance();
    vi.advanceTimersByTime(60_000); // route A entered
    first.wheelBack(); // the walked choice screen
    expect(first.getState().choice?.walkRoute).toBe(0);
    expect(first.getState().choice?.autoPick).toBeUndefined(); // browsing
    const stored = first.exportContext();
    expect(stored.choice).toBe(0);
    first.destroy();
    const m = machine(CANON, { resumeContext: stored, settings: ALL });
    expect(m.getState()).toMatchObject({ cursor: 2, settled: true });
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.autoPick).toMatchObject({ picked: false });
    vi.advanceTimersByTime(60_000);
    expect(m.getState().cursor).toBe(3); // the countdown picked route A
    m.destroy();
  });

  it("a reload on a route end's re-offer shows the choice and counts down again", () => {
    vi.useFakeTimers();
    const first = playAll(CANON);
    for (let press = 0; press < 3; press += 1) first.advance();
    vi.advanceTimersByTime(60_000); // route A entered, at a-1
    first.advance(); // a-2
    first.advance(); // off A's end: the re-offer over a-2
    expect(first.getState()).toMatchObject({ cursor: 4 });
    expect(first.getState().choice?.autoPick).toBeDefined();
    const stored = first.exportContext();
    expect(stored.choice).toBe(0);
    first.destroy();
    const m = machine(CANON, { resumeContext: stored, settings: ALL });
    expect(m.getState().cursor).toBe(4);
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.autoPick).toMatchObject({ picked: false });
    vi.advanceTimersByTime(60_000);
    expect(m.getState().choice).toBeUndefined(); // the countdown picked
    m.destroy();
  });

  it("the continuing route's end joins with no choice", () => {
    vi.useFakeTimers();
    const m = playAll(CANON);
    for (let press = 0; press < 20 && m.getState().cursor !== 9; press += 1)
      m.advance();
    expect(m.getState().cursor).toBe(9);
    expect(m.getState().choice).toBeUndefined();
    m.destroy();
  });

  it("no end card on a route ending play-all carries on from", () => {
    vi.useFakeTimers();
    const m = playAll(PURE);
    m.advance(); // 0 -> 1
    m.advance(); // fires
    m.advance(); // Space: route P at 2
    m.advance(); // 2 -> 3, P's last item: an ending
    expect(m.getState().cursor).toBe(3);
    expect(m.getState().endCard).toBeUndefined();
    m.advance(); // the re-offer before Q
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(1);
    expect(m.getState().endCard).toBeUndefined();
    m.destroy();
  });

  it("skip-all: no countdown, only the highlight, and the burst carries on", () => {
    vi.useFakeTimers();
    const make = () => playAll(CANON, { ...ALL, skipAll: true });
    const run = (m: ReturnType<typeof make>) => {
      m.toggleSkip();
      for (let n = 0; n < 40 && m.getState().choice === undefined; n += 1)
        vi.advanceTimersByTime(SETTINGS.skipDwellMs);
      expect(m.getState().choice?.autoPick).toMatchObject({
        picked: true,
        ms: AUTO_PICK_SHOW_MS,
      });
    };
    const elapsed = make();
    run(elapsed);
    vi.advanceTimersByTime(AUTO_PICK_SHOW_MS);
    expect(elapsed.getState().skipping).toBe(true); // the burst carries on
    elapsed.destroy();
    const pressed = make();
    run(pressed);
    pressed.advance(); // the reader's press takes the pick and stops there
    expect(pressed.getState().skipping).toBe(false);
    expect(pressed.getState().cursor).toBe(3);
    pressed.destroy();
  });
});

describe("`u` reaches the next unseen content (docs/plan.md Phase 18)", () => {
  /** Press until the cursor reaches `index` (manual, one item per press). */
  const pressTo = (m: ReturnType<typeof machine>, index: number) => {
    for (let n = 0; n < 40 && m.getState().cursor !== index; n += 1) {
      m.advance();
    }
  };

  it("from an ending route's end, lands in the next unplayed route as if picked", () => {
    const m = machine(CANON);
    pressTo(m, 2);
    m.advance(); // fires d1
    m.choose(1); // route B: 5..6, an ending
    m.advance(); // 5 -> 6: B's end
    expect(m.getState().endCard).toEqual({
      unseenRoutes: 2, // A and C
      otherUnseen: true, // the aftermath
      nextUnseen: true,
    });
    m.jumpToUnseen();
    const state = m.getState();
    expect(state.cursor).toBe(7); // C's first item: the next unseen in order
    expect(state.transition).toBe("advance");
    expect(state.settled).toBe(false);
    expect(m.exportContext().stack).toEqual([{ decision: 0, route: 2 }]);
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: 0, routes: [1, 2] },
    ]);
    // As if picked: C is now the last pick at d1 (docs/plan.md Phase 27).
    expect(m.exportContext().lastPicks).toEqual([{ decision: 0, route: 2 }]);
    m.advance(); // carries on inside C
    m.advance(); // C's end joins the aftermath
    expect(m.getState().cursor).toBe(9);
    m.destroy();
  });

  it("wraps to earlier content: the content end goes back to an unplayed route", () => {
    const m = machine(CANON);
    pressTo(m, 2);
    m.advance();
    m.choose(2); // C, continuing
    pressTo(m, 10); // joins at 9, then the content end
    m.jumpToUnseen();
    expect(m.getState().cursor).toBe(3); // route A, before the cursor
    expect(m.exportContext().stack).toEqual([{ decision: 0, route: 0 }]);
    m.advance(); // 3 -> 4
    m.advance(); // A's end re-offers d1, its route rows now marked
    expect(m.getState().choice?.routes.map((route) => route.seen)).toEqual([
      true,
      false,
      true,
    ]);
    m.destroy();
  });

  it("opens every enclosing frame for a nested route", () => {
    const m = machine(NESTED);
    m.advance(); // 0 -> 1
    m.advance(); // fires d1
    m.choose(0); // A at 2
    m.advance(); // 2 -> 3, a-decide
    m.advance(); // fires d2
    m.choose(1); // Y, continuing, at 6
    pressTo(m, 9); // joins a-cont (8), then a-2
    m.advance(); // A's end re-offers d1
    m.choose(2); // C at 12, continuing
    m.advance(); // joins after-1 (13), the content end
    expect(m.getState().cursor).toBe(13);
    expect(m.getState().endCard).toEqual({
      unseenRoutes: 2, // B, X
      otherUnseen: false,
      nextUnseen: true,
    });
    m.jumpToUnseen();
    expect(m.getState().cursor).toBe(4); // X, inside A
    expect(m.exportContext().stack).toEqual([
      { decision: 0, route: 0 },
      { decision: 1, route: 0 },
    ]);
    m.advance(); // 4 -> 5
    m.advance(); // X's end re-offers d2 (X is an ending route)
    expect(m.getState().choice?.decisionId).toBe("d2");
    m.destroy();
  });

  it("leaves the reader's own continuation to Space: a fresh start and an unanswered decision do nothing", () => {
    const m = machine(CANON);
    let before = m.getState();
    m.jumpToUnseen(); // 1, 2 are the continuation; routes wait on `decide`
    expect(m.getState()).toBe(before);
    pressTo(m, 2); // standing on `decide`, nothing picked yet
    before = m.getState();
    m.jumpToUnseen(); // its routes are the reader's pick; after-1 is behind it
    expect(m.getState()).toBe(before);
    m.destroy();
  });

  it("never jumps behind an unpassed decision: a pure choice's tail waits for its routes", () => {
    const m = machine(PURE);
    pressTo(m, 1);
    m.advance(); // fires d1
    m.choose(1); // Q: 4..5
    m.advance(); // Q's end
    m.jumpToUnseen();
    expect(m.getState().cursor).toBe(2); // P, not the tail at 6
    m.destroy();
  });

  it("leaves an open choice for the target", () => {
    const m = machine(CANON);
    pressTo(m, 2);
    m.advance();
    m.choose(1); // B
    m.advance(); // B's end
    m.advance(); // the re-offer opens
    expect(m.getState().choice).toBeDefined();
    m.jumpToUnseen();
    expect(m.getState().choice).toBeUndefined();
    expect(m.getState().cursor).toBe(7);
    m.destroy();
  });

  it("is a no-op when everything has been seen", () => {
    const m = machine(PURE);
    pressTo(m, 1);
    m.advance();
    m.choose(0);
    m.advance(); // P's end
    m.advance(); // re-offer
    m.choose(1);
    m.advance(); // Q's end: all played, the tail follows
    pressTo(m, 7);
    expect(m.visitedList()).toHaveLength(8);
    const before = m.getState();
    m.jumpToUnseen();
    expect(m.getState()).toBe(before);
    m.destroy();
  });

  it("hasEarlierUnseen: passed-over content before the cursor counts, declined routes do not", () => {
    // A save that read the continuing route and the aftermath but whose
    // manifest gained `lead-1`/`lead-2` (a prequel, say).
    const withPrequel = machine(CANON, {
      resumeContext: {
        lastShown: 10,
        visited: [2, 7, 8, 9, 10],
        stack: [],
        playedRoutes: [{ decision: 0, routes: [2] }],
        completedRoutes: [{ decision: 0, routes: [2] }],
      },
    });
    expect(withPrequel.hasEarlierUnseen()).toBe(true);
    withPrequel.jumpToUnseen();
    expect(withPrequel.getState().cursor).toBe(0); // the prequel first
    withPrequel.destroy();
    const declinedOnly = machine(CANON, {
      resumeContext: {
        lastShown: 10,
        visited: [0, 1, 2, 7, 8, 9, 10],
        stack: [],
        playedRoutes: [{ decision: 0, routes: [2] }],
        completedRoutes: [{ decision: 0, routes: [2] }],
      },
    });
    expect(declinedOnly.hasEarlierUnseen()).toBe(false); // A, B were declined
    declinedOnly.jumpToUnseen(); // `u` still reaches them
    expect(declinedOnly.getState().cursor).toBe(3);
    declinedOnly.destroy();
  });
});

describe("turning play-all on over an open choice (docs/plan.md Phase 18)", () => {
  it("a live choice starts counting down; a walked one stays waiting", () => {
    vi.useFakeTimers();
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // the choice, manual
    m.setSettings({ ...SETTINGS, playAllRoutes: true });
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(0);
    m.setSettings(SETTINGS);
    m.choose(1); // route B at 5
    m.wheelBack(); // the walked choice screen
    m.setSettings({ ...SETTINGS, playAllRoutes: true });
    expect(m.getState().choice?.autoPick).toBeUndefined();
    m.destroy();
  });
});

describe("rolling back restores the routes (docs/plan.md Phase 22)", () => {
  const ALL: MachineSettings = { ...SETTINGS, playAllRoutes: true };

  /** Press Space (taking each play-all pick at once) until the end item. */
  function spaceToEnd(m: ReturnType<typeof machine>, end: number): number[] {
    const path: number[] = [];
    for (let press = 0; press < 80; press += 1) {
      const state = m.getState();
      path.push(state.choice === undefined ? state.cursor : -1);
      if (state.cursor === end && state.choice === undefined && state.settled)
        break;
      m.advance();
    }
    return path;
  }

  const seenMarks = (m: ReturnType<typeof machine>) =>
    m.getState().choice?.routes.map((r) => r.seen);

  it("manual: rewound before the decision, the choice re-opens with its seen marks and an unseen route can be picked", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires
    m.choose(0); // A
    step(m); // 3 -> 4
    step(m); // off A's end: re-offer
    m.choose(2); // C, the continuing route
    step(m); // 7 -> 8
    step(m); // off C's end: joins at 9
    step(m); // 9 -> 10
    wheelBackUntil(m, (s) => s.cursor === 2 && s.choice === undefined);
    // Seen routes are cumulative: rewinding forgets nothing.
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: 0, routes: [0, 2] },
    ]);
    expect(m.exportContext().passRoutes).toEqual([]);
    m.advance(); // settle `decide`: the decision fires
    expect(seenMarks(m)).toEqual([true, false, true]);
    expect(m.getState().choice?.continueOption).toBe(true);
    m.choose(1); // B, the one route not seen yet
    expect(m.getState().cursor).toBe(5);
    step(m); // 5 -> 6
    step(m); // off B's end: the re-offer, every route now seen
    expect(seenMarks(m)).toEqual([true, true, true]);
    expect(m.exportContext().passRoutes).toEqual([
      { decision: 0, routes: [1] },
    ]);
    m.destroy();
  });

  it("manual pure choice: rewound before it, the menu opens again instead of closing", () => {
    const m = machine(PURE);
    step(m); // 0 -> 1
    m.advance(); // fires
    m.choose(0); // P
    step(m); // 2 -> 3
    step(m); // P's end: re-offer
    m.choose(1); // Q
    step(m); // 4 -> 5
    step(m); // Q's end: every route played, the decision closes at 6
    expect(m.getState().cursor).toBe(6);
    wheelBackUntil(m, (s) => s.cursor === 1 && s.choice === undefined);
    m.advance(); // settle `decide`
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(seenMarks(m)).toEqual([true, true]);
    m.choose(0); // P again
    step(m);
    step(m); // P's end: Q is not played this pass, so the menu re-opens
    expect(m.getState().choice?.decisionId).toBe("d1");
    m.choose(1); // Q
    step(m);
    step(m); // Q's end: every route played this pass, so it closes
    expect(m.getState().cursor).toBe(6);
    expect(m.getState().choice).toBeUndefined();
    m.destroy();
  });

  it("play-all with Space: rewound before the decision, every route plays again, shortest first, continuing last", () => {
    vi.useFakeTimers();
    const m = machine(CANON, { settings: ALL });
    const first = spaceToEnd(m, 10);
    wheelBackUntil(m, (s) => s.cursor === 2 && s.choice === undefined);
    m.wheelBack(); // `lead-2`, before the decision's after item
    expect(m.getState().cursor).toBe(1);
    m.advance(); // 1 -> 2
    m.advance(); // fires: the choice shows with its countdown, as the first time
    expect(m.getState().choice?.autoPick).toMatchObject({
      routeIdx: 0,
      picked: false,
    });
    expect(seenMarks(m)).toEqual([true, true, true]); // seen stays seen
    const again = spaceToEnd(m, 10);
    expect(again).toEqual(first.slice(first.indexOf(2) + 1));
    expect(m.exportContext().passRoutes).toEqual([
      { decision: 0, routes: [0, 1, 2] },
    ]);
    m.destroy();
  });

  it("play-all with auto-forward: rewound before the decision, the countdowns pick every route again", () => {
    vi.useFakeTimers();
    const m = machine(CANON, { settings: ALL });
    spaceToEnd(m, 10);
    wheelBackUntil(m, (s) => s.cursor === 2 && s.choice === undefined);
    const path: string[] = [];
    m.subscribe((s) => {
      const at = s.choice === undefined ? `${s.cursor}` : `${s.cursor}?`;
      if (path[path.length - 1] !== at) path.push(at);
    });
    m.setAutoAdvance(true);
    vi.advanceTimersByTime(600_000);
    expect(path).toEqual([
      "2?", // the choice, counting down
      "3",
      "4",
      "4?", // re-offer after A
      "5",
      "6",
      "6?", // re-offer after B
      "7",
      "8",
      "9",
      "10",
    ]);
    m.destroy();
  });

  it("the wheel forward rewinds the pass to each screen; `e` restores the walk's starting record", () => {
    vi.useFakeTimers();
    const m = machine(CANON, { settings: ALL });
    spaceToEnd(m, 10); // A, B, then C: C is the last pick
    const end = m.exportContext();
    wheelBackUntil(m, (s) => s.cursor === 2 && s.choice === undefined);
    expect(m.exportContext().passRoutes).toEqual([]); // before the decision
    m.wheelForward(); // the choice screen leading into C, waiting
    expect(m.getState().choice?.walkRoute).toBe(2);
    expect(m.getState().choice?.autoPick).toBeUndefined();
    expect(seenMarks(m)).toEqual([true, true, true]);
    expect(m.exportContext().passRoutes).toEqual([]);
    m.wheelForward(); // C's first item: inside the decision, its pass is back
    expect(m.exportContext().passRoutes).toEqual(end.passRoutes);
    expect(m.exportContext().playedRoutes).toEqual(end.playedRoutes);
    wheelBackUntil(m, (s) => s.cursor === 1);
    m.jumpToEnd();
    expect(m.getState().cursor).toBe(10);
    expect(m.exportContext().passRoutes).toEqual(end.passRoutes);
    m.destroy();
  });

  it("nested: walked back to the inner decision, the inner routes and the outer remainder play again", () => {
    vi.useFakeTimers();
    const reference = machine(NESTED, { settings: ALL });
    const first = spaceToEnd(reference, 13);
    reference.destroy();
    const m = machine(NESTED, { settings: ALL });
    // Play on to A's last item, past the inner decision.
    for (let press = 0; press < 80; press += 1) {
      const state = m.getState();
      if (state.cursor === 9 && state.choice === undefined) break;
      m.advance();
    }
    expect(m.getState().cursor).toBe(9);
    wheelBackUntil(m, (s) => s.cursor === 3 && s.choice === undefined);
    // B (shortest) went first, then A: the inner decision unplayed then.
    expect(m.exportContext().passRoutes).toEqual([
      { decision: 0, routes: [0, 1] },
    ]);
    m.advance(); // fires the inner decision again
    expect(m.getState().choice?.decisionId).toBe("d2");
    const again = spaceToEnd(m, 13);
    expect(again).toEqual(first.slice(first.indexOf(3) + 1));
    m.destroy();
  });

  it("in-story re-arrival keeps the all-played rule: a rewind to a later screen restores its pass", () => {
    const m = machine(PURE);
    step(m); // 0 -> 1
    m.advance(); // fires
    m.choose(0); // P
    step(m);
    step(m); // P's end: re-offer
    m.choose(1); // Q at 4
    step(m); // 4 -> 5
    step(m); // Q's end: closes at 6
    expect(m.getState().cursor).toBe(6);
    // Back to Q's first screen: P and Q were both played this pass by
    // then, so finishing Q again closes the menu, as it did.
    wheelBackUntil(m, (s) => s.cursor === 4);
    expect(m.exportContext().passRoutes).toEqual([
      { decision: 0, routes: [0, 1] },
    ]);
    step(m);
    step(m);
    expect(m.getState().cursor).toBe(6);
    expect(m.getState().choice).toBeUndefined();
    m.destroy();
  });

  it("a reload after walking back resumes with the rewound pass", () => {
    vi.useFakeTimers();
    const m = machine(CANON, { settings: ALL });
    spaceToEnd(m, 10);
    wheelBackUntil(m, (s) => s.cursor === 2 && s.choice === undefined);
    const stored = JSON.parse(JSON.stringify(m.exportContext()));
    m.destroy();
    expect(stored.passRoutes).toEqual([]);
    expect(stored.playedRoutes).toEqual([{ decision: 0, routes: [0, 1, 2] }]);
    const again = machine(CANON, {
      settings: ALL,
      resumeContext: stored as MachineContext,
    });
    expect(again.getState().cursor).toBe(2);
    again.advance(); // fires: nothing played this pass as of this screen
    expect(again.getState().choice?.autoPick?.routeIdx).toBe(0);
    again.jumpToEnd(); // the furthest point read is still there
    expect(again.getState().cursor).toBe(10);
    again.destroy();
  });

  it("a bookmark taken before the decision restores its own pass: play-all plays every route again", () => {
    vi.useFakeTimers();
    const m = machine(CANON, { settings: ALL });
    step(m);
    step(m); // on `decide`, nothing played
    const bookmark = m.exportContext();
    spaceToEnd(m, 10);
    // What mergeProgress hands over: seen and route records merged, the
    // pass the bookmark's.
    m.importContext(mergeProgress(bookmark, m.exportContext()));
    expect(m.getState().cursor).toBe(2);
    m.advance(); // fires: the choice counts down for route A again
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(0);
    expect(m.getState().choice?.continueOption).toBe(true); // seen: kept
    m.destroy();
  });

  it("a save from before the pass record reads its played routes as the pass; the wheel still rewinds it", () => {
    vi.useFakeTimers();
    const m = machine(CANON, { settings: ALL });
    spaceToEnd(m, 10);
    const { passRoutes: _pass, ...legacy } = m.exportContext();
    m.destroy();
    const again = machine(CANON, { settings: ALL, resumeContext: legacy });
    expect(again.exportContext().passRoutes).toEqual(legacy.playedRoutes);
    wheelBackUntil(again, (s) => s.cursor === 2 && s.choice === undefined);
    expect(again.exportContext().passRoutes).toEqual([]);
    again.advance(); // fires: every route plays again
    expect(again.getState().choice?.autoPick?.routeIdx).toBe(0);
    again.destroy();
  });
});

// i0 | i1 | i2 | i3 | i4 | i5
//  0 |  1 |  2 |  3 |  4 |  5
// Nested continuing routes sharing an ending: the outer decision's
// continuing route i2..i4 holds the inner decision, whose continuing route
// i4..i4 ends on the same item, and both join at i5.
const SHARED_END: Shape = {
  items: ["i0", "i1", "i2", "i3", "i4", "i5"],
  branches: [
    {
      id: "outer",
      after: "i0",
      prompt: "Outer?",
      routes: [
        {
          id: "o-alt",
          label: "Outer alt",
          start: "i1",
          end: "i1",
          result: "return",
        },
        { id: "o-cont", label: "Outer cont", start: "i2", end: "i4" },
      ],
      continuingRoute: "o-cont",
      continueAt: "i5",
    },
    {
      id: "inner",
      after: "i2",
      prompt: "Inner?",
      routes: [
        {
          id: "n-alt",
          label: "Inner alt",
          start: "i3",
          end: "i3",
          result: "return",
        },
        { id: "n-cont", label: "Inner cont", start: "i4", end: "i4" },
      ],
      continuingRoute: "n-cont",
      continueAt: "i5",
    },
  ],
};

describe("nested continuing routes sharing an ending", () => {
  const BOTH_COMPLETE = [
    { decision: 0, routes: [0, 1] },
    { decision: 1, routes: [0, 1] },
  ];

  function expectOuterReturnRow(m: ReturnType<typeof machine>): void {
    wheelBackUntil(m, (s) => s.choice?.decisionId === "outer");
    const choice = m.getState().choice;
    expect(choice?.decisionId).toBe("outer");
    expect(choice?.routes.map((r) => r.seen)).toEqual([true, true]);
    expect(choice?.continueOption).toBe(true);
  }

  it("playAllRoutes: leaving i4 completes both continuing routes; the outer choice offers the return", () => {
    vi.useFakeTimers();
    const m = machine(SHARED_END, {
      settings: { ...SETTINGS, playAllRoutes: true },
    });
    for (let press = 0; press < 30 && m.getState().cursor !== 5; press += 1)
      m.advance();
    expect(m.getState().cursor).toBe(5);
    expect(m.exportContext().completedRoutes).toEqual(BOTH_COMPLETE);
    expect(m.exportContext().stack).toEqual([]);
    expectOuterReturnRow(m);
    m.destroy();
  });

  it("manual picks through both levels complete both continuing routes", () => {
    const m = machine(SHARED_END);
    m.advance(); // outer fires on i0
    m.choose(0); // outer alt
    m.advance(); // off i1: outer re-offers
    m.choose(1); // outer cont
    m.advance(); // inner fires on i2
    m.choose(0); // inner alt
    m.advance(); // off i3: inner re-offers
    m.choose(1); // inner cont
    expect(m.getState().cursor).toBe(4);
    m.advance(); // off i4: both routes end here, joining at i5
    expect(m.getState().cursor).toBe(5);
    expect(m.exportContext().completedRoutes).toEqual(BOTH_COMPLETE);
    expect(m.exportContext().stack).toEqual([]);
    expectOuterReturnRow(m);
    m.destroy();
  });

  it("rolling back to i4 and reading on closes both frames again", () => {
    const m = machine(SHARED_END);
    m.advance();
    m.choose(1); // outer cont
    m.advance();
    m.choose(1); // inner cont
    m.advance(); // off i4 to i5
    wheelBackTo(m, 4);
    expect(m.exportContext().stack).toEqual([
      { decision: 0, route: 1 },
      { decision: 1, route: 1 },
    ]);
    m.advance(); // off i4 again
    expect(m.getState().cursor).toBe(5);
    expect(m.exportContext().stack).toEqual([]);
    expect(m.exportContext().completedRoutes).toEqual([
      { decision: 0, routes: [1] },
      { decision: 1, routes: [1] },
    ]);
    m.destroy();
  });

  it("the inner return row joins past the outer route and closes its frame", () => {
    const m = machine(SHARED_END);
    m.advance();
    m.choose(1); // outer cont
    m.advance();
    m.choose(1); // inner cont
    m.advance(); // off i4 to i5: the inner return row is open from now on
    wheelBackUntil(m, (s) => s.choice?.decisionId === "inner");
    m.choose(0); // inner alt from the walked screen
    m.advance(); // off i3: inner re-offers, with the return row
    expect(m.getState().choice?.continueOption).toBe(true);
    m.chooseContinue();
    expect(m.getState().cursor).toBe(5);
    expect(m.exportContext().stack).toEqual([]);
    m.destroy();
  });
});

// m0 m1 m2 m3 | a1 a2 | c1 c2 c3 | m4 m5 m6 | e1 e2 | k1 k2 k3 | m7 .. m14
//  0  1  2  3 | 4  5  | 6  7  8  | 9 10 11  | 12 13 | 14 15 16 | 17 .. 24
// A main plot with two branches that rejoin it: `dA` off m3 (a1-a2 returns
// to the choice, c1-c3 continues to m4) and `dB` off m6 (e1-e2 is an
// ending, k1-k3 continues to m7).
const STORY: Shape = {
  items: [
    "m0",
    "m1",
    "m2",
    "m3",
    "a1",
    "a2",
    "c1",
    "c2",
    "c3",
    "m4",
    "m5",
    "m6",
    "e1",
    "e2",
    "k1",
    "k2",
    "k3",
    ...Array.from({ length: 8 }, (_, n) => `m${String(n + 7)}`),
  ],
  branches: [
    {
      id: "dA",
      after: "m3",
      prompt: "A?",
      routes: [
        {
          id: "aShort",
          label: "Short",
          start: "a1",
          end: "a2",
          result: "return",
        },
        { id: "aCont", label: "Long", start: "c1", end: "c3" },
      ],
      continuingRoute: "aCont",
      continueAt: "m4",
    },
    {
      id: "dB",
      after: "m6",
      prompt: "B?",
      routes: [
        { id: "bEnd", label: "Ending", start: "e1", end: "e2" },
        { id: "bCont", label: "On", start: "k1", end: "k3" },
      ],
      continuingRoute: "bCont",
      continueAt: "m7",
    },
  ],
};

/** The screen on show: the item, or `decision>walk route` on a choice. */
function here(m: ReturnType<typeof machine>): string {
  const choice = m.getState().choice;
  return choice === undefined
    ? String(m.getState().cursor)
    : `${choice.decisionId}>${String(choice.walkRoute)}`;
}

/** Wheel `notches` times one way, collecting each screen shown. */
function walk(
  m: ReturnType<typeof machine>,
  direction: "back" | "forward",
  notches: number,
): string[] {
  const shown: string[] = [];
  for (let notch = 0; notch < notches; notch += 1) {
    if (direction === "back") m.wheelBack();
    else m.wheelForward();
    shown.push(here(m));
  }
  return shown;
}

/** Manual reading: A's short route, then its continuing one; B's continuing. */
function readStoryTo(m: ReturnType<typeof machine>, target: number): void {
  for (
    let press = 0;
    press < 80 && m.getState().cursor !== target;
    press += 1
  ) {
    const choice = m.getState().choice;
    if (choice?.decisionId === "dA") m.choose(choice.routes[0].seen ? 1 : 0);
    else if (choice?.decisionId === "dB") m.choose(1);
    else m.advance();
  }
}

describe("timeline: the wheel walks the story order (docs/plan.md Phase 27)", () => {
  it("the user's example: from a bookmark near the start the wheel walks around it; after `e` around the furthest point", () => {
    const m = machine(STORY);
    readStoryTo(m, 1);
    const early = m.exportContext(); // `b` at m1, near the start
    readStoryTo(m, 22); // read on to m12, far along the main plot
    expect(m.getState().cursor).toBe(22);
    m.importContext(mergeProgress(early, m.exportContext())); // `t`: the bookmark
    expect(m.getState().cursor).toBe(1);
    expect(walk(m, "back", 1)).toEqual(["0"]); // towards the start…
    expect(walk(m, "forward", 3)).toEqual(["1", "2", "3"]); // …and past it
    m.jumpToEnd(); // the furthest point read
    expect(m.getState().cursor).toBe(22);
    expect(walk(m, "back", 1)).toEqual(["21"]);
    expect(walk(m, "forward", 2)).toEqual(["22", "22"]); // nothing seen beyond
    m.destroy();
  });

  it("the whole walk follows the last picks, through each choice screen, both ways", () => {
    const m = machine(STORY);
    readStoryTo(m, 22);
    // dA: aShort first, then aCont (the last pick); dB: bCont.
    expect(m.exportContext().lastPicks).toEqual([
      { decision: 0, route: 1 },
      { decision: 1, route: 1 },
    ]);
    const back = walk(m, "back", 26);
    expect(back).toEqual([
      "21",
      "20",
      "19",
      "18",
      "17",
      "16",
      "15",
      "14",
      "dB>1", // into bCont, back through its choice
      "11",
      "10",
      "9",
      "8",
      "7",
      "6",
      "dA>1", // the last pick at dA: the long route
      "3",
      "2",
      "1",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0", // the start: nowhere further
    ]);
    const forward = walk(m, "forward", 25);
    expect(forward).toEqual([
      "1",
      "2",
      "3",
      "dA>1",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "dB>1",
      "14",
      "15",
      "16",
      "17",
      "18",
      "19",
      "20",
      "21",
      "22",
      "22",
      "22",
      "22",
      "22",
      "22", // the furthest point: nothing seen beyond
    ]);
    m.destroy();
  });

  it("a returning last pick: back along it to its choice screen and on along the continuing route", () => {
    const m = machine(STORY);
    readStoryTo(m, 10); // dA: aShort, then aCont; on to m5
    wheelBackUntil(m, (s) => s.cursor === 3 && s.choice === undefined);
    m.advance(); // dA fires again
    m.choose(0); // aShort: now the last pick
    m.advance(); // a2
    m.advance(); // off a2: the live re-offer
    expect(m.getState().choice?.decisionId).toBe("dA");
    expect(m.getState().choice?.walkRoute).toBeUndefined(); // live, not walked
    // The live re-offer is the choice the returning route led back to: on
    // from it along the continuing route.
    expect(walk(m, "forward", 6)).toEqual([
      "6",
      "7",
      "8",
      "9",
      "10",
      "10", // the furthest point
    ]);
    expect(walk(m, "back", 12)).toEqual([
      "9",
      "8",
      "7",
      "6",
      "dA>1", // the choice the returning route led back to
      "5",
      "4",
      "dA>0", // the choice that led into the short route
      "3",
      "2",
      "1",
      "0",
    ]);
    m.destroy();
  });

  it("an ending last pick: its end stops the walk; `e` and the walk back from the furthest point take the continuing route", () => {
    const m = machine(STORY);
    readStoryTo(m, 17); // through bCont to m7
    wheelBackUntil(m, (s) => s.cursor === 11 && s.choice === undefined);
    m.advance(); // dB fires again
    m.choose(0); // bEnd: the last pick at dB
    m.advance(); // e2, the ending
    expect(m.getState().cursor).toBe(13);
    expect(walk(m, "forward", 2)).toEqual(["13", "13"]); // the ending stops it
    expect(walk(m, "back", 4)).toEqual(["12", "dB>0", "11", "10"]);
    expect(walk(m, "forward", 4)).toEqual(["11", "dB>0", "12", "13"]);
    m.jumpToEnd(); // the furthest point read: m7, outside every route
    expect(m.getState().cursor).toBe(17);
    expect(m.exportContext().stack).toEqual([]);
    expect(walk(m, "back", 5)).toEqual(["16", "15", "14", "dB>1", "11"]);
    m.destroy();
  });

  it("no known pick: the walk takes the longest route holding seen content", () => {
    const resume = (visited: number[]) =>
      machine(STORY, {
        resumeContext: {
          lastShown: 3,
          visited,
          stack: [],
          playedRoutes: [],
        },
      });
    const both = resume([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(walk(both, "forward", 3)).toEqual(["dA>1", "6", "7"]); // the longer
    both.destroy();
    const short = resume([0, 1, 2, 3, 4, 5]); // only the short route read
    expect(walk(short, "forward", 4)).toEqual(["dA>0", "4", "5", "5"]);
    short.destroy();
    const none = resume([0, 1, 2, 3]); // nothing read past the decision
    expect(walk(none, "forward", 1)).toEqual(["3"]);
    none.destroy();
  });

  it("the wheel marks nothing seen or played, and a walked choice picks nothing", () => {
    const m = machine(STORY);
    readStoryTo(m, 22);
    const before = m.exportContext();
    walk(m, "back", 30);
    walk(m, "forward", 10);
    const after = m.exportContext();
    expect(after.visited).toEqual(before.visited);
    expect(after.playedRoutes).toEqual(before.playedRoutes);
    expect(after.completedRoutes).toEqual(before.completedRoutes);
    expect(after.lastPicks).toEqual(before.lastPicks);
    m.destroy();
  });

  it("reading on from a walked-to screen simply continues from it", () => {
    const m = machine(STORY);
    readStoryTo(m, 22);
    wheelBackUntil(m, (s) => s.cursor === 15);
    expect(m.exportContext().stack).toEqual([{ decision: 1, route: 1 }]);
    m.advance(); // k3
    m.advance(); // off bCont's end: joins at m7
    expect(m.getState().cursor).toBe(17);
    expect(m.getState().transition).toBe("nav");
    m.advance();
    expect(m.getState()).toMatchObject({ cursor: 18, transition: "advance" });
    m.jumpToEnd(); // still the furthest point read
    expect(m.getState().cursor).toBe(22);
    m.destroy();
  });

  it("play all routes: walked back before a decision, reading on replays its choices and routes", () => {
    vi.useFakeTimers();
    const ALL = { ...SETTINGS, playAllRoutes: true };
    const m = machine(STORY, { settings: ALL });
    // Space through: each play-all pick taken at once.
    for (let press = 0; press < 80 && m.getState().cursor !== 22; press += 1)
      m.advance();
    expect(m.getState().cursor).toBe(22);
    const seen = m.exportContext().playedRoutes;
    expect(m.exportContext().passRoutes).toEqual([
      { decision: 0, routes: [0, 1] },
      { decision: 1, routes: [0, 1] },
    ]);
    wheelBackUntil(m, (s) => s.cursor === 11 && s.choice === undefined);
    // dA, before the screen, keeps its pass; dB counts as unplayed.
    expect(m.exportContext().passRoutes).toEqual([
      { decision: 0, routes: [0, 1] },
    ]);
    m.advance(); // dB fires: the countdown for its shortest route again
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(0);
    m.advance(); // Space takes it: bEnd
    expect(m.getState().cursor).toBe(12);
    m.advance();
    m.advance(); // off e2: the re-offer counts down for bCont
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(1);
    // Seen marks are cumulative: nothing was forgotten.
    expect(m.exportContext().playedRoutes).toEqual(seen);
    m.destroy();
  });
});

// lead decide | c-1 c-2 c-3 c-4 | n-1 n-2 | p-1 p-2 | s-1 s-2 s-3
//  0    1     | 2   3   4   5   | 6   7   | 8   9   | 10  11  12
// Routes that continue into the join (docs/plan.md Phase 38): Rowan's
// decision, whose short routes Negotiate (0) and Pay (1) are `continue`
// routes and whose long route Contract (2) is the continuing one; all three
// lead into the shared scene at `s-1`. Contract comes first in the array,
// so the short routes' ends are the items just before the join.
const JOINING: Shape = {
  items: [
    "lead",
    "decide",
    "c-1",
    "c-2",
    "c-3",
    "c-4",
    "n-1",
    "n-2",
    "p-1",
    "p-2",
    "s-1",
    "s-2",
    "s-3",
  ],
  branches: [
    {
      id: "rowan",
      after: "decide",
      prompt: "What does Rowan do?",
      routes: [
        {
          id: "negotiate",
          label: "Negotiate",
          start: "n-1",
          end: "n-2",
          result: "continue",
        },
        {
          id: "pay",
          label: "Pay",
          start: "p-1",
          end: "p-2",
          result: "continue",
        },
        { id: "contract", label: "Contract", start: "c-1", end: "c-4" },
      ],
      continuingRoute: "contract",
      continueAt: "s-1",
    },
  ],
};
const NEGOTIATE = 0;
const PAY = 1;
const CONTRACT = 2;
const JOIN = 10;

/** From the start, Space to `decide` and settle it: Rowan's choice opens. */
function openRowan(m: ReturnType<typeof machine>): void {
  step(m); // lead -> decide
  m.advance(); // settling decide fires the decision
}

/** Pick `route` from the open choice and read it through to the join. */
function readThrough(m: ReturnType<typeof machine>, route: number): void {
  m.choose(route);
  for (let press = 0; press < 8 && m.getState().cursor !== JOIN; press += 1)
    m.advance();
  expect(m.getState().cursor).toBe(JOIN);
  expect(m.getState().choice).toBeUndefined();
}

/** Wheel back onto Rowan's choice screen. */
function backToRowan(m: ReturnType<typeof machine>): void {
  wheelBackUntil(m, (s) => s.choice?.decisionId === "rowan");
}

describe("routes that continue into the join (docs/plan.md Phase 38)", () => {
  const PLAY_ALL: MachineSettings = { ...SETTINGS, playAllRoutes: true };

  it("play all routes off: stepping off a continue route's last item goes straight to continueAt, every time", () => {
    const m = machine(JOINING);
    openRowan(m);
    m.choose(PAY);
    expect(m.getState().cursor).toBe(8);
    m.advance();
    expect(m.getState().cursor).toBe(9); // p-2, Pay's last item
    m.advance(); // off it: no choice screen, the shared scene
    expect(m.getState().cursor).toBe(JOIN);
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().stack).toEqual([]);
    backToRowan(m);
    m.choose(NEGOTIATE); // again, from the walked choice screen
    m.advance();
    m.advance(); // off n-2
    expect(m.getState().cursor).toBe(JOIN);
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().stack).toEqual([]);
    m.destroy();
  });

  it("a continue route completes only itself: the return row waits for the continuing route", () => {
    const m = machine(JOINING);
    openRowan(m);
    readThrough(m, PAY);
    expect(m.exportContext().completedRoutes).toEqual([
      { decision: 0, routes: [PAY] },
    ]);
    backToRowan(m);
    expect(m.getState().choice?.continueOption).toBeUndefined();
    readThrough(m, NEGOTIATE);
    backToRowan(m);
    expect(m.getState().choice?.continueOption).toBeUndefined();
    readThrough(m, CONTRACT); // the continuing route: its end opens the row
    expect(m.exportContext().completedRoutes).toEqual([
      { decision: 0, routes: [NEGOTIATE, PAY, CONTRACT] },
    ]);
    backToRowan(m);
    expect(m.getState().choice?.continueOption).toBe(true);
    m.destroy();
  });

  it("play all routes on: every route once, shortest first, the continuing route last; a continue route's end re-offers", () => {
    vi.useFakeTimers();
    const m = machine(JOINING, { settings: PLAY_ALL });
    const shown: { cursor: number; pick?: number; back?: string }[] = [];
    m.subscribe((s) => {
      if (s.choice?.autoPick?.picked === false)
        shown.push({
          cursor: s.cursor,
          pick: s.choice.autoPick.routeIdx,
          back: s.choice.autoPick.backFromLabel,
        });
    });
    for (let press = 0; press < 40 && m.getState().cursor !== 12; press += 1)
      m.advance();
    expect(shown).toEqual([
      { cursor: 1, pick: NEGOTIATE, back: undefined },
      { cursor: 7, pick: PAY, back: "Negotiate" }, // re-offered off n-2
      { cursor: 9, pick: CONTRACT, back: "Pay" }, // re-offered off p-2
    ]);
    // Contract's end joins, and the shared scene plays once.
    expect(m.exportContext().visited).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(m.getState().cursor).toBe(12);
    m.destroy();
  });

  it("play all routes on: a continue route's end joins at continueAt once no route is unplayed this pass", () => {
    vi.useFakeTimers();
    const m = machine(JOINING);
    openRowan(m);
    m.choose(CONTRACT); // entered this pass, then left by `u`
    expect(m.getState().cursor).toBe(2);
    m.jumpToUnseen(); // past Contract's own run: into Negotiate
    expect(m.getState().cursor).toBe(6);
    m.setSettings(PLAY_ALL);
    m.advance(); // n-2
    m.advance(); // off it: Pay is unplayed this pass, so the choice again
    expect(m.getState().cursor).toBe(7);
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(PAY);
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.advance(); // Space takes Pay
    m.advance(); // p-2
    expect(m.getState().cursor).toBe(9);
    m.advance(); // off it: nothing unplayed this pass, so the join
    expect(m.getState().cursor).toBe(JOIN);
    expect(m.getState().choice).toBeUndefined();
    m.destroy();
  });

  it("its last item is not an ending: no end card there", () => {
    const m = machine(JOINING);
    openRowan(m);
    m.choose(PAY);
    m.advance();
    expect(m.getState().cursor).toBe(9);
    expect(m.getState().endCard).toBeUndefined();
    m.destroy();
  });

  it("a completed continue route passes the decision: `u` reaches the shared scene", () => {
    const m = machine(JOINING);
    openRowan(m);
    readThrough(m, NEGOTIATE); // completed: the decision is passed
    backToRowan(m);
    m.choose(PAY);
    m.advance();
    expect(m.getState().cursor).toBe(9); // p-2, Pay not yet completed
    m.jumpToUnseen();
    // s-1 is seen (Space shows it next); s-2 lies past the menu region,
    // reachable because Negotiate has completed (not Contract's c-1).
    expect(m.getState().cursor).toBe(11);
    m.destroy();
  });

  it("`u` leaves the join to Space where the next step takes it, and not under play-all's re-offer", () => {
    vi.useFakeTimers();
    // Play all routes: Negotiate completes and re-offers; Pay is taken and
    // read to its last item. The shared scene is still unseen.
    const atPayEnd = () => {
      const m = machine(JOINING, { settings: PLAY_ALL });
      openRowan(m);
      m.advance(); // Space takes Negotiate
      m.advance(); // n-2
      m.advance(); // off it: the re-offer
      m.advance(); // Space takes Pay
      m.advance(); // p-2
      expect(m.getState().cursor).toBe(9);
      expect(m.getState().choice).toBeUndefined();
      return m;
    };
    const playAll = atPayEnd();
    // The next step re-offers (Contract is unplayed), so s-1 is not the
    // reader's continuation and `u` may land there.
    playAll.jumpToUnseen();
    expect(playAll.getState().cursor).toBe(JOIN);
    playAll.destroy();
    const manual = atPayEnd();
    manual.setSettings(SETTINGS);
    // Now the next step joins: s-1 onwards is Space's, so `u` wraps round
    // to the unplayed Contract instead.
    manual.jumpToUnseen();
    expect(manual.getState().cursor).toBe(2);
    manual.destroy();
  });

  it("skip never reveals the join off a continue route's end", () => {
    const m = machine(JOINING, {
      settings: { ...SETTINGS, skipAll: false },
    });
    openRowan(m);
    m.choose(PAY);
    m.advance();
    expect(m.getState().cursor).toBe(9);
    m.toggleSkip(); // the next step would show the unseen s-1
    expect(m.getState().skipping).toBe(false);
    expect(m.getState().cursor).toBe(9);
    m.destroy();
  });

  it("the wheel: a continue route's end leads forward to continueAt; back from it the last pick's end", () => {
    const m = machine(JOINING);
    openRowan(m);
    readThrough(m, CONTRACT);
    backToRowan(m);
    readThrough(m, PAY);
    backToRowan(m);
    readThrough(m, NEGOTIATE); // the last pick; p-2 is read and adjacent
    m.advance(); // s-2
    expect(walk(m, "back", 7)).toEqual([
      "10",
      "7", // Negotiate's end, not p-2 or Contract's c-4
      "6",
      "rowan>0",
      "1",
      "0",
      "0",
    ]);
    expect(walk(m, "forward", 7)).toEqual([
      "1",
      "rowan>0",
      "6",
      "7",
      "10", // on to the join, not back to the choice screen
      "11",
      "11",
    ]);
    m.destroy();
  });

  // The last pick wins over a seen join (docs/plan.md Phase 39): back from
  // continueAt, a last pick abandoned before its end leads to its last read
  // item. The continuing route's end and another read joining end count
  // only when the last pick holds nothing read (the Phase 39 block below).
  it("the wheel back from continueAt: the last pick's route, abandoned before its end, to its last read item", () => {
    const m = machine(JOINING);
    openRowan(m);
    readThrough(m, CONTRACT);
    m.advance();
    m.advance(); // s-3
    backToRowan(m);
    readThrough(m, NEGOTIATE);
    backToRowan(m);
    m.choose(PAY); // the last pick, abandoned on p-1
    m.jumpToEnd();
    expect(m.getState().cursor).toBe(12);
    // p-1, not Contract's read end c-4 (5).
    expect(walk(m, "back", 4)).toEqual(["11", "10", "8", "rowan>1"]);
    m.destroy();
  });

  it("the wheel back from continueAt: the abandoned last pick before another joining route's read end", () => {
    const m = machine(JOINING);
    openRowan(m);
    readThrough(m, NEGOTIATE);
    m.advance();
    m.advance(); // s-3
    backToRowan(m);
    m.choose(PAY); // the last pick, abandoned on p-1; Contract never read
    m.jumpToEnd();
    // p-1, not Negotiate's read end n-2 (7).
    expect(walk(m, "back", 5)).toEqual(["11", "10", "8", "rowan>1", "1"]);
    m.destroy();
  });

  it("a continue route on a decision without a join drops that decision", () => {
    const m = machine({
      items: ["lead", "decide", "p-1", "q-1", "tail"],
      branches: [
        {
          id: "pure",
          after: "decide",
          prompt: "Which?",
          routes: [
            {
              id: "p",
              label: "P",
              start: "p-1",
              end: "p-1",
              result: "continue",
            },
            { id: "q", label: "Q", start: "q-1", end: "q-1" },
          ],
        },
      ],
    });
    step(m);
    m.advance(); // settling decide fires nothing: the items play linearly
    expect(m.getState().choice).toBeUndefined();
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });
});

// i0 | i1 | i2 | i3 | i4 | i5
//  0 |  1 |  2 |  3 |  4 |  5
// A continue route inside an enclosing route: the outer decision's
// continuing route i2..i4 holds the inner decision, whose continue route
// i3 and continuing route i4 both join at i5, past the enclosing route.
const NESTED_JOINING: Shape = {
  items: ["i0", "i1", "i2", "i3", "i4", "i5"],
  branches: [
    {
      id: "outer",
      after: "i0",
      prompt: "Outer?",
      routes: [
        {
          id: "o-alt",
          label: "Outer alt",
          start: "i1",
          end: "i1",
          result: "return",
        },
        { id: "o-cont", label: "Outer cont", start: "i2", end: "i4" },
      ],
      continuingRoute: "o-cont",
      continueAt: "i5",
    },
    {
      id: "inner",
      after: "i2",
      prompt: "Inner?",
      routes: [
        {
          id: "n-pay",
          label: "Inner pay",
          start: "i3",
          end: "i3",
          result: "continue",
        },
        { id: "n-cont", label: "Inner cont", start: "i4", end: "i4" },
      ],
      continuingRoute: "n-cont",
      continueAt: "i5",
    },
  ],
};

describe("a nested continue route joining past its enclosing route (docs/plan.md Phase 38)", () => {
  it("its end leaves the enclosing route too, completing it, as the continuing route's does", () => {
    const m = machine(NESTED_JOINING);
    m.advance(); // outer fires on i0
    m.choose(1); // outer cont
    m.advance(); // inner fires on i2
    m.choose(0); // inner pay
    expect(m.getState().cursor).toBe(3);
    m.advance(); // off i3: joins at i5, past the outer route's end
    expect(m.getState().cursor).toBe(5);
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().stack).toEqual([]);
    expect(m.exportContext().completedRoutes).toEqual([
      { decision: 0, routes: [1] },
      { decision: 1, routes: [0] },
    ]);
    // The wheel walks the same path, both ways.
    expect(walk(m, "back", 5)).toEqual(["3", "inner>0", "2", "outer>1", "0"]);
    expect(walk(m, "forward", 5)).toEqual([
      "outer>1",
      "2",
      "inner>0",
      "3",
      "5",
    ]);
    // The outer continuing route completed, so its return row is open.
    wheelBackUntil(m, (s) => s.choice?.decisionId === "outer");
    expect(m.getState().choice?.continueOption).toBe(true);
    m.destroy();
  });
});

/** The context `m` would save, through JSON as storage holds it. */
function savedContext(m: ReturnType<typeof machine>): MachineContext {
  return JSON.parse(JSON.stringify(m.exportContext())) as MachineContext;
}

// lead-1 lead-2 decide | a-1 a-2 | b-1 b-2 | cont-1 cont-2 | after-1 after-2 after-3
//  0      1      2     | 3   4   | 5   6   | 7      8      | 9       10      11
// CANON with `after-3`: content past the join that `u` reaches only once
// flow has passed d1.
const LONGER: Shape = { ...CANON, items: [...CANON.items, "after-3"] };

describe("a restored completion follows the route's current end (docs/plan.md Phase 38)", () => {
  // Every route of d1 recorded completed, as a save made before route C was
  // extended restores: C's end `cont-2` (8) is not in the seen set.
  const restored = (
    visited: readonly number[],
    lastShown: number,
    stack: MachineContext["stack"],
  ): MachineContext => ({
    lastShown,
    visited,
    stack,
    playedRoutes: [{ decision: 0, routes: [0, 1, 2] }],
    completedRoutes: [{ decision: 0, routes: [0, 1, 2] }],
  });
  const END_UNSEEN = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10];
  const END_SEEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it("the continuing route's end unseen: no return row on a re-opening, played mark kept", () => {
    const m = machine(LONGER, {
      resumeContext: restored(END_UNSEEN, 4, [{ decision: 0, route: 0 }]),
    });
    expect(m.exportContext().completedRoutes).toEqual([
      { decision: 0, routes: [0, 1] },
    ]);
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: 0, routes: [0, 1, 2] },
    ]);
    m.advance(); // off A's end (a return route): d1 re-offers
    const choice = m.getState().choice;
    expect(choice?.decisionId).toBe("d1");
    expect(choice?.continueOption).toBeUndefined();
    expect(choice?.routes.map((route) => route.seen)).toEqual([
      true,
      true,
      true,
    ]);
    m.destroy();
  });

  it("the continuing route's end unseen: `u` reads the decision as not passed", () => {
    const m = machine(LONGER, { resumeContext: restored(END_UNSEEN, 9, []) });
    m.jumpToUnseen();
    expect(m.getState().cursor).toBe(8); // C's unseen end, not `after-3`
    m.destroy();
  });

  it("the continuing route's end seen: the completion is kept", () => {
    const reopened = machine(LONGER, {
      resumeContext: restored(END_SEEN, 4, [{ decision: 0, route: 0 }]),
    });
    expect(reopened.exportContext().completedRoutes).toEqual([
      { decision: 0, routes: [0, 1, 2] },
    ]);
    reopened.advance(); // off A's end: d1 re-offers, with the return row
    expect(reopened.getState().choice?.continueOption).toBe(true);
    reopened.destroy();
    const jumped = machine(LONGER, {
      resumeContext: restored(END_SEEN, 9, []),
    });
    jumped.jumpToUnseen();
    expect(jumped.getState().cursor).toBe(11); // d1 passed: past it
    jumped.destroy();
  });

  it("a nested continue route's join past the outer end: the outer completion survives a reload", () => {
    const m = machine(NESTED_JOINING);
    m.advance(); // outer fires on i0
    m.choose(1); // outer cont
    m.advance(); // inner fires on i2
    m.choose(0); // inner pay
    m.advance(); // off i3: joins at i5, completing the outer route too
    expect(m.visitedList()).not.toContain(4); // the outer route's end
    const saved = savedContext(m);
    m.destroy();
    const resumed = machine(NESTED_JOINING, { resumeContext: saved });
    expect(resumed.exportContext().completedRoutes).toEqual(
      saved.completedRoutes,
    );
    resumed.showChoice(0);
    expect(resumed.getState().choice?.decisionId).toBe("outer");
    expect(resumed.getState().choice?.continueOption).toBe(true);
    resumed.destroy();
  });

  it("a nested continuing route joining past the outer end: the outer completion survives a reload", () => {
    // i0 | i1 | i2 | i3 | i4 i5 | i6: the inner continuing route i3 comes
    // first, its alternative runs to the outer route's end, and both
    // decisions join at i6, so picking it skips the outer end i5.
    const shape: Shape = {
      items: ["i0", "i1", "i2", "i3", "i4", "i5", "i6"],
      branches: [
        {
          id: "outer",
          after: "i0",
          prompt: "Outer?",
          routes: [
            {
              id: "o-alt",
              label: "Outer alt",
              start: "i1",
              end: "i1",
              result: "return",
            },
            { id: "o-cont", label: "Outer cont", start: "i2", end: "i5" },
          ],
          continuingRoute: "o-cont",
          continueAt: "i6",
        },
        {
          id: "inner",
          after: "i2",
          prompt: "Inner?",
          routes: [
            { id: "n-cont", label: "Inner cont", start: "i3", end: "i3" },
            { id: "n-alt", label: "Inner alt", start: "i4", end: "i5" },
          ],
          continuingRoute: "n-cont",
          continueAt: "i6",
        },
      ],
    };
    const m = machine(shape);
    m.advance(); // outer fires on i0
    m.choose(1); // outer cont
    m.advance(); // inner fires on i2
    m.choose(0); // inner cont
    m.advance(); // off i3: joins at i6, past the outer end
    expect(m.getState().cursor).toBe(6);
    expect(m.visitedList()).toEqual([0, 2, 3, 6]);
    const saved = savedContext(m);
    expect(saved.completedRoutes).toEqual([
      { decision: 0, routes: [1] },
      { decision: 1, routes: [0] },
    ]);
    m.destroy();
    const resumed = machine(shape, { resumeContext: saved });
    expect(resumed.exportContext().completedRoutes).toEqual(
      saved.completedRoutes,
    );
    resumed.showChoice(0);
    expect(resumed.getState().choice?.continueOption).toBe(true);
    resumed.destroy();
  });

  it("a nested pure choice closing past the outer end: the outer completion survives a reload", () => {
    // o0 | o1 | o2 | p1 | q1 q2 | o3: the pure choice `menu` inside the
    // outer continuing route o2..q2 has a region running to that route's
    // end, so closing it ends the outer route. Q is entered, then `u` leaves
    // it for P before its end `q2`, and P's end closes the menu.
    const shape: Shape = {
      items: ["o0", "o1", "o2", "p1", "q1", "q2", "o3"],
      branches: [
        {
          id: "outer",
          after: "o0",
          prompt: "Outer?",
          routes: [
            {
              id: "o-alt",
              label: "Outer alt",
              start: "o1",
              end: "o1",
              result: "return",
            },
            { id: "o-cont", label: "Outer cont", start: "o2", end: "q2" },
          ],
          continuingRoute: "o-cont",
          continueAt: "o3",
        },
        {
          id: "menu",
          after: "o2",
          prompt: "Menu?",
          routes: [
            { id: "p", label: "P", start: "p1", end: "p1" },
            { id: "q", label: "Q", start: "q1", end: "q2" },
          ],
        },
      ],
    };
    const m = machine(shape);
    m.advance(); // outer fires on o0
    m.choose(0); // outer alt
    m.advance(); // off o1: outer re-offers
    m.choose(1); // outer cont
    m.advance(); // menu fires on o2
    m.choose(1); // Q
    expect(m.getState().cursor).toBe(4);
    m.jumpToUnseen(); // into P, as picking it would
    expect(m.getState().cursor).toBe(3);
    m.advance(); // off P's end: every menu route played, it closes past q2
    expect(m.getState().cursor).toBe(6);
    expect(m.visitedList()).not.toContain(5); // the outer route's end
    const saved = savedContext(m);
    expect(saved.completedRoutes).toEqual([
      { decision: 0, routes: [0, 1] },
      { decision: 1, routes: [0] },
    ]);
    m.destroy();
    const resumed = machine(shape, { resumeContext: saved });
    expect(resumed.exportContext().completedRoutes).toEqual(
      saved.completedRoutes,
    );
    resumed.showChoice(0);
    expect(resumed.getState().choice?.continueOption).toBe(true);
    resumed.destroy();
  });
});

/**
 * `shape` after a content update: `added` items inserted after item
 * `after`, and, when `end` is given, route `end.route` ending on `end.at`.
 */
function updated(
  shape: Shape,
  after: string,
  added: readonly string[],
  end?: { route: string; at: string },
): Shape {
  const at = shape.items.indexOf(after) + 1;
  return {
    items: [...shape.items.slice(0, at), ...added, ...shape.items.slice(at)],
    branches: shape.branches.map((branch) => ({
      ...branch,
      routes: branch.routes.map((route) =>
        route.id === end?.route ? { ...route, end: end.at } : route,
      ),
    })),
  };
}

/** `m`'s save, made under `from`, restored under `to` as storage does: by ids. */
function reloadedUnder(
  m: ReturnType<typeof machine>,
  from: Shape,
  to: Shape,
  settings: MachineSettings = SETTINGS,
): ReturnType<typeof machine> {
  const saved = createContextCodec(manifest(from).items, from.branches).toSaved(
    m.exportContext(),
  );
  const context = createContextCodec(manifest(to).items, to.branches).fromSaved(
    JSON.parse(JSON.stringify(saved)),
  );
  if (context === undefined) throw new Error("the save did not restore");
  return machine(to, { resumeContext: context, settings });
}

/** The context fields the wheel must never touch. */
function records(m: ReturnType<typeof machine>) {
  const { visited, playedRoutes, completedRoutes, lastPicks } =
    m.exportContext();
  return { visited, playedRoutes, completedRoutes, lastPicks };
}

describe("the wheel steps back over unseen content (docs/plan.md Phase 39)", () => {
  it("a finished continuing route extended since: back from continueAt passes over the new end to the old one", () => {
    const m = machine(JOINING);
    openRowan(m);
    readThrough(m, CONTRACT); // c-1..c-4, then the shared scene
    // lead decide | c-1 c-2 c-3 c-4 c-5 c-6 | n-1 n-2 | p-1 p-2 | s-1 s-2 s-3
    //  0    1     | 2   3   4   5   6   7   | 8   9   | 10  11  | 12  13  14
    const later = updated(JOINING, "c-4", ["c-5", "c-6"], {
      route: "contract",
      at: "c-6",
    });
    const resumed = reloadedUnder(m, JOINING, later);
    m.destroy();
    expect(resumed.getState().cursor).toBe(12); // s-1
    const before = records(resumed);
    expect(before.visited).toEqual([0, 1, 2, 3, 4, 5, 12]);
    expect(walk(resumed, "back", 7)).toEqual([
      "5", // c-4, the last item of the route as it was read
      "4",
      "3",
      "2",
      "rowan>2",
      "1",
      "0",
    ]);
    // Forward stops before the unseen c-5, where Space reads on into it.
    expect(walk(resumed, "forward", 7)).toEqual([
      "1",
      "rowan>2",
      "2",
      "3",
      "4",
      "5",
      "5",
    ]);
    // Nothing unseen was shown or marked on the way.
    expect(records(resumed)).toEqual(before);
    resumed.advance();
    expect(resumed.getState().cursor).toBe(6); // c-5, the new content
    resumed.jumpToEnd(); // the furthest point read is still s-1
    expect(resumed.getState().cursor).toBe(12);
    resumed.destroy();
  });

  it("a finished continue route extended since, the last pick: back from continueAt passes over its new end", () => {
    const m = machine(JOINING);
    openRowan(m);
    readThrough(m, PAY); // p-1 p-2, then the shared scene
    m.advance(); // s-2
    // lead decide | c-1 c-2 c-3 c-4 | n-1 n-2 | p-1 p-2 p-3 | s-1 s-2 s-3
    //  0    1     | 2   3   4   5   | 6   7   | 8   9   10  | 11  12  13
    const later = updated(JOINING, "p-2", ["p-3"], { route: "pay", at: "p-3" });
    const resumed = reloadedUnder(m, JOINING, later);
    m.destroy();
    expect(resumed.getState().cursor).toBe(12); // s-2
    const before = records(resumed);
    expect(walk(resumed, "back", 6)).toEqual([
      "11",
      "9", // p-2, past the unseen p-3
      "8",
      "rowan>1",
      "1",
      "0",
    ]);
    expect(walk(resumed, "forward", 5)).toEqual([
      "1",
      "rowan>1",
      "8",
      "9",
      "9", // p-3 is unseen: the walk stops before it
    ]);
    expect(records(resumed)).toEqual(before);
    resumed.destroy();
  });

  it("items inserted inside a route: the walk back passes over them", () => {
    const m = machine(JOINING);
    openRowan(m);
    readThrough(m, CONTRACT);
    // lead decide | c-1 c-2 c-2b c-3 c-4 | n-1 n-2 | p-1 p-2 | s-1 s-2 s-3
    //  0    1     | 2   3   4    5   6   | 7   8   | 9   10  | 11  12  13
    const later = updated(JOINING, "c-2", ["c-2b"]);
    const resumed = reloadedUnder(m, JOINING, later);
    m.destroy();
    expect(resumed.getState().cursor).toBe(11);
    const before = records(resumed);
    expect(walk(resumed, "back", 5)).toEqual([
      "6",
      "5",
      "3", // c-2, past the unseen c-2b
      "2",
      "rowan>2",
    ]);
    expect(walk(resumed, "forward", 4)).toEqual(["2", "3", "3", "3"]);
    expect(records(resumed)).toEqual(before);
    resumed.destroy();
  });

  it("a `u` landing past unseen items: back from it to the last item read on the way", () => {
    const m = machine(PURE);
    step(m); // lead-1 -> decide
    m.advance(); // the choice
    m.choose(0); // P: p-1
    m.jumpToUnseen(); // into Q, past P's unread end
    expect(m.getState().cursor).toBe(4);
    m.jumpToUnseen(); // both routes played: past the region, both ends unread
    expect(m.getState().cursor).toBe(6);
    const before = records(m);
    // Not the screen past the region over Q's unread end: nothing unseen
    // shows, the choice screen's picture included.
    expect(walk(m, "back", 4)).toEqual(["4", "d1>1", "1", "0"]);
    expect(walk(m, "forward", 4)).toEqual(["1", "d1>1", "4", "4"]);
    expect(records(m)).toEqual(before);
    m.destroy();
  });

  // lead decide | c-1 c-2 c-3 c-4 c-5 c-6 | n-1 n-2 | p-1 p-2 | s-1 s-2 s-3
  //  0    1     | 2   3   4   5   6   7   | 8   9   | 10  11  | 12  13  14
  // Contract extended by c-5 and c-6 after the reader finished it.
  const CONTRACT_EXTENDED = updated(JOINING, "c-4", ["c-5", "c-6"], {
    route: "contract",
    at: "c-6",
  });

  it("the last pick wins over a seen join: play all routes read Negotiate, Pay, then Contract; Contract extended since, back from the shared scene shows Contract's old end", () => {
    vi.useFakeTimers();
    const PLAY_ALL: MachineSettings = { ...SETTINGS, playAllRoutes: true };
    const m = machine(JOINING, { settings: PLAY_ALL });
    for (let press = 0; press < 40 && m.getState().cursor !== JOIN; press += 1)
      m.advance();
    expect(m.getState().cursor).toBe(JOIN);
    expect(m.visitedList()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(m.exportContext().lastPicks).toEqual([
      { decision: 0, route: CONTRACT },
    ]);
    const resumed = reloadedUnder(m, JOINING, CONTRACT_EXTENDED, PLAY_ALL);
    m.destroy();
    expect(resumed.getState().cursor).toBe(12);
    const before = records(resumed);
    // c-4, not Pay's read end p-2 (11) just before the join.
    expect(walk(resumed, "back", 2)).toEqual(["5", "4"]);
    expect(walk(resumed, "forward", 2)).toEqual(["5", "5"]); // c-5 unseen
    expect(records(resumed)).toEqual(before);
    resumed.advance();
    expect(resumed.getState().cursor).toBe(6); // Space reads c-5
    resumed.destroy();
  });

  it("the last pick wins over a seen join: Negotiate read earlier, Contract last, Contract extended since; back from the shared scene follows Contract", () => {
    const m = machine(JOINING);
    openRowan(m);
    readThrough(m, NEGOTIATE);
    backToRowan(m);
    readThrough(m, CONTRACT); // the last pick
    const resumed = reloadedUnder(m, JOINING, CONTRACT_EXTENDED);
    m.destroy();
    expect(resumed.getState().cursor).toBe(12);
    const before = records(resumed);
    // c-4, not Negotiate's read end n-2 (9).
    expect(walk(resumed, "back", 2)).toEqual(["5", "4"]);
    expect(walk(resumed, "forward", 2)).toEqual(["5", "5"]);
    expect(records(resumed)).toEqual(before);
    resumed.advance();
    expect(resumed.getState().cursor).toBe(6);
    resumed.destroy();
  });

  it("only when the last pick's route holds nothing read do the other joins count, in their order", () => {
    // Saved state with Pay the last pick and none of its items seen (as
    // after Pay's items were replaced by new ones).
    const restored = (visited: number[]) =>
      machine(JOINING, {
        resumeContext: {
          lastShown: JOIN,
          visited,
          stack: [],
          playedRoutes: [{ decision: 0, routes: [NEGOTIATE, PAY, CONTRACT] }],
          lastPicks: [{ decision: 0, route: PAY }],
        },
      });
    const both = restored([0, 1, 2, 3, 4, 5, 6, 7, JOIN]);
    expect(walk(both, "back", 1)).toEqual(["5"]); // the continuing route's end
    both.destroy();
    const negotiated = restored([0, 1, 6, 7, JOIN]); // Contract never read
    expect(walk(negotiated, "back", 1)).toEqual(["7"]); // Negotiate's end
    negotiated.destroy();
  });

  it("no seen screen behind: the wheel does not move, and the notch still ends skip", () => {
    // A prequel with its own decision inserted before everything read.
    // pre-1 pre-decide | px-1 | py-1 | pre-end lead-1 lead-2
    //  0     1         | 2    | 3    | 4       5      6
    const m = machine(
      {
        items: [
          "pre-1",
          "pre-decide",
          "px-1",
          "py-1",
          "pre-end",
          "lead-1",
          "lead-2",
        ],
        branches: [
          {
            id: "pre",
            after: "pre-decide",
            prompt: "Prequel?",
            routes: [
              { id: "px", label: "PX", start: "px-1", end: "px-1" },
              { id: "py", label: "PY", start: "py-1", end: "py-1" },
            ],
            continuingRoute: "py",
            continueAt: "pre-end",
          },
        ],
      },
      {
        resumeContext: {
          lastShown: 6,
          visited: [5, 6],
          stack: [],
          playedRoutes: [],
        },
      },
    );
    expect(walk(m, "back", 3)).toEqual(["5", "5", "5"]);
    expect(m.visitedList()).toEqual([5, 6]);
    m.toggleSkip(); // lead-2 is seen ahead
    expect(m.getState().skipping).toBe(true);
    m.wheelBack();
    expect(m.getState()).toMatchObject({ cursor: 5, skipping: false });
    m.destroy();
  });

  it("a malformed table whose walk back loops: the notch finds nothing and does not move", () => {
    // i0 i1 | i2 i3 | i4 | i5: the join `continueAt` is the decision's own
    // `after`, so the walk back from it runs through route R1 to its
    // choice screen and on to `after` again.
    const m = machine(
      {
        items: ["i0", "i1", "i2", "i3", "i4", "i5"],
        branches: [
          {
            id: "loop",
            after: "i1",
            prompt: "Loop?",
            routes: [
              { id: "r1", label: "R1", start: "i2", end: "i3" },
              { id: "r2", label: "R2", start: "i4", end: "i4" },
            ],
            continuingRoute: "r1",
            continueAt: "i1",
          },
        ],
      },
      {
        resumeContext: {
          lastShown: 4,
          visited: [4],
          stack: [{ decision: 0, route: 1 }],
          playedRoutes: [{ decision: 0, routes: [1] }],
        },
      },
    );
    m.wheelBack();
    expect(here(m)).toBe("4");
    expect(m.visitedList()).toEqual([4]);
    m.destroy();
  });
});

describe("auto-forward over an open choice (docs/plan.md Phase 43)", () => {
  // Auto-forward now arms a settled item's hold, but an open choice waits
  // for its answer: no hold re-fires the decision behind it, and play-all's
  // auto-pick keeps its own timer.
  it("`a` over a restored choice arms nothing: it waits for its answer", () => {
    vi.useFakeTimers();
    const first = machine(CANON);
    for (let press = 0; press < 3; press += 1) first.advance(); // the choice
    const stored = first.exportContext();
    first.destroy();
    const m = machine(CANON, { resumeContext: stored });
    const landed = m.getState();
    expect(landed).toMatchObject({ cursor: 2, settled: true });
    expect(landed.choice?.decisionId).toBe("d1");
    const seen: MachineState[] = [];
    m.subscribe((state) => seen.push(state));
    m.setAutoAdvance(true);
    vi.advanceTimersByTime(60_000);
    m.pause(); // the Esc screen opens and closes over it
    m.resume();
    vi.advanceTimersByTime(60_000);
    expect(seen).toEqual([]);
    expect(m.getState()).toBe(landed);
    m.destroy();
  });

  it.each(["ending", "return"] as const)(
    "a pure choice that closed the story on route P's last item (result %s) stays: no hold steps into route Q",
    (result) => {
      vi.useFakeTimers();
      // A pure choice whose routes run to the array end: the all-played close
      // ends the story on P's last item, with Q's items after it.
      const d1 = PURE.branches[0];
      const LAST: Shape = {
        items: ["lead-1", "decide", "p-1", "p-2", "q-1", "q-2"],
        branches: [
          { ...d1, routes: d1.routes.map((route) => ({ ...route, result })) },
        ],
      };
      const m = machine(LAST);
      m.advance(); // 0 -> 1
      m.advance(); // fires d1
      m.choose(1); // route Q: 4..5
      m.advance(); // 4 -> 5
      m.advance(); // the re-offer
      m.choose(0); // route P: 2..3
      m.advance(); // 2 -> 3
      m.advance(); // all routes played: the menu closes and the story ends
      const ended = m.getState();
      expect(ended).toMatchObject({ cursor: 3, settled: true });
      expect(ended.choice).toBeUndefined();
      const seen: MachineState[] = [];
      m.subscribe((state) => seen.push(state));
      m.setAutoAdvance(true);
      vi.advanceTimersByTime(60_000);
      m.pause(); // the Esc screen opens and closes at the end
      m.resume();
      vi.advanceTimersByTime(60_000);
      expect(seen).toEqual([]);
      expect(m.getState()).toBe(ended);
      const reloaded = machine(LAST, { resumeContext: m.exportContext() });
      m.destroy();
      expect(reloaded.getState()).toMatchObject({ cursor: 3, settled: true });
      reloaded.setAutoAdvance(true); // and after a reload onto it
      vi.advanceTimersByTime(60_000);
      expect(reloaded.getState().cursor).toBe(3);
      reloaded.destroy();
    },
  );

  it("`a` during play-all's countdown leaves the auto-pick on its own timer", () => {
    vi.useFakeTimers();
    const m = machine(CANON, {
      settings: { ...SETTINGS, playAllRoutes: true },
    });
    for (let press = 0; press < 3; press += 1) m.advance(); // the choice
    const ms = m.getState().choice?.autoPick?.ms ?? 0;
    expect(ms).toBeGreaterThan(2000);
    vi.advanceTimersByTime(1000);
    m.setAutoAdvance(true);
    vi.advanceTimersByTime(ms - 1001);
    expect(m.getState().choice?.autoPick?.picked).toBe(false);
    vi.advanceTimersByTime(1); // the countdown never restarted
    expect(m.getState().choice?.autoPick).toMatchObject({
      routeIdx: 0,
      picked: true,
    });
    vi.advanceTimersByTime(AUTO_PICK_SHOW_MS);
    expect(m.getState().choice).toBeUndefined();
    expect(m.getState().cursor).toBe(3);
    m.destroy();
  });
});

// lead-1 decide | a-1 a-2 a-3 a-4 | b-1 | after-1
//  0      1     | 2   3   4   5   | 6   | 7
// One decision with a long returning route A, so a burst through it after
// a pick has steps to take, and a one-item continuing route B.
const LONG_A: Shape = {
  items: ["lead-1", "decide", "a-1", "a-2", "a-3", "a-4", "b-1", "after-1"],
  branches: [
    {
      id: "d1",
      after: "decide",
      prompt: "Which way?",
      routes: [
        {
          id: "r-a",
          label: "Route A",
          start: "a-1",
          end: "a-4",
          result: "return",
        },
        { id: "r-b", label: "Route B", start: "b-1", end: "b-1" },
      ],
      continuingRoute: "r-b",
      continueAt: "after-1",
    },
  ],
};

// s0 | s1 s2 s3 | s4 | s5
//  0 |  1  2  3 |  4 |  5
// The outer decision's returning route s1..s3 holds the inner decision,
// whose continuing route s3 ends with it and joins past it at s5: leaving
// the inner decision by its return row ends the outer route there, so the
// outer decision re-offers at once.
const REOFFER: Shape = {
  items: ["s0", "s1", "s2", "s3", "s4", "s5"],
  branches: [
    {
      id: "outer",
      after: "s0",
      prompt: "Outer?",
      routes: [
        {
          id: "o-alt",
          label: "Outer alt",
          start: "s1",
          end: "s3",
          result: "return",
        },
        { id: "o-cont", label: "Outer cont", start: "s4", end: "s4" },
      ],
      continuingRoute: "o-cont",
      continueAt: "s5",
    },
    {
      id: "inner",
      after: "s1",
      prompt: "Inner?",
      routes: [
        {
          id: "n-alt",
          label: "Inner alt",
          start: "s2",
          end: "s2",
          result: "return",
        },
        { id: "n-cont", label: "Inner cont", start: "s3", end: "s3" },
      ],
      continuingRoute: "n-cont",
      continueAt: "s5",
    },
  ],
};

describe("skip and auto-forward on a choice screen (docs/plan.md Phase 43)", () => {
  // Tab on an open choice turns skip on (reported) and moves nothing; the
  // answer then starts the burst on the first item it shows, as a Tab
  // pressed there would. `a` likewise: the route's first item gets its
  // hold after the pick.
  const ALL: MachineSettings = { ...SETTINGS, playAllRoutes: true };
  const dwell = SETTINGS.skipDwellMs;

  function watch(m: ReturnType<typeof machine>): boolean[] {
    const flips: boolean[] = [];
    m.onSkipChange((on) => flips.push(on));
    return flips;
  }

  /** Manual LONG_A: route A read through, the choice re-offered after it. */
  function atReoffer(settings: MachineSettings = SETTINGS) {
    const m = machine(LONG_A, { settings });
    m.advance(); // 0 -> 1
    m.advance(); // fires d1
    m.choose(0); // route A: a-1
    for (let press = 0; press < 3; press += 1) m.advance(); // to a-4
    m.advance(); // off a-4: route A returns, the choice re-offers
    expect(m.getState().choice).toMatchObject({ decisionId: "d1" });
    expect(m.getState().choice?.routes[0].seen).toBe(true);
    return m;
  }

  it("Tab on a choice arms skip: reported on, the choice stays and nothing moves", () => {
    vi.useFakeTimers();
    const m = atReoffer();
    const before = m.getState();
    const seen: MachineState[] = [];
    m.subscribe((state) => seen.push(state));
    const flips = watch(m);
    m.toggleSkip();
    expect(flips).toEqual([true]);
    vi.advanceTimersByTime(60_000);
    expect(m.getState()).toBe(before);
    expect(seen).toEqual([]);
    m.destroy();
  });

  it("the pick then runs the burst from the route's first item", () => {
    vi.useFakeTimers();
    const m = atReoffer();
    const flips = watch(m);
    m.toggleSkip();
    const path: [number, boolean][] = [];
    m.subscribe((state) => path.push([state.cursor, state.skipping]));
    m.choose(0); // route A again: every item of it was read
    expect(m.getState()).toMatchObject({ cursor: 2, skipping: true });
    expect(m.getState().choice).toBeUndefined();
    vi.advanceTimersByTime(dwell * 3);
    expect(path).toEqual([
      [2, true],
      [3, true],
      [4, true],
      [5, false], // the last seen item: the burst stops ON it
    ]);
    expect(flips).toEqual([true, false]);
    m.destroy();
  });

  it("Tab twice on a choice arms nothing: on, then off, and the pick runs no burst", () => {
    vi.useFakeTimers();
    const m = atReoffer();
    const flips = watch(m);
    m.toggleSkip();
    m.toggleSkip();
    expect(flips).toEqual([true, false]);
    m.choose(0);
    expect(m.getState()).toMatchObject({ cursor: 2, skipping: false });
    vi.advanceTimersByTime(60_000); // manual: the route waits for a press
    expect(m.getState().cursor).toBe(2);
    expect(flips).toEqual([true, false]);
    m.destroy();
  });

  it("armed skip with nothing seen to run through after the pick turns off at the pick", () => {
    vi.useFakeTimers();
    const m = machine(LONG_A);
    m.advance();
    m.advance(); // the first fire: no route read yet
    const flips = watch(m);
    m.toggleSkip();
    expect(flips).toEqual([true]);
    m.choose(0); // route A, unseen
    expect(m.getState()).toMatchObject({
      cursor: 2,
      skipping: false,
      settled: false,
    });
    expect(flips).toEqual([true, false]);
    vi.advanceTimersByTime(60_000);
    expect(m.getState().cursor).toBe(2); // shown normally, manual
    m.destroy();
  });

  it("a burst reaching a choice stops there with the off report; Tab on it arms skip for after the pick", () => {
    vi.useFakeTimers();
    const m = atReoffer();
    wheelBackTo(m, 0); // back before the decision, everything up to a-4 read
    const flips = watch(m);
    m.toggleSkip();
    vi.advanceTimersByTime(dwell * 4);
    expect(m.getState()).toMatchObject({ cursor: 1, skipping: false });
    expect(m.getState().choice).toMatchObject({ decisionId: "d1" });
    expect(flips).toEqual([true, false]);
    vi.advanceTimersByTime(60_000); // the pick never resumes it by itself
    m.toggleSkip();
    expect(flips).toEqual([true, false, true]);
    expect(m.getState().choice).toMatchObject({ decisionId: "d1" });
    m.choose(0);
    expect(m.getState()).toMatchObject({ cursor: 2, skipping: true });
    m.destroy();
  });

  it("auto-forward turned on at a choice runs after the pick; turned off there, the route waits", () => {
    vi.useFakeTimers();
    const on = machine(LONG_A);
    on.advance();
    on.advance(); // the choice
    on.setAutoAdvance(true);
    vi.advanceTimersByTime(60_000);
    expect(on.getState().choice).toMatchObject({ decisionId: "d1" });
    on.choose(0);
    expect(on.getState().cursor).toBe(2);
    vi.advanceTimersByTime(SETTINGS.minHoldMs); // a-1's own hold
    expect(on.getState().cursor).toBe(3);
    on.destroy();

    const off = machine(LONG_A, { auto: true });
    step(off);
    step(off);
    off.advance(); // the choice
    expect(off.getState().choice).toMatchObject({ decisionId: "d1" });
    off.setAutoAdvance(false);
    off.choose(0);
    vi.advanceTimersByTime(60_000);
    expect(off.getState().cursor).toBe(2);
    off.destroy();
  });

  it("chooseContinue answers like a pick: armed skip runs from where it lands", () => {
    vi.useFakeTimers();
    const m = machine(CANON);
    for (let press = 0; press < 3; press += 1) m.advance(); // fires d1
    m.choose(2); // route C, the continuing route
    m.advance(); // cont-2
    m.advance(); // off cont-2: joins at after-1, C completed
    m.advance(); // after-2
    wheelBackUntil(m, (s) => s.choice !== undefined);
    expect(m.getState().choice?.continueOption).toBe(true);
    const flips = watch(m);
    m.toggleSkip();
    m.chooseContinue();
    expect(m.getState()).toMatchObject({ cursor: 9, skipping: true });
    vi.advanceTimersByTime(dwell);
    expect(m.getState()).toMatchObject({ cursor: 10, skipping: false });
    expect(flips).toEqual([true, false]);
    m.destroy();
  });

  it("an answer landing where the story ends turns armed skip off at once", () => {
    vi.useFakeTimers();
    const m = machine(LONG_A);
    m.advance();
    m.advance(); // fires d1
    m.choose(1); // route B, the continuing route
    m.advance(); // off b-1: joins at after-1, the last item; B completed
    wheelBackUntil(m, (s) => s.choice !== undefined);
    expect(m.getState().choice?.continueOption).toBe(true);
    const flips = watch(m);
    m.toggleSkip();
    m.chooseContinue(); // lands on after-1, where the story ends
    expect(m.getState()).toMatchObject({ cursor: 7, skipping: false });
    expect(flips).toEqual([true, false]);
    m.destroy();
  });

  it("an answer that opens another choice keeps skip armed for that one", () => {
    vi.useFakeTimers();
    const m = machine(REOFFER);
    m.advance(); // outer fires on s0
    m.choose(0); // outer alt: s1
    m.advance(); // inner fires on s1
    m.choose(1); // inner cont: s3
    m.advance(); // off s3: inner joins past outer alt's end, outer re-offers
    expect(m.getState().choice?.decisionId).toBe("outer");
    wheelBackUntil(m, (s) => s.choice?.decisionId === "inner");
    expect(m.getState().choice?.continueOption).toBe(true);
    const flips = watch(m);
    m.toggleSkip();
    m.chooseContinue(); // ends outer alt too: the outer choice re-offers
    expect(m.getState().choice?.decisionId).toBe("outer");
    expect(m.getState().skipping).toBe(false);
    expect(flips).toEqual([true]);
    m.choose(0); // outer alt again, read: the burst runs
    expect(m.getState()).toMatchObject({ cursor: 1, skipping: true });
    expect(flips).toEqual([true]);
    m.destroy();
  });

  it.each([
    ["a wheel step back", (m: ReturnType<typeof machine>) => m.wheelBack()],
    [
      "a wheel step forward with nowhere to go",
      (m: ReturnType<typeof machine>) => m.wheelForward(),
    ],
    ["`u`", (m: ReturnType<typeof machine>) => m.jumpToUnseen()],
    [
      "a restore",
      (m: ReturnType<typeof machine>) => m.importContext(m.exportContext()),
    ],
    [
      "a map click on the decision",
      (m: ReturnType<typeof machine>) => m.showChoice(0),
    ],
  ])("%s leaving an armed choice unanswered turns skip off", (_name, leave) => {
    vi.useFakeTimers();
    const m = atReoffer();
    const flips = watch(m);
    m.toggleSkip();
    leave(m);
    expect(flips).toEqual([true, false]);
    expect(m.getState().skipping).toBe(false);
    // Whatever is on screen now, a pick from it (if any) runs no burst.
    if (m.getState().choice !== undefined) {
      m.choose(0);
      expect(m.getState().skipping).toBe(false);
    }
    expect(flips).toEqual([true, false]);
    m.destroy();
  });

  it("play-all: Tab during the countdown arms skip; the elapsed auto-pick runs it from the route entered", () => {
    vi.useFakeTimers();
    const m = atReoffer(ALL);
    // The re-offer under play-all picks the continuing route; back before
    // the decision, a fresh pass picks route A (read) again.
    wheelBackTo(m, 0);
    m.advance(); // 0 -> 1
    m.advance(); // fires: play-all counts down to route A
    const pick = m.getState().choice?.autoPick;
    expect(pick).toMatchObject({ routeIdx: 0, picked: false });
    const flips = watch(m);
    m.toggleSkip();
    expect(flips).toEqual([true]);
    vi.advanceTimersByTime(pick?.ms ?? 0); // the countdown runs as before
    expect(m.getState().choice?.autoPick?.picked).toBe(true);
    vi.advanceTimersByTime(AUTO_PICK_SHOW_MS);
    expect(m.getState().choice).toBeUndefined();
    expect(m.getState()).toMatchObject({ cursor: 2, skipping: true });
    expect(flips).toEqual([true]);
    m.destroy();
  });

  it("play-all: Space taking the auto-pick turns armed skip off", () => {
    vi.useFakeTimers();
    const m = atReoffer(ALL);
    wheelBackTo(m, 0);
    m.advance();
    m.advance(); // the countdown to route A
    const flips = watch(m);
    m.toggleSkip();
    m.advance(); // Space takes the pick at once, and stops skip
    expect(m.getState()).toMatchObject({ cursor: 2, skipping: false });
    expect(flips).toEqual([true, false]);
    m.destroy();
  });

  it("play-all: a burst its choice carries on through reports nothing until it stops", () => {
    vi.useFakeTimers();
    const m = machine(CANON, { settings: { ...ALL, skipAll: true } });
    const flips = watch(m);
    m.toggleSkip();
    expect(flips).toEqual([true]);
    for (let n = 0; n < 40 && m.getState().choice === undefined; n += 1)
      vi.advanceTimersByTime(dwell);
    expect(m.getState().choice?.autoPick?.picked).toBe(true);
    vi.advanceTimersByTime(AUTO_PICK_SHOW_MS);
    expect(m.getState().skipping).toBe(true); // the burst carries on
    expect(flips).toEqual([true]);
    m.advance(); // Space stops it
    expect(flips).toEqual([true, false]);
    m.destroy();
  });
});

describe("where a pure choice's close ends the story (docs/plan.md Phase 43)", () => {
  // lead-1 decide | p-1 p-2 | q-1 q-2
  //  0      1     | 2   3   | 4   5
  // A pure choice whose menu region runs to the array end. Played Q then P,
  // the all-played close ends the story on P's last item with Q's items
  // after it, which the format reaches only through the decision; played P
  // then Q, it ends on the array's last item. Every route kind a pure
  // choice allows: `ending`, `return`, and no `result` (an ending).
  const RESULTS = ["ending", "return", undefined] as const;
  function toEnd(result: (typeof RESULTS)[number]): Shape {
    const d1 = PURE.branches[0];
    return {
      items: ["lead-1", "decide", "p-1", "p-2", "q-1", "q-2"],
      branches: [
        {
          ...d1,
          routes: d1.routes.map((route) =>
            result === undefined ? route : { ...route, result },
          ),
        },
      ],
    };
  }

  /** Q then P: the story ends on P's last item, 3. */
  function endOnRoute(m: ReturnType<typeof machine>): void {
    m.advance(); // 0 -> 1
    m.advance(); // fires d1
    m.choose(1); // route Q: 4..5
    m.advance(); // 4 -> 5
    m.advance(); // the re-offer
    m.choose(0); // route P: 2..3
    m.advance(); // 2 -> 3
    m.advance(); // all played: the menu closes and the story ends
    expect(m.getState().cursor).toBe(3);
  }

  /** P then Q: the story ends on the array's last item, 5. */
  function endOnLast(m: ReturnType<typeof machine>): void {
    m.advance(); // 0 -> 1
    m.advance(); // fires d1
    m.choose(0); // route P: 2..3
    m.advance(); // 2 -> 3
    m.advance(); // the re-offer
    m.choose(1); // route Q: 4..5
    m.advance(); // 4 -> 5
    m.advance(); // all played: the menu closes and the story ends
    expect(m.getState().cursor).toBe(5);
  }

  /** A state with the cursor blanked, to compare the two ends. */
  const apartFromCursor = (state: MachineState) => ({ ...state, cursor: -1 });
  const ALL_SEEN = { unseenRoutes: 0, otherUnseen: false, nextUnseen: false };

  it.each(RESULTS)(
    "Space there moves nothing, with the array end's state and end card (result %s)",
    (result) => {
      const m = machine(toEnd(result));
      endOnRoute(m);
      const last = machine(toEnd(result));
      endOnLast(last);
      expect(apartFromCursor(m.getState())).toEqual(
        apartFromCursor(last.getState()),
      );
      for (let press = 0; press < 3; press += 1) {
        m.advance();
        last.advance();
      }
      expect(m.getState().cursor).toBe(3);
      expect(last.getState().cursor).toBe(5);
      expect(m.exportContext().stack).toEqual([]);
      expect(apartFromCursor(m.getState())).toEqual(
        apartFromCursor(last.getState()),
      );
      expect(m.getState()).toMatchObject({ settled: true, endCard: ALL_SEEN });
      expect(m.getState().choice).toBeUndefined();
      m.wheelForward(); // and the wheel stops there, as it already did
      expect(m.getState().cursor).toBe(3);
      m.destroy();
      last.destroy();
    },
  );

  it("Tab there does nothing and reports nothing, as at the array end", () => {
    vi.useFakeTimers();
    const m = machine(toEnd("ending"));
    endOnRoute(m);
    const last = machine(toEnd("ending"));
    endOnLast(last);
    const before = m.getState();
    const lastBefore = last.getState();
    const flips: boolean[] = [];
    m.onSkipChange((on) => flips.push(on));
    last.onSkipChange((on) => flips.push(on));
    m.toggleSkip();
    last.toggleSkip();
    vi.advanceTimersByTime(60_000);
    expect(m.getState()).toBe(before);
    expect(last.getState()).toBe(lastBefore);
    expect(flips).toEqual([]);
    expect(apartFromCursor(m.getState())).toEqual(
      apartFromCursor(last.getState()),
    );
    m.destroy();
    last.destroy();
  });

  it("a bookmark onto it under auto-forward stays there when its hold ends", () => {
    vi.useFakeTimers();
    const first = machine(toEnd("return"));
    endOnRoute(first);
    const stored = first.exportContext();
    first.destroy();
    const m = machine(toEnd("return"), { auto: true });
    m.importContext(stored); // an unsettled arrival: its hold is armed
    expect(m.getState()).toMatchObject({ cursor: 3, settled: false });
    vi.advanceTimersByTime(60_000);
    expect(m.getState()).toMatchObject({
      cursor: 3,
      settled: true,
      endCard: ALL_SEEN,
    });
    m.destroy();
  });

  it.each(RESULTS)(
    "a reload from the saved context main.ts passes back lands there, and Space stays (result %s)",
    async (result) => {
      const shape = toEnd(result);
      const { items, branches } = manifest(shape);
      const codec = createContextCodec(items, branches);
      const storage = createMemoryStorage();
      const first = machine(shape);
      endOnRoute(first);
      await storage.saveState({ ctx: codec.toSaved(first.exportContext()) });
      first.destroy();
      const m = createMachine({
        items,
        branches,
        settings: SETTINGS,
        ...resumeOptionsFor(await storage.loadState(), codec),
      });
      expect(m.getState()).toMatchObject({
        cursor: 3,
        settled: true,
        endCard: ALL_SEEN,
      });
      m.advance();
      expect(m.getState()).toMatchObject({ cursor: 3, settled: true });
      m.destroy();
    },
  );

  it("under play-all the end card shows there too, and Space stays", () => {
    vi.useFakeTimers();
    // lead-1 decide | p-1 p-2 | q-1
    //  0      1     | 2   3   | 4
    // Play-all plays the shorter Q first, so P's last item ends the story.
    const d1 = PURE.branches[0];
    const SHORT_Q: Shape = {
      items: ["lead-1", "decide", "p-1", "p-2", "q-1"],
      branches: [
        { ...d1, routes: [d1.routes[0], { ...d1.routes[1], end: "q-1" }] },
      ],
    };
    const m = machine(SHORT_Q, {
      settings: { ...SETTINGS, playAllRoutes: true },
    });
    // Space takes each auto-pick at once: Q, its re-offer, then P to its end.
    for (let press = 0; press < 7; press += 1) m.advance();
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: 0, routes: [0, 1] },
    ]);
    expect(m.getState()).toMatchObject({
      cursor: 3,
      settled: true,
      endCard: ALL_SEEN,
    });
    m.advance();
    expect(m.getState()).toMatchObject({ cursor: 3, endCard: ALL_SEEN });
    m.destroy();
  });

  it("`u` there reaches unseen content in the menu region, as Space reads nothing on", () => {
    // lead-1 decide | p-1 p-2 | gap | q-1 q-2
    //  0      1     | 2   3   | 4   | 5   6
    // An item between the routes, in neither: only `u` reaches it.
    const GAP: Shape = {
      items: ["lead-1", "decide", "p-1", "p-2", "gap", "q-1", "q-2"],
      branches: PURE.branches,
    };
    const m = machine(GAP);
    m.advance(); // 0 -> 1
    m.advance(); // fires d1
    m.choose(1); // route Q: 5..6
    m.advance(); // 5 -> 6
    m.advance(); // the re-offer
    m.choose(0); // route P: 2..3
    m.advance(); // 2 -> 3
    m.advance(); // all played: the menu closes and the story ends
    expect(m.getState()).toMatchObject({
      cursor: 3,
      endCard: { unseenRoutes: 0, otherUnseen: true, nextUnseen: true },
    });
    m.advance();
    expect(m.getState().cursor).toBe(3);
    m.jumpToUnseen();
    expect(m.getState().cursor).toBe(4);
    m.destroy();
  });
});

describe("opening at an item from the URL (docs/plan.md Phase 46)", () => {
  it("a main-line item: the load starts there as a forward read, and nothing before it is seen", () => {
    const m = machine(CANON, { startAt: 1 });
    expect(m.getState()).toMatchObject({
      cursor: 1,
      transition: "advance", // its media plays, wherever the seen edge is
      settled: false,
      skipping: false,
    });
    expect(m.getState().choice).toBeUndefined();
    expect(m.visitedList()).toEqual([1]); // item 0 was never shown
    expect(m.seenSince(0)).toEqual([1]); // the next save writes just it
    expect(m.exportContext().stack).toEqual([]);
    m.advance();
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });

  it("an item in a nested route: its frames open, its routes are played and picked, Space carries on inside the route", () => {
    const m = machine(NESTED, { startAt: 6 }); // y-1: Y inside A
    const ctx = m.exportContext();
    expect(m.getState()).toMatchObject({ cursor: 6, transition: "advance" });
    expect(ctx.stack).toEqual([
      { decision: 0, route: 0 },
      { decision: 1, route: 1 },
    ]);
    expect(ctx.playedRoutes).toEqual([
      { decision: 0, routes: [0] },
      { decision: 1, routes: [1] },
    ]);
    expect(ctx.passRoutes).toEqual(ctx.playedRoutes);
    expect(ctx.lastPicks).toEqual([
      { decision: 0, route: 0 },
      { decision: 1, route: 1 },
    ]);
    expect(m.visitedList()).toEqual([6]);
    m.advance(); // 6 -> 7, Y's end
    expect(m.getState().cursor).toBe(7);
    m.advance(); // Y continues: it joins A at a-cont
    expect(m.getState().cursor).toBe(8);
    expect(m.exportContext().stack).toEqual([{ decision: 0, route: 0 }]);
    m.advance(); // on inside A
    expect(m.getState().cursor).toBe(9);
    m.destroy();
  });

  it("a decision's `after` item: Space opens the choice", () => {
    const m = machine(CANON, { startAt: 2 });
    expect(m.getState()).toMatchObject({ cursor: 2, settled: false });
    m.advance();
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice?.decisionId).toBe("d1");
    m.destroy();
    const nested = machine(NESTED, { startAt: 3 }); // a-decide, inside A
    expect(nested.exportContext().stack).toEqual([{ decision: 0, route: 0 }]);
    nested.advance();
    expect(nested.getState().choice?.decisionId).toBe("d2");
    nested.destroy();
  });

  it("play all routes behaves as always from there: a route's end offers the next unplayed route", () => {
    const m = machine(CANON, {
      startAt: 4, // a-2, route A's end
      settings: { ...SETTINGS, playAllRoutes: true },
    });
    m.advance(); // off A's end: d1 re-offers, play-all counting down to B
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(1);
    m.destroy();
  });

  it("replaces the restored place and keeps the rest of the restore", () => {
    const m = machine(CANON, {
      resumeContext: {
        lastShown: 2,
        visited: [0, 1, 2, 7, 8, 9, 10],
        stack: [],
        playedRoutes: [{ decision: 0, routes: [2] }],
        completedRoutes: [{ decision: 0, routes: [2] }],
        lastPicks: [{ decision: 0, route: 2 }],
        choice: 0, // an open choice: not reopened on a URL start
      },
      startAt: 3, // a-1, route A
    });
    const ctx = m.exportContext();
    expect(m.getState()).toMatchObject({ cursor: 3, transition: "advance" });
    expect(m.getState().choice).toBeUndefined();
    expect(m.visitedList()).toEqual([0, 1, 2, 3, 7, 8, 9, 10]);
    expect(m.seenSince(0)).toEqual([3]); // the restored set is not logged
    expect(ctx.stack).toEqual([{ decision: 0, route: 0 }]);
    expect(ctx.playedRoutes).toEqual([{ decision: 0, routes: [0, 2] }]);
    expect(ctx.completedRoutes).toEqual([{ decision: 0, routes: [2] }]);
    expect(ctx.lastPicks).toEqual([{ decision: 0, route: 0 }]);
    m.advance(); // 3 -> 4
    m.advance(); // A's end re-offers d1, C completed: the return row too
    expect(m.getState().choice).toMatchObject({
      decisionId: "d1",
      continueOption: true,
    });
    m.destroy();
  });

  it.each([
    ["before the first item", -1],
    ["past the last item", 11],
    ["not a whole number", 1.5],
    ["NaN", Number.NaN],
  ])("an index %s is ignored: the load starts as without one", (_name, at) => {
    const fresh = machine(CANON, { startAt: at });
    expect(fresh.getState()).toMatchObject({ cursor: 0, transition: "nav" });
    expect(fresh.visitedList()).toEqual([0]);
    fresh.destroy();
    const resumed = machine(CANON, {
      resumeContext: {
        lastShown: 2,
        visited: [0, 1, 2],
        stack: [],
        playedRoutes: [],
        choice: 0,
      },
      startAt: at,
    });
    expect(resumed.getState()).toMatchObject({ cursor: 2, settled: true });
    expect(resumed.getState().choice?.decisionId).toBe("d1");
    resumed.destroy();
  });
});
