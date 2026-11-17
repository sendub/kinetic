// The sound controls follow the language shown (render/soundcontrols.ts,
// docs/plan.md Phase 54 item 6b): each language's sound content
// (render/soundrows.ts `soundContent` with that language's voices), and the
// switch rule that shows and hides the controls and makes the voice client
// once, when a language first needs the model.

import { describe, expect, it } from "vitest";
import type { Item, LanguageFile, Manifest } from "../machine/types";
import { createLineVoices } from "./linevoice";
import { createSoundControls } from "./soundcontrols";
import { type SoundContent, soundContent } from "./soundrows";

const ITEMS: Item[] = [
  { id: "a", type: "text", speaker: "Mei", text: "You're early." },
  { id: "b", type: "text", text: "The harbour." },
];

function game(extra: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 1,
    width: 10,
    height: 10,
    items: ITEMS,
    languages: ["de", "fr"],
    ...extra,
  } as Manifest;
}

/** A language file translating every item, with `voice` recordings of `recorded`. */
function file(tag: string, recorded: string[] = []): LanguageFile {
  const items: Record<string, string> = {};
  const tracks: Record<string, { file: string; durationSeconds: number }> = {};
  for (const id of recorded) {
    items[id] = id;
    tracks[id] = { file: `lang/${tag}/${id}.webm`, durationSeconds: 1 };
  }
  return {
    language: tag,
    items: { a: { text: `${tag} a` }, b: { text: `${tag} b` } },
    ...(recorded.length > 0 ? { voice: { tracks, items } } : {}),
  };
}

const contentOf = (
  manifest: Manifest,
  tag: LanguageFile | null,
  host = false,
): SoundContent =>
  soundContent(manifest, host, createLineVoices(manifest, tag));

describe("soundContent per language (what the controls follow)", () => {
  it("a game with no base sound has sound only in a language with recorded lines", () => {
    const manifest = game();
    expect(contentOf(manifest, null).any).toBe(false);
    expect(contentOf(manifest, file("de", ["a", "b"]))).toMatchObject({
      recordedVoice: true,
      needsModel: false,
      voice: true,
      any: true,
    });
    // A language with nothing recorded, in a browser tab: no sound.
    expect(contentOf(manifest, file("fr")).any).toBe(false);
  });

  it("music and effects are the same in every language", () => {
    const manifest = game({
      items: [
        { ...ITEMS[0], audio: { music: "song", sfx: [{ track: "bang" }] } },
        ITEMS[1],
      ] as Item[],
      audio: {
        tracks: {
          song: { file: "song.mp3", durationSeconds: 1 },
          bang: { file: "bang.mp3", durationSeconds: 1 },
        },
      },
    });
    for (const tag of [null, file("de"), file("fr", ["a"])]) {
      expect(contentOf(manifest, tag)).toMatchObject({
        music: true,
        effects: true,
        any: true,
      });
    }
  });

  it("a fully recorded language needs no model where the base does", () => {
    const manifest = game({
      voices: { Mei: { file: "mei.flac" } },
      narrator: { file: "narrator.flac" },
    });
    expect(contentOf(manifest, null, true).needsModel).toBe(true);
    expect(contentOf(manifest, file("de", ["a", "b"]), true)).toMatchObject({
      needsModel: false,
      voice: true,
    });
    // Partly recorded: the rest is spoken live.
    expect(contentOf(manifest, file("de", ["a"]), true).needsModel).toBe(true);
  });
});

/** A content with the given answers. */
function content(over: Partial<SoundContent> = {}): SoundContent {
  const base = {
    music: false,
    effects: false,
    recordedVoice: false,
    needsModel: false,
    ...over,
  };
  const voice = over.voice ?? (base.recordedVoice || base.needsModel);
  return {
    ...base,
    voice,
    any: over.any ?? (base.music || base.effects || voice),
  };
}

const NONE = content();
const RECORDED = content({ recordedVoice: true });
const LIVE = content({ needsModel: true });
const MUSIC = content({ music: true });

function harness(initial: SoundContent, audio = true) {
  const calls: string[] = [];
  const controls = createSoundControls({
    initial,
    audio: () => audio,
    makeVoiceClient: () => calls.push("voice"),
    show: (shown) => calls.push(shown ? "show" : "hide"),
    onContent: (next) => calls.push(`content:${String(next.any)}`),
  });
  return { calls, controls };
}

describe("createSoundControls (the switch rule)", () => {
  it("at boot: shows with sound, calls nothing but the voice client when needed", () => {
    const quiet = harness(NONE);
    expect(quiet.controls.shown()).toBe(false);
    expect(quiet.calls).toEqual([]);
    const music = harness(MUSIC);
    expect(music.controls.shown()).toBe(true);
    expect(music.calls).toEqual([]);
    const live = harness(LIVE);
    expect(live.controls.shown()).toBe(true);
    expect(live.calls).toEqual(["voice"]);
  });

  it("a language whose voice gives sound brings the controls; back to the base takes them away", () => {
    const { calls, controls } = harness(NONE);
    controls.set(RECORDED);
    expect(controls.shown()).toBe(true);
    expect(calls).toEqual(["content:true", "show"]);
    calls.length = 0;
    controls.set(NONE);
    expect(controls.shown()).toBe(false);
    expect(calls).toEqual(["content:false", "hide"]);
  });

  it("a switch between languages that both have sound only updates the rows", () => {
    const { calls, controls } = harness(MUSIC);
    controls.set(content({ music: true, recordedVoice: true }));
    controls.set(MUSIC);
    expect(calls).toEqual(["content:true", "content:true"]);
    expect(controls.shown()).toBe(true);
  });

  it("makes the voice client once, when a language first needs the model", () => {
    const { calls, controls } = harness(RECORDED);
    controls.set(RECORDED);
    expect(calls).not.toContain("voice");
    calls.length = 0;
    controls.set(LIVE);
    // Made before the rows learn the new content, so the sheet finds it.
    expect(calls).toEqual(["voice", "content:true"]);
    controls.set(NONE);
    controls.set(LIVE);
    expect(calls.filter((call) => call === "voice")).toEqual(["voice"]);
  });

  it("never makes one in a game whose every language is recorded or silent", () => {
    const { calls, controls } = harness(RECORDED);
    for (const next of [NONE, RECORDED, MUSIC, NONE]) controls.set(next);
    expect(calls).not.toContain("voice");
  });

  it("shows nothing without a mounted sound", () => {
    const { calls, controls } = harness(MUSIC, false);
    expect(controls.shown()).toBe(false);
    controls.set(RECORDED);
    controls.set(NONE);
    expect(calls).not.toContain("show");
    expect(controls.shown()).toBe(false);
  });
});
