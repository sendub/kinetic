import { describe, expect, it } from "vitest";
import type { DisplayMode } from "./host";
import {
  CLOSE_TAB_NOTE,
  DISPLAY_TEXT,
  EXIT_TEXT,
  mountWindowControls,
  WINDOW_SECTION,
} from "./windowcontrols";

// The Esc screen's window controls (docs/plan.md Phase 43 item 9) over a
// stub DOM, as the config panel's tests do: the group's parts, the
// switch's pressed half, the clicks it reports and the tab note.

class FakeElement {
  className = "";
  textContent = "";
  hidden = false;
  type = "";
  parent: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly handlers = new Map<string, (() => void)[]>();
  constructor(
    readonly tag: string,
    readonly ownerDocument: FakeDocument,
  ) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  addEventListener(type: string, handler: () => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }
  click(): void {
    for (const handler of this.handlers.get("click") ?? []) handler();
  }
}

class FakeDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
}

const walk = (el: FakeElement): FakeElement[] => [
  el,
  ...el.children.flatMap(walk),
];
const byAction = (root: FakeElement, action: string): FakeElement => {
  const el = walk(root).find(
    (node) => node.getAttribute("data-config-action") === action,
  );
  if (el === undefined) throw new Error(`no ${action}`);
  return el;
};

function mount(initial: DisplayMode) {
  const root = new FakeDocument().createElement("div");
  let shown = initial;
  const picks: DisplayMode[] = [];
  let exits = 0;
  const controls = mountWindowControls({
    root: root as unknown as HTMLElement,
    display: () => shown,
    onDisplay: (mode) => picks.push(mode),
    onExit: () => {
      exits += 1;
    },
  });
  return {
    root,
    controls,
    picks,
    exits: () => exits,
    show(mode: DisplayMode) {
      shown = mode;
    },
    pressed: () => ({
      fullscreen: byAction(root, "display-fullscreen").getAttribute(
        "aria-pressed",
      ),
      window: byAction(root, "display-window").getAttribute("aria-pressed"),
    }),
  };
}

describe("mountWindowControls", () => {
  it("adds the Game window group: heading, Fullscreen | Window, Exit, a hidden note", () => {
    const { root } = mount("fullscreen");
    const [heading, displayRow, exitRow, note] = root.children;
    expect(heading?.textContent).toBe(WINDOW_SECTION);
    expect(heading?.className).toBe("config-section");
    expect(displayRow?.className).toContain("config-inline");
    expect(exitRow?.className).toContain("config-inline");
    expect(
      displayRow?.children
        .filter((el) => el.tag === "button")
        .map((el) => el.textContent),
    ).toEqual([DISPLAY_TEXT.fullscreen, DISPLAY_TEXT.window]);
    expect(byAction(root, "exit-game").textContent).toBe(EXIT_TEXT);
    expect(note?.hidden).toBe(true);
  });

  it("presses the half for the display mode shown, and repaints on refresh", () => {
    const view = mount("fullscreen");
    expect(view.pressed()).toEqual({ fullscreen: "true", window: "false" });
    view.show("window");
    view.controls.refresh();
    expect(view.pressed()).toEqual({ fullscreen: "false", window: "true" });
  });

  it("reports a click on either half (the pressed one too) and on Exit", () => {
    const view = mount("fullscreen");
    byAction(view.root, "display-window").click();
    byAction(view.root, "display-fullscreen").click();
    byAction(view.root, "exit-game").click();
    expect(view.picks).toEqual(["window", "fullscreen"]);
    expect(view.exits()).toBe(1);
  });

  it("shows and hides the tab note", () => {
    const view = mount("window");
    const note = view.root.children[3];
    view.controls.showNote(CLOSE_TAB_NOTE);
    expect(note?.hidden).toBe(false);
    expect(note?.textContent).toBe(CLOSE_TAB_NOTE);
    view.controls.showNote("");
    expect(note?.hidden).toBe(true);
  });
});
