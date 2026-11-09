// The Esc screen's window controls (docs/plan.md Phase 43 item 9): the last
// group of the settings (a `.config-group` like the others, render/
// config.ts), under its own heading, on one line: a two-part Fullscreen |
// Window switch at its left, drawn like the branch map's Full size | Fit
// (its pressed half is the display mode now: the game app's, or the browser
// tab's Display setting), and Exit at its right, which quits the game
// (item 12). A browser tab that would not close itself says so in
// the shell's pill (`CLOSE_TAB_NOTE`, main.ts), not on this screen. What a
// click does lives in render/host.ts (`windowActions`); this module only
// draws and reports.

import type { DisplayMode } from "./host";

/** The group's heading. */
export const WINDOW_SECTION = "Game window";
/** The switch's halves, in order. */
export const DISPLAY_MODES: readonly DisplayMode[] = ["fullscreen", "window"];
export const DISPLAY_TEXT: Readonly<Record<DisplayMode, string>> = {
  fullscreen: "Fullscreen",
  window: "Window",
};
export const EXIT_TEXT = "Exit";
/**
 * The pill for a browser tab the page may not close (render/host.ts
 * `tabClosable`), or one that stayed open after `window.close()`.
 */
export const CLOSE_TAB_NOTE =
  "This browser keeps the tab open: close the tab to exit.";
export interface WindowControls {
  /** Repaints the switch from `display()`. */
  refresh(): void;
}

export interface WindowControlsOptions {
  /** The settings section (`#config`): the group goes at its end. */
  root: HTMLElement;
  /** The mode the switch shows pressed. */
  display(): DisplayMode;
  /** A click on a half (the pressed one included). */
  onDisplay(mode: DisplayMode): void;
  onExit(): void;
}

export function mountWindowControls({
  root,
  display,
  onDisplay,
  onExit,
}: WindowControlsOptions): WindowControls {
  const doc = root.ownerDocument;

  const heading = doc.createElement("p");
  heading.className = "config-section";
  heading.textContent = WINDOW_SECTION;

  // Two rows on one line (index.html's `.config-inline`): the switch at
  // the line's start, Exit at its end. Each is labelled for the screen's
  // reading order like the Progress rows; the buttons name themselves, so
  // the labels are not drawn.
  const inlineRow = (label: string): HTMLElement => {
    const row = doc.createElement("div");
    row.className = "config-row config-option config-inline";
    const labelEl = doc.createElement("span");
    labelEl.className = "config-label";
    labelEl.textContent = label;
    row.append(labelEl);
    return row;
  };

  const displayRow = inlineRow("Display");
  const halves = new Map<DisplayMode, HTMLElement>();
  for (const mode of DISPLAY_MODES) {
    const half = doc.createElement("button");
    half.className = `config-toggle config-display config-display-${mode}`;
    half.type = "button";
    half.textContent = DISPLAY_TEXT[mode];
    half.setAttribute("data-config-action", `display-${mode}`);
    half.addEventListener("click", () => onDisplay(mode));
    displayRow.append(half);
    halves.set(mode, half);
  }

  const exitRow = inlineRow("Exit the game");
  const exitButton = doc.createElement("button");
  exitButton.className = "config-toggle config-exit";
  exitButton.type = "button";
  exitButton.textContent = EXIT_TEXT;
  exitButton.setAttribute("aria-label", "Exit the game");
  exitButton.setAttribute("data-config-action", "exit-game");
  exitButton.addEventListener("click", () => onExit());
  exitRow.append(exitButton);

  const group = doc.createElement("div");
  group.className = "config-group";
  group.append(heading, displayRow, exitRow);
  root.append(group);

  function refresh(): void {
    const shown = display();
    for (const [mode, half] of halves) {
      half.setAttribute("aria-pressed", String(mode === shown));
    }
  }
  refresh();

  return { refresh };
}
