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

/** Wheel pixels one machine step costs a LARGE delta (a fast flick). */
export const WHEEL_STEP_PX = 100;

/**
 * Wheel pixels below which an event is not a tick at all: trackpad inertia
 * tails and pointer jitter. Events at or above it are a deliberate notch,
 * however small, and move one item (docs/plan.md Phase 16).
 */
export const WHEEL_TICK_MIN_PX = 8;

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
 * - Steps: one event at or above `WHEEL_TICK_MIN_PX` moves at least one item
 *   (docs/plan.md Phase 16 — "one tick of the wheel is one step", so a
 *   half-notch 50 px event, or a trackpad notch under 100 px, no longer needs
 *   a second event to land anywhere). Past one step's worth the delta is
 *   priced as it always was, `WHEEL_STEP_PX` per step with the remainder kept
 *   toward the next notch, so a 500 px fling is five items and a 250 px fling
 *   is two with 50 px still to spend. Below `WHEEL_TICK_MIN_PX` an event is
 *   not a tick and accumulates instead — that is what stops an inertia tail
 *   from walking the timeline after the finger has left the trackpad.
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
  const magnitude = Math.abs(accumulated);
  if (magnitude < WHEEL_TICK_MIN_PX) {
    return {
      tracker: { ...tracker, pending: accumulated },
      direction: null,
      steps: 0,
    };
  }
  const direction: WheelDirection = accumulated < 0 ? "back" : "forward";
  const steps = Math.max(1, Math.floor(magnitude / WHEEL_STEP_PX));
  // A sub-notch tick spends every pixel it brought (nothing is carried), so
  // the next tick is worth a whole step on its own; a flick spends the steps
  // it was priced at and keeps the change. The remainder keeps the
  // accumulated sign, so it is never a signed zero.
  const spend = Math.min(magnitude, steps * WHEEL_STEP_PX);
  return {
    tracker: {
      pending: accumulated - (direction === "back" ? -spend : spend),
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
