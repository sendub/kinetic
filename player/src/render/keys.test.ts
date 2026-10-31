import { describe, expect, it } from "vitest";

import { commandForKey } from "./keys";

describe("commandForKey", () => {
  it("maps space to advance and h to the text toggle", () => {
    expect(commandForKey(" ", false)).toBe("advance");
    expect(commandForKey("h", false)).toBe("toggleText");
    expect(commandForKey("H", false)).toBe("toggleText");
  });

  it("maps tab to skip mode and e to the unseen jump (Phase 7)", () => {
    expect(commandForKey("Tab", false)).toBe("toggleSkip");
    expect(commandForKey("e", false)).toBe("jumpToUnseen");
    expect(commandForKey("E", false)).toBe("jumpToUnseen");
  });

  it("maps b to the bookmark append (Phase 8)", () => {
    expect(commandForKey("b", false)).toBe("bookmark");
    expect(commandForKey("B", false)).toBe("bookmark");
  });

  it("ignores a held key's auto-repeat so it cannot burst through items", () => {
    expect(commandForKey(" ", true)).toBeNull();
    expect(commandForKey("h", true)).toBeNull();
    expect(commandForKey("Tab", true)).toBeNull();
    expect(commandForKey("e", true)).toBeNull();
    expect(commandForKey("b", true)).toBeNull();
  });

  it("leaves keys owned by later phases unmapped", () => {
    // t joins the map with Phase 8's overlay work, c with Phase 9.
    for (const key of ["t", "c", "Enter", "ArrowRight", "Shift"]) {
      expect(commandForKey(key, false)).toBeNull();
    }
  });

  it("never resolves a prototype key into a command", () => {
    // The table is a Map precisely so these stay null instead of finding
    // Object.prototype members.
    for (const key of ["constructor", "toString", "hasOwnProperty"]) {
      expect(commandForKey(key, false)).toBeNull();
    }
  });
});
