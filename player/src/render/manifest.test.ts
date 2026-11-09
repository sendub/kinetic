import { describe, expect, it, vi } from "vitest";

import {
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
