import { describe, expect, it } from "vitest";

import { THUMB_MAX_WIDTH, thumbSize } from "./capture";

// The pure scaling rule behind thumbnail capture (docs/content-format.md):
// previews are no wider than 320px, the aspect ratio is preserved, and the
// DOM draw path is verified headless in a later task — these tests pin only
// the math.

describe("thumbSize", () => {
  it("caps a wide asset at 320 wide with the aspect kept", () => {
    expect(thumbSize(1920, 1080)).toEqual({ width: 320, height: 180 });
    expect(thumbSize(540, 1920)).toEqual({ width: 320, height: 1138 });
  });

  it("caps a tall asset at 320 wide, never at 320 tall", () => {
    const size = thumbSize(1080, 1920);
    expect(size.width).toBe(THUMB_MAX_WIDTH);
    expect(size.height).toBeGreaterThan(THUMB_MAX_WIDTH);
    expect(size.height).toBe(569); // round(1920 * 320 / 1080)
  });

  it("leaves an already-small asset unchanged", () => {
    expect(thumbSize(96, 72)).toEqual({ width: 96, height: 72 });
    expect(thumbSize(319, 200)).toEqual({ width: 319, height: 200 });
  });

  it("leaves an exactly-320-wide asset unchanged", () => {
    expect(thumbSize(320, 240)).toEqual({ width: 320, height: 240 });
  });

  it("yields zero size for zero or negative dimensions", () => {
    // Callers treat width 0 as "not drawable" and return null.
    expect(thumbSize(0, 100)).toEqual({ width: 0, height: 0 });
    expect(thumbSize(100, 0)).toEqual({ width: 0, height: 0 });
    expect(thumbSize(-5, 100)).toEqual({ width: 0, height: 0 });
    expect(thumbSize(Number.NaN, 100)).toEqual({ width: 0, height: 0 });
  });

  it("never exceeds the cap and keeps the aspect for any asset", () => {
    const assets: ReadonlyArray<readonly [number, number]> = [
      [1920, 1080],
      [1080, 1920],
      [640, 960],
      [540, 1920],
      [800, 800],
      [4096, 2160],
      [321, 320],
      [1, 10000],
    ];
    for (const [w, h] of assets) {
      const size = thumbSize(w, h);
      expect(size.width).toBeLessThanOrEqual(THUMB_MAX_WIDTH);
      expect(size.height).toBeGreaterThan(0);
      // Height is the nearest pixel to the exact scaled height, so the
      // aspect ratio is preserved to within one pixel of height.
      expect(Math.abs(size.height - (h * size.width) / w)).toBeLessThan(1);
    }
  });
});
