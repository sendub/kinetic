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
//   leaves `loop` off, reports every `ended` to the machine, and restarts
//   from 0 until `loopCount` passes have been reported; a `holdSeconds`
//   video is background — `loop` on, free looping, nothing reported
//   (docs/plan.md Phase 9b).
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
   * How many `ended` events to report to `machine.mediaEnded()` before
   * the element holds on its final frame; 0 means the element's ends gate
   * nothing (background, chain, or still).
   */
  reportEnds: number;
}

/**
 * Pure element-plan decision for a video (docs/content-format.md,
 * "Timing"). Standalone (`loop-once`): a `holdSeconds` video is background,
 * so it loops freely and reports nothing — the machine gates on the clock
 * alone and ignores `ended`; any other video must have its ends counted, so
 * `loop` stays off and each pass reports one `ended` up to `loopCount`
 * (default 1). A chain (`loop-forever`) loops beneath the whole chain and
 * reports nothing; a still plays nothing.
 */
export function videoPlanFor(item: VideoItem, mode: PlaybackMode): VideoPlan {
  if (mode !== "loop-once") {
    return { loop: mode === "loop-forever", reportEnds: 0 };
  }
  if (item.holdSeconds !== undefined) return { loop: true, reportEnds: 0 };
  return { loop: false, reportEnds: item.loopCount ?? 1 };
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
  // loads; `videoMode` its current playback mode; `videoPlan` how that mode
  // plays out on the element (see `videoPlanFor`); `videoEndedCount` the
  // ends already reported for the current playback; `videoGeneration` bumps
  // whenever the source changes so a late autoplay rejection cannot report
  // an end for a video that is no longer on screen.
  let video: HTMLVideoElement | null = null;
  let drawnVideoSrc: string | null = null;
  let videoMode: PlaybackMode | null = null;
  let videoPlan: VideoPlan | null = null;
  let videoEndedCount = 0;
  let videoGeneration = 0;

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
    }
    if (!video.isConnected) stage.append(video);
    return video;
  }

  function onVideoEnded(): void {
    // A chain or `holdSeconds` video has `loop` set, so `ended` never fires
    // there; the plan is the single source of truth. A reporting video —
    // `loop` off by the HTML fact that looping suppresses `ended` — forwards
    // every pass to the machine, restarting playback until the last one,
    // so `loopCount` passes play and the machine counts N `ended`s to drive
    // its gate (docs/plan.md Phase 9b).
    const plan = videoPlan;
    if (plan === null || plan.reportEnds === 0) return;
    videoEndedCount += 1;
    options.onVideoEnded();
    if (videoEndedCount < plan.reportEnds && video !== null) {
      seekToStart(video);
      playVideo(video, plan);
    }
  }

  function seekToStart(element: HTMLVideoElement): void {
    try {
      if (element.currentTime !== 0) element.currentTime = 0;
    } catch {
      // Metadata not loaded yet: the poster stays painted, which is the
      // same first frame the seek would show.
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
   * Apply a mode to the reused element without touching its source, so an
   * advance within a chain (once -> forever) keeps the SAME element playing.
   */
  function applyVideoMode(
    element: HTMLVideoElement,
    item: VideoItem,
    mode: PlaybackMode,
  ): void {
    videoMode = mode;
    videoPlan = videoPlanFor(item, mode);
    videoEndedCount = 0; // every (re)start counts its passes afresh
    element.style.display = "";
    element.loop = videoPlan.loop;
    if (mode === "still") {
      // Poster still: paused at the start, the poster attribute and the CSS
      // background beneath the frame keep the poster painted.
      element.pause();
      seekToStart(element);
      return;
    }
    if (mode === "loop-once") seekToStart(element);
    playVideo(element, videoPlan);
  }

  function showVideo(item: VideoItem, mode: PlaybackMode): void {
    stopAnimation();
    dropNotice();
    hideImage();
    const element = ensureVideo();
    if (drawnVideoSrc !== item.file) {
      videoGeneration += 1;
      element.pause();
      element.src = item.file;
      element.poster = item.poster;
      // Poster as a CSS background: painted instantly while the file loads
      // or while autoplay is pending, so the first frame is never a blank.
      element.style.backgroundImage = `url("${item.poster}")`;
      element.style.backgroundSize = "contain";
      element.style.backgroundRepeat = "no-repeat";
      element.style.backgroundPosition = "center";
      drawnVideoSrc = item.file;
      applyVideoMode(element, item, mode);
      return;
    }
    if (videoMode !== mode) applyVideoMode(element, item, mode);
  }

  function hideVideo(): void {
    if (video === null) return;
    video.pause();
    video.style.display = "none";
    drawnVideoSrc = null;
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
      if (video !== null) {
        video.pause();
        video.removeEventListener("ended", onVideoEnded);
        video.remove();
        video = null;
        drawnVideoSrc = null;
        videoMode = null;
        videoPlan = null;
        videoEndedCount = 0;
        videoGeneration += 1;
      }
    },
  };
}
