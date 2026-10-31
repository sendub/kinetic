import { describe, expect, it } from "vitest";
import type { TimelineCommands } from "./keys";
import { commandForKey, suspendTimeline } from "./keys";

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

  it("maps t to the bookmark overlay and Escape closes it (Phase 8)", () => {
    expect(commandForKey("t", false)).toBe("toggleBookmarks");
    expect(commandForKey("T", false)).toBe("toggleBookmarks");
    expect(commandForKey("Escape", false)).toBe("dismissOverlay");
  });

  it("maps c to the config screen (Phase 9)", () => {
    expect(commandForKey("c", false)).toBe("toggleConfig");
    expect(commandForKey("C", false)).toBe("toggleConfig");
  });

  it("ignores a held key's auto-repeat so it cannot burst through items", () => {
    expect(commandForKey(" ", true)).toBeNull();
    expect(commandForKey("h", true)).toBeNull();
    expect(commandForKey("Tab", true)).toBeNull();
    expect(commandForKey("e", true)).toBeNull();
    expect(commandForKey("b", true)).toBeNull();
    expect(commandForKey("t", true)).toBeNull();
    expect(commandForKey("c", true)).toBeNull();
    expect(commandForKey("Escape", true)).toBeNull();
  });

  it("leaves keys owned by later phases unmapped", () => {
    // c joined the map with Phase 9's config screen; these stay free.
    for (const key of ["Enter", "ArrowRight", "Shift"]) {
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

describe("suspendTimeline (the t overlay takes precedence, Phase 8)", () => {
  function spy(): { calls: string[]; commands: TimelineCommands } {
    const calls: string[] = [];
    const name = (label: string) => () => calls.push(label);
    return {
      calls,
      commands: {
        advance: name("advance"),
        toggleSkip: name("toggleSkip"),
        jumpToUnseen: name("jumpToUnseen"),
        wheelBack: name("wheelBack"),
        wheelForward: name("wheelForward"),
      },
    };
  }

  it("runs every command while the overlay is closed", () => {
    const { calls, commands } = spy();
    const open = false;
    const gated = suspendTimeline(commands, () => open);
    gated.advance();
    gated.toggleSkip();
    gated.jumpToUnseen();
    gated.wheelBack();
    gated.wheelForward();
    expect(calls).toEqual([
      "advance",
      "toggleSkip",
      "jumpToUnseen",
      "wheelBack",
      "wheelForward",
    ]);
  });

  it("swallows every timeline command while the overlay is open", () => {
    const { calls, commands } = spy();
    let open = true;
    const gated = suspendTimeline(commands, () => open);
    gated.advance();
    gated.toggleSkip();
    gated.jumpToUnseen();
    gated.wheelBack();
    gated.wheelForward();
    expect(calls).toEqual([]);
    open = false; // closing the overlay resumes the timeline immediately
    gated.advance();
    gated.wheelBack();
    expect(calls).toEqual(["advance", "wheelBack"]);
  });
});
