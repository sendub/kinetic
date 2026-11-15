// The player's own copy of Kinetic's version (version.ts): the repo's
// VERSION, through the build's `define` (vitest.config.mjs gives tests the
// same value; scripts/bundle.test.mjs checks the built bundle).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KINETIC_VERSION } from "./version.ts";

describe("KINETIC_VERSION", () => {
  it("is the repo's VERSION file", () => {
    const file = readFileSync(
      new URL("../../VERSION", import.meta.url),
      "utf8",
    );
    expect(KINETIC_VERSION).toBe(file.trim());
  });
});
