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

import type {
  Item,
  MachineSettings,
  MachineState,
  Scheduler,
  VideoItem,
} from "./types";

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
  /**
   * Bookmark click (the `t` overlay, README `t` bullet): move the cursor to
   * `index`, clamped to `[0, frontier - 1]`. The frontier never moves —
   * unseen items must be seen in order via `advance()`, so jumping ahead of
   * it (or having stored a bookmark from beyond the current frontier) is
   * clamped to seen content rather than entering or consuming it. The
   * arrival is UNSETTLED, unlike `jumpToUnseen()`'s settled landing: a
   * bookmark click "continues the novel from that time point", so the
   * item's text hold replays and auto-advance carries the reader onward.
   */
  goTo(index: number): void;
  /**
   * Video `ended` event for the current video item. It increments the item's
   * ended count, which must reach `loopCount` — alongside the time bound —
   * before a standalone video completes. Ignored when the item has
   * `holdSeconds` (a background video loops freely and never gates), while a
   * `text` item follows, during skip mode, and once the item is settled.
   */
  mediaEnded(): void;
  /**
   * `c` config screen (docs/plan.md Phase 9): replace the pacing settings
   * with a full snapshot; the machine copies it and never reads storage.
   * Changes apply live, each where its setting takes effect:
   *
   * - `readingSpeed` (and `skipDwellMs`): a pending auto-advance is
   *   re-armed as if the new settings had held since the item began, so
   *   the time already shown counts toward the new total — a 2400 ms hold
   *   changed to a 1200 ms one at 500 ms fires 700 ms later. A new total
   *   already behind the elapsed time fires on the next tick. An item
   *   with no pending timer (settled, or waiting on a video's `ended`) is
   *   not armed by this call.
   * - `skipAll`: read when skip mode meets the frontier, so a change
   *   takes effect at the next frontier crossing.
   *
   * After `destroy()` it is inert, like every other command.
   */
  setSettings(settings: MachineSettings): void;
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

/** Effective `loopCount` of a video item, default 1. */
function videoLoops(item: VideoItem): number {
  return item.loopCount ?? 1;
}

/**
 * A standalone video's media-gate time bound, in ms: `holdSeconds` when
 * present — the video is then background and only the clock gates — else
 * `durationSeconds * loopCount` (docs/content-format.md, "Timing").
 */
function videoGateMs(item: VideoItem): number {
  if (item.holdSeconds !== undefined) return item.holdSeconds * 1000;
  return item.durationSeconds * videoLoops(item) * 1000;
}

/**
 * Auto-advance delay for an item, in ms: the time the item must be on screen
 * before it may complete. `nextIsText` marks a media item whose following
 * item is `text`: the chain advances on text holds alone, so an animation's
 * loop time and a video's gate drop out. A standalone video's true advance
 * also waits for its `mediaEnded()` loops unless the chain applies, so the
 * ended count is a second condition the machine checks when this elapses.
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
  if (item.type === "video") return Math.max(hold, videoGateMs(item));
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
  const { items } = options;
  // Copied, and copied again on every setSettings(): the caller keeps
  // owning the object it passed (main.ts persists it), and later mutation
  // of it cannot silently retime the timeline.
  let settings: MachineSettings = { ...options.settings };
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
  /** `mediaEnded()` calls counted for the standalone video under the cursor. */
  let endedCount = 0;
  let timer: unknown = null;
  // When the timer now running was armed for the item under the cursor.
  // setSettings() re-arms from this instant, so the new settings act as
  // if they had held since the item began (the interface docs). Time
  // enters only through scheduler and Date.now, both fakeable in tests.
  let timerArmedAt = 0;
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

  /** The delay the current timer must cover, under the present settings. */
  function currentDelayMs(): number {
    if (skipping) {
      // Skip mode: one fixed `settings.skipDwellMs` per item whatever its
      // type. Media never gates and never plays to completion; the machine
      // only times (docs/content-format.md, "Timing"). A video's dwell is
      // clamped to its own gate, so a short clip is not shown longer than
      // the content describes.
      const item = items[cursor];
      if (item.type === "video") {
        return Math.min(settings.skipDwellMs, videoGateMs(item));
      }
      return settings.skipDwellMs;
    }
    return itemHoldMs(items[cursor], settings, nextIsText(cursor));
  }

  function onTimerElapsed(): void {
    timer = null;
    // `skipping` can only have changed through a re-arm, so dispatching
    // here matches the mode the timer was armed under.
    if (skipping) skipTick();
    else onHoldElapsed();
  }

  function armTimer(): void {
    cancelTimer();
    if (destroyed || count === 0) return;
    timerArmedAt = Date.now();
    timer = scheduler.schedule(onTimerElapsed, currentDelayMs());
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
    endedCount = 0; // every cursor change starts the video's loops afresh
    armTimer();
  }

  /**
   * Whether the media half of the current item's gate is met. Only a
   * standalone video gates on media: a `holdSeconds` video is background and
   * time-driven only, a video under a `text` chain loops beneath the chain
   * ungated, and every other type has no media condition. A video without
   * `holdSeconds` completes when BOTH its time bound has elapsed (checked at
   * the timer) AND `endedCount` has reached `loopCount` (checked at each
   * `mediaEnded()`), whichever happens last. A settled item bypasses the gate
   * entirely — its wait ended on the reader's press or on a resume /
   * `e`-jump landing, so ended counts are irrelevant to it.
   */
  function mediaGateSatisfied(): boolean {
    const item = items[cursor];
    if (item.type !== "video") return true;
    if (item.holdSeconds !== undefined || nextIsText(cursor)) return true;
    return endedCount >= videoLoops(item);
  }

  function onHoldElapsed(): void {
    holdElapsed = true;
    // The time half of the gate has elapsed; a video auto-advances only when
    // its ended count has reached `loopCount` too (docs/content-format.md,
    // "Timing").
    if (!mediaGateSatisfied()) return;
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
    endedCount = 0;
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

    goTo(index) {
      if (destroyed || count === 0) return;
      // A bookmark always points at content the reader had reached, but the
      // list outlives the moment it was written, so clamp defensively to
      // seen content `[0, frontier - 1]`: unseen items must be seen in
      // order via advance(), and jumping onto one would either show it out
      // of order or silently consume the frontier. (The cursor may move
      // either way — backward, or forward back to the frontier edge.)
      skipping = false; // like jumpToUnseen: manual navigation ends skip mode
      cursor = clamp(index, 0, frontier - 1);
      beginItem(); // unsettled arrival: the item replays under its own hold
      emit();
    },

    mediaEnded() {
      // During skip a video never plays (the renderer shows the poster), so
      // media-end events are irrelevant; guard against a straggler.
      if (destroyed || count === 0 || settled || skipping) return;
      const item = items[cursor];
      if (item.type !== "video") return;
      // A background (`holdSeconds`) video and a video under a text chain
      // loop freely: their `ended` events gate nothing, so they are dropped
      // rather than counted.
      if (item.holdSeconds !== undefined || nextIsText(cursor)) return;
      endedCount += 1;
      if (holdElapsed && mediaGateSatisfied()) moveForward();
    },

    setSettings(next) {
      settings = { ...next }; // caller keeps owning its object
      if (destroyed || count === 0) return;
      // Only a live auto-advance is re-timed; a settled item (or one
      // waiting on a video's `ended`) owns no timer to re-arm. The new
      // delay is measured from when this item's timer was armed, so the
      // time already shown counts toward the new total.
      if (timer === null) return;
      const remainingMs = Math.max(
        0,
        currentDelayMs() - (Date.now() - timerArmedAt),
      );
      cancelTimer();
      timer = scheduler.schedule(onTimerElapsed, remainingMs);
    },

    destroy() {
      destroyed = true;
      cancelTimer();
      listeners.clear();
    },
  };
}
