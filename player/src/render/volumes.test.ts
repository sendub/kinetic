// The sound controls' pure parts (render/volumes.ts, docs/plan.md Phase 47
// item 7): the volume steps and readout, which rows the Volumes sheet has,
// and the `v` pill. The sheet itself (focus, keys, Esc) is walked in a real
// browser by screens.scenario.mjs.

import { describe, expect, it } from "vitest";
import {
  soundMessage,
  stepVolume,
  VOLUME_STEP,
  volumeLabel,
  volumeRows,
} from "./volumes";

describe("stepVolume (0 to 1 in steps of 0.1)", () => {
  it("walks the 0.1 grid both ways, landing on exact tenths", () => {
    expect(VOLUME_STEP).toBe(0.1);
    expect(stepVolume(1, -1)).toBe(0.9);
    expect(stepVolume(0.7, 1)).toBe(0.8);
    expect(stepVolume(0.1, 2)).toBe(0.3);
    // Seven presses down from full: 0.3, not 0.30000000000000004.
    let v = 1;
    for (let i = 0; i < 7; i += 1) v = stepVolume(v, -1);
    expect(v).toBe(0.3);
  });

  it("snaps a value off the grid (a drag, an imported file) and clamps to 0-1", () => {
    expect(stepVolume(0.33, 0)).toBe(0.3);
    expect(stepVolume(0.66, 0)).toBe(0.7);
    expect(stepVolume(0, -1)).toBe(0);
    expect(stepVolume(1, 1)).toBe(1);
    expect(stepVolume(-3, 0)).toBe(0);
    expect(stepVolume(7, 0)).toBe(1);
  });
});

describe("volumeLabel (the readout)", () => {
  it("reads as a percentage", () => {
    expect(volumeLabel(1)).toBe("100%");
    expect(volumeLabel(0.9)).toBe("90%");
    expect(volumeLabel(0.3)).toBe("30%");
    expect(volumeLabel(0)).toBe("0%");
  });
});

describe("volumeRows (the Volumes sheet)", () => {
  it("has Music and Effects, and Voice only when some item has a voice line", () => {
    expect(volumeRows(true).map((row) => [row.label, row.setting])).toEqual([
      ["Music", "musicVolume"],
      ["Effects", "effectsVolume"],
      ["Voice", "voiceVolume"],
    ]);
    expect(volumeRows(false).map((row) => row.label)).toEqual([
      "Music",
      "Effects",
    ]);
  });

  it("samples Effects and Voice at their new level; Music plays under the sheet already", () => {
    expect(volumeRows(true).map((row) => row.sample)).toEqual([
      null,
      "effects",
      "voice",
    ]);
  });
});

describe("soundMessage (the v pill)", () => {
  it("names the state sound is now in", () => {
    expect(soundMessage(true)).toBe("Sound on");
    expect(soundMessage(false)).toBe("Sound off");
  });
});
