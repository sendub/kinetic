// The key map (docs/plan.md Phases 5, 7, 8, 9, 13, 13b). Owns key -> command
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
  jumpToEnd(): void;
  /**
   * `u`: go to the next unseen content, wherever it is (docs/plan.md Phase
   * 18, "Reach unseen content from anywhere"; machine `jumpToUnseen`).
   */
  nextUnseen(): void;
  /** `b`: append a bookmark at the current item (Phase 8). */
  bookmark(): void;
  /**
   * `m`: open or close the branch map (docs/plan.md Phase 31): the
   * decision tree with the reader's marks and the bookmarks as cards on
   * it (Phase 35, which retired `t`); a click jumps there.
   */
  toggleMap(): void;
  /**
   * Escape: with an overlay up, close it; otherwise open the Esc screen —
   * the keys and every setting (Phase 13b; Phase 26 moved the settings
   * there and dropped `c`).
   */
  dismissOverlay(): void;
  /**
   * `a`: toggle auto-forward (Phase 13b, README `a` bullet). Off is the
   * player's default: items wait for the reader until `a` is pressed.
   */
  toggleAutoForward(): void;
  /**
   * `y`: confirm while the reset box is open (Phase 16, "Reset
   * progress"). Inert with no box open. The box shows its own buttons,
   * so the help screen does not list `y`/`n` (`UNLISTED_COMMANDS`).
   */
  confirmReset(): void;
  /** `n`: cancel while the reset box is open; Escape is its synonym. */
  confirmCancel(): void;
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
  ["e", "jumpToEnd"],
  ["E", "jumpToEnd"],
  ["u", "nextUnseen"],
  ["U", "nextUnseen"],
  ["b", "bookmark"],
  ["B", "bookmark"],
  ["m", "toggleMap"],
  ["M", "toggleMap"],
  ["a", "toggleAutoForward"],
  ["A", "toggleAutoForward"],
  ["Escape", "dismissOverlay"],
  ["y", "confirmReset"],
  ["Y", "confirmReset"],
  ["n", "confirmCancel"],
  ["N", "confirmCancel"],
]);

/**
 * Commands the help screen deliberately leaves out (docs/plan.md Phase 18,
 * "Key help simplified"): the reset box's `y`/`n` belong to that box,
 * which shows its own Reset / Cancel buttons, so the help lists only the
 * main interaction keys.
 */
export const UNLISTED_COMMANDS: ReadonlySet<KeyCommand> = new Set([
  "confirmReset",
  "confirmCancel",
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
 * The rows, one short line per main interaction key (docs/plan.md Phase
 * 18, "Key help simplified"): the cursor first (space, wheel, e, u, tab),
 * then the modes, then the screens, then the decision keys. Every command
 * the table maps has a row unless it is in `UNLISTED_COMMANDS` —
 * `keys.test.ts` asserts both directions, so adding a key or command
 * without a row fails a test (docs/plan.md Phase 13b).
 */
const HELP_ROWS: ReadonlyArray<{
  command: KeyCommand | null;
  /** Label for a non-command row (the wheel, the decision digits). */
  plainLabel?: string;
  description: string;
}> = [
  { command: "advance", description: "next item; stops auto-forward" },
  {
    command: null,
    plainLabel: "wheel",
    description: "back / forward through the story",
  },
  {
    command: "jumpToEnd",
    description: "jump to the furthest point read",
  },
  { command: "nextUnseen", description: "next unseen content" },
  { command: "toggleSkip", description: "skip what you have seen" },
  { command: "toggleAutoForward", description: "auto-forward on / off" },
  { command: "toggleText", description: "hide / show the text" },
  { command: "bookmark", description: "bookmark this moment" },
  {
    command: "toggleMap",
    description: "branch map and bookmarks: click to go there",
  },
  {
    command: "dismissOverlay",
    description: "this screen: keys and settings; closes the map",
  },
  {
    command: null,
    plainLabel: "1-9 0 ↑↓ Enter",
    description: "at a decision: pick a route; 0 returns to main route",
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
        ? [row.plainLabel ?? "wheel"]
        : entryKeysFor(row.command),
    description: row.description,
  }));
}

/**
 * The Esc screen rows that act when clicked (or Enter on them): `m` opens
 * the branch map in the screen's place, as its key does over it. The other
 * rows only describe; their keys do the work.
 */
export const CLICKABLE_HELP_COMMANDS: ReadonlySet<KeyCommand> = new Set([
  "toggleMap",
]);

/** What `m` (or a click on its Esc screen row) does in a given state. */
export type MapKeyAction = "open" | "close" | "replaceHelp" | "none";

/**
 * Pure routing for `m` (docs/plan.md Phase 31). The reset box swallows it;
 * over the Esc screen it replaces that screen with the map, so the next
 * Escape returns to the game. It opens over a pending decision too — the
 * map is a way to move, like the wheel, and a click on one of that
 * decision's routes is a pick. Otherwise it toggles the map.
 */
export function mapKeyAction(state: {
  confirmOpen: boolean;
  helpOpen: boolean;
  mapOpen: boolean;
}): MapKeyAction {
  if (state.confirmOpen) return "none";
  if (state.helpOpen) return "replaceHelp";
  return state.mapOpen ? "close" : "open";
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
 * The decision overlay's digit input (docs/content-format.md, "Branches"):
 * `1`..`9` select route indices 0..8. Kept OUT of `KEY_TABLE` deliberately:
 * the table maps keys to zero-argument commands, while a digit carries a
 * parameter and is only meaningful while a choice is open — the shell
 * (main.ts) owns that context and drops the digit when no choice is up.
 * The overlay itself numbers its rows, so the keys are discoverable there;
 * a help row (below) names them for the screen as a whole.
 */
export function routeIndexForKey(key: string, repeat: boolean): number | null {
  if (repeat) return null;
  if (key.length !== 1 || key < "1" || key > "9") return null;
  return key.charCodeAt(0) - "1".charCodeAt(0);
}

/**
 * A decision key: a route digit (`routeIndexForKey`), `0` — the
 * "Return to main route" row's key, drawn as that row's number
 * (docs/plan.md Phase 18, "Key help simplified") — or the row cursor that
 * reaches every row however many there are (a choice can have more routes
 * than the nine digits): ArrowUp / ArrowDown move it (`prev` / `next`) and
 * Enter picks the row under it (`pick`). Null for anything else.
 */
export type DecisionKey = number | "return" | "prev" | "next" | "pick";

export function decisionKeyFor(
  key: string,
  repeat: boolean,
): DecisionKey | null {
  // A held arrow walks the rows (13 routes are 13 presses otherwise); a
  // held digit or Enter must not pick twice.
  if (key === "ArrowUp") return "prev";
  if (key === "ArrowDown") return "next";
  if (repeat) return null;
  if (key === "Enter") return "pick";
  if (key === "0") return "return";
  return routeIndexForKey(key, repeat);
}

/**
 * The cursor-moving commands: the key map's advance/toggleSkip/jumpToEnd
 * plus the wheel's two steps. While a full-screen screen (the branch map,
 * the `#help` Esc screen with its settings — Phase 13b, Phase 26 — or the
 * reset confirmation box over it, Phase 16) is open these are suspended —
 * the overlay takes precedence, so no key or wheel notch slides the
 * timeline underneath it (`e` is included for the same reason: jumping
 * behind the panel would move the cursor out of sight). `m` and Escape
 * drive the screens.
 */
export interface TimelineCommands {
  advance(): void;
  toggleSkip(): void;
  jumpToEnd(): void;
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
    jumpToEnd: gate(commands.jumpToEnd),
    wheelBack: gate(commands.wheelBack),
    wheelForward: gate(commands.wheelForward),
  };
}

/**
 * Installs the key map; returns a function that removes it. `preventDefault`
 * covers every mapped key: space would otherwise scroll the document behind
 * the player, and Tab would otherwise move focus out of it.
 *
 * `onDecisionKey`, when given, receives decision keys (`decisionKeyFor`)
 * for keys no mapped command claims — the decision overlay's 1..9, 0, the
 * arrows and Enter. The callback owns the context check: it returns false
 * for a key it dropped (no choice open), and only a key it took has its
 * default prevented — so Enter still activates a focused control on the
 * Esc screen, as it always did.
 */
export function installKeyMap(
  target: EventTarget,
  commands: KeyCommands,
  onDecisionKey?: (key: DecisionKey) => boolean,
): () => void {
  const onKeyDown = (event: Event): void => {
    const keydown = event as KeyboardEvent;
    if (typeof keydown.key !== "string") return;
    const repeat = keydown.repeat === true;
    const command = commandForKey(keydown.key, repeat);
    if (command !== null) {
      keydown.preventDefault();
      commands[command]();
      return;
    }
    if (onDecisionKey === undefined) return;
    const decision = decisionKeyFor(keydown.key, repeat);
    if (decision === null) return;
    if (onDecisionKey(decision)) keydown.preventDefault();
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
