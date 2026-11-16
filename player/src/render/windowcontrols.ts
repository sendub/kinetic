// The Esc screen's window controls (docs/plan.md Phase 43 item 9): the last
// group of the settings (a `.config-group` like the others, render/
// config.ts), under its own heading, on one line: a two-part Fullscreen |
// Window switch at its left, drawn like the branch map's Full size | Fit
// (its pressed half is the display mode now: the game app's, or the browser
// tab's Display setting), and Exit at its right, which quits the game
// (item 12). A browser tab that would not close itself says so in
// the shell's pill (`closeTabNote`, main.ts), not on this screen. What a
// click does lives in render/host.ts (`windowActions`); this module only
// draws and reports.

import { localized, type MessageKey, t } from "../i18n/catalogue.ts";
import type { DisplayMode } from "./host";

/** The switch's halves, in order. */
export const DISPLAY_MODES: readonly DisplayMode[] = ["fullscreen", "window"];
/** Each half's words in the catalogue. */
const DISPLAY_TEXT: Readonly<Record<DisplayMode, MessageKey>> = {
  fullscreen: "window.fullscreen",
  window: "window.window",
};

/**
 * The pill for a browser tab the page may not close (render/host.ts
 * `tabClosable`), or one that stayed open after `window.close()`.
 */
export function closeTabNote(): string {
  return t("window.closeTab");
}

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
  display: displayMode,
  onDisplay,
  onExit,
}: WindowControlsOptions): WindowControls {
  const doc = root.ownerDocument;

  const heading = doc.createElement("p");
  heading.className = "config-section";

  // Two rows on one line (index.html's `.config-inline`): the switch at
  // the line's start, Exit at its end. Each is labelled for the screen's
  // reading order like the Progress rows; the buttons name themselves, so
  // the labels are not drawn.
  const inlineRow = (): { row: HTMLElement; label: HTMLElement } => {
    const row = doc.createElement("div");
    row.className = "config-row config-option config-inline";
    const label = doc.createElement("span");
    label.className = "config-label";
    row.append(label);
    return { row, label };
  };

  const display = inlineRow();
  const displayRow = display.row;
  const halves = new Map<DisplayMode, HTMLElement>();
  for (const mode of DISPLAY_MODES) {
    const half = doc.createElement("button");
    half.className = `config-toggle config-display config-display-${mode}`;
    half.type = "button";
    half.setAttribute("data-config-action", `display-${mode}`);
    half.addEventListener("click", () => onDisplay(mode));
    displayRow.append(half);
    halves.set(mode, half);
  }

  const exit = inlineRow();
  const exitButton = doc.createElement("button");
  exitButton.className = "config-toggle config-exit";
  exitButton.type = "button";
  exitButton.setAttribute("data-config-action", "exit-game");
  exitButton.addEventListener("click", () => onExit());
  exit.row.append(exitButton);

  const group = doc.createElement("div");
  group.className = "config-group";
  group.append(heading, displayRow, exit.row);
  root.append(group);

  // The group's words, drawn again in each new UI language.
  localized(() => {
    heading.textContent = t("window.section");
    display.label.textContent = t("window.display");
    for (const [mode, half] of halves) {
      half.textContent = t(DISPLAY_TEXT[mode]);
    }
    exit.label.textContent = t("window.exitLabel");
    exitButton.textContent = t("window.exit");
    exitButton.setAttribute("aria-label", t("window.exitLabel"));
  });

  function refresh(): void {
    const shown = displayMode();
    for (const [mode, half] of halves) {
      half.setAttribute("aria-pressed", String(mode === shown));
    }
  }
  refresh();

  return { refresh };
}
