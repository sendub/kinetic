// The `#help` Esc screen (docs/plan.md Phase 13b; Phase 26 "Settings live
// on the Esc screen"): a black screen headed by the game's name (and its
// release, Phase 51; Kinetic's own release in a corner), listing
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

import { localized, t } from "../i18n/catalogue.ts";
import { KINETIC_VERSION } from "../version";
import {
  CLICKABLE_HELP_COMMANDS,
  type KeyCommand,
  keyHelpEntries,
} from "./keys";

/**
 * The screen's one hint (Phase 26, cut in Phase 40): its keys close it (a
 * click never closes it, Phase 24). Its words, the keys' heading's and the
 * rows' are the catalogue's (../i18n/en.ts), drawn in the UI language.
 */
export function helpHint(): string {
  return t("help.hint", { esc: "Esc", space: "Space" });
}

/**
 * The game's name from the manifest `title` (docs/plan.md Phase 21, Game
 * name on the Esc screen), trimmed; anything blank or not text is no name.
 * Pure.
 */
export function gameTitleOf(title: unknown): string | null {
  return plainTextOf(title);
}

/**
 * The game's release from the manifest `version` (docs/plan.md Phase 51),
 * by the title's rule: trimmed; anything blank or not text is none. Pure.
 */
export function gameVersionOf(version: unknown): string | null {
  return plainTextOf(version);
}

/** A manifest text field, trimmed, or `null` when blank or not text. */
function plainTextOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The page (tab) title: the game's name, else the player's own
 * (index.html's, `page.title`).
 */
export function pageTitleFor(title: unknown): string {
  return gameTitleOf(title) ?? t("page.title");
}

/** The Esc screen's corner line naming this player's Kinetic release. */
export function kineticLine(): string {
  return t("help.kinetic", { version: KINETIC_VERSION });
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
  /**
   * The manifest `version` (docs/plan.md Phase 51): drawn after the name,
   * smaller and dimmer, or alone in the heading's place when there is no
   * name, when it is non-blank text (gameVersionOf); else nothing.
   */
  gameVersion?: unknown;
  /**
   * A click (or Enter) on a row whose command is in
   * `CLICKABLE_HELP_COMMANDS` — the `m` row — runs that command as its key
   * would over this screen. Absent: no row is a control.
   */
  onEntry?: (command: KeyCommand) => void;
  /**
   * The game has audio (docs/plan.md Phase 47 item 7): the keys list `v`.
   * Absent or false: no row for it, as `v` does nothing there.
   */
  sound?: boolean;
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

/**
 * The rows to draw, from the keymap's entries; `sound` says the game has
 * audio, which adds the `v` row. Pure.
 */
export function helpRows(options: { sound?: boolean } = {}): {
  command: KeyCommand | null;
  keys: string[];
  description: string;
}[] {
  return keyHelpEntries(options).map((entry) => ({
    command: entry.command,
    keys: entry.keys.map(helpKeyLabel),
    description: entry.description,
  }));
}

export function mountHelpOverlay({
  root,
  gameTitle,
  gameVersion,
  onEntry,
  sound = false,
}: HelpOverlayOptions): HelpOverlay {
  const doc = root.ownerDocument;

  const panel = doc.createElement("div");
  panel.id = "help";
  panel.className = "help";
  panel.hidden = true; // first load or Escape opens it; its keys close it

  const title = doc.createElement("h2");
  title.className = "help-title";

  const hint = doc.createElement("p");
  hint.className = "help-hint";

  // A grid that fills across before it goes down (Phase 26): index.html's
  // `.help-list` sizes its columns with auto-fill.
  const list = doc.createElement("div");
  list.className = "help-list";
  const drawRows = (): void => {
    list.textContent = "";
    for (const row of helpRows({ sound })) {
      // A clickable row is a button (focusable, Enter activates it) drawn
      // like the others; index.html's `button.help-row` adds only the
      // hover/focus cue.
      const command = row.command;
      const clickable =
        onEntry !== undefined &&
        command !== null &&
        CLICKABLE_HELP_COMMANDS.has(command);
      const line = doc.createElement(clickable ? "button" : "div");
      line.className = "help-row";
      if (clickable) {
        (line as HTMLButtonElement).type = "button";
        line.addEventListener("click", () => onEntry(command));
      }
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
  };

  // The game's name heads the screen (Phase 21), its release after it,
  // smaller and dimmer (Phase 51), both set as text so markup shows
  // literally. The name and the version are one run of text inside the
  // heading (index.html's `.help-game-text`), so a long name wraps and the
  // version follows its last line, or the next, never cut off. With no
  // name the version stands alone where the heading would be; with
  // neither, no heading.
  const name = gameTitleOf(gameTitle);
  const release = gameVersionOf(gameVersion);
  const versionLine = (tag: "span" | "p"): HTMLElement => {
    const line = doc.createElement(tag);
    line.className = "help-version";
    line.textContent = release ?? "";
    return line;
  };
  if (name !== null) {
    const heading = doc.createElement("h1");
    heading.className = "help-game";
    const text = doc.createElement("span");
    text.className = "help-game-text";
    const nameText = doc.createElement("span");
    nameText.className = "help-game-name";
    nameText.textContent = name;
    text.append(nameText);
    if (release !== null) text.append(" ", versionLine("span"));
    heading.append(text);
    panel.append(heading);
  } else if (release !== null) {
    panel.append(versionLine("p"));
  }
  // Kinetic's own version, small and dim in the screen's bottom-right
  // corner, outside the sheet (index.html's `.help-kinetic`).
  const kinetic = doc.createElement("p");
  kinetic.className = "help-kinetic";
  panel.append(hint, title, list, kinetic);
  root.appendChild(panel);

  // The screen's words, drawn again in each new UI language.
  localized(() => {
    title.textContent = t("help.title");
    hint.textContent = helpHint();
    kinetic.textContent = kineticLine();
    drawRows();
  });

  // No click handler on the panel: only its keys close it (Esc or Space,
  // main.ts), so a stray click — the first-load one included — leaves it
  // up (docs/plan.md Phase 24). The one exception is the `m` row, a
  // deliberate control that swaps this screen for the branch map.

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
