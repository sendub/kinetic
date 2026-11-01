import { describe, expect, it } from "vitest";
import type { TimelineCommands } from "./keys";
import {
  commandForKey,
  keyHelpEntries,
  mappedKeys,
  routeIndexForKey,
  suspendTimeline,
} from "./keys";

describe("commandForKey", () => {
  it("maps space to advance and h to the text toggle", () => {
    expect(commandForKey(" ", false)).toBe("advance");
    expect(commandForKey("h", false)).toBe("toggleText");
    expect(commandForKey("H", false)).toBe("toggleText");
  });

  it("maps tab to skip mode and e to the unseen jump (Phase 7)", () => {
    expect(commandForKey("Tab", false)).toBe("toggleSkip");
    expect(commandForKey("e", false)).toBe("jumpToEnd");
    expect(commandForKey("E", false)).toBe("jumpToEnd");
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

  it("maps a to auto-forward and Enter to closing help (Phase 13b)", () => {
    expect(commandForKey("a", false)).toBe("toggleAutoForward");
    expect(commandForKey("A", false)).toBe("toggleAutoForward");
    expect(commandForKey("Enter", false)).toBe("closeHelp");
  });

  it("ignores a held key's auto-repeat so it cannot burst through items", () => {
    expect(commandForKey(" ", true)).toBeNull();
    expect(commandForKey("h", true)).toBeNull();
    expect(commandForKey("Tab", true)).toBeNull();
    expect(commandForKey("e", true)).toBeNull();
    expect(commandForKey("b", true)).toBeNull();
    expect(commandForKey("t", true)).toBeNull();
    expect(commandForKey("c", true)).toBeNull();
    expect(commandForKey("a", true)).toBeNull();
    expect(commandForKey("Enter", true)).toBeNull();
    expect(commandForKey("Escape", true)).toBeNull();
  });

  it("leaves keys owned by later phases unmapped", () => {
    // c joined with Phase 9, a and Enter with Phase 13b's help; these
    // stay free (the arrow keys belong to nobody yet).
    for (const key of ["ArrowRight", "Shift"]) {
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

describe("routeIndexForKey (the decision overlay's 1..9, Phase 13)", () => {
  it("maps the digits to route indices 0..8", () => {
    expect(routeIndexForKey("1", false)).toBe(0); // index 0: a digit, not "absent"
    expect(routeIndexForKey("5", false)).toBe(4);
    expect(routeIndexForKey("9", false)).toBe(8);
  });

  it("leaves everything else — 0, letters, repeats — unmapped", () => {
    expect(routeIndexForKey("0", false)).toBeNull();
    expect(routeIndexForKey("a", false)).toBeNull();
    expect(routeIndexForKey("Enter", false)).toBeNull();
    expect(routeIndexForKey("1", true)).toBeNull();
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
        jumpToEnd: name("jumpToEnd"),
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
    gated.jumpToEnd();
    gated.wheelBack();
    gated.wheelForward();
    expect(calls).toEqual([
      "advance",
      "toggleSkip",
      "jumpToEnd",
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
    gated.jumpToEnd();
    gated.wheelBack();
    gated.wheelForward();
    expect(calls).toEqual([]);
    open = false; // closing the overlay resumes the timeline immediately
    gated.advance();
    gated.wheelBack();
    expect(calls).toEqual(["advance", "wheelBack"]);
  });
});

describe("keyHelpEntries (the help lists the map itself, Phase 13b)", () => {
  // The drift test docs/plan.md Phase 13b asks for: the keymap module is
  // the single source, so a key or command without a help row fails here
  // — the README's lost `a` bullet is exactly this drift, caught in code.
  function listedLabels(): Set<string> {
    return new Set(keyHelpEntries().flatMap((entry) => entry.keys));
  }

  it("lists every mapped key", () => {
    const listed = listedLabels();
    for (const key of mappedKeys()) {
      const label =
        key === " " ? "Space" : key.length === 1 ? key.toLowerCase() : key;
      expect(listed.has(label)).toBe(true);
    }
  });

  it("lists every command the map can issue, each with a description", () => {
    const commands = new Set(
      mappedKeys()
        .map((key) => commandForKey(key, false))
        .filter(
          (command): command is NonNullable<typeof command> => command !== null,
        ),
    );
    const entries = keyHelpEntries();
    for (const command of commands) {
      const row = entries.find((entry) => entry.command === command);
      expect(row).toBeDefined();
      expect((row?.description ?? "").length).toBeGreaterThan(0);
      expect(row?.keys.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("lists the wheel — not a key, but a control all the same", () => {
    expect(listedLabels().has("wheel")).toBe(true);
  });

  it("lists the decision digits and Enter — the choice overlay's own keys", () => {
    // The digits live outside KEY_TABLE (they carry a parameter and belong
    // to one context), so this row is the help's promise about them.
    expect(listedLabels().has("1-9 / Enter")).toBe(true);
  });
});
