import { describe, expect, it } from "vitest";

import { THUMB_MAX_WIDTH, thumbSize } from "./capture";

// The pure scaling rule behind the `b` thumbnail capture: no wider than
// 480px (Phase 26, "Bigger bookmark thumbnails in a grid" — the `t` grid
// shows them some 300-400 CSS px wide, so the converter's 320px preview
// size would look soft), the aspect ratio is preserved, and the DOM draw
// path is verified headless — these tests pin only the math.

describe("thumbSize", () => {
  it("caps captures at 480 wide (Phase 26), larger than the 320 previews", () => {
    expect(THUMB_MAX_WIDTH).toBe(480);
  });

  it("caps a wide asset at 480 wide with the aspect kept", () => {
    expect(thumbSize(1920, 1080)).toEqual({ width: 480, height: 270 });
    expect(thumbSize(540, 1920)).toEqual({ width: 480, height: 1707 });
  });

  it("caps a tall asset at 480 wide, never at 480 tall", () => {
    const size = thumbSize(1080, 1920);
    expect(size.width).toBe(THUMB_MAX_WIDTH);
    expect(size.height).toBeGreaterThan(THUMB_MAX_WIDTH);
    expect(size.height).toBe(853); // round(1920 * 480 / 1080)
  });

  it("leaves an already-small asset unchanged", () => {
    expect(thumbSize(96, 72)).toEqual({ width: 96, height: 72 });
    expect(thumbSize(479, 200)).toEqual({ width: 479, height: 200 });
  });

  it("leaves an exactly-480-wide asset unchanged", () => {
    expect(thumbSize(480, 360)).toEqual({ width: 480, height: 360 });
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
      [481, 480],
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
