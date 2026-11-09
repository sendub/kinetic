import { afterEach, describe, expect, it, vi } from "vitest";
import type { Item } from "../machine/types";
import { parseUrlStart, takeUrlStart, type UrlStartPage } from "./urlstart";

// `index.html#start=<id>` (docs/plan.md Phase 46, item 3): the hash names
// the item the load opens at; once read it is removed, and an id the
// manifest lacks is warned about once.

const items: Item[] = ["intro", "middle", "late"].map((id) => ({
  id,
  type: "image",
  file: `${id}.jpg`,
}));

/** A page whose URL is `/game/index.html?v=2<hash>`, recording replaceState. */
function page(hash: string, replace?: () => void) {
  const calls: unknown[][] = [];
  const state = { kept: true };
  const fake: UrlStartPage = {
    location: { hash, pathname: "/game/index.html", search: "?v=2" },
    history: {
      state,
      replaceState: (...args: unknown[]) => {
        calls.push(args);
        replace?.();
      },
    },
  };
  return { fake, calls, state };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseUrlStart", () => {
  it("names a known item by id and position", () => {
    expect(parseUrlStart("#start=late", items)).toEqual({
      id: "late",
      index: 2,
    });
  });

  it("URL-decodes the id", () => {
    expect(parseUrlStart("#start=%6Diddle", items)).toEqual({
      id: "middle",
      index: 1,
    });
  });

  it("an id the manifest lacks is an unknown start (index -1)", () => {
    expect(parseUrlStart("#start=nope", items)).toEqual({
      id: "nope",
      index: -1,
    });
  });

  it("an id that does not decode is unknown, named as written", () => {
    expect(parseUrlStart("#start=%E0%A4%A", items)).toEqual({
      id: "%E0%A4%A",
      index: -1,
    });
  });

  it.each([
    ["no hash", ""],
    ["an empty hash", "#"],
    ["a different hash", "#chapter-2"],
    ["another key", "#begin=late"],
    ["a longer key", "#starts=late"],
    ["no value", "#start"],
    ["an empty id", "#start="],
  ])("%s is no start request", (_name, hash) => {
    expect(parseUrlStart(hash, items)).toBeNull();
  });
});

describe("takeUrlStart", () => {
  it("returns the start and removes the hash, keeping path, query and history state", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, calls, state } = page("#start=middle");
    expect(takeUrlStart(fake, items)).toEqual({ id: "middle", index: 1 });
    expect(calls).toEqual([[state, "", "/game/index.html?v=2"]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("an unknown id: one console warning naming it, and the hash removed too", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, calls } = page("#start=no-such-item");
    expect(takeUrlStart(fake, items)).toEqual({
      id: "no-such-item",
      index: -1,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[kinetic\] /);
    expect(String(warn.mock.calls[0][0])).toContain('"no-such-item"');
    expect(calls).toHaveLength(1);
  });

  it("a malformed or different hash is left alone, with no warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const hash of ["", "#chapter-2", "#start="]) {
      const { fake, calls } = page(hash);
      expect(takeUrlStart(fake, items)).toBeNull();
      expect(calls).toEqual([]);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("a history that refuses the change still opens at the item", () => {
    const { fake } = page("#start=late", () => {
      throw new Error("SecurityError");
    });
    expect(takeUrlStart(fake, items)).toEqual({ id: "late", index: 2 });
  });
});
