// What an item's voice is in the language shown (render/linevoice.ts,
// docs/plan.md Phase 54 item 6): the rule's every branch, the tag-to-engine
// mapping and the per-language table the sound and the machine read.

import { describe, expect, it } from "vitest";
import type { Item, LanguageFile, Manifest } from "../machine/types";
import {
  createLineVoices,
  ENGINE_LANGUAGES,
  engineLanguage,
  languageTrackKey,
  lineVoice,
} from "./linevoice";
import { soundContent } from "./soundrows";

const CAST: Pick<Manifest, "voices" | "narrator"> = {
  voices: { Mei: { file: "voices/mei.flac" } },
  narrator: { file: "voices/narrator.flac" },
};

const ITEMS: Item[] = [
  { id: "pic", type: "image", file: "pic.jpg", text: "The harbour." },
  { id: "mei", type: "text", speaker: "Mei", text: "You're early." },
  {
    id: "rec",
    type: "text",
    speaker: "Mei",
    text: "Recorded.",
    audio: { voice: "rec-1" },
  },
  { id: "theo", type: "text", speaker: "Theo", text: "No voice." },
  {
    id: "theo-rec",
    type: "text",
    speaker: "Theo",
    text: "Recorded, no voice.",
    audio: { voice: "rec-2" },
  },
  {
    id: "thought",
    type: "text",
    speaker: "Mei",
    thought: true,
    text: "Hm.",
  },
  { id: "bare", type: "text", speaker: "Mei", text: "" },
];

const item = (id: string): Item => {
  const found = ITEMS.find((it) => it.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};

function file(
  language: string,
  extra: Partial<LanguageFile> = {},
): LanguageFile {
  return {
    language,
    items: {
      pic: { text: `${language}: Der Hafen.` },
      mei: { text: `${language}: Du bist früh.` },
      rec: { text: `${language}: Aufgenommen.` },
      theo: { text: `${language}: Keine Stimme.` },
      "theo-rec": { text: `${language}: Aufgenommen, keine Stimme.` },
      thought: { text: `${language}: Hm.` },
    },
    ...extra,
  };
}

const base = (tag = "en") => ({ base: tag, file: null });
const shown = (f: LanguageFile, tag = "en") => ({ base: tag, file: f });

describe("engineLanguage: a BCP 47 tag to the engine's language", () => {
  it("maps by the primary language subtag", () => {
    expect(engineLanguage("de")).toBe("de");
    expect(engineLanguage("de-AT")).toBe("de");
    expect(engineLanguage("ja")).toBe("ja");
    expect(engineLanguage("ar")).toBe("ar");
    expect(engineLanguage("zh-Hans")).toBe("zh");
    expect(engineLanguage("zh-Hant")).toBe("zh");
    expect(engineLanguage("pt-BR")).toBe("pt");
    expect(engineLanguage("pt-PT")).toBe("pt");
    expect(engineLanguage("es-419")).toBe("es");
  });

  it("knows Norwegian Bokmål and Nynorsk as the engine's Norwegian", () => {
    expect(engineLanguage("nb")).toBe("no");
    expect(engineLanguage("nn")).toBe("no");
    expect(engineLanguage("no")).toBe("no");
  });

  it("gives null for a language the engine does not speak", () => {
    for (const tag of ["vi", "uk", "fa", "ur", "th", "ca", "id", "bg"]) {
      expect(engineLanguage(tag)).toBeNull();
    }
    expect(engineLanguage("")).toBeNull();
    expect(engineLanguage("constructor")).toBeNull();
    expect(engineLanguage("toString")).toBeNull();
  });

  it("lists the engine's 23 languages", () => {
    expect(ENGINE_LANGUAGES).toHaveLength(23);
    for (const code of ENGINE_LANGUAGES) {
      expect(engineLanguage(code)).toBe(code);
    }
  });
});

describe("lineVoice with the base shown: the manifest's own rule", () => {
  it("plays an item's recording", () => {
    expect(lineVoice(item("rec"), CAST, base())).toEqual({
      kind: "recorded",
      track: "rec-1",
    });
  });

  it("speaks a line live in the base language's engine id", () => {
    expect(lineVoice(item("mei"), CAST, base())).toEqual({
      kind: "live",
      line: {
        voice: "speaker:Mei",
        text: "You're early.",
        lang: "en",
        key: "speaker:Mei\nen\nYou're early.",
      },
    });
    const german = lineVoice(item("pic"), CAST, base("de"));
    expect(german?.kind === "live" && german.line).toMatchObject({
      voice: "narrator",
      text: "The harbour.",
      lang: "de",
    });
  });

  it("is silent for a base the engine does not speak, a speaker with no voice, or no text", () => {
    expect(lineVoice(item("mei"), CAST, base("vi"))).toBeNull();
    expect(lineVoice(item("theo"), CAST, base())).toBeNull();
    expect(lineVoice(item("bare"), CAST, base())).toBeNull();
    expect(lineVoice(undefined, CAST, base())).toBeNull();
  });
});

describe("lineVoice with a translation shown", () => {
  it("plays the language file's own recording first, keyed apart", () => {
    const de = file("de", {
      keepOriginalVoice: true,
      voice: {
        tracks: {
          "rec-1": { file: "lang/de/lines/a.webm", durationSeconds: 2 },
        },
        items: { rec: "rec-1", mei: "rec-1" },
      },
    });
    expect(lineVoice(item("rec"), CAST, shown(de))).toEqual({
      kind: "recorded",
      track: languageTrackKey("de", "rec-1"),
    });
    expect(lineVoice(item("mei"), CAST, shown(de))).toEqual({
      kind: "recorded",
      track: "lang:de:rec-1",
    });
  });

  it("ignores a file recording whose track is missing or unusable", () => {
    for (const track of [
      undefined,
      { file: "../out.webm", durationSeconds: 2 },
      { file: "lang/de/a.webm", durationSeconds: 0 },
      { file: "lang/de/a.webm" },
    ]) {
      const de = file("de", {
        voice: {
          tracks: track === undefined ? {} : { t: track as never },
          items: { mei: "t" },
        },
      });
      expect(lineVoice(item("mei"), CAST, shown(de))?.kind).toBe("live");
    }
  });

  it("plays the base recording under the translation only with keepOriginalVoice", () => {
    const kept = file("de", { keepOriginalVoice: true });
    expect(lineVoice(item("rec"), CAST, shown(kept))).toEqual({
      kind: "recorded",
      track: "rec-1",
    });
    expect(lineVoice(item("theo-rec"), CAST, shown(kept))).toEqual({
      kind: "recorded",
      track: "rec-2",
    });
    // Without it: never the base recording; live in German, or silent.
    const plain = file("de");
    const live = lineVoice(item("rec"), CAST, shown(plain));
    expect(live?.kind === "live" && live.line).toMatchObject({
      text: "de: Aufgenommen.",
      lang: "de",
    });
    expect(lineVoice(item("theo-rec"), CAST, shown(plain))).toBeNull();
    expect(
      lineVoice(
        item("rec"),
        CAST,
        shown(file("de", { keepOriginalVoice: false })),
      ),
    ).toMatchObject({ kind: "live" });
  });

  it("speaks the shown text live in the file's language, a thought and the narrator too", () => {
    for (const [tag, code] of [
      ["de", "de"],
      ["ja", "ja"],
      ["ar", "ar"],
      ["pt-BR", "pt"],
      ["nb", "no"],
    ] as const) {
      const f = file(tag);
      expect(lineVoice(item("mei"), CAST, shown(f))).toEqual({
        kind: "live",
        line: {
          voice: "speaker:Mei",
          text: `${tag}: Du bist früh.`,
          lang: code,
          key: `speaker:Mei\n${code}\n${tag}: Du bist früh.`,
        },
      });
    }
    const thought = lineVoice(item("thought"), CAST, shown(file("de")));
    expect(thought?.kind === "live" && thought.line.voice).toBe("speaker:Mei");
    const pic = lineVoice(item("pic"), CAST, shown(file("de")));
    expect(pic?.kind === "live" && pic.line.voice).toBe("narrator");
    expect(lineVoice(item("theo"), CAST, shown(file("de")))).toBeNull();
    expect(
      lineVoice(item("pic"), { voices: CAST.voices }, shown(file("de"))),
    ).toBeNull();
  });

  it("is silent in a language the engine lacks, unless a recording plays", () => {
    const vi = file("vi");
    expect(lineVoice(item("mei"), CAST, shown(vi))).toBeNull();
    expect(lineVoice(item("rec"), CAST, shown(vi))).toBeNull();
    expect(
      lineVoice(
        item("rec"),
        CAST,
        shown(file("vi", { keepOriginalVoice: true })),
      ),
    ).toEqual({ kind: "recorded", track: "rec-1" });
    const own = file("vi", {
      voice: {
        tracks: { a: { file: "lang/vi/a.webm", durationSeconds: 1 } },
        items: { mei: "a" },
      },
    });
    expect(lineVoice(item("mei"), CAST, shown(own))).toEqual({
      kind: "recorded",
      track: "lang:vi:a",
    });
  });

  it("falls back to the base rule for a line the file lacks", () => {
    const partial: LanguageFile = { language: "de", items: {} };
    expect(lineVoice(item("rec"), CAST, shown(partial))).toEqual({
      kind: "recorded",
      track: "rec-1",
    });
    const live = lineVoice(item("mei"), CAST, shown(partial));
    expect(live?.kind === "live" && live.line).toMatchObject({
      text: "You're early.",
      lang: "en",
    });
    // A blank translation is no translation.
    const blank = file("de", { items: { mei: { text: "  " } } });
    const fell = lineVoice(item("mei"), CAST, shown(blank));
    expect(fell?.kind === "live" && fell.line.lang).toBe("en");
    // A file recording for an untranslated item never plays.
    const stray = file("de", {
      items: {},
      voice: {
        tracks: { a: { file: "lang/de/a.webm", durationSeconds: 1 } },
        items: { mei: "a" },
      },
    });
    expect(lineVoice(item("mei"), CAST, shown(stray))?.kind).toBe("live");
  });
});

describe("createLineVoices: one language's voices", () => {
  const manifest = {
    items: ITEMS,
    ...CAST,
    audio: { tracks: { "rec-1": { file: "r1.webm", durationSeconds: 1 } } },
  };

  it("keys the file's usable tracks apart and answers per item", () => {
    const de = file("de", {
      voice: {
        tracks: {
          "rec-1": { file: "lang/de/lines/a.webm", durationSeconds: 2 },
          bad: { file: "/abs.webm", durationSeconds: 2 },
        },
        items: { mei: "rec-1" },
      },
    });
    const voices = createLineVoices(manifest, de);
    expect(Object.keys(voices.tracks)).toEqual(["lang:de:rec-1"]);
    expect(voices.recorded(1)).toBe("lang:de:rec-1");
    expect(voices.live(1)).toBeNull();
    expect(voices.recorded(2)).toBeNull();
    expect(voices.live(2)?.text).toBe("de: Aufgenommen.");
    expect(voices.at(99)).toBeNull();
  });

  it("is the manifest's own for the base", () => {
    const voices = createLineVoices(manifest, null);
    expect(voices.tracks).toEqual({});
    expect(voices.recorded(2)).toBe("rec-1");
    expect(voices.live(1)?.lang).toBe("en");
    expect(
      createLineVoices({ ...manifest, language: "ja" }, null).live(1)?.lang,
    ).toBe("ja");
  });
});

describe("soundContent per language (the Voice row and the model)", () => {
  const manifest = {
    schemaVersion: 1,
    width: 10,
    height: 10,
    items: ITEMS,
    ...CAST,
    audio: {
      tracks: {
        "rec-1": { file: "r1.webm", durationSeconds: 1 },
        "rec-2": { file: "r2.webm", durationSeconds: 1 },
      },
    },
  } as Manifest;

  it("offers the model for a language with live lines, as for the base", () => {
    expect(soundContent(manifest, true).needsModel).toBe(true);
    const de = createLineVoices(manifest, file("de"));
    expect(soundContent(manifest, true, de)).toMatchObject({
      needsModel: true,
      voice: true,
    });
  });

  it("offers no model for a language whose every line is recorded", () => {
    const tracks: Record<string, { file: string; durationSeconds: number }> =
      {};
    const items: Record<string, string> = {};
    for (const id of ["pic", "mei", "rec", "thought"]) {
      tracks[id] = { file: `lang/de/${id}.webm`, durationSeconds: 1 };
      items[id] = id;
    }
    const de = createLineVoices(
      manifest,
      file("de", { voice: { tracks, items } }),
    );
    expect(soundContent(manifest, true, de)).toMatchObject({
      needsModel: false,
      recordedVoice: true,
      voice: true,
    });
  });

  it("has no Voice row in a language the engine lacks with nothing recorded", () => {
    const vi = createLineVoices(manifest, file("vi"));
    expect(soundContent(manifest, true, vi)).toMatchObject({
      needsModel: false,
      recordedVoice: false,
      voice: false,
    });
    const kept = createLineVoices(
      manifest,
      file("vi", { keepOriginalVoice: true }),
    );
    expect(soundContent(manifest, true, kept)).toMatchObject({
      needsModel: false,
      recordedVoice: true,
      voice: true,
    });
  });
});
