import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachine, itemHoldMs, textHoldMs } from "./machine";
import type { Item, MachineSettings, MachineState, Manifest } from "./types";
import { DEFAULT_SETTINGS } from "./types";

const SETTINGS: MachineSettings = { ...DEFAULT_SETTINGS };

function image(text?: string): Item {
  return { id: "img", type: "image", file: "img.jpg", text };
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

function video(durationSeconds = 10, text?: string): Item {
  return {
    id: "vid",
    type: "video",
    file: "vid.mp4",
    poster: "vid.poster.jpg",
    durationSeconds,
    text,
  };
}

function manifest(items: readonly Item[]): Manifest {
  return { schemaVersion: 1, width: 1280, height: 720, items };
}

function machine(
  items: readonly Item[],
  opts: { resumeFrontier?: number; settings?: MachineSettings } = {},
) {
  return createMachine({
    items,
    settings: opts.settings ?? SETTINGS,
    resumeFrontier: opts.resumeFrontier,
  });
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

  it("video hold lower bound is the text hold", () => {
    expect(itemHoldMs(video(10), SETTINGS)).toBe(1500);
  });
});

describe("advance() through every item type", () => {
  it("first-ever load starts at item 0 with frontier one past it", () => {
    const m = machine(manifest([image(), animation(3, 12, 3), video()]).items);
    expect(m.getState()).toEqual({ cursor: 0, frontier: 1, settled: false });
    m.destroy();
  });

  it("settles an unsettled item without moving, then moves", () => {
    vi.useFakeTimers();
    const items = manifest([
      image("first"),
      animation(3, 12, 3),
      video(),
    ]).items;
    const m = machine(items);
    // First press on a not-yet-settled item: immediate-complete, no move.
    m.advance();
    expect(m.getState()).toEqual({ cursor: 0, frontier: 1, settled: true });
    // Second press moves, and the frontier follows into unseen content.
    m.advance();
    expect(m.getState()).toEqual({ cursor: 1, frontier: 2, settled: false });
    m.advance(); // settle animation
    m.advance(); // move onto the video
    expect(m.getState()).toEqual({ cursor: 2, frontier: 3, settled: false });
    // At the last item, settles then clamps with the frontier at the end.
    m.advance();
    m.advance();
    expect(m.getState()).toEqual({ cursor: 2, frontier: 3, settled: true });
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
    expect(m.getState()).toEqual({ cursor: 1, frontier: 2, settled: false });
    m.destroy();
  });

  it("settling an item stops its pending auto-advance", () => {
    vi.useFakeTimers();
    const m = machine([image(), image()]);
    m.advance(); // immediate-complete before the hold elapsed
    vi.advanceTimersByTime(60_000);
    expect(m.getState()).toEqual({ cursor: 0, frontier: 1, settled: true });
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

describe("video and mediaEnded()", () => {
  it("waits for mediaEnded when the video outlasts the text hold", () => {
    vi.useFakeTimers();
    const m = machine([video(10), image()]);
    vi.advanceTimersByTime(5000); // text hold long past, video still running
    expect(m.getState().cursor).toBe(0);
    m.mediaEnded();
    expect(m.getState()).toEqual({ cursor: 1, frontier: 2, settled: false });
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

describe("frontier and wheel rules", () => {
  it("resume starts at the frontier and counts it as shown", () => {
    const m = machine([image(), image(), image(), image()], {
      resumeFrontier: 2,
    });
    expect(m.getState()).toEqual({ cursor: 2, frontier: 3, settled: false });
    m.destroy();
  });

  it("wheel forward is blocked at the frontier", () => {
    const m = machine([image(), image(), image()], { resumeFrontier: 1 });
    m.wheelForward(); // cursor 1 === frontier - 1: unseen ahead, blocked
    expect(m.getState()).toEqual({ cursor: 1, frontier: 2, settled: false });
    m.wheelBack();
    expect(m.getState().cursor).toBe(0);
    m.wheelForward(); // returns through seen content
    expect(m.getState().cursor).toBe(1);
    m.wheelForward(); // blocked again
    expect(m.getState()).toEqual({ cursor: 1, frontier: 2, settled: false });
    // advance() may cross the frontier; the wheel may not.
    m.advance();
    m.advance();
    expect(m.getState()).toEqual({ cursor: 2, frontier: 3, settled: false });
    m.destroy();
  });

  it("wheel back before item 0 clamps", () => {
    const m = machine([image(), image()]);
    m.wheelBack();
    expect(m.getState()).toEqual({ cursor: 0, frontier: 1, settled: false });
    m.destroy();
  });

  it("a first-ever load cannot wheel into unseen content", () => {
    const m = machine([image(), image()]);
    m.wheelForward();
    expect(m.getState()).toEqual({ cursor: 0, frontier: 1, settled: false });
    m.destroy();
  });
});

describe("subscribe, timers, and destroy()", () => {
  it("notifies subscribers on every state change until unsubscribe", () => {
    const m = machine([image(), image()]);
    const seen: MachineState[] = [];
    const unsubscribe = m.subscribe((s) => seen.push(s));
    m.advance(); // settles: notify
    m.advance(); // move: notify
    unsubscribe();
    m.wheelBack(); // not observed after unsubscribe
    expect(seen.map((s) => [s.cursor, s.settled])).toEqual([
      [0, true],
      [1, false],
    ]);
    expect(m.getState().cursor).toBe(0);
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
    expect(m.getState()).toEqual({ cursor: 0, frontier: 1, settled: false });
  });
});
