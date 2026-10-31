import { describe, expect, it } from "vitest";

import {
  initialWheelTracker,
  WHEEL_RATE_CAP_MS,
  WHEEL_STEP_PX,
  type WheelTracker,
  wheelPlan,
} from "./wheel";

/** Feed a run of (deltaY, now) events and collect the steps they produced. */
function feed(events: ReadonlyArray<readonly [number, number]>) {
  let tracker: WheelTracker = initialWheelTracker;
  const steps: Array<{ direction: string | null; steps: number }> = [];
  for (const [deltaY, now] of events) {
    const outcome = wheelPlan(deltaY, now, tracker);
    tracker = outcome.tracker;
    steps.push({ direction: outcome.direction, steps: outcome.steps });
  }
  return { tracker, steps };
}

const SPACING = WHEEL_RATE_CAP_MS + 20;

describe("wheelPlan threshold", () => {
  it("issues one step per full WHEEL_STEP_PX of accumulated delta", () => {
    const one = wheelPlan(-WHEEL_STEP_PX, 0, initialWheelTracker);
    expect(one).toMatchObject({ direction: "back", steps: 1 });
    expect(one.tracker.pending).toBe(0);
    expect(one.tracker.lastStepAt).toBe(0);
  });

  it("holds a short flick and pays it out when the next notch arrives", () => {
    const short = wheelPlan(-WHEEL_STEP_PX + 10, 0, initialWheelTracker);
    expect(short).toMatchObject({ direction: null, steps: 0 });
    expect(short.tracker.pending).toBe(-90);
    expect(short.tracker.lastStepAt).toBeNull(); // nothing was stepped
    const next = wheelPlan(-20, SPACING, short.tracker);
    expect(next).toMatchObject({ direction: "back", steps: 1 });
    expect(next.tracker.pending).toBe(-10);
  });

  it("pays several steps for one big delta and keeps the remainder", () => {
    const big = wheelPlan(-WHEEL_STEP_PX * 2 - 40, 0, initialWheelTracker);
    expect(big).toMatchObject({ direction: "back", steps: 2 });
    expect(big.tracker.pending).toBe(-40);
  });

  it("maps a positive delta to wheelForward", () => {
    const down = wheelPlan(WHEEL_STEP_PX, 0, initialWheelTracker);
    expect(down).toMatchObject({ direction: "forward", steps: 1 });
    expect(down.tracker.pending).toBe(0);
  });
});

describe("wheelPlan rate cap", () => {
  it("ignores an event inside the cap, unspent pixels included", () => {
    const first = wheelPlan(-WHEEL_STEP_PX, 1000, initialWheelTracker);
    const held = wheelPlan(
      -WHEEL_STEP_PX,
      1000 + WHEEL_RATE_CAP_MS - 1,
      first.tracker,
    );
    expect(held).toEqual({ tracker: first.tracker, direction: null, steps: 0 });
    const after = wheelPlan(
      -WHEEL_STEP_PX,
      1000 + WHEEL_RATE_CAP_MS,
      first.tracker,
    );
    expect(after).toMatchObject({ direction: "back", steps: 1 });
  });

  it("does not let a fast flick outrun the cap", () => {
    const { steps } = feed(
      Array.from(
        { length: 6 },
        (_, i) => [-WHEEL_STEP_PX, 1000 + i * 10] as const,
      ),
    );
    expect(steps.filter((s) => s.steps > 0)).toHaveLength(1);
  });
});

describe("wheelPlan direction flip", () => {
  it("drops the stale accumulator when the wheel reverses", () => {
    const held = wheelPlan(-WHEEL_STEP_PX + 10, 0, initialWheelTracker);
    expect(held.tracker.pending).toBe(-90);
    const flipped = wheelPlan(WHEEL_STEP_PX - 30, SPACING, held.tracker);
    // 70 px forward, not -20 px: the -90 that never reached a step is gone.
    expect(flipped).toMatchObject({ direction: null, steps: 0 });
    expect(flipped.tracker.pending).toBe(70);
    const paid = wheelPlan(40, SPACING * 2, flipped.tracker);
    expect(paid).toMatchObject({ direction: "forward", steps: 1 });
    expect(paid.tracker.pending).toBe(10);
  });

  it("keeps walking one step per notch in each direction", () => {
    const { tracker, steps } = feed([
      [-WHEEL_STEP_PX, 0],
      [-WHEEL_STEP_PX, SPACING],
      [WHEEL_STEP_PX, SPACING * 2],
      [WHEEL_STEP_PX, SPACING * 3],
    ]);
    expect(steps.map((s) => [s.direction, s.steps])).toEqual([
      ["back", 1],
      ["back", 1],
      ["forward", 1],
      ["forward", 1],
    ]);
    expect(tracker.pending).toBe(0);
  });
});

describe("wheelPlan degenerate input", () => {
  it("ignores a zero or non-finite delta without touching the tracker", () => {
    const tracker: WheelTracker = { pending: -50, lastStepAt: 10 };
    expect(wheelPlan(0, 200, tracker)).toEqual({
      tracker,
      direction: null,
      steps: 0,
    });
    expect(wheelPlan(Number.NaN, 200, tracker)).toEqual({
      tracker,
      direction: null,
      steps: 0,
    });
  });

  it("is not wedged by a clock that steps backwards", () => {
    const first = wheelPlan(-WHEEL_STEP_PX, 1000, initialWheelTracker);
    const earlier = wheelPlan(-WHEEL_STEP_PX, 900, first.tracker);
    expect(earlier).toMatchObject({ direction: "back", steps: 1 });
  });
});
