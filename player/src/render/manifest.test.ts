import { describe, expect, it, vi } from "vitest";

import { loadManifest, MANIFEST_URL, parseManifest } from "./manifest";

const MANIFEST = {
  schemaVersion: 1,
  width: 960,
  height: 540,
  items: [{ id: "a-001", type: "image", file: "a-001.jpg" }],
};

describe("loadManifest", () => {
  it("uses the embedded manifest without fetching", async () => {
    const fetchJson = vi.fn();
    const manifest = await loadManifest({ embedded: MANIFEST, fetchJson });
    expect(manifest.items).toHaveLength(1);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("fetches manifest.json when nothing is embedded", async () => {
    const fetchJson = vi.fn(async () => MANIFEST);
    const manifest = await loadManifest({ embedded: undefined, fetchJson });
    expect(fetchJson).toHaveBeenCalledWith(MANIFEST_URL);
    expect(manifest.width).toBe(960);
  });

  it("treats an embedded null as absent, like ?? does", async () => {
    const fetchJson = vi.fn(async () => MANIFEST);
    await loadManifest({ embedded: null, fetchJson });
    expect(fetchJson).toHaveBeenCalledWith(MANIFEST_URL);
  });

  it("surfaces a fetch failure to the caller", async () => {
    const fetchJson = vi.fn(async () => {
      throw new Error("file:// refused the fetch");
    });
    await expect(loadManifest({ embedded: null, fetchJson })).rejects.toThrow(
      "file:// refused the fetch",
    );
  });
});

describe("parseManifest", () => {
  it("accepts an empty manifest — a bare bundle has no content", () => {
    const empty = { schemaVersion: 1, width: 1, height: 1, items: [] };
    expect(parseManifest(empty)).toBe(empty);
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
    expect(() => parseManifest(value)).toThrow();
  });
});
