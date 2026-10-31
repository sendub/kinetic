// Timeline state machine core (docs/plan.md Phases 3-4). Pure TypeScript:
// no DOM, no imports beyond ./types. Commands in, state out; time enters
// through an injected Scheduler so tests are deterministic.
//
// Frontier invariant: frontier === 1 + the highest item index ever shown,
// clamped to items.length. A first-ever load starts at item 0 (already
// shown, so frontier 1). A resume keeps the persisted frontier and starts
// at its last shown item (frontier - 1), the same spot jumpToUnseen()
// lands on; that landing counts as settled, so one advance() shows the
// first unseen item. Therefore cursor is always in [0, frontier - 1], the
// wheel can return through seen items but never enter unseen content,
// and advance() past the last shown item pushes the frontier forward.
//
// Skip mode (tab) advances one item per settings.skipDwellMs regardless of
// media: with skip_all off it ends when the cursor moves onto the first
// never-shown item (which is then shown normally); with skip_all on it
// marks items seen as it shows them and ends at content end.

import type { Item, MachineSettings, MachineState, Scheduler } from "./types";

export interface MachineOptions {
  items: readonly Item[];
  settings: MachineSettings;
  /**
   * Persisted frontier from a previous session: the first never-shown
   * item, one past the last item the reader saw. The machine then starts
   * on that last seen item (frontier - 1), the spot `jumpToUnseen()`
   * lands on. Out-of-range values clamp.
   */
  resumeFrontier?: number;
  /** Defaults to the global setTimeout/clearTimeout. */
  scheduler?: Scheduler;
}

export interface Machine {
  getState(): MachineState;
  /**
   * Index of the item whose visual to render, `items[visualIndex()]`. It
   * equals `cursor` for a media item and the nearest earlier media item for a
   * `text` item, whose visual keeps looping underneath the chain.
   */
  visualIndex(): number;
  /** Receives every state change; returns an unsubscribe function. */
  subscribe(listener: (state: MachineState) => void): () => void;
  /**
   * Space press: during skip mode, exits skip mode and then behaves
   * normally — settles an unsettled item, else moves the cursor.
   */
  advance(): void;
  /**
   * Wheel step back; clamps at item 0. During skip mode, exits skip mode
   * and still performs the step.
   */
  wheelBack(): void;
  /**
   * Wheel step forward; never passes the frontier into unseen items.
   * During skip mode, exits skip mode and steps when allowed.
   */
  wheelForward(): void;
  /**
   * Tab press: toggles skip mode. While on, every item advances after
   * `settings.skipDwellMs` regardless of text/animation/video; media never
   * gates. With `settings.skipAll` off the mode ends when the cursor moves
   * onto the first never-shown item (shown normally afterward); with it on
   * the mode continues through unseen items, marking them seen, and ends
   * when the last item of content has been shown.
   */
  toggleSkip(): void;
  /**
   * `e` press: cursor to the last shown item (`frontier - 1`), the resume
   * position; no-op when already there. Marks nothing new seen.
   */
  jumpToUnseen(): void;
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
 * Auto-advance delay for an item, in ms. `nextIsText` marks a media item
 * whose following item is `text`: the chain advances on text holds alone, so
 * an animation's loop time does not apply. A video's true advance also waits
 * for mediaEnded() unless the chain applies, so this is its lower bound (the
 * text hold).
 */
export function itemHoldMs(
  item: Item,
  settings: MachineSettings,
  nextIsText = false,
): number {
  const hold = textHoldMs(item.text, settings);
  if (nextIsText) return hold;
  if (item.type === "animation") {
    const loopMs = (item.frames.length * item.loopCount * 1000) / item.fps;
    return Math.max(hold, loopMs);
  }
  return hold;
}

/**
 * Index of the item whose visual the renderer draws at position `index`
 * (`items[visualIndexFor(items, index)]`). A media item shows its own
 * visual; a `text` item shows the visual of the nearest earlier
 * media-bearing item, which keeps looping underneath the chain
 * (docs/content-format.md, "Text items"). A `text` item before any media
 * item is a schema violation; index 0 is returned then, so the result is
 * always a usable index for a non-empty manifest.
 */
export function visualIndexFor(items: readonly Item[], index: number): number {
  if (items[index]?.type !== "text") return index;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (items[i].type !== "text") return i;
  }
  return 0;
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
  let cursor = 0;
  // First-ever load: item 0 starts shown, so the frontier is one past it.
  let frontier = count === 0 ? 0 : 1;
  let settled = false;
  if (count > 0 && options.resumeFrontier !== undefined) {
    // Resume (and e-jump) lands on the last seen item, frontier - 1, and
    // marks nothing new seen. The landing item counts as settled — it was
    // shown in a past session — so one advance() enters unseen content.
    frontier = clamp(options.resumeFrontier, 1, count);
    cursor = frontier - 1;
    settled = true;
  }
  let skipping = false;
  let holdElapsed = false;
  let videoEnded = false;
  let timer: unknown = null;
  let destroyed = false;
  let state: MachineState = snapshot();
  armTimer(); // the item shown at start auto-advances too

  function snapshot(): MachineState {
    return Object.freeze({ cursor, frontier, settled, skipping });
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
    if (skipping) {
      // Skip mode: one fixed `settings.skipDwellMs` per item whatever its
      // type. Media never gates and never plays to completion; the machine
      // only times (docs/content-format.md, "Timing").
      timer = scheduler.schedule(() => {
        timer = null;
        skipTick();
      }, settings.skipDwellMs);
      return;
    }
    const delayMs = itemHoldMs(items[cursor], settings, nextIsText(cursor));
    timer = scheduler.schedule(() => {
      timer = null;
      onHoldElapsed();
    }, delayMs);
  }

  /**
   * True when the item after `index` is `text`. The two then form a chain
   * that advances on text holds alone: loop completion and the video `ended`
   * event gate nothing while it lasts (docs/content-format.md, "Timing").
   */
  function nextIsText(index: number): boolean {
    return items[index + 1]?.type === "text";
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
    // A video auto-advances at the later of the text hold and `ended`, except
    // when a `text` item follows: the renderer keeps it looping underneath
    // the chain and the machine does not gate the advance on media end.
    if (items[cursor].type === "video" && !nextIsText(cursor) && !videoEnded) {
      return;
    }
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

  /**
   * Skip-mode dwell elapsed. One fixed-dwell step forward: a media item
   * followed by `text`, and each `text` line of a chain, each consume
   * exactly one dwell (chains are never collapsed). The mode ends when the
   * step moves onto the first never-shown item with `skipAll` off, or when
   * the last item of content has been shown; the ending item is then shown
   * normally, its auto-advance armed per its own hold.
   */
  function skipTick(): void {
    if (destroyed || count === 0) return;
    if (cursor < count - 1) {
      const enteringUnseen = cursor + 1 >= frontier;
      cursor += 1;
      if (enteringUnseen) frontier = Math.min(cursor + 1, count);
      if ((enteringUnseen && !settings.skipAll) || cursor >= count - 1) {
        skipping = false;
      }
    } else {
      // Dwell elapsed on the last item; nothing is left to skip.
      skipping = false;
    }
    beginItem(); // arms a dwell if skipping, else the item's normal hold
    emit();
  }

  /** Leave skip mode; the current item restarts under its normal hold. */
  function exitSkip(): void {
    skipping = false;
    beginItem();
  }

  /**
   * `e`-jump / resume landing on `frontier - 1`, the last shown item. The
   * landing counts as settled — that item was already seen — so the next
   * advance() enters unseen content; auto-advance is armed per its hold.
   */
  function landOnLastSeen(): void {
    cursor = frontier - 1;
    holdElapsed = false;
    videoEnded = false;
    settled = true;
    armTimer();
    emit();
  }

  return {
    getState() {
      return state;
    },

    visualIndex() {
      return visualIndexFor(items, cursor);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    advance() {
      if (destroyed || count === 0) return;
      if (skipping) {
        // Space during skip exits skip mode, then behaves normally: the
        // current item has not met its own hold, so this press settles it.
        exitSkip();
      }
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
      if (destroyed) return;
      // Decision (docs/plan.md Phase 4): a wheel step during skip exits
      // skip mode AND performs the step — the step is what the user
      // meant; merely dropping it would feel like a dead input.
      const wasSkipping = skipping;
      if (skipping) skipping = false; // a clamped step exits skip too
      if (cursor === 0) {
        if (wasSkipping) {
          beginItem(); // normal timing for the item left under the cursor
          emit();
        }
        return;
      }
      moveVisible(cursor - 1);
    },

    wheelForward() {
      if (destroyed) return;
      const wasSkipping = skipping;
      if (skipping) skipping = false; // same decision as wheelBack()
      if (cursor + 1 >= frontier) {
        if (wasSkipping) {
          beginItem(); // blocked step still ends skip: normal timing again
          emit();
        }
        return;
      }
      moveVisible(cursor + 1);
    },

    toggleSkip() {
      if (destroyed || count === 0) return;
      if (skipping) {
        exitSkip(); // tab again: manual off, normal timing from here
      } else {
        skipping = true;
        beginItem(); // the current item gets a fresh dwell too
      }
      emit();
    },

    jumpToUnseen() {
      if (destroyed || count === 0) return;
      if (cursor === frontier - 1) return; // already there: stay
      skipping = false; // a jump is manual navigation: skip mode is off
      landOnLastSeen();
    },

    mediaEnded() {
      // During skip a video never plays (the renderer shows the poster), so
      // media-end events are irrelevant; guard against a straggler.
      if (destroyed || count === 0 || settled || videoEnded || skipping) {
        return;
      }
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
