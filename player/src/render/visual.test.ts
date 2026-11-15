import { describe, expect, it, vi } from "vitest";

import type { Item, Manifest, VideoItem } from "../machine/types";
import {
  animationFrameAt,
  createVisualLayer,
  emptyStateNoticeText,
  playbackModeFor,
  type StageVideo,
  upcomingVisualFiles,
  videoPlanFor,
} from "./visual";

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
    // At the edge the kind of the arrival changes nothing.
    expect(playbackModeFor(video, undefined, false, "nav", 3, 4)).toBe(
      "loop-once",
    );
    expect(playbackModeFor(video, undefined, false, "advance", 3, 4)).toBe(
      "loop-once",
    );
    expect(playbackModeFor(animation, video, false, "nav", 3, 4)).toBe(
      "loop-once",
    );
    // loopCount/holdSeconds change the video plan, not the mode: still
    // loop-once; `videoPlanFor` below decides passes vs free looping.
    expect(playbackModeFor(loopVideo, undefined, false, "nav", 3, 4)).toBe(
      "loop-once",
    );
    expect(playbackModeFor(holdVideo, undefined, false, "nav", 3, 4)).toBe(
      "loop-once",
    );
  });

  it("loops forever while the current item is text", () => {
    expect(playbackModeFor(text, undefined, false, "nav", 6, 7)).toBe(
      "loop-forever",
    );
    expect(playbackModeFor(text, video, false, "advance", 6, 7)).toBe(
      "loop-forever",
    );
  });

  it("loops forever while the NEXT item is text — the chain's head", () => {
    expect(playbackModeFor(video, text, false, "nav", 5, 6)).toBe(
      "loop-forever",
    );
    expect(playbackModeFor(animation, text, false, "advance", 5, 6)).toBe(
      "loop-forever",
    );
  });

  it("shows stills on a nav arrival below the frontier", () => {
    // Wheel scrub, bookmark `goTo()`, `e` jump, route entry: the cursor is on
    // content already seen, so it stays a poster (docs/content-format.md).
    // Even a chain item rewound to is a still.
    expect(playbackModeFor(video, text, false, "nav", 5, 8)).toBe("still");
    expect(playbackModeFor(text, undefined, false, "nav", 6, 8)).toBe("still");
    expect(playbackModeFor(animation, undefined, false, "nav", 0, 4)).toBe(
      "still",
    );
  });

  it("replays a forward advance below the frontier", () => {
    // The reader is re-READING this content by pressing forward (or auto
    // re-walking it), so media plays again at any position: same modes the
    // same items get at the edge.
    expect(playbackModeFor(video, undefined, false, "advance", 5, 8)).toBe(
      "loop-once",
    );
    expect(playbackModeFor(animation, undefined, false, "advance", 0, 4)).toBe(
      "loop-once",
    );
    expect(playbackModeFor(video, text, false, "advance", 5, 8)).toBe(
      "loop-forever",
    );
    expect(playbackModeFor(text, undefined, false, "advance", 6, 8)).toBe(
      "loop-forever",
    );
  });

  it("shows stills during skip, chain or not, at any position", () => {
    // Skip wins over the arrival kind and the cursor position.
    for (const kind of ["nav", "advance"] as const) {
      expect(playbackModeFor(video, text, true, kind, 5, 6)).toBe("still");
      expect(playbackModeFor(text, undefined, true, kind, 5, 6)).toBe("still");
      expect(playbackModeFor(animation, undefined, true, kind, 5, 6)).toBe(
        "still",
      );
      expect(playbackModeFor(video, undefined, true, kind, 5, 8)).toBe("still");
    }
  });

  it("plays the video skip is playing (skipVideo), as an advance would", () => {
    // docs/plan.md Phase 18: `skipPlaysVideos` lifts skip's still, and the
    // nav arrival below the edge a skip step is.
    expect(playbackModeFor(video, undefined, true, "nav", 5, 8, true)).toBe(
      "loop-once",
    );
    expect(playbackModeFor(video, text, true, "nav", 5, 8, true)).toBe(
      "loop-forever",
    );
    expect(playbackModeFor(text, undefined, true, "nav", 6, 8, true)).toBe(
      "loop-forever",
    );
  });

  it("falls back to still when there is no cursor item", () => {
    expect(playbackModeFor(undefined, undefined, false, "nav", 0, 0)).toBe(
      "still",
    );
    expect(playbackModeFor(undefined, undefined, false, "advance", 0, 0)).toBe(
      "still",
    );
  });
});

describe("videoPlanFor", () => {
  it("plays a standalone video reporting each of its passes", () => {
    // The default loopCount is one pass.
    // No `endSeconds`: the file's own end bounds each pass.
    expect(videoPlanFor(video, "loop-once", true)).toEqual({
      reportEnds: 1,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: null,
      boundary: "fileEnd",
    });
    expect(videoPlanFor(loopVideo, "loop-once", true)).toEqual({
      reportEnds: 3,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: null,
      boundary: "fileEnd",
    });
  });

  it("treats a holdSeconds video as background: free looping, no ends", () => {
    // Time-driven only — the machine ignores ended for these.
    expect(videoPlanFor(holdVideo, "loop-once", true)).toEqual({
      reportEnds: 0,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: null,
      boundary: "fileEnd",
    });
    // holdSeconds wins over loopCount: it is the explicit display duration.
    expect(videoPlanFor(holdLoopVideo, "loop-once", true)).toEqual({
      reportEnds: 0,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: null,
      boundary: "fileEnd",
    });
  });

  it("loops forever under a text chain and reports nothing", () => {
    // Chain looping is forever, so its ends could never be counted anyway.
    expect(videoPlanFor(video, "loop-forever", true)).toEqual({
      reportEnds: 0,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: null,
      boundary: "fileEnd",
    });
    expect(videoPlanFor(loopVideo, "loop-forever", true)).toEqual({
      reportEnds: 0,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: null,
      boundary: "fileEnd",
    });
  });

  it("plays nothing on a still", () => {
    expect(videoPlanFor(video, "still", true)).toEqual({
      reportEnds: 0,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: null,
      boundary: "fileEnd",
    });
    expect(videoPlanFor(loopVideo, "still", true)).toEqual({
      reportEnds: 0,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: null,
      boundary: "fileEnd",
    });
  });

  // --- playback ranges (docs/plan.md Phase 9c) --------------------------

  it("carries the range into the plan: start is the seek target, end the bound", () => {
    expect(videoPlanFor(rangeVideo, "loop-once", true)).toEqual({
      reportEnds: 1,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: 1,
      boundary: "rvfc",
    });
    expect(videoPlanFor(endRangeVideo, "loop-once", true)).toEqual({
      reportEnds: 2,
      startSeconds: 1,
      loopStartSeconds: 1, // default: the loop replays the whole range
      endSeconds: 2,
      boundary: "fileEnd", // an end at the file's end is the file's end
    });
    expect(videoPlanFor(startOnlyVideo, "loop-once", true)).toEqual({
      reportEnds: 1,
      startSeconds: 1.5,
      loopStartSeconds: 1.5,
      endSeconds: null,
      boundary: "fileEnd",
    });
  });

  it("keeps the range under a chain or hold, reporting nothing", () => {
    // The renderer seeks back itself at each pass boundary (to
    // `loopStartSeconds`).
    const forever = videoPlanFor(rangeVideo, "loop-forever", true);
    expect(forever.reportEnds).toBe(0); // the chain gates nothing
    expect(forever.startSeconds).toBe(0);
    expect(forever.endSeconds).toBe(1);
    const background = videoPlanFor(holdRangeVideo, "loop-once", true);
    expect(background.reportEnds).toBe(0);
    expect(background.endSeconds).toBe(1);
    // A still of a range holds the frame AT startSeconds.
    const still = videoPlanFor(endRangeVideo, "still", true);
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
    // The file's own end needs neither (`endFile`).
    expect(videoPlanFor(video, "loop-once", false).boundary).toBe("fileEnd");
    expect(videoPlanFor(endRangeVideo, "loop-once", false).boundary).toBe(
      "fileEnd",
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
    // file's end is the file's end, an interior end is rVFC/timeupdate.
    expect(videoPlanFor(loopStartVideo, "loop-once", true).boundary).toBe(
      "fileEnd",
    );
    const interior = { ...loopStartVideo, endSeconds: 1.9 };
    expect(videoPlanFor(interior, "loop-once", true).boundary).toBe("rvfc");
    expect(videoPlanFor(interior, "loop-once", false).boundary).toBe(
      "timeupdate",
    );
  });

  // --- navigated re-entry (docs/plan.md Phase 16, part-012 stall) ---------

  it("replays the full plan on a re-entry at the seen edge", () => {
    // Navigation (wheel, `goTo()`, `e`) that lands ON the seen edge is a
    // fresh entry: mode loop-once, and the plan runs the whole declared
    // pass sequence — entry seek at `startSeconds`, every pass reported,
    // loop-backs at `loopStartSeconds` — so the machine's ended half of
    // the gate is fed on a re-entry exactly as on forward play.
    expect(playbackModeFor(rangeVideo, undefined, false, "nav", 11, 12)).toBe(
      "loop-once",
    );
    expect(videoPlanFor(rangeVideo, "loop-once", true)).toMatchObject({
      reportEnds: 1, // part-012's shape: one 0..1 s pass, reported
      startSeconds: 0,
      endSeconds: 1,
    });
    // part-013's shape: two passes from a restart point inside the range.
    expect(videoPlanFor(loopStartVideo, "loop-once", true)).toMatchObject({
      reportEnds: 2,
      startSeconds: 1, // the fresh-entry seek stays the range start
      loopStartSeconds: 1.5, // loop-backs skip the pre-roll
    });
  });

  it("reports nothing for a video entered by navigation below the edge", () => {
    // Rewound navigation: `playbackModeFor` says "still", the element is
    // paused on the poster at `startSeconds`, and the plan reports no
    // pass — the renderer CANNOT feed the machine's ended condition down
    // here, which is why the machine gates such an entry on its time
    // bound alone instead of freezing (the auto-forward part-012 stall).
    expect(playbackModeFor(rangeVideo, undefined, false, "nav", 11, 27)).toBe(
      "still",
    );
    const plan = videoPlanFor(rangeVideo, "still", true);
    expect(plan.reportEnds).toBe(0);
    expect(plan.startSeconds).toBe(0); // the still holds the entry frame
  });

  it("feeds the ended condition again on an advance below the edge", () => {
    // The same cursor/frontier as above, reached by pressing forward: mode
    // loop-once, so the plan runs its passes and reports them. The machine's
    // gate stays the time bound there — it IS this replay's duration — so
    // auto pacing matches whether or not the element managed to play.
    expect(
      playbackModeFor(rangeVideo, undefined, false, "advance", 11, 27),
    ).toBe("loop-once");
    expect(videoPlanFor(rangeVideo, "loop-once", true)).toMatchObject({
      reportEnds: 1,
      startSeconds: 0,
      endSeconds: 1,
    });
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

describe("empty-state notice (docs/extracting.md BUG 1)", () => {
  it("names the empty manifest as the honest empty-folder case", () => {
    // A validator-clean folder may ship zero items; the shell must then
    // show this notice — no error, nothing that reaches the console.
    expect(emptyStateNoticeText(0)).toBe(
      "No content yet — this folder has an empty manifest.",
    );
  });

  it("distinguishes a folder with items but no drawable visual", () => {
    expect(emptyStateNoticeText(4)).toBe("No content to show.");
  });
});

describe("upcomingVisualFiles (Phase 12 decode preload)", () => {
  const img = (file: string): Item => item({ id: file, type: "image", file });
  const line = (id: string): Item => item({ id, type: "text", text: "x" });

  it("collects image files in array order ahead of the cursor", () => {
    const items = [img("a.jpg"), line("l1"), img("b.jpg"), img("c.jpg")];
    expect(upcomingVisualFiles(items, 0, 3)).toEqual(["b.jpg", "c.jpg"]);
  });

  it("skips text items: they keep an earlier visual, they add none", () => {
    const items = [img("a.jpg"), line("l1"), line("l2"), img("b.jpg")];
    expect(upcomingVisualFiles(items, 0, 1)).toEqual(["b.jpg"]);
  });

  it("counts media items, not files: an animation contributes all frames", () => {
    const anim: Item = item({
      type: "animation",
      frames: ["s.f0.jpg", "s.f1.jpg", "s.f2.jpg"],
      fps: 8,
      loopCount: 2,
    });
    const items = [animation, anim, img("z.jpg")];
    // ahead=1 reaches only `anim`: all three of its frames cycle through
    // the <img> once entered, so every one must be warm — and the cap on
    // `ahead` counts MEDIA items, so the following image is cut off.
    expect(upcomingVisualFiles(items, 0, 1)).toEqual([
      "s.f0.jpg",
      "s.f1.jpg",
      "s.f2.jpg",
    ]);
    expect(upcomingVisualFiles(items, 0, 2)).toEqual([
      "s.f0.jpg",
      "s.f1.jpg",
      "s.f2.jpg",
      "z.jpg",
    ]);
  });

  it("contributes a video's poster only — first paint is the poster", () => {
    const items = [video, img("b.jpg")];
    expect(upcomingVisualFiles(items, -1, 1)).toEqual(["v.jpg"]);
  });

  it("carries a bucket subpath through unchanged — the LRU key is the src", () => {
    // docs/plan.md Phases 17, 25: a media file may live under `media/<bucket>/`.
    // The preload holds the declared path verbatim, so a warm entry and the
    // `<img src>` the renderer later assigns are the same string.
    const bucketVideo = vid({
      file: "media/cd/v.mp4",
      poster: "media/cd/v.jpg",
    });
    const items = [img("media/ab/b.jpg"), bucketVideo];
    expect(upcomingVisualFiles(items, -1, 2)).toEqual([
      "media/ab/b.jpg",
      "media/cd/v.jpg",
    ]);
  });

  it("stops at the array end and at `ahead` media items (v1: array order)", () => {
    const items = [img("a.jpg"), img("b.jpg"), img("c.jpg"), img("d.jpg")];
    expect(upcomingVisualFiles(items, 0, 2)).toEqual(["b.jpg", "c.jpg"]);
    expect(upcomingVisualFiles(items, 3, 3)).toEqual([]);
  });
});

// A stale end event: the machine moves forward INSIDE `onVideoEnded()`
// (machine.mediaEnded() -> moveForward() once the hold has run out), so the
// next item is applied to the reused <video> before the old item's
// boundary code returns. That old code must not then seek or replay the
// element with the old item's plan, nor report more ends for it.
class FakeVideo {
  id = "";
  className = "";
  muted = false;
  playsInline = false;
  preload = "";
  loop = false;
  poster = "";
  src = "";
  isConnected = false;
  currentTime = 0;
  paused = true;
  ended = false;
  style: Record<string, string> = {};
  plays = 0;
  rejectPlays = 0; // how many upcoming play() calls autoplay refuses
  private listeners = new Map<string, Array<() => void>>();
  setAttribute(): void {}
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(): void {}
  remove(): void {
    this.isConnected = false;
  }
  pause(): void {
    this.paused = true;
  }
  play(): Promise<void> {
    this.plays += 1;
    if (this.rejectPlays > 0) {
      this.rejectPlays -= 1;
      return Promise.reject(new Error("NotAllowed"));
    }
    this.paused = false;
    return Promise.resolve();
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  /** Playback reaches the file's end at `t`, as an engine stops there. */
  end(t: number): void {
    this.currentTime = t;
    this.paused = true;
    this.ended = true;
  }
}

function staleEndHarness(first: VideoItem, second: VideoItem, rejectPlays = 0) {
  const videos: FakeVideo[] = [];
  const doc = {
    createElement(tag: string) {
      if (tag === "video") {
        const v = new FakeVideo();
        v.rejectPlays = rejectPlays;
        videos.push(v);
        return v;
      }
      return { style: {}, remove() {} };
    },
  };
  const stage = {
    ownerDocument: doc,
    append(el: { isConnected: boolean }) {
      el.isConnected = true;
    },
  } as unknown as HTMLElement;
  const items = [first, second];
  const manifest = { schemaVersion: 1, items } as unknown as Manifest;
  const reports: number[] = [];
  let cursor = 0;
  const show = (): void => {
    layer.update(items[cursor], {
      cursor,
      frontier: cursor + 1,
      settled: false,
      skipping: false,
      transition: "advance",
    });
  };
  const layer = createVisualLayer(stage, manifest, {
    onVideoEnded() {
      reports.push(cursor);
      // The machine's hold has already run out: the last counted pass
      // moves it forward synchronously, inside this callback.
      const owed = items[cursor].loopCount ?? 1;
      if (reports.filter((c) => c === cursor).length >= owed && cursor === 0) {
        cursor = 1;
        show();
      }
    },
  });
  show();
  const element = videos[0];
  return { element, reports };
}

describe("a stale end event never touches the next item's playback", () => {
  // Both items share one file, so the reused element keeps its source and
  // only the plan changes, as for consecutive ranges of one movie.
  const first = vid({
    id: "v-001",
    startSeconds: 1.0,
    endSeconds: 2.0,
    loopStartSeconds: 1.5,
    loopCount: 2,
  });
  const next = vid({ id: "v-002", startSeconds: 0.25, loopCount: 1 });

  it("file-end boundary: the next item starts at its own start, played once", () => {
    const { element, reports } = staleEndHarness(first, next);
    element.end(2.0);
    element.fire("ended"); // pass 1 of 2: loops back
    expect(element.currentTime).toBe(1.5);
    element.end(2.0);
    const playsBefore = element.plays;
    element.fire("ended"); // pass 2 of 2: machine moves to v-002 inside
    expect(reports).toEqual([0, 0]);
    expect(element.currentTime).toBe(0.25);
    expect(element.plays).toBe(playsBefore + 1); // v-002's own play only
  });

  it("in-file range boundary (timeupdate): the next item is not re-seeked", () => {
    const inFile = vid({
      id: "v-001",
      startSeconds: 0.5,
      endSeconds: 1.0,
      loopStartSeconds: 0.75,
      loopCount: 1,
    });
    const { element, reports } = staleEndHarness(inFile, next);
    element.currentTime = 1.0;
    element.fire("timeupdate"); // the only pass: machine moves to v-002
    expect(reports).toEqual([0]);
    expect(element.currentTime).toBe(0.25);
    expect(element.paused).toBe(false);
  });

  it("autoplay rejection: owed ends stop once the machine has moved on", async () => {
    // Only v-001's play is refused; v-002 plays, so it owes no ends yet.
    const { reports } = staleEndHarness(
      first,
      vid({ id: "v-002", startSeconds: 0.25, loopCount: 3 }),
      1,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toEqual([0, 0]);
  });
});

// Decoding ahead (docs/plan.md Phase 43): WebKit only fetches an off-DOM
// image and decodes it on first paint, on the main thread, so each
// preloaded image is asked to decode up front.
class FakeImage {
  src = "";
  style: Record<string, string> = {};
  remove(): void {}
}

function preloadHarness(
  files: string[],
  decode?: (img: FakeImage) => Promise<void>,
) {
  const images: FakeImage[] = [];
  const doc = {
    createElement() {
      const img = new FakeImage();
      if (decode !== undefined) {
        Object.assign(img, { decode: () => decode(img) });
      }
      images.push(img);
      return img;
    },
  };
  const stage = { ownerDocument: doc, append() {} } as unknown as HTMLElement;
  const items = files.map((file, i) =>
    item({ id: `i-${i}`, type: "image", file }),
  );
  const manifest = { schemaVersion: 1, items } as unknown as Manifest;
  const layer = createVisualLayer(stage, manifest, { onVideoEnded() {} });
  return { layer, images };
}

describe("decoding ahead (Phase 43)", () => {
  it("asks each preloaded image to decode once, after its src is set", () => {
    const decoded: string[] = [];
    const { layer, images } = preloadHarness(["a.jpg", "b.jpg"], (img) => {
      decoded.push(img.src);
      return Promise.resolve();
    });
    layer.preloadUpcoming(-1);
    expect(images.map((img) => img.src)).toEqual(["a.jpg", "b.jpg"]);
    expect(decoded).toEqual(["a.jpg", "b.jpg"]);
    layer.preloadUpcoming(-1); // already warm: an LRU touch, no new decode
    expect(images).toHaveLength(2);
    expect(decoded).toEqual(["a.jpg", "b.jpg"]);
  });

  it("swallows a rejected decode and preloads the rest", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let decodes = 0;
      const { layer, images } = preloadHarness(["a.jpg", "b.jpg"], () => {
        decodes += 1;
        return Promise.reject(new Error("EncodingError"));
      });
      layer.preloadUpcoming(-1);
      expect(decodes).toBe(2);
      expect(images.map((img) => img.src)).toEqual(["a.jpg", "b.jpg"]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("still preloads in an engine whose img has no decode()", () => {
    const { layer, images } = preloadHarness(["a.jpg", "b.jpg"]);
    expect(() => layer.preloadUpcoming(-1)).not.toThrow();
    expect(images.map((img) => img.src)).toEqual(["a.jpg", "b.jpg"]);
  });
});

// One <video> per source file (render/visual.ts, "A fresh <video> per
// source"): a new file gets a new element and the old one is released
// (paused, its src removed and loaded empty, its listeners off, out of the
// DOM); everything within one file (ranges, loop passes, replays, a text
// chain) stays on the same element. Only one is ever in the stage.
class LifeVideo {
  id = "";
  className = "";
  muted = false;
  playsInline = false;
  preload = "";
  loop = false;
  poster = "";
  src = "";
  paused = true;
  // Playback ended at the file's end, as WebKit handles it (2026-11-14):
  // while ended, a seek is pending until `land()`, and play() queues its
  // own restart from 0, which lands last whatever the order of the two.
  ended = false;
  seeking = false;
  duration = Number.NaN;
  private time = 0;
  private restartFromZero = false;
  get currentTime(): number {
    return this.time;
  }
  set currentTime(seconds: number) {
    this.time = seconds;
    if (this.ended) this.seeking = true;
  }
  /** Playback reaches the file's end at `t`, as an engine stops there. */
  end(t: number): void {
    this.time = t;
    this.paused = true;
    this.ended = true;
  }
  /** The pending seek lands: `seeked`, the video no longer ended. */
  land(): void {
    if (this.restartFromZero) this.time = 0;
    this.restartFromZero = false;
    this.ended = false;
    this.seeking = false;
    this.fire("seeked");
  }
  plays = 0;
  loads = 0;
  style: Record<string, string> = {};
  stage: LifeStage | null = null;
  private listeners = new Map<string, Array<() => void>>();
  get isConnected(): boolean {
    return this.stage?.children.includes(this) ?? false;
  }
  setAttribute(): void {}
  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }
  load(): void {
    this.loads += 1;
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((f) => f !== fn),
    );
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce((n, fns) => n + fns.length, 0);
  }
  remove(): void {
    if (this.stage === null) return;
    this.stage.children = this.stage.children.filter((c) => c !== this);
  }
  pause(): void {
    this.paused = true;
  }
  play(): Promise<void> {
    this.plays += 1;
    if (this.ended) {
      this.restartFromZero = true;
      this.seeking = true;
    }
    this.paused = false;
    return Promise.resolve();
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

interface LifeStage {
  children: unknown[];
}

function lifecycleHarness<V extends LifeVideo = LifeVideo>(
  items: Item[],
  make: () => V = () => new LifeVideo() as V,
) {
  const videos: V[] = [];
  const stage: LifeStage & {
    ownerDocument: unknown;
    append(el: { stage?: LifeStage | null }): void;
  } = {
    children: [],
    ownerDocument: {
      createElement(tag: string) {
        if (tag === "video") {
          const v = make();
          videos.push(v);
          return v;
        }
        return { style: {}, remove() {} };
      },
    },
    append(el) {
      if ("stage" in el) el.stage = stage;
      stage.children.push(el);
    },
  };
  const manifest = { schemaVersion: 1, items } as unknown as Manifest;
  const ends: number[] = [];
  let cursor = 0;
  const layer = createVisualLayer(stage as unknown as HTMLElement, manifest, {
    onVideoEnded() {
      ends.push(cursor);
    },
  });
  // Show item `index` as an advance onto it (it plays), or as a nav
  // arrival below the frontier (a still); `segment`, the active segment's
  // index into the visual item's `segments` (docs/plan.md Phase 49).
  const show = (
    index: number,
    transition: "advance" | "nav" = "advance",
    segment?: number,
  ) => {
    cursor = index;
    let visual = index;
    while (items[visual].type === "text") visual -= 1;
    const shown = items[visual];
    const count = shown.type === "video" ? (shown.segments?.length ?? 0) : 0;
    layer.update(items[visual], {
      cursor: index,
      frontier: transition === "nav" ? items.length : index + 1,
      settled: false,
      skipping: false,
      transition,
      ...(segment === undefined ? {} : { segment: { index: segment, count } }),
    } as never);
  };
  const inStage = () => stage.children.filter((c) => c instanceof LifeVideo);
  return { layer, videos, show, inStage, ends };
}

describe("a fresh <video> per source file", () => {
  it("a new file gets a new element; the old one is released and removed", () => {
    const { videos, show, inStage } = lifecycleHarness([
      vid({ id: "v-a", file: "a.mp4", poster: "a.jpg" }),
      vid({ id: "v-b", file: "b.webm", poster: "b.jpg" }),
    ]);
    show(0);
    show(1);
    expect(videos).toHaveLength(2);
    const [old, current] = videos;
    expect(old.paused).toBe(true);
    expect(old.src).toBe("");
    expect(old.loads).toBe(1);
    expect(old.listenerCount()).toBe(0);
    expect(old.isConnected).toBe(false);
    expect(current.src).toBe("b.webm");
    expect(current.poster).toBe("b.jpg");
    expect(current.style.backgroundImage).toBe('url("b.jpg")');
    expect(current.id).toBe("visual-video");
    expect(inStage()).toEqual([current]);
  });

  it("ranges of one file, their loop passes and a replay stay on one element", () => {
    const { videos, show, inStage, ends } = lifecycleHarness([
      vid({
        id: "r-a",
        file: "r.mp4",
        startSeconds: 0,
        endSeconds: 2,
        loopCount: 2,
      }),
      vid({ id: "r-b", file: "r.mp4", startSeconds: 2, endSeconds: 4 }),
      item({ id: "after", type: "image", file: "p.jpg" }),
    ]);
    show(0);
    const element = videos[0];
    element.end(2);
    element.fire("ended"); // pass 1 of 2: loops back on the same element
    expect(ends).toEqual([0]);
    show(1); // the next range of the same file
    expect(element.currentTime).toBe(2);
    show(0, "nav"); // the wheel back onto the first range: its still
    show(0); // and Space again: a replay
    expect(videos).toHaveLength(1);
    expect(element.loads).toBe(0);
    expect(element.src).toBe("r.mp4");
    expect(inStage()).toEqual([element]);
  });

  it("a text chain over one video stays on one element", () => {
    const { videos, show } = lifecycleHarness([
      vid({ id: "v-a", file: "a.mp4" }),
      item({ id: "line-2", type: "text", text: "Second line." }),
      item({ id: "line-3", type: "text", text: "Third line." }),
    ]);
    show(0);
    show(1);
    show(2);
    expect(videos).toHaveLength(1);
    expect(videos[0].loop).toBe(false); // the player loops it (Phase 50)
    expect(videos[0].loads).toBe(0);
  });

  it("a picture between two videos: one element in the stage, the old one released", () => {
    const { videos, show, inStage } = lifecycleHarness([
      vid({ id: "v-a", file: "a.mp4" }),
      item({ id: "pic", type: "image", file: "p.jpg" }),
      vid({ id: "v-b", file: "b.mp4" }),
      vid({ id: "v-c", file: "c.mp4" }),
    ]);
    for (let i = 0; i < 4; i += 1) show(i);
    expect(videos).toHaveLength(3);
    expect(
      videos.slice(0, 2).every((v) => !v.isConnected && v.src === ""),
    ).toBe(true);
    expect(inStage()).toEqual([videos[2]]);
  });

  it("a released element's late ended reports nothing; hold and capture use the new one", () => {
    const { layer, videos, show, ends } = lifecycleHarness([
      vid({ id: "v-a", file: "a.mp4" }),
      vid({ id: "v-b", file: "b.mp4" }),
    ]);
    show(0);
    show(1);
    videos[0].fire("ended");
    expect(ends).toEqual([]);
    expect(layer.currentVisual()).toBe(
      videos[1] as unknown as HTMLVideoElement,
    );
    layer.setPaused(true);
    expect(videos[1].paused).toBe(true);
    const plays = videos[1].plays;
    layer.setPaused(false);
    expect(videos[1].plays).toBe(plays + 1);
    videos[1].end(2);
    videos[1].fire("ended");
    expect(ends).toEqual([1]);
  });

  it("tells its watcher the stage's video and whether it plays (Phase 47 item 6)", () => {
    const { layer, videos, show } = lifecycleHarness([
      vid({ id: "v-a", file: "a.mp4" }),
      item({ id: "line-2", type: "text", text: "Second line." }),
      item({ id: "pic", type: "image", file: "p.jpg" }),
      vid({ id: "v-b", file: "b.mp4" }),
    ]);
    const heard: Array<{ element: unknown; plays: boolean } | null> = [];
    layer.watchVideo((video) =>
      heard.push(
        video === null ? null : { element: video.element, plays: video.plays },
      ),
    );
    expect(heard).toEqual([null]); // told at once: no video yet
    show(0); // an advance: it plays
    show(1); // the text chain over it: the same element plays on, unchanged
    show(0, "nav"); // the wheel back below the seen edge: its poster
    show(2); // a picture: no video
    show(3); // a new file: a fresh element, playing
    const [a, b] = videos;
    expect(heard).toEqual([
      null,
      { element: a, plays: true },
      { element: a, plays: false },
      null,
      { element: b, plays: true },
    ]);
    layer.destroy();
    expect(heard[heard.length - 1]).toBeNull();
  });

  it("a watcher set while a video plays hears it at once", () => {
    const { layer, videos, show } = lifecycleHarness([
      vid({ id: "v-a", file: "a.mp4" }),
    ]);
    show(0);
    const heard: unknown[] = [];
    layer.watchVideo((video) =>
      heard.push({ element: video?.element, plays: video?.plays }),
    );
    expect(heard).toEqual([{ element: videos[0], plays: true }]);
  });

  it("tells its watcher where the pass under way ends and where it restarts, if it wraps (Phase 47 item 15)", () => {
    const { layer, videos, show } = lifecycleHarness([
      vid({ id: "v-two", file: "t.mp4", durationSeconds: 3, loopCount: 2 }),
      vid({
        id: "v-range",
        file: "r.mp4",
        durationSeconds: 8,
        startSeconds: 2,
        endSeconds: 6,
        loopStartSeconds: 4,
      }),
      item({ id: "line-2", type: "text", text: "Second line." }),
      vid({ id: "v-loop", file: "l.mp4", durationSeconds: 5, holdSeconds: 9 }),
    ]);
    let pass: (() => unknown) | null = null;
    layer.watchVideo((video) => {
      pass = video === null ? null : () => video.pass();
    });
    const now = () => (pass === null ? "none" : pass());
    show(0); // two passes: the first wraps to its start, the last holds
    expect(now()).toEqual({ end: 3, restart: 0 });
    videos[0].end(3);
    videos[0].fire("ended");
    videos[0].land();
    expect(now()).toEqual({ end: 3, restart: null });
    show(1); // under a text chain: it loops from its restart point
    expect(now()).toEqual({ end: 6, restart: 4 });
    show(2);
    expect(now()).toEqual({ end: 6, restart: 4 });
    show(3); // background: the element's own loop, from 0
    expect(now()).toEqual({ end: 5, restart: 0 });
    show(1, "nav"); // a poster: no pass
    expect(now()).toBeNull();
  });

  it("ends the pass under way early when its sound asks, reporting a counted pass, and plays on from its restart point; nothing on the last pass, held, or once the video is gone (Phase 47 item 19)", () => {
    const { layer, videos, show, ends } = lifecycleHarness([
      vid({ id: "v-three", file: "t.mp4", durationSeconds: 3, loopCount: 3 }),
      item({ id: "pic", type: "image", file: "p.jpg" }),
      vid({
        id: "v-range",
        file: "r.mp4",
        durationSeconds: 8,
        startSeconds: 2,
        endSeconds: 6,
        loopStartSeconds: 4,
      }),
      item({ id: "line-2", type: "text", text: "Second line." }),
      vid({ id: "v-loop", file: "l.mp4", durationSeconds: 5, holdSeconds: 9 }),
    ]);
    let stage: StageVideo | null = null;
    layer.watchVideo((video) => {
      stage = video;
    });
    const restart = () => (stage as StageVideo | null)?.restart();
    show(0);
    const three = videos[0];
    three.currentTime = 2.96;
    restart(); // the first of three passes: reported, back to its start
    expect(ends).toEqual([0]);
    expect(three.currentTime).toBe(0);
    expect(three.paused).toBe(false);
    three.currentTime = 2.97;
    restart();
    expect(ends).toEqual([0, 0]);
    expect(three.currentTime).toBe(0);
    three.currentTime = 2.98;
    restart(); // the last pass holds at its end: its own end reports it
    expect(ends).toEqual([0, 0]);
    expect(three.currentTime).toBe(2.98);
    // Under a text chain: back to its loop point, nothing reported.
    show(2);
    const range = videos[1];
    range.currentTime = 5.97;
    restart();
    expect(range.currentTime).toBe(4);
    expect(ends).toEqual([0, 0]);
    // Held by a menu: nothing.
    layer.setPaused(true);
    range.currentTime = 5.97;
    restart();
    expect(range.currentTime).toBe(5.97);
    layer.setPaused(false);
    // A background video's own loop restarts at 0.
    show(4);
    const looped = videos[2];
    looped.currentTime = 4.97;
    restart();
    expect(looped.currentTime).toBe(0);
    // A stage gone: its old restart does nothing.
    const gone = stage as StageVideo | null;
    show(1);
    looped.currentTime = 4.97;
    gone?.restart();
    expect(looped.currentTime).toBe(4.97);
  });

  it("asks how long a start from paused waits and plays only then; a wrap, a menu or a new item never plays early (Phase 47 item 15)", () => {
    vi.useFakeTimers();
    try {
      const { layer, videos, show } = lifecycleHarness([
        vid({
          id: "v-a",
          file: "a.mp4",
          durationSeconds: 2,
          startSeconds: 0.5,
        }),
        item({ id: "line-2", type: "text", text: "Second line." }),
        item({ id: "pic", type: "image", file: "p.jpg" }),
      ]);
      const asked: number[] = [];
      layer.setStartDelay((element) => {
        asked.push((element as unknown as LifeVideo).plays);
        return 300;
      });
      show(1); // onto the chain: an entry, asked before any play
      const v = videos[0];
      expect(asked).toEqual([0]);
      expect(v.plays).toBe(0);
      vi.advanceTimersByTime(299);
      expect(v.plays).toBe(0);
      vi.advanceTimersByTime(1);
      expect(v.plays).toBe(1);
      // A wrap plays again at once, unasked.
      v.end(2);
      v.fire("ended");
      v.land();
      expect(v.plays).toBe(2);
      expect(asked).toHaveLength(1);
      // A menu: the resume asks again; a menu opened during the wait wins.
      layer.setPaused(true);
      layer.setPaused(false);
      expect(asked).toHaveLength(2);
      layer.setPaused(true);
      vi.advanceTimersByTime(1000);
      expect(v.plays).toBe(2);
      layer.setPaused(false);
      vi.advanceTimersByTime(300);
      expect(v.plays).toBe(3);
      // Leaving during the wait plays nothing.
      layer.setPaused(true);
      layer.setPaused(false);
      show(2);
      vi.advanceTimersByTime(1000);
      expect(v.plays).toBe(3);
      // No delay given: it plays at once.
      layer.setStartDelay(null);
      show(1);
      expect(videos[videos.length - 1].plays).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroy releases the element", () => {
    const { layer, videos, show, inStage } = lifecycleHarness([
      vid({ id: "v-a", file: "a.mp4" }),
    ]);
    show(0);
    layer.destroy();
    expect(videos[0].src).toBe("");
    expect(videos[0].listenerCount()).toBe(0);
    expect(inStage()).toEqual([]);
  });
});

// Video segments (docs/plan.md Phase 49, docs/content-format.md "Video
// segments"): the active segment replaces the item's own range on the
// stage: one seek to its start, then a loop of loopStart..end, no pass
// reported, until the next step; leaving, re-entering or the machine
// clearing it plays the item's own range again.
describe("video segments", () => {
  const segments = [
    { startSeconds: 0, endSeconds: 2 },
    { startSeconds: 2, loopStartSeconds: 2.5, endSeconds: 4 },
    { startSeconds: 4, endSeconds: 6 },
  ];
  // The item plays 2..5 of a 6 s file, looping back to 3 under its lines:
  // the first segment lies before its range and the last past it, to the
  // file's end.
  const segVideo = vid({
    id: "v-seg",
    file: "s.mp4",
    durationSeconds: 6,
    startSeconds: 2,
    endSeconds: 5,
    loopStartSeconds: 3,
    segments,
  });

  describe("videoPlanFor with a segment", () => {
    it("plays the segment: its start, its loop restart (default its start) and its end, nothing reported", () => {
      expect(videoPlanFor(segVideo, "loop-forever", true, segments[1])).toEqual(
        {
          reportEnds: 0,
          startSeconds: 2,
          loopStartSeconds: 2.5,
          endSeconds: 4,
          boundary: "rvfc",
        },
      );
      expect(
        videoPlanFor(segVideo, "loop-forever", false, segments[0]),
      ).toEqual({
        reportEnds: 0,
        startSeconds: 0,
        loopStartSeconds: 0,
        endSeconds: 2,
        boundary: "timeupdate",
      });
    });

    it("bounds a segment ending at the file's end by the file's own end", () => {
      expect(
        videoPlanFor(segVideo, "loop-forever", true, segments[2]),
      ).toMatchObject({
        startSeconds: 4,
        loopStartSeconds: 4,
        endSeconds: 6,
        boundary: "fileEnd",
      });
    });

    it("counts no passes and never loops natively, whatever the item's own passes", () => {
      // A standalone counted video and a background one (whose own plan
      // loops natively): the segment loops on the renderer's seeks.
      const counted = vid({ loopCount: 3, segments });
      expect(
        videoPlanFor(counted, "loop-once", true, segments[1]),
      ).toMatchObject({ reportEnds: 0, endSeconds: 4 });
      const background = vid({ holdSeconds: 9, segments });
      expect(
        videoPlanFor(background, "loop-once", true, segments[0]),
      ).toMatchObject({ reportEnds: 0, endSeconds: 2 });
    });

    it("leaves a still at the item's own start", () => {
      expect(videoPlanFor(segVideo, "still", true, segments[2])).toEqual(
        videoPlanFor(segVideo, "still", true),
      );
    });
  });

  // A chain over the segment video, then a picture.
  const chain = (): Item[] => [
    segVideo,
    item({ id: "line-2", type: "text", text: "Second line." }),
    item({ id: "pic", type: "image", file: "p.jpg" }),
  ];

  it("seeks once to the segment's start, plays to its end, then loops its loopStart..end, reporting nothing", () => {
    const { videos, show, ends } = lifecycleHarness(chain());
    show(1); // the chain's last line: the item's own range plays
    const v = videos[0];
    expect(v.currentTime).toBe(2);
    v.currentTime = 4.2; // wherever the loop has got to
    show(1, "advance", 1); // a step to the second segment
    expect(v.currentTime).toBe(2);
    expect(v.paused).toBe(false);
    v.currentTime = 3.5;
    v.fire("timeupdate"); // inside the segment: nothing
    expect(v.currentTime).toBe(3.5);
    v.currentTime = 4;
    v.fire("timeupdate"); // its end: back to its loop restart
    expect(v.currentTime).toBe(2.5);
    v.currentTime = 4.01;
    v.fire("timeupdate");
    expect(v.currentTime).toBe(2.5);
    // The item's own end (5) is not this pass's end.
    expect(ends).toEqual([]);
    // The same state again (a re-render): no second seek.
    v.currentTime = 3.1;
    show(1, "advance", 1);
    expect(v.currentTime).toBe(3.1);
    // The next step: one seek to its start.
    show(1, "advance", 2);
    expect(v.currentTime).toBe(4);
    expect(videos).toHaveLength(1);
  });

  it("plays a segment before the item's range, and one ending at the file's end loops on its ended", () => {
    const { videos, show, ends } = lifecycleHarness(chain());
    show(1);
    const v = videos[0];
    show(1, "advance", 0);
    expect(v.currentTime).toBe(0);
    v.currentTime = 2; // its end, below the item's own start
    v.fire("timeupdate");
    expect(v.currentTime).toBe(0);
    show(1, "advance", 2);
    expect(v.currentTime).toBe(4);
    v.currentTime = 5.2; // past the item's own end: plays on
    v.fire("timeupdate");
    expect(v.currentTime).toBe(5.2);
    v.end(6);
    v.fire("ended"); // the file's end: back to the segment's start, playing
    v.land();
    expect(v.currentTime).toBe(4);
    expect(v.paused).toBe(false);
    expect(ends).toEqual([]);
  });

  it("a standalone counted video steps from its held end: it plays the segment, and its loop reports nothing", () => {
    const { videos, show, ends } = lifecycleHarness([
      vid({ id: "v-alone", file: "a.mp4", durationSeconds: 6, segments }),
      item({ id: "pic", type: "image", file: "p.jpg" }),
    ]);
    show(0);
    const v = videos[0];
    // Its one pass, reported, held at its end; `ended` left unset, so the
    // step's seek and play below land at once (a step from a held end of
    // the file is not modelled here).
    v.duration = 6;
    v.currentTime = 6;
    v.paused = true;
    v.fire("ended");
    expect(ends).toEqual([0]);
    const plays = v.plays;
    show(0, "advance", 1);
    expect(v.currentTime).toBe(2);
    expect(v.plays).toBe(plays + 1);
    v.currentTime = 4;
    v.fire("timeupdate");
    expect(v.currentTime).toBe(2.5);
    show(0, "advance", 2);
    v.end(6);
    v.fire("ended");
    v.land();
    expect(v.currentTime).toBe(4);
    expect(v.paused).toBe(false);
    expect(ends).toEqual([0]);
  });

  it("tells its watcher of each step; the pass reports the segment's end and restart point", () => {
    const { layer, videos, show } = lifecycleHarness(chain());
    let stage: StageVideo | null = null;
    const heard: Array<StageVideo | null> = [];
    layer.watchVideo((video) => {
      stage = video;
      heard.push(video);
    });
    const pass = () => (stage as StageVideo | null)?.pass() ?? null;
    show(1);
    expect(pass()).toEqual({ end: 5, restart: 3 });
    const before = heard.length;
    show(1, "advance", 1);
    expect(heard.length).toBe(before + 1);
    expect(heard[heard.length - 1]?.element).toBe(videos[0]);
    expect(heard[heard.length - 1]?.plays).toBe(true);
    expect(pass()).toEqual({ end: 4, restart: 2.5 });
    show(1, "advance", 1); // nothing changed: nothing heard
    expect(heard.length).toBe(before + 1);
    show(1, "advance", 0);
    expect(heard.length).toBe(before + 2);
    expect(pass()).toEqual({ end: 2, restart: 0 });
    // Its sound's early restart lands on the segment's loop restart.
    videos[0].currentTime = 1.97;
    (stage as StageVideo | null)?.restart();
    expect(videos[0].currentTime).toBe(0);
  });

  it("the machine clearing the segment, leaving or re-entering plays the item's own range again", () => {
    const { videos, show, layer } = lifecycleHarness(chain());
    let stage: StageVideo | null = null;
    layer.watchVideo((video) => {
      stage = video;
    });
    const pass = () => (stage as StageVideo | null)?.pass() ?? null;
    show(1);
    const v = videos[0];
    show(1, "advance", 2);
    expect(v.currentTime).toBe(4);
    // Cleared with the cursor where it is (an arrival on the same item).
    show(1);
    expect(v.currentTime).toBe(2);
    expect(pass()).toEqual({ end: 5, restart: 3 });
    v.currentTime = 5;
    v.fire("timeupdate"); // the item's own end: back to its loop point
    expect(v.currentTime).toBe(3);
    // The wheel back onto the item (its poster) and forward again.
    show(1, "advance", 1);
    show(0, "nav");
    expect(pass()).toBeNull();
    expect(v.currentTime).toBe(2);
    show(1);
    expect(pass()).toEqual({ end: 5, restart: 3 });
    // Leaving for the picture and coming back by an advance.
    show(1, "advance", 2);
    show(2);
    show(1);
    expect(stage).not.toBeNull();
    expect(pass()).toEqual({ end: 5, restart: 3 });
    expect(videos[videos.length - 1]?.currentTime).toBe(2);
  });

  it("a menu's pause and resume keep the segment: it resumes where it stood, inside the segment's loop", () => {
    const { layer, videos, show } = lifecycleHarness(chain());
    let stage: StageVideo | null = null;
    layer.watchVideo((video) => {
      stage = video;
    });
    show(1);
    const v = videos[0];
    show(1, "advance", 1);
    v.currentTime = 3.3;
    layer.setPaused(true);
    expect(v.paused).toBe(true);
    layer.setPaused(false);
    expect(v.paused).toBe(false);
    expect(v.currentTime).toBe(3.3);
    expect((stage as StageVideo | null)?.pass()).toEqual({
      end: 4,
      restart: 2.5,
    });
    v.currentTime = 4;
    v.fire("timeupdate");
    expect(v.currentTime).toBe(2.5);
  });

  it("gives the machine the video's time while the stage plays that item's video, a held one included; null for a still, another item or none", () => {
    const { layer, videos, show } = lifecycleHarness(chain());
    const items = chain();
    expect(layer.videoTime(items[0])).toBeNull(); // nothing shown yet
    show(1);
    videos[0].currentTime = 3.25;
    expect(layer.videoTime(items[0])).toBe(3.25);
    expect(layer.videoTime(items[2])).toBeNull();
    expect(layer.videoTime(undefined)).toBeNull();
    layer.setPaused(true); // a menu holds it: it counts as playing
    expect(layer.videoTime(items[0])).toBe(3.25);
    layer.setPaused(false);
    show(0, "nav"); // its poster below the seen edge
    expect(layer.videoTime(items[0])).toBeNull();
    show(2); // a picture
    expect(layer.videoTime(items[0])).toBeNull();
  });
});

// WebKit, 2026-11-14: at the file's `ended`, play() restarts the video from
// 0, and a seek asked for just before or just after it does not reliably
// win (the segments scenario's held WebM played on from 0, 4 runs in 8
// with the seek first, 1 in 5 with it after). Every loop-back at the
// file's end seeks, and plays once the seek has landed.
describe("a loop-back at the file's end lands on its restart point, not 0", () => {
  const endAt = (v: LifeVideo, t: number): void => {
    v.end(t);
    v.fire("ended");
  };

  it("a segment ending at the file's end, on a background video", () => {
    const { videos, show } = lifecycleHarness([
      vid({
        id: "v-hold",
        file: "h.webm",
        durationSeconds: 2,
        holdSeconds: 4,
        segments: [
          { startSeconds: 0, endSeconds: 0.8 },
          { startSeconds: 1, endSeconds: 2 },
        ],
      }),
      item({ id: "pic", type: "image", file: "p.jpg" }),
    ]);
    show(0);
    const v = videos[0];
    show(0, "advance", 1);
    const plays = v.plays;
    endAt(v, 2);
    expect(v.plays).toBe(plays); // not before the seek lands
    v.land();
    expect(v.currentTime).toBe(1);
    expect(v.paused).toBe(false);
    expect(v.plays).toBe(plays + 1);
  });

  it("a counted pass and a chain's range, each ending at the file's end", () => {
    const { videos, show, ends } = lifecycleHarness([
      vid({
        id: "v-count",
        file: "c.mp4",
        durationSeconds: 2,
        startSeconds: 1,
        loopStartSeconds: 1.5,
        loopCount: 2,
      }),
      vid({
        id: "v-chain",
        file: "r.mp4",
        durationSeconds: 8,
        startSeconds: 2,
        loopStartSeconds: 4,
      }),
      item({ id: "line-2", type: "text", text: "Second line." }),
    ]);
    show(0);
    endAt(videos[0], 2); // pass 1 of 2: back to 1.5
    videos[0].land();
    expect(ends).toEqual([0]);
    expect(videos[0].currentTime).toBe(1.5);
    expect(videos[0].paused).toBe(false);
    show(2);
    endAt(videos[1], 8); // under its line: back to 4
    videos[1].land();
    expect(videos[1].currentTime).toBe(4);
    expect(videos[1].paused).toBe(false);
  });

  // Phase 50 item 4: Left from a counted video held at its file's end steps
  // to a segment; WebKit played the ended element on from 0 in 3 runs of
  // 28 when it was played before the step's seek landed.
  it("a step from a counted video held at its file's end plays the segment once its seek lands, its start asked then", () => {
    const { layer, videos, show, ends } = lifecycleHarness([
      vid({
        id: "v-alone",
        file: "a.mkv",
        durationSeconds: 6,
        startSeconds: 4.5,
        loopCount: 1,
        segments: [
          { startSeconds: 1, endSeconds: 2.5 },
          { startSeconds: 3, loopStartSeconds: 3.5, endSeconds: 4.5 },
        ],
      }),
      item({ id: "pic", type: "image", file: "p.jpg" }),
    ]);
    const asked: Array<{ seeking: boolean; time: number }> = [];
    layer.setStartDelay((element) => {
      asked.push({ seeking: element.seeking, time: element.currentTime });
      return 0;
    });
    show(0);
    const v = videos[0];
    v.duration = 6;
    endAt(v, 6); // its one pass: reported, held at the end
    expect(ends).toEqual([0]);
    expect(v.paused).toBe(true);
    const plays = v.plays;
    asked.length = 0;
    show(0, "advance", 1); // Left: the last segment
    expect(v.seeking).toBe(true);
    expect(v.plays).toBe(plays); // not before the seek lands
    expect(asked).toEqual([]);
    v.land();
    expect(v.currentTime).toBe(3);
    expect(v.paused).toBe(false);
    expect(v.plays).toBe(plays + 1);
    expect(asked).toEqual([{ seeking: false, time: 3 }]);
    // The segment then loops from its loop start, reporting nothing more.
    v.currentTime = 4.5;
    v.fire("timeupdate");
    expect(v.currentTime).toBe(3.5);
    expect(ends).toEqual([0]);
  });

  it("a step on an ended element plays nothing once its seek lands if a menu holds it or the reader left", () => {
    const items: Item[] = [
      vid({
        id: "v-alone",
        file: "a.mkv",
        durationSeconds: 6,
        startSeconds: 4.5,
        loopCount: 1,
        segments: [{ startSeconds: 1, endSeconds: 2.5 }],
      }),
      item({ id: "pic", type: "image", file: "p.jpg" }),
    ];
    const { layer, videos, show } = lifecycleHarness(items);
    show(0);
    const v = videos[0];
    endAt(v, 6);
    show(0, "advance", 0);
    layer.setPaused(true);
    const held = v.plays;
    v.land();
    expect(v.plays).toBe(held);
    expect(v.paused).toBe(true);
    layer.setPaused(false); // the menu's resume plays it, from the segment
    expect(v.paused).toBe(false);
    expect(v.currentTime).toBe(1);
    // Ended again, stepped back to the item's own range, then left.
    endAt(v, 6);
    show(0);
    show(1);
    const gone = v.plays;
    v.land();
    expect(v.plays).toBe(gone);
  });

  it("plays nothing once the seek lands if the reader left, a menu holds it, or a step re-planned it", () => {
    const { layer, videos, show } = lifecycleHarness([
      vid({
        id: "v-hold",
        file: "h.webm",
        durationSeconds: 2,
        holdSeconds: 4,
        segments: [
          { startSeconds: 0, endSeconds: 1 },
          { startSeconds: 1, endSeconds: 2 },
        ],
      }),
      item({ id: "pic", type: "image", file: "p.jpg" }),
    ]);
    show(0);
    const v = videos[0];
    show(0, "advance", 1);
    endAt(v, 2);
    layer.setPaused(true);
    const held = v.plays;
    v.land();
    expect(v.plays).toBe(held);
    layer.setPaused(false); // the menu's resume plays it
    expect(v.paused).toBe(false);
    endAt(v, 2);
    show(1); // left for the picture
    const gone = v.plays;
    v.land();
    expect(v.plays).toBe(gone);
  });
});

// Loops at a file's end (docs/plan.md Phase 50). WebKit sends `pause` and
// `ended` only at a Matroska or WebM file's first end; at every later end
// only its periodic `timeupdate` comes (currentTime at the duration, `ended`
// true, `paused` false) and the video holds on its last frame, the
// element's own `loop` included. The file's end is whichever comes first
// of the frame callback presenting the last frame (plus one frame
// interval), a `timeupdate` at the end while it plays on and the native
// `ended`; each end is handled once, and one seen while seeking or before
// the end is ignored.
class FrameVideo extends LifeVideo {
  private frameCallbacks = new Map<
    number,
    (now: number, meta: VideoFrameCallbackMetadata) => void
  >();
  private nextHandle = 1;
  constructor() {
    super();
    this.duration = 6;
  }
  requestVideoFrameCallback(
    cb: (now: number, meta: VideoFrameCallbackMetadata) => void,
  ): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.frameCallbacks.set(handle, cb);
    return handle;
  }
  cancelVideoFrameCallback(handle: number): void {
    this.frameCallbacks.delete(handle);
  }
  /** The frame at `mediaTime` is presented: the time moves there. */
  present(mediaTime: number): void {
    this.currentTime = mediaTime;
    const due = [...this.frameCallbacks.values()];
    this.frameCallbacks.clear();
    for (const cb of due) {
      cb(0, { mediaTime } as VideoFrameCallbackMetadata);
    }
  }
  /** Frames from `from` to `to` (inclusive) at 25 fps. */
  run(from: number, to: number): void {
    for (let t = from; t <= to + 1e-9; t += 0.04) {
      this.present(Math.round(t * 100) / 100);
    }
  }
}

describe("a pass ending at the file's end loops back at every end (Phase 50)", () => {
  // 6 s at 25 fps: the last frame starts at 5.96.
  const clip = (fields: Partial<VideoItem>) =>
    vid({ id: "v-end", file: "e.mkv", durationSeconds: 6, ...fields });
  const line = item({ id: "line-2", type: "text", text: "A line." });
  /** WebKit's later ends: the time at the duration, still playing. */
  const stuckAtEnd = (v: LifeVideo): void => {
    v.end(6);
    v.paused = false;
  };

  it("no plan loops the element natively: a chain or background with no range loops from its loop start", () => {
    for (const [it, mode] of [
      [video, "loop-forever"],
      [holdVideo, "loop-once"],
    ] as const) {
      expect(videoPlanFor(it, mode, true)).toEqual({
        reportEnds: 0,
        startSeconds: 0,
        loopStartSeconds: 0,
        endSeconds: null,
        boundary: "fileEnd",
      });
    }
    // A loop start with no range is the loop's restart point too, as it
    // is for a counted video's passes.
    expect(
      videoPlanFor(vid({ loopStartSeconds: 0.5 }), "loop-forever", true)
        .loopStartSeconds,
    ).toBe(0.5);
  });

  it("wraps at every end WebKit leaves playing with only a timeupdate, the element's loop off", () => {
    const { videos, show, layer } = lifecycleHarness([clip({}), line]);
    let stage: StageVideo | null = null;
    layer.watchVideo((v) => {
      stage = v;
    });
    show(1);
    const v = videos[0];
    expect(v.loop).toBe(false);
    expect((stage as StageVideo | null)?.pass()).toEqual({
      end: 6,
      restart: 0,
    });
    for (let end = 0; end < 3; end += 1) {
      stuckAtEnd(v);
      v.fire("timeupdate");
      expect(v.currentTime).toBe(0);
      v.land();
      expect(v.paused).toBe(false);
      v.currentTime = 3;
      v.fire("timeupdate"); // mid-file: nothing
      expect(v.currentTime).toBe(3);
    }
  });

  it("a timeupdate at the end of a paused element leaves the end to its ended, which follows it", () => {
    // The engine stops there and sends pause and ended in the same task:
    // the video's sound reads that pause as the wrap's while the element
    // is still ended.
    const { videos, show } = lifecycleHarness([
      clip({ startSeconds: 1, loopStartSeconds: 4 }),
      line,
    ]);
    show(1);
    const v = videos[0];
    v.end(6);
    v.fire("timeupdate");
    expect(v.currentTime).toBe(6);
    v.fire("ended");
    expect(v.currentTime).toBe(4);
  });

  it("counts each end once whichever signals arrive, in any order; the last pass holds paused at the end", () => {
    const { videos, show, ends } = lifecycleHarness([
      clip({ startSeconds: 1, loopStartSeconds: 4, loopCount: 3 }),
      item({ id: "pic", type: "image", file: "p.jpg" }),
    ]);
    show(0);
    const v = videos[0];
    // End 1 (WebKit's first end): ended, then the same end's timeupdate.
    v.end(6);
    v.fire("ended");
    expect(ends).toEqual([0]);
    expect(v.currentTime).toBe(4);
    expect(v.seeking).toBe(true);
    v.fire("timeupdate"); // seeking: the end is behind it
    v.fire("ended");
    v.land();
    v.fire("ended"); // a late ended below the duration (Chrome)
    expect(ends).toEqual([0]);
    expect(v.paused).toBe(false);
    // End 2 (WebKit's later ends): a timeupdate while it plays on.
    stuckAtEnd(v);
    v.fire("timeupdate");
    v.fire("timeupdate");
    expect(ends).toEqual([0, 0]);
    v.fire("ended");
    v.land();
    expect(ends).toEqual([0, 0]);
    // End 3, the last: held at the end, paused, whatever comes after.
    stuckAtEnd(v);
    v.fire("timeupdate");
    expect(ends).toEqual([0, 0, 0]);
    expect(v.paused).toBe(true);
    expect(v.currentTime).toBe(6);
    v.fire("ended");
    v.fire("timeupdate");
    expect(ends).toEqual([0, 0, 0]);
  });

  it("an end signal while seeking or before the end is ignored", () => {
    const { videos, show, ends } = lifecycleHarness([
      clip({ loopCount: 2 }),
      item({ id: "pic", type: "image", file: "p.jpg" }),
    ]);
    show(0);
    const v = videos[0];
    v.currentTime = 5.9;
    v.fire("ended");
    v.fire("timeupdate");
    v.currentTime = 6;
    v.seeking = true;
    v.fire("ended");
    v.fire("timeupdate");
    expect(ends).toEqual([]);
    expect(v.currentTime).toBe(6);
  });

  it("the last frame presented plus one frame interval ends the pass, unless a seek, a menu or a new plan came first", () => {
    vi.useFakeTimers();
    try {
      const { videos, show, ends, layer } = lifecycleHarness(
        [
          clip({ startSeconds: 1, loopStartSeconds: 4, loopCount: 3 }),
          item({ id: "pic", type: "image", file: "p.jpg" }),
        ],
        () => new FrameVideo(),
      );
      show(0);
      const v = videos[0];
      v.run(1, 5.96);
      vi.advanceTimersByTime(38);
      expect(ends).toEqual([]);
      vi.advanceTimersByTime(2); // one interval (40 ms) after the last frame
      expect(ends).toEqual([0]);
      expect(v.currentTime).toBe(4);
      // The same end's ended and timeupdate, after the loop-back: nothing.
      v.fire("ended");
      v.fire("timeupdate");
      expect(ends).toEqual([0]);
      // A seek back meanwhile (its sound's restart lands it elsewhere).
      v.run(4, 5.96);
      v.currentTime = 4.5;
      vi.advanceTimersByTime(100);
      expect(ends).toEqual([0]);
      // A menu holds it on its last frame: nothing until it plays on.
      v.run(4.52, 5.96);
      layer.setPaused(true);
      vi.advanceTimersByTime(100);
      expect(ends).toEqual([0]);
      layer.setPaused(false);
      stuckAtEnd(v);
      v.fire("timeupdate");
      expect(ends).toEqual([0, 0]);
      v.land();
      // The reader leaves on the last frame: the old timer reports nothing.
      v.run(4, 5.96);
      show(1);
      vi.advanceTimersByTime(100);
      expect(ends).toEqual([0, 0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a frame interval longer than the frames' (a dropped frame) is not taken for the last frame", () => {
    vi.useFakeTimers();
    try {
      const { videos, show } = lifecycleHarness(
        [clip({ startSeconds: 1, loopStartSeconds: 4 }), line],
        () => new FrameVideo(),
      );
      show(1);
      const v = videos[0];
      v.run(5, 5.84);
      v.present(5.92); // 5.88 dropped: 5.92 + 0.08 reaches the end
      vi.advanceTimersByTime(100);
      expect(v.currentTime).toBe(5.92);
      v.present(5.96);
      vi.advanceTimersByTime(40);
      expect(v.currentTime).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a range ending at or past the last frame (a float step below the duration) completes its pass at the file's end", () => {
    vi.useFakeTimers();
    try {
      const below = 6 - 2 ** -50; // the double just below 6
      const { videos, show, ends } = lifecycleHarness(
        [
          clip({ startSeconds: 1, loopStartSeconds: 4, endSeconds: below }),
          line,
          clip({
            id: "v-count",
            file: "c.mkv",
            startSeconds: 1,
            loopStartSeconds: 4,
            endSeconds: below,
            loopCount: 2,
          }),
          item({ id: "pic", type: "image", file: "p.jpg" }),
        ],
        () => new FrameVideo(),
      );
      show(1);
      const chain = videos[0];
      chain.run(1, 5.96); // no frame reaches the range's end
      chain.end(6);
      chain.fire("ended");
      chain.land();
      expect(chain.currentTime).toBe(4);
      expect(chain.paused).toBe(false);
      show(2);
      const counted = videos[1];
      counted.run(1, 5.96);
      vi.advanceTimersByTime(40);
      expect(ends).toEqual([2]);
      expect(counted.currentTime).toBe(4);
      counted.run(4, 5.96);
      vi.advanceTimersByTime(40);
      expect(ends).toEqual([2, 2]);
      expect(counted.paused).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// A counted video opened by `#start=` (docs/plan.md Phase 50 item 3): the
// first load's Esc screen opens in the same task as the first render, so
// the menu's hold pauses the element while its play() is still pending,
// and the engine rejects that play() with an AbortError (WebKit and
// Chrome, 2026-11-14). Such a play() was superseded, not refused by
// autoplay: it owes no ends, and the resume plays every pass.
class AbortableVideo extends LifeVideo {
  private pending: ((reason: Error) => void) | null = null;
  override play(): Promise<void> {
    super.play();
    return new Promise((_resolve, reject) => {
      this.pending = reject;
    });
  }
  override pause(): void {
    super.pause();
    const reject = this.pending;
    this.pending = null;
    reject?.(Object.assign(new Error("aborted"), { name: "AbortError" }));
  }
  /** The engine starts playing: the pending play() resolves. */
  started(): void {
    this.pending = null;
  }
}

describe("a play() a menu's hold aborts owes no ends (Phase 50 item 3)", () => {
  const counted = vid({
    id: "v-count",
    file: "c.mp4",
    durationSeconds: 6,
    startSeconds: 0.5,
    loopStartSeconds: 3,
    loopCount: 3,
  });
  const after = item({ id: "pic", type: "image", file: "p.jpg" });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("the menu opened as the item starts: the resume plays all three passes", async () => {
    const { layer, videos, show, ends } = lifecycleHarness(
      [counted, after],
      () => new AbortableVideo(),
    );
    show(0);
    layer.setPaused(true); // the Esc screen, in the same task
    await tick();
    expect(ends).toEqual([]);
    layer.setPaused(false);
    const v = videos[0];
    v.started();
    for (let pass = 1; pass <= 3; pass += 1) {
      v.end(6);
      v.fire("ended");
      expect(ends).toHaveLength(pass);
      if (pass < 3) {
        v.land();
        expect(v.currentTime).toBe(3);
        expect(v.paused).toBe(false);
        v.started();
      }
    }
    expect(v.paused).toBe(true); // the last pass holds at its end
  });

  it("autoplay refused after a menu's resume still reports every owed end", async () => {
    const { layer, show, ends } = lifecycleHarness([counted, after], () => {
      const v = new LifeVideo();
      v.play = function (this: LifeVideo) {
        this.plays += 1;
        return Promise.reject(
          Object.assign(new Error("refused"), { name: "NotAllowedError" }),
        );
      };
      return v;
    });
    show(0);
    layer.setPaused(true);
    layer.setPaused(false);
    await tick();
    expect(ends).toEqual([0, 0, 0]);
  });
});
