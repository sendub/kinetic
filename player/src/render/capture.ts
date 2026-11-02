// Thumbnail capture of the currently visible surface (docs/plan.md Phase 8,
// README bookmark bullet). The `b` binding will pass the visual layer's
// current element to `captureVisualThumbnail`, which paints its CURRENT
// pixels — a decoded video frame, the on-screen animation frame, or an
// image — into an offscreen canvas scaled per `thumbSize` (no wider than
// 480 pixels, Phase 26) and returns a JPEG blob.
//
// The module never throws: when nothing is drawable (no element, undecoded
// video with no poster, failed poster load, tainted or unsupported canvas)
// it resolves null so the caller can skip or fall back to `<id>.thumb.jpg`.

/**
 * Bookmark captures are no wider than this. Wider than the converter's
 * 320px `<id>.thumb.jpg` previews (docs/content-format.md) because the `t`
 * grid (docs/plan.md Phase 26) draws each thumbnail some 300-400 CSS px
 * wide; at JPEG quality `THUMB_QUALITY` a 480x270 capture is a few tens
 * of KB per bookmark.
 */
export const THUMB_MAX_WIDTH = 480;

/** The JPEG encoder quality for captures (Chrome's own default is 0.92). */
export const THUMB_QUALITY = 0.8;

export interface ThumbSize {
  width: number;
  height: number;
}

/**
 * Pure scaling math: the thumbnail box for an asset of `assetWidth` x
 * `assetHeight`, no wider than 480px with the aspect ratio preserved
 * (height rounded, at least 1). Non-positive or non-finite input yields
 * zero size, which callers treat as "not drawable".
 */
export function thumbSize(assetWidth: number, assetHeight: number): ThumbSize {
  if (
    !Number.isFinite(assetWidth) ||
    !Number.isFinite(assetHeight) ||
    assetWidth <= 0 ||
    assetHeight <= 0
  ) {
    return { width: 0, height: 0 };
  }
  if (assetWidth <= THUMB_MAX_WIDTH) {
    return {
      width: Math.min(THUMB_MAX_WIDTH, Math.round(assetWidth)),
      height: Math.max(1, Math.round(assetHeight)),
    };
  }
  return {
    width: THUMB_MAX_WIDTH,
    height: Math.max(
      1,
      Math.round(assetHeight * (THUMB_MAX_WIDTH / assetWidth)),
    ),
  };
}

/** The element `render/visual.ts` currently paints, or null while a notice shows. */
export type VisualSource =
  | HTMLImageElement
  | HTMLVideoElement
  | null
  | undefined;

export interface CaptureOptions {
  /** Injected for tests; defaults to a detached `<canvas>`. */
  createCanvas?: (width: number, height: number) => HTMLCanvasElement;
  /** Injected for tests; defaults to `new Image()` for the poster fallback. */
  createImage?: () => HTMLImageElement;
  /** Blob MIME type. Defaults to JPEG, the format of every generated preview. */
  type?: string;
  /** Encoder quality for lossy types. Defaults to `THUMB_QUALITY`. */
  quality?: number;
}

interface Drawable {
  element: HTMLImageElement | HTMLVideoElement;
  width: number;
  height: number;
}

function isVideo(
  source: HTMLImageElement | HTMLVideoElement,
): source is HTMLVideoElement {
  return "videoWidth" in source && "readyState" in source;
}

function defaultCreateCanvas(): (
  width: number,
  height: number,
) => HTMLCanvasElement {
  const doc = globalThis.document;
  if (doc === undefined) throw new Error("no document");
  return () => doc.createElement("canvas");
}

function defaultCreateImage(): () => HTMLImageElement {
  const Ctor = globalThis.Image;
  if (Ctor === undefined) throw new Error("no Image constructor");
  return () => new Ctor();
}

/** Loads `src` into a fresh <img>; resolves null on error or missing DOM. */
function loadImage(
  src: string,
  createImage: () => HTMLImageElement,
): Promise<HTMLImageElement | null> {
  let img: HTMLImageElement;
  try {
    img = createImage();
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * Resolve what to draw right now: a video with decoded data (readyState >=
 * HAVE_CURRENT_DATA) draws its current playback frame; a video not yet
 * decoded falls back to its poster; anything else draws the <img> as it
 * stands. Resolves null when there is nothing drawable.
 */
async function resolveDrawable(
  source: VisualSource,
  createImage: () => HTMLImageElement,
): Promise<Drawable | null> {
  if (source === null || source === undefined) return null;
  if (!isVideo(source)) {
    return {
      element: source,
      width: source.naturalWidth,
      height: source.naturalHeight,
    };
  }
  const video = source;
  if (video.readyState >= 2 && video.videoWidth > 0) {
    return {
      element: video,
      width: video.videoWidth,
      height: video.videoHeight,
    };
  }
  const poster = video.getAttribute("poster");
  if (poster === null || poster === "") return null;
  const img = await loadImage(poster, createImage);
  if (img === null) return null;
  return { element: img, width: img.naturalWidth, height: img.naturalHeight };
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number | undefined,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    // A tainted canvas never calls back; it fires "error"/"abort" on the
    // canvas element instead (per the spec), so resolve null from those.
    canvas.addEventListener("error", () => resolve(null), { once: true });
    canvas.addEventListener("abort", () => resolve(null), { once: true });
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Draw the current pixels of the visible visual element into an offscreen
 * canvas at thumbnail size and encode a Blob. Resolves null (never throws)
 * when nothing is drawable or the canvas cannot be read.
 */
export async function captureVisualThumbnail(
  source: VisualSource,
  options: CaptureOptions = {},
): Promise<Blob | null> {
  let createImage: () => HTMLImageElement;
  try {
    createImage = options.createImage ?? defaultCreateImage();
  } catch {
    return null;
  }
  const drawable = await resolveDrawable(source, createImage);
  if (drawable === null) return null;
  const { width, height } = thumbSize(drawable.width, drawable.height);
  if (width === 0 || height === 0) return null;
  let canvas: HTMLCanvasElement;
  try {
    canvas = (options.createCanvas ?? defaultCreateCanvas())(width, height);
  } catch {
    return null;
  }
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  try {
    ctx.drawImage(drawable.element, 0, 0, width, height);
  } catch {
    return null; // e.g. a video frame the decoder cannot paint yet
  }
  return canvasToBlob(
    canvas,
    options.type ?? "image/jpeg",
    options.quality ?? THUMB_QUALITY,
  );
}
