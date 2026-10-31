import { describe, expect, it } from "vitest";

import type { Item, VideoItem } from "../machine/types";
import { animationFrameAt, playbackModeFor, videoPlanFor } from "./visual";

const item = (fields: Partial<Item>): Item =>
  ({ id: "x-001", type: "image", ...fields }) as Item;

const vid = (fields: Partial<VideoItem>): VideoItem =>
  ({
    id: "v-001",
    type: "video",
    file: "v.mp4",
    poster: "v.jpg",
    durationSeconds: 2,
    ...fields,
  }) as VideoItem;

const video = vid({});
const loopVideo = vid({ loopCount: 3 });
const holdVideo = vid({ holdSeconds: 12 });
const holdLoopVideo = vid({ loopCount: 3, holdSeconds: 12 });
// phase 9c shapes: a sub-range of the file, and the same range whose end
// IS the file's end (2 s duration is the `vid` default).
const rangeVideo = vid({ startSeconds: 0.0, endSeconds: 1.0, loopCount: 1 });
const endRangeVideo = vid({ startSeconds: 1.0, endSeconds: 2.0, loopCount: 2 });
const startOnlyVideo = vid({ startSeconds: 1.5 });
const holdRangeVideo = vid({ holdSeconds: 12, endSeconds: 1.0 });
// phase 9d shape (part-013's): the range loops back from a restart point
// inside it, so the first pass plays a pre-roll the loop-backs skip.
const loopStartVideo = vid({
  startSeconds: 1.0,
  endSeconds: 2.0,
  loopStartSeconds: 1.5,
  loopCount: 2,
});
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
    // loopCount/holdSeconds change the video plan, not the mode: still
    // loop-once; `videoPlanFor` below decides passes vs free looping.
    expect(playbackModeFor(loopVideo, undefined, false, 3, 4)).toBe(
      "loop-once",
    );
    expect(playbackModeFor(holdVideo, undefined, false, 3, 4)).toBe(
      "loop-once",
    );
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

describe("videoPlanFor", () => {
  it("plays a standalone video with loop off, reporting each of its passes", () => {
    // The HTML fact: `loop` NEVER fires 'ended', so a video whose ends
    // gate must play with loop off; the default loopCount is one pass.
    // No `endSeconds`: the file's own end bounds each pass.
    expect(videoPlanFor(video, "loop-once", true)).toEqual({
      loop: false,
      reportEnds: 1,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: null,
      boundary: "ended",
    });
    expect(videoPlanFor(loopVideo, "loop-once", true)).toEqual({
      loop: false,
      reportEnds: 3,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: null,
      boundary: "ended",
    });
  });

  it("treats a holdSeconds video as background: free looping, no ends", () => {
    // Time-driven only — the machine ignores ended for these.
    expect(videoPlanFor(holdVideo, "loop-once", true)).toEqual({
      loop: true,
      reportEnds: 0,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: null,
      boundary: "ended",
    });
    // holdSeconds wins over loopCount: it is the explicit display duration.
    expect(videoPlanFor(holdLoopVideo, "loop-once", true)).toEqual({
      loop: true,
      reportEnds: 0,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: null,
      boundary: "ended",
    });
  });

  it("loops forever under a text chain and reports nothing", () => {
    // Chain looping is forever, so its ends could never be counted anyway.
    expect(videoPlanFor(video, "loop-forever", true)).toEqual({
      loop: true,
      reportEnds: 0,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: null,
      boundary: "ended",
    });
    expect(videoPlanFor(loopVideo, "loop-forever", true)).toEqual({
      loop: true,
      reportEnds: 0,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: null,
      boundary: "ended",
    });
  });

  it("plays nothing on a still", () => {
    expect(videoPlanFor(video, "still", true)).toEqual({
      loop: false,
      reportEnds: 0,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: null,
      boundary: "ended",
    });
    expect(videoPlanFor(loopVideo, "still", true)).toEqual({
      loop: false,
      reportEnds: 0,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: null,
      boundary: "ended",
    });
  });

  // --- playback ranges (docs/plan.md Phase 9c) --------------------------

  it("carries the range into the plan: start is the seek target, end the bound", () => {
    expect(videoPlanFor(rangeVideo, "loop-once", true)).toEqual({
      loop: false,
      reportEnds: 1,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: 1,
      boundary: "rvfc",
    });
    expect(videoPlanFor(endRangeVideo, "loop-once", true)).toEqual({
      loop: false,
      reportEnds: 2,
      startSeconds: 1,
      loopStartSeconds: 1, // default: the loop replays the whole range
      endSeconds: 2,
      boundary: "ended", // an end at the file's end IS the file's end event
    });
    expect(videoPlanFor(startOnlyVideo, "loop-once", true)).toEqual({
      loop: false,
      reportEnds: 1,
      startSeconds: 1.5,
      loopStartSeconds: 1.5,
      endSeconds: null,
      boundary: "ended",
    });
  });

  it("never loops when a range is active — even under a chain or hold", () => {
    // loop=true would seek to 0, wrong for a range: the renderer seeks
    // back itself at each pass boundary (to `loopStartSeconds`).
    const forever = videoPlanFor(rangeVideo, "loop-forever", true);
    expect(forever.loop).toBe(false);
    expect(forever.reportEnds).toBe(0); // the chain gates nothing
    expect(forever.startSeconds).toBe(0);
    expect(forever.endSeconds).toBe(1);
    const background = videoPlanFor(holdRangeVideo, "loop-once", true);
    expect(background.loop).toBe(false);
    expect(background.reportEnds).toBe(0);
    expect(background.endSeconds).toBe(1);
    // A still of a range holds the frame AT startSeconds.
    const still = videoPlanFor(endRangeVideo, "still", true);
    expect(still.loop).toBe(false);
    expect(still.reportEnds).toBe(0);
    expect(still.startSeconds).toBe(1);
  });

  it("bounds a pass by rVFC when available, by timeupdate where it is not", () => {
    // rVFC's mediaTime is exact per presented frame; timeupdate fires only
    // every ~4-250 ms and so overshoots the end frame — the documented
    // fallback (Firefox pre-133).
    expect(videoPlanFor(rangeVideo, "loop-once", true).boundary).toBe("rvfc");
    expect(videoPlanFor(rangeVideo, "loop-once", false).boundary).toBe(
      "timeupdate",
    );
    // The file's own end needs neither: 'ended' is the exact signal then.
    expect(videoPlanFor(video, "loop-once", false).boundary).toBe("ended");
    expect(videoPlanFor(endRangeVideo, "loop-once", false).boundary).toBe(
      "ended",
    );
  });

  // --- loop restart point (docs/plan.md Phase 9d) ------------------------

  it("defaults the loop restart to the range start", () => {
    // Without `loopStartSeconds` every pass restarts at `startSeconds` —
    // today's behaviour; entry and loop-back are the same point.
    expect(
      videoPlanFor(endRangeVideo, "loop-once", true).loopStartSeconds,
    ).toBe(1);
    expect(
      videoPlanFor(rangeVideo, "loop-forever", true).loopStartSeconds,
    ).toBe(0);
    // A plain no-range video restarts at 0, same as its entry.
    expect(videoPlanFor(loopVideo, "loop-once", true).loopStartSeconds).toBe(0);
  });

  it("honours an explicit loopStartSeconds for the loop-back only", () => {
    // The seek-back after a completed pass restarts at loopStartSeconds
    // (1.5); a fresh entry and a still still use startSeconds (1.0).
    const plan = videoPlanFor(loopStartVideo, "loop-once", true);
    expect(plan.startSeconds).toBe(1); // entry seek unchanged
    expect(plan.loopStartSeconds).toBe(1.5); // loop-back seek
    expect(plan.reportEnds).toBe(2);
    // A chain under text carries the same restart point; nothing counted.
    const chain = videoPlanFor(loopStartVideo, "loop-forever", true);
    expect(chain.loopStartSeconds).toBe(1.5);
    expect(chain.reportEnds).toBe(0);
    // holdSeconds (background) carries it too, free looping.
    const hold = videoPlanFor(
      { ...loopStartVideo, holdSeconds: 12 },
      "loop-once",
      true,
    );
    expect(hold.loopStartSeconds).toBe(1.5);
  });

  it("leaves the boundary signal untouched by loopStartSeconds", () => {
    // loopStartSeconds never changes how a pass is bounded: an end at the
    // file's end is `ended`, an interior end is rVFC/timeupdate.
    expect(videoPlanFor(loopStartVideo, "loop-once", true).boundary).toBe(
      "ended",
    );
    const interior = { ...loopStartVideo, endSeconds: 1.9 };
    expect(videoPlanFor(interior, "loop-once", true).boundary).toBe("rvfc");
    expect(videoPlanFor(interior, "loop-once", false).boundary).toBe(
      "timeupdate",
    );
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
