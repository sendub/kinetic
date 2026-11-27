import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachine, resolveDecisions } from "./machine";
import type {
  Branch,
  Item,
  MachineContext,
  MachineSettings,
  MachineState,
  RouteResult,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

// Shared spans (docs/content-format.md, "Branches"; docs/plan.md Phase 60
// item 9f): after the end of a route with `then`, flow enters the named
// span of its own decision or of one enclosing it, the reader staying in
// the route they picked (its frame, its played mark, its completion at the
// span's end); at the span's end the span's `result` acts at the span's
// decision. Under Play all routes the first route of a pass to reach a
// span reads it and a later one runs a skip burst through it on its own.

const OFF: MachineSettings = { ...DEFAULT_SETTINGS, playAllRoutes: false };
const ALL: MachineSettings = { ...DEFAULT_SETTINGS, playAllRoutes: true };

afterEach(() => {
  vi.useRealTimers();
});

function image(id: string): Item {
  return { id, type: "image", file: `${id}.jpg` };
}

// intro d | a-1 | b-1 n x-1 y-1 b-2 | c-1 | f-1 f-2 | t-1 | join end
//  0    1 | 2   | 3   4 5   6   7   | 8   | 9   10  | 11  | 12   13
// `d` off d: A (then `fail`), B holding `n`, C (the continuing route,
// joining at `join`); spans `fail` (f-1, f-2) and `tail` (t-1, continue).
// `n` off n inside B: X (then `fail`, the enclosing decision's span), Y
// (the continuing route, joining at b-2).
const ITEMS = [
  "intro",
  "d",
  "a-1",
  "b-1",
  "n",
  "x-1",
  "y-1",
  "b-2",
  "c-1",
  "f-1",
  "f-2",
  "t-1",
  "join",
  "end",
];
const D = 0;
const N = 1;
const A = 0;
const B = 1;
const C = 2;
const X = 0;
const F1 = 9;
const F2 = 10;
const T1 = 11;
const JOIN = 12;

function branches(
  opts: { fail?: RouteResult; cThen?: boolean } = {},
): readonly Branch[] {
  return [
    {
      id: "d",
      after: "d",
      prompt: "Which way?",
      routes: [
        { id: "a", label: "A", start: "a-1", end: "a-1", then: "fail" },
        { id: "b", label: "B", start: "b-1", end: "b-2" },
        {
          id: "c",
          label: "C",
          start: "c-1",
          end: "c-1",
          ...(opts.cThen === true ? { then: "tail" } : {}),
        },
      ],
      continuingRoute: "c",
      continueAt: "join",
      shared: [
        { id: "fail", start: "f-1", end: "f-2", result: opts.fail ?? "return" },
        { id: "tail", start: "t-1", end: "t-1", result: "continue" },
      ],
    },
    {
      id: "n",
      after: "n",
      prompt: "Which door?",
      routes: [
        { id: "x", label: "X", start: "x-1", end: "x-1", then: "fail" },
        { id: "y", label: "Y", start: "y-1", end: "y-1" },
      ],
      continuingRoute: "y",
      continueAt: "b-2",
    },
  ];
}

function machine(
  opts: {
    settings?: MachineSettings;
    fail?: RouteResult;
    cThen?: boolean;
    resumeContext?: MachineContext;
    items?: readonly string[];
    branches?: readonly Branch[];
  } = {},
) {
  return createMachine({
    items: (opts.items ?? ITEMS).map(image),
    branches: opts.branches ?? branches(opts),
    settings: opts.settings ?? OFF,
    resumeContext: opts.resumeContext,
    autoAdvance: false, // manual: one press is one step
  });
}

type M = ReturnType<typeof machine>;

/** Read from the opening to `d`'s choice. */
function toChoice(m: M): void {
  m.advance(); // intro -> d
  m.advance(); // fires d
  expect(m.getState().choice?.decisionId).toBe("d");
}

/** The top frame of the open stack. */
function top(m: M) {
  const stack = m.exportContext().stack;
  return stack[stack.length - 1];
}

/** The completed routes of decision `index`. */
function completedAt(m: M, index: number): readonly number[] {
  return (
    m.exportContext().completedRoutes?.find((set) => set.decision === index)
      ?.routes ?? []
  );
}

/** Every state the machine emits while `act` runs. */
function statesDuring(m: M, act: () => void): MachineState[] {
  const states: MachineState[] = [];
  const stop = m.subscribe((s) => states.push(s));
  act();
  stop();
  return states;
}

/** Pick B, then X at `n`: on x-1, the nested route's last item. */
function toX(m: M): void {
  m.choose(B); // b-1
  m.advance(); // n
  m.advance(); // fires n
  expect(m.getState().choice?.decisionId).toBe("n");
  m.choose(X);
  expect(m.getState().cursor).toBe(5);
}

describe("resolving `shared` and `then`", () => {
  it("a decision carries its spans and each route the span its `then` names", () => {
    const [d, n] = resolveDecisions(ITEMS.map(image), branches());
    expect(d.shared).toEqual([
      { id: "fail", startIndex: F1, endIndex: F2, result: "return" },
      { id: "tail", startIndex: T1, endIndex: T1, result: "continue" },
    ]);
    expect(d.routes[A].then).toEqual({ decision: D, span: 0 });
    expect(d.routes[B].then).toBeUndefined();
    // X names a span of the decision enclosing its own.
    expect(n.routes[X].then).toEqual({ decision: D, span: 0 });
  });

  it("an unknown span, or a continuing route's `then` to a span that does not continue, reads as absent", () => {
    const table = branches().map((branch) => ({ ...branch }));
    table[0] = {
      ...table[0],
      routes: [
        { ...table[0].routes[0], then: "nowhere" },
        table[0].routes[1],
        { ...table[0].routes[2], then: "fail" },
      ],
    };
    const [d] = resolveDecisions(ITEMS.map(image), table);
    expect(d.routes[A].then).toBeUndefined();
    expect(d.routes[C].then).toBeUndefined();
  });
});

describe("Play all routes off: a route's end enters its span", () => {
  it("reading on from a route with `then` enters the span, the reader still in the route", () => {
    const m = machine();
    toChoice(m);
    m.choose(A);
    m.advance(); // off a-1
    expect(m.getState().cursor).toBe(F1);
    expect(m.getState().transition).toBe("advance");
    expect(m.getState().choice).toBeUndefined();
    expect(top(m)).toEqual({ decision: D, route: A });
    // Not completed until its span is.
    expect(completedAt(m, D)).toEqual([]);
    m.advance(); // f-2
    expect(m.getState().cursor).toBe(F2);
    m.advance(); // the span's end: its "return" re-offers the choice
    expect(m.getState().choice?.decisionId).toBe("d");
    expect(m.getState().choice?.continueOption).toBeUndefined();
    expect(completedAt(m, D)).toEqual([A]);
    expect(m.exportContext().stack).toEqual([]);
    m.destroy();
  });

  it("a nested route's `then` to the enclosing decision's span leaves both routes, the enclosing one not completed", () => {
    const m = machine();
    toChoice(m);
    toX(m);
    m.advance(); // off x-1: into `d`'s span
    expect(m.getState().cursor).toBe(F1);
    expect(m.exportContext().stack).toEqual([{ decision: N, route: X }]);
    m.advance();
    m.advance(); // the span's end acts at `d`
    expect(m.getState().choice?.decisionId).toBe("d");
    expect(completedAt(m, N)).toEqual([X]);
    expect(completedAt(m, D)).toEqual([]); // B was left, not completed
    expect(m.exportContext().playedRoutes).toEqual([
      { decision: D, routes: [B] },
      { decision: N, routes: [X] },
    ]);
    m.destroy();
  });

  it('a span with "continue" joins at its decision\'s `continueAt`', () => {
    const m = machine({ fail: "continue" });
    toChoice(m);
    m.choose(A);
    m.advance(); // f-1
    m.advance(); // f-2
    m.advance(); // joins
    expect(m.getState().cursor).toBe(JOIN);
    expect(m.getState().transition).toBe("advance");
    expect(m.getState().choice).toBeUndefined();
    m.destroy();
  });

  it("a span ending at the story's end: the choice again, then the close ends the story", () => {
    // intro p | a-1 | b-1 | e-1 e-2: a pure choice whose routes both read
    // the span `end` laid out after them, up to the last item.
    const items = ["intro", "p", "a-1", "b-1", "e-1", "e-2"];
    const table: Branch[] = [
      {
        id: "p",
        after: "p",
        prompt: "Which?",
        routes: [
          { id: "a", label: "A", start: "a-1", end: "a-1", then: "end" },
          { id: "b", label: "B", start: "b-1", end: "b-1", then: "end" },
        ],
        shared: [{ id: "end", start: "e-1", end: "e-2" }],
      },
    ];
    const m = machine({ items, branches: table });
    m.advance();
    m.advance(); // fires p
    m.choose(0);
    m.advance(); // e-1
    m.advance(); // e-2: the ending
    expect(m.getState().cursor).toBe(5);
    expect(m.getState().endCard).toBeDefined();
    m.advance(); // a route is left: the choice again
    expect(m.getState().choice?.decisionId).toBe("p");
    m.choose(1);
    m.advance(); // e-1
    expect(m.getState().cursor).toBe(4);
    m.advance(); // e-2
    m.advance(); // every route played: the close past the span ends the story
    expect(m.getState().cursor).toBe(5);
    expect(m.getState().settled).toBe(true);
    expect(m.getState().choice).toBeUndefined();
    expect(m.getState().endCard).toBeDefined();
    m.advance();
    expect(m.getState().cursor).toBe(5);
    m.destroy();
  });

  it("the return row opens on the continuing route's own completion, then shows at a span's re-offer", () => {
    const m = machine();
    toChoice(m);
    m.choose(C);
    m.advance(); // joins at `join`
    expect(m.getState().cursor).toBe(JOIN);
    for (let n = 0; n < 20 && m.getState().choice === undefined; n += 1)
      m.wheelBack();
    expect(m.getState().choice?.decisionId).toBe("d");
    m.choose(A);
    m.advance(); // f-1
    m.advance(); // f-2
    m.advance(); // re-offer
    expect(m.getState().choice?.continueOption).toBe(true);
    m.chooseContinue();
    expect(m.getState().cursor).toBe(JOIN);
    m.destroy();
  });

  it("the continuing route with `then` completes at its span's end, which joins and opens the return row", () => {
    const m = machine({ cThen: true });
    toChoice(m);
    m.choose(C);
    m.advance(); // off c-1: into `tail`
    expect(m.getState().cursor).toBe(T1);
    expect(completedAt(m, D)).toEqual([]);
    m.advance(); // `tail` continues
    expect(m.getState().cursor).toBe(JOIN);
    expect(completedAt(m, D)).toEqual([C]);
    m.destroy();
  });

  it("with Play all routes off a span is read every time", () => {
    const m = machine();
    toChoice(m);
    m.choose(A);
    m.advance();
    m.advance();
    m.advance(); // re-offer
    toX(m);
    m.advance(); // into the span again
    expect(m.getState().cursor).toBe(F1);
    expect(m.getState().skipping).toBe(false);
    expect(m.getState().readAgain).toBeUndefined();
    m.destroy();
  });

  it("a skip burst enters the span as a fast traverse", () => {
    vi.useFakeTimers();
    const m = machine();
    toChoice(m);
    m.choose(A);
    m.advance(); // f-1
    m.advance(); // f-2
    for (let n = 0; n < 20 && m.getState().cursor !== 2; n += 1) m.wheelBack();
    expect(m.getState().cursor).toBe(2);
    m.toggleSkip();
    expect(m.getState().skipping).toBe(true);
    const states = statesDuring(m, () => {
      vi.advanceTimersByTime(DEFAULT_SETTINGS.skipDwellMs);
    });
    const entry = states.find((s) => s.cursor === F1);
    expect(entry?.transition).toBe("nav");
    m.destroy();
  });
});

describe("Play all routes on: a span read already this pass is skipped", () => {
  /** Space through play-all's picks to x-1, having read A's span. */
  function readAThenToX(m: M): void {
    toChoice(m);
    m.advance(); // takes the auto-pick: A, the shortest
    expect(m.getState().cursor).toBe(2);
    m.advance(); // f-1, read
    expect(m.getState().skipping).toBe(false);
    m.advance(); // f-2
    m.advance(); // re-offer: B next
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(B);
    m.advance(); // b-1
    m.advance(); // n
    m.advance(); // fires n: X first
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(X);
    m.advance(); // x-1
    expect(m.getState().cursor).toBe(5);
  }

  it("the first route reads the span; a later one skips through it, then the result acts", () => {
    vi.useFakeTimers();
    const m = machine({ settings: ALL });
    const flips: boolean[] = [];
    m.onSkipChange((on) => flips.push(on));
    readAThenToX(m);
    m.advance(); // into the span: read already this pass
    expect(m.getState().cursor).toBe(F1);
    expect(m.getState().skipping).toBe(true);
    expect(m.getState().readAgain).toBe(true);
    expect(flips).toEqual([true]);
    vi.advanceTimersByTime(DEFAULT_SETTINGS.skipDwellMs); // f-2
    expect(m.getState().cursor).toBe(F2);
    vi.advanceTimersByTime(DEFAULT_SETTINGS.skipDwellMs); // the span's end
    // The burst ends with the span, with no "off" flip of its own, and
    // the span's "return" re-offers `d` under play-all: C next.
    expect(m.getState().skipping).toBe(false);
    expect(m.getState().readAgain).toBeUndefined();
    expect(flips).toEqual([true]);
    expect(m.getState().choice?.decisionId).toBe("d");
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(C);
    expect(m.getState().choice?.autoPick?.backFromLabel).toBe("X");
    expect(completedAt(m, N)).toEqual([X]);
    m.advance(); // c-1
    m.advance(); // joins: every route played
    expect(m.getState().cursor).toBe(JOIN);
    m.destroy();
  });

  it("Space stops the skip as it stops Tab's, the reader reading the span", () => {
    vi.useFakeTimers();
    const m = machine({ settings: ALL });
    const flips: boolean[] = [];
    m.onSkipChange((on) => flips.push(on));
    readAThenToX(m);
    m.advance(); // into the span, skipping
    m.advance(); // Space: stop here
    expect(m.getState().skipping).toBe(false);
    expect(m.getState().readAgain).toBeUndefined();
    expect(m.getState().cursor).toBe(F1);
    expect(flips).toEqual([true, false]);
    vi.advanceTimersByTime(10_000);
    expect(m.getState().cursor).toBe(F1); // manual: nothing moves
    m.advance(); // f-2
    m.advance(); // the result acts
    expect(m.getState().choice?.decisionId).toBe("d");
    m.destroy();
  });

  it('a "continue" span re-offers while a route is unplayed this pass, then joins', () => {
    vi.useFakeTimers();
    const m = machine({ settings: ALL, fail: "continue" });
    readAThenToX(m);
    m.advance(); // the span, skipped
    vi.advanceTimersByTime(DEFAULT_SETTINGS.skipDwellMs * 2);
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(C);
    m.advance(); // c-1
    m.advance(); // joins
    expect(m.getState().cursor).toBe(JOIN);
    m.destroy();
  });

  it("an unseen span is read even though a route of this pass reached it, skip-all off", () => {
    vi.useFakeTimers();
    const m = machine({ settings: ALL });
    readAThenToX(m);
    const saved = m.exportContext();
    m.destroy();
    // The same place with the span unseen (as if its items were added since).
    const again = machine({
      settings: ALL,
      resumeContext: {
        ...saved,
        visited: saved.visited.filter((i) => i !== F1 && i !== F2),
      },
    });
    again.advance(); // settles x-1 (a resume landing is read already)
    if (again.getState().cursor === 5) again.advance();
    expect(again.getState().cursor).toBe(F1);
    expect(again.getState().skipping).toBe(false);
    again.destroy();
  });
});

describe("the wheel and a reload inside a span", () => {
  it("the wheel walks the span after the last-picked route that reaches it, and back", () => {
    const m = machine();
    toChoice(m);
    m.choose(A);
    m.advance(); // f-1
    m.advance(); // f-2
    m.advance(); // re-offer
    toX(m);
    m.advance(); // f-1 by X
    m.advance(); // f-2
    m.wheelBack();
    expect(m.getState().cursor).toBe(F1);
    expect(top(m)).toEqual({ decision: N, route: X });
    m.wheelBack();
    expect(m.getState().cursor).toBe(5); // x-1: the last pick's way in
    m.wheelForward();
    expect(m.getState().cursor).toBe(F1);
    expect(m.exportContext().stack).toEqual([{ decision: N, route: X }]);
    m.wheelForward();
    expect(m.getState().cursor).toBe(F2);
    // Reading on from the walk: the span's end acts as ever.
    m.advance();
    m.advance();
    expect(m.getState().choice?.decisionId).toBe("d");
    m.destroy();
  });

  it("a walk forward from the span's end follows its result", () => {
    const m = machine({ fail: "continue" });
    toChoice(m);
    m.choose(A);
    m.advance();
    m.advance();
    m.advance(); // joins at `join`
    m.advance(); // end
    for (let n = 0; n < 3; n += 1) m.wheelBack();
    expect(m.getState().cursor).toBe(F1);
    m.wheelBack();
    expect(m.getState().cursor).toBe(2); // a-1
    m.wheelForward();
    m.wheelForward();
    m.wheelForward();
    expect(m.getState().cursor).toBe(JOIN);
    m.destroy();
  });

  it("a reload inside the span keeps the route that led in, and its end acts", () => {
    const m = machine();
    toChoice(m);
    toX(m);
    m.advance(); // f-1 by X
    const saved = m.exportContext();
    expect(saved.stack).toEqual([{ decision: N, route: X }]);
    m.destroy();
    const again = machine({ resumeContext: saved });
    expect(again.getState().cursor).toBe(F1);
    again.advance(); // f-2
    again.advance(); // the span's end
    expect(again.getState().choice?.decisionId).toBe("d");
    expect(completedAt(again, N)).toEqual([X]);
    again.destroy();
  });

  it("a reload with the span's re-offer open reopens it", () => {
    const m = machine();
    toChoice(m);
    m.choose(A);
    m.advance();
    m.advance();
    m.advance(); // re-offer over f-2
    const saved = m.exportContext();
    m.destroy();
    const again = machine({ resumeContext: saved });
    expect(again.getState().cursor).toBe(F2);
    expect(again.getState().choice?.decisionId).toBe("d");
    again.wheelBack();
    expect(again.getState().cursor).toBe(F2);
    expect(again.getState().choice).toBeUndefined();
    again.destroy();
  });

  it("an import (a bookmark) inside the span keeps the route that led in", () => {
    const m = machine();
    toChoice(m);
    toX(m);
    m.advance(); // f-1 by X
    const mark = m.exportContext();
    m.advance(); // f-2
    m.advance(); // re-offer
    m.choose(C);
    m.advance(); // join
    m.importContext(mark);
    expect(m.getState().cursor).toBe(F1);
    expect(top(m)).toEqual({ decision: N, route: X });
    m.advance();
    m.advance();
    expect(m.getState().choice?.decisionId).toBe("d");
    m.destroy();
  });
});
