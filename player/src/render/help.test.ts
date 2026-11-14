import { describe, expect, it } from "vitest";
import {
  gameTitleOf,
  HELP_HINT,
  HELP_TITLE,
  helpKeyLabel,
  helpRows,
  helpScreenStateFor,
  mountHelpOverlay,
  PAGE_TITLE_DEFAULT,
  pageTitleFor,
} from "./help";
import { keyHelpEntries } from "./keys";

// The DOM half of render/help.ts has no browser here — same as the config
// and bookmark panels — so these tests pin the pure rule it applies, and
// the walk (docs/verify-player.md, the help steps) proves the screen.

describe("helpScreenStateFor (the black screen's rule, Phase 13b)", () => {
  it("open help: the panel is up and the stage is hidden", () => {
    expect(helpScreenStateFor(true)).toEqual({
      panelHidden: false,
      stageHidden: true,
    });
  });

  it("closed help: the panel is gone and the stage is restored", () => {
    expect(helpScreenStateFor(false)).toEqual({
      panelHidden: true,
      stageHidden: false,
    });
  });
});

describe("helpRows (drawn from the keymap, Phase 13b)", () => {
  it("renders one row per keymap entry — the single source, undrifted", () => {
    const rows = helpRows();
    expect(rows).toHaveLength(keyHelpEntries().length);
    for (const row of rows) {
      expect(row.keys.length).toBeGreaterThan(0);
      expect(row.description.length).toBeGreaterThan(0);
    }
  });

  it("closes with Esc or Space, and says only that (Phases 18, 24, 26, 40)", () => {
    expect(HELP_HINT).toBe("Esc or Space closes");
    expect(HELP_HINT).not.toContain("Enter");
    expect(HELP_HINT).not.toContain("·");
    expect(HELP_HINT).not.toMatch(/\bc\b/);
  });

  it("draws no reset-box keys; Enter only with the decision arrows (Phase 18, long lists)", () => {
    const labels = helpRows().flatMap((row) => row.keys);
    expect(labels).toEqual([
      "Space",
      "← →",
      "wheel",
      "E",
      "U",
      "Tab",
      "A",
      "H",
      "B",
      "M",
      "Esc",
      "1-9 0 ↑↓ Enter",
    ]);
  });

  it("draws a V row after H only for a game with sound (Phase 47 item 7)", () => {
    const labels = helpRows({ sound: true }).flatMap((row) => row.keys);
    expect(labels.slice(6, 10)).toEqual(["A", "H", "V", "B"]);
    expect(labels).toHaveLength(13);
    expect(helpRows({ sound: false })).toEqual(helpRows());
    expect(helpRows().flatMap((row) => row.keys)).not.toContain("V");
  });

  it("labels keys the way a keyboard legends them", () => {
    expect(helpKeyLabel("h")).toBe("H");
    expect(helpKeyLabel("Space")).toBe("Space"); // already a word
    expect(helpKeyLabel("Tab")).toBe("Tab");
    expect(helpKeyLabel("Escape")).toBe("Esc"); // the name readers know
  });
});

describe("the game's name (docs/plan.md Phase 21, Game name on the Esc screen)", () => {
  it("a manifest title is the name, trimmed; blank or non-text is none", () => {
    expect(gameTitleOf("Kinetic demo")).toBe("Kinetic demo");
    expect(gameTitleOf("  Rainy Day  ")).toBe("Rainy Day");
    expect(gameTitleOf("")).toBeNull();
    expect(gameTitleOf("   ")).toBeNull();
    expect(gameTitleOf(undefined)).toBeNull();
    expect(gameTitleOf(7)).toBeNull();
  });

  it("the page title is the game's name, else the player's own", () => {
    expect(PAGE_TITLE_DEFAULT).toBe("Kinetic");
    expect(pageTitleFor("Kinetic demo")).toBe("Kinetic demo");
    expect(pageTitleFor(" Rainy Day ")).toBe("Rainy Day");
    expect(pageTitleFor(undefined)).toBe("Kinetic");
    expect(pageTitleFor("  ")).toBe("Kinetic");
  });
});

// A minimal DOM for the mount: node has none, and these tests only need
// the panel's element tree and its text.
class FakeElement {
  children: FakeElement[] = [];
  className = "";
  id = "";
  hidden = false;
  textContent = "";
  innerHTML = "";
  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }
  appendChild(node: FakeElement): FakeElement {
    this.children.push(node);
    return node;
  }
  listeners = new Map<string, (() => void)[]>();
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

class FakeDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag.toUpperCase(), this);
  }
}

function mountWith(gameTitle?: unknown): FakeElement {
  const root = new FakeDocument().createElement("div");
  mountHelpOverlay({
    root: root as unknown as HTMLElement,
    gameTitle,
  });
  const [panel] = root.children;
  if (panel === undefined) throw new Error("no #help panel");
  return panel;
}

describe("mountHelpOverlay heading (Phase 21)", () => {
  it("draws the game's name as the first line, then the hint and the keys", () => {
    const panel = mountWith("Kinetic demo");
    const [heading, hint, title] = panel.children;
    expect(heading?.tagName).toBe("H1");
    expect(heading?.className).toBe("help-game");
    expect(heading?.textContent).toBe("Kinetic demo");
    expect(hint?.className).toBe("help-hint");
    expect(title?.className).toBe("help-title");
    expect(title?.textContent).toBe(HELP_TITLE);
    expect(HELP_TITLE).toBe("Keys");
  });

  it("sets the name as text, never as markup", () => {
    const panel = mountWith("<img src=x onerror=alert(1)>");
    const [heading] = panel.children;
    expect(heading?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(heading?.innerHTML).toBe("");
  });

  it("no title, no heading: the hint comes first", () => {
    for (const absent of [undefined, "", "   "]) {
      const panel = mountWith(absent);
      expect(panel.children.map((el) => el.className)).toEqual([
        "help-hint",
        "help-title",
        "help-list",
      ]);
    }
  });
});

describe("the Esc screen holds the settings (docs/plan.md Phase 26)", () => {
  it("exposes its panel, the element the settings section mounts into", () => {
    const root = new FakeDocument().createElement("div");
    const help = mountHelpOverlay({ root: root as unknown as HTMLElement });
    const [panel] = root.children;
    expect(help.panel).toBe(panel as unknown as HTMLElement);
  });

  it("lays the keys out in one grid of rows, one row per key", () => {
    const panel = mountWith("Kinetic demo");
    const list = panel.children.find((el) => el.className === "help-list");
    expect(list?.children.map((el) => el.className)).toEqual(
      helpRows().map(() => "help-row"),
    );
  });

  it("draws Left and Right as two caps over one line: previous / next view of a video (Phase 49)", () => {
    const panel = mountWith("Kinetic demo");
    const list = panel.children.find((el) => el.className === "help-list");
    const row = list?.children[1];
    const key = row?.children.find((el) => el.className === "help-key");
    expect(
      key?.children
        .filter((el) => el.className === "help-cap")
        .map((el) => el.textContent),
    ).toEqual(["←", "→"]);
    expect(
      row?.children.find((el) => el.className === "help-desc")?.textContent,
    ).toBe("previous / next view of a video");
  });

  it("draws the sound key's row when told the game has sound", () => {
    const root = new FakeDocument().createElement("div");
    mountHelpOverlay({ root: root as unknown as HTMLElement, sound: true });
    const list = root.children[0]?.children.find(
      (el) => el.className === "help-list",
    );
    expect(list?.children).toHaveLength(helpRows({ sound: true }).length);
    const descriptions = list?.children.map(
      (row) =>
        row.children.find((el) => el.className === "help-desc")?.textContent,
    );
    expect(descriptions).toContain("sound on / off");
  });
});

describe("a click does not close the help (docs/plan.md Phase 24)", () => {
  it("a click anywhere on the open screen leaves it open", () => {
    const root = new FakeDocument().createElement("div");
    const help = mountHelpOverlay({ root: root as unknown as HTMLElement });
    help.open();
    const [panel] = root.children;
    if (panel === undefined) throw new Error("no #help panel");
    panel.fire("click");
    for (const child of panel.children) child.fire("click");
    expect(help.isOpen()).toBe(true);
    expect(panel.hidden).toBe(false);
    help.close(); // its keys (main.ts) close it through close()
    expect(help.isOpen()).toBe(false);
  });
});

describe("the M entry is a control (m from the Esc screen)", () => {
  function mountRows(onEntry?: (command: string) => void): FakeElement[] {
    const root = new FakeDocument().createElement("div");
    mountHelpOverlay({ root: root as unknown as HTMLElement, onEntry });
    const list = root.children[0]?.children.find(
      (el) => el.className === "help-list",
    );
    if (list === undefined) throw new Error("no key grid");
    return list.children;
  }

  it("draws the M row as a button that runs its command; every other row stays plain, and there is no T row (Phase 35)", () => {
    const calls: string[] = [];
    const rows = mountRows((command) => calls.push(command));
    const m = helpRows().findIndex((r) => r.command === "toggleMap");
    rows.forEach((row, i) => {
      expect(row.tagName).toBe(i === m ? "BUTTON" : "DIV");
      expect(row.className).toBe("help-row");
    });
    expect(helpRows().some((r) => r.keys.includes("T"))).toBe(false);
    rows[m]?.fire("click");
    expect(calls).toEqual(["toggleMap"]);
  });

  it("with no handler no row is a control", () => {
    for (const row of mountRows()) expect(row.tagName).toBe("DIV");
  });
});
