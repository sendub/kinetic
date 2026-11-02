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

  it("closes with Esc, Space or a click — Enter is no key (Phase 18)", () => {
    expect(HELP_HINT).toBe("Esc · Space · click — closes");
    expect(HELP_HINT).not.toContain("Enter");
  });

  it("draws no reset-box keys and no Enter (Phase 18)", () => {
    const labels = helpRows().flatMap((row) => row.keys);
    expect(labels).toEqual([
      "Space",
      "wheel",
      "E",
      "U",
      "Tab",
      "A",
      "H",
      "B",
      "T",
      "C",
      "Esc",
      "1-9 / 0",
    ]);
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
  addEventListener(): void {}
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
    onClose: () => {},
    gameTitle,
  });
  const [panel] = root.children;
  if (panel === undefined) throw new Error("no #help panel");
  return panel;
}

describe("mountHelpOverlay heading (Phase 21)", () => {
  it("draws the game's name as the first line, above the key help title", () => {
    const panel = mountWith("Kinetic demo");
    const [heading, title] = panel.children;
    expect(heading?.tagName).toBe("H1");
    expect(heading?.className).toBe("help-game");
    expect(heading?.textContent).toBe("Kinetic demo");
    expect(title?.className).toBe("help-title");
    expect(title?.textContent).toBe(HELP_TITLE);
  });

  it("sets the name as text, never as markup", () => {
    const panel = mountWith("<img src=x onerror=alert(1)>");
    const [heading] = panel.children;
    expect(heading?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(heading?.innerHTML).toBe("");
  });

  it("no title, no heading: the key help title comes first", () => {
    for (const absent of [undefined, "", "   "]) {
      const panel = mountWith(absent);
      expect(panel.children.map((el) => el.className)).toEqual([
        "help-title",
        "help-hint",
        "help-list",
      ]);
    }
  });
});
