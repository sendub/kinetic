// The `#help` Esc screen (docs/plan.md Phase 13b; Phase 26 "Settings live
// on the Esc screen"): a black screen headed by the game's name, listing
// the main interaction keys, each its key caps over a short description,
// in a grid that fills across before going down (Phase 18, "Key help simplified" — the reset
// box's own keys are not listed), and below them every setting: main.ts
// mounts the settings section (render/config.ts) into this panel, so the
// keys and the settings are one screen. The rows render from the keymap module's own table
// (`keyHelpEntries` in render/keys.ts) — the keys shown are the keys that
// are mapped, so the screen cannot drift from the mapping (the README's
// auto-forward bullet was the symptom; discoverability was the cause).
//
// It shows FIRST, before any advance, when storage says the reader has
// never seen it (`helpSeen`, storage/types.ts), and Escape opens it at any
// other time when no other screen is up. While it is open the shell hides
// the stage, pauses the machine and lets only the closing keys through
// (Escape, space — main.ts owns that mutual exclusion, and the choice
// overlay slots into the same rule). A mouse click does not close it
// (docs/plan.md Phase 24, "Clicks don't close settings or help").
//
// FULLSCREEN CAVEAT, observed and documented (docs/verify-player.md, the
// help steps): while the page is fullscreen the browser reserves Escape for
// leaving fullscreen, and the page cannot reliably see that keydown —
// Chrome consumed the first Escape in the headless walk too. Escape in
// windowed mode reaches the page and opens/closes the help directly; every
// closing key (space) is unaffected by fullscreen.
//
// Like the config screen, the decisions are pure exports below and the DOM
// half only applies them; the rows themselves live with the keymap
// (single source), not here.

import { keyHelpEntries } from "./keys";

/** The keys' heading, shown above the key grid. */
export const HELP_TITLE = "Keys";

/**
 * The screen's one hint (Phase 26): its keys close it, and a click changes
 * a setting (a click never closes it, Phase 24).
 */
export const HELP_HINT = "Esc or Space closes; click a setting to change it";

/** The page title when the manifest names no game (index.html's own). */
export const PAGE_TITLE_DEFAULT = "Kinetic";

/**
 * The game's name from the manifest `title` (docs/plan.md Phase 21, Game
 * name on the Esc screen), trimmed; anything blank or not text is no name.
 * Pure.
 */
export function gameTitleOf(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const trimmed = title.trim();
  return trimmed === "" ? null : trimmed;
}

/** The page (tab) title: the game's name, else the player's own. Pure. */
export function pageTitleFor(title: unknown): string {
  return gameTitleOf(title) ?? PAGE_TITLE_DEFAULT;
}

export interface HelpOverlay {
  /** The screen's element: the settings section mounts into it (Phase 26). */
  readonly panel: HTMLElement;
  isOpen(): boolean;
  /** Shows the screen. The shell pauses the machine and hides the stage. */
  open(): void;
  close(): void;
}

export interface HelpOverlayOptions {
  /** The `#app` element; the panel is a sibling of the other panels. */
  root: HTMLElement;
  /**
   * The manifest `title`: drawn as a heading at the top of the screen when
   * it is non-blank text (gameTitleOf), else no heading at all.
   */
  gameTitle?: unknown;
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
  gameTitle,
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

  // A grid that fills across before it goes down (Phase 26): index.html's
  // `.help-list` sizes its columns with auto-fill.
  const list = doc.createElement("div");
  list.className = "help-list";
  for (const row of helpRows()) {
    const line = doc.createElement("div");
    line.className = "help-row";
    // The entry's key caps on one line, its description beneath
    // (index.html's `.help-row`). Each word of a label is its own cap and
    // a lone "/" is the "or" between caps, so `1-9 / 0` draws two caps;
    // the spaces between are text nodes, so the line's text is still the
    // label itself.
    const key = doc.createElement("span");
    key.className = "help-key";
    row.keys
      .join(" / ")
      .split(" ")
      .forEach((word, index) => {
        if (index > 0) key.append(" ");
        const part = doc.createElement(word === "/" ? "span" : "kbd");
        part.className = word === "/" ? "help-or" : "help-cap";
        part.textContent = word;
        key.append(part);
      });
    const description = doc.createElement("span");
    description.className = "help-desc";
    description.textContent = row.description;
    line.append(key, description);
    list.appendChild(line);
  }

  // The game's name heads the screen (Phase 21), set as text so a title
  // carrying markup shows literally; no name, no heading.
  const name = gameTitleOf(gameTitle);
  if (name !== null) {
    const heading = doc.createElement("h1");
    heading.className = "help-game";
    heading.textContent = name;
    panel.append(heading);
  }
  panel.append(hint, title, list);
  root.appendChild(panel);

  // No click handler: only its keys close it (Esc or Space, main.ts),
  // so a stray click — the first-load one included — leaves it up
  // (docs/plan.md Phase 24).

  function close(): void {
    panel.hidden = true;
  }

  return {
    panel,
    isOpen() {
      return !panel.hidden;
    },
    open() {
      panel.hidden = false;
    },
    close,
  };
}
