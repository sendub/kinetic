// Wheel rewind wiring (docs/plan.md Phase 7). A wheel event is a gesture, not
// a key, so it has its own module: continuous pixel deltas in, discrete machine
// steps out. The decision is pure (wheelPlan over an explicit tracker) and
// installWheelInput is the only DOM code.
//
// Direction follows the DOM convention: scrolling up reports a negative deltaY
// and rewinds time (wheelBack), scrolling down returns toward the present and
// stops at the frontier (wheelForward) — whether a step is actually allowed is
// the machine's own clamp, never this module's concern.
//
// Deltas are read as pixels, the `deltaMode === 0` Chrome reports on macOS.

/** Accumulated wheel pixels needed for one machine step. */
export const WHEEL_STEP_PX = 100;

/** Minimum spacing between two emitted steps, in ms. */
export const WHEEL_RATE_CAP_MS = 80;

export type WheelDirection = "back" | "forward";

/** Everything the decision carries between wheel events. */
export interface WheelTracker {
  /** Unspent wheel delta in px. Sign: negative = up = back in time. */
  pending: number;
  /** `now` of the event that last produced a step; null until the first. */
  lastStepAt: number | null;
}

export const initialWheelTracker: WheelTracker = {
  pending: 0,
  lastStepAt: null,
};

export interface WheelOutcome {
  tracker: WheelTracker;
  /** null when this event produced no step. */
  direction: WheelDirection | null;
  /** Machine steps to issue: 0, or more for one large delta. */
  steps: number;
}

function noop(tracker: WheelTracker): WheelOutcome {
  return { tracker, direction: null, steps: 0 };
}

/**
 * Folds one wheel event into the tracker and reports the steps it is worth.
 *
 * Three rules, in order:
 *
 * - Rate cap: an event within `WHEEL_RATE_CAP_MS` of the step it just
 *   produced is ignored whole — it accumulates nothing. Its pixels are lost on
 *   purpose; the cap is what keeps a fast trackpad flick from tearing through
 *   items faster than the eye can follow. (A clock that moves backwards is a
 *   browser oddity, not a cap, so it never wedges the wheel.)
 * - Direction flip: the accumulator resets first, so a reversal starts from
 *   the new gesture instead of cancelling stale pixels.
 * - Threshold: one step per `WHEEL_STEP_PX` accumulated, the remainder kept
 *   with its sign so a 90 px flick is not thrown away but counted toward the
 *   next notch.
 */
export function wheelPlan(
  deltaY: number,
  now: number,
  tracker: WheelTracker,
): WheelOutcome {
  if (!Number.isFinite(deltaY) || deltaY === 0) return noop(tracker);
  if (
    tracker.lastStepAt !== null &&
    now >= tracker.lastStepAt &&
    now - tracker.lastStepAt < WHEEL_RATE_CAP_MS
  ) {
    return noop(tracker);
  }
  const reversed =
    tracker.pending !== 0 && Math.sign(deltaY) !== Math.sign(tracker.pending);
  const accumulated = (reversed ? 0 : tracker.pending) + deltaY;
  const steps = Math.floor(Math.abs(accumulated) / WHEEL_STEP_PX);
  if (steps === 0) {
    return {
      tracker: { ...tracker, pending: accumulated },
      direction: null,
      steps: 0,
    };
  }
  const direction: WheelDirection = accumulated < 0 ? "back" : "forward";
  const notch = steps * WHEEL_STEP_PX;
  return {
    tracker: {
      // Spend the pixels with the accumulated sign, so the remainder keeps
      // its direction and is never a signed zero.
      pending: accumulated - (direction === "back" ? -notch : notch),
      lastStepAt: now,
    },
    direction,
    steps,
  };
}

/** The wheel half of the input map, machine commands only. */
export interface WheelCommands {
  wheelBack(): void;
  wheelForward(): void;
}

/**
 * Installs the wheel listener; returns a function that removes it. Nothing is
 * cancelled here: the page has `overflow: hidden` (index.html), so a wheel
 * event has no default behaviour worth preventing.
 */
export function installWheelInput(
  target: EventTarget,
  commands: WheelCommands,
): () => void {
  let tracker = initialWheelTracker;
  const onWheel = (event: Event): void => {
    const wheel = event as WheelEvent;
    const now = Number.isFinite(wheel.timeStamp) ? wheel.timeStamp : 0;
    const outcome = wheelPlan(wheel.deltaY, now, tracker);
    tracker = outcome.tracker;
    for (let step = 0; step < outcome.steps; step += 1) {
      if (outcome.direction === "back") commands.wheelBack();
      else commands.wheelForward();
    }
  };
  target.addEventListener("wheel", onWheel);
  return () => target.removeEventListener("wheel", onWheel);
}
