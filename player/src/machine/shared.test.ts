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
const Y = 1;
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
    // X's own decision, with Y unplayed this pass, is offered again
    // before the span's "return" acts at `d` (item 9i2).
    expect(m.getState().skipping).toBe(false);
    expect(m.getState().readAgain).toBeUndefined();
    expect(flips).toEqual([true]);
    expect(m.getState().choice?.decisionId).toBe("n");
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(Y);
    expect(m.getState().choice?.autoPick?.backFromLabel).toBe("X");
    expect(completedAt(m, N)).toEqual([X]);
    m.advance(); // y-1
    m.advance(); // joins at b-2, B's last item
    m.advance(); // B's end re-offers `d`: C next
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(C);
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
    m.advance(); // the span's end: `n` again for Y (item 9i2)
    expect(m.getState().choice?.decisionId).toBe("n");
    m.destroy();
  });

  it('a "continue" span re-offers while a route is unplayed this pass, then joins', () => {
    vi.useFakeTimers();
    const m = machine({ settings: ALL, fail: "continue" });
    readAThenToX(m);
    m.advance(); // the span, skipped
    vi.advanceTimersByTime(DEFAULT_SETTINGS.skipDwellMs * 2);
    // `n` first, Y unplayed; then B's end, and C.
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(Y);
    m.advance(); // y-1
    m.advance(); // b-2
    m.advance(); // B's end
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

// Item 9i2: under Play all routes, the end of a span entered from a nested
// route offers again the innermost decision between that route and the
// span's decision with a route unplayed this pass, its enclosing routes
// open again, before the span's `result` acts at its own decision.

/**
 * Space through play-all to the story's end, the clock running each skip
 * burst through a span read already: each choice offered, as
 * "decision:picked route", with "<label" for the route a re-offer came
 * back from.
 */
function playAll(m: M): string[] {
  const offers: string[] = [];
  for (let n = 0; n < 300; n += 1) {
    const state = m.getState();
    if (state.skipping) {
      vi.advanceTimersByTime(DEFAULT_SETTINGS.skipDwellMs);
      continue;
    }
    const auto = state.choice?.autoPick;
    if (state.choice !== undefined && auto !== undefined) {
      const back =
        auto.backFromLabel === undefined ? "" : `<${auto.backFromLabel}`;
      offers.push(
        `${state.choice.decisionId}:${state.choice.routes[auto.routeIdx].label}${back}`,
      );
    }
    m.advance();
    const after = m.getState();
    if (
      after.cursor === state.cursor &&
      after.choice === undefined &&
      state.choice === undefined &&
      !after.skipping
    )
      break;
  }
  return offers;
}

/** Every item index of a manifest of `count` items not yet shown. */
function unshown(m: M, count: number): number[] {
  const seen = new Set(m.visitedList());
  return Array.from({ length: count }, (_, i) => i).filter((i) => !seen.has(i));
}

describe("Play all routes on: a nested route's span offers its own decision again (item 9i2)", () => {
  it("one level: X's span end offers `n` again for Y, whose join continues B", () => {
    vi.useFakeTimers();
    const m = machine({ settings: ALL });
    expect(playAll(m)).toEqual(["d:A", "d:B<A", "n:X", "n:Y<X", "d:C<B"]);
    // Only `tail`, which no route names, is left unread.
    expect(unshown(m, ITEMS.length)).toEqual([T1]);
    expect(completedAt(m, D)).toEqual([A, B, C]);
    expect(completedAt(m, N)).toEqual([X, Y]);
    m.destroy();
  });

  it("the re-offer has B's frame open again, and Y's join reads on in B", () => {
    vi.useFakeTimers();
    const m = machine({ settings: ALL });
    toChoice(m);
    m.advance(); // A
    m.advance(); // f-1
    m.advance(); // f-2
    m.advance(); // d again: B
    m.advance(); // b-1
    m.advance(); // n
    m.advance(); // fires n: X
    m.advance(); // x-1
    m.advance(); // the span, read already: skipping
    vi.advanceTimersByTime(DEFAULT_SETTINGS.skipDwellMs * 2);
    expect(m.getState().cursor).toBe(F2);
    expect(m.getState().choice?.decisionId).toBe("n");
    expect(m.exportContext().stack).toEqual([{ decision: D, route: B }]);
    // B is left at the span, not completed, until its own end.
    expect(completedAt(m, D)).toEqual([A]);
    m.advance(); // y-1
    expect(top(m)).toEqual({ decision: N, route: Y });
    m.advance(); // b-2, Y's join
    expect(m.getState().cursor).toBe(7);
    expect(top(m)).toEqual({ decision: D, route: B });
    m.advance(); // B's end
    expect(completedAt(m, D)).toEqual([A, B]);
    expect(m.getState().choice?.decisionId).toBe("d");
    m.destroy();
  });

  it("the nested route that reads the span first: its end offers `n` again too", () => {
    vi.useFakeTimers();
    // A without `then`: X is the first route of the pass to reach `fail`.
    const table = branches().map((branch) => ({ ...branch }));
    table[0] = {
      ...table[0],
      routes: [
        { id: "a", label: "A", start: "a-1", end: "a-1" },
        ...table[0].routes.slice(1),
      ],
    };
    const m = machine({ settings: ALL, branches: table });
    toChoice(m);
    m.advance(); // A
    m.advance(); // A's end: d again, B
    m.advance(); // b-1
    m.advance(); // n
    m.advance(); // fires n: X
    m.advance(); // x-1
    m.advance(); // f-1, read
    expect(m.getState().skipping).toBe(false);
    m.advance(); // f-2
    m.advance(); // the span's end
    expect(m.getState().choice?.decisionId).toBe("n");
    expect(m.getState().choice?.autoPick?.backFromLabel).toBe("X");
    m.destroy();
  });

  it("with Play all routes off the span's result acts at its own decision, as before", () => {
    const m = machine();
    toChoice(m);
    toX(m);
    m.advance(); // f-1
    m.advance(); // f-2
    m.advance(); // the span's end
    expect(m.getState().choice?.decisionId).toBe("d");
    expect(m.exportContext().stack).toEqual([]);
    m.destroy();
  });

  it("the wheel steps back from the re-offer onto the span's end", () => {
    vi.useFakeTimers();
    const m = machine({ settings: ALL });
    toChoice(m);
    for (let n = 0; n < 8; n += 1) m.advance(); // to x-1
    m.advance(); // the span, skipping
    vi.advanceTimersByTime(DEFAULT_SETTINGS.skipDwellMs * 2);
    expect(m.getState().choice?.decisionId).toBe("n");
    m.wheelBack();
    expect(m.getState().choice).toBeUndefined();
    expect(m.getState().cursor).toBe(F2);
    expect(top(m)).toEqual({ decision: N, route: X });
    // Reading on from there comes back to the same re-offer.
    m.advance();
    expect(m.getState().choice?.decisionId).toBe("n");
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(Y);
    m.destroy();
  });

  it("a reload with the re-offer open reopens it, B's frame kept, and play-all goes on", () => {
    vi.useFakeTimers();
    const m = machine({ settings: ALL });
    toChoice(m);
    for (let n = 0; n < 8; n += 1) m.advance(); // to x-1
    m.advance(); // the span, skipping
    vi.advanceTimersByTime(DEFAULT_SETTINGS.skipDwellMs * 2);
    const saved = m.exportContext();
    expect(saved.choice).toBe(N);
    m.destroy();
    const again = machine({ settings: ALL, resumeContext: saved });
    expect(again.getState().cursor).toBe(F2);
    expect(again.getState().choice?.decisionId).toBe("n");
    expect(again.getState().choice?.autoPick?.routeIdx).toBe(Y);
    again.wheelBack();
    expect(again.getState().cursor).toBe(F2);
    again.advance(); // the same re-offer
    expect(again.getState().choice?.decisionId).toBe("n");
    again.advance(); // y-1
    again.advance(); // b-2
    expect(again.getState().cursor).toBe(7);
    again.advance(); // B's end
    expect(again.getState().choice?.autoPick?.routeIdx).toBe(C);
    again.destroy();
  });

  // intro d | a-1 m | p-1 q | r-1 | s-1 | t-1 | a-2 | b-1 | f-1 | join end
  //  0    1 | 2   3 | 4   5 | 6   | 7   | 8   | 9   | 10  | 11  | 12   13
  // `d`: a (a-1..a-2, holding `m`), b (continuing, joining at `join`);
  // span `fail` (f-1, "return"). `m` in a: p (p-1..s-1, holding `q`), t
  // (continuing, joining at a-2). `q` in p, a pure choice: r and s, both
  // `then` `fail`, two levels out; p ends with `q`'s region.
  const TWO = [
    "intro",
    "d",
    "a-1",
    "m",
    "p-1",
    "q",
    "r-1",
    "s-1",
    "t-1",
    "a-2",
    "b-1",
    "f-1",
    "join",
    "end",
  ];
  function twoLevels(pEnd = "s-1"): Branch[] {
    return [
      {
        id: "d",
        after: "d",
        prompt: "?",
        routes: [
          { id: "a", label: "a", start: "a-1", end: "a-2" },
          { id: "b", label: "b", start: "b-1", end: "b-1" },
        ],
        continuingRoute: "b",
        continueAt: "join",
        shared: [{ id: "fail", start: "f-1", end: "f-1", result: "return" }],
      },
      {
        id: "m",
        after: "m",
        prompt: "?",
        routes: [
          { id: "p", label: "p", start: "p-1", end: pEnd },
          { id: "t", label: "t", start: "t-1", end: "t-1" },
        ],
        continuingRoute: "t",
        continueAt: "a-2",
      },
      {
        id: "q",
        after: "q",
        prompt: "?",
        routes: [
          { id: "r", label: "r", start: "r-1", end: "r-1", then: "fail" },
          { id: "s", label: "s", start: "s-1", end: "s-1", then: "fail" },
        ],
      },
    ];
  }

  it("two levels: `q` again while s is unplayed, then `m`, then the span's own decision", () => {
    vi.useFakeTimers();
    const m = machine({ settings: ALL, items: TWO, branches: twoLevels() });
    expect(playAll(m)).toEqual([
      "d:a",
      "m:p",
      "q:r",
      "q:s<r",
      "m:t<s",
      "d:b<a",
    ]);
    expect(unshown(m, TWO.length)).toEqual([]);
    expect(m.getState().cursor).toBe(TWO.length - 1);
    // p was left at the span; every other route completed.
    expect(m.exportContext().completedRoutes).toEqual([
      { decision: 0, routes: [0, 1] },
      { decision: 1, routes: [1] },
      { decision: 2, routes: [0, 1] },
    ]);
    expect(m.getState().endCard).toEqual({
      unseenRoutes: 0,
      otherUnseen: false,
      nextUnseen: false,
    });
    m.destroy();
  });

  it("two levels: `m`'s re-offer has a's frame open again", () => {
    vi.useFakeTimers();
    const m = machine({ settings: ALL, items: TWO, branches: twoLevels() });
    const offers: string[] = [];
    for (let n = 0; n < 60 && offers.length < 5; n += 1) {
      const state = m.getState();
      if (state.skipping) {
        vi.advanceTimersByTime(DEFAULT_SETTINGS.skipDwellMs);
        continue;
      }
      if (state.choice !== undefined) offers.push(state.choice.decisionId);
      if (offers.length === 5) break;
      m.advance();
    }
    expect(offers).toEqual(["d", "m", "q", "q", "m"]);
    expect(m.getState().cursor).toBe(11); // f-1, the span's end
    expect(m.exportContext().stack).toEqual([{ decision: 0, route: 0 }]);
    m.destroy();
  });

  it("a pure choice all played closes past its region when that lies inside its enclosing route", () => {
    vi.useFakeTimers();
    // p reads on to p-2 after `q`'s region.
    const items = [...TWO.slice(0, 8), "p-2", ...TWO.slice(8)];
    const m = machine({ settings: ALL, items, branches: twoLevels("p-2") });
    expect(playAll(m)).toEqual([
      "d:a",
      "m:p",
      "q:r",
      "q:s<r",
      "m:t<p",
      "d:b<a",
    ]);
    expect(unshown(m, items.length)).toEqual([]);
    m.destroy();
  });

  // intro A | a1-1 B | b1-1 C | c1-1 | c2-1 | b1-2 | b2-1 | a1-2 | a2-1 |
  //  0    1 | 2    3 | 4    5 | 6    | 7    | 8    | 9    | 10   | 11   |
  // a3-1 | s-1 s-2 | join end
  // 12   | 13  14  | 15   16
  // A: a1 (holding B), a2 (then S), a3 (continuing, joining at `join`);
  // span S ("return"). B in a1: b1 (holding C; continuing, joining at
  // a1-2), b2 (then S). C in b1: c1 (then S), c2 (continuing, joining at
  // b1-2). C's c1, B's b2 and A's a2 all name A's S.
  const CHAIN = [
    "intro",
    "A",
    "a1-1",
    "B",
    "b1-1",
    "C",
    "c1-1",
    "c2-1",
    "b1-2",
    "b2-1",
    "a1-2",
    "a2-1",
    "a3-1",
    "s-1",
    "s-2",
    "join",
    "end",
  ];
  const CHAIN_BRANCHES: Branch[] = [
    {
      id: "A",
      after: "A",
      prompt: "?",
      routes: [
        { id: "a1", label: "a1", start: "a1-1", end: "a1-2" },
        { id: "a2", label: "a2", start: "a2-1", end: "a2-1", then: "S" },
        { id: "a3", label: "a3", start: "a3-1", end: "a3-1" },
      ],
      continuingRoute: "a3",
      continueAt: "join",
      shared: [{ id: "S", start: "s-1", end: "s-2", result: "return" }],
    },
    {
      id: "B",
      after: "B",
      prompt: "?",
      routes: [
        { id: "b1", label: "b1", start: "b1-1", end: "b1-2" },
        { id: "b2", label: "b2", start: "b2-1", end: "b2-1", then: "S" },
      ],
      continuingRoute: "b1",
      continueAt: "a1-2",
    },
    {
      id: "C",
      after: "C",
      prompt: "?",
      routes: [
        { id: "c1", label: "c1", start: "c1-1", end: "c1-1", then: "S" },
        { id: "c2", label: "c2", start: "c2-1", end: "c2-1" },
      ],
      continuingRoute: "c2",
      continueAt: "b1-2",
    },
  ];

  it("a chain of menus: each nested decision is offered again, innermost first, and every item is read", () => {
    vi.useFakeTimers();
    const m = machine({
      settings: ALL,
      items: CHAIN,
      branches: CHAIN_BRANCHES,
    });
    expect(playAll(m)).toEqual([
      "A:a2",
      "A:a1<a2",
      "B:b2",
      "B:b1<b2",
      "C:c1",
      "C:c2<c1",
      "A:a3<a1",
    ]);
    expect(unshown(m, CHAIN.length)).toEqual([]);
    expect(m.exportContext().completedRoutes).toEqual([
      { decision: 0, routes: [0, 1, 2] },
      { decision: 1, routes: [0, 1] },
      { decision: 2, routes: [0, 1] },
    ]);
    m.destroy();
  });
});
