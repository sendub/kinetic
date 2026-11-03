import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeProgress } from "../render/bookmarks";
import { createContextCodec, resumeOptionsFor } from "../storage/ids";
import { createMemoryStorage } from "../storage/memory";
import {
  AUTO_PICK_MIN_MS,
  AUTO_PICK_SHOW_MS,
  createMachine,
  itemHoldMs,
  textHoldMs,
  visualIndexFor,
} from "./machine";
import type {
  Branch,
  Item,
  MachineSettings,
  MachineState,
  Manifest,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

const SETTINGS: MachineSettings = { ...DEFAULT_SETTINGS };

function image(text?: string): Item {
  return { id: "img", type: "image", file: "img.jpg", text };
}

function text(content?: string): Item {
  return { id: "line", type: "text", text: content };
}

function animation(
  frames: number,
  fps: number,
  loopCount: number,
  text?: string,
): Item {
  return {
    id: "anim",
    type: "animation",
    frames: Array.from({ length: frames }, (_, i) => `anim.f${i}.jpg`),
    fps,
    loopCount,
    text,
  };
}

function video(
  durationSeconds = 10,
  text?: string,
  timing: {
    loopCount?: number;
    holdSeconds?: number;
    startSeconds?: number;
    endSeconds?: number;
    loopStartSeconds?: number;
    minPlaySeconds?: number;
  } = {},
): Item {
  return {
    id: "vid",
    type: "video",
    file: "vid.mp4",
    poster: "vid.poster.jpg",
    durationSeconds,
    text,
    loopCount: timing.loopCount,
    holdSeconds: timing.holdSeconds,
    startSeconds: timing.startSeconds,
    endSeconds: timing.endSeconds,
    loopStartSeconds: timing.loopStartSeconds,
    minPlaySeconds: timing.minPlaySeconds,
  };
}

function manifest(items: readonly Item[]): Manifest {
  return { schemaVersion: 1, width: 1280, height: 720, items };
}

function machine(
  items: readonly Item[],
  opts: {
    resumeFrontier?: number;
    settings?: MachineSettings;
    /** false: the player's manual start, for press-driven tests. */
    auto?: boolean;
  } = {},
) {
  return createMachine({
    items,
    settings: opts.settings ?? SETTINGS,
    resumeFrontier: opts.resumeFrontier,
    // These tests ride the AUTO-timed path (holds fire on the timer), so
    // they opt in: the player's own start — and the machine's default —
    // is manual (Phase 13b), pinned by the explicit manual tests below.
    autoAdvance: opts.auto !== false,
  });
}

/**
 * Reads a linear manifest forward with presses until `target` is on screen,
 * reading every item on the way. A Space press in auto
 * mode turns auto off (docs/plan.md Phase 18), so the presses go in manual
 * — one press, one step — and auto comes back on with the landing's hold.
 */
function readTo(m: ReturnType<typeof createMachine>, target: number): void {
  if (m.getState().cursor >= target) return;
  const auto = m.isAutoAdvance();
  if (auto) m.setAutoAdvance(false);
  while (m.getState().cursor < target) m.advance();
  if (auto) m.setAutoAdvance(true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("hold computation (docs/content-format.md Timing)", () => {
  it("applies minHold to short or absent text", () => {
    expect(textHoldMs(undefined, SETTINGS)).toBe(1500);
    expect(textHoldMs("Hi.", SETTINGS)).toBe(1500); // 3 chars * 60 = 180 < 1500
  });

  it("uses chars * msPerChar / readingSpeed above minHold", () => {
    const long = "a".repeat(40); // 40 * 60 = 2400
    expect(textHoldMs(long, SETTINGS)).toBe(2400);
    // Speed 2 gives 1200 ms, but minHold floors it back to 1500.
    expect(textHoldMs(long, { ...SETTINGS, readingSpeed: 2 })).toBe(1500);
    expect(textHoldMs("a".repeat(60), { ...SETTINGS, readingSpeed: 2 })).toBe(
      1800,
    ); // 60 * 60 / 2 = 1800 > 1500
  });

  it("counts code points, not UTF-16 units", () => {
    expect(textHoldMs("😀".repeat(30), SETTINGS)).toBe(1800);
  });

  it("animation hold is the later of loop time and text hold", () => {
    // 10 frames * 2 loops / 5 fps = 4 s.
    expect(itemHoldMs(animation(10, 5, 2), SETTINGS)).toBe(4000);
    // 3 * 3 / 12 = 0.75 s < minHold.
    expect(itemHoldMs(animation(3, 12, 3), SETTINGS)).toBe(1500);
  });

  it("standalone video hold is the later of its media gate and the text hold", () => {
    // durationSeconds 10 * loopCount 1 = 10 s, above minHold.
    expect(itemHoldMs(video(10), SETTINGS)).toBe(10_000);
    // A 1 s clip sits under minHold, so the text hold floors the gate.
    expect(itemHoldMs(video(1), SETTINGS)).toBe(1500);
    // loopCount scales the time bound; holdSeconds replaces it.
    expect(itemHoldMs(video(1, undefined, { loopCount: 2 }), SETTINGS)).toBe(
      2000,
    );
    expect(itemHoldMs(video(1, undefined, { holdSeconds: 8 }), SETTINGS)).toBe(
      8000,
    );
    // ... and the text hold still floors a short holdSeconds.
    expect(
      itemHoldMs(video(30, "a".repeat(40), { holdSeconds: 1 }), SETTINGS),
    ).toBe(2400);
  });

  it("media item followed by text holds the text hold alone", () => {
    // nextIsText: the animation loop time (4000) drops out entirely.
    expect(itemHoldMs(animation(10, 5, 2), SETTINGS, true)).toBe(1500);
    expect(
      itemHoldMs(animation(10, 5, 2, "a".repeat(40)), SETTINGS, true),
    ).toBe(2400);
    expect(itemHoldMs(video(10, "a".repeat(40)), SETTINGS, true)).toBe(2400);
    expect(itemHoldMs(image("a".repeat(40)), SETTINGS, true)).toBe(2400);
  });
});

describe("advance() through every item type", () => {
  it("first-ever load starts at item 0 with frontier one past it", () => {
    const m = machine(manifest([image(), animation(3, 12, 3), video()]).items);
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    m.destroy();
  });

  it("in auto, the first press turns auto off in place; then one press per step", () => {
    vi.useFakeTimers();
    const items = manifest([
      image("first"),
      animation(3, 12, 3),
      video(),
    ]).items;
    const m = machine(items);
    // docs/plan.md Phase 18: Space during auto-forward returns to manual —
    // nothing moves and nothing settles on that press.
    m.advance();
    expect(m.isAutoAdvance()).toBe(false);
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    // Manual from here: each press moves one item.
    m.advance();
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    m.advance(); // onto the video
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    // At the last item, a press settles it with the frontier at the end.
    m.advance();
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: true,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });
});

describe("auto-advance timing", () => {
  it("image fires at max(minHold, text hold) and moves the frontier", () => {
    vi.useFakeTimers();
    const m = machine([image("a".repeat(40)), image()]); // 2400 ms hold
    vi.advanceTimersByTime(2399);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });

  it("Space in auto cancels the pending auto-advance and returns to manual", () => {
    vi.useFakeTimers();
    const m = machine([image(), image(), image()]);
    const seen: MachineState[] = [];
    m.subscribe((state) => seen.push(state));
    vi.advanceTimersByTime(1000); // part of the 1500 ms hold
    m.advance(); // docs/plan.md Phase 18: auto off, the reader stays here
    expect(m.isAutoAdvance()).toBe(false);
    vi.advanceTimersByTime(60_000); // no hold is armed any more
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    expect(seen).toHaveLength(0); // the press changed nothing on screen
    m.advance(); // the next press steps, manual-style
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(60_000); // and manual waits for the reader
    expect(m.getState().cursor).toBe(1);
    m.setAutoAdvance(true); // `a` brings auto back with a fresh hold
    vi.advanceTimersByTime(1500);
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });

  it("respects the reading-speed setting", () => {
    vi.useFakeTimers();
    const settings = { ...SETTINGS, readingSpeed: 2 }; // 60 chars -> 1800 ms
    const m = machine([image("a".repeat(60)), image()], { settings });
    vi.advanceTimersByTime(1799);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("animation fires at its loop time when the loops outlast the text", () => {
    vi.useFakeTimers();
    const m = machine([animation(10, 5, 2, "short"), image()]); // 4000 > 1500
    vi.advanceTimersByTime(1500);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(2500);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("animation fires at the text hold when the text outlasts the loops", () => {
    vi.useFakeTimers();
    const m = machine([animation(3, 12, 3, "a".repeat(48)), image()]); // 2880 > 750
    vi.advanceTimersByTime(2879);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });
});

describe("manual and auto modes, pause/resume (docs/plan.md Phase 13b)", () => {
  // The player starts manual (README advance bullet): a machine built
  // without `autoAdvance` arms no hold for plain items — only the
  // reader's presses move it — and `setAutoAdvance` is the `a` toggle.
  function manualMachine(items: readonly Item[]) {
    return createMachine({ items, settings: SETTINGS });
  }

  it("manual by default: nothing on the timer, and one press is one step", () => {
    vi.useFakeTimers();
    // 1800 ms hold, which manual mode never waits for.
    const m = manualMachine([image("a".repeat(30)), image(), image()]);
    vi.advanceTimersByTime(60_000);
    expect(m.getState().cursor).toBe(0);
    // docs/plan.md Phase 16: the press ends the item's wait AND moves the
    // cursor — no settle-only press in front of every step.
    m.advance();
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    vi.advanceTimersByTime(60_000); // the fresh item waits for the reader too
    expect(m.getState().cursor).toBe(1);
    m.advance(); // the next press steps one further
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    m.advance(); // at the last item there is nowhere to go: it settles
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: true,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });

  it("manual space during skip stops the burst on the item under the cursor", () => {
    vi.useFakeTimers();
    const m = createMachine({
      items: [image(), image(), image(), image()],
      settings: SETTINGS,
      resumeFrontier: 4, // all seen, so the burst runs past item 1
    }); // manual by default
    m.goTo(0);
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs); // 0 -> 1
    expect(m.getState().cursor).toBe(1);
    expect(m.getState().skipping).toBe(true);
    m.advance(); // stops skipping HERE: the reader meant this item
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 4,
      settled: true,
      skipping: false,
      transition: "nav",
    });
    m.advance(); // and only the next press moves on
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });

  // `a` counts time already shown (docs/plan.md Phase 20): turning auto on
  // waits only for what is left of the item's hold, measured from when the
  // item first appeared — time under help or settings counts as shown.
  it("setAutoAdvance(true) waits only for the hold left since the item appeared", () => {
    vi.useFakeTimers();
    const m = manualMachine([image("a".repeat(20)), image()]); // 1500 ms hold
    vi.advanceTimersByTime(1000); // shown for 1000 ms in manual
    m.setAutoAdvance(true);
    expect(m.isAutoAdvance()).toBe(true);
    vi.advanceTimersByTime(499);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(1499); // the next item gets its own full hold
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("setAutoAdvance(true) moves on promptly once the hold has already passed", () => {
    vi.useFakeTimers();
    const m = manualMachine([image("a".repeat(20)), image()]); // 1500 ms hold
    vi.advanceTimersByTime(59_000); // up far longer than its hold
    m.setAutoAdvance(true);
    vi.advanceTimersByTime(0); // the next tick
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("time under a pause (help, settings) counts as shown when `a` turns auto on", () => {
    vi.useFakeTimers();
    const m = manualMachine([image("a".repeat(30)), image()]); // 1800 ms hold
    vi.advanceTimersByTime(500);
    m.pause(); // help opens
    vi.advanceTimersByTime(1000);
    m.resume(); // closed after 1500 ms on screen
    m.setAutoAdvance(true);
    vi.advanceTimersByTime(299);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("setAutoAdvance(false) cancels the pending hold; turning on counts the time shown", () => {
    vi.useFakeTimers();
    const m = createMachine({
      items: [image("a".repeat(30)), image(), image()], // 1800 ms hold
      settings: SETTINGS,
      autoAdvance: true,
    });
    vi.advanceTimersByTime(900);
    m.setAutoAdvance(false);
    vi.advanceTimersByTime(600);
    expect(m.getState().cursor).toBe(0);
    m.setAutoAdvance(true); // 1500 ms shown: 300 ms left, not a fresh 1800
    vi.advanceTimersByTime(299);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("setAutoAdvance(true) on a video still waits for its ended report", () => {
    vi.useFakeTimers();
    const m = manualMachine([video(10), image()]); // 10 s time bound
    vi.advanceTimersByTime(12_000); // the bound has passed, no `ended` yet
    m.setAutoAdvance(true);
    vi.advanceTimersByTime(60_000);
    expect(m.getState().cursor).toBe(0);
    m.mediaEnded(); // the pass completes: the gate is now met
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("setAutoAdvance(true) on a video that already ended moves on promptly", () => {
    vi.useFakeTimers();
    const m = manualMachine([video(10), image()]);
    vi.advanceTimersByTime(10_000);
    m.mediaEnded(); // reported while manual: counted, nothing moves
    vi.advanceTimersByTime(2000);
    expect(m.getState().cursor).toBe(0);
    m.setAutoAdvance(true);
    vi.advanceTimersByTime(0);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("manual mode still runs the skip dwell, then waits", () => {
    vi.useFakeTimers();
    const m = createMachine({
      items: [image(), image(), image()],
      settings: SETTINGS,
      resumeFrontier: 3, // all seen; the resume lands on item 2 settled
    }); // manual by default, as everywhere in this block
    m.wheelBack();
    m.wheelBack(); // back to item 0 inside seen content
    m.toggleSkip(); // the dwell is the reader's own run: both modes
    const dwell = SETTINGS.skipDwellMs;
    vi.advanceTimersByTime(dwell * 2); // 0 -> 1 -> 2, one fixed dwell each
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().skipping).toBe(false); // ends as the frontier item is current
    vi.advanceTimersByTime(60_000); // shown normally — and manual: it waits
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });

  it("pause() freezes the armed hold; resume() re-arms it fresh", () => {
    vi.useFakeTimers();
    const m = createMachine({
      items: [image("a".repeat(30)), image()], // 1800 ms hold
      settings: SETTINGS,
      autoAdvance: true,
    });
    vi.advanceTimersByTime(1000);
    m.pause(); // the help screen opens over a black stage
    vi.advanceTimersByTime(60_000); // no timers behind the help
    expect(m.getState().cursor).toBe(0);
    m.resume(); // closed: the same item, its hold re-armed from now
    vi.advanceTimersByTime(1799);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("pause() freezes a skip burst; resume() continues it (menus, Phase 18)", () => {
    vi.useFakeTimers();
    const m = createMachine({
      items: [image(), image(), image(), image(), image()],
      settings: { ...SETTINGS, skipAll: true },
    }); // manual: the burst is the reader's own run
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs); // 0 -> 1
    vi.advanceTimersByTime(SETTINGS.skipDwellMs - 5);
    m.pause(); // the `c` screen opens
    vi.advanceTimersByTime(60_000); // nothing advances behind it
    expect(m.getState()).toMatchObject({ cursor: 1, skipping: true });
    m.resume(); // closed: the burst carries on, a fresh dwell first
    vi.advanceTimersByTime(SETTINGS.skipDwellMs - 1);
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(1);
    expect(m.getState()).toMatchObject({ cursor: 2, skipping: true });
    m.destroy();
  });

  it("a bookmark restore while paused ends the burst; resume arms only the hold", () => {
    vi.useFakeTimers();
    const m = createMachine({
      items: [image(), image(), image(), image(), image()],
      settings: { ...SETTINGS, skipAll: true },
      autoAdvance: true,
    });
    const mark = m.exportContext(); // a bookmark on item 0
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs * 2); // 0 -> 2
    m.pause(); // `t` opens
    m.importContext(mark); // an entry click jumps back to item 0
    vi.advanceTimersByTime(60_000);
    expect(m.getState()).toMatchObject({ cursor: 0, skipping: false });
    m.resume(); // the screen closed: auto-forward stays on, no burst
    vi.advanceTimersByTime(1499);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1); // the landing's own 1500 ms hold
    expect(m.getState()).toMatchObject({ cursor: 1, skipping: false });
    m.destroy();
  });

  it("pause/resume in manual mode arms nothing (first-load help)", () => {
    vi.useFakeTimers();
    const m = manualMachine([image(), image()]);
    m.pause();
    m.resume();
    vi.advanceTimersByTime(60_000);
    expect(m.getState().cursor).toBe(0);
    m.destroy();
  });

  it("resume on a settled item arms nothing: settled items move on presses", () => {
    vi.useFakeTimers();
    const m = createMachine({
      items: [image(), image(), image()],
      settings: SETTINGS,
      resumeFrontier: 2, // a resume landing: item 1, settled
      autoAdvance: true,
    });
    m.pause();
    m.resume();
    vi.advanceTimersByTime(60_000);
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: true,
      skipping: false,
      transition: "nav",
    });
    m.destroy();
  });

  it("mediaEnded while paused counts but never moves; resume lets the hold decide", () => {
    vi.useFakeTimers();
    const m = createMachine({
      items: [video(10), image()], // media-gated: the hold waits for ended
      settings: SETTINGS,
      autoAdvance: true,
    });
    vi.advanceTimersByTime(1000);
    m.pause();
    m.mediaEnded(); // reported behind the help: counted, not moved
    vi.advanceTimersByTime(60_000);
    expect(m.getState().cursor).toBe(0);
    m.resume(); // hold re-armed fresh
    vi.advanceTimersByTime(11_000); // the video's full gate, then it moves
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("ctx restore brings the seen edge with it: forward to the frontier still works after a resume", () => {
    // Phase 13b verification found applyContext left `highestSeen` at the
    // landing item: a resumed reader's wheel-forward ceiling (and the
    // derived frontier) had shrunk from the seen edge to wherever the
    // reading sat. The seen set was restored; the seen edge was not.
    const items = [image(), image(), image(), image(), image()];
    const first = manualMachine(items);
    for (let press = 0; press < 3; press += 1) first.advance(); // seen 0..3
    expect(first.getState()).toMatchObject({ cursor: 3, frontier: 4 });
    first.goTo(1); // a `t` click back inside seen content: the cursor moves…
    expect(first.getState()).toMatchObject({ cursor: 1, frontier: 4 }); // the edge does not
    // A restore keeps only the seen set and the landing, so the seen edge
    // must come from the seen set.
    const ctx = first.exportContext();
    first.destroy();

    const resumed = createMachine({
      items,
      settings: SETTINGS,
      resumeContext: ctx,
    });
    expect(resumed.getState()).toMatchObject({
      cursor: 1,
      frontier: 4, // the seen edge came back with the seen set
      settled: true,
    });
    resumed.goTo(3); // a bookmark jump still reaches the seen edge
    expect(resumed.getState().cursor).toBe(3);
    resumed.goTo(4); // the frontier stays the ceiling: item 4 is unseen
    expect(resumed.getState().cursor).toBe(3);
    resumed.destroy();
  });
});

describe("video and mediaEnded()", () => {
  it("waits for mediaEnded when the video outlasts the text hold", () => {
    vi.useFakeTimers();
    const m = machine([video(10), image()]);
    vi.advanceTimersByTime(5000); // text hold long past, video still running
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(5000); // time bound (10 s) elapsed, no `ended`
    expect(m.getState().cursor).toBe(0);
    m.mediaEnded();
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });

  it("waits for the text hold when the video ends early", () => {
    vi.useFakeTimers();
    const m = machine([video(1), image()]);
    m.mediaEnded(); // ends at 400 ms-equivalent, before the 1500 ms hold
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1500);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("advance() skips a still-playing video after settling it", () => {
    const m = machine([video(10), image()]);
    m.advance(); // immediate-complete the video
    m.mediaEnded(); // late ended must not double-advance
    expect(m.getState().cursor).toBe(0);
    m.advance();
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("ignores mediaEnded on non-video items", () => {
    const m = machine([image(), image()]);
    m.mediaEnded();
    expect(m.getState().cursor).toBe(0);
    m.destroy();
  });
});

describe("short-video timing: loopCount and holdSeconds (docs/plan.md Phase 9b)", () => {
  function skipSettings(skipAll: boolean): MachineSettings {
    return { ...SETTINGS, skipAll };
  }

  it("holdSeconds holds for max(text hold, holdSeconds) with no mediaEnded", () => {
    vi.useFakeTimers();
    // holdSeconds 4 s > minHold 1500: the gate is the clock alone.
    const m = machine([video(30, undefined, { holdSeconds: 4 }), image()]);
    vi.advanceTimersByTime(3999);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    // The text hold still floors a shorter holdSeconds.
    const floored = machine([
      video(30, "a".repeat(40), { holdSeconds: 1 }),
      image(),
    ]);
    vi.advanceTimersByTime(2399); // 2400 ms text hold > 1000 ms holdSeconds
    expect(floored.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(floored.getState().cursor).toBe(1);
    m.destroy();
    floored.destroy();
  });

  it("ignores every mediaEnded on a holdSeconds background video", () => {
    vi.useFakeTimers();
    const m = machine([video(30, undefined, { holdSeconds: 4 }), image()]);
    vi.advanceTimersByTime(100);
    m.mediaEnded(); // strays: the renderer loops freely and reports nothing,
    m.mediaEnded(); // but a late event must not advance early either.
    vi.advanceTimersByTime(3899);
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("loopCount 2 needs the second ended AND the time bound (bound first)", () => {
    vi.useFakeTimers();
    const m = machine([video(1, undefined, { loopCount: 2 }), image()]); // 2000 ms
    vi.advanceTimersByTime(2000);
    expect(m.getState().cursor).toBe(0);
    m.mediaEnded(); // first loop done, time bound passed: still not enough
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    m.mediaEnded(); // second ended completes the item
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });

  it("loopCount 2 waits for the time bound when both endeds land early", () => {
    vi.useFakeTimers();
    const m = machine([video(1, undefined, { loopCount: 2 }), image()]);
    vi.advanceTimersByTime(100);
    m.mediaEnded();
    m.mediaEnded(); // loops complete early: the bound still has to elapse
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1899);
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    vi.advanceTimersByTime(1); // 2000 ms from the item start
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("loopCount 1 keeps the legacy single-ended gate", () => {
    vi.useFakeTimers();
    // The default (absent loopCount) and an explicit 1 behave alike.
    for (const clip of [video(10), video(10, undefined, { loopCount: 1 })]) {
      const m = machine([clip, image()]);
      vi.advanceTimersByTime(1500); // text hold past, bound (10 s) not
      expect(m.getState().cursor).toBe(0);
      m.mediaEnded(); // the single ended is met: only the clock gates now
      expect(m.getState().cursor).toBe(0);
      vi.advanceTimersByTime(8499); // 9999 ms of the 10 s bound
      expect(m.getState().cursor).toBe(0);
      vi.advanceTimersByTime(1); // bound elapsed with its ended met: advance
      expect(m.getState().cursor).toBe(1);
      m.destroy();
    }
    // Ended-first ordering is the legacy "video ends early" case: the text
    // hold carries it, exactly as before loopCount existed.
    const early = machine([video(1), image()]);
    early.mediaEnded();
    expect(early.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1500);
    expect(early.getState().cursor).toBe(1);
    early.destroy();
  });

  it("skip dwell clamps a video to min(skipDwellMs, holdSeconds)", () => {
    vi.useFakeTimers();
    // durationSeconds 3 is irrelevant here: holdSeconds 0.05 gates the dwell.
    const m = machine(
      [video(3, undefined, { holdSeconds: 0.05 }), image(), image()],
      {
        settings: { ...skipSettings(true), skipDwellMs: 120 }, // a dwell longer than the clamps
      },
    );
    m.toggleSkip();
    vi.advanceTimersByTime(49);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    // The next item is an image: the full dwell applies again.
    vi.advanceTimersByTime(120);
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });

  it("skip dwell clamps a video to min(skipDwellMs, durationSeconds * loops)", () => {
    vi.useFakeTimers();
    // 0.03 s * 2 loops = 60 ms < the 120 ms dwell.
    const m = machine(
      [video(0.03, undefined, { loopCount: 2 }), image(), image()],
      {
        settings: { ...skipSettings(true), skipDwellMs: 120 }, // a dwell longer than the clamps
      },
    );
    m.toggleSkip();
    vi.advanceTimersByTime(59);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(120);
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });

  it("a video re-shown below the seen edge replays its hold with no ended (Phase 16)", () => {
    vi.useFakeTimers();
    // Seen content: read onto item 1 so a wheel step can return to the video.
    // The wheel step lands BELOW the seen edge (frontier 2, cursor 0), where
    // the renderer shows a still and can never report a pass — the shape of
    // the part-012 stall (docs/plan.md Phase 16). The machine therefore
    // re-runs the plan's TIME alone: the 2 s bound completes the item with
    // no ended report at all. (Ended-count reset on re-entry at the seen
    // edge, this test's former subject, is pinned by the next test.)
    const m = machine([video(1, undefined, { loopCount: 2 }), image()]);
    readTo(m, 1); // onto the image
    expect(m.getState().cursor).toBe(1);
    m.wheelBack(); // back onto the video: fresh item state, hold armed afresh
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    vi.advanceTimersByTime(1999); // the bound replays: below the edge it gates alone
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    // A press in auto returns to manual (docs/plan.md Phase 18): from then
    // on the cursor only moves on advance(), and mediaEnded() moves nothing.
    vi.advanceTimersByTime(1500); // the last image's hold settles it in place
    expect(m.getState().settled).toBe(true);
    m.wheelBack();
    m.advance(); // auto off on the re-shown video, no ended needed
    expect(m.getState()).toMatchObject({ cursor: 0, settled: false });
    m.mediaEnded();
    m.mediaEnded();
    vi.advanceTimersByTime(60_000);
    expect(m.getState().cursor).toBe(0);
    m.advance();
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("a navigated re-entry AT the seen edge replays the gate and owes its ends again", () => {
    vi.useFakeTimers();
    // Wheel steps that land ON the seen edge (cursor == frontier - 1) enter
    // the video the way forward play does: the renderer re-seeks to
    // `startSeconds` and reports every pass (render/visual.ts, the fresh-
    // entry rule). So the ended half of the gate stays live there, counted
    // afresh for the new entry — what the rewound case above gave up.
    const m = machine([
      image(),
      video(1, undefined, { loopCount: 2 }),
      image(),
    ]);
    vi.advanceTimersByTime(1500); // onto the video at the frontier
    expect(m.getState()).toMatchObject({ cursor: 1, frontier: 2 });
    m.wheelBack(); // item 0
    m.wheelForward(); // re-enter the video, still at the seen edge
    expect(m.getState()).toMatchObject({ cursor: 1, frontier: 2 });
    vi.advanceTimersByTime(2000); // the bound replayed, but the ends are owed
    expect(m.getState().cursor).toBe(1);
    m.mediaEnded(); // one of two
    expect(m.getState().cursor).toBe(1);
    m.mediaEnded(); // the second pass completes the re-entry
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });

  it("an auto re-walk of seen content passes a range video on its time bound (part-012)", () => {
    vi.useFakeTimers();
    // The user's flow, machine-shaped: auto walks forward over the video
    // (its reports arrive at the seen edge), reaches the end, and the
    // reader wheels back; auto on, the re-walk meets the same video BELOW
    // the edge — a still for the renderer, no reports. Pre-fix this froze
    // forever on item 2 (the part-012 stall).
    const m = machine([
      image(),
      image(),
      video(1, undefined, { loopCount: 2 }),
      image(),
      image(),
    ]);
    vi.advanceTimersByTime(3000); // items 0 and 1 on their text holds
    m.mediaEnded(); // the forward pass at the seen edge reports its passes
    m.mediaEnded();
    vi.advanceTimersByTime(2000); // the video's bound
    vi.advanceTimersByTime(3000); // items 3 and 4, then the end settles
    expect(m.getState()).toMatchObject({ cursor: 4, settled: true });
    m.wheelBack(); // onto item 3
    m.wheelBack(); // onto the video: below the edge
    vi.advanceTimersByTime(1999);
    expect(m.getState().cursor).toBe(2);
    vi.advanceTimersByTime(1); // the plan's replay time elapsed: auto moves on
    expect(m.getState().cursor).toBe(3);
    m.destroy();
  });
});

describe("range-based video timing (docs/plan.md Phase 9c)", () => {
  // 0.5 .. 2.5 of a 4 s file: a 2 s range, so the bound is 2 s * loops,
  // never the 4 s duration. Exact fractional seconds, no rounding.
  const ranged = { startSeconds: 0.5, endSeconds: 2.5 };

  it("time bound is the range length, not the file duration", () => {
    expect(itemHoldMs(video(4, undefined, ranged), SETTINGS)).toBe(2000);
    vi.useFakeTimers();
    const m = machine([video(4, undefined, ranged), image()]);
    vi.advanceTimersByTime(1999);
    m.mediaEnded(); // first pass complete; the 2 s bound has not elapsed
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    vi.advanceTimersByTime(1); // 2000 ms, not 4000: the range gates
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("loopCount scales the range bound: 2 s range * 2 loops = 4 s", () => {
    expect(
      itemHoldMs(video(4, undefined, { ...ranged, loopCount: 2 }), SETTINGS),
    ).toBe(4000);
    vi.useFakeTimers();
    const m = machine([
      video(4, undefined, { ...ranged, loopCount: 2 }),
      image(),
    ]);
    m.mediaEnded(); // one pass of the range done: needs the second
    vi.advanceTimersByTime(3999);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1); // bound elapsed, but only one pass ended
    expect(m.getState().cursor).toBe(0);
    m.mediaEnded(); // second range-end report completes the item
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("holdSeconds overrides the range bound and ignores pass reports", () => {
    vi.useFakeTimers();
    const m = machine([
      video(4, undefined, { ...ranged, holdSeconds: 3 }),
      image(),
    ]);
    vi.advanceTimersByTime(1999);
    m.mediaEnded(); // would be the 2 s range end: a background video
    m.mediaEnded(); // loops freely, so these gate nothing
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1001); // holdSeconds 3 s wins over the 2 s range
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("skip dwell clamps to the range length", () => {
    vi.useFakeTimers();
    // 0.5 .. 0.55 of a 4 s file: a 0.05 s range = 50 ms < the 120 ms dwell.
    const m = machine(
      [
        video(4, undefined, { startSeconds: 0.5, endSeconds: 0.55 }),
        image(),
        image(),
      ],
      { settings: { ...SETTINGS, skipAll: true, skipDwellMs: 120 } },
    );
    m.toggleSkip();
    vi.advanceTimersByTime(49);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1); // 50 ms: the range clamps the dwell
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(120); // image: full dwell again
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });

  it("no range fields keeps the whole-duration bound (Phase 9b default)", () => {
    expect(itemHoldMs(video(2.5), SETTINGS)).toBe(2500);
    expect(itemHoldMs(video(2.5, undefined, { loopCount: 2 }), SETTINGS)).toBe(
      5000,
    );
  });
});

describe("loop restart point (docs/plan.md Phase 9d)", () => {
  // 1 .. 4 of an 8 s file with a loop restart at 3: the first pass is 3 s and
  // every later pass 1 s, so the bound is 3 + (loops - 1) s, never 3 * loops.
  // Exact fractional seconds, no rounding.
  const looping = { startSeconds: 1, endSeconds: 4, loopStartSeconds: 3 };

  it("time bound is firstPass + (loops-1) * loopPass, not range * loops", () => {
    expect(itemHoldMs(video(8, undefined, looping), SETTINGS)).toBe(3000);
    expect(
      itemHoldMs(video(8, undefined, { ...looping, loopCount: 2 }), SETTINGS),
    ).toBe(4000); // 3 + 1, not 6
    vi.useFakeTimers();
    const m = machine([
      video(8, undefined, { ...looping, loopCount: 2 }),
      image(),
    ]);
    m.mediaEnded(); // first pass done; the shorter loop pass is running
    vi.advanceTimersByTime(3999);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1); // the 4 s bound elapsed; one pass report only
    expect(m.getState().cursor).toBe(0);
    m.mediaEnded(); // second pass completes the item
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("three passes sum the first pass and two loop passes", () => {
    expect(
      itemHoldMs(video(8, undefined, { ...looping, loopCount: 3 }), SETTINGS),
    ).toBe(5000); // 3 + 2 * 1
    // A restart before `startSeconds` lengthens the loop pass instead: the
    // first pass is 2 s, each later pass the 4 s from 0 to the range end.
    const preRoll = {
      startSeconds: 2,
      endSeconds: 4,
      loopStartSeconds: 0,
      loopCount: 2,
    };
    expect(itemHoldMs(video(8, undefined, preRoll), SETTINGS)).toBe(6000); // 2 + 4
  });

  it("absent or equal loopStartSeconds keeps range * loops (Phase 9c)", () => {
    const ranged = { startSeconds: 1, endSeconds: 4 };
    expect(
      itemHoldMs(video(8, undefined, { ...ranged, loopCount: 2 }), SETTINGS),
    ).toBe(6000);
    expect(
      itemHoldMs(
        video(8, undefined, { ...ranged, loopStartSeconds: 1, loopCount: 2 }),
        SETTINGS,
      ),
    ).toBe(6000);
    expect(
      itemHoldMs(video(8, undefined, { ...ranged, loopCount: 3 }), SETTINGS),
    ).toBe(9000);
  });

  it("holdSeconds overrides the loop bound", () => {
    const clip = { ...looping, loopCount: 2, holdSeconds: 2 };
    expect(itemHoldMs(video(8, undefined, clip), SETTINGS)).toBe(2000);
    vi.useFakeTimers();
    const m = machine([video(8, undefined, clip), image()]);
    vi.advanceTimersByTime(1999);
    m.mediaEnded(); // pass reports gate nothing under a hold
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1); // holdSeconds 2 s, not the 4 s loop bound
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("skip dwell clamps to the summed passes", () => {
    vi.useFakeTimers();
    // Dyadic seconds keep the float exact: 0 .. 0.0625 with a restart at
    // 0.03125 is a 62.5 ms first pass plus a 31.25 ms loop pass, so 2 loops
    // bound the dwell at 93.75 ms, which the scheduler floors to 93. The
    // range alone (62 ms) and the range times loops (125 ms, above the 120 ms
    // dwell) are both wrong here.
    const clip = {
      startSeconds: 0,
      endSeconds: 0.0625,
      loopStartSeconds: 0.03125,
      loopCount: 2,
    };
    const m = machine([video(4, undefined, clip), image(), image()], {
      settings: { ...SETTINGS, skipAll: true, skipDwellMs: 120 },
    });
    m.toggleSkip();
    vi.advanceTimersByTime(92);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1); // 93 ms: the summed passes clamp the dwell
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(120); // image: full dwell again
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });
});

describe("text items hold on the text alone (docs/content-format.md, Text items)", () => {
  it("text item holds exactly its text hold and is never gated on media end", () => {
    vi.useFakeTimers();
    const m = machine([image("a".repeat(40)), text("a".repeat(40)), image()]); // 2400 ms holds
    vi.advanceTimersByTime(2399);
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    vi.advanceTimersByTime(1);
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    // On the text item, mediaEnded is irrelevant: the cursor does not move.
    m.mediaEnded();
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    vi.advanceTimersByTime(2399);
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(1);
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });

  it("video followed by text advances at the text hold though mediaEnded never fired", () => {
    vi.useFakeTimers();
    const m = machine([
      video(600, "a".repeat(40)),
      text("one"),
      text("two"),
      image(),
    ]);
    vi.advanceTimersByTime(2399);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1); // video's text hold, video still playing
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    vi.advanceTimersByTime(1499);
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(1); // first text line: minHold floor
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    vi.advanceTimersByTime(1500); // second text line
    expect(m.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });

  it("video with no text still advances at minHold under a text chain", () => {
    vi.useFakeTimers();
    const m = machine([video(600), text("one"), image()]);
    vi.advanceTimersByTime(1499);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.mediaEnded(); // the video finishing under the text changes nothing
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });

  it("animation followed by text ignores its loop time", () => {
    vi.useFakeTimers();
    // Loop time is 4000 ms; its text hold is 1500 ms.
    const chained = machine([
      animation(10, 5, 2, "short"),
      text("next"),
      image(),
    ]);
    const alone = machine([animation(10, 5, 2, "short"), image()]);
    vi.advanceTimersByTime(1500);
    expect(chained.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    expect(alone.getState().cursor).toBe(0); // still looping
    vi.advanceTimersByTime(2500);
    expect(alone.getState().cursor).toBe(1); // fires at its loop time
    chained.destroy();
    alone.destroy();
  });

  it("media item after a text chain resumes its own timing rules", () => {
    vi.useFakeTimers();
    const m = machine([image(), text("one"), animation(10, 5, 2)]);
    vi.advanceTimersByTime(3000);
    expect(m.getState().cursor).toBe(2); // now on the animation
    vi.advanceTimersByTime(3999);
    expect(m.getState().cursor).toBe(2); // loops outlast the text hold
    vi.advanceTimersByTime(1);
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: true,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });
});

describe("visualIndexFor: a text item shows the earlier visual", () => {
  const items = manifest([
    image(), // 0
    text("one"), // 1
    text("two"), // 2
    animation(3, 12, 3), // 3
    text("three"), // 4
    video(), // 5
    text("four"), // 6
  ]).items;

  it("maps every media item to itself", () => {
    expect(visualIndexFor(items, 0)).toBe(0);
    expect(visualIndexFor(items, 3)).toBe(3);
    expect(visualIndexFor(items, 5)).toBe(5);
  });

  it("maps a text item to the nearest earlier media item", () => {
    expect(visualIndexFor(items, 1)).toBe(0);
    expect(visualIndexFor(items, 4)).toBe(3);
    expect(visualIndexFor(items, 6)).toBe(5);
  });

  it("maps consecutive text items to the same media index", () => {
    expect(visualIndexFor(items, 1)).toBe(0);
    expect(visualIndexFor(items, 2)).toBe(0);
  });

  it("machine.visualIndex() is constant across a chain and moves at the next media item", () => {
    vi.useFakeTimers();
    const m = machine(items, { auto: false });
    expect(m.visualIndex()).toBe(0);
    for (const [expectedCursor, expectedVisual] of [
      [1, 0],
      [2, 0],
      [3, 3],
      [4, 3],
      [5, 5],
      [6, 5],
    ]) {
      m.advance(); // manual: one press, one step
      expect(m.getState().cursor).toBe(expectedCursor);
      expect(m.visualIndex()).toBe(expectedVisual);
    }
    m.destroy();
  });
});

describe("frontier and wheel rules", () => {
  it("resume starts at the last seen item; first advance shows the first unseen item", () => {
    const m = machine([image(), image(), image(), image()], {
      resumeFrontier: 2,
      auto: false,
    });
    // Landing is the resume position: the last shown item, counted settled.
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: true,
      skipping: false,
      transition: "nav",
    });
    m.advance();
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });

  it("wheel forward is blocked at the furthest point read", () => {
    const m = machine([image(), image(), image()], { auto: false });
    m.advance(); // read onto item 1
    const atEnd = {
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "advance",
    };
    expect(m.getState()).toEqual(atEnd);
    m.wheelForward(); // the furthest point: nothing seen ahead, blocked
    expect(m.getState()).toEqual(atEnd);
    m.wheelBack();
    expect(m.getState().cursor).toBe(0);
    m.wheelForward(); // returns through seen content
    expect(m.getState().cursor).toBe(1);
    m.wheelForward(); // blocked again
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    // advance() may cross the frontier; the wheel may not.
    m.advance();
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });

  it("wheel forward at the furthest point stays blocked across a text chain", () => {
    const m = machine([image(), video(), text("one"), text("two"), image()], {
      auto: false,
    });
    for (let press = 0; press < 2; press += 1) m.advance(); // read onto item 2
    // Last read item is the text line; its visual is the video.
    const atEnd = {
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "advance",
    };
    expect(m.getState()).toEqual(atEnd);
    expect(m.visualIndex()).toBe(1); // the video's visual keeps showing
    m.wheelForward(); // nothing seen ahead: blocked
    expect(m.getState()).toEqual(atEnd);
    m.wheelBack(); // back through seen content, same visual
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    expect(m.visualIndex()).toBe(1);
    m.wheelForward(); // forward again through seen content
    expect(m.getState().cursor).toBe(2);
    m.wheelForward(); // blocked at the furthest point again
    expect(m.getState().cursor).toBe(2);
    // advance() crosses the frontier from a text item like any other item.
    m.advance();
    expect(m.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    expect(m.visualIndex()).toBe(1);
    m.destroy();
  });

  it("wheel back before item 0 clamps", () => {
    const m = machine([image(), image()]);
    m.wheelBack();
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    m.destroy();
  });

  it("a first-ever load cannot wheel into unseen content", () => {
    const m = machine([image(), image()]);
    m.wheelForward();
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    m.destroy();
  });
});

describe("skip mode (tab), docs/plan.md Phase 4", () => {
  function skipSettings(skipAll: boolean): MachineSettings {
    return { ...SETTINGS, skipAll };
  }

  it("advances every picture after the fixed dwell; media never gates", () => {
    vi.useFakeTimers();
    const m = machine(
      [
        image(), // plain image
        animation(10, 5, 2), // 4000 ms loop time
        video(600), // 10-minute video
        image(),
        image(),
      ],
      { settings: skipSettings(true) },
    );
    m.toggleSkip();
    expect(m.getState().skipping).toBe(true);
    const dwell = SETTINGS.skipDwellMs;
    // Each picture — image, animation, video — takes exactly one dwell.
    for (let steps = 1; steps <= 4; steps += 1) {
      vi.advanceTimersByTime(dwell - 1);
      expect(m.getState().cursor).toBe(steps - 1);
      m.mediaEnded(); // a straggler media-end must not skip ahead
      vi.advanceTimersByTime(1);
      expect(m.getState().cursor).toBe(steps);
      expect(m.getState().skipping).toBe(steps < 4);
    }
    m.destroy();
  });

  it("paces by pictures: a 5-line chain over one picture costs one dwell", () => {
    // docs/plan.md Phase 18, skip paces by pictures.
    vi.useFakeTimers();
    const m = machine(
      [
        image(),
        image(),
        text("one"),
        text("two"),
        text("three"),
        text("four"),
        text("five"),
        image(),
        image(),
      ],
      { settings: skipSettings(true) },
    );
    const states: number[] = [];
    m.subscribe((state) => states.push(state.cursor));
    m.toggleSkip();
    const dwell = SETTINGS.skipDwellMs;
    vi.advanceTimersByTime(dwell); // 0 -> 1, the chain's picture
    expect(m.getState()).toMatchObject({ cursor: 1, skipping: true });
    vi.advanceTimersByTime(dwell - 1);
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(1); // one dwell walks the whole chain
    expect(m.getState()).toMatchObject({ cursor: 7, skipping: true });
    // Every line was still walked: shown and seen.
    expect(states).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(m.visitedList()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    m.destroy();
  });

  it("a skip starting on a line leaves it at once, in zero time", () => {
    vi.useFakeTimers();
    const m = machine([image(), text("one"), text("two"), image(), image()], {
      settings: skipSettings(true),
      auto: false,
    });
    m.advance(); // onto line 1
    m.toggleSkip();
    vi.advanceTimersByTime(0);
    expect(m.getState()).toMatchObject({ cursor: 3, skipping: true });
    m.destroy();
  });

  it("stops ON the last seen line of a chain, which then reads normally", () => {
    vi.useFakeTimers();
    const m = machine(
      [image(), image(), text("one"), text("two"), text("three"), image()],
      { settings: skipSettings(false) },
    );
    readTo(m, 3); // items 0..3 seen; "three" unseen
    m.wheelBack();
    m.wheelBack();
    m.wheelBack(); // back to 0
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs); // 0 -> 1
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(SETTINGS.skipDwellMs); // the chain, at once
    // The burst ends ON line "two", the last seen item: it is shown under
    // its normal text hold, not a zero-time skip step.
    expect(m.getState()).toMatchObject({ cursor: 3, skipping: false });
    vi.advanceTimersByTime(1000);
    expect(m.getState().cursor).toBe(3);
    vi.advanceTimersByTime(1000);
    expect(m.getState().cursor).toBe(4); // its 1500 ms floor elapsed
    m.destroy();
  });

  it("with skipAll off, ends ON the last seen item; its normal auto-advance is armed", () => {
    // docs/plan.md Phase 18: skip never reveals unseen content.
    vi.useFakeTimers();
    const m = machine([image(), image(), image(), image(), image()]);
    readTo(m, 2);
    m.wheelBack();
    m.wheelBack(); // cursor 0; items 1 and 2 are seen, 3 is the frontier
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs);
    expect(m.getState()).toMatchObject({ cursor: 1, skipping: true });
    vi.advanceTimersByTime(SETTINGS.skipDwellMs);
    // Onto the last seen item (2): the burst ends here, nothing unseen shown.
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    // Shown normally: the item's own 1500 ms hold drives auto-advance.
    vi.advanceTimersByTime(1499);
    expect(m.getState().cursor).toBe(2);
    vi.advanceTimersByTime(1);
    expect(m.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });

  it("with skipAll off, tab with nothing seen ahead does nothing (a fresh start)", () => {
    vi.useFakeTimers();
    const m = machine([image(), image(), image()]);
    const before = m.getState();
    m.toggleSkip();
    expect(m.getState()).toBe(before); // no skip mode, no emit
    vi.advanceTimersByTime(SETTINGS.skipDwellMs * 3);
    expect(m.getState().frontier).toBe(1); // nothing unseen was revealed
    m.destroy();
  });

  it("with skipAll on, marks unseen items seen while skipping and ends at content end", () => {
    vi.useFakeTimers();
    const items = [image(), image(), text("one"), video(600), image()];
    const m = machine(items, {
      resumeFrontier: 2,
      settings: skipSettings(true),
    });
    m.toggleSkip();
    // Two pictures' dwells: the line between them takes zero time.
    const total = SETTINGS.skipDwellMs * 2;
    vi.advanceTimersByTime(total - 1);
    expect(m.getState().cursor).toBe(3); // mid-skip, still skipping
    expect(m.getState().skipping).toBe(true);
    vi.advanceTimersByTime(1);
    // Last item of content shown: skip mode ends, everything marked seen.
    expect(m.getState()).toEqual({
      cursor: 4,
      frontier: 5,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    m.destroy();
  });

  it("tab toggles skip off mid-skip and the item resumes normal timing", () => {
    vi.useFakeTimers();
    const m = machine([image(), image(), image()], {
      settings: skipSettings(true),
    });
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs);
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: true,
      transition: "nav",
    });
    m.toggleSkip(); // tab again: manual off
    expect(m.getState().skipping).toBe(false);
    vi.advanceTimersByTime(SETTINGS.skipDwellMs); // no dwell step anymore
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(1500 - SETTINGS.skipDwellMs); // normal hold fires
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });

  it("space during skip exits skip mode and settles the item without moving", () => {
    vi.useFakeTimers();
    const m = machine([image(), image(), image()], {
      settings: skipSettings(true),
    });
    m.toggleSkip();
    m.advance();
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: true,
      skipping: false,
      transition: "nav",
    });
    // The stop also returns auto-forward to manual (docs/plan.md Phase 18).
    expect(m.isAutoAdvance()).toBe(false);
    vi.advanceTimersByTime(60_000); // nothing pending advances by itself
    expect(m.getState().cursor).toBe(0);
    m.advance(); // then behaves normally: the next press moves
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("a wheel step during skip exits skip mode AND performs the step", () => {
    vi.useFakeTimers();
    const m = machine([image(), image(), image(), image()]);
    readTo(m, 2);
    m.wheelBack(); // item 1: a seen item ahead, so tab can skip
    m.toggleSkip();
    expect(m.getState().skipping).toBe(true);
    m.wheelBack();
    const step = (cursor: number) => ({
      cursor,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    expect(m.getState()).toEqual(step(0));
    m.toggleSkip();
    m.wheelForward(); // forward step also exits skip and performs
    expect(m.getState()).toEqual(step(1));
    m.wheelBack();
    m.toggleSkip();
    expect(m.getState().skipping).toBe(true);
    m.wheelBack(); // clamped at the first entry: still exits skip, stays
    expect(m.getState()).toEqual(step(0));
    m.destroy();
  });
});

describe("skip plays videos (docs/plan.md Phase 18)", () => {
  const playing: MachineSettings = {
    ...SETTINGS,
    skipAll: true,
    skipPlaysVideos: true,
  };

  it("is off by default", () => {
    expect(DEFAULT_SETTINGS.skipPlaysVideos).toBe(false);
  });

  it("a burst plays a standalone video for its whole plan, then carries on", () => {
    vi.useFakeTimers();
    const m = machine(
      [image(), video(1, undefined, { loopCount: 3 }), image(), image()],
      { settings: playing },
    );
    m.toggleSkip();
    expect(m.getState().skipVideo).toBeUndefined(); // an image: plain dwell
    vi.advanceTimersByTime(SETTINGS.skipDwellMs);
    expect(m.getState()).toMatchObject({
      cursor: 1,
      skipping: true,
      skipVideo: true,
    });
    // Three 1 s passes: the plan's time bound, not one dwell. A pass report
    // gates nothing (time alone paces it, as forward play below the edge).
    vi.advanceTimersByTime(2999);
    m.mediaEnded();
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(1);
    expect(m.getState()).toMatchObject({ cursor: 2, skipping: true });
    expect(m.getState().skipVideo).toBeUndefined();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs); // the burst goes on
    expect(m.getState().cursor).toBe(3);
    m.destroy();
  });

  it("honours a range and holdSeconds as forward play does", () => {
    vi.useFakeTimers();
    const m = machine(
      [
        image(),
        video(4, undefined, { startSeconds: 1, endSeconds: 2.5 }),
        video(2, undefined, { holdSeconds: 3 }),
        image(),
        image(),
      ],
      { settings: playing },
    );
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs);
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(1499); // the 1.5 s range
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(2);
    vi.advanceTimersByTime(2999); // holdSeconds 3
    expect(m.getState().cursor).toBe(2);
    vi.advanceTimersByTime(1);
    expect(m.getState()).toMatchObject({ cursor: 3, skipping: true });
    m.destroy();
  });

  it("a chain head plays its plan; its lines then take zero time", () => {
    vi.useFakeTimers();
    const m = machine(
      [image(), video(2), text("one"), text("two"), image(), image()],
      { settings: playing },
    );
    const cursors: number[] = [];
    m.subscribe((state) => cursors.push(state.cursor));
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs);
    expect(m.getState()).toMatchObject({ cursor: 1, skipVideo: true });
    vi.advanceTimersByTime(1999);
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(1); // the head's 2 s plan, then the lines at once
    expect(m.getState()).toMatchObject({ cursor: 4, skipping: true });
    expect(cursors).toEqual([0, 1, 2, 3, 4]); // each line still shown
    expect(m.getState().skipVideo).toBeUndefined(); // an image again
    m.destroy();
  });

  it("Space during the playback aborts the video and the burst continues", () => {
    vi.useFakeTimers();
    const m = machine(
      [image(), video(10), image(), video(10), text("line"), image(), image()],
      { settings: playing },
    );
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs);
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(500);
    m.advance(); // abort: straight on to the next item, still skipping
    expect(m.getState()).toMatchObject({ cursor: 2, skipping: true });
    expect(m.isAutoAdvance()).toBe(true); // auto untouched by the abort
    vi.advanceTimersByTime(SETTINGS.skipDwellMs); // the burst goes on
    expect(m.getState()).toMatchObject({ cursor: 3, skipVideo: true });
    m.advance(); // a chain head aborts the same way, through its line
    expect(m.getState()).toMatchObject({ cursor: 5, skipping: true });
    expect(m.visitedList()).toContain(4);
    // Space on a non-video still stops the burst on the item.
    m.advance();
    expect(m.getState()).toMatchObject({
      cursor: 5,
      skipping: false,
      settled: true,
    });
    m.destroy();
  });

  it("never reveals: an abort onto the seen edge ends the burst there", () => {
    vi.useFakeTimers();
    const m = machine([image(), video(10), image(), image()], {
      settings: { ...playing, skipAll: false },
    });
    readTo(m, 2); // items 0..2 seen, 3 unseen
    m.wheelBack();
    m.wheelBack(); // back to 0
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs);
    expect(m.getState()).toMatchObject({ cursor: 1, skipVideo: true });
    m.advance(); // abort onto item 2, the last seen: the burst ends there
    expect(m.getState()).toMatchObject({ cursor: 2, skipping: false });
    expect(m.getState().frontier).toBe(3); // nothing unseen shown
    m.destroy();
  });

  it("a settings toggle mid-burst re-times the video and flips the flag", () => {
    vi.useFakeTimers();
    const m = machine([image(), video(10), image(), image()], {
      settings: { ...playing, skipPlaysVideos: false },
    });
    const seen: MachineState[] = [];
    m.subscribe((state) => seen.push(state));
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs);
    expect(m.getState().cursor).toBe(1);
    expect(m.getState().skipVideo).toBeUndefined(); // off: a poster dwell
    m.setSettings(playing);
    expect(seen[seen.length - 1].skipVideo).toBe(true);
    vi.advanceTimersByTime(9999);
    expect(m.getState().cursor).toBe(1); // now the 10 s plan
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });
});

describe("`e` (jumpToEnd): the furthest screen read (docs/plan.md Phase 27)", () => {
  // `e` goes to the highest seen item — the furthest point read in story
  // order — and is a no-op there. It never reveals unseen content.
  it("goes to the furthest item read; there it does nothing", () => {
    const m = machine([image(), image(), image(), image(), image()]);
    readTo(m, 2);
    m.wheelBack();
    m.wheelBack(); // walked back to the start
    expect(m.getState().cursor).toBe(0);
    m.jumpToEnd();
    const resumed = m.getState();
    expect(resumed).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    // There now: unseen item 3 is next, but `e` never reveals it.
    m.jumpToEnd();
    expect(m.getState()).toBe(resumed);
    m.destroy();
  });

  it("at the furthest point with the next item unseen, the press reveals nothing", () => {
    const m = machine([image(), image(), image()], { resumeFrontier: 1 });
    const before = m.getState();
    m.jumpToEnd();
    expect(m.getState()).toBe(before);
    expect(m.getState().frontier).toBe(1); // item 1 stayed unseen
    m.destroy();
  });

  it("user repro: after wheeling back, the press lands ON the last-read item; the next stays", () => {
    vi.useFakeTimers();
    const m = createMachine({
      items: [image(), image(), image(), image(), image()],
      settings: SETTINGS,
    });
    m.advance(); // one space: item 1 is the last item the reader read
    m.wheelBack();
    expect(m.getState().cursor).toBe(0);
    m.jumpToEnd();
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "nav", // a nav landing, like a wheel step
    });
    const resumed = m.getState();
    m.jumpToEnd();
    expect(m.getState()).toBe(resumed);
    m.destroy();
  });

  it("a resume below the furthest point: `e` lands on the highest seen item as a nav arrival", () => {
    vi.useFakeTimers();
    const m = createMachine({
      items: [image(), image(), image(), image(), image()],
      settings: SETTINGS,
      autoAdvance: true,
      resumeContext: {
        lastShown: 0,
        visited: [0, 1, 2, 3],
        stack: [],
        playedRoutes: [],
      },
    });
    expect(m.getState().cursor).toBe(0);
    m.jumpToEnd();
    expect(m.getState()).toMatchObject({
      cursor: 3,
      frontier: 4,
      transition: "nav",
    });
    m.jumpToEnd(); // already there
    expect(m.getState().cursor).toBe(3);
    m.destroy();
  });
});

describe("`e` and the wheel after continuing from a bookmark (docs/plan.md Phase 27)", () => {
  // The user's rejected behaviour: after a bookmark visit the wheel walked
  // the reading order back to the furthest point. Now it walks the story
  // order around the landing, and `e` reaches the furthest point read.
  const items = () => [image(), video(), image(), text("a"), image(), image()];

  it("right after the restore, `e` goes to where the reading had got to", () => {
    const m = machine(items(), { auto: false });
    readTo(m, 1); // the video
    const mark = m.exportContext(); // `b` on the video
    readTo(m, 4);
    m.importContext(mergeProgress(mark, m.exportContext()));
    expect(m.getState().cursor).toBe(1);
    m.jumpToEnd();
    expect(m.getState()).toMatchObject({ cursor: 4, transition: "nav" });
    m.destroy();
  });

  it("the wheel walks the story around the landing, not the reading order", () => {
    const m = machine(items(), { auto: false });
    readTo(m, 2);
    const mark = m.exportContext();
    readTo(m, 4);
    m.importContext(mergeProgress(mark, m.exportContext()));
    m.wheelBack();
    expect(m.getState().cursor).toBe(1); // towards the start, not item 4
    m.wheelForward();
    m.wheelForward();
    expect(m.getState().cursor).toBe(3); // past the landing
    m.wheelForward();
    m.wheelForward(); // item 5 was never read: forward ends at item 4
    expect(m.getState().cursor).toBe(4);
    m.destroy();
  });

  it("reading on from the landing keeps `e` on the furthest point until read past", () => {
    const m = machine(items(), { auto: false });
    readTo(m, 2);
    const mark = m.exportContext();
    readTo(m, 4);
    m.importContext(mergeProgress(mark, m.exportContext()));
    m.advance(); // item 3
    expect(m.getState().cursor).toBe(3);
    m.jumpToEnd();
    expect(m.getState().cursor).toBe(4);
    m.advance(); // reads past it
    expect(m.getState().cursor).toBe(5);
    const here = m.getState();
    m.jumpToEnd();
    expect(m.getState()).toBe(here);
    m.destroy();
  });

  it("a landing on the furthest point: `e` stays", () => {
    const m = machine(items(), { auto: false });
    readTo(m, 3);
    const mark = m.exportContext();
    m.importContext(mergeProgress(mark, m.exportContext()));
    const landed = m.getState();
    m.jumpToEnd();
    expect(m.getState()).toBe(landed);
    m.destroy();
  });

  it("a bookmark click after a resume: `e` returns to the furthest item", () => {
    const m = machine(items(), { resumeFrontier: 5, auto: false });
    m.goTo(2);
    m.jumpToEnd();
    expect(m.getState()).toMatchObject({ cursor: 4, transition: "nav" });
    m.jumpToEnd();
    expect(m.getState().cursor).toBe(4);
    m.destroy();
  });

  it("survives a reload through storage", async () => {
    const list = items().map((item, n) => ({ ...item, id: `i-${String(n)}` }));
    const storage = createMemoryStorage();
    const codec = createContextCodec(list);
    const m = machine(list, { auto: false });
    readTo(m, 1);
    const mark = m.exportContext();
    readTo(m, 4);
    m.importContext(mergeProgress(mark, m.exportContext()));
    m.advance();
    await storage.saveState({ ctx: codec.toSaved(m.exportContext()) });
    m.destroy();
    const reloaded = createMachine({
      items: list,
      settings: SETTINGS,
      ...resumeOptionsFor(await storage.loadState(), codec),
    });
    expect(reloaded.getState().cursor).toBe(2);
    reloaded.wheelBack();
    expect(reloaded.getState().cursor).toBe(1);
    reloaded.jumpToEnd();
    expect(reloaded.getState().cursor).toBe(4);
    reloaded.destroy();
  });
});

describe("goTo (t-overlay bookmark click), docs/plan.md Phase 8", () => {
  it("moves the cursor to any seen index from any position, frontier unmoved", () => {
    const m = machine([image(), image(), image(), image(), image()], {
      resumeFrontier: 4,
    });
    expect(m.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: true,
      skipping: false,
      transition: "nav",
    });
    m.goTo(0); // back to the very first item
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 4,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    m.goTo(2); // forward, mid-seen
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 4,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    m.goTo(1);
    m.goTo(3); // back onto the frontier edge itself
    expect(m.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    m.advance(); // arrival was unsettled: this press settles, it does not move
    expect(m.getState().cursor).toBe(3);
    m.advance(); // and the next enters unseen content as ever
    expect(m.getState()).toEqual({
      cursor: 4,
      frontier: 5,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });

  it("clamps into [0, frontier - 1]: unseen items are never entered", () => {
    // frontier 2 of 4: items 2 and 3 are unseen and out of reach.
    const m = machine([image(), image(), image(), image()], {
      resumeFrontier: 2,
    });
    m.goTo(3); // beyond the frontier: clamps to the last SHOWN item
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    m.goTo(99); // same clamp for a far-off index
    expect(m.getState().cursor).toBe(1);
    expect(m.getState().frontier).toBe(2);
    m.goTo(-5); // and below zero
    expect(m.getState().cursor).toBe(0);
    expect(m.getState().frontier).toBe(2);
    m.destroy();
  });

  it("arrives UNSETTLED, unlike a resume landing: the bookmarked item replays", () => {
    vi.useFakeTimers();
    const m = machine([image(), image(), image()], { resumeFrontier: 3 });
    // Resume landed settled (a re-arrival); a bookmark click does not.
    expect(m.getState().settled).toBe(true);
    m.goTo(0);
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    // The item's own hold is armed: at 1499 ms nothing has moved...
    vi.advanceTimersByTime(1499);
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    // ...and at the bare-image hold (1500 ms) auto-advance continues the
    // novel from the bookmark — README: "continues the novel from that
    // time point" — without moving the frontier.
    vi.advanceTimersByTime(1);
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });

  it("goTo on the last item of content clamps and holds instead of moving", () => {
    vi.useFakeTimers();
    const m = machine([image(), image(), image()], { resumeFrontier: 3 });
    m.goTo(0);
    m.goTo(2); // frontier - 1 === last item
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    vi.advanceTimersByTime(10_000); // hold elapses: settle, nothing to enter
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: true,
      skipping: false,
      transition: "nav",
    });
    m.destroy();
  });

  it("a goTo during skip exits skip mode AND performs the jump", () => {
    const m = machine([image(), image(), image(), image()], {
      resumeFrontier: 3,
    });
    m.toggleSkip();
    m.goTo(0);
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 3,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    m.destroy();
  });

  it("emits to subscribers and no-ops on an empty manifest or after destroy", () => {
    const empty = machine([]);
    empty.goTo(0);
    expect(empty.getState()).toEqual({
      cursor: 0,
      frontier: 0,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    empty.destroy();

    const m = machine([image(), image()], { resumeFrontier: 2 });
    const seen: MachineState[] = [];
    m.subscribe((s) => seen.push(s));
    m.goTo(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      cursor: 0,
      frontier: 2,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    m.destroy();
    m.goTo(1);
    expect(m.getState().cursor).toBe(0); // destroy() froze the machine
  });

  it("an empty manifest is inert: no timer is armed and no command emits", () => {
    // The empty-state guarantee behind an honestly-empty folder
    // (docs/extracting.md BUG 1): the machine must not schedule holds
    // for items that do not exist, and every command must be a silent
    // no-op rather than a crash the player would log to the console.
    vi.useFakeTimers();
    const m = machine([]);
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 0,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    vi.advanceTimersByTime(60_000); // no auto-advance was armed at start
    expect(m.getState().cursor).toBe(0);
    const seen: MachineState[] = [];
    m.subscribe((s) => seen.push(s));
    m.advance();
    m.wheelBack();
    m.wheelForward();
    m.toggleSkip();
    m.jumpToEnd();
    m.mediaEnded();
    m.setSettings(SETTINGS);
    expect(seen).toHaveLength(0);
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 0,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    m.destroy();
  });
});

describe("onAutoAdvanceChange: every real flip of the mode (docs/plan.md Phase 20)", () => {
  function watch(m: ReturnType<typeof createMachine>): boolean[] {
    const flips: boolean[] = [];
    m.onAutoAdvanceChange((on) => flips.push(on));
    return flips;
  }

  it("setAutoAdvance reports a flip, never a repeat of the current mode", () => {
    const m = machine([image(), image()], { auto: false });
    const flips = watch(m);
    m.setAutoAdvance(false);
    m.setAutoAdvance(true);
    m.setAutoAdvance(true);
    m.setAutoAdvance(false);
    expect(flips).toEqual([true, false]);
    m.destroy();
  });

  it("Space in auto turns it off and reports it; Space in manual reports nothing", () => {
    vi.useFakeTimers();
    const m = machine([image(), image(), image()]);
    const flips = watch(m);
    m.advance();
    expect(flips).toEqual([false]);
    m.advance();
    expect(flips).toEqual([false]);
    m.destroy();
  });

  it("Space ending a skip burst in auto reports the turn-off", () => {
    vi.useFakeTimers();
    const m = machine([image(), image(), image(), image()]);
    readTo(m, 3);
    m.wheelBack();
    m.wheelBack();
    m.wheelBack();
    const flips = watch(m);
    m.toggleSkip();
    expect(m.getState().skipping).toBe(true);
    m.toggleSkip(); // Tab on and off: the mode is untouched
    m.toggleSkip();
    expect(flips).toEqual([]);
    m.advance();
    expect(m.getState().skipping).toBe(false);
    expect(flips).toEqual([false]);
    m.destroy();
  });

  it("pause, resume, the wheel, a jump and the end leave the mode alone", () => {
    vi.useFakeTimers();
    const m = machine([image(), image(), image()]);
    const flips = watch(m);
    m.pause();
    m.resume();
    vi.advanceTimersByTime(60_000); // auto reads on to the end
    expect(m.getState().cursor).toBe(2);
    m.wheelBack();
    m.wheelForward();
    m.goTo(0);
    m.jumpToEnd();
    expect(m.isAutoAdvance()).toBe(true);
    expect(flips).toEqual([]);
    m.destroy();
  });

  it("an unsubscribed or destroyed machine reports nothing", () => {
    const m = machine([image(), image()], { auto: false });
    const flips: boolean[] = [];
    const stop = m.onAutoAdvanceChange((on) => flips.push(on));
    stop();
    m.setAutoAdvance(true);
    const flips2 = watch(m);
    m.destroy();
    m.setAutoAdvance(false);
    expect(flips).toEqual([]);
    expect(flips2).toEqual([]);
  });
});

describe("subscribe, timers, and destroy()", () => {
  it("notifies subscribers on every state change until unsubscribe", () => {
    const m = machine([image(), image(), image()], { auto: false });
    const seen: MachineState[] = [];
    const unsubscribe = m.subscribe((s) => seen.push(s));
    m.advance(); // move: notify
    m.advance(); // move: notify
    unsubscribe();
    m.wheelBack(); // not observed after unsubscribe
    expect(seen.map((s) => [s.cursor, s.settled])).toEqual([
      [1, false],
      [2, false],
    ]);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("destroy() leaks no timers and stops all updates", () => {
    vi.useFakeTimers();
    const m = machine([video(10), image()]);
    const seen: MachineState[] = [];
    m.subscribe((s) => seen.push(s));
    vi.advanceTimersByTime(1000);
    m.destroy();
    expect(vi.getTimerCount()).toBe(0);
    m.advance();
    m.advance();
    m.mediaEnded();
    vi.advanceTimersByTime(60_000);
    expect(seen).toEqual([]);
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: false,
      skipping: false,
      transition: "nav",
    });
  });
});

describe("resume from persisted storage (docs/plan.md Phase 8, memory fake)", () => {
  it("the persisted id-keyed ctx resumes: lands where the reader was, e stays there, one advance enters unseen", async () => {
    const storage = createMemoryStorage();
    const items = [0, 1, 2, 3, 4, 5].map((n) => ({
      ...image(),
      id: `img-${String(n)}`,
    }));
    const codec = createContextCodec(items);
    // Session 1: the reader saw items 0..3 (three manual presses).
    const first = machine(items, { auto: false });
    first.advance();
    first.advance();
    first.advance();
    expect(first.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    // Exactly what main.ts's persister writes: the ctx, keyed by id.
    await storage.saveState({ ctx: codec.toSaved(first.exportContext()) });
    first.destroy();
    expect((await storage.loadState())?.ctx).toMatchObject({
      lastShown: "img-3",
      visited: ["img-0", "img-1", "img-2", "img-3"],
    });

    // Reload, as main.ts does it: the stored ctx becomes resumeContext,
    // landing settled on the item the reader was on.
    const reload = async () =>
      createMachine({
        items,
        settings: SETTINGS,
        ...resumeOptionsFor(await storage.loadState(), codec),
      });
    const resumed = await reload();
    expect(resumed.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: true,
      skipping: false,
      transition: "nav",
    });
    // `e` at the resume spot stays: the landing is the furthest point.
    const landed = resumed.getState();
    resumed.jumpToEnd();
    expect(resumed.getState()).toBe(landed);
    resumed.destroy();

    const second = await reload();
    // From the resume spot one press enters the first unseen item...
    second.advance();
    expect(second.getState()).toEqual({
      cursor: 4,
      frontier: 5,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    // ...and that position is worth persisting: the next reload resumes
    // from it, settled at item 4.
    await storage.saveState({ ctx: codec.toSaved(second.exportContext()) });
    const third = await reload();
    expect(third.getState()).toEqual({
      cursor: 4,
      frontier: 5,
      settled: true,
      skipping: false,
      transition: "nav",
    });
    second.destroy();
    third.destroy();
  });
});

describe("setSettings (config screen, docs/plan.md Phase 9)", () => {
  // minHold sits at 1000 in these three so the doubled speed's 1200 ms
  // total is above the floor and the exact number is testable.
  const holdSettings: MachineSettings = { ...SETTINGS, minHoldMs: 1000 };

  it("re-arms a pending hold with the new readingSpeed from the item start", () => {
    vi.useFakeTimers();
    const m = machine([image("a".repeat(40)), image()], {
      settings: holdSettings,
    }); // 2400 ms at 1.0
    vi.advanceTimersByTime(500);
    m.setSettings({ ...holdSettings, readingSpeed: 2 }); // 1200 ms at 2.0
    // The new settings act as if they had held since the item began: the
    // item ends at 1200 ms from ITS start, i.e. 700 ms from the change.
    vi.advanceTimersByTime(699);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1); // total from item start: 1200 ms
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("fires on the next tick when the elapsed time already passed the new total", () => {
    vi.useFakeTimers();
    const m = machine([image("a".repeat(40)), image()], {
      settings: holdSettings,
    }); // 2400 ms hold
    vi.advanceTimersByTime(1300);
    m.setSettings({ ...holdSettings, readingSpeed: 2 }); // total 1200 < 1300
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("does not re-arm a settled item: a completed hold stays completed", () => {
    vi.useFakeTimers();
    const m = machine([image(), image()]);
    vi.advanceTimersByTime(1500); // onto the last item
    vi.advanceTimersByTime(1500); // its hold completes it in place: settled
    expect(m.getState().settled).toBe(true);
    m.setSettings({ ...SETTINGS, readingSpeed: 3 });
    vi.advanceTimersByTime(60_000);
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: true,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });

  it("skipAll takes effect at the frontier crossing: skip walks the unseen tail", () => {
    vi.useFakeTimers();
    // Cursor starts at the last seen item (2), frontier at 3: the very
    // next skip step enters unseen content, where skipAll decides.
    const m = machine([image(), image(), image(), image(), image()]);
    readTo(m, 2);
    m.wheelBack(); // cursor 1: a seen item ahead, so tab starts skip
    m.toggleSkip();
    m.setSettings({ ...SETTINGS, skipAll: true }); // changed mid-skip
    const dwell = SETTINGS.skipDwellMs;
    vi.advanceTimersByTime(dwell); // onto 2, the last seen item
    expect(m.getState()).toMatchObject({ cursor: 2, skipping: true });
    vi.advanceTimersByTime(dwell); // onto the frontier item, skip goes on
    expect(m.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: false,
      skipping: true,
      transition: "nav",
    });
    vi.advanceTimersByTime(dwell); // last item: skip ends at content end
    expect(m.getState()).toEqual({
      cursor: 4,
      frontier: 5,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    m.destroy();
  });

  it("copies what it is given: mutating the caller's object cannot retime it", () => {
    vi.useFakeTimers();
    const m = machine([image("a".repeat(40)), image()], {
      settings: holdSettings,
    }); // 2400 ms hold
    const caller: MachineSettings = { ...holdSettings, readingSpeed: 2 };
    m.setSettings(caller); // a 1200 ms hold is now armed
    caller.readingSpeed = 3; // the shell keeps owning (and persisting) its own
    vi.advanceTimersByTime(1199); // at 3.0 it would already have fired
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1); // fires at the copied 2.0's total, 1200
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("settings survive destroy(): every command stays inert", () => {
    vi.useFakeTimers();
    const m = machine([image("a".repeat(40)), image()]);
    const finalState = m.getState();
    m.destroy();
    m.setSettings({ ...SETTINGS, readingSpeed: 3 });
    m.advance();
    vi.advanceTimersByTime(60_000);
    expect(m.getState()).toBe(finalState); // no re-arm, no move, frozen
  });
});

describe("minPlaySeconds chain-exit floor (docs/plan.md Phase 15)", () => {
  // The external tester's scenario reduced to numbers: an 8 s video with
  // minPlaySeconds 5.0 and three dialogue lines that sit at minHold. With
  // minHoldMs 800 the dialogue sums to 2.4 s, so an exit near the text sum
  // — the observed 5.829 s bug shape — means the floor is not applied.
  const floorSettings: MachineSettings = { ...SETTINGS, minHoldMs: 800 };

  function chained(minPlaySeconds?: number): Item[] {
    return [
      video(
        8,
        undefined,
        minPlaySeconds === undefined ? {} : { minPlaySeconds },
      ),
      text("one"),
      text("two"),
      text("three"),
      image(),
    ];
  }

  it("exits an 8 s video's chain at the 5 s floor, not the 2.4 s text sum", () => {
    vi.useFakeTimers();
    const m = machine(chained(5), { settings: floorSettings });
    // The chain plays through its dialogue normally while the video runs.
    vi.advanceTimersByTime(800);
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(800);
    expect(m.getState().cursor).toBe(2);
    vi.advanceTimersByTime(800); // last item of the chain, machine time 2.4 s
    expect(m.getState().cursor).toBe(3);
    // Leaving the chain waits for the floor: exit at 5000, not 3200.
    vi.advanceTimersByTime(2599); // total 4999
    expect(m.getState().cursor).toBe(3);
    vi.advanceTimersByTime(1);
    expect(m.getState()).toEqual({
      cursor: 4,
      frontier: 5,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });

  it("a chain without minPlaySeconds exits on the text holds alone", () => {
    vi.useFakeTimers();
    const m = machine(chained(), { settings: floorSettings });
    vi.advanceTimersByTime(3199); // video hold + 3 x 800 ms dialogue
    expect(m.getState().cursor).toBe(3);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(4); // timing exactly as before the field
    m.destroy();
  });

  it("manual advance leaves the chain immediately under the floor", () => {
    vi.useFakeTimers();
    const m = machine(chained(5), { settings: floorSettings, auto: false });
    for (let steps = 1; steps <= 4; steps += 1) {
      m.advance(); // move on — instant, the floor gates timers only
      expect(m.getState().cursor).toBe(steps);
    }
    expect(m.getState().frontier).toBe(5); // all of it at machine time 0
    m.destroy();
  });

  it("skip stays immediate through the whole chain: the floor never delays a dwell", () => {
    vi.useFakeTimers();
    // skipAll so the burst walks the unseen chain rather than ending at it.
    // Phase 15 correction (README: "manual advance and skip stay
    // immediate"): the floor exists so AUTO play sees the video; a reader
    // in skip mode chose speed, so even the step LEAVING an unmet chain is
    // a plain dwell.
    const m = machine(chained(5), {
      settings: { ...floorSettings, skipAll: true },
    });
    m.toggleSkip();
    const dwell = SETTINGS.skipDwellMs;
    // The head's one dwell; the chain's lines take zero time (docs/plan.md
    // Phase 18), the leaving line included — with the floor it waited
    // until 5000. Immediate.
    vi.advanceTimersByTime(dwell - 1);
    expect(m.getState()).toMatchObject({ cursor: 0, skipping: true });
    vi.advanceTimersByTime(1);
    expect(m.getState()).toEqual({
      cursor: 4,
      frontier: 5,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    m.destroy();
  });

  it("the playAllRoutes burst honors the floor when its route's chain exits", () => {
    vi.useFakeTimers();
    const items: Item[] = [
      { id: "a", type: "image", file: "a.jpg" }, // the decision's `after`
      {
        id: "v",
        type: "video",
        file: "v.mp4",
        poster: "v.jpg",
        durationSeconds: 8,
        minPlaySeconds: 5,
      },
      { id: "t1", type: "text", text: "one" },
      { id: "t2", type: "text", text: "two" },
      { id: "t3", type: "text", text: "three" }, // route A ends here
      { id: "b", type: "image", file: "b.jpg" }, // continuing route B
      { id: "c", type: "image", file: "c.jpg" }, // continueAt
    ];
    const branch: Branch = {
      id: "d",
      after: "a",
      prompt: "Which?",
      routes: [
        { id: "A", label: "A", start: "v", end: "t3" },
        { id: "B", label: "B", start: "b", end: "b" },
      ],
      continuingRoute: "B",
      continueAt: "c",
    };
    const m = createMachine({
      items,
      branches: [branch],
      // A fast reader: the choice countdown sits at its 2.5 s floor
      // (texts here hold the 800 ms minimum at any speed).
      settings: { ...floorSettings, readingSpeed: 10, playAllRoutes: true },
      autoAdvance: true,
    });
    vi.advanceTimersByTime(800); // "a" settles: the choice opens, counting down
    expect(m.getState().choice?.autoPick?.ms).toBe(AUTO_PICK_MIN_MS);
    vi.advanceTimersByTime(AUTO_PICK_MIN_MS + AUTO_PICK_SHOW_MS); // enters A
    expect(m.getState().cursor).toBe(1); // chain head at machine time 4000
    vi.advanceTimersByTime(800);
    expect(m.getState().cursor).toBe(2);
    vi.advanceTimersByTime(800);
    expect(m.getState().cursor).toBe(3);
    vi.advanceTimersByTime(800); // last chain item at machine time 6400
    expect(m.getState().cursor).toBe(4);
    // Route end waits for the floor — deadline 4000 + 5000, not 7200.
    vi.advanceTimersByTime(2599); // total 8999
    expect(m.getState().cursor).toBe(4);
    vi.advanceTimersByTime(1); // route end: the re-offer counts down first
    expect(m.getState().choice?.autoPick?.routeIdx).toBe(1);
    vi.advanceTimersByTime(AUTO_PICK_MIN_MS + AUTO_PICK_SHOW_MS); // then B
    expect(m.getState().cursor).toBe(5);
    m.destroy();
  });

  it("setSettings mid-chain re-arms the floor honestly: elapsed counts", () => {
    vi.useFakeTimers();
    const m = machine(chained(5), { settings: floorSettings });
    vi.advanceTimersByTime(2400); // on the last chain item, timer to 5000
    expect(m.getState().cursor).toBe(3);
    vi.advanceTimersByTime(600); // 600 ms of the pending hold shown
    m.setSettings({ ...floorSettings, minHoldMs: 200 }); // much shorter holds
    // The floor is not reset by the change (it still ends at 5000) and not
    // shortened by it either: 5000 - 3000 elapsed = 2000 ms from here.
    vi.advanceTimersByTime(1999); // total 4999
    expect(m.getState().cursor).toBe(3);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(4);
    m.destroy();
  });

  it("goTo into a chain's middle re-bases the floor from the entry", () => {
    vi.useFakeTimers();
    const m = machine(chained(5), { settings: floorSettings });
    vi.advanceTimersByTime(2400); // last chain item; exit would fire at 5000
    expect(m.getState().cursor).toBe(3);
    m.goTo(2); // navigation re-entry: fresh floor from now (conservative)
    vi.advanceTimersByTime(800); // forward through the rest of the chain
    expect(m.getState().cursor).toBe(3);
    // The original floor (5000) has passed, yet the re-based floor runs to
    // 2400 + 5000: navigation may wait LONGER, never shorter (documented).
    vi.advanceTimersByTime(4199); // total 7399
    expect(m.getState().cursor).toBe(3);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(4);
    m.destroy();
  });

  // The external tester's EXACT re-report config (2025-11-02, reproduced on
  // 3c70ed1, which predates the 2bd3e42 skip exclusion): a video carrying
  // BOTH `holdSeconds: 8` and `minPlaySeconds: 8`, two dialogue lines, then
  // an image. Pinned as a permanent regression at HEAD.
  function holdFloorChained(): Item[] {
    return [
      video(8, undefined, { holdSeconds: 8, minPlaySeconds: 8 }),
      text("one"),
      text("two"),
      image(),
    ];
  }

  it("skipAll + holdSeconds video: floor never gates skip", () => {
    vi.useFakeTimers();
    const m = machine(holdFloorChained(), {
      settings: { ...SETTINGS, skipAll: true },
    });
    // Skip started on the video item itself — the reported repro path.
    m.toggleSkip();
    expect(m.getState().skipping).toBe(true);
    // One dwell for the head; its lines take zero time (docs/plan.md Phase
    // 18), the floor ignored. The chain is left after one dwell — nowhere
    // near the 8 s floor (the old bug waited ~7.9 s here).
    vi.advanceTimersByTime(SETTINGS.skipDwellMs);
    expect(m.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: false,
      skipping: false,
      transition: "nav",
    });
    vi.advanceTimersByTime(8000); // the floor would have gated the exit
    expect(m.getState().cursor).toBe(3); // unchanged: the exit was not it
    m.destroy();
  });

  it("same manifest, AUTO mode (no skip): the chain exits at the 8 s floor", () => {
    vi.useFakeTimers();
    const m = machine(holdFloorChained()); // default settings, auto
    // Chain timing: video (chain head) + two lines at minHold = 3000 ms.
    vi.advanceTimersByTime(2999);
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(1); // last chain item at machine time 3000
    expect(m.getState().cursor).toBe(2);
    // Leaving waits for the floor: NOT the 4500 ms text-only exit…
    vi.advanceTimersByTime(4999); // total 7999
    expect(m.getState().cursor).toBe(2);
    // …but 8000 from the chain head, exactly the expected ~7.9 s of wall.
    vi.advanceTimersByTime(1);
    expect(m.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: false,
      skipping: false,
      transition: "advance",
    });
    m.destroy();
  });

  it("default settings (skipAll off): tab at a fresh start is inert; the floor gates auto from the chain head", () => {
    vi.useFakeTimers();
    const m = machine(holdFloorChained()); // default settings: skipAll off
    const before = m.getState();
    m.toggleSkip(); // entered on the video, as in the report: nothing seen ahead
    expect(m.getState()).toBe(before); // skip never reveals (docs/plan.md Phase 18)
    // Auto governs the chain, and the floor applies from its head (0).
    vi.advanceTimersByTime(7999);
    expect(m.getState().cursor).toBe(2);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(3);
    m.destroy();
  });

  it("an already-elapsed floor adds no wait: text timing unchanged", () => {
    vi.useFakeTimers();
    // Dialogue long enough (3 x 2400 ms over the default holds) that the
    // last chain item is entered at 6300 ms — long past the 5 s floor.
    const m = machine([
      video(8, undefined, { minPlaySeconds: 5 }),
      text("a".repeat(40)),
      text("a".repeat(40)),
      text("a".repeat(40)),
      image(),
    ]);
    vi.advanceTimersByTime(8699); // entered 3rd line at 6300 + its 2399 hold
    expect(m.getState().cursor).toBe(3);
    vi.advanceTimersByTime(1); // exit at 8700: the plain text timing
    expect(m.getState().cursor).toBe(4); // floor <= 0 behaves as today
    m.destroy();
  });
});

describe("transition kind: which mover made the item current", () => {
  // `MachineState.transition` is the renderer's replay signal: an `advance`
  // plays its media wherever the cursor sits, a `nav` arrival below the seen
  // edge holds the poster (docs/content-format.md, "Timing"). Pinned here
  // mover by mover; the pure mode rule itself is render/visual.test.ts.
  const five = () => [image(), image(), image(), image(), image()];

  it("is nav for a load landing, fresh or resumed", () => {
    vi.useFakeTimers();
    const fresh = machine(five());
    expect(fresh.getState().transition).toBe("nav");
    const resumed = machine(five(), { resumeFrontier: 3 });
    expect(resumed.getState().transition).toBe("nav");
    const restored = createMachine({
      items: five(),
      settings: SETTINGS,
      autoAdvance: true,
      resumeContext: {
        lastShown: 2,
        visited: [0, 1, 2],
        stack: [],
        playedRoutes: [],
      },
    });
    expect(restored.getState().transition).toBe("nav");
    for (const m of [fresh, resumed, restored]) m.destroy();
  });

  it("is advance for a space press that moves, and unchanged for one that moves nothing", () => {
    vi.useFakeTimers();
    const manual = createMachine({ items: five(), settings: SETTINGS });
    manual.advance(); // manual: one press settles AND moves
    expect(manual.getState().cursor).toBe(1);
    expect(manual.getState().transition).toBe("advance");
    manual.destroy();

    const auto = machine(five());
    auto.advance(); // auto: this press only returns to manual (Phase 18)
    expect(auto.getState()).toMatchObject({ cursor: 0, settled: false });
    expect(auto.getState().transition).toBe("nav"); // no transition happened
    auto.advance(); // the press that moves is the advance
    expect(auto.getState().cursor).toBe(1);
    expect(auto.getState().transition).toBe("advance");
    auto.destroy();
  });

  it("is advance when the auto hold elapses", () => {
    vi.useFakeTimers();
    const m = machine(five());
    vi.advanceTimersByTime(SETTINGS.minHoldMs);
    expect(m.getState().cursor).toBe(1);
    expect(m.getState().transition).toBe("advance");
    m.destroy();
  });

  it("is nav for the wheel, in both directions", () => {
    vi.useFakeTimers();
    const m = machine(five());
    vi.advanceTimersByTime(SETTINGS.minHoldMs * 3); // seen edge at item 3
    expect(m.getState().cursor).toBe(3);
    m.wheelBack();
    expect(m.getState()).toMatchObject({ cursor: 2, transition: "nav" });
    m.wheelForward();
    expect(m.getState()).toMatchObject({ cursor: 3, transition: "nav" });
    m.destroy();
  });

  it("is nav for a bookmark goTo and for the e jump", () => {
    vi.useFakeTimers();
    const m = machine(five());
    vi.advanceTimersByTime(SETTINGS.minHoldMs * 3);
    m.goTo(0);
    expect(m.getState()).toMatchObject({ cursor: 0, transition: "nav" });
    m.wheelForward(); // the next screen in story order
    expect(m.getState()).toMatchObject({ cursor: 1, transition: "nav" });
    m.jumpToEnd(); // the furthest point read: item 3
    expect(m.getState()).toMatchObject({ cursor: 3, transition: "nav" });
    m.destroy();
  });

  it("is nav for a bookmark restore (importContext)", () => {
    vi.useFakeTimers();
    const m = machine(five());
    vi.advanceTimersByTime(SETTINGS.minHoldMs * 3);
    const context = m.exportContext();
    m.advance(); // an advance, to prove the restore overwrites the kind
    expect(m.getState().transition).toBe("advance");
    m.importContext({ ...context, lastShown: 1 });
    expect(m.getState()).toMatchObject({ cursor: 1, settled: false });
    expect(m.getState().transition).toBe("nav");
    m.destroy();
  });

  it("is nav for skip's dwell step, and no command that does not move rewrites it", () => {
    vi.useFakeTimers();
    const m = machine(five());
    vi.advanceTimersByTime(SETTINGS.minHoldMs * 3); // seen edge at item 3
    m.wheelBack();
    m.wheelBack(); // cursor 1, deep below the edge
    expect(m.getState().transition).toBe("nav");
    m.toggleSkip(); // tab on: an emit on the SAME item
    expect(m.getState().transition).toBe("nav");
    vi.advanceTimersByTime(SETTINGS.skipDwellMs);
    expect(m.getState().cursor).toBe(2); // a dwell step forward
    expect(m.getState().transition).toBe("nav"); // a fast traverse, not a read
    m.toggleSkip(); // tab off: same item, kind untouched
    expect(m.getState().transition).toBe("nav");
    m.advance(); // auto mode: this press ends the wait where it stands
    expect(m.getState().cursor).toBe(2);
    m.advance(); // and the press that moves turns the kind around
    expect(m.getState().cursor).toBe(3);
    expect(m.getState().transition).toBe("advance");
    m.destroy();
  });
});
