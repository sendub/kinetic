// The visual surface (docs/plan.md Phases 5-6). Draws `items[machine
// .visualIndex()]`: a media item draws its own visual, a `text` item draws the
// visual of the nearest earlier media-bearing item, which keeps playing
// underneath the chain (docs/content-format.md, "Text items").
//
// Playback is derived from machine state alone:
//   playing = !skipping && cursor >= frontier - 1. Rewind and skip show
//   stills (animation `frames[0]`, video poster), never play.
//   In a chain — the cursor item is `text`, or the next manifest item is
//   `text` — the visual loops continuously and media end gates nothing.
//   A standalone animation cycles its frames at `fps` for `loopCount` loops
//   and stops on the final frame. A standalone video plays its passes
//   manually: an element with `loop` NEVER fires `ended`, so the renderer
//   leaves `loop` off, reports every pass complete to the machine, and seeks
//   back to the loop restart point (`loopStartSeconds`, defaulting to the
//   range start) until `loopCount` passes have been reported; a
//   `holdSeconds` video is background — free looping, nothing reported
//   (docs/plan.md Phase 9b).
//
//   A video may play a sub-range of its file (`startSeconds`/`endSeconds`,
//   docs/content-format.md "Video playback ranges"): the renderer seeks to
//   `startSeconds` when the item is freshly entered (a chain advance stays
//   on the SAME item and never re-seeks), and a pass completes when
//   playback reaches `endSeconds` — detected per presented frame with
//   `requestVideoFrameCallback` (exact per frame), falling back to
//   `timeupdate` where rVFC is absent (Firefox pre-133; ~4-250 ms coarse,
//   noted once). The file's native `ended` bounds a pass only when the
//   range runs to the file's end (`endSeconds` absent or equal to
//   `durationSeconds`), because no frame is ever presented past it. With a
//   range or counted passes active, `loop` stays off: the element's own
//   looping seeks to 0, which is wrong for a range (docs/plan.md Phase 9c).
//   A pass that completes while passes remain restarts at
//   `loopStartSeconds` (default `startSeconds`), so an intro plays once and
//   the loop-backs skip it; only a fresh item entry starts at
//   `startSeconds` again (docs/plan.md Phase 9d). A video `loop`ing
//   natively — background, no range — wraps at 0, because the element
//   controls that restart.
//
// One `<img>` serves images and animation frames, and ONE `<video>` element
// is reused across renders: advancing within a chain flips `loop` and keeps
// the same element playing, never re-creating or reloading it.
//
// Sizing is not this module's business: `.visual` (index.html) is a box the
// size of the viewport whose paint is `object-fit: contain`, so whatever the
// player gets fills it maximally with the aspect ratio kept, and the manifest's
// width/height are used for nothing at render time (docs/plan.md Phase 7b).

import type {
  AnimationItem,
  Item,
  MachineState,
  Manifest,
  VideoItem,
} from "../machine/types";

/** How the current visual plays, per docs/content-format.md "Timing". */
export type PlaybackMode = "still" | "loop-once" | "loop-forever";

/**
 * Pure chain/still decision. The visual plays only while the cursor is at
 * the frontier (`cursor >= frontier - 1`) and skip mode is off; rewind and
 * skip show stills. It plays continuously — `loop-forever`, media end
 * ignored — while the cursor item is `text` or the next manifest item is:
 * the chain's visual loops under the whole chain. Otherwise a media visual
 * runs its fixed cycle once (for a video, its declared passes — see
 * `videoPlanFor`).
 */
export function playbackModeFor(
  cursorItem: Item | undefined,
  nextItem: Item | undefined,
  skipping: boolean,
  cursor: number,
  frontier: number,
): PlaybackMode {
  if (cursorItem === undefined) return "still";
  if (skipping || cursor < frontier - 1) return "still";
  if (cursorItem.type === "text" || nextItem?.type === "text") {
    return "loop-forever";
  }
  return "loop-once";
}

/** How the reused `<video>` element must play out a `PlaybackMode`. */
export interface VideoPlan {
  /** The `loop` attribute: an element that loops NEVER fires `ended`. */
  loop: boolean;
  /**
   * How many pass-completes to report to `machine.mediaEnded()` before
   * the element holds on its final frame; 0 means the element's ends gate
   * nothing (background, chain, or still).
   */
  reportEnds: number;
  /** Where a pass begins: seek target on entry and on every loop-back. */
  startSeconds: number;
  /** Where a pass ends; null means the file's end (no `endSeconds`). */
  endSeconds: number | null;
  /**
   * Which signal bounds a pass (docs/content-format.md, "Video playback
   * ranges"): the file's native `ended` when the range runs to the file's
   * end (no frame is ever presented past it — and none before it when
   * `endSeconds` is absent); otherwise one presented frame per
   * `requestVideoFrameCallback` ("rvfc"), or `timeupdate` where rVFC is
   * unavailable (~4-250 ms coarse).
   */
  boundary: "ended" | "rvfc" | "timeupdate";
}

/**
 * Pure element-plan decision for a video (docs/content-format.md,
 * "Timing"). Standalone (`loop-once`): a `holdSeconds` video is background,
 * so it loops freely and reports nothing — the machine gates on the clock
 * alone and ignores `ended`; any other video must have its pass-completes
 * counted, so `loop` stays off and each pass reports one `mediaEnded()` up
 * to `loopCount` (default 1). A chain (`loop-forever`) loops beneath the
 * whole chain and reports nothing; a still plays nothing.
 *
 * With a range active (either bound present), `loop` stays OFF even for a
 * chain: the element's own looping seeks to 0, which is wrong for a range,
 * so the renderer seeks back to `startSeconds` itself at each pass boundary
 * (docs/plan.md Phase 9c). `hasRVFC` is the runtime capability of the
 * `<video>` element, passed in so this decision stays pure and testable.
 */
export function videoPlanFor(
  item: VideoItem,
  mode: PlaybackMode,
  hasRVFC: boolean,
): VideoPlan {
  const startSeconds = item.startSeconds ?? 0;
  const endSeconds = item.endSeconds ?? null;
  const ranged =
    item.startSeconds !== undefined || item.endSeconds !== undefined;
  const boundary: VideoPlan["boundary"] =
    endSeconds === null || endSeconds >= item.durationSeconds
      ? "ended"
      : hasRVFC
        ? "rvfc"
        : "timeupdate";
  if (mode !== "loop-once") {
    return {
      loop: mode === "loop-forever" && !ranged,
      reportEnds: 0,
      startSeconds,
      endSeconds,
      boundary,
    };
  }
  if (item.holdSeconds !== undefined) {
    return { loop: !ranged, reportEnds: 0, startSeconds, endSeconds, boundary };
  }
  return {
    loop: false,
    reportEnds: item.loopCount ?? 1,
    startSeconds,
    endSeconds,
    boundary,
  };
}

/**
 * Pure frame-sequence math: which frame index to show `elapsedMs` after the
 * cycle started, cycling at `fps`. With `loopCount === Infinity` (chain
 * mode) it cycles forever; otherwise, once `loopCount` cycles have elapsed
 * it stops on the final frame (`frameCount - 1`).
 */
export function animationFrameAt(
  frameCount: number,
  fps: number,
  loopCount: number,
  elapsedMs: number,
): number {
  if (frameCount <= 0 || fps <= 0 || elapsedMs < 0) return 0;
  const step = Math.floor(elapsedMs / (1000 / fps));
  const total = loopCount === Infinity ? Infinity : frameCount * loopCount;
  if (step >= total) return frameCount - 1;
  return step % frameCount;
}

export interface VisualLayer {
  /**
   * Draw the item under `machine.visualIndex()` with the playback mode that
   * `state` implies. `skipping` holds media to stills; rewind (cursor below
   * the frontier) holds them too (docs/content-format.md, "Timing").
   */
  update(item: Item | undefined, state: MachineState): void;
  /**
   * The `<img>` or `<video>` currently painted, for thumbnail capture
   * (render/capture.ts). Null while a notice is on screen — nothing is
   * drawable then, and the caller falls back or skips.
   */
  currentVisual(): HTMLImageElement | HTMLVideoElement | null;
  /** Stop all playback and drop the video element. Idempotent. */
  destroy(): void;
}

export interface VisualLayerOptions {
  /**
   * One reported pass of a standalone video: wired to `machine.mediaEnded()`,
   * which counts to `loopCount` (or ignores ends for background videos).
   */
  onVideoEnded(): void;
}

interface AnimationRun {
  id: string;
  mode: PlaybackMode;
  frames: readonly string[];
  fps: number;
  loopCount: number;
  startedAt: number;
}

const now = (): number => globalThis.performance.now();

export function createVisualLayer(
  stage: HTMLElement,
  manifest: Manifest,
  options: VisualLayerOptions,
): VisualLayer {
  const doc = stage.ownerDocument;
  let image: HTMLImageElement | null = null;
  let notice: HTMLElement | null = null;
  // Last drawn values, so re-showing an item leaves the painted surface alone
  // instead of blanking it for a frame.
  let drawnFile: string | null = null;
  let drawnNotice: string | null = null;

  // The single reused <video>. `drawnVideoSrc` is the file it currently
  // loads and `drawnVideoItem` the item it was entered with — two items can
  // share one file at different ranges, and a fresh item entry (whatever
  // the file) re-seeks to that item's range start. `videoMode` its current
  // playback mode; `videoPlan` how that mode plays out on the element (see
  // `videoPlanFor`); `videoEndedCount` the pass-completes already reported
  // for the current playback; `videoGeneration` bumps whenever the source
  // changes so a late autoplay rejection cannot report an end for a video
  // that is no longer on screen.
  let video: HTMLVideoElement | null = null;
  let drawnVideoSrc: string | null = null;
  let drawnVideoItem: string | null = null;
  let videoMode: PlaybackMode | null = null;
  let videoPlan: VideoPlan | null = null;
  let videoEndedCount = 0;
  let videoGeneration = 0;
  let rangeFallbackNoted = false;

  let animation: AnimationRun | null = null;
  let animationTimer: ReturnType<typeof setTimeout> | null = null;
  const preloaded = new Set<string>();

  function dropImage(): void {
    image?.remove();
    image = null;
    drawnFile = null;
  }

  function dropNotice(): void {
    notice?.remove();
    notice = null;
    drawnNotice = null;
  }

  function showNotice(id: string, text: string): void {
    stopAnimation();
    hideVideo();
    dropImage();
    if (notice === null || drawnNotice !== text) {
      notice?.remove();
      notice = doc.createElement("div");
      notice.id = id;
      notice.className = "notice";
      notice.textContent = text;
      drawnNotice = text;
      stage.append(notice);
    }
  }

  /** The shared <img>, created on first use and un-hidden. */
  function ensureImage(): HTMLImageElement {
    if (image === null) {
      image = doc.createElement("img");
      image.id = "visual-image";
      image.className = "visual";
      image.alt = "";
      image.draggable = false;
      // No size is taken from the manifest: its width/height are the asset's
      // intrinsic size, and `.visual` (index.html) is a viewport-sized box
      // with `object-fit: contain`, so the media fills whatever screen it
      // gets, aspect kept. Setting the attributes here would letterbox the
      // content to the manifest instead (docs/plan.md Phase 7b).
      stage.append(image);
    }
    image.style.display = "";
    return image;
  }

  function hideImage(): void {
    if (image !== null) image.style.display = "none";
  }

  function showImage(file: string): void {
    stopAnimation();
    hideVideo();
    dropNotice();
    const img = ensureImage();
    if (drawnFile === file) return;
    img.src = file;
    drawnFile = file;
  }

  // --- animation ---------------------------------------------------------

  function stopAnimation(): void {
    if (animationTimer !== null) {
      clearTimeout(animationTimer);
      animationTimer = null;
    }
    animation = null;
  }

  function setFrame(file: string): void {
    const img = ensureImage();
    if (drawnFile !== file) {
      img.src = file;
      drawnFile = file;
    }
  }

  /**
   * Per-callback self-rescheduling timer: each tick computes the frame from
   * elapsed time via the pure `animationFrameAt` (not from a tick count), so
   * timing never drifts with callback delay, and schedules the next tick for
   * the exact frame boundary. `loop-once` stops the timer on the final frame.
   */
  function animationTick(): void {
    animationTimer = null;
    const run = animation;
    if (run === null) return;
    const forever = run.mode === "loop-forever";
    const loopCount = forever ? Infinity : run.loopCount;
    const frameMs = 1000 / run.fps;
    const elapsed = now() - run.startedAt;
    setFrame(
      run.frames[
        animationFrameAt(run.frames.length, run.fps, loopCount, elapsed)
      ],
    );
    if (!forever && elapsed >= run.frames.length * run.loopCount * frameMs) {
      return; // stopped: the pure function pins the final frame
    }
    const step = Math.floor(elapsed / frameMs);
    const due = run.startedAt + (step + 1) * frameMs;
    animationTimer = setTimeout(animationTick, Math.max(0, due - now()));
  }

  function showAnimation(item: AnimationItem, mode: PlaybackMode): void {
    hideVideo();
    dropNotice();
    const key = `${item.id}\u0000${mode}`;
    if (animation !== null && animationKey() === key) return; // same run
    stopAnimation();
    setFrame(item.frames[0]); // first paint is frame 0 either way
    if (mode === "still") return; // rewind/skip: frames[0], never play
    // Warm the decode cache so looped swaps never wait on the file.
    for (const frame of item.frames) {
      if (!preloaded.has(frame)) {
        preloaded.add(frame);
        const warm = new Image();
        warm.src = frame;
      }
    }
    animation = {
      id: item.id,
      mode,
      frames: item.frames,
      fps: item.fps,
      loopCount: item.loopCount,
      startedAt: now(),
    };
    animationTick();
  }

  function animationKey(): string | null {
    return animation === null ? null : `${animation.id}\u0000${animation.mode}`;
  }

  // --- video -------------------------------------------------------------

  // Range-pass watch state: `rangeWatchToken` bumps whenever a watch is
  // retired (mode change, hide, destroy, pass boundary), so a queued
  // `requestVideoFrameCallback` cannot fire against a stale plan;
  // `rvfcHandle` cancels a pending callback. The `timeupdate` fallback
  // listener stays attached for the element's life and gates itself on
  // `videoPlan.boundary` (it fires only every ~4-250 ms — coarse by
  // design; docs/content-format.md, "Video playback ranges").
  let rangeWatchToken = 0;
  let rvfcHandle: number | null = null;

  function hasRVFC(element: HTMLVideoElement): boolean {
    return typeof element.requestVideoFrameCallback === "function";
  }

  function ensureVideo(): HTMLVideoElement {
    if (video === null) {
      video = doc.createElement("video");
      video.id = "visual-video";
      video.className = "visual";
      video.muted = true;
      video.playsInline = true;
      // The classic attribute too: iOS Safari honours only this spelling.
      video.setAttribute("playsinline", "");
      video.preload = "auto";
      video.addEventListener("ended", onVideoEnded);
      video.addEventListener("timeupdate", onTimeUpdate);
    }
    if (!video.isConnected) stage.append(video);
    return video;
  }

  function stopRangeWatch(): void {
    rangeWatchToken += 1;
    if (video !== null && rvfcHandle !== null) {
      video.cancelVideoFrameCallback(rvfcHandle);
    }
    rvfcHandle = null;
  }

  /**
   * Arm the per-pass boundary watch for the current plan: rVFC where
   * available (its `mediaTime` is exact per presented frame), `timeupdate`
   * as the documented fallback. Nothing to watch when the pass is bounded
   * by the file's own end (`ended` handles that) or when no range bounds
   * playback at all.
   */
  function startRangeWatch(element: HTMLVideoElement): void {
    stopRangeWatch();
    const plan = videoPlan;
    if (
      plan === null ||
      plan.endSeconds === null ||
      plan.boundary === "ended"
    ) {
      return;
    }
    if (plan.boundary === "rvfc") {
      const token = rangeWatchToken;
      const tick = (_now: number, meta: VideoFrameCallbackMetadata): void => {
        if (
          token !== rangeWatchToken ||
          video !== element ||
          videoPlan !== plan
        ) {
          return; // retired: the callback chain ends here
        }
        if (plan.endSeconds !== null && meta.mediaTime >= plan.endSeconds) {
          passBoundary(element, plan);
        } else {
          rvfcHandle = element.requestVideoFrameCallback(tick);
        }
      };
      rvfcHandle = element.requestVideoFrameCallback(tick);
    } else if (!rangeFallbackNoted) {
      // Noted once per page: this browser has no rVFC, so pass boundaries
      // land where the coarse 4-250 ms `timeupdate` cadence puts them.
      rangeFallbackNoted = true;
      console.info(
        "kinetic: requestVideoFrameCallback unavailable; range pass " +
          "boundaries fall back to timeupdate (~4-250 ms coarse).",
      );
    }
  }

  function onTimeUpdate(): void {
    const plan = videoPlan;
    if (
      video === null ||
      plan === null ||
      plan.boundary !== "timeupdate" ||
      plan.endSeconds === null
    ) {
      return;
    }
    if (video.currentTime >= plan.endSeconds) passBoundary(video, plan);
  }

  /**
   * Playback reached the pass end (`endSeconds`) on a presented frame.
   * A counted pass reports one `mediaEnded()` to the machine and seeks
   * back to `startSeconds` while passes remain; after the last one the
   * element pauses — the machine's gate is met and it moves on. A chain or
   * background video (nothing counted) just keeps looping within the
   * range: forward to `endSeconds`, back to `startSeconds`, no report
   * (docs/plan.md Phase 9c).
   */
  function passBoundary(element: HTMLVideoElement, plan: VideoPlan): void {
    if (plan.reportEnds > 0) {
      videoEndedCount += 1;
      options.onVideoEnded();
      if (videoEndedCount >= plan.reportEnds) {
        stopRangeWatch();
        element.pause(); // last pass: hold at the range end
        return;
      }
    }
    seekTo(element, plan.startSeconds);
    startRangeWatch(element); // re-arms the rVFC chain after the seek
  }

  function onVideoEnded(): void {
    // The file's own end is the pass boundary only when the plan says so:
    // no `endSeconds`, or an `endSeconds` at the file's end (past it no
    // frame is ever presented, so rVFC could never see it). A range that
    // ends inside the file is bounded by the rVFC/timeupdate watch, and a
    // `loop`-ing element never reaches this event at all.
    const plan = videoPlan;
    if (plan === null || plan.boundary !== "ended") return;
    if (plan.reportEnds === 0) {
      // A chain/background video whose range runs to the file's end: loop
      // back to the range start, nothing reported (`loop` is off precisely
      // because a range is active — a non-ranged free looper never ends).
      if (video === null || plan.loop) return;
      seekTo(video, plan.startSeconds);
      playVideo(video, plan);
      return;
    }
    videoEndedCount += 1;
    options.onVideoEnded();
    if (videoEndedCount < plan.reportEnds && video !== null) {
      seekTo(video, plan.startSeconds);
      playVideo(video, plan);
    }
  }

  function seekTo(element: HTMLVideoElement, seconds: number): void {
    try {
      if (element.currentTime !== seconds) element.currentTime = seconds;
    } catch {
      // Metadata not loaded yet: the poster stays painted, which is the
      // same frame at `startSeconds` the seek would show.
    }
  }

  /**
   * Start or continue playback, and keep the machine's gate honest when
   * autoplay rejects: muted autoplay is normally allowed; if it does not
   * start, stay on the poster with no console error and report EVERY
   * remaining `ended` the plan still owes — the machine otherwise waits for
   * ends that can never come, so the timeline would dead-end on an
   * unplayable video.
   */
  function playVideo(element: HTMLVideoElement, plan: VideoPlan): void {
    const generation = videoGeneration;
    element.play().catch(() => {
      if (generation !== videoGeneration || videoPlan !== plan) return;
      while (videoEndedCount < plan.reportEnds) {
        videoEndedCount += 1;
        options.onVideoEnded();
      }
    });
  }

  /**
   * Apply a mode to the reused element without touching its source. On a
   * fresh item entry the element seeks to the plan's `startSeconds` before
   * playing (stills hold that same frame); an advance within a chain lands
   * on the SAME item and is only a mode flip (once -> forever), so the
   * video keeps playing forward from where it is — never re-seeked on a
   * text advance (docs/plan.md Phase 9c).
   */
  function applyVideoMode(
    element: HTMLVideoElement,
    item: VideoItem,
    mode: PlaybackMode,
    freshEntry: boolean,
  ): void {
    videoMode = mode;
    videoPlan = videoPlanFor(item, mode, hasRVFC(element));
    videoEndedCount = 0; // every (re)start counts its passes afresh
    element.style.display = "";
    element.loop = videoPlan.loop;
    if (mode === "still") {
      // Poster still: paused at the range start, the poster attribute and
      // the CSS background beneath the frame keep the poster painted.
      stopRangeWatch();
      element.pause();
      seekTo(element, videoPlan.startSeconds);
      return;
    }
    if (freshEntry || mode === "loop-once") {
      seekTo(element, videoPlan.startSeconds);
    }
    playVideo(element, videoPlan);
    startRangeWatch(element);
  }

  function showVideo(item: VideoItem, mode: PlaybackMode): void {
    stopAnimation();
    dropNotice();
    hideImage();
    const element = ensureVideo();
    const freshEntry =
      drawnVideoSrc !== item.file || drawnVideoItem !== item.id;
    if (drawnVideoSrc !== item.file) {
      videoGeneration += 1;
      element.pause();
      element.src = item.file;
      drawnVideoSrc = item.file;
    }
    if (freshEntry) {
      // The item's poster is the frame at ITS startSeconds — two items may
      // share one file at different ranges, so it is repainted per entry.
      drawnVideoItem = item.id;
      element.poster = item.poster;
      // Poster as a CSS background: painted instantly while the file loads
      // or while autoplay is pending, so the first frame is never a blank.
      element.style.backgroundImage = `url("${item.poster}")`;
      element.style.backgroundSize = "contain";
      element.style.backgroundRepeat = "no-repeat";
      element.style.backgroundPosition = "center";
      applyVideoMode(element, item, mode, true);
      return;
    }
    if (videoMode !== mode) applyVideoMode(element, item, mode, false);
  }

  function hideVideo(): void {
    if (video === null) return;
    stopRangeWatch();
    video.pause();
    video.style.display = "none";
    drawnVideoSrc = null;
    drawnVideoItem = null;
    videoMode = null;
    videoPlan = null;
    videoEndedCount = 0;
    videoGeneration += 1; // retire any pending autoplay fallback
  }

  return {
    update(item, state) {
      if (item === undefined) {
        const empty = manifest.items.length === 0;
        showNotice(
          "empty-state",
          empty
            ? "No content yet — this folder has an empty manifest."
            : "No content to show.",
        );
        return;
      }
      const mode = playbackModeFor(
        manifest.items[state.cursor],
        manifest.items[state.cursor + 1],
        state.skipping,
        state.cursor,
        state.frontier,
      );
      switch (item.type) {
        case "image":
          showImage(item.file);
          return;
        case "animation":
          showAnimation(item, mode);
          return;
        case "video":
          showVideo(item, mode);
          return;
        case "text":
          // Unreachable for a valid manifest: visualIndex() resolves a `text`
          // item to its earlier media. Guard so a bad folder shows a label
          // rather than a blank screen.
          showNotice("placeholder", `${item.id} — text item with no visual`);
          return;
      }
    },

    currentVisual() {
      // Exactly one surface is visible at a time: showVideo hides the <img>
      // and showImage/showAnimation/showNotice hide the <video>.
      if (video !== null && drawnVideoSrc !== null) return video;
      if (
        image !== null &&
        drawnFile !== null &&
        image.style.display !== "none"
      ) {
        return image;
      }
      return null;
    },

    destroy() {
      stopAnimation();
      stopRangeWatch();
      if (video !== null) {
        video.pause();
        video.removeEventListener("ended", onVideoEnded);
        video.removeEventListener("timeupdate", onTimeUpdate);
        video.remove();
        video = null;
        drawnVideoSrc = null;
        drawnVideoItem = null;
        videoMode = null;
        videoPlan = null;
        videoEndedCount = 0;
        videoGeneration += 1;
      }
    },
  };
}
