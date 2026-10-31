import { describe, expect, it } from "vitest";

import type { Item } from "../machine/types";
import { animationFrameAt, playbackModeFor } from "./visual";

const item = (fields: Partial<Item>): Item =>
  ({ id: "x-001", type: "image", ...fields }) as Item;

const video = item({ type: "video", file: "v.mp4", poster: "v.jpg" });
const animation = item({
  type: "animation",
  frames: ["a.jpg", "b.jpg"],
  fps: 8,
  loopCount: 2,
});
const text = item({ type: "text", text: "A line." });

describe("playbackModeFor", () => {
  it("plays a standalone media item at the frontier exactly once", () => {
    // cursor 3 of frontier 4: the last shown item, nothing unseen ahead.
    expect(playbackModeFor(video, undefined, false, 3, 4)).toBe("loop-once");
    expect(playbackModeFor(animation, video, false, 3, 4)).toBe("loop-once");
  });

  it("loops forever while the current item is text", () => {
    expect(playbackModeFor(text, undefined, false, 6, 7)).toBe("loop-forever");
    expect(playbackModeFor(text, video, false, 6, 7)).toBe("loop-forever");
  });

  it("loops forever while the NEXT item is text — the chain's head", () => {
    expect(playbackModeFor(video, text, false, 5, 6)).toBe("loop-forever");
    expect(playbackModeFor(animation, text, false, 5, 6)).toBe("loop-forever");
  });

  it("shows stills on rewind: the cursor sits below the frontier", () => {
    // Even a chain item rewound to is a still (docs/content-format.md).
    expect(playbackModeFor(video, text, false, 5, 8)).toBe("still");
    expect(playbackModeFor(text, undefined, false, 6, 8)).toBe("still");
    expect(playbackModeFor(animation, undefined, false, 0, 4)).toBe("still");
  });

  it("shows stills during skip, chain or not", () => {
    expect(playbackModeFor(video, text, true, 5, 6)).toBe("still");
    expect(playbackModeFor(text, undefined, true, 5, 6)).toBe("still");
    expect(playbackModeFor(animation, undefined, true, 5, 6)).toBe("still");
  });

  it("falls back to still when there is no cursor item", () => {
    expect(playbackModeFor(undefined, undefined, false, 0, 0)).toBe("still");
  });
});

describe("animationFrameAt", () => {
  // spark-005's shape: 4 frames at 8 fps (125 ms per frame), 2 loops.
  const fps = 8;
  const frames = 4;
  const loops = 2;

  it("advances one frame per 1000/fps ms", () => {
    expect(animationFrameAt(frames, fps, loops, 0)).toBe(0);
    expect(animationFrameAt(frames, fps, loops, 124)).toBe(0);
    expect(animationFrameAt(frames, fps, loops, 125)).toBe(1);
    expect(animationFrameAt(frames, fps, loops, 499)).toBe(3);
  });

  it("wraps at the sequence end for each loop", () => {
    expect(animationFrameAt(frames, fps, loops, 500)).toBe(0); // second loop
    expect(animationFrameAt(frames, fps, loops, 875)).toBe(3);
  });

  it("stops on the final frame once all loops have elapsed", () => {
    // 2 loops x 4 frames x 125 ms = 1000 ms of cycling.
    expect(animationFrameAt(frames, fps, loops, 999)).toBe(3);
    expect(animationFrameAt(frames, fps, loops, 1000)).toBe(3);
    expect(animationFrameAt(frames, fps, loops, 60_000)).toBe(3);
  });

  it("cycles forever with loopCount Infinity (chain mode)", () => {
    const forever = Number.POSITIVE_INFINITY;
    expect(animationFrameAt(frames, fps, forever, 2500)).toBe(0); // step 20
    expect(animationFrameAt(frames, fps, forever, 2625)).toBe(1); // step 21
    expect(animationFrameAt(frames, fps, forever, 1_000_000_000)).toBe(0);
  });

  it("honours a single loop", () => {
    // 3 frames at 10 fps: 100 ms per frame, one pass, stops on frame 2.
    expect(animationFrameAt(3, 10, 1, 100)).toBe(1);
    expect(animationFrameAt(3, 10, 1, 299)).toBe(2);
    expect(animationFrameAt(3, 10, 1, 300)).toBe(2);
  });

  it("degenerates to frame 0 on nonsensical inputs", () => {
    expect(animationFrameAt(0, fps, loops, 500)).toBe(0);
    expect(animationFrameAt(frames, 0, loops, 500)).toBe(0);
    expect(animationFrameAt(frames, fps, loops, -1)).toBe(0);
  });
});
