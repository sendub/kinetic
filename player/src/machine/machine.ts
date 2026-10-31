// Timeline state machine core (docs/plan.md Phase 3). Pure TypeScript:
// no DOM, no imports beyond ./types. Commands in, state out; time enters
// through an injected Scheduler so tests are deterministic.
//
// Frontier invariant: frontier === 1 + the highest item index ever shown,
// clamped to items.length. A first-ever load starts at item 0 (already
// shown, so frontier 1); a resume starts AT the persisted frontier, which
// marks that item shown. Therefore cursor is always in [0, frontier - 1],
// the wheel can return through seen items but never enter unseen content,
// and advance() past the last shown item pushes the frontier forward.

import type { Item, MachineSettings, MachineState, Scheduler } from "./types";

export interface MachineOptions {
  items: readonly Item[];
  settings: MachineSettings;
  /**
   * Persisted frontier from a previous session. When present, the machine
   * resumes at that item instead of item 0. Out-of-range values clamp.
   */
  resumeFrontier?: number;
  /** Defaults to the global setTimeout/clearTimeout. */
  scheduler?: Scheduler;
}

export interface Machine {
  getState(): MachineState;
  /** Receives every state change; returns an unsubscribe function. */
  subscribe(listener: (state: MachineState) => void): () => void;
  /** Space press: settles an unsettled item, else moves the cursor. */
  advance(): void;
  /** Wheel step back; clamps at item 0. */
  wheelBack(): void;
  /** Wheel step forward; never passes the frontier into unseen items. */
  wheelForward(): void;
  /** Video `ended` event for the current video item. */
  mediaEnded(): void;
  /** Cancels the pending timer and drops all subscribers. */
  destroy(): void;
}

export const defaultScheduler: Scheduler = {
  schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  cancel: (handle) => globalThis.clearTimeout(handle as never),
};

/** Text hold in ms: max(minHold, codepoints(text) * msPerChar / speed). */
export function textHoldMs(
  text: string | undefined,
  settings: MachineSettings,
): number {
  const chars = [...(text ?? "")].length;
  if (chars === 0) return settings.minHoldMs;
  return Math.max(
    settings.minHoldMs,
    (chars * settings.msPerChar) / settings.readingSpeed,
  );
}

/**
 * Auto-advance delay for an item, in ms. A video's true advance also waits
 * for mediaEnded(), so this is its lower bound (the text hold).
 */
export function itemHoldMs(item: Item, settings: MachineSettings): number {
  const hold = textHoldMs(item.text, settings);
  if (item.type === "animation") {
    const loopMs = (item.frames.length * item.loopCount * 1000) / item.fps;
    return Math.max(hold, loopMs);
  }
  return hold;
}

type Listener = (state: MachineState) => void;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

export function createMachine(options: MachineOptions): Machine {
  const { items, settings } = options;
  const scheduler = options.scheduler ?? defaultScheduler;
  const count = items.length;

  const listeners = new Set<Listener>();
  let cursor =
    count === 0 ? 0 : clamp(options.resumeFrontier ?? 0, 0, count - 1);
  // The item under the cursor counts as shown the moment it is shown.
  let frontier = count === 0 ? 0 : Math.min(cursor + 1, count);
  let settled = false;
  let holdElapsed = false;
  let videoEnded = false;
  let timer: unknown = null;
  let destroyed = false;
  let state: MachineState = snapshot();
  armTimer(); // the item shown at start auto-advances too

  function snapshot(): MachineState {
    return Object.freeze({ cursor, frontier, settled });
  }

  function emit(): void {
    state = snapshot();
    for (const listener of [...listeners]) listener(state);
  }

  function cancelTimer(): void {
    if (timer !== null) {
      scheduler.cancel(timer);
      timer = null;
    }
  }

  function armTimer(): void {
    cancelTimer();
    if (destroyed || count === 0) return;
    const delayMs = itemHoldMs(items[cursor], settings);
    timer = scheduler.schedule(() => {
      timer = null;
      onHoldElapsed();
    }, delayMs);
  }

  /** Fresh view of the item under the cursor. */
  function beginItem(): void {
    settled = false;
    holdElapsed = false;
    videoEnded = false;
    armTimer();
  }

  function onHoldElapsed(): void {
    holdElapsed = true;
    // A video auto-advances at the later of the text hold and `ended`.
    if (items[cursor].type === "video" && !videoEnded) return;
    moveForward();
  }

  function moveForward(): void {
    if (count === 0 || destroyed) return;
    if (cursor >= count - 1) {
      // Nothing unseen ahead: the shown item is simply settled.
      settled = true;
      emit();
      return;
    }
    cursor += 1;
    if (cursor >= frontier) frontier = Math.min(cursor + 1, count);
    beginItem();
    emit();
  }

  function moveVisible(newCursor: number): void {
    cursor = newCursor;
    beginItem();
    emit();
  }

  return {
    getState() {
      return state;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    advance() {
      if (destroyed || count === 0) return;
      if (!settled) {
        // Immediate-complete: the item's wait ends now, but the cursor
        // stays; the next advance() moves on.
        settled = true;
        cancelTimer();
        emit();
        return;
      }
      moveForward();
    },

    wheelBack() {
      if (destroyed || cursor === 0) return;
      moveVisible(cursor - 1);
    },

    wheelForward() {
      if (destroyed || cursor + 1 >= frontier) return;
      moveVisible(cursor + 1);
    },

    mediaEnded() {
      if (destroyed || count === 0 || settled || videoEnded) return;
      if (items[cursor].type !== "video") return;
      videoEnded = true;
      if (holdElapsed) moveForward();
    },

    destroy() {
      destroyed = true;
      cancelTimer();
      listeners.clear();
    },
  };
}
