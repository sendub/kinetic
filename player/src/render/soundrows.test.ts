// Which sound controls a game shows (render/soundrows.ts, docs/plan.md
// Phase 52 item 10): one function from the manifest and the host.

import { describe, expect, it } from "vitest";
import type { Item, Manifest } from "../machine/types";
import { soundContent } from "./soundrows";

const TRACKS = {
  song: { file: "song.mp3", durationSeconds: 1 },
  rain: { file: "rain.mp3", durationSeconds: 1 },
  bang: { file: "bang.mp3", durationSeconds: 1 },
  talk: { file: "talk.mp3", durationSeconds: 1 },
  clip: { file: "clip.mp3", durationSeconds: 1 },
};

function image(id: string, extra: Partial<Item> = {}): Item {
  return { id, type: "image", file: `${id}.png`, ...extra } as Item;
}

function game(items: Item[], extra: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 1,
    width: 100,
    height: 100,
    items,
    ...extra,
  } as Manifest;
}

const withTracks = { audio: { tracks: TRACKS } } as Partial<Manifest>;
const cast = { voices: { Ann: { file: "ann.flac" } } } as Partial<Manifest>;

describe("soundContent (rows by what the game has)", () => {
  it("has no rows for a game with no sound, even in an app with voice", () => {
    const m = game([image("a"), image("b", { text: "Hi", speaker: "Ann" })]);
    for (const host of [false, true]) {
      expect(soundContent(m, host)).toEqual({
        music: false,
        effects: false,
        recordedVoice: false,
        needsModel: false,
        voice: false,
        any: false,
      });
    }
  });

  it("shows Music only for music or ambience", () => {
    const music = soundContent(
      game([image("a", { audio: { music: "song" } })], withTracks),
      false,
    );
    expect([music.music, music.effects, music.voice]).toEqual([
      true,
      false,
      false,
    ]);
    const ambience = soundContent(
      game([image("a", { audio: { ambience: ["rain"] } })], withTracks),
      false,
    );
    expect([ambience.music, ambience.effects]).toEqual([true, false]);
    // A music change to nothing is not music.
    const stop = soundContent(
      game([image("a", { audio: { music: null, ambience: [] } })], withTracks),
      false,
    );
    expect(stop.any).toBe(false);
  });

  it("shows Effects only for one-shots and a video's sound", () => {
    const sfx = soundContent(
      game([image("a", { audio: { sfx: [{ track: "bang" }] } })], withTracks),
      false,
    );
    expect([sfx.music, sfx.effects, sfx.voice]).toEqual([false, true, false]);
    const video = soundContent(
      game(
        [
          {
            id: "v",
            type: "video",
            file: "v.mp4",
            poster: "v.png",
            durationSeconds: 3,
            audio: { videoSound: { track: "clip" } },
          } as Item,
        ],
        withTracks,
      ),
      false,
    );
    expect([video.music, video.effects]).toEqual([false, true]);
  });

  it("ignores a name no track defines", () => {
    const m = game([image("a", { audio: { music: "missing" } })], withTracks);
    expect(soundContent(m, false).any).toBe(false);
  });

  it("shows Voice for recorded lines, in a browser tab too, with no model", () => {
    const m = game(
      [image("a", { text: "Hi", speaker: "Ann", audio: { voice: "talk" } })],
      { ...withTracks, ...cast },
    );
    for (const host of [false, true]) {
      const c = soundContent(m, host);
      expect([c.voice, c.recordedVoice, c.needsModel, c.music]).toEqual([
        true,
        true,
        false,
        false,
      ]);
    }
  });

  it("shows Voice for lines the model would speak only where the host offers voice", () => {
    const m = game([image("a", { text: "Hi", speaker: "Ann" })], cast);
    expect(soundContent(m, true)).toMatchObject({
      voice: true,
      recordedVoice: false,
      needsModel: true,
      any: true,
    });
    // A browser tab cannot speak them: no row.
    expect(soundContent(m, false)).toMatchObject({
      voice: false,
      needsModel: false,
      any: false,
    });
  });

  it("wants the model only for a line it would speak", () => {
    // Cast, but the only text is blank, uncast, or recorded.
    const m = game(
      [
        image("a", { text: "  ", speaker: "Ann" }),
        image("b", { text: "Hi", speaker: "Bob" }),
        image("c", { text: "Yes", speaker: "Ann", audio: { voice: "talk" } }),
      ],
      { ...withTracks, ...cast },
    );
    expect(soundContent(m, true)).toMatchObject({
      recordedVoice: true,
      needsModel: false,
    });
    // One more line with no recording needs it, and the narrator counts.
    const more = game([...m.items, image("d", { text: "Night." })], {
      ...withTracks,
      ...cast,
      narrator: { file: "n.flac" },
    });
    expect(soundContent(more, true)).toMatchObject({
      recordedVoice: true,
      needsModel: true,
    });
  });

  it("combines rows", () => {
    const m = game(
      [
        image("a", {
          audio: { music: "song", sfx: [{ track: "bang" }] },
        }),
        image("b", { text: "Hi", speaker: "Ann" }),
      ],
      { ...withTracks, ...cast },
    );
    expect(soundContent(m, true)).toMatchObject({
      music: true,
      effects: true,
      voice: true,
      needsModel: true,
    });
  });
});
