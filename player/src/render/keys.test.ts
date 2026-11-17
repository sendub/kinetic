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
  SEGMENT_COMMANDS,
  SOUND_COMMANDS,
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

  it("maps v to sound on / off, and ignores its repeats (Phase 47)", () => {
    expect(commandForKey("v", false)).toBe("toggleSound");
    expect(commandForKey("V", false)).toBe("toggleSound");
    expect(commandForKey("v", true)).toBeNull();
    expect([...SOUND_COMMANDS]).toEqual(["toggleSound"]);
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
    // (Up and Down are no command: only a decision's row cursor reads them).
    for (const key of ["ArrowUp", "ArrowDown", "Shift"]) {
      expect(commandForKey(key, false)).toBeNull();
    }
  });

  it("maps Left and Right to a video's previous and next segment (Phase 49)", () => {
    expect(commandForKey("ArrowLeft", false)).toBe("segmentBack");
    expect(commandForKey("ArrowRight", false)).toBe("segmentForward");
    // A held arrow steps once: its repeats run nothing.
    expect(commandForKey("ArrowLeft", true)).toBeNull();
    expect(commandForKey("ArrowRight", true)).toBeNull();
    expect([...SEGMENT_COMMANDS].sort()).toEqual([
      "segmentBack",
      "segmentForward",
    ]);
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
    installKeyMap(
      target,
      commands,
      {
        taking: () => false,
        take: () => {},
      },
      { taking: () => true },
    );
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
    for (const key of ["t", "z", "ArrowUp", "F5"]) {
      expect(hold(key, 2)).toEqual({
        ran: [],
        prevented: [false, false, false],
      });
    }
  });
});

describe("installKeyMap's segment arrows (Phase 49)", () => {
  // Left and Right step a video's segments only while the story owns the
  // keys: with a panel up a focused slider (the reading speed, a volume)
  // steps on them, so the key map must leave them to the page there.
  function press(
    key: string,
    opts: { taking?: boolean; repeat?: boolean; meta?: boolean } = {},
  ) {
    const target = new EventTarget();
    const ran: KeyCommand[] = [];
    const commands = new Proxy({} as KeyCommands, {
      get: (_, name) => () => ran.push(name as KeyCommand),
    });
    installKeyMap(
      target,
      commands,
      { taking: () => false, take: () => {} },
      opts.taking === undefined
        ? undefined
        : { taking: () => opts.taking === true },
    );
    const event = keydown(key, opts.repeat === true);
    if (opts.meta === true) Object.assign(event, { metaKey: true });
    target.dispatchEvent(event);
    return { ran, prevented: event.defaultPrevented };
  }

  it("runs the step and takes the key while the story takes the arrows", () => {
    expect(press("ArrowRight", { taking: true })).toEqual({
      ran: ["segmentForward"],
      prevented: true,
    });
    expect(press("ArrowLeft", { taking: true })).toEqual({
      ran: ["segmentBack"],
      prevented: true,
    });
  });

  it("leaves the arrows to the page while it does not, or with no such input", () => {
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      expect(press(key, { taking: false })).toEqual({
        ran: [],
        prevented: false,
      });
      expect(press(key)).toEqual({ ran: [], prevented: false });
      expect(press(key, { taking: false, repeat: true })).toEqual({
        ran: [],
        prevented: false,
      });
    }
  });

  it("takes a held arrow's repeats while taking, stepping nothing more", () => {
    expect(press("ArrowRight", { taking: true, repeat: true })).toEqual({
      ran: [],
      prevented: true,
    });
  });

  it("leaves an arrow held with ⌘ alone", () => {
    expect(press("ArrowRight", { taking: true, meta: true })).toEqual({
      ran: [],
      prevented: false,
    });
  });
});

describe("installKeyMap leaves shortcuts to the browser and the host", () => {
  type Modifiers = Partial<
    Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>
  >;
  function press(key: string, modifiers: Modifiers, taking = false) {
    const target = new EventTarget();
    const ran: KeyCommand[] = [];
    const took: DecisionKey[] = [];
    const commands = new Proxy({} as KeyCommands, {
      get: (_, name) => () => ran.push(name as KeyCommand),
    });
    installKeyMap(target, commands, {
      taking: () => taking,
      take: (decision) => took.push(decision),
    });
    const event = keydown(key, false);
    Object.assign(event, modifiers);
    target.dispatchEvent(event);
    return { ran, took, prevented: event.defaultPrevented };
  }
  const NOTHING = { ran: [], took: [], prevented: false };
  const MODIFIERS: Modifiers[] = [
    { metaKey: true },
    { ctrlKey: true },
    { altKey: true },
  ];

  it("leaves ⌘H, Ctrl+H and Alt+H alone: no text toggle, default kept (the browser's or the app's)", () => {
    for (const modifiers of MODIFIERS) {
      expect(press("h", modifiers)).toEqual(NOTHING);
      expect(press("H", modifiers)).toEqual(NOTHING);
    }
  });

  it("leaves every mapped key alone when it is held with ⌘, Ctrl or Alt", () => {
    for (const key of mappedKeys()) {
      for (const modifiers of MODIFIERS) {
        expect(press(key, modifiers)).toEqual(NOTHING);
      }
    }
  });

  it("leaves a decision key held with ⌘, Ctrl or Alt alone while a choice is open", () => {
    for (const key of ["1", "0", "Enter", "ArrowDown", "ArrowUp"]) {
      for (const modifiers of MODIFIERS) {
        expect(press(key, modifiers, true)).toEqual(NOTHING);
      }
    }
  });

  it("still toggles the text on a plain h", () => {
    expect(press("h", {})).toEqual({
      ran: ["toggleText"],
      took: [],
      prevented: true,
    });
  });

  it("keeps Shift: Shift+h (H) toggles the text and Shift+Tab skips, both taken", () => {
    expect(press("H", { shiftKey: true })).toEqual({
      ran: ["toggleText"],
      took: [],
      prevented: true,
    });
    expect(press("Tab", { shiftKey: true })).toEqual({
      ran: ["toggleSkip"],
      took: [],
      prevented: true,
    });
    expect(press("ArrowDown", { shiftKey: true }, true)).toEqual({
      ran: [],
      took: ["next"],
      prevented: true,
    });
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

/** The help's caps for the arrow keys the table maps. */
const ARROW_LABELS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
};

describe("keyHelpEntries (the help lists the map itself, Phase 13b)", () => {
  // The drift test docs/plan.md Phase 13b asks for: the keymap module is
  // the single source, so a key or command without a help row fails here
  // — the old README's lost `a` bullet is exactly this drift, caught in code.
  function listedLabels(): Set<string> {
    return new Set(keyHelpEntries().flatMap((entry) => entry.keys));
  }

  // A game with sound lists every mapped key but the reset box's; a silent
  // game also leaves out `v`, which does nothing there (Phase 47 item 7).
  it("lists every mapped key except the reset box's own, and v only in a game with sound", () => {
    for (const sound of [true, false]) {
      const listed = new Set(
        keyHelpEntries({ sound }).flatMap((entry) => entry.keys),
      );
      // A row's label may hold several caps ("← →"), one per word.
      const caps = new Set([...listed].flatMap((label) => label.split(" ")));
      for (const key of mappedKeys()) {
        const command = commandForKey(key, false);
        if (command !== null && UNLISTED_COMMANDS.has(command)) continue;
        const label =
          ARROW_LABELS[key] ??
          (key === " " ? "Space" : key.length === 1 ? key.toLowerCase() : key);
        expect(caps.has(label)).toBe(
          sound || command === null || !SOUND_COMMANDS.has(command),
        );
      }
    }
  });

  it("lists every command the map can issue, each with a description; a silent game has no sound row", () => {
    const commands = new Set(
      mappedKeys()
        .map((key) => commandForKey(key, false))
        .filter(
          (command): command is NonNullable<typeof command> => command !== null,
        ),
    );
    for (const sound of [true, false]) {
      const entries = keyHelpEntries({ sound });
      for (const command of commands) {
        if (UNLISTED_COMMANDS.has(command)) continue;
        const row = entries.find((entry) => entry.commands.includes(command));
        if (!sound && SOUND_COMMANDS.has(command)) {
          expect(row).toBeUndefined();
          continue;
        }
        expect(row).toBeDefined();
        expect((row?.description ?? "").length).toBeGreaterThan(0);
        expect(row?.keys.length ?? 0).toBeGreaterThan(0);
      }
    }
    // Absent options are a silent game: the screen a game without audio
    // draws.
    expect(keyHelpEntries()).toEqual(keyHelpEntries({ sound: false }));
  });

  it("puts v with the other mode keys in a game with sound: after h, before b", () => {
    const labels = keyHelpEntries({ sound: true }).map((entry) =>
      entry.keys.join(" / "),
    );
    expect(labels.slice(6, 10)).toEqual(["a", "h", "v", "b"]);
    const row = keyHelpEntries({ sound: true }).find(
      (entry) => entry.command === "toggleSound",
    );
    expect(row?.description).toBe("sound on / off");
  });

  it("lists Left and Right as one row of two caps after Space (Phase 49)", () => {
    const row = keyHelpEntries().find((entry) =>
      entry.commands.includes("segmentForward"),
    );
    expect(row).toEqual({
      command: "segmentBack",
      commands: ["segmentBack", "segmentForward"],
      keys: ["← →"],
      description: "previous / next view of a video",
    });
    expect(keyHelpEntries()[1]).toEqual(row);
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
      "← →",
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
