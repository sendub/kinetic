import { describe, expect, it } from "vitest";
import { KINETIC_VERSION } from "../version";
import {
  gameTitleOf,
  gameVersionOf,
  helpKeyLabel,
  helpRows,
  helpScreenStateFor,
  mountHelpOverlay,
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
    expect("Esc or Space closes").not.toContain("Enter");
    expect("Esc or Space closes").not.toContain("·");
    expect("Esc or Space closes").not.toMatch(/\bc\b/);
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
    expect(pageTitleFor("Kinetic demo")).toBe("Kinetic demo");
    expect(pageTitleFor(" Rainy Day ")).toBe("Rainy Day");
    expect(pageTitleFor(undefined)).toBe("Kinetic");
    expect(pageTitleFor("  ")).toBe("Kinetic");
  });
});

describe("the game's version (docs/plan.md Phase 51 item 3)", () => {
  it("a manifest version is the release, trimmed; blank or non-text is none", () => {
    expect(gameVersionOf("1.2")).toBe("1.2");
    expect(gameVersionOf("  0.9 beta  ")).toBe("0.9 beta");
    expect(gameVersionOf("<b>3</b>")).toBe("<b>3</b>");
    expect(gameVersionOf("")).toBeNull();
    expect(gameVersionOf("   ")).toBeNull();
    expect(gameVersionOf(undefined)).toBeNull();
    expect(gameVersionOf(1.2)).toBeNull();
    expect(gameVersionOf(null)).toBeNull();
  });
});

// A minimal DOM for the mount: node has none, and these tests only need
// the panel's element tree and its text. As in a browser, an element's
// textContent is its own text plus its children's (text nodes are plain
// strings here), and setting it replaces the children.
class FakeElement {
  children: FakeElement[] = [];
  nodes: (FakeElement | string)[] = [];
  className = "";
  id = "";
  hidden = false;
  innerHTML = "";
  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}
  get textContent(): string {
    return this.nodes
      .map((node) => (typeof node === "string" ? node : node.textContent))
      .join("");
  }
  set textContent(text: string) {
    this.children = [];
    this.nodes = [text];
  }
  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      this.nodes.push(node);
      if (typeof node !== "string") this.children.push(node);
    }
  }
  appendChild(node: FakeElement): FakeElement {
    this.append(node);
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

function mountWith(gameTitle?: unknown, gameVersion?: unknown): FakeElement {
  const root = new FakeDocument().createElement("div");
  mountHelpOverlay({
    root: root as unknown as HTMLElement,
    gameTitle,
    gameVersion,
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
    expect(title?.textContent).toBe("Keys");
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
        "help-kinetic",
      ]);
    }
  });
});

/** Every element under `el`, depth first. */
function descendants(el: FakeElement): FakeElement[] {
  return el.children.flatMap((child) => [child, ...descendants(child)]);
}

describe("the versions on the Esc screen (docs/plan.md Phase 51 item 4)", () => {
  it("title and version: the version follows the name inside the heading, in its own element", () => {
    const panel = mountWith("Kinetic demo", " 1.2 beta ");
    const [heading, hint] = panel.children;
    expect(heading?.tagName).toBe("H1");
    expect(heading?.className).toBe("help-game");
    expect(heading?.textContent).toBe("Kinetic demo 1.2 beta");
    const inside = descendants(heading as FakeElement);
    const name = inside.find((el) => el.className === "help-game-name");
    const version = inside.find((el) => el.className === "help-version");
    expect(name?.textContent).toBe("Kinetic demo");
    expect(version?.textContent).toBe("1.2 beta");
    // The name's text comes first, the version's last.
    expect(heading?.textContent.endsWith("1.2 beta")).toBe(true);
    expect(hint?.className).toBe("help-hint");
  });

  it("a title alone: the heading is the name, with no version element", () => {
    for (const absent of [undefined, "", "  ", 3]) {
      const panel = mountWith("Kinetic demo", absent);
      const [heading] = panel.children;
      expect(heading?.textContent).toBe("Kinetic demo");
      expect(
        descendants(panel).some((el) => el.className === "help-version"),
      ).toBe(false);
    }
  });

  it("a version and no title: the version alone where the heading would be, no heading", () => {
    for (const absent of [undefined, "", "   "]) {
      const panel = mountWith(absent, "0.9");
      const [first, hint] = panel.children;
      expect(first?.tagName).toBe("P");
      expect(first?.className).toBe("help-version");
      expect(first?.textContent).toBe("0.9");
      expect(hint?.className).toBe("help-hint");
      expect(descendants(panel).some((el) => el.tagName === "H1")).toBe(false);
    }
  });

  it("neither: no heading and no version element", () => {
    const panel = mountWith(undefined, undefined);
    expect(panel.children.map((el) => el.className)).toEqual([
      "help-hint",
      "help-title",
      "help-list",
      "help-kinetic",
    ]);
  });

  it("sets the version as text, never as markup, with a title and without", () => {
    const markup = "<img src=x onerror=alert(1)>";
    for (const panel of [
      mountWith("<b>Name</b>", markup),
      mountWith("", markup),
    ]) {
      const version = descendants(panel).find(
        (el) => el.className === "help-version",
      );
      expect(version?.textContent).toBe(markup);
      expect(descendants(panel).every((el) => el.innerHTML === "")).toBe(true);
    }
    const [heading] = mountWith("<b>Name</b>", markup).children;
    expect(heading?.textContent).toBe(`<b>Name</b> ${markup}`);
  });

  it("names the Kinetic version in its own line on the panel, outside the key grid", () => {
    for (const panel of [
      mountWith("Kinetic demo", "1.2"),
      mountWith(undefined, undefined),
    ]) {
      const lines = descendants(panel).filter(
        (el) => el.className === "help-kinetic",
      );
      expect(lines).toHaveLength(1);
      const [line] = lines;
      expect(panel.children).toContain(line);
      expect(line?.tagName).toBe("P");
      expect(line?.textContent).toBe(`Kinetic ${KINETIC_VERSION}`);
      expect(KINETIC_VERSION).toMatch(/^\d+\.\d+\.\d+/);
      const list = panel.children.find((el) => el.className === "help-list");
      expect(descendants(list as FakeElement)).not.toContain(line);
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
