// The key map (docs/plan.md Phases 5, 7). Owns key -> command translation and
// nothing else: commands go to the machine or the shell, no state lives here.
// `b`, `t` and `c` join in later phases; the wheel is a separate module
// (render/wheel.ts) because a wheel event is not a key.

/** The commands the shell and machine expose to the key map. */
export interface KeyCommands {
  advance(): void;
  toggleText(): void;
  toggleSkip(): void;
  jumpToUnseen(): void;
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
]);

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
