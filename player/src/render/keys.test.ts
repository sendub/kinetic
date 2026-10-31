import { describe, expect, it } from "vitest";

import { commandForKey } from "./keys";

describe("commandForKey", () => {
  it("maps space to advance and h to the text toggle", () => {
    expect(commandForKey(" ", false)).toBe("advance");
    expect(commandForKey("h", false)).toBe("toggleText");
    expect(commandForKey("H", false)).toBe("toggleText");
  });

  it("ignores a held key's auto-repeat so it cannot burst through items", () => {
    expect(commandForKey(" ", true)).toBeNull();
    expect(commandForKey("h", true)).toBeNull();
  });

  it("leaves keys owned by later phases unmapped", () => {
    // tab (skip), b/t/e and c join the map in later phases.
    for (const key of ["Tab", "b", "t", "e", "c", "Enter", "ArrowRight"]) {
      expect(commandForKey(key, false)).toBeNull();
    }
  });
});
