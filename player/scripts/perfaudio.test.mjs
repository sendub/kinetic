// perf.mjs's decoded-audio read (perfaudio.mjs), without a browser: the
// page instrument on stand-in Web Audio classes, and the summary.
import { afterEach, describe, expect, it } from "vitest";
import { AUDIO_INSTRUMENT, decodedSummary } from "./perfaudio.mjs";

const NAMES = ["BaseAudioContext", "AudioBufferSourceNode", "__perfAudio"];
const saved = Object.fromEntries(NAMES.map((n) => [n, globalThis[n]]));

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete globalThis[name];
    else globalThis[name] = saved[name];
  }
});

/** Stand-ins for the two Web Audio classes the instrument wraps. */
function fakeWebAudio() {
  globalThis.BaseAudioContext = class {
    decodeAudioData(bytes) {
      return bytes === "bad"
        ? Promise.reject(new Error("undecodable"))
        : Promise.resolve(bytes);
    }
  };
  globalThis.AudioBufferSourceNode = class {
    start(when) {
      return `started at ${String(when)}`;
    }
  };
}

describe("AUDIO_INSTRUMENT", () => {
  it("records each decoded buffer and passes it on", async () => {
    fakeWebAudio();
    AUDIO_INSTRUMENT();
    const context = new globalThis.BaseAudioContext();
    const buffer = { length: 96000, numberOfChannels: 2, sampleRate: 48000 };
    await expect(context.decodeAudioData(buffer)).resolves.toBe(buffer);
    expect(globalThis.__perfAudio.decodes).toEqual([
      { length: 96000, channels: 2, rate: 48000 },
    ]);
  });

  it("records nothing for a decode that fails, which still rejects", async () => {
    fakeWebAudio();
    AUDIO_INSTRUMENT();
    const context = new globalThis.BaseAudioContext();
    await expect(context.decodeAudioData("bad")).rejects.toThrow("undecodable");
    expect(globalThis.__perfAudio.decodes).toEqual([]);
  });

  it("counts the sources started, each still starting", () => {
    fakeWebAudio();
    AUDIO_INSTRUMENT();
    const source = new globalThis.AudioBufferSourceNode();
    expect(source.start(0.5)).toBe("started at 0.5");
    source.start(1);
    expect(globalThis.__perfAudio.sourcesStarted).toBe(2);
  });

  it("records nothing on a page without Web Audio", () => {
    delete globalThis.BaseAudioContext;
    delete globalThis.AudioBufferSourceNode;
    AUDIO_INSTRUMENT();
    expect(globalThis.__perfAudio).toEqual({ decodes: [], sourcesStarted: 0 });
  });
});

describe("decodedSummary", () => {
  it("is empty for no decodes", () => {
    expect(decodedSummary([])).toEqual({
      files: 0,
      bytes: 0,
      largestBytes: 0,
      rates: [],
    });
  });

  it("counts 4 bytes a sample on every channel", () => {
    const summary = decodedSummary([
      { length: 48000, channels: 1, rate: 48000 },
      { length: 8640000, channels: 2, rate: 48000 },
      { length: 44100, channels: 2, rate: 44100 },
    ]);
    expect(summary).toEqual({
      files: 3,
      bytes: 48000 * 4 + 8640000 * 2 * 4 + 44100 * 2 * 4,
      largestBytes: 69120000,
      rates: [44100, 48000],
    });
  });
});
