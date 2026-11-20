// testing/scratch.mjs: where the testing library keeps browser profiles
// and crash dumps, in a checkout and in the copy an installed Kinetic
// carries (the same folders converter/kinetic_extract/paths.py names;
// converter/tests/test_paths.py checks those).
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALLED, scratchDir, userCacheDir } from "./scratch.mjs";

const home = join("/", "home", "reader");

describe("userCacheDir", () => {
  it("is KINETIC_HOME/cache when KINETIC_HOME is set, ~ expanded", () => {
    expect(userCacheDir({ KINETIC_HOME: "/k" }, "darwin", home)).toBe(
      join("/k", "cache"),
    );
    expect(userCacheDir({ KINETIC_HOME: "~/k" }, "linux", home)).toBe(
      join(home, "k", "cache"),
    );
  });

  it("is each system's own cache folder otherwise", () => {
    expect(userCacheDir({}, "darwin", home)).toBe(
      join(home, "Library", "Caches", "Kinetic"),
    );
    expect(userCacheDir({ LOCALAPPDATA: "/local" }, "win32", home)).toBe(
      join("/local", "Kinetic", "Cache"),
    );
    expect(userCacheDir({}, "win32", home)).toBe(
      join(home, "AppData", "Local", "Kinetic", "Cache"),
    );
    expect(userCacheDir({ XDG_CACHE_HOME: "/xdg" }, "linux", home)).toBe(
      join("/xdg", "kinetic"),
    );
    expect(userCacheDir({}, "linux", home)).toBe(
      join(home, ".cache", "kinetic"),
    );
  });
});

describe("scratchDir", () => {
  it("is the checkout's .tmp in a checkout", () => {
    expect(INSTALLED).toBe(false);
    expect(scratchDir({ env: {} })).toMatch(/[\\/]\.tmp$/);
  });

  it("is check/ in the per-user cache when installed", () => {
    expect(
      scratchDir({ env: {}, installed: true, system: "darwin", home }),
    ).toBe(join(home, "Library", "Caches", "Kinetic", "check"));
    expect(
      scratchDir({ env: { KINETIC_HOME: "/k" }, installed: true, home }),
    ).toBe(join("/k", "cache", "check"));
  });

  it("is KINETIC_SCRATCH_DIR when set, either way", () => {
    for (const installed of [false, true]) {
      expect(
        scratchDir({ env: { KINETIC_SCRATCH_DIR: "/s" }, installed }),
      ).toBe("/s");
    }
  });
});
