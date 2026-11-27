import { describe, expect, it, vi } from "vitest";

import {
  isLanguageTag,
  loadManifest,
  MANIFEST_URL,
  parseManifest,
  resolveMediaPath,
} from "./manifest";

// The page is the content folder's own index.html, so the folder root is what
// every declared media path resolves against — under `file://` exactly as
// `img.src = "<declared path>"` resolves it.
const ROOT = "file:///Users/reader/novels/demo/index.html";
const FOLDER = "file:///Users/reader/novels/demo/";

const MANIFEST = {
  schemaVersion: 1,
  width: 960,
  height: 540,
  items: [{ id: "a-001", type: "image", file: "a-001.jpg" }],
};

describe("loadManifest", () => {
  it("uses the embedded manifest without fetching", async () => {
    const fetchJson = vi.fn();
    const manifest = await loadManifest(
      { embedded: MANIFEST, fetchJson },
      ROOT,
    );
    expect(manifest.items).toHaveLength(1);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("fetches manifest.json when nothing is embedded", async () => {
    const fetchJson = vi.fn(async () => MANIFEST);
    const manifest = await loadManifest(
      { embedded: undefined, fetchJson },
      ROOT,
    );
    expect(fetchJson).toHaveBeenCalledWith(MANIFEST_URL);
    expect(manifest.width).toBe(960);
  });

  it("treats an embedded null as absent, like ?? does", async () => {
    const fetchJson = vi.fn(async () => MANIFEST);
    await loadManifest({ embedded: null, fetchJson }, ROOT);
    expect(fetchJson).toHaveBeenCalledWith(MANIFEST_URL);
  });

  it("surfaces a fetch failure to the caller", async () => {
    const fetchJson = vi.fn(async () => {
      throw new Error("file:// refused the fetch");
    });
    await expect(
      loadManifest({ embedded: null, fetchJson }, ROOT),
    ).rejects.toThrow("file:// refused the fetch");
  });
});

describe("parseManifest", () => {
  it("accepts an empty manifest — a bare bundle has no content", () => {
    const empty = { schemaVersion: 1, width: 1, height: 1, items: [] };
    expect(parseManifest(empty, ROOT)).toBe(empty);
  });

  it.each([
    ["a non-object", "not json"],
    ["a null", null],
    [
      "another schemaVersion",
      { schemaVersion: 2, width: 1, height: 1, items: [] },
    ],
    ["no items array", { schemaVersion: 1, width: 1, height: 1, items: null }],
    ["no display size", { schemaVersion: 1, width: 0, height: 540, items: [] }],
  ])("rejects %s", (_label, value) => {
    expect(() => parseManifest(value, ROOT)).toThrow();
  });

  it("keeps the game's title and version as written (Phase 51 item 3)", () => {
    const manifest = parseManifest(
      { ...MANIFEST, title: "Rainy Day", version: "0.9 beta" },
      ROOT,
    );
    expect(manifest.title).toBe("Rainy Day");
    expect(manifest.version).toBe("0.9 beta");
    expect(parseManifest(MANIFEST, ROOT).version).toBeUndefined();
  });

  // A bad `version`, like a bad `title`, never stops the game: the
  // validator reports it, and the Esc screen shows no version for it.
  it.each([
    ["blank", "   "],
    ["empty", ""],
    ["not text", 1.2],
    ["over 40 characters", "x".repeat(41)],
  ])("loads a manifest whose version is %s", (_label, version) => {
    expect(() =>
      parseManifest({ ...MANIFEST, title: 7, version }, ROOT),
    ).not.toThrow();
  });

  // kinetic-extract's manifest opens with `$schema` (Phase 51 item 5):
  // for an author's editor, never read by the player, whatever it holds.
  it.each([
    ["the schema copy", "./manifest.schema.json"],
    ["a URL", "https://example.invalid/schema.json"],
    ["not text", 7],
  ])("loads a manifest whose $schema is %s", (_label, value) => {
    const manifest = parseManifest({ $schema: value, ...MANIFEST }, ROOT);
    expect(manifest.items).toEqual(MANIFEST.items);
    expect(manifest.width).toBe(960);
  });

  // The schema-version policy (docs/content-format.md, "Schema version"):
  // a field this player does not know, at the top level or on an item,
  // is ignored rather than refused.
  it("ignores top-level and item fields it does not know", () => {
    const manifest = parseManifest(
      {
        ...MANIFEST,
        laterTopLevelField: { any: "shape" },
        items: [{ ...MANIFEST.items[0], laterItemField: [1, 2] }],
      },
      ROOT,
    );
    expect(manifest.items[0]).toMatchObject(MANIFEST.items[0]);
  });
});

// A game's languages (docs/content-format.md, "Translations"; Phase 56
// item 1): `language` is the base, `languages` the language files present.
// Bad values play as if absent, as a bad title does: the folder still
// plays in its base language.
describe("parseManifest languages", () => {
  it("keeps a valid language and languages, returning the same object", () => {
    const value = {
      ...MANIFEST,
      language: "ja",
      languages: ["en", "zh-Hans", "pt-BR", "es-419", "sr-Latn-RS"],
    };
    const manifest = parseManifest(value, ROOT);
    expect(manifest).toBe(value);
    expect(manifest.language).toBe("ja");
    expect(manifest.languages).toEqual([
      "en",
      "zh-Hans",
      "pt-BR",
      "es-419",
      "sr-Latn-RS",
    ]);
  });

  it("leaves both absent when the manifest has neither", () => {
    const manifest = parseManifest(MANIFEST, ROOT);
    expect(manifest.language).toBeUndefined();
    expect(manifest.languages).toBeUndefined();
  });

  it.each([
    ["not text", 7],
    ["not canonical", "EN"],
    ["an underscore tag", "pt_BR"],
    ["a name, not a tag", "english"],
    ["empty", ""],
  ])("drops a language that is %s", (_label, language) => {
    const value = { ...MANIFEST, language, languages: ["de"] };
    const manifest = parseManifest(value, ROOT);
    expect(manifest.language).toBeUndefined();
    expect(manifest.languages).toEqual(["de"]);
    expect(value.language).toBe(language); // the input is not changed
  });

  it("keeps only canonical tags in languages, each once, never the base", () => {
    const languages = ["de", "DE", "pt-br", 3, "fr", "de", "en", "x"];
    const value = { ...MANIFEST, languages };
    const manifest = parseManifest(value, ROOT);
    expect(manifest.languages).toEqual(["de", "fr"]);
    expect(value.languages).toBe(languages);
    expect(languages).toHaveLength(8);
  });

  it("measures the base against language when it is given", () => {
    const manifest = parseManifest(
      { ...MANIFEST, language: "de", languages: ["de", "en"] },
      ROOT,
    );
    expect(manifest.languages).toEqual(["en"]);
  });

  it.each([
    ["a string", "de"],
    ["an object", { de: true }],
    ["null", null],
  ])("drops languages that is %s", (_label, languages) => {
    const manifest = parseManifest({ ...MANIFEST, languages }, ROOT);
    expect(manifest.languages).toBeUndefined();
    expect(manifest.items).toEqual(MANIFEST.items);
  });

  it.each([
    ["de", true],
    ["zh-Hant", true],
    ["es-419", true],
    ["de-CH-1996", true],
    ["zh-hans", false],
    ["pt-br", false],
    ["e", false],
    ["deutsch", false],
    ["de-", false],
  ])("isLanguageTag(%s) is %s", (tag, ok) => {
    expect(isLanguageTag(tag)).toBe(ok);
  });
});

/**
 * Media paths below the folder root (docs/plan.md Phases 17, 25): the converter
 * buckets media into subfolders, so `file` / `poster` / `frames[]` may name a
 * path. The declared value is what reaches the DOM (the LRU key and the
 * decoded-image bookkeeping ride on it); what the parse step guarantees is
 * that this value resolves to a file INSIDE the folder it was loaded from.
 */
describe("media path resolution", () => {
  const bucketed = {
    schemaVersion: 1,
    width: 960,
    height: 540,
    items: [
      { id: "meadow-001", type: "image", file: "meadow-001.jpg" },
      { id: "window-004", type: "image", file: "media/ab/window-004.jpg" },
      {
        id: "intro-006",
        type: "video",
        file: "media/cd/intro-006.mp4",
        poster: "media/cd/intro-006.poster.jpg",
        durationSeconds: 2,
      },
      {
        id: "spark-005",
        type: "animation",
        frames: ["media/ef/spark-005.f000.jpg", "media/ef/spark-005.f001.jpg"],
        fps: 8,
        loopCount: 2,
      },
    ],
  };

  it("accepts bucket subpaths and keeps them as declared", () => {
    expect(parseManifest(bucketed, ROOT)).toBe(bucketed);
  });

  it("resolves each declared path to a file inside the content folder", () => {
    parseManifest(bucketed, ROOT);
    const declared = [
      "meadow-001.jpg",
      "media/ab/window-004.jpg",
      "media/cd/intro-006.mp4",
      "media/cd/intro-006.poster.jpg",
      "media/ef/spark-005.f000.jpg",
      "media/ef/spark-005.f001.jpg",
    ];
    for (const path of declared) {
      // Same answer the browser gives the `src` the renderer assigns.
      expect(resolveMediaPath(path, ROOT)).toBe(new URL(path, ROOT).href);
      expect(resolveMediaPath(path, ROOT)).toBe(`${FOLDER}${path}`);
    }
  });

  it("checks a held video's lastFrame as it checks its poster (Phase 60 item 9n4)", () => {
    const held = (lastFrame: string) => ({
      schemaVersion: 1,
      width: 960,
      height: 540,
      items: [
        {
          id: "once-007",
          type: "video",
          file: "media/cd/once-007.mp4",
          poster: "media/cd/once-007.poster.jpg",
          lastFrame,
          holdLastFrame: true,
          durationSeconds: 2,
        },
      ],
    });
    const good = held("media/cd/once-007.last.jpg");
    expect(parseManifest(good, ROOT)).toBe(good);
    expect(() => parseManifest(held("../once-007.last.jpg"), ROOT)).toThrow(
      /media path /,
    );
  });

  it("resolves against the folder root when the page URL is the directory", () => {
    expect(resolveMediaPath("media/ab/window-004.jpg", FOLDER)).toBe(
      `${FOLDER}media/ab/window-004.jpg`,
    );
  });

  it.each([
    ["an absolute path", "/window-004.jpg"],
    ["a parent segment", "../window-004.jpg"],
    ["a parent segment in a subpath", "media/../window-004.jpg"],
    ["a backslash path", "assets\\ab\\window-004.jpg"],
    ["a drive letter", "C:/novels/demo/window-004.jpg"],
    ["an empty segment", "media//window-004.jpg"],
    ["a dot-leading segment", "./window-004.jpg"],
    ["whitespace", "media/ab/window 004.jpg"],
  ])("rejects %s as an item file", (_label, file) => {
    const manifest = {
      schemaVersion: 1,
      width: 960,
      height: 540,
      items: [{ id: "window-004", type: "image", file }],
    };
    expect(() => parseManifest(manifest, ROOT)).toThrow(/media path /);
  });

  it("names the item whose media path cannot resolve", () => {
    const manifest = {
      schemaVersion: 1,
      width: 960,
      height: 540,
      items: [
        { id: "meadow-001", type: "image", file: "meadow-001.jpg" },
        { id: "window-004", type: "image", file: "../window-004.jpg" },
      ],
    };
    expect(() => parseManifest(manifest, ROOT)).toThrow(/^items\[1\]: /);
  });
});

/**
 * Track files (docs/content-format.md, "Audio"): `audio.tracks.<id>.file`
 * is a media path like an item's `file`, checked the same way and kept as
 * declared; the item `audio` fields name tracks by id and hold no paths.
 */
describe("audio track paths", () => {
  function withTrack(file: string) {
    return {
      schemaVersion: 1,
      width: 960,
      height: 540,
      audio: {
        tracks: {
          theme: { file: "media/ab/theme.m4a", durationSeconds: 184.2 },
          door: { file, durationSeconds: 1.4 },
        },
      },
      items: [
        {
          id: "street-001",
          type: "image",
          file: "street-001.jpg",
          audio: { music: "theme", sfx: [{ track: "door", delayMs: 400 }] },
        },
      ],
    };
  }

  it("accepts track files at bucket subpaths and keeps them as declared", () => {
    const manifest = withTrack("door.mp3");
    const parsed = parseManifest(manifest, ROOT);
    expect(parsed).toBe(manifest);
    expect(parsed.audio?.tracks.theme.file).toBe("media/ab/theme.m4a");
    expect(parsed.items[0].audio?.music).toBe("theme");
  });

  it.each([
    ["an absolute path", "/door.mp3"],
    ["a parent segment", "media/../door.mp3"],
    ["a backslash path", "media\\door.mp3"],
    ["a URL scheme", "https://example.com/door.mp3"],
    ["whitespace", "media/door 1.mp3"],
  ])("rejects %s as a track file, naming the track", (_label, file) => {
    expect(() => parseManifest(withTrack(file), ROOT)).toThrow(
      /^audio\.tracks\.door: media path /,
    );
  });

  it("rejects an audio object without a tracks object", () => {
    const manifest = { ...withTrack("door.mp3"), audio: { tracks: [] } };
    expect(() => parseManifest(manifest, ROOT)).toThrow(/audio\.tracks/);
  });
});

/**
 * Voices (docs/content-format.md, "Voices"): each `voices.<speaker>.file`
 * and `narrator.file` is a reference clip's media path, checked like a
 * track's `file` and kept as declared.
 */
describe("voice reference clip paths", () => {
  function withVoices(mei: string, narrator = "media/vo/narrator.flac") {
    return {
      schemaVersion: 1,
      width: 960,
      height: 540,
      voices: {
        Mei: {
          file: mei,
          text: "The tide is coming in early tonight.",
          description: "A bright, quick young woman.",
        },
        "Old Theo": { file: "voices/theo.wav" },
      },
      narrator: { file: narrator },
      items: [
        {
          id: "street-001",
          type: "image",
          file: "street-001.jpg",
          speaker: "Mei",
          text: "You're early today.",
        },
      ],
    };
  }

  it("accepts voice files at subpaths and keeps them as declared", () => {
    const manifest = withVoices("voices/mei.flac");
    const parsed = parseManifest(manifest, ROOT);
    expect(parsed).toBe(manifest);
    expect(parsed.voices?.Mei.file).toBe("voices/mei.flac");
    expect(parsed.voices?.Mei.text).toBe(
      "The tide is coming in early tonight.",
    );
    expect(parsed.narrator?.file).toBe("media/vo/narrator.flac");
  });

  it.each([
    ["an absolute path", "/mei.flac"],
    ["a parent segment", "voices/../mei.flac"],
    ["a backslash path", "voices\\mei.flac"],
    ["a URL scheme", "https://example.com/mei.flac"],
    ["whitespace", "voices/mei 1.flac"],
  ])("rejects %s as a voice file, naming the speaker", (_label, file) => {
    expect(() => parseManifest(withVoices(file), ROOT)).toThrow(
      /^voices\.Mei: media path /,
    );
    expect(() =>
      parseManifest(withVoices("voices/mei.flac", file), ROOT),
    ).toThrow(/^narrator: media path /);
  });

  it("rejects a voices value that is not an object of voices", () => {
    const manifest = { ...withVoices("voices/mei.flac"), voices: [] };
    expect(() => parseManifest(manifest, ROOT)).toThrow(/^voices /);
  });
});
