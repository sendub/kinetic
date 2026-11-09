import { describe, expect, it } from "vitest";
import type {
  DecisionKey,
  KeyCommand,
  KeyCommands,
  TimelineCommands,
} from "./keys";
import {
  CLICKABLE_HELP_COMMANDS,
  commandForKey,
  decisionKeyFor,
  installKeyMap,
  keyHelpEntries,
  mapKeyAction,
  mappedKeys,
  routeIndexForKey,
  suspendTimeline,
  UNLISTED_COMMANDS,
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

  it("maps nothing to t: the bookmarks live on the branch map (Phase 35)", () => {
    expect(commandForKey("t", false)).toBeNull();
    expect(commandForKey("T", false)).toBeNull();
    expect(mappedKeys()).not.toContain("t");
    expect(mappedKeys()).not.toContain("T");
    expect(commandForKey("Escape", false)).toBe("dismissOverlay");
  });

  it("maps nothing to c: the settings live on the Esc screen (Phase 26)", () => {
    expect(commandForKey("c", false)).toBeNull();
    expect(commandForKey("C", false)).toBeNull();
    const esc = keyHelpEntries().find((e) => e.command === "dismissOverlay");
    expect(esc?.description).toBe(
      "this screen: keys and settings; closes the map",
    );
    for (const entry of keyHelpEntries()) {
      expect(entry.description).not.toMatch(/\bc\b/);
    }
  });

  it("maps a to auto-forward (Phase 13b)", () => {
    expect(commandForKey("a", false)).toBe("toggleAutoForward");
    expect(commandForKey("A", false)).toBe("toggleAutoForward");
  });

  it("maps no command to Enter — one key per action (Phase 18)", () => {
    // "enter was never something I requested": help closes with Esc or
    // Space, the return row is 0, the reset box is y or a click. Enter's
    // one job is at a decision: picking the row cursor's row (long lists).
    expect(commandForKey("Enter", false)).toBeNull();
    expect(decisionKeyFor("Enter", false)).toBe("pick");
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
    expect(commandForKey("Escape", true)).toBeNull();
  });

  it("leaves keys owned by later phases unmapped", () => {
    // c joined with Phase 9, a with Phase 13b's help; these stay free
    // (the arrows are no command: only a decision's row cursor reads them).
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

describe("decisionKeyFor (1..9 pick a route, 0 returns — Phase 18)", () => {
  it("passes the route digits through as indices", () => {
    expect(decisionKeyFor("1", false)).toBe(0);
    expect(decisionKeyFor("9", false)).toBe(8);
  });

  it("maps 0 to the return row", () => {
    expect(decisionKeyFor("0", false)).toBe("return");
  });

  it("ignores repeats and every other key", () => {
    expect(decisionKeyFor("0", true)).toBeNull();
    expect(decisionKeyFor("1", true)).toBeNull();
    expect(decisionKeyFor("a", false)).toBeNull();
    expect(decisionKeyFor("Enter", true)).toBeNull();
    expect(decisionKeyFor("ArrowLeft", false)).toBeNull();
  });

  it("moves the row cursor with the arrows, held or not, and Enter picks", () => {
    // Long lists: rows past nine have no digit, so the arrows reach them.
    expect(decisionKeyFor("ArrowUp", false)).toBe("prev");
    expect(decisionKeyFor("ArrowDown", false)).toBe("next");
    expect(decisionKeyFor("ArrowDown", true)).toBe("next");
    expect(decisionKeyFor("ArrowUp", true)).toBe("prev");
    expect(decisionKeyFor("Enter", false)).toBe("pick");
  });
});

/** A keydown event as the browser sends it: cancelable, with `repeat`. */
function keydown(key: string, repeat: boolean): Event {
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key, repeat });
  return event;
}

describe("installKeyMap's decision keys (long lists)", () => {
  function press(
    taking: boolean,
    key: string,
    repeat = false,
  ): { got: DecisionKey[]; prevented: boolean } {
    const target = new EventTarget();
    const got: DecisionKey[] = [];
    const commands = new Proxy({} as KeyCommands, {
      get: () => () => {},
    });
    installKeyMap(target, commands, {
      taking: () => taking,
      take: (decision) => got.push(decision),
    });
    const event = keydown(key, repeat);
    target.dispatchEvent(event);
    return { got, prevented: event.defaultPrevented };
  }

  it("hands the arrows and Enter to the decision callback", () => {
    expect(press(true, "ArrowDown").got).toEqual(["next"]);
    expect(press(true, "ArrowUp").got).toEqual(["prev"]);
    expect(press(true, "Enter").got).toEqual(["pick"]);
  });

  it("prevents a key's default only while a choice takes it", () => {
    // No choice open: Enter must still activate a focused settings button.
    expect(press(false, "Enter")).toEqual({ got: [], prevented: false });
    expect(press(true, "Enter").prevented).toBe(true);
    expect(press(true, "3").prevented).toBe(true);
  });

  it("takes a held digit, 0 or Enter's repeats while a choice is open, picking nothing", () => {
    for (const key of ["3", "0", "Enter"]) {
      expect(press(true, key, true)).toEqual({ got: [], prevented: true });
    }
  });

  it("walks the row cursor on a held arrow's repeats, each one taken", () => {
    expect(press(true, "ArrowDown", true)).toEqual({
      got: ["next"],
      prevented: true,
    });
    expect(press(true, "ArrowUp", true)).toEqual({
      got: ["prev"],
      prevented: true,
    });
  });

  it("leaves a held decision key's repeats to the page with no choice open", () => {
    // The Esc screen: a held Enter keeps activating its focused control.
    for (const key of ["Enter", "3", "0", "ArrowDown"]) {
      expect(press(false, key, true)).toEqual({ got: [], prevented: false });
    }
  });
});

describe("installKeyMap's held keys", () => {
  function hold(key: string, repeats: number) {
    const target = new EventTarget();
    const ran: KeyCommand[] = [];
    const commands = new Proxy({} as KeyCommands, {
      get: (_, name) => () => ran.push(name as KeyCommand),
    });
    installKeyMap(target, commands, {
      taking: () => false,
      take: () => {},
    });
    const prevented: boolean[] = [];
    for (let n = 0; n <= repeats; n += 1) {
      const event = keydown(key, n > 0);
      target.dispatchEvent(event);
      prevented.push(event.defaultPrevented);
    }
    return { ran, prevented };
  }

  it("takes every repeat of every mapped key, running its command once", () => {
    for (const key of mappedKeys()) {
      const { ran, prevented } = hold(key, 4);
      expect(ran).toEqual([commandForKey(key, false)]);
      expect(prevented).toEqual([true, true, true, true, true]);
    }
  });

  it("takes a held Escape, Space and Tab (the macOS app's fullscreen keys)", () => {
    expect(hold("Escape", 3)).toEqual({
      ran: ["dismissOverlay"],
      prevented: [true, true, true, true],
    });
    expect(hold(" ", 3).prevented).toEqual([true, true, true, true]);
    expect(hold("Tab", 3).prevented).toEqual([true, true, true, true]);
  });

  it("leaves an unmapped key's presses and repeats to the page", () => {
    for (const key of ["t", "z", "ArrowLeft", "F5"]) {
      expect(hold(key, 2)).toEqual({
        ran: [],
        prevented: [false, false, false],
      });
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

  it("lists every mapped key except the reset box's own", () => {
    const listed = listedLabels();
    for (const key of mappedKeys()) {
      const command = commandForKey(key, false);
      if (command !== null && UNLISTED_COMMANDS.has(command)) continue;
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
      if (UNLISTED_COMMANDS.has(command)) continue;
      const row = entries.find((entry) => entry.command === command);
      expect(row).toBeDefined();
      expect((row?.description ?? "").length).toBeGreaterThan(0);
      expect(row?.keys.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("lists the wheel — not a key, but a control all the same", () => {
    expect(listedLabels().has("wheel")).toBe(true);
  });

  it("lists the decision digits and 0 — the choice overlay's own keys", () => {
    // The digits live outside KEY_TABLE (they carry a parameter and belong
    // to one context), so this row is the help's promise about them.
    expect(listedLabels().has("1-9 0 ↑↓ Enter")).toBe(true);
  });

  it("shows only the main interaction keys, one line each (Phase 18)", () => {
    // "highlight and focus on the main interaction keys ... no need to
    // mention the keys used during the reset process."
    expect(keyHelpEntries().map((entry) => entry.keys.join(" / "))).toEqual([
      "Space",
      "wheel",
      "e",
      "u",
      "Tab",
      "a",
      "h",
      "b",
      "m",
      "Escape",
      "1-9 0 ↑↓ Enter",
    ]);
    const listed = listedLabels();
    for (const gone of ["y", "n"]) expect(listed.has(gone)).toBe(false);
    for (const command of UNLISTED_COMMANDS) {
      expect(keyHelpEntries().some((entry) => entry.command === command)).toBe(
        false,
      );
    }
    // One short line each: no row wraps into a paragraph.
    for (const entry of keyHelpEntries()) {
      expect(entry.description.length).toBeLessThanOrEqual(56);
    }
  });
});

describe("the Esc screen's controls", () => {
  it("only the m row of the Esc screen is a control (t is gone, Phase 35)", () => {
    expect([...CLICKABLE_HELP_COMMANDS]).toEqual(["toggleMap"]);
  });

  it("names the m row's screen without telling the reader to click (Phase 36)", () => {
    const row = keyHelpEntries().find((e) => e.command === "toggleMap");
    expect(row?.description).toBe("branch map and bookmarks");
  });
});

describe("mapKeyAction (m, the branch map; Phase 31)", () => {
  const closedAll = {
    confirmOpen: false,
    helpOpen: false,
    mapOpen: false,
  };

  it("m and M both map to the map toggle", () => {
    expect(commandForKey("m", false)).toBe("toggleMap");
    expect(commandForKey("M", false)).toBe("toggleMap");
    expect(commandForKey("m", true)).toBeNull();
  });

  it("toggles the map over the story", () => {
    expect(mapKeyAction(closedAll)).toBe("open");
    expect(mapKeyAction({ ...closedAll, mapOpen: true })).toBe("close");
  });

  it("over the Esc screen replaces it, so the next Escape returns to the game", () => {
    expect(mapKeyAction({ ...closedAll, helpOpen: true })).toBe("replaceHelp");
  });

  it("is inert under the reset box, whatever else is up", () => {
    for (const helpOpen of [false, true])
      expect(mapKeyAction({ ...closedAll, helpOpen, confirmOpen: true })).toBe(
        "none",
      );
  });
});
