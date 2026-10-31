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
//   and stops on the final frame; a standalone video plays once and reports
//   `ended` so the machine can advance.
//
// One `<img>` serves images and animation frames, and ONE `<video>` element
// is reused across renders: advancing within a chain flips `loop` and keeps
// the same element playing, never re-creating or reloading it.

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
 * runs its fixed cycle once.
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
  /** Stop all playback and drop the video element. Idempotent. */
  destroy(): void;
}

export interface VisualLayerOptions {
  /** Video `ended` for a standalone video: wires to `machine.mediaEnded()`. */
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
  // loads; `videoMode` its current playback mode; `videoGeneration` bumps
  // whenever the source changes so a late autoplay rejection cannot report
  // an end for a video that is no longer on screen.
  let video: HTMLVideoElement | null = null;
  let drawnVideoSrc: string | null = null;
  let videoMode: PlaybackMode | null = null;
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
      // Declare the manifest's display size so layout is reserved before the
      // file decodes; CSS then scales that box down to fit the viewport.
      image.width = manifest.width;
      image.height = manifest.height;
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
    // A chain's video has `loop` set, so `ended` never fires there; only a
    // standalone play-through reports, per docs/content-format.md "Timing".
    if (videoMode === "loop-once") options.onVideoEnded();
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
   * Apply a mode to the reused element without touching its source, so an
   * advance within a chain (once -> forever) keeps the SAME element playing.
   */
  function applyVideoMode(element: HTMLVideoElement, mode: PlaybackMode): void {
    videoMode = mode;
    element.style.display = "";
    element.loop = mode === "loop-forever";
    if (mode === "still") {
      // Poster still: paused at the start, the poster attribute and the CSS
      // background beneath the frame keep the poster painted.
      element.pause();
      seekToStart(element);
      return;
    }
    if (mode === "loop-once") seekToStart(element);
    // Muted autoplay is normally allowed; if it rejects, stay on the poster
    // with no console error, and — for a standalone video — report media
    // ended anyway: the machine otherwise waits for an `ended` that can
    // never come, so the timeline would dead-end on an unplayable video.
    const generation = videoGeneration;
    element.play().catch(() => {
      if (generation !== videoGeneration || videoMode !== mode) return;
      if (mode === "loop-once") options.onVideoEnded();
    });
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
      applyVideoMode(element, mode);
      return;
    }
    if (videoMode !== mode) applyVideoMode(element, mode);
  }

  function hideVideo(): void {
    if (video === null) return;
    video.pause();
    video.style.display = "none";
    drawnVideoSrc = null;
    videoMode = null;
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

    destroy() {
      stopAnimation();
      if (video !== null) {
        video.pause();
        video.removeEventListener("ended", onVideoEnded);
        video.remove();
        video = null;
        drawnVideoSrc = null;
        videoMode = null;
        videoGeneration += 1;
      }
    },
  };
}
