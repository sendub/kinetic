// The pure half of the `c` config screen (docs/plan.md Phase 9): the
// speed stepper's step and clamps, and the readout text. The DOM panel in
// config.ts only applies these; the end-to-end behaviour is walked by
// scripts/verify.mjs.

import { describe, expect, it } from "vitest";

import {
  SPEED_MAX,
  SPEED_MIN,
  skipAllLabel,
  speedLabel,
  stepSpeed,
} from "./config";

describe("stepSpeed (README: configurable reading speed)", () => {
  it("walks the 0.25 grid in both directions", () => {
    expect(stepSpeed(1.0, 1)).toBe(1.25);
    expect(stepSpeed(1.0, -1)).toBe(0.75);
    expect(stepSpeed(1.0, 4)).toBe(2.0);
    expect(stepSpeed(1.0, -3)).toBe(0.25);
  });

  it("clamps at both ends of the range", () => {
    expect(stepSpeed(SPEED_MIN, -1)).toBe(SPEED_MIN); // 0 is not a speed
    expect(stepSpeed(SPEED_MAX, 1)).toBe(SPEED_MAX);
    expect(stepSpeed(0.25, -4)).toBe(SPEED_MIN);
    expect(stepSpeed(3.0, 4)).toBe(SPEED_MAX);
  });

  it("snaps an off-grid value back onto the grid", () => {
    // A hand-built or older persisted value still lands on a legal step.
    expect(stepSpeed(1.1, 1)).toBe(1.25);
    expect(stepSpeed(1.1, 0)).toBe(1.0);
    expect(stepSpeed(1.4, 0)).toBe(1.5);
  });
});

describe("speedLabel (multiplier and its ms/char)", () => {
  it("shows the multiplier and the per-code-point allowance it gives", () => {
    expect(speedLabel(1.0, 60)).toBe("1.00x — ~60 ms/char");
    expect(speedLabel(2.0, 60)).toBe("2.00x — ~30 ms/char");
    expect(speedLabel(3.0, 60)).toBe("3.00x — ~20 ms/char");
    expect(speedLabel(0.25, 60)).toBe("0.25x — ~240 ms/char");
  });

  it("rounds a fractional allowance to a whole ms", () => {
    // 60 / 0.75 = 80 exactly; 0.25-step values against the 60 ms base are
    // exact, but the label stays a rounded integer whatever the inputs.
    expect(speedLabel(0.75, 60)).toBe("0.75x — ~80 ms/char");
    expect(speedLabel(1.0, 61)).toBe("1.00x — ~61 ms/char");
  });
});

describe("skipAllLabel (the README tab bullet's config option)", () => {
  it("names the two states", () => {
    expect(skipAllLabel(true)).toBe("On");
    expect(skipAllLabel(false)).toBe("Off");
  });
});
