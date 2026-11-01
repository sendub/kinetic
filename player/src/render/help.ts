// The `#help` key help overlay (docs/plan.md Phase 13b): a black screen
// listing the main interaction keys, one short line each (Phase 18, "Key
// help simplified" — the reset box's own keys are not listed), rendered from the keymap module's own table
// (`keyHelpEntries` in render/keys.ts) — the keys shown are the keys that
// are mapped, so the screen cannot drift from the mapping (the README's
// auto-forward bullet was the symptom; discoverability was the cause).
//
// It shows FIRST, before any advance, when storage says the reader has
// never seen it (`helpSeen`, storage/types.ts), and Escape opens it at any
// other time when no other screen is up. While it is open the shell hides
// the stage, pauses the machine and lets only the closing actions through
// (Escape, space, a click anywhere — main.ts owns that mutual
// exclusion, and the future choice overlay slots into the same rule).
//
// FULLSCREEN CAVEAT, observed and documented (docs/verify-player.md, the
// help steps): while the page is fullscreen the browser reserves Escape for
// leaving fullscreen, and the page cannot reliably see that keydown —
// Chrome consumed the first Escape in the headless walk too. Escape in
// windowed mode reaches the page and opens/closes the help directly; every
// other closing action (space, click) is unaffected by fullscreen.
//
// Like the config screen, the decisions are pure exports below and the DOM
// half only applies them; the rows themselves live with the keymap
// (single source), not here.

import { keyHelpEntries } from "./keys";

/** The panel's title, shown above the rows. */
export const HELP_TITLE = "Key help";

/** The panel's closing hint. */
export const HELP_HINT = "Esc · Space · click — closes";

export interface HelpOverlay {
  isOpen(): boolean;
  /** Shows the screen. The shell pauses the machine and hides the stage. */
  open(): void;
  close(): void;
}

export interface HelpOverlayOptions {
  /** The `#app` element; the panel is a sibling of the other panels. */
  root: HTMLElement;
  /** A click anywhere on the screen: the shell closes help and resumes. */
  onClose(): void;
}

/**
 * The screen-state rule, pure: open help means the panel is up and the
 * stage (visuals included) is hidden — the black screen of docs/plan.md
 * Phase 13b; closed is exactly the inverse. The DOM half applies this and
 * nothing else.
 */
export function helpScreenStateFor(open: boolean): {
  panelHidden: boolean;
  stageHidden: boolean;
} {
  return { panelHidden: !open, stageHidden: open };
}

/**
 * A key label as displayed: `Space` already reads right, a letter shows
 * upper-case on the chip, and Escape shortens to the name readers know.
 */
export function helpKeyLabel(key: string): string {
  if (key === "Escape") return "Esc";
  return key.length === 1 ? key.toUpperCase() : key;
}

/** The rows to draw, from the keymap's entries. Pure. */
export function helpRows(): { keys: string[]; description: string }[] {
  return keyHelpEntries().map((entry) => ({
    keys: entry.keys.map(helpKeyLabel),
    description: entry.description,
  }));
}

export function mountHelpOverlay({
  root,
  onClose,
}: HelpOverlayOptions): HelpOverlay {
  const doc = root.ownerDocument;

  const panel = doc.createElement("div");
  panel.id = "help";
  panel.className = "help";
  panel.hidden = true; // first load or Escape opens it; its keys close it

  const title = doc.createElement("h2");
  title.className = "help-title";
  title.textContent = HELP_TITLE;

  const hint = doc.createElement("p");
  hint.className = "help-hint";
  hint.textContent = HELP_HINT;

  const list = doc.createElement("div");
  list.className = "help-list";
  for (const row of helpRows()) {
    const line = doc.createElement("div");
    line.className = "help-row";
    const key = doc.createElement("kbd");
    key.className = "help-key";
    key.textContent = row.keys.join(" / ");
    const description = doc.createElement("span");
    description.className = "help-desc";
    description.textContent = row.description;
    line.append(key, description);
    list.appendChild(line);
  }

  panel.append(title, hint, list);
  root.appendChild(panel);

  // A click anywhere on the screen closes it (docs/plan.md Phase 13b);
  // the panel covers the viewport, so any click lands here. The shell's
  // onClose resumes the machine and persists `helpSeen`.
  panel.addEventListener("click", () => onClose());

  function close(): void {
    panel.hidden = true;
  }

  return {
    isOpen() {
      return !panel.hidden;
    },
    open() {
      panel.hidden = false;
    },
    close,
  };
}
