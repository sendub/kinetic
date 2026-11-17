// The voice model's pure parts (render/voicemodel.ts, docs/plan.md Phase 52
// item 10): the download's words and size, the progress, and what the Voice
// row shows for each status of the voice engine.

import { afterEach, describe, expect, it } from "vitest";
import { setUiLanguage } from "../i18n/catalogue";
import { EN } from "../i18n/en";
import {
  downloadLabel,
  gigabytes,
  installPercent,
  modelHelp,
  VOICE_CODES,
  voiceModelView,
  voiceProblem,
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

  it("gives an unsupported machine's reason by its code, and a fallback with none", () => {
    expect(
      modelHelp({
        ...ABSENT,
        state: "unsupported",
        code: "macos-version",
        version: "14.0",
        message: "Spoken lines need macOS 14.0 or later.",
      }),
    ).toBe("Spoken lines need macOS 14.0 or later.");
    expect(modelHelp({ ...ABSENT, state: "unsupported" })).toBe(
      "Spoken lines are not available on this computer.",
    );
  });
});

describe("voiceProblem: a host's error in the player's words (Phase 54 item 7)", () => {
  afterEach(() => setUiLanguage("en"));

  it("has catalogue words for every code a host sends", () => {
    for (const code of VOICE_CODES) {
      expect(EN, code).toHaveProperty(`voice.code.${code}`);
    }
  });

  it("words each code from the catalogue, never the host's English", () => {
    const status = { ...ABSENT, state: "error" as const, message: "detail" };
    for (const code of VOICE_CODES) {
      const words = voiceProblem({ ...status, code });
      expect(words, code).not.toContain("detail");
      expect(words, code).not.toContain("{");
    }
    expect(voiceProblem({ ...status, code: "download-failed" })).toBe(
      "A download failed. Try again to continue it.",
    );
  });

  it("fills in a code's version and sizes", () => {
    expect(
      voiceProblem({
        ...ABSENT,
        state: "unsupported",
        code: "nvidia-driver",
        version: "570.65",
      }),
    ).toBe(
      "Spoken lines need NVIDIA driver 570.65 or later. Update the graphics driver to use them.",
    );
    expect(
      voiceProblem({
        ...ABSENT,
        state: "error",
        code: "disk-space",
        needBytes: 7_830_000_000,
        freeBytes: 2_100_000_000,
      }),
    ).toBe(
      "Spoken lines need 7.8 GB of free disk space; this computer has 2.1 GB free. Free some space, then try again.",
    );
  });

  it("is in the UI language", () => {
    setUiLanguage("de");
    expect(
      voiceProblem({ ...ABSENT, state: "error", code: "hash-mismatch" }),
    ).toBe(
      "Ein Download passte nicht zu seiner Prüfsumme. Versuche es erneut.",
    );
  });

  it("an unknown code, or none: the general words and the host's detail", () => {
    expect(
      voiceProblem({
        ...ABSENT,
        state: "error",
        code: "new-trouble",
        message: "The disk caught fire.",
      }),
    ).toBe("The voice model could not be downloaded. (The disk caught fire.)");
    expect(
      voiceProblem({ ...ABSENT, state: "unsupported", message: "No GPU." }),
    ).toBe("Spoken lines are not available on this computer. (No GPU.)");
    expect(voiceProblem({ ...ABSENT, state: "error" })).toBe(
      "The voice model could not be downloaded.",
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
      voiceModelView({
        ...ABSENT,
        state: "error",
        code: "pip-failed",
        message: "pip said no.",
      }),
    ).toMatchObject({
      area: "error",
      message: "Installing the voice packages failed.",
      help: null,
    });
    expect(voiceModelView({ ...ABSENT, state: "error" }).message).not.toBe("");
  });

  it("unsupported: the download greyed, its help the reason", () => {
    expect(
      voiceModelView({ ...ABSENT, state: "unsupported", code: "no-nvidia" }),
    ).toMatchObject({
      area: "download",
      disabled: true,
      help: "Spoken lines need an NVIDIA graphics card. This computer doesn't have one.",
    });
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
