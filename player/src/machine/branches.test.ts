import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachine, HISTORY_CAP, INTERSTITIAL_MS } from "./machine";
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
 * Wheel back until the cursor reaches `index`. The wheel walks the reading
 * history, choice screens included, so the notch count depends on the path
 * read; the tests name the target instead of counting notches. A choice
 * screen recorded over `index` is reached before the item itself.
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

/**
 * The reading history as short strings, oldest first: `index`, or
 * `index:choice#decision` for a choice screen, then ` [decision/route ...]`
 * for the route frames open under it.
 */
function screens(m: { exportContext(): MachineContext }): string[] {
  return (m.exportContext().history ?? []).map((entry) => {
    const frames =
      entry.stack.length === 0
        ? ""
        : ` [${entry.stack.map((f) => `${f.decision}/${f.route}`).join(" ")}]`;
    const screen =
      entry.decision === undefined
        ? `${entry.index}`
        : `${entry.index}:choice#${entry.decision}`;
    return `${screen}${frames}`;
  });
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

  it("every key command but choose, chooseContinue and the history moves is inert while a choice is open", () => {
    // The wheel and `e` move through the reading history (docs/plan.md,
    // "History rollback spec") — pinned in their own describe below.
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires
    const before = m.getState();
    m.advance();
    m.advance();
    m.toggleSkip();
    m.jumpToEnd(); // the choice screen IS the history's end: a no-op
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

describe("the reading history replays decisions (docs/plan.md, History rollback spec)", () => {
  it("records every screen in order, each choice screen as its own entry", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires d1 over `decide`
    m.choose(1); // route B
    step(m); // 5 -> 6, B's end
    step(m); // off B's end: the re-offer over b-2
    m.choose(2); // route C
    expect(screens(m)).toEqual([
      "0",
      "1",
      "2",
      "2:choice#0",
      "5 [0/1]",
      "6 [0/1]",
      "6:choice#0",
      "7 [0/2]",
    ]);
    expect(m.exportContext().historyPos).toBe(7);
    m.destroy();
  });

  it("the wheel replays the record exactly: choice screens in full, frames restored", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires
    m.choose(0); // route A at 3
    const played = m.exportContext().playedRoutes;
    m.wheelBack(); // the choice screen, as it was shown
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
    });
    expect(m.exportContext().stack).toEqual([]);
    m.wheelBack(); // `decide` before the overlay opened
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice).toBeUndefined();
    m.wheelForward(); // the choice screen again
    expect(m.getState().choice?.decisionId).toBe("d1");
    m.wheelForward(); // route A's first item, inside route A again
    expect(m.getState().cursor).toBe(3);
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().stack).toEqual([{ decision: 0, route: 0 }]);
    // Nothing was answered or marked played by any of it.
    expect(m.exportContext().playedRoutes).toEqual(played);
    expect(screens(m)).toHaveLength(5);
    m.destroy();
  });

  it("Space from a rolled-back point replays the record while it matches", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires
    m.choose(0); // route A at 3
    step(m); // 3 -> 4
    const recorded = screens(m);
    wheelBackUntil(m, (state) => state.cursor === 2 && !state.choice);
    m.advance(); // settle `decide`: the decision fires, as recorded
    expect(m.getState().choice?.decisionId).toBe("d1");
    m.choose(0); // the recorded pick
    expect(m.getState().cursor).toBe(3);
    step(m); // 3 -> 4
    expect(screens(m)).toEqual(recorded); // nothing appended, nothing dropped
    expect(m.exportContext().historyPos).toBe(recorded.length - 1);
    m.destroy();
  });

  it("a different pick at a replayed choice screen forks: the recorded future is dropped", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires
    m.choose(0); // route A
    step(m); // 3 -> 4
    wheelBackUntil(m, (state) => state.choice !== undefined);
    expect(m.getState().cursor).toBe(2);
    m.choose(1); // a REAL pick from the replayed screen: route B
    expect(m.getState().cursor).toBe(5);
    expect(screens(m)).toEqual(["0", "1", "2", "2:choice#0", "5 [0/1]"]);
    m.wheelForward(); // nothing recorded ahead any more
    expect(m.getState().cursor).toBe(5);
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: 0, routes: [0, 1] },
    ]);
    m.destroy();
  });

  it("a replayed choice screen holds timing and is inert to Space, tab and bookmarks", () => {
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

  it("`e` shows the last entry exactly — a choice screen included — and is a no-op there", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance(); // fires: the choice screen is the history's last entry
    m.wheelBack();
    m.wheelBack(); // item 1
    expect(m.getState().cursor).toBe(1);
    m.jumpToEnd();
    const end = m.getState();
    expect(end.cursor).toBe(2);
    expect(end.choice?.decisionId).toBe("d1");
    m.jumpToEnd();
    expect(m.getState()).toBe(end);
    m.choose(2); // the end's choice screen answers like the live one
    expect(m.getState().cursor).toBe(7);
    m.destroy();
  });

  it("a replayed choice screen applies the return-row rule as it stands now", () => {
    // The row exists only once the continuing route has COMPLETED
    // (docs/plan.md Phase 18): the first screen was recorded before that,
    // and replaying it after C finished shows the row.
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
    wheelBackUntil(m, (state) => state.choice !== undefined);
    expect(m.getState().cursor).toBe(6); // the re-offer over b-2
    expect(m.getState().choice?.continueOption).toBe(true);
    m.wheelBack();
    wheelBackUntil(m, (state) => state.choice !== undefined);
    expect(m.getState().cursor).toBe(2); // the first screen over `decide`
    expect(m.getState().choice?.continueOption).toBe(true);
    m.chooseContinue(); // a real pick: forks the record at the join
    expect(m.getState().cursor).toBe(9);
    expect(screens(m).slice(-2)).toEqual(["2:choice#0", "9"]);
    m.destroy();
  });

  it("a pure-choice decision never offers a return, live or replayed", () => {
    const m = machine(PURE);
    step(m); // 0 -> 1
    m.advance(); // fires
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.choose(0); // route P
    step(m); // 2 -> 3
    step(m); // P's end: Q unplayed, so the decision re-opens
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.wheelBack();
    wheelBackUntil(m, (state) => state.choice !== undefined);
    expect(m.getState().cursor).toBe(1);
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.destroy();
  });

  it("playAllRoutes: auto-picks are recorded, the interstitial is not", () => {
    vi.useFakeTimers();
    const auto = { ...SETTINGS, playAllRoutes: true };
    const m = machine(CANON, { settings: auto });
    step(m);
    step(m); // cursor 2
    m.advance(); // the settle auto-picks route A: no overlay, no choice entry
    expect(m.getState().cursor).toBe(3);
    step(m); // 3 -> 4, A's end
    step(m); // off A's end: the interstitial holds
    expect(m.getState().interstitial).toBeDefined();
    expect(screens(m)).toEqual(["0", "1", "2", "3 [0/0]", "4 [0/0]"]);
    vi.advanceTimersByTime(INTERSTITIAL_MS); // enters route B
    expect(m.getState().cursor).toBe(5);
    expect(screens(m).slice(-1)).toEqual(["5 [0/1]"]);
    m.wheelBack(); // back to A's end: the screen before the hold
    expect(m.getState().cursor).toBe(4);
    expect(m.getState().interstitial).toBeUndefined();
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
    wheelBackTo(m, 2); // back to the recorded choice screen over `decide`
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.continueOption).toBe(true); // C completed once
    m.choose(0); // route A again from the replayed screen
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
  // NAVIGATION does not mark a route: a wheel replay of a choice screen, or
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
    // back to the branch. The history never held the other spans, and the
    // replayed overlay marks only the route taken.
    const m = manual(CANON);
    m.advance(); // 0 -> 1
    m.advance(); // 1 -> 2 (`decide`)
    m.advance(); // the forward settle fires d1
    m.choose(2); // route C, the continuing route
    m.advance(); // 7 -> 8
    m.advance(); // off C's end: the continuing route proceeds to `after-1`
    expect(m.getState().cursor).toBe(9);
    wheelBackTo(m, 2); // onto the recorded choice screen over `decide`
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(seenFlags(m)).toEqual([false, false, true]);
    // The wheel replays only what was shown: route A's items (3, 4) and
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
    fired.wheelForward(); // the screen replayed, then left again
    expect(seenFlags(fired)).toEqual([false, false, false]);
    fired.wheelBack();
    expect(fired.getState().choice).toBeUndefined();
    expect(fired.exportContext().playedRoutes).toEqual([]);
    fired.destroy();
  });

  it("wheeling back replays the choice screen, not another route's span; playing it marks it", () => {
    const m = manual(CANON);
    m.advance();
    m.advance();
    m.advance(); // fires d1
    m.choose(2); // route C at 7
    m.wheelBack(); // the recorded choice screen: B's and A's spans unseen
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
    // of the decision, replayed or fired, stays routes-only.
    const m = manual(CANON);
    m.advance(); // 0 -> 1
    m.advance(); // 1 -> 2 (`decide`)
    m.advance(); // fires d1
    m.choose(2); // enter route C (the continuing route) at 7
    expect(m.getState().cursor).toBe(7);
    wheelBackTo(m, 2); // the recorded choice screen, abandoning route C
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.continueOption).toBeUndefined(); // entry ≠ completion
    m.wheelBack(); // `decide` before the overlay
    expect(m.getState().choice).toBeUndefined();
    m.advance(); // the press FIRES the decision again
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.continueOption).toBeUndefined();
    m.destroy();
  });

  it("finish the continuing route once: every later re-offer and replay has the row", () => {
    const m = manual(CANON);
    m.advance();
    m.advance();
    m.advance(); // fires d1
    m.choose(2); // route C at 7
    m.advance(); // 7 -> 8
    m.advance(); // C completes: joins the aftermath at 9
    expect(m.getState().cursor).toBe(9);
    wheelBackTo(m, 2); // back to the recorded choice screen
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().choice?.continueOption).toBe(true); // the rule as it stands now
    m.choose(0); // route A from the replayed screen...
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

  it("wheel forward clamps at the end of the history, not at the array end", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(2); // route C
    step(m); // 7 -> 8, the history's end
    m.wheelBack();
    m.wheelBack(); // 8 -> 7 -> the choice screen over `decide`
    for (let press = 0; press < 6; press += 1) m.wheelForward(); // -> 8 plus clamps
    expect(m.getState().cursor).toBe(8);
    m.wheelForward(); // beyond the ceiling: blocked
    expect(m.getState().cursor).toBe(8);
    m.destroy();
  });

  it("a wheel step back from a route shows the recorded choice screen; crossing it consumes nothing", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(0); // inside route A at 3
    m.wheelBack(); // the choice screen recorded over `decide`: shown, unanswered
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
    m.wheelBack(); // 7, then the recorded choice screen over 2
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
    m.wheelForward(); // the history's end: B (5, 6) and C (7, 8) never shown
    expect(m.getState().cursor).toBe(4);
    for (const index of [5, 6, 7, 8])
      expect(m.visitedList()).not.toContain(index);
    m.destroy();
  });
});

describe("`e` goes to the end of the history (docs/plan.md, History rollback spec)", () => {
  // `e` shows the history's last entry, a no-op there. It no longer jumps
  // to unseen content (the old cases a/b/c) or looks up an ending; until
  // the end card lands the ending hint just says content is unseen.
  it("from a rolled-back point inside a route, `e` returns to the end and reveals nothing", () => {
    const m = machine(CANON);
    step(m);
    step(m);
    m.advance();
    m.choose(0); // route A at 3, span 3..4
    m.wheelBack(); // the choice screen
    m.wheelBack(); // `decide`: outside the span
    expect(m.getState().cursor).toBe(2);
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
    expect(m.getState().endingHint).toBe(true);
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
    step(m); // 0 -> 1: the history's end
    m.wheelBack(); // roll back to 0
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

  it("a legacy all-seen save restores a one-entry history: `e` stays, no ending lookup", () => {
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
    expect(screens(m)).toEqual(["0"]);
    m.jumpToEnd();
    expect(m.getState().cursor).toBe(0);
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
      // The reading history, the choice screen included, and the entry on
      // screen (docs/plan.md, "History rollback spec").
      history: [
        { index: 0, stack: [] },
        { index: 1, stack: [] },
        { index: 2, stack: [] },
        { index: 2, stack: [], decision: 0 },
        { index: 3, stack: [{ decision: 0, route: 0 }] },
      ],
      historyPos: 4,
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

describe("the reading history persists and jumps append (docs/plan.md, History rollback spec)", () => {
  /** Read CANON into route A's last item: 0, 1, 2, the screen, 3, 4. */
  const readIntoRouteA = (m: ReturnType<typeof machine>) => {
    step(m);
    step(m);
    m.advance(); // fires
    m.choose(0);
    step(m); // 3 -> 4
  };

  it("a JSON round trip restores the record and the entry on screen; the wheel rolls back across it", () => {
    const first = machine(CANON);
    readIntoRouteA(first);
    first.wheelBack(); // roll back to 3 before saving
    const recorded = screens(first);
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
    expect(screens(second)).toEqual(recorded);
    expect(second.exportContext().historyPos).toBe(4);
    expect(second.exportContext().stack).toEqual([{ decision: 0, route: 0 }]);
    second.wheelBack(); // the choice screen, across the reload
    expect(second.getState().choice?.decisionId).toBe("d1");
    second.jumpToEnd(); // the end of the restored record
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

  it("a save without a history restores a one-entry history at its landing", () => {
    const m = machine(CANON, {
      resumeContext: {
        lastShown: 8,
        visited: [0, 1, 2, 7, 8],
        stack: [{ decision: 0, route: 2 }],
        playedRoutes: [{ decision: 0, routes: [2] }],
      },
    });
    expect(screens(m)).toEqual(["8 [0/2]"]);
    expect(m.exportContext().historyPos).toBe(0);
    m.wheelBack(); // nothing behind the landing
    expect(m.getState().cursor).toBe(8);
    step(m); // reading appends: the route ends into the aftermath
    expect(screens(m)).toEqual(["8 [0/2]", "9"]);
    m.destroy();
  });

  it("foreign history entries are dropped; with none usable the landing starts it", () => {
    const base = {
      lastShown: 4,
      visited: [0, 1, 2, 3, 4],
      stack: [{ decision: 0, route: 0 }],
      playedRoutes: [{ decision: 0, routes: [0] }],
    };
    const m = machine(CANON, {
      resumeContext: {
        ...base,
        history: [
          { index: 99, stack: [] }, // off this manifest
          { index: 1, stack: [{ decision: 7, route: 0 }] }, // no such decision
          { index: 2, stack: [], decision: 5 }, // no such decision
          { index: 3, stack: [{ decision: 0, route: 0 }] },
        ],
        historyPos: 7, // clamps to the record
      },
    });
    expect(screens(m)).toEqual(["3 [0/0]"]);
    expect(m.getState().cursor).toBe(3);
    m.destroy();
    const fallback = machine(CANON, {
      resumeContext: { ...base, history: [{ index: -1, stack: [] }] },
    });
    expect(screens(fallback)).toEqual(["4 [0/0]"]);
    fallback.destroy();
  });

  it(`is capped at HISTORY_CAP (${HISTORY_CAP}) entries, oldest dropped first`, () => {
    const long = Array.from({ length: HISTORY_CAP + 7 }, (_, i) => ({
      index: i % 2, // 0, 1, 0, 1, ...
      stack: [],
    }));
    const m = createMachine({
      items: manifest(CANON).items,
      branches: manifest(CANON).branches,
      settings: SETTINGS,
      resumeContext: {
        lastShown: 1,
        visited: [0, 1],
        stack: [],
        playedRoutes: [],
        history: long,
      },
    }); // manual: one press is one step
    expect(screens(m)).toHaveLength(HISTORY_CAP);
    expect(m.getState().cursor).toBe(0); // the last stored entry, (HISTORY_CAP + 6) % 2
    m.advance(); // a fork appends; the cap drops the oldest entry
    const record = screens(m);
    expect(record).toHaveLength(HISTORY_CAP);
    expect(record.slice(-2)).toEqual(["0", "1"]);
    expect(m.exportContext().historyPos).toBe(HISTORY_CAP - 1);
    m.destroy();
  });

  it("a bookmark restore appends its landing to THIS history and ignores a stored one", () => {
    const m = machine(CANON);
    readIntoRouteA(m);
    const before = screens(m);
    m.importContext({
      lastShown: 1,
      visited: [0, 1],
      stack: [],
      playedRoutes: [],
      history: [{ index: 9, stack: [] }],
      historyPos: 0,
    });
    expect(m.getState().cursor).toBe(1);
    expect(screens(m)).toEqual([...before, "1"]);
    m.wheelBack(); // the screen before the jump
    expect(m.getState().cursor).toBe(4);
    m.destroy();
  });

  it("goTo from a rolled-back point appends at the end, keeping the recorded future", () => {
    const m = machine(CANON);
    readIntoRouteA(m);
    const before = screens(m);
    m.wheelBack();
    m.wheelBack();
    m.wheelBack(); // `decide`
    m.goTo(0);
    expect(screens(m)).toEqual([...before, "0"]); // under the frames it left
    expect(m.exportContext().historyPos).toBe(before.length);
    m.destroy();
  });
});

describe("scrolling back shows every choice screen in the order seen (docs/plan.md, History rollback spec)", () => {
  // The user's scroll: back from the story's end must show exactly what was
  // seen going forward — every choice screen (first fires and route-end
  // re-offers, nested ones included) as its own waypoint, with the current
  // seen marks and return-row rule — and change no route context: a wheel
  // step is browsing, not answering.
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
      stack: m.exportContext().stack,
    };
  };
  /** Wheel back to the history's start, collecting every choice screen. */
  const choiceScreensBack = (m: ReturnType<typeof manual>) => {
    const opened: unknown[] = [];
    for (let notch = 0; notch < 64; notch += 1) {
      const before = m.exportContext().historyPos;
      m.wheelBack();
      if (m.exportContext().historyPos === before) break;
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
    m.wheelBack(); // the recorded choice screen over `decide`
    expect(view(m)).toEqual({
      cursor: 2,
      id: "d1",
      seen: [false, false, true],
      returns: true, // C completed once: the row is offered here too
      stack: [],
    });
    m.wheelBack(); // stepping away consumes nothing
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: 0, routes: [2] },
    ]);
    m.destroy();
  });

  it("nested: re-offers and first fires surface in reverse reading order", () => {
    const m = manual(NESTED);
    m.advance();
    m.advance(); // 0 -> 1 (`decide`)
    m.advance(); // fires d1
    m.choose(0); // route A: 2..9
    m.advance(); // 2 -> 3 (`a-decide`)
    m.advance(); // fires d2
    m.choose(0); // route X: 4..5
    m.advance(); // 4 -> 5
    m.advance(); // X's end re-opens d2
    m.choose(1); // route Y: 6..7
    m.advance(); // 6 -> 7
    m.advance(); // Y completes and rejoins A at `a-cont`, 8
    m.advance(); // 8 -> 9
    m.advance(); // A's end re-opens d1
    m.choose(2); // route C: 12, the continuing route
    m.advance(); // C completes and joins at `after-1`, 13 — the end
    expect(m.getState().cursor).toBe(13);
    expect(m.exportContext().stack).toEqual([]);
    const outer = { seen: [true, false, true], returns: true, stack: [] };
    const inner = {
      seen: [true, true],
      returns: true, // Y, the inner continuing route, completed
      stack: [{ decision: 0, route: 0 }], // inside route A, as shown
    };
    expect(choiceScreensBack(m)).toEqual([
      { cursor: 9, id: "d1", ...outer }, // A's end re-offer
      { cursor: 5, id: "d2", ...inner }, // X's end re-offer
      { cursor: 3, id: "d2", ...inner }, // d2's first fire
      { cursor: 1, id: "d1", ...outer }, // d1's first fire
    ]);
    expect(m.getState().cursor).toBe(0);
    m.destroy();
  });

  it("an all-played pure choice that CLOSED: its screens replay as they were shown", () => {
    // The CLOSE rule governs the forward flow (docs/plan.md Phase 13); a
    // scroll back shows the screens the reader saw on the way.
    const m = manual(PURE);
    m.advance(); // 0 -> 1 (`decide`)
    m.advance(); // fires d1
    m.choose(1); // route Q: 4..5
    m.advance(); // 4 -> 5
    m.advance(); // Q's end re-opens d1: P is unplayed
    m.choose(0); // route P: 2..3
    m.advance(); // 2 -> 3
    m.advance(); // P's end, all routes played: the decision CLOSES past the region
    expect(m.getState().cursor).toBe(6);
    expect(m.getState().choice).toBeUndefined();
    const closed = { id: "d1", seen: [true, true], returns: false, stack: [] };
    expect(choiceScreensBack(m)).toEqual([
      { cursor: 5, ...closed }, // Q's end re-offer
      { cursor: 1, ...closed }, // the first fire
    ]);
    m.destroy();
  });

  it("a pick from a replayed completed screen enters the route exactly like a re-selection", () => {
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
    m.choose(1); // route Q again from the replayed first screen
    expect(m.getState().cursor).toBe(4); // Q's first item, entered
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().stack).toEqual([{ decision: 0, route: 1 }]);
    m.destroy();
  });

  it("playAllRoutes: a recorded choice screen replays like any entry and resolves nothing", () => {
    // The screen was recorded before play-all came on; the wheel shows the
    // record exactly, and play-all answers only decisions that FIRE.
    const m = manual(CANON);
    m.advance();
    m.advance();
    m.advance(); // fires d1
    m.choose(2); // route C, the continuing route
    m.advance(); // 7 -> 8
    m.advance(); // joins at `after-1`, 9
    m.setSettings({ ...SETTINGS, playAllRoutes: true });
    wheelBackTo(m, 2); // the recorded screen over `decide`
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

describe("the wheel leaves any choice screen for the adjacent history entry", () => {
  // User report (Phase 18): scroll wheel back did nothing on a fired choice
  // and on a route-end re-offer. Only keys choose; a wheel notch moves
  // through the history, answering nothing.
  const manual = (shape: Shape) => {
    const m = manifest(shape);
    return createMachine({
      items: m.items,
      branches: m.branches,
      settings: SETTINGS,
    });
  };

  it("a fired choice: a wheel back shows the item before it; forward re-shows it", () => {
    const m = manual(CANON);
    m.advance(); // 0 -> 1
    m.advance(); // 1 -> 2 (`decide`)
    m.advance(); // fires d1
    const fired = m.getState().choice;
    m.wheelBack();
    expect(m.getState().cursor).toBe(2); // `decide` before the overlay opened
    expect(m.getState().choice).toBeUndefined();
    expect(m.exportContext().playedRoutes).toEqual([]);
    m.wheelForward(); // the same screen again
    expect(m.getState().choice).toEqual(fired);
    m.destroy();
  });

  it("a fired choice at the history's end: a wheel forward is blocked and it stays", () => {
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
    const recorded = screens(m);
    m.advance(); // A's end re-offers again, exactly as recorded
    expect(m.getState().choice?.decisionId).toBe("d1");
    expect(m.getState().cursor).toBe(4);
    expect(screens(m)).toEqual(recorded);
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

describe("the ending hint (docs/plan.md Phase 18, bullet 6)", () => {
  const manual = (shape: Shape) => {
    const m = manifest(shape);
    return createMachine({
      items: m.items,
      branches: m.branches,
      settings: SETTINGS,
    });
  };

  it("shows on an ending while content is unseen, hides under a choice, and is gone once all is seen", () => {
    const m = manual(PURE);
    m.advance(); // 0 -> 1
    m.advance(); // fires d1
    m.choose(1); // route Q: 4..5, an ending route
    expect(m.getState().endingHint).toBeUndefined(); // not an ending item
    m.advance(); // 4 -> 5: Q's last item, an ending
    expect(m.getState().endingHint).toBe(true); // P and the tail are unseen
    m.advance(); // the re-offer opens: the overlay owns the screen
    expect(m.getState().choice).toBeDefined();
    expect(m.getState().endingHint).toBeUndefined();
    m.choose(0); // route P: 2..3
    m.advance(); // 2 -> 3: P's end, also an ending; the tail is unseen
    expect(m.getState().endingHint).toBe(true);
    m.advance(); // all routes played: closes past the region, onto 6
    m.advance(); // 6 -> 7, the array end: now everything has been seen
    expect(m.getState().cursor).toBe(7);
    expect(m.getState().endingHint).toBeUndefined();
    m.destroy();
  });

  it("the array end with an unplayed route behind it shows the hint", () => {
    const m = manual(CANON);
    m.advance();
    m.advance();
    m.advance(); // fires d1
    m.choose(2); // route C, continuing: joins at 9
    m.advance(); // 7 -> 8
    m.advance(); // joins at 9
    m.advance(); // 9 -> 10, the array end; A and B are unseen
    expect(m.getState().cursor).toBe(10);
    expect(m.getState().endingHint).toBe(true);
    m.destroy();
  });
});

describe("play-all back-in-time interstitial (docs/plan.md Phase 18, bullet 7)", () => {
  const playAll = (shape: Shape, items?: Item[]) => {
    const m = manifest(shape);
    return createMachine({
      items: items ?? m.items,
      branches: m.branches,
      settings: { ...SETTINGS, playAllRoutes: true },
    }); // manual presses: each step is explicit
  };

  it("a route end held for INTERSTITIAL_MS shows the decision, seen marks, and the next route", () => {
    vi.useFakeTimers();
    const m = playAll(CANON);
    m.advance(); // 0 -> 1
    m.advance(); // 1 -> 2 (`decide`)
    m.advance(); // fires: play-all enters route A at 3
    expect(m.getState().cursor).toBe(3);
    expect(m.getState().interstitial).toBeUndefined(); // the first pick: no jump back
    m.advance(); // 3 -> 4
    m.advance(); // off A's end: hold the interstitial before B
    expect(m.getState().cursor).toBe(4);
    expect(m.getState().interstitial).toEqual({
      decisionId: "d1",
      prompt: CANON.branches[0].prompt,
      routes: [
        { routeIdx: 0, id: "r-a", label: "Route A", seen: true },
        { routeIdx: 1, id: "r-b", label: "Route B", seen: false },
        { routeIdx: 2, id: "r-c", label: "Route C", seen: false },
      ],
      fromRouteIdx: 0,
      toRouteIdx: 1,
    });
    vi.advanceTimersByTime(INTERSTITIAL_MS - 1);
    expect(m.getState().cursor).toBe(4);
    vi.advanceTimersByTime(1);
    expect(m.getState().interstitial).toBeUndefined();
    expect(m.getState().cursor).toBe(5); // route B's first item
    expect(m.exportContext().stack).toEqual([{ decision: 0, route: 1 }]);
    m.destroy();
  });

  it("a press ends the hold early; pause freezes it and resume restarts it", () => {
    vi.useFakeTimers();
    const m = playAll(CANON);
    for (let press = 0; press < 5; press += 1) m.advance(); // into the hold before B
    expect(m.getState().interstitial?.toRouteIdx).toBe(1);
    m.pause();
    vi.advanceTimersByTime(INTERSTITIAL_MS * 2);
    expect(m.getState().interstitial).toBeDefined(); // frozen behind help
    m.resume();
    vi.advanceTimersByTime(INTERSTITIAL_MS - 1);
    expect(m.getState().interstitial).toBeDefined();
    m.advance(); // the reader's press: enter now
    expect(m.getState().interstitial).toBeUndefined();
    expect(m.getState().cursor).toBe(5);
    vi.advanceTimersByTime(INTERSTITIAL_MS); // the cancelled hold fires nothing
    expect(m.getState().cursor).toBe(5);
    m.destroy();
  });

  it("carries the `after` item's text as context when it has one", () => {
    vi.useFakeTimers();
    const shaped = manifest(CANON);
    const items = shaped.items.map((item) =>
      item.id === "decide" ? { ...item, text: "Where now?" } : item,
    );
    const m = playAll(CANON, items);
    for (let press = 0; press < 5; press += 1) m.advance();
    expect(m.getState().interstitial?.context).toBe("Where now?");
    m.destroy();
  });

  it("the continuing route's end joins with no interstitial", () => {
    vi.useFakeTimers();
    const m = playAll(CANON);
    for (let press = 0; press < 5; press += 1) m.advance(); // hold before B
    vi.advanceTimersByTime(INTERSTITIAL_MS); // B at 5
    m.advance(); // 5 -> 6
    m.advance(); // off B: hold before C, the continuing route
    expect(m.getState().interstitial?.toRouteIdx).toBe(2);
    vi.advanceTimersByTime(INTERSTITIAL_MS); // C at 7
    m.advance(); // 7 -> 8
    m.advance(); // off C: joins at `after-1` directly
    expect(m.getState().interstitial).toBeUndefined();
    expect(m.getState().cursor).toBe(9);
    m.destroy();
  });
});

describe("interstitial context and play-all hint rules (docs/plan.md Phase 18)", () => {
  it("falls back to the nearest earlier line when `after` has no text", () => {
    vi.useFakeTimers();
    const shaped = manifest(CANON);
    const items = shaped.items.map((item) =>
      item.id === "lead-1" ? { ...item, text: "Before it all." } : item,
    );
    const m = createMachine({
      items,
      branches: shaped.branches,
      settings: { ...SETTINGS, playAllRoutes: true },
    });
    for (let press = 0; press < 5; press += 1) m.advance();
    expect(m.getState().interstitial?.context).toBe("Before it all.");
    m.destroy();
  });

  it("play-all shows no ending hint on a route ending (it carries on), nor during the hold", () => {
    vi.useFakeTimers();
    const shaped = manifest(PURE);
    const m = createMachine({
      items: shaped.items,
      branches: shaped.branches,
      settings: { ...SETTINGS, playAllRoutes: true },
    });
    m.advance(); // 0 -> 1
    m.advance(); // fires: enters route P at 2
    m.advance(); // 2 -> 3, P's last item: an ending
    expect(m.getState().cursor).toBe(3);
    expect(m.getState().endingHint).toBeUndefined();
    m.advance(); // the hold before Q
    expect(m.getState().interstitial).toBeDefined();
    expect(m.getState().endingHint).toBeUndefined();
    m.destroy();
  });
});

describe("play-all + skip-all: the interstitial does not end the burst (Phase 18)", () => {
  it("an elapsed hold resumes skipping; a press during it leaves skip off", () => {
    vi.useFakeTimers();
    const shaped = manifest(CANON);
    const make = () =>
      createMachine({
        items: shaped.items,
        branches: shaped.branches,
        settings: { ...SETTINGS, playAllRoutes: true, skipAll: true },
      });
    const run = (m: ReturnType<typeof make>) => {
      m.toggleSkip(); // skip-all: the burst may reveal
      for (let n = 0; n < 40 && m.getState().interstitial === undefined; n += 1)
        vi.advanceTimersByTime(SETTINGS.skipDwellMs);
      expect(m.getState().interstitial).toBeDefined();
    };
    const elapsed = make();
    run(elapsed);
    vi.advanceTimersByTime(INTERSTITIAL_MS);
    expect(elapsed.getState().skipping).toBe(true); // the burst carries on
    elapsed.destroy();
    const pressed = make();
    run(pressed);
    pressed.advance(); // the reader's press ends it early: stop here
    expect(pressed.getState().skipping).toBe(false);
    pressed.destroy();
  });
});
