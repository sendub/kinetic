import { describe, expect, it } from "vitest";

import type { Item, Manifest, VideoItem } from "../machine/types";
import {
  animationFrameAt,
  createVisualLayer,
  emptyStateNoticeText,
  playbackModeFor,
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
      loop: false,
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
    expect(plan.loop).toBe(false);
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
      loop: false,
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
    element.currentTime = 2.0;
    element.fire("ended"); // pass 1 of 2: loops back
    expect(element.currentTime).toBe(1.5);
    element.currentTime = 2.0;
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
