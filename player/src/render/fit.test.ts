import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { containFit } from "./fit";

// The one presentation rule these tests pin (docs/plan.md Phase 7b): media
// fills the viewport as much as possible without changing its aspect ratio —
// the largest centered contain fit — and the manifest's width/height are the
// asset's intrinsic size, never a box to fit to.

/** The largest fit must keep the asset's aspect ratio to within a pixel. */
const aspectMatches = (
  width: number,
  height: number,
  assetW: number,
  assetH: number,
): boolean => Math.abs(width / height - assetW / assetH) < 1e-9;

const VIEWPORTS: ReadonlyArray<readonly [number, number]> = [
  [1920, 1080],
  [1080, 1920], // portrait phone
  [1280, 720],
  [640, 640], // square
  [1, 1],
];

const ASSETS: ReadonlyArray<readonly [number, number]> = [
  [1920, 1080],
  [960, 540], // the demo fixture's assets, smaller than a real screen
  [640, 960], // portrait asset
  [540, 1920],
  [800, 800],
];

describe("containFit", () => {
  it("letterboxes: a wide asset in a tall viewport is flush in width only", () => {
    const fit = containFit(960, 540, 700, 1000);
    expect(fit.width).toBeCloseTo(700, 6); // flush with the viewport
    expect(fit.height).toBeCloseTo(393.75, 6); // letterboxed vertically
    expect(aspectMatches(fit.width, fit.height, 960, 540)).toBe(true);
  });

  it("pillarboxes: a tall asset in a wide viewport is flush in height only", () => {
    const fit = containFit(640, 960, 1200, 700);
    expect(fit.height).toBeCloseTo(700, 6); // flush with the viewport
    expect(fit.width).toBeCloseTo(466.6667, 3); // pillarboxed horizontally
    expect(aspectMatches(fit.width, fit.height, 640, 960)).toBe(true);
  });

  it("scales a small asset UP: fill means fill, not intrinsic size", () => {
    // The demo's 640x960 frame on a 900x1400 screen must be blown up, not
    // painted 640x960 in the middle (the old max-width/max-height rule).
    const fit = containFit(640, 960, 900, 1400);
    expect(fit.width).toBeCloseTo(900, 6);
    expect(fit.height).toBeCloseTo(1350, 6);
    expect(fit.width).toBeGreaterThan(640);
  });

  it("fills a viewport whose aspect matches, with nothing letterboxed", () => {
    const fit = containFit(1920, 1080, 960, 540);
    expect(fit).toEqual({ x: 0, y: 0, width: 960, height: 540 });
  });

  it("centers the fit, and the letterbox is split evenly", () => {
    for (const [vw, vh] of VIEWPORTS) {
      for (const [aw, ah] of ASSETS) {
        const fit = containFit(aw, ah, vw, vh);
        expect(fit.x).toBeCloseTo((vw - fit.width) / 2, 9);
        expect(fit.y).toBeCloseTo((vh - fit.height) / 2, 9);
      }
    }
  });

  it("never exceeds the viewport, and always touches one edge", () => {
    for (const [vw, vh] of VIEWPORTS) {
      for (const [aw, ah] of ASSETS) {
        const fit = containFit(aw, ah, vw, vh);
        expect(fit.width).toBeLessThanOrEqual(vw + 1e-9);
        expect(fit.height).toBeLessThanOrEqual(vh + 1e-9);
        // The maximal fit is flush in at least one dimension.
        expect(Math.max(fit.width / vw, fit.height / vh)).toBeCloseTo(1, 9);
        expect(aspectMatches(fit.width, fit.height, aw, ah)).toBe(true);
      }
    }
  });

  it("yields a zero-size centered box when a size is not a positive number", () => {
    // Covers the pre-decode / no-metadata case: no asset size, no bogus box.
    expect(containFit(0, 0, 700, 1000)).toEqual({
      x: 350,
      y: 500,
      width: 0,
      height: 0,
    });
    expect(containFit(640, 960, 0, 700).width).toBe(0);
    expect(containFit(Number.NaN, 960, 900, 700).height).toBe(0);
  });
});

// The rule itself lives in CSS, so the durable assertion about it is about
// the CSS: a full-viewport media box whose paint is contained. This guard is
// the same kind as machine/dom-free.test.ts — it reads the shipped sources.
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "..", "index.html"), "utf8");
const visualSrc = readFileSync(join(here, "visual.ts"), "utf8");

const visualRule = /\.visual\s*\{[^}]*\}/.exec(html)?.[0] ?? "";

describe("fill-the-screen CSS rule", () => {
  it("declares a media box that is the viewport", () => {
    expect(visualRule).toContain("width: 100%");
    expect(visualRule).toContain("height: 100%");
  });

  it("contains the paint so the aspect ratio cannot change", () => {
    expect(visualRule).toContain("object-fit: contain");
  });

  it("takes no size from the manifest, whose w/h are the asset's own", () => {
    expect(visualSrc).not.toMatch(/manifest\.width|manifest\.height/);
  });

  it("reaches image, animation frame and video through one class", () => {
    // One rule fits every medium only because the renderer gives the same
    // class to the two elements it creates — the `<img>` carries the
    // animation's frames too — so nothing may be sized separately.
    expect(visualSrc.match(/className = "visual"/g)).toHaveLength(2);
  });
});
