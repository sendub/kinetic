// The voice model's pure parts (render/voicemodel.ts, docs/plan.md Phase 52
// item 10): the download's words and size, the progress, and what the Voice
// row shows for each status of the voice engine.

import { describe, expect, it } from "vitest";
import {
  downloadLabel,
  gigabytes,
  installPercent,
  modelHelp,
  voiceModelView,
} from "./voicemodel";

const ABSENT = { state: "absent", downloadBytes: 3_300_000_000 } as const;

describe("the download's size and words", () => {
  it("sizes it to one decimal place of 1e9 bytes", () => {
    expect(gigabytes(3_249_000_000)).toBe("3.2 GB");
    expect(downloadLabel(3_300_000_000)).toBe("Download voice model (3.3 GB)");
    expect(downloadLabel(12_000_000_000)).toBe(
      "Download voice model (12.0 GB)",
    );
  });

  it("counts progress in whole percent, 0 to 100, 0 with no total", () => {
    expect(installPercent({ state: "installing", downloadBytes: 1 })).toBe(0);
    expect(
      installPercent({
        state: "installing",
        downloadBytes: 1,
        done: 5,
        total: 0,
      }),
    ).toBe(0);
    expect(
      installPercent({
        state: "installing",
        downloadBytes: 1,
        done: 42,
        total: 100,
      }),
    ).toBe(42);
    expect(
      installPercent({
        state: "installing",
        downloadBytes: 1,
        done: 500,
        total: 100,
      }),
    ).toBe(100);
  });
});

describe("modelHelp (the ? beside the download)", () => {
  it("explains where the lines come from, the one download and its size", () => {
    const text = modelHelp(ABSENT);
    expect(text).toMatch(/made on this computer from the characters' voices/);
    expect(text).toMatch(/downloaded once/);
    expect(text).toMatch(/every Kinetic game on this computer/);
    expect(text).toMatch(/3\.3 GB/);
  });

  it("gives an unsupported machine's reason, and a fallback with none", () => {
    expect(
      modelHelp({
        ...ABSENT,
        state: "unsupported",
        message: "Spoken lines need a Mac with Apple silicon.",
      }),
    ).toBe("Spoken lines need a Mac with Apple silicon.");
    expect(modelHelp({ ...ABSENT, state: "unsupported" })).toBe(
      "Spoken lines are not available on this computer.",
    );
  });
});

describe("voiceModelView: what the Voice row shows for each status", () => {
  it("checking, until the host gives a status", () => {
    expect(voiceModelView(null)).toMatchObject({
      area: "checking",
      ready: false,
      removable: false,
      help: null,
    });
  });

  it("absent: the download with its help", () => {
    expect(voiceModelView(ABSENT)).toMatchObject({
      area: "download",
      disabled: false,
      ready: false,
      label: "Download voice model (3.3 GB)",
      help: modelHelp(ABSENT),
    });
  });

  it("installing: the progress, no help", () => {
    expect(
      voiceModelView({
        ...ABSENT,
        state: "installing",
        done: 33,
        total: 100,
      }),
    ).toMatchObject({ area: "progress", percent: 33, help: null });
  });

  it("error: its words and Retry", () => {
    expect(
      voiceModelView({ ...ABSENT, state: "error", message: "Failed." }),
    ).toMatchObject({ area: "error", message: "Failed.", help: null });
    expect(voiceModelView({ ...ABSENT, state: "error" }).message).not.toBe("");
  });

  it("unsupported: the download greyed, its help the reason", () => {
    expect(
      voiceModelView({ ...ABSENT, state: "unsupported", message: "No GPU." }),
    ).toMatchObject({ area: "download", disabled: true, help: "No GPU." });
  });

  it("ready: the model can be removed, nothing else to show", () => {
    expect(voiceModelView({ ...ABSENT, state: "ready" })).toMatchObject({
      area: "none",
      ready: true,
      removable: true,
      help: null,
    });
  });
});
