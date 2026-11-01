// The key map (docs/plan.md Phases 5, 7, 8, 9, 13b). Owns key -> command
// translation and nothing else: commands go to the machine or the shell,
// no state lives here. The wheel is a separate module (render/wheel.ts)
// because a wheel event is not a key. The key help overlay renders this
// module's own table (`keyHelpEntries`), so the listed keys and the
// mapping in force cannot drift apart.

/** The commands the shell and machine expose to the key map. */
export interface KeyCommands {
  advance(): void;
  toggleText(): void;
  toggleSkip(): void;
  jumpToUnseen(): void;
  /** `b`: append a bookmark at the current item (Phase 8). */
  bookmark(): void;
  /** `t`: open or close the bookmark thumbnail overlay (Phase 8). */
  toggleBookmarks(): void;
  /** `c`: open or close the config screen (Phase 9). */
  toggleConfig(): void;
  /**
   * Escape: with an overlay up, close it; otherwise open the key help
   * overlay (Phase 13b — "ESC opens only when no overlay is open; ESC
   * closes the help overlay").
   */
  dismissOverlay(): void;
  /**
   * `a`: toggle auto-forward (Phase 13b, README `a` bullet). Off is the
   * player's default: items wait for the reader until `a` is pressed.
   */
  toggleAutoForward(): void;
  /** Enter: close the key help overlay when it is up (Phase 13b). */
  closeHelp(): void;
}

/** A command the key map can issue. */
export type KeyCommand = keyof KeyCommands;

/**
 * The table itself. A `Map`, not an object literal, so a key like
 * `constructor` cannot resolve to something on the prototype. Derived from
 * `KeyCommands`, so a key can only be mapped to a command the shell has —
 * `h`/`H` and `e`/`E` both spellings because a Caps Lock reader exists.
 */
const KEY_TABLE = new Map<string, KeyCommand>([
  [" ", "advance"],
  ["h", "toggleText"],
  ["H", "toggleText"],
  ["Tab", "toggleSkip"],
  ["e", "jumpToUnseen"],
  ["E", "jumpToUnseen"],
  ["b", "bookmark"],
  ["B", "bookmark"],
  ["t", "toggleBookmarks"],
  ["T", "toggleBookmarks"],
  ["c", "toggleConfig"],
  ["C", "toggleConfig"],
  ["a", "toggleAutoForward"],
  ["A", "toggleAutoForward"],
  ["Enter", "closeHelp"],
  ["Escape", "dismissOverlay"],
]);

/** Every key the table maps — the key help's coverage guard reads this. */
export function mappedKeys(): string[] {
  return [...KEY_TABLE.keys()];
}

/** A table key as the help overlay lists it: Space, `h`, Tab, Escape… */
function displayKey(key: string): string {
  if (key === " ") return "Space";
  return key.length === 1 ? key.toLowerCase() : key;
}

/**
 * The keys listed for one command, straight from `KEY_TABLE`: a letter's
 * two spellings collapse to one entry (one row, Caps Lock aside). Because
 * the labels come from the table itself, the help screen cannot drift from
 * the mapping in force — that is the single-source rule of docs/plan.md
 * Phase 13b.
 */
export function entryKeysFor(command: KeyCommand): string[] {
  const keys = new Set<string>();
  for (const [key, value] of KEY_TABLE) {
    if (value === command) keys.add(displayKey(key));
  }
  return [...keys];
}

/** One row of the key help screen. */
export interface KeyHelpEntry {
  /** The command the row describes; null for the wheel, which is no key. */
  readonly command: KeyCommand | null;
  /** Key labels to show, e.g. ["Space"] or ["Tab"]. */
  readonly keys: readonly string[];
  /** One line telling the reader what it does. */
  readonly description: string;
}

/**
 * The rows, in reading order: the cursor first (space, wheel, tab), then
 * the modes, then the screens. Every `command` below must cover a command
 * the table maps — `keys.test.ts` asserts both directions, so adding a key
 * or command without a row fails a test (docs/plan.md Phase 13b).
 */
const HELP_ROWS: ReadonlyArray<{
  command: KeyCommand | null;
  wheelLabel?: string;
  description: string;
}> = [
  {
    command: "advance",
    description: "finish this item; the next press moves on",
  },
  {
    command: null,
    wheelLabel: "wheel",
    description: "roll back one item, or forward again through what you read",
  },
  {
    command: "toggleSkip",
    description: "skip mode: run through read items; stops at new content",
  },
  {
    command: "toggleAutoForward",
    description: "auto-forward on / off — on, items advance without input",
  },
  { command: "toggleText", description: "hide or show the text" },
  { command: "bookmark", description: "bookmark this moment" },
  { command: "toggleBookmarks", description: "show or hide the bookmark list" },
  { command: "jumpToUnseen", description: "jump to the last item you read" },
  { command: "toggleConfig", description: "config: reading speed, skip-all" },
  { command: "closeHelp", description: "close this help" },
  {
    command: "dismissOverlay",
    description:
      "open or close this help; closes the open list or config screen",
  },
];

/**
 * The help screen's content, built FROM the key table (docs/plan.md Phase
 * 13b): each row's keys are the table's own keys for its command. This is
 * the single source the `#help` overlay renders — `render/help.ts` only
 * draws it.
 */
export function keyHelpEntries(): KeyHelpEntry[] {
  return HELP_ROWS.map((row) => ({
    command: row.command,
    keys:
      row.command === null
        ? [row.wheelLabel ?? "wheel"]
        : entryKeysFor(row.command),
    description: row.description,
  }));
}

/**
 * Pure mapping, so the interesting decisions are testable without a DOM.
 * A held-down key repeats; acting on each repeat would burst through the
 * timeline faster than any reader, so repeats are ignored.
 */
export function commandForKey(key: string, repeat: boolean): KeyCommand | null {
  if (repeat) return null;
  return KEY_TABLE.get(key) ?? null;
}

/**
 * The cursor-moving commands: the key map's advance/toggleSkip/jumpToUnseen
 * plus the wheel's two steps. While a full-screen screen (the `t` bookmark
 * overlay, the `c` config screen, or the `#help` key help — Phase 13b) is
 * open these are suspended — the overlay takes precedence, so no key or
 * wheel notch slides the timeline underneath it (`e` is included for the
 * same reason: jumping behind the panel would move the cursor out of
 * sight). `b` and `h` are not timeline commands and keep working behind
 * the `t`/`c` panels; behind the help screen the shell suspends them too,
 * since nothing behind it is visible. `t`, `c` and Escape drive the
 * overlays.
 */
export interface TimelineCommands {
  advance(): void;
  toggleSkip(): void;
  jumpToUnseen(): void;
  wheelBack(): void;
  wheelForward(): void;
}

/**
 * Pure gate: every command of `commands` runs only while `overlayOpen()`
 * reports false. The state lives with the caller (the overlay component),
 * so the key and wheel wiring stay stateless.
 */
export function suspendTimeline(
  commands: TimelineCommands,
  overlayOpen: () => boolean,
): TimelineCommands {
  const gate = (command: () => void): (() => void) => {
    return () => {
      if (overlayOpen()) return;
      command();
    };
  };
  return {
    advance: gate(commands.advance),
    toggleSkip: gate(commands.toggleSkip),
    jumpToUnseen: gate(commands.jumpToUnseen),
    wheelBack: gate(commands.wheelBack),
    wheelForward: gate(commands.wheelForward),
  };
}

/**
 * Installs the key map; returns a function that removes it. `preventDefault`
 * covers every mapped key: space would otherwise scroll the document behind
 * the player, and Tab would otherwise move focus out of it.
 */
export function installKeyMap(
  target: EventTarget,
  commands: KeyCommands,
): () => void {
  const onKeyDown = (event: Event): void => {
    const keydown = event as KeyboardEvent;
    if (typeof keydown.key !== "string") return;
    const command = commandForKey(keydown.key, keydown.repeat === true);
    if (command === null) return;
    keydown.preventDefault();
    commands[command]();
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
