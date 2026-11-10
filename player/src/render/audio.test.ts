// The sound module's pure parts (render/audio.ts): whether a manifest has
// anything to play, and which files the warm-up fetches ahead.

import { describe, expect, it } from "vitest";
import type { Item, Manifest } from "../machine/types";
import { hasSound, upcomingSoundFiles } from "./audio";

const tracks = {
  knock: { file: "knock.wav", durationSeconds: 0.6 },
  bell: { file: "bell.webm", durationSeconds: 3 },
  mei: { file: "mei.webm", durationSeconds: 1.2 },
  again: { file: "knock.wav", durationSeconds: 0.6 },
  calm: { file: "calm.m4a", durationSeconds: 8 },
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

describe("upcomingSoundFiles (the warm-up)", () => {
  const items = [
    image("now", { sfx: [{ track: "bell" }] }),
    image("one", { sfx: [{ track: "knock" }, { track: "bell" }] }),
    image("two", { music: "calm" }),
    image("three", { voice: "mei", sfx: [{ track: "again" }] }),
    image("four", { sfx: [{ track: "bell" }] }),
  ];

  it("takes the one-shots and voice lines of the next 3 items, each file once, music never", () => {
    expect(upcomingSoundFiles(items, tracks, 0, 3)).toEqual([
      "knock.wav",
      "bell.webm",
      "mei.webm",
    ]);
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
