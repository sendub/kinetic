// The one geometry rule of the visual surface (docs/plan.md Phase 7b): media
// fills the screen as much as possible without changing its aspect ratio —
// the largest centered contain fit, the leftover letterboxed. The manifest's
// `width`/`height` describe the ASSET, not a letterbox target, so nothing in
// the player fits content to them: the only mismatch that can letterbox is
// the asset's own aspect against the viewport's.
//
// The layout is CSS (`.visual` in index.html: a media box the size of the
// viewport with `object-fit: contain`, one rule shared by image, animation
// frame and video). This function is that rule stated as arithmetic, so the
// fit can be pinned by unit tests, and `scripts/verify.mjs` imports it as the
// box the rendered media has to match.

/** A box inside the viewport: where the media paints, and where the bars are. */
export interface FitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The largest `assetW x assetH` box that fits `viewportW x viewportH` with
 * the aspect ratio preserved, centered in the viewport. Exactly one
 * dimension is flush with the viewport unless the two aspects are equal;
 * the other one leaves the letterbox. Results are exact (unrounded) — a
 * caller that writes pixels rounds them.
 *
 * Degenerate input (anything non-positive) yields a zero-size box at the
 * viewport's center, so an unknown asset size never produces a bogus box.
 */
export function containFit(
  assetW: number,
  assetH: number,
  viewportW: number,
  viewportH: number,
): FitRect {
  if (!(assetW > 0) || !(assetH > 0) || !(viewportW > 0) || !(viewportH > 0)) {
    return { x: viewportW / 2, y: viewportH / 2, width: 0, height: 0 };
  }
  const scale = Math.min(viewportW / assetW, viewportH / assetH);
  const width = assetW * scale;
  const height = assetH * scale;
  return {
    x: (viewportW - width) / 2,
    y: (viewportH - height) / 2,
    width,
    height,
  };
}
