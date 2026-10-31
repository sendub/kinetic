// The key map (docs/plan.md Phase 5). Owns key -> command translation and
// nothing else: commands go to the machine or the shell, no state lives here.
// The map grows in later phases (tab, b, t, e, c) and the wheel is wired
// separately (Phase 7).

/** A command the key map can issue. */
export type KeyCommand = "advance" | "toggleText";

/**
 * Pure mapping, so the interesting decisions are testable without a DOM.
 * A held-down key repeats; acting on each repeat would burst through the
 * timeline faster than any reader, so repeats are ignored.
 */
export function commandForKey(key: string, repeat: boolean): KeyCommand | null {
  if (repeat) return null;
  if (key === " ") return "advance";
  if (key === "h" || key === "H") return "toggleText";
  return null;
}

export interface KeyCommands {
  advance(): void;
  toggleText(): void;
}

/** Installs the key map; returns a function that removes it. */
export function installKeyMap(
  target: EventTarget,
  commands: KeyCommands,
): () => void {
  const onKeyDown = (event: Event): void => {
    const keydown = event as KeyboardEvent;
    if (typeof keydown.key !== "string") return;
    const command = commandForKey(keydown.key, keydown.repeat === true);
    if (command === null) return;
    // Space would otherwise scroll the document behind the player.
    keydown.preventDefault();
    if (command === "advance") commands.advance();
    else commands.toggleText();
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
