// The pill-over-choice rule (render/app.ts `createPillGate`): the `#flash`
// pill never covers a choice screen with news the reader did not ask for;
// the mode pills (docs/plan.md Phase 43) may. The DOM half (app.ts's shell
// drops the pill element and its queued messages) is checked in the
// browser by scripts/scenarios/choicelist.scenario.mjs. The pill queue
// (`createPillQueue`) is checked here with its timers injected.

import { describe, expect, it } from "vitest";
import {
  createPillGate,
  createPillQueue,
  NOTICE_LONG_MS,
  type PillMessage,
  ROUTE_PILL_MS,
} from "./app";

describe("createPillGate (no pill over a choice screen)", () => {
  it("lets pills show while no choice is open", () => {
    const gate = createPillGate();
    expect(gate.choiceChanged(false)).toBe(false);
    expect(gate.mayShow()).toBe(true);
  });

  it("drops the pill when a choice opens, once, and blocks pills while it stays open", () => {
    const gate = createPillGate();
    expect(gate.choiceChanged(true)).toBe(true);
    expect(gate.mayShow()).toBe(false);
    // later state changes on the same open choice (countdown ticks, cursor
    // moves) drop nothing more: nothing can have shown since
    expect(gate.choiceChanged(true)).toBe(false);
    expect(gate.mayShow()).toBe(false);
  });

  it("lets the route pill show once the pick closes the choice, and drops again at the re-offer", () => {
    const gate = createPillGate();
    gate.choiceChanged(true);
    expect(gate.choiceChanged(false)).toBe(false); // the pick: no drop
    expect(gate.mayShow()).toBe(true); // "Route: <label>" may show
    expect(gate.choiceChanged(true)).toBe(true); // short route ends: re-offer
    expect(gate.mayShow()).toBe(false);
  });

  it("lets a mode pill show over an open choice (docs/plan.md Phase 43)", () => {
    const gate = createPillGate();
    gate.choiceChanged(true);
    expect(gate.mayShow(true)).toBe(true); // "Skip on" from Tab on the choice
    expect(gate.mayShow(false)).toBe(false);
  });
});

describe("createPillGate (no pill over the branch map)", () => {
  it("drops the pill when the map opens, blocks pills while it is up, and lets them show once it closes", () => {
    const gate = createPillGate();
    expect(gate.coverChanged(true)).toBe(true); // a pill still holding goes
    expect(gate.mayShow()).toBe(false);
    expect(gate.coverChanged(true)).toBe(false);
    // a map jump closes the map before the route pill shows
    expect(gate.coverChanged(false)).toBe(false);
    expect(gate.mayShow()).toBe(true);
  });

  it("a choice under the map still blocks pills after the map closes", () => {
    const gate = createPillGate();
    gate.choiceChanged(true);
    gate.coverChanged(true);
    gate.coverChanged(false);
    expect(gate.mayShow()).toBe(false);
  });

  it("blocks mode pills too while the map is up", () => {
    const gate = createPillGate();
    gate.coverChanged(true);
    expect(gate.mayShow(true)).toBe(false);
  });
});

describe("createPillQueue (docs/plan.md Phase 43: one task, one sequence)", () => {
  const HOLD = 1600;

  /** A queue on a hand-driven clock: `flush()` ends the task, `tick(ms)` runs timers. */
  function harness() {
    let now = 0;
    let deferred: (() => void)[] = [];
    let timers: { at: number; fn: () => void; id: number }[] = [];
    let ids = 0;
    const shown: [number, string, boolean][] = [];
    const queue = createPillQueue(
      {
        defer: (fn) => deferred.push(fn),
        setTimer: (fn, ms) => {
          ids += 1;
          timers.push({ at: now + ms, fn, id: ids });
          return ids;
        },
        clearTimer: (handle) => {
          timers = timers.filter((timer) => timer.id !== handle);
        },
        show: (message: PillMessage) =>
          shown.push([now, message.text, message.mode]),
      },
      HOLD,
    );
    const flush = () => {
      const run = deferred;
      deferred = [];
      for (const fn of run) fn();
    };
    const tick = (ms: number) => {
      const until = now + ms;
      for (;;) {
        const due = timers
          .filter((timer) => timer.at <= until)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        timers = timers.filter((timer) => timer !== due);
        now = due.at;
        due.fn();
      }
      now = until;
    };
    return { queue, shown, flush, tick };
  }

  it("announcements made in one task show one after another, in order", () => {
    const { queue, shown, flush, tick } = harness();
    queue.add(["Skip off"], true);
    queue.add(["Auto-forward off"], true);
    flush();
    tick(HOLD * 3);
    expect(shown).toEqual([
      [0, "Skip off", true],
      [HOLD, "Auto-forward off", true],
    ]);
  });

  it("a later task's announcement wins over what is still queued", () => {
    const { queue, shown, flush, tick } = harness();
    queue.add(["Back to try another route", "Route: A"], false);
    flush();
    tick(10); // the first shows
    queue.add(["Route: B"], false);
    flush();
    tick(HOLD * 3);
    expect(shown.map(([, text]) => text)).toEqual([
      "Back to try another route",
      "Route: B",
    ]);
  });

  it("a task's mode pills lead its route pills: a pick whose skip cannot run says Skip off first", () => {
    const { queue, shown, flush, tick } = harness();
    queue.add(["Back to try another route", "Route: A"], false);
    queue.add(["Skip off"], true);
    flush();
    tick(HOLD * 4);
    expect(shown).toEqual([
      [0, "Skip off", true],
      [HOLD, "Back to try another route", false],
      [HOLD * 2, "Route: A", false],
    ]);
  });

  it("a choice opening drops the queued route pills but keeps the mode pill", () => {
    const { queue, shown, flush, tick } = harness();
    queue.add(["Route: A"], false);
    queue.add(["Skip off"], true);
    queue.dropGated(); // in the same task, before the sequence starts
    flush();
    tick(HOLD * 3);
    expect(shown).toEqual([[0, "Skip off", true]]);

    const later = harness();
    later.queue.add(["Skip on"], true);
    later.queue.add(["Back to try another route", "Route: A"], false);
    later.flush();
    later.tick(10); // the mode pill shows; the route pills wait their turn
    later.queue.dropGated(); // a choice opens while it holds
    later.tick(HOLD * 3);
    expect(later.shown.map(([, text]) => text)).toEqual(["Skip on"]);
  });

  it("a message with its own hold keeps the next one waiting that long (a notice held to be read)", () => {
    const { queue, shown, flush, tick } = harness();
    queue.add(["That file could not be read."], true, HOLD * 2.5);
    queue.add(["Route: A"], false);
    flush();
    tick(HOLD * 5);
    expect(shown).toEqual([
      [0, "That file could not be read.", true],
      [HOLD * 2.5, "Route: A", false],
    ]);
  });

  it("hands each message's own hold to the pill, and none for the default", () => {
    const held: (number | undefined)[] = [];
    let deferred: (() => void) | null = null;
    const timers: (() => void)[] = [];
    const queue = createPillQueue(
      {
        defer: (fn) => {
          deferred = fn;
        },
        setTimer: (fn) => timers.push(fn),
        clearTimer: () => {},
        show: (message) => held.push(message.holdMs),
      },
      HOLD,
    );
    queue.add(["Progress exported"], true);
    queue.add(["This browser keeps the tab open."], true, NOTICE_LONG_MS);
    (deferred as (() => void) | null)?.();
    for (const fn of timers) fn();
    expect(held).toEqual([undefined, NOTICE_LONG_MS]);
    expect(NOTICE_LONG_MS).toBeGreaterThan(ROUTE_PILL_MS);
  });

  it("dropAll drops everything queued, mode pills too", () => {
    const { queue, shown, flush, tick } = harness();
    queue.add(["Skip on"], true);
    queue.dropAll();
    flush();
    queue.add(["Route: A", "Skip off"], true);
    flush();
    queue.dropAll();
    tick(HOLD * 3);
    expect(shown).toEqual([]);
  });
});
