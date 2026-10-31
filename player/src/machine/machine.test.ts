import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../storage/memory";
import {
  createMachine,
  itemHoldMs,
  textHoldMs,
  visualIndexFor,
} from "./machine";
import type { Item, MachineSettings, MachineState, Manifest } from "./types";
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
    });
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
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: true,
      skipping: false,
    });
    // Second press moves, and the frontier follows into unseen content.
    m.advance();
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
    });
    m.advance(); // settle animation
    m.advance(); // move onto the video
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
    });
    // At the last item, settles then clamps with the frontier at the end.
    m.advance();
    m.advance();
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: true,
      skipping: false,
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
    });
    m.destroy();
  });

  it("settling an item stops its pending auto-advance", () => {
    vi.useFakeTimers();
    const m = machine([image(), image()]);
    m.advance(); // immediate-complete before the hold elapsed
    vi.advanceTimersByTime(60_000);
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: true,
      skipping: false,
    });
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
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
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
    });
    vi.advanceTimersByTime(1);
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
    });
    // On the text item, mediaEnded is irrelevant: the cursor does not move.
    m.mediaEnded();
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: false,
      skipping: false,
    });
    vi.advanceTimersByTime(2399);
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(1);
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
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
    });
    vi.advanceTimersByTime(1499);
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(1); // first text line: minHold floor
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
    });
    vi.advanceTimersByTime(1500); // second text line
    expect(m.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: false,
      skipping: false,
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
    const m = machine(items);
    expect(m.visualIndex()).toBe(0);
    for (const [expectedCursor, expectedVisual] of [
      [1, 0],
      [2, 0],
      [3, 3],
      [4, 3],
      [5, 5],
      [6, 5],
    ]) {
      m.advance(); // settle the current item
      m.advance(); // move to the next one
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
    });
    // Landing is the e-jump position: the last shown item, counted settled.
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: true,
      skipping: false,
    });
    m.advance();
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
    });
    m.destroy();
  });

  it("wheel forward is blocked at the frontier", () => {
    const m = machine([image(), image(), image()], { resumeFrontier: 2 });
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: true,
      skipping: false,
    });
    m.wheelForward(); // cursor 1 === frontier - 1: unseen ahead, blocked
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 2,
      settled: true,
      skipping: false,
    });
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
    });
    // advance() may cross the frontier; the wheel may not.
    m.advance(); // settle the re-shown item
    m.advance();
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
    });
    m.destroy();
  });

  it("wheel forward at the frontier stays blocked across a text chain", () => {
    const m = machine([image(), video(), text("one"), text("two"), image()], {
      resumeFrontier: 3,
    });
    // Last seen item is the text line; its visual is the video.
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: true,
      skipping: false,
    });
    expect(m.visualIndex()).toBe(1); // the video's visual keeps showing
    m.wheelForward(); // unseen item ahead: blocked
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: true,
      skipping: false,
    });
    m.wheelBack(); // back through seen content, same visual
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 3,
      settled: false,
      skipping: false,
    });
    expect(m.visualIndex()).toBe(1);
    m.wheelForward(); // forward again through seen content
    expect(m.getState().cursor).toBe(2);
    m.wheelForward(); // blocked at the frontier again
    expect(m.getState().cursor).toBe(2);
    // advance() crosses the frontier from a text item like any other item.
    m.advance(); // settle the re-shown text line
    m.advance();
    expect(m.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: false,
      skipping: false,
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
    });
    m.destroy();
  });
});

describe("skip mode (tab), docs/plan.md Phase 4", () => {
  function skipSettings(skipAll: boolean): MachineSettings {
    return { ...SETTINGS, skipAll };
  }

  it("advances every item after the fixed dwell; media never gates", () => {
    vi.useFakeTimers();
    const m = machine(
      [
        image(), // plain image
        animation(10, 5, 2), // 4000 ms loop time
        video(600), // 10-minute video
        text("a".repeat(40)), // 2400 ms text hold when not skipping
        image(),
      ],
      { settings: skipSettings(true) },
    );
    m.toggleSkip();
    expect(m.getState().skipping).toBe(true);
    const dwell = SETTINGS.skipDwellMs;
    // Each item — image, animation, video, text — takes exactly one dwell.
    for (let steps = 1; steps <= 4; steps += 1) {
      vi.advanceTimersByTime(dwell - 1);
      expect(m.getState().cursor).toBe(steps - 1);
      m.mediaEnded(); // a straggler media-end must not skip ahead
      vi.advanceTimersByTime(1);
      expect(m.getState().cursor).toBe(steps);
      expect(m.getState().skipping).toBe(steps < 4);
    }
    // The chain (video + text line) consumed one dwell per item, 4 x dwell
    // total, where normal timing would have taken 1500 + 4000 + 1500 + 2400.
    m.destroy();
  });

  it("with skipAll off, ends as the frontier item becomes current; its normal auto-advance is armed", () => {
    vi.useFakeTimers();
    const m = machine([image(), image(), image(), image(), image()], {
      resumeFrontier: 3,
    });
    // Cursor starts at the last seen item (2); the next item is unseen.
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs - 1);
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: true,
    });
    vi.advanceTimersByTime(1);
    // Moved onto the first unseen item (shown, so frontier moves too) and
    // skip mode ended without entering further unseen content.
    expect(m.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: false,
      skipping: false,
    });
    // Shown normally: the item's own 1500 ms hold drives auto-advance.
    vi.advanceTimersByTime(1499);
    expect(m.getState().cursor).toBe(3);
    vi.advanceTimersByTime(1);
    expect(m.getState()).toEqual({
      cursor: 4,
      frontier: 5,
      settled: false,
      skipping: false,
    });
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
    const total = SETTINGS.skipDwellMs * 3;
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
    });
    vi.advanceTimersByTime(60_000); // nothing pending advances by itself
    expect(m.getState().cursor).toBe(0);
    m.advance(); // then behaves normally: the next press moves
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("a wheel step during skip exits skip mode AND performs the step", () => {
    vi.useFakeTimers();
    const m = machine([image(), image(), image(), image()], {
      resumeFrontier: 3,
    });
    m.toggleSkip();
    m.wheelBack();
    expect(m.getState()).toEqual({
      cursor: 1,
      frontier: 3,
      settled: false,
      skipping: false,
    });
    m.toggleSkip();
    m.wheelForward(); // forward step also exits skip and performs
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
    });
    m.toggleSkip();
    m.wheelForward(); // blocked at the frontier: exits skip, stays
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: false,
      skipping: false,
    });
    m.destroy();
  });
});

describe("e-jump (jumpToUnseen), docs/plan.md Phase 4", () => {
  it("jumps to the item before the frontier and a repeat press is a no-op", () => {
    const m = machine([image(), image(), image(), image(), image()], {
      resumeFrontier: 3,
    });
    m.wheelBack();
    m.wheelBack(); // bookmark-style rollback to the start
    expect(m.getState().cursor).toBe(0);
    m.jumpToUnseen();
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: true,
      skipping: false,
    });
    m.jumpToUnseen(); // repeat: stay
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: true,
      skipping: false,
    });
    m.advance(); // one press enters unseen content
    expect(m.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: false,
      skipping: false,
    });
    m.destroy();
  });

  it("the jump marks nothing new seen and never touches unseen content", () => {
    const m = machine([image(), image(), image()], { resumeFrontier: 1 });
    m.jumpToUnseen(); // cursor 0 === frontier - 1: no-op
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: true,
      skipping: false,
    });
    m.advance(); // settled landing: the first advance enters item 1
    expect(m.getState().frontier).toBe(2); // nothing marked seen until shown
    m.destroy();
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
    });
    m.goTo(0); // back to the very first item
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 4,
      settled: false,
      skipping: false,
    });
    m.goTo(2); // forward, mid-seen
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 4,
      settled: false,
      skipping: false,
    });
    m.goTo(1);
    m.goTo(3); // back onto the frontier edge itself
    expect(m.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: false,
      skipping: false,
    });
    m.advance(); // arrival was unsettled: this press settles, it does not move
    expect(m.getState().cursor).toBe(3);
    m.advance(); // and the next enters unseen content as ever
    expect(m.getState()).toEqual({
      cursor: 4,
      frontier: 5,
      settled: false,
      skipping: false,
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
    });
    m.goTo(99); // same clamp for a far-off index
    expect(m.getState().cursor).toBe(1);
    expect(m.getState().frontier).toBe(2);
    m.goTo(-5); // and below zero
    expect(m.getState().cursor).toBe(0);
    expect(m.getState().frontier).toBe(2);
    m.destroy();
  });

  it("arrives UNSETTLED, unlike the e-jump: the bookmarked item replays", () => {
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
    });
    // The item's own hold is armed: at 1499 ms nothing has moved...
    vi.advanceTimersByTime(1499);
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 3,
      settled: false,
      skipping: false,
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
    });
    vi.advanceTimersByTime(10_000); // hold elapses: settle, nothing to enter
    expect(m.getState()).toEqual({
      cursor: 2,
      frontier: 3,
      settled: true,
      skipping: false,
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
    });
    m.destroy();
    m.goTo(1);
    expect(m.getState().cursor).toBe(0); // destroy() froze the machine
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
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: false,
      skipping: false,
    });
  });
});

describe("resume from persisted storage (docs/plan.md Phase 8, memory fake)", () => {
  it("the persisted value feeds resumeFrontier: lands at frontier-1, e is a no-op there, one advance enters unseen", async () => {
    const storage = createMemoryStorage();
    const items = [image(), image(), image(), image(), image(), image()];
    // Session 1: the reader saw items 0..3 (three settle-and-move pairs).
    const first = machine(items);
    first.advance();
    first.advance();
    first.advance();
    first.advance();
    first.advance();
    first.advance();
    expect(first.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: false,
      skipping: false,
    });
    // Exactly what main.ts's persister writes: the frontier, and only it.
    await storage.saveState({ frontier: first.getState().frontier });
    first.destroy();

    // Reload, as main.ts does it: the stored frontier becomes
    // resumeFrontier, and the machine derives cursor = frontier - 1 and
    // the settled landing itself.
    expect(await storage.loadState()).toEqual({ frontier: 4 });
    const resumed = machine(items, {
      resumeFrontier: (await storage.loadState())?.frontier,
    });
    expect(resumed.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: true,
      skipping: false,
    });
    // `e` at the resume spot: the landing already IS frontier - 1, no-op.
    resumed.jumpToUnseen();
    expect(resumed.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: true,
      skipping: false,
    });

    // Travelling back through seen content persists nothing: a reload
    // returns to the resume spot, not wherever the wheel had stopped.
    resumed.wheelBack();
    resumed.wheelBack();
    expect(resumed.getState().cursor).toBe(1);
    const second = machine(items, {
      resumeFrontier: (await storage.loadState())?.frontier,
    });
    expect(second.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: true,
      skipping: false,
    });
    // From the resume spot one press enters the first unseen item...
    second.advance();
    expect(second.getState()).toEqual({
      cursor: 4,
      frontier: 5,
      settled: false,
      skipping: false,
    });
    // ...and that frontier is worth persisting: the next reload resumes
    // from it, settled at item 4.
    await storage.saveState({ frontier: second.getState().frontier });
    const third = machine(items, {
      resumeFrontier: (await storage.loadState())?.frontier,
    });
    expect(third.getState()).toEqual({
      cursor: 4,
      frontier: 5,
      settled: true,
      skipping: false,
    });
    resumed.destroy();
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
    m.advance(); // immediate-complete: settled, timer cancelled
    m.setSettings({ ...SETTINGS, readingSpeed: 3 });
    vi.advanceTimersByTime(60_000);
    expect(m.getState()).toEqual({
      cursor: 0,
      frontier: 1,
      settled: true,
      skipping: false,
    });
    m.destroy();
  });

  it("skipAll takes effect at the frontier crossing: skip walks the unseen tail", () => {
    vi.useFakeTimers();
    // Cursor starts at the last seen item (2), frontier at 3: the very
    // next skip step enters unseen content, where skipAll decides.
    const m = machine([image(), image(), image(), image(), image()], {
      resumeFrontier: 3,
    });
    m.toggleSkip();
    m.setSettings({ ...SETTINGS, skipAll: true }); // changed mid-skip
    const dwell = SETTINGS.skipDwellMs;
    vi.advanceTimersByTime(dwell); // onto the frontier item, skip goes on
    expect(m.getState()).toEqual({
      cursor: 3,
      frontier: 4,
      settled: false,
      skipping: true,
    });
    vi.advanceTimersByTime(dwell); // last item: skip ends at content end
    expect(m.getState()).toEqual({
      cursor: 4,
      frontier: 5,
      settled: false,
      skipping: false,
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
