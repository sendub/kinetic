// The sound module's pure parts (render/audio.ts): whether a manifest has
// anything to play, and which files the warm-up decodes ahead.

import { describe, expect, it } from "vitest";
import type { Item, Manifest } from "../machine/types";
import { hasSound, largestAmbienceSet, upcomingSoundFiles } from "./audio";

const tracks = {
  knock: { file: "knock.wav", durationSeconds: 0.6 },
  bell: { file: "bell.webm", durationSeconds: 3 },
  mei: { file: "mei.webm", durationSeconds: 1.2 },
  again: { file: "knock.wav", durationSeconds: 0.6 },
  calm: { file: "calm.m4a", durationSeconds: 8 },
  rain: { file: "rain.flac", durationSeconds: 6 },
};

const image = (id: string, audio?: Item["audio"]): Item =>
  audio === undefined
    ? { id, type: "image", file: `${id}.jpg` }
    : { id, type: "image", file: `${id}.jpg`, audio };

describe("hasSound", () => {
  const manifest = (over: Partial<Manifest>): Manifest => ({
    schemaVersion: 1,
    width: 960,
    height: 540,
    items: [image("a")],
    ...over,
  });

  it("is true for tracks that an item names, false otherwise", () => {
    expect(
      hasSound(
        manifest({
          audio: { tracks },
          items: [image("a", { music: "calm" })],
        }),
      ),
    ).toBe(true);
    expect(hasSound(manifest({}))).toBe(false);
    expect(hasSound(manifest({ audio: { tracks } }))).toBe(false);
    expect(
      hasSound(
        manifest({
          audio: { tracks: {} },
          items: [image("a", { music: "calm" })],
        }),
      ),
    ).toBe(false);
  });
});

describe("largestAmbienceSet", () => {
  it("is the most loops one item names, 0 with none", () => {
    expect(largestAmbienceSet([image("a")])).toBe(0);
    expect(
      largestAmbienceSet([
        image("a", { ambience: ["rain"] }),
        image("b", { ambience: ["rain", "hum", "wind"] }),
        image("c", { ambience: [] }),
      ]),
    ).toBe(3);
  });

  it("counts a 160,000-item game (docs/perf.md, Navigation with sound)", () => {
    const items = Array.from({ length: 160_000 }, (_, i) =>
      image(`i${String(i)}`, i === 7 ? { ambience: ["rain", "hum"] } : {}),
    );
    expect(largestAmbienceSet(items)).toBe(2);
  });
});

describe("upcomingSoundFiles (the warm-up)", () => {
  const items = [
    image("now", { sfx: [{ track: "bell" }] }),
    image("one", { sfx: [{ track: "knock" }, { track: "bell" }] }),
    image("two", { music: "calm", ambience: ["rain"] }),
    image("three", { voice: "mei", sfx: [{ track: "again" }], music: null }),
    image("four", { sfx: [{ track: "bell" }] }),
  ];

  it("takes every track the next 3 items name (music, ambience, one-shots, voice), each file once", () => {
    expect(upcomingSoundFiles(items, tracks, 0, 3)).toEqual([
      "knock.wav",
      "bell.webm",
      "calm.m4a",
      "rain.flac",
      "mei.webm",
    ]);
  });

  it("takes a video's own sound, so it plays with its video at once (Phase 47 item 19)", () => {
    const clip: Item = {
      id: "clip",
      type: "video",
      file: "clip.mp4",
      poster: "clip.poster.jpg",
      durationSeconds: 8,
      audio: { videoSound: { track: "clock", duck: 0.3 } },
    };
    expect(
      upcomingSoundFiles(
        [image("now"), clip],
        { ...tracks, clock: { file: "clock.m4a", durationSeconds: 8 } },
        0,
        3,
      ),
    ).toEqual(["clock.m4a"]);
  });

  it("stops at the story's end and skips unknown tracks", () => {
    expect(upcomingSoundFiles(items, tracks, 3, 3)).toEqual(["bell.webm"]);
    expect(
      upcomingSoundFiles(
        [image("a"), image("b", { sfx: [{ track: "missing" }] })],
        tracks,
        0,
        3,
      ),
    ).toEqual([]);
  });
});
