// The visual surface (docs/plan.md Phases 5-6). Draws `items[machine
// .visualIndex()]`: a media item draws its own visual, a `text` item draws the
// visual of the nearest earlier media-bearing item, which keeps playing
// underneath the chain (docs/content-format.md, "Text items").
//
// Playback is derived from machine state alone:
//   playing = !skipping && (cursor >= frontier - 1 || the step that arrived
//   was a forward advance). Skip and a NAV arrival below the seen edge — the
//   wheel scrub, a bookmark, an `e` landing, a route entry — show stills
//   (animation `frames[0]`, video poster); an ADVANCE (space or the auto
//   timer) replays its media wherever the cursor sits, so content read once
//   plays again when the reader advances back over it. The `skipPlaysVideos`
//   setting's `skipVideo` state flag overrides skip's still: the video (and
//   its chain) plays as an advance would (docs/plan.md Phase 18).
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
//   An active segment (`state.segment`, docs/plan.md Phase 49,
//   docs/content-format.md "Video segments") replaces the item's range on
//   the same item: the step seeks ONCE to the segment's `startSeconds` (the
//   one deliberate seek on an item already shown), plays to its
//   `endSeconds` and loops back to its `loopStartSeconds`, bounded as a
//   range is and counting no passes. The machine clears it on every
//   arrival, so leaving, re-entering, a reload or skip plays the item's own
//   range again; a menu's pause and resume keep it.
//
// One `<img>` serves images and animation frames. One `<video>` serves one
// source file: advancing within a chain flips `loop` and keeps the same
// element playing, never re-creating or reloading it, and so do ranges of
// the same file, loop passes, replays and seeks. A new file gets a fresh
// element and the old one is released (see `retireVideo` for why).
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
  TransitionKind,
  VideoItem,
  VideoSegment,
} from "../machine/types";

/** How the current visual plays, per docs/content-format.md "Timing". */
export type PlaybackMode = "still" | "loop-once" | "loop-forever";

/**
 * Pure chain/still decision. The visual plays while skip mode is off, and
 * either the cursor is at the frontier (`cursor >= frontier - 1`) or the step
 * that made it current was a forward `advance`: a `nav` arrival below the
 * seen edge — the wheel scrub, a bookmark, an `e` landing, a route entry —
 * shows stills, while advancing forward over already-seen content plays it
 * again (docs/content-format.md, "Timing"). It plays continuously —
 * `loop-forever`, media end ignored — while the cursor item is `text` or the
 * next manifest item is: the chain's visual loops under the whole chain.
 * Otherwise a media visual runs its fixed cycle once (for a video, its
 * declared passes — see `videoPlanFor`). `skipVideo` (the machine state's
 * flag, the `skipPlaysVideos` setting — docs/plan.md Phase 18) means skip is
 * PLAYING the video: it plays as a forward advance would, so neither skip
 * nor a nav arrival below the edge holds it to its poster.
 */
export function playbackModeFor(
  cursorItem: Item | undefined,
  nextItem: Item | undefined,
  skipping: boolean,
  transition: TransitionKind,
  cursor: number,
  frontier: number,
  skipVideo = false,
): PlaybackMode {
  if (cursorItem === undefined) return "still";
  const held = skipping || (cursor < frontier - 1 && transition === "nav");
  if (held && !skipVideo) return "still";
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
  /** Where the FIRST pass begins: the seek target on a fresh entry. */
  startSeconds: number;
  /**
   * Where every pass AFTER the first begins: the seek target at a
   * loop-back while passes remain, defaulting to `startSeconds`
   * (docs/plan.md Phase 9d) — an intro plays once and the loop skips it.
   */
  loopStartSeconds: number;
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
 * so the renderer seeks back itself at each pass boundary — to
 * `startSeconds` on a fresh entry and to `loopStartSeconds` (default
 * `startSeconds`) on every loop-back (docs/plan.md Phases 9c and 9d).
 * `hasRVFC` is the runtime capability of the `<video>` element, passed in
 * so this decision stays pure and testable.
 *
 * An active `segment` (docs/plan.md Phase 49, docs/content-format.md
 * "Video segments") replaces the item's range while the video plays: the
 * segment's start is the seek target, its end bounds each pass (the
 * file's `ended` when it ends at the file's end) and every pass after the
 * first restarts at its `loopStartSeconds` (default its start), with
 * `loop` off and nothing reported, whatever the item's own passes. It may
 * lie outside the item's range. A still ignores it: the poster is the
 * frame at the item's own start.
 */
export function videoPlanFor(
  item: VideoItem,
  mode: PlaybackMode,
  hasRVFC: boolean,
  segment?: VideoSegment,
): VideoPlan {
  const boundaryAt = (end: number | null): VideoPlan["boundary"] =>
    end === null || end >= item.durationSeconds
      ? "ended"
      : hasRVFC
        ? "rvfc"
        : "timeupdate";
  if (segment !== undefined && mode !== "still") {
    return {
      loop: false,
      reportEnds: 0,
      startSeconds: segment.startSeconds,
      loopStartSeconds: segment.loopStartSeconds ?? segment.startSeconds,
      endSeconds: segment.endSeconds,
      boundary: boundaryAt(segment.endSeconds),
    };
  }
  const startSeconds = item.startSeconds ?? 0;
  const loopStartSeconds = item.loopStartSeconds ?? startSeconds;
  const endSeconds = item.endSeconds ?? null;
  const ranged =
    item.startSeconds !== undefined || item.endSeconds !== undefined;
  const boundary = boundaryAt(endSeconds);
  if (mode !== "loop-once") {
    return {
      loop: mode === "loop-forever" && !ranged,
      reportEnds: 0,
      startSeconds,
      loopStartSeconds,
      endSeconds,
      boundary,
    };
  }
  if (item.holdSeconds !== undefined) {
    return {
      loop: !ranged,
      reportEnds: 0,
      startSeconds,
      loopStartSeconds,
      endSeconds,
      boundary,
    };
  }
  return {
    loop: false,
    reportEnds: item.loopCount ?? 1,
    startSeconds,
    loopStartSeconds,
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

/**
 * The files to warm so the next `ahead` MEDIA items paint instantly
 * (docs/plan.md Phase 12, docs/perf.md). Array order only: v1 follows the
 * manifest order ahead of `cursor` and does not walk route spans — an
 * upcoming decision's routes are not trivially derivable without the
 * reader's answer, and a wrong guess costs one wasted warm, never a miss
 * (the real render path still loads whatever it shows). A `text` item
 * contributes nothing: it keeps an earlier item's visual, which is either
 * already on screen or already among the media picked below. An animation
 * contributes all its frames (the entry cycles through them), a video
 * contributes ONLY its poster — the first paint of a video item is the
 * poster through the same img decode path (docs/verify-player.md step 9);
 * the file itself is the element's `preload=auto` business, never a gate.
 */
export function upcomingVisualFiles(
  items: readonly Item[],
  cursor: number,
  ahead: number,
): string[] {
  const files: string[] = [];
  let media = 0;
  for (let i = cursor + 1; i < items.length && media < ahead; i += 1) {
    const item = items[i];
    switch (item.type) {
      case "image":
        media += 1;
        files.push(item.file);
        break;
      case "animation":
        media += 1;
        files.push(...item.frames);
        break;
      case "video":
        media += 1;
        files.push(item.poster);
        break;
      case "text":
        break; // no new visual of its own
    }
  }
  return files;
}

/** The stage's video as `VisualLayer.watchVideo` reports it. */
export interface StageVideo {
  /** The `<video>` element: a fresh one per file (`retireVideo`). */
  readonly element: HTMLVideoElement;
  /**
   * The stage plays it (false: it holds its poster, under skip or a walk
   * back over seen content). A menu's hold (`setPaused`) leaves this true:
   * the element itself pauses.
   */
  readonly plays: boolean;
  /**
   * The pass under way, read when asked (passes are counted as they end):
   * where it ends, and where the video plays from next if it wraps there
   * (the loop restart point, 0 for an element's own loop); `restart` is
   * null when the video holds at the end. Null while it plays nothing.
   */
  pass(): { end: number; restart: number | null } | null;
  /**
   * Ends the pass under way now, as reaching its end would, and plays on
   * from its restart point: a counted pass is reported. Its sound
   * (render/audio.ts, docs/plan.md Phase 47 item 19) asks for it a seek's
   * landing before the sound wraps, so the video's restart lands with the
   * sound's. Nothing on a pass that holds at its end, or while it plays
   * nothing.
   */
  restart(): void;
}

export interface VisualLayer {
  /**
   * Draw the item under `machine.visualIndex()` with the playback mode that
   * `state` implies. `skipping` holds media to stills, and so does a nav
   * arrival with the cursor below the frontier; an advance arriving there
   * replays the media (docs/content-format.md, "Timing").
   */
  update(item: Item | undefined, state: MachineState): void;
  /**
   * Warm the decode path for the next media items (see
   * `upcomingVisualFiles`): fetch + decode behind a hidden `Image` per
   * file, kept in an LRU so the browser's decoded bitmap stays alive until
   * the item is entered. Idempotent and cheap; call it on idle moments.
   */
  preloadUpcoming(cursor: number): void;
  /**
   * The `<img>` or `<video>` currently painted, for thumbnail capture
   * (render/capture.ts). Null while a notice is on screen — nothing is
   * drawable then, and the caller falls back or skips.
   */
  currentVisual(): HTMLImageElement | HTMLVideoElement | null;
  /**
   * Hold (true) or release (false) a playing video in place — the Esc
   * screen and the branch map pause the timeline (docs/plan.md Phase 18). While held a video
   * never starts; release resumes it from where it stopped, if its mode
   * still plays. Idempotent.
   */
  setPaused(paused: boolean): void;
  /**
   * The video's sound follows the stage's video (docs/plan.md Phase 47,
   * item 6): `listener` hears the video now, then on every entry and mode
   * change of a video, and null once no video shows. One listener; a new
   * one replaces it.
   */
  watchVideo(listener: (video: StageVideo | null) => void): void;
  /**
   * Asked each time a video is about to start from paused (an entry, a
   * menu's resume; never a wrap), after `watchVideo` heard it: how long
   * (ms) the start waits. The video's sound (render/audio.ts) starts at
   * once and is heard only after the audio output's latency (docs/plan.md
   * Phase 47, item 19), so the two begin together. Null: no wait.
   */
  setStartDelay(delay: ((element: HTMLVideoElement) => number) | null): void;
  /**
   * The stage video's current time while the stage plays `item`'s video
   * (a video a menu holds paused counts), for the machine's segment step
   * (`Machine.setVideoClock`, docs/plan.md Phase 49); null while it holds
   * its poster as a still, shows another item, or shows no video.
   */
  videoTime(item: Item | undefined): number | null;
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

/**
 * The notice text when no item can produce a visual: an empty manifest
 * (a folder whose visuals all failed to resolve — docs/extracting.md
 * BUG 1 — ships zero items) reads differently from a folder that has
 * items but nothing drawable at the cursor. Pure so the empty-state
 * wording is unit-tested without a DOM.
 */
export function emptyStateNoticeText(itemCount: number): string {
  return itemCount === 0
    ? "No content yet — this folder has an empty manifest."
    : "No content to show.";
}

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

  // The current <video> (one per source file, see `retireVideo`).
  // `drawnVideoSrc` is the file it loads and `drawnVideoItem` the item it
  // was entered with — two items can share one file at different ranges,
  // and a fresh item entry (whatever the file) re-seeks to that item's
  // range start. `videoMode` its current playback mode; `videoSegment` the
  // active segment it plays (an index into the item's `segments`, null for
  // the item's own range); `videoPlan` how that mode plays out on the
  // element (see `videoPlanFor`);
  // `videoEndedCount` the pass-completes already reported for the current
  // playback; `videoGeneration` bumps whenever the source changes so a late
  // autoplay rejection cannot report an end for a video that is no longer
  // on screen.
  let video: HTMLVideoElement | null = null;
  let drawnVideoSrc: string | null = null;
  let drawnVideoItem: string | null = null;
  let videoMode: PlaybackMode | null = null;
  let videoSegment: number | null = null;
  let videoPlan: VideoPlan | null = null;
  let videoEndedCount = 0;
  let videoGeneration = 0;
  let rangeFallbackNoted = false;
  // `setPaused(true)`: the menus' timeline pause (docs/plan.md Phase 18).
  let held = false;
  // `watchVideo`: what the listener last heard.
  let stageVideo: StageVideo | null = null;
  let videoListener: ((video: StageVideo | null) => void) | null = null;
  // `setStartDelay`, and the start it put off: `startToken` changes with
  // every start asked for since, so a later one wins.
  let startDelay: ((element: HTMLVideoElement) => number) | null = null;
  let startToken = 0;

  function tellVideo(next: StageVideo | null): void {
    if (next === null && stageVideo === null) return;
    stageVideo = next;
    videoListener?.(next);
  }

  let animation: AnimationRun | null = null;
  let animationTimer: ReturnType<typeof setTimeout> | null = null;

  // --- decode preload (docs/plan.md Phase 12, docs/perf.md) ---------------
  //
  // MEASURED (docs/perf.md, headless Chrome 156, file://): a cold
  // navigation — keypress to the first rAF frame whose image is decoded —
  // ran 2-4 frames WITHOUT preload (demo p50 27.9 / p95 36.7; extract-demo
  // p50 13.9 / p95 32.2) because the fetch + decode land on the navigation
  // itself, while a file this run already painted navigates in ~0-1
  // frames. The capability probe says `img.decode()` and
  // `createImageBitmap(img)` both work on file:// images in this Chrome,
  // but the presenter is an `<img>` element: an ImageBitmap only pays off
  // by replacing it with a canvas draw (a full presenter refactor the
  // budget does not need). A hidden `Image` per file goes through the SAME
  // resource + decode path the `<img>` will use on entry, so holding it
  // alive is the smallest variant that removes the cold cost — CHOSEN.
  // WITH this preload both folders navigate inside one frame (demo p95
  // 16-16.8 ms, extract p95 10.2-18.6 ms across runs): under the 41 ms
  // budget, and the canvas/ImageBitmap refactor stays unmade.
  //
  // `PRELOAD_AHEAD` media items (docs/stack.md "cursor +/- a few items";
  // v1 looks forward in array order only — see `upcomingVisualFiles`),
  // capped at `PRELOAD_CAP` live files; eviction drops the reference and
  // the browser reclaims (an ImageBitmap map would `close()` here instead).
  const PRELOAD_AHEAD = 3;
  const PRELOAD_CAP = 8;
  const warm = new Map<string, HTMLImageElement>();

  /** Fetch+decode `file` (or touch it if already warm) and mark it newest. */
  function warmFile(file: string): void {
    const held = warm.get(file);
    if (held !== undefined) {
      warm.delete(file); // Map iteration order is insertion order: a
      warm.set(file, held); // delete+set re-places the file at the newest end.
      return;
    }
    const img = doc.createElement("img"); // off-DOM: fetches + decodes, paints nowhere
    img.src = file;
    // WebKit only fetches an off-DOM image and decodes it on first paint, on
    // the main thread (106-126 ms per 1080p JPEG XL in WKWebView), which
    // stalls a skip burst at every such picture. `decode()` decodes off the
    // main thread and the `<img>` that later shows this URL reuses the
    // result; Chrome keeps the same contract (docs/plan.md Phase 43). The
    // promise is caught, so a failed decode is left to that `<img>`, and an
    // entry evicted mid-decode needs nothing more than dropping its ref.
    if (typeof img.decode === "function") img.decode().catch(() => undefined);
    warm.set(file, img);
    while (warm.size > PRELOAD_CAP) {
      const oldest = warm.keys().next().value;
      if (oldest === undefined) break;
      warm.delete(oldest); // drop the ref; GC frees the decoded bitmap
    }
  }

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
    warmFile(file); // hold the on-screen file's decode, LRU-fresh
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
    warmFile(file); // the cycling frames stay at the LRU's fresh end
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
    // Warm the decode cache so looped swaps never wait on the file (the
    // same LRU the Phase 12 preload uses).
    for (const frame of item.frames) warmFile(frame);
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

  /**
   * Release the current `<video>`, if any: paused, its listeners off, its
   * source removed and `load()`ed empty (so the engine drops the media
   * player, its decoder and its video layer) and out of the stage. The
   * next `ensureVideo()` makes a fresh one, so only one is ever in the DOM.
   *
   * A fresh element per source file (docs/plan.md Phase 46 item 6). The
   * user saw videos play smaller than the stage, an earlier still showing
   * around them, in Safari and the macOS app, fullscreen, after many
   * pictures and videos; wheeling back and pressing Space fixed it. It was
   * not reproduced headless: WebKit draws a playing video in its GPU
   * process, which the off-screen test window never renders, and both
   * engines' screenshots and the DOM showed the video filling its box on
   * every path. The still around it is this element's own poster
   * background, so WebKit was drawing the frames smaller than the box.
   * WebKit sizes that video layer through state it keeps per `<video>`
   * element (in the UI process, a layer that resends a size only when its
   * own cached view of the video changes; each new media player starts
   * from the element's last layer size), and one element used to serve
   * every file of a session. A fresh element starts that state over for
   * each file, as the reader's wheel-back-and-Space did. WebKit has open
   * bugs of this kind: https://bugs.webkit.org/show_bug.cgi?id=241789
   * (a video first renders small) and
   * https://bugs.webkit.org/show_bug.cgi?id=240604 (the wrong fit at
   * playback start).
   */
  function retireVideo(): void {
    if (video === null) return;
    tellVideo(null);
    stopRangeWatch();
    startToken += 1;
    video.pause();
    video.removeEventListener("ended", onVideoEnded);
    video.removeEventListener("timeupdate", onTimeUpdate);
    video.removeAttribute("src");
    video.load();
    video.remove();
    video = null;
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
        // A frame presented while a seek lands (the restart of a pass its
        // sound ended early, `StageVideo.restart`) is the old place's.
        if (
          plan.endSeconds !== null &&
          meta.mediaTime >= plan.endSeconds &&
          !element.seeking
        ) {
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
   * back to `loopStartSeconds` while passes remain; after the last one
   * the element pauses — the machine's gate is met and it moves on. A
   * chain or background video (nothing counted) just keeps looping
   * within the range: forward to `endSeconds`, back to
   * `loopStartSeconds`, no report (docs/plan.md Phases 9c and 9d). `to` is
   * where it plays on from (an element's own loop's restart is 0, for
   * `StageVideo.restart`).
   */
  function passBoundary(
    element: HTMLVideoElement,
    plan: VideoPlan,
    to = plan.loopStartSeconds,
  ): void {
    if (plan.reportEnds > 0) {
      if (!reportEnd(plan)) return;
      if (videoEndedCount >= plan.reportEnds) {
        stopRangeWatch();
        element.pause(); // last pass: hold at the range end
        return;
      }
    }
    seekTo(element, to);
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
      // back to the restart point, nothing reported (`loop` is off
      // precisely because a range is active — a non-ranged free looper
      // never ends).
      if (video === null || plan.loop) return;
      playOnFrom(video, plan);
      return;
    }
    if (!reportEnd(plan)) return;
    if (videoEndedCount < plan.reportEnds && video !== null) {
      playOnFrom(video, plan);
    }
  }

  /**
   * Plays an element that reached the file's end on from the plan's loop
   * restart point: the seek first, and play() once it has landed. play()
   * on an ended video restarts it from 0, and in WebKit a seek asked for
   * just before or just after it did not reliably win: the video played
   * on from 0 (the segments scenario's held WebM, 4 runs in 8 with the
   * seek first, 1 in 5 with it after, 2026-11-14). Landed, the video is no
   * longer ended. Nothing plays if by then a menu holds it (its resume
   * plays it), the plan changed or the element went.
   */
  function playOnFrom(element: HTMLVideoElement, plan: VideoPlan): void {
    seekTo(element, plan.loopStartSeconds, true);
    if (!element.seeking) {
      playVideo(element, plan);
      return;
    }
    element.addEventListener(
      "seeked",
      () => {
        if (video === element && videoPlan === plan) playVideo(element, plan);
      },
      { once: true },
    );
  }

  /**
   * Count and report one pass of `plan` to the machine. The report can
   * move the machine forward synchronously (`mediaEnded()` ->
   * `moveForward()` once the hold has run out), and the next item's
   * `applyVideoMode` then replaces `videoPlan` and resets
   * `videoEndedCount` on this same element before control returns here.
   * Returns false when `plan` is no longer current: the caller must then
   * stop, so a stale pass never seeks, replays or reports for the next
   * item.
   */
  function reportEnd(plan: VideoPlan): boolean {
    videoEndedCount += 1;
    options.onVideoEnded();
    return videoPlan === plan;
  }

  function seekTo(
    element: HTMLVideoElement,
    seconds: number,
    always = false,
  ): void {
    try {
      if (always || element.currentTime !== seconds) {
        element.currentTime = seconds;
      }
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
  function playVideo(
    element: HTMLVideoElement,
    plan: VideoPlan,
    fromPaused = false,
  ): void {
    if (held) return; // `setPaused(false)` starts it
    startToken += 1;
    const wait =
      fromPaused && element.paused && startDelay !== null
        ? startDelay(element)
        : 0;
    if (wait > 0) {
      const token = startToken;
      setTimeout(() => {
        if (
          token === startToken &&
          !held &&
          video === element &&
          videoPlan === plan
        ) {
          playVideo(element, plan);
        }
      }, wait);
      return;
    }
    const generation = videoGeneration;
    element.play().catch(() => {
      if (generation !== videoGeneration || videoPlan !== plan) return;
      while (videoEndedCount < plan.reportEnds) {
        if (!reportEnd(plan)) return;
      }
    });
  }

  /**
   * Apply a mode to the reused element without touching its source. On a
   * fresh item entry the element seeks to the plan's `startSeconds` before
   * playing (stills hold that same frame); an advance within a chain lands
   * on the SAME item and is only a mode flip (once -> forever), so the
   * video keeps playing forward from where it is — never re-seeked on a
   * text advance (docs/plan.md Phase 9c). A change of `segment` (a step,
   * or the segment cleared) seeks once to the new plan's start: the
   * segment's, or the item's own (docs/plan.md Phase 49).
   */
  function applyVideoMode(
    element: HTMLVideoElement,
    item: VideoItem,
    mode: PlaybackMode,
    freshEntry: boolean,
    segment: number | null,
  ): void {
    const stepped = segment !== videoSegment;
    videoMode = mode;
    videoSegment = segment;
    videoPlan = videoPlanFor(
      item,
      mode,
      hasRVFC(element),
      segment === null ? undefined : item.segments?.[segment],
    );
    videoEndedCount = 0; // every (re)start counts its passes afresh
    element.style.display = "";
    element.loop = videoPlan.loop;
    if (mode === "still") {
      // Poster still: paused at the range start, the poster attribute and
      // the CSS background beneath the frame keep the poster painted.
      stopRangeWatch();
      startToken += 1;
      element.pause();
      seekTo(element, videoPlan.startSeconds);
      tellVideo({
        element,
        plays: false,
        pass: () => null,
        restart: () => undefined,
      });
      return;
    }
    if (freshEntry || mode === "loop-once" || stepped) {
      seekTo(element, videoPlan.startSeconds);
    }
    // Heard before it plays: its sound may hold its start back.
    tellVideo({
      element,
      plays: true,
      pass: () => passOf(item),
      restart: () => restartPass(element, item),
    });
    playVideo(element, videoPlan, true);
    startRangeWatch(element);
  }

  /** `StageVideo.pass` for `item`, from the plan and the passes reported. */
  function passOf(item: VideoItem): ReturnType<StageVideo["pass"]> {
    const plan = videoPlan;
    if (plan === null || videoMode === "still") return null;
    const wraps =
      plan.reportEnds === 0 || videoEndedCount + 1 < plan.reportEnds;
    return {
      end: Math.min(
        plan.endSeconds ?? item.durationSeconds,
        item.durationSeconds,
      ),
      restart: wraps ? (plan.loop ? 0 : plan.loopStartSeconds) : null,
    };
  }

  /** `StageVideo.restart` for `item` on `element`, while it is the one playing. */
  function restartPass(element: HTMLVideoElement, item: VideoItem): void {
    const plan = videoPlan;
    const pass = passOf(item);
    if (video !== element || plan === null || held || pass === null) return;
    if (pass.restart === null || element.paused) return;
    passBoundary(element, plan, pass.restart);
  }

  function showVideo(
    item: VideoItem,
    mode: PlaybackMode,
    activeSegment: number | null,
  ): void {
    stopAnimation();
    dropNotice();
    hideImage();
    const newSource = drawnVideoSrc !== item.file;
    // A new file (or the first video after a picture) gets a fresh element;
    // the same file keeps its element (`retireVideo`).
    if (newSource) retireVideo();
    const element = ensureVideo();
    const freshEntry = newSource || drawnVideoItem !== item.id;
    // A still holds the item's own start whatever segment is active.
    const segment =
      mode !== "still" &&
      activeSegment !== null &&
      item.segments?.[activeSegment] !== undefined
        ? activeSegment
        : null;
    if (newSource) {
      videoGeneration += 1;
      element.src = item.file;
      drawnVideoSrc = item.file;
    }
    if (freshEntry) {
      // The item's poster is the frame at ITS startSeconds — two items may
      // share one file at different ranges, so it is repainted per entry.
      // Set in the same task as the element is added, so the stage never
      // paints it without its poster.
      drawnVideoItem = item.id;
      element.poster = item.poster;
      warmFile(item.poster); // first paint is the poster: same img decode path
      // Poster as a CSS background: painted instantly while the file loads
      // or while autoplay is pending, so the first frame is never a blank.
      element.style.backgroundImage = `url("${item.poster}")`;
      element.style.backgroundSize = "contain";
      element.style.backgroundRepeat = "no-repeat";
      element.style.backgroundPosition = "center";
      applyVideoMode(element, item, mode, true, segment);
      return;
    }
    if (videoMode !== mode || videoSegment !== segment) {
      applyVideoMode(element, item, mode, false, segment);
    }
  }

  function hideVideo(): void {
    if (video === null) return;
    tellVideo(null);
    stopRangeWatch();
    startToken += 1;
    video.pause();
    video.style.display = "none";
    drawnVideoSrc = null;
    drawnVideoItem = null;
    videoMode = null;
    videoSegment = null;
    videoPlan = null;
    videoEndedCount = 0;
    videoGeneration += 1; // retire any pending autoplay fallback
  }

  return {
    update(item, state) {
      if (item === undefined) {
        showNotice("empty-state", emptyStateNoticeText(manifest.items.length));
        return;
      }
      const mode = playbackModeFor(
        manifest.items[state.cursor],
        manifest.items[state.cursor + 1],
        state.skipping,
        state.transition,
        state.cursor,
        state.frontier,
        state.skipVideo === true,
      );
      switch (item.type) {
        case "image":
          showImage(item.file);
          return;
        case "animation":
          showAnimation(item, mode);
          return;
        case "video":
          showVideo(item, mode, state.segment?.index ?? null);
          return;
        case "text":
          // Unreachable for a valid manifest: visualIndex() resolves a `text`
          // item to its earlier media. Guard so a bad folder shows a label
          // rather than a blank screen.
          showNotice("placeholder", `${item.id} — text item with no visual`);
          return;
      }
    },

    preloadUpcoming(cursor) {
      // Warm what the reader is most likely to enter next, in array order
      // (see `upcomingVisualFiles`). Repeat calls on the same cursor are
      // LRU touches, not refetches, so the caller can fire on every idle.
      for (const file of upcomingVisualFiles(
        manifest.items,
        cursor,
        PRELOAD_AHEAD,
      )) {
        warmFile(file);
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

    setPaused(paused) {
      if (held === paused) return;
      held = paused;
      if (video === null || videoPlan === null || videoMode === "still") {
        return;
      }
      if (paused) {
        startToken += 1;
        video.pause();
      } else {
        // WebKit can run a video on from up to 0.2 s past the time it
        // reported while held (twice in four resumes, macOS 27.2), and the
        // video's sound resumes where it stopped, with the reported time:
        // sought there, it plays on from there.
        seekTo(video, video.currentTime, true);
        playVideo(video, videoPlan, true);
      }
    },

    watchVideo(listener) {
      videoListener = listener;
      listener(stageVideo);
    },

    setStartDelay(delay) {
      startDelay = delay;
    },

    videoTime(item) {
      if (
        item?.type !== "video" ||
        video === null ||
        videoPlan === null ||
        videoMode === null ||
        videoMode === "still" ||
        drawnVideoItem !== item.id
      ) {
        return null;
      }
      return video.currentTime;
    },

    destroy() {
      stopAnimation();
      stopRangeWatch();
      if (video !== null) {
        retireVideo();
        drawnVideoSrc = null;
        drawnVideoItem = null;
        videoMode = null;
        videoSegment = null;
        videoPlan = null;
        videoEndedCount = 0;
        videoGeneration += 1;
      }
    },
  };
}
