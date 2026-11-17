// When an item's picture comes in through its `transition`, and on what
// timings (docs/content-format.md, "Transitions"; docs/plan.md Phase 57
// item 3). Pure, so the rules are unit-tested without a DOM; the visual
// layer (render/visual.ts) draws them.
//
// Only reading on brings a transition in: Space, auto-forward, a pick on a
// choice screen entering where it leads, and a join or a pure choice's
// close reached by reading on (the machine's `read` arrival). Everything
// else cuts, as the plan's "Transitions never delay navigation or text"
// says: a skip step (every skip mode), a wheel step either way (going back
// is the wheel), a jump (the branch map, a bookmark, `e`, `u`, `#start`,
// and the load, which a reload and a resume go through), the reader's
// reduced-motion setting, and a menu holding the stage. A re-emit of the
// same arrival (a settle, a settings flip) starts nothing.

import type { Arrival, Item, Transition } from "../machine/types";

/** What `transitionFor` decides from. */
export interface TransitionCue {
  /** The item whose picture is about to be drawn (`visualIndex`). */
  readonly visual: Item | undefined;
  /** The item under the cursor. */
  readonly cursorItem: Item | undefined;
  /** The visual item drawn before this update; null for none. */
  readonly shownId: string | null;
  /** The machine's arrival now; undefined when the caller has none. */
  readonly arrival: Arrival | undefined;
  /** The arrival number the previous update was drawn for. */
  readonly lastArrival: number;
  /** A skip burst runs (`MachineState.skipping`). */
  readonly skipping: boolean;
  /** `prefers-reduced-motion: reduce` matches. */
  readonly reducedMotion: boolean;
  /** A menu holds the stage (`VisualLayer.setPaused`). */
  readonly held: boolean;
}

/**
 * The transition to draw now, or null to cut. It runs only on a fresh
 * `read` arrival at the item that carries it, entering a picture not
 * already on screen: reading onto a `text` item keeps the picture it
 * resolves to, and a re-arrival at the item on show changes no picture.
 * An item whose picture is the same file as the one before still runs
 * its transition (a dissolve between them shows nothing; a fade dips to
 * black and back, as Ren'Py's does).
 */
export function transitionFor(cue: TransitionCue): Transition | null {
  const { visual, arrival } = cue;
  if (visual === undefined || visual.type === "text") return null;
  const transition = visual.transition;
  if (transition === undefined) return null;
  if (arrival === undefined || arrival.number === cue.lastArrival) return null;
  if (arrival.kind !== "read") return null;
  if (cue.skipping || cue.reducedMotion || cue.held) return null;
  if (cue.cursorItem?.id !== visual.id) return null;
  if (cue.shownId === visual.id) return null;
  return transition;
}

/** One element's opacity ramp, in milliseconds from the transition's start. */
export interface Ramp {
  readonly delayMs: number;
  readonly durationMs: number;
}

/**
 * How a transition plays out on the two pictures. The incoming picture
 * ramps from opacity 0 to 1 (`incoming`), over the outgoing one; the
 * outgoing ramps from 1 to 0 (`outgoing`) for a fade, over the black
 * stage, and stays at 1 under a dissolve (null). `totalMs` is when the
 * last ramp ends and the outgoing picture can go.
 */
export interface TransitionPlan {
  readonly incoming: Ramp;
  readonly outgoing: Ramp | null;
  readonly totalMs: number;
}

/** The ramps of `transition`, from its seconds. */
export function transitionPlan(transition: Transition): TransitionPlan {
  if (transition.kind === "dissolve") {
    const durationMs = transition.seconds * 1000;
    return {
      incoming: { delayMs: 0, durationMs },
      outgoing: null,
      totalMs: durationMs,
    };
  }
  const outMs = transition.out * 1000;
  const holdMs = transition.hold * 1000;
  const inMs = transition.in * 1000;
  return {
    incoming: { delayMs: outMs + holdMs, durationMs: inMs },
    outgoing: { delayMs: 0, durationMs: outMs },
    totalMs: outMs + holdMs + inMs,
  };
}
