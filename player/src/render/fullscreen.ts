// Fullscreen in a browser tab (docs/plan.md Phases 5 and 43; docs/stack.md:
// fullscreen needs a user gesture, so the page asks on a key press or a
// click). A game app (render/host.ts) owns its window's mode instead, and
// with a host present the page never asks.
//
// Three rules from the Phase 43 prototype (.tmp/app-launch):
// 1. Re-armed: while the Display setting is Fullscreen, every gesture made
//    while windowed asks again, so leaving fullscreen once no longer strands
//    the reader in a window until the next reload. Escape never asks:
//    holding it is how a reader leaves on purpose, and the Esc screen's
//    Window half is how they stay out.
// 2. Skipped when the window already fills the screen (a browser in its own
//    fullscreen, as after F11): element fullscreen on top would only add a
//    layer that Esc and reload strip away.
// 3. Keyboard Lock (Chromium): once in element fullscreen, a short Esc
//    reaches the game (its Esc screen) and only holding Esc leaves.
//
// The console stays clean on a plain `file://` open: an untrusted event is
// no gesture and asks nothing (Blink logs a failure for a request it cannot
// honour, even when the rejection is handled), and neither does a key with
// no user activation behind it; a refused request is swallowed, since
// staying windowed is a valid outcome.

import { isShortcut } from "./keys";

const GESTURES = ["keydown", "pointerdown"] as const;

export interface GestureFullscreenOptions {
  /**
   * Whether fullscreen is wanted now: no host, and the tab's Display
   * setting is Fullscreen. Read at every gesture.
   */
  wanted(): boolean;
  /**
   * A gesture to leave alone: one on a settings control (render/config.ts
   * `isSettingsControl`). Chromium spends the gesture on the request, and
   * Import's file picker needs it; and a request racing the Window half's
   * exit would undo it.
   */
  ignore?(event: Event): boolean;
}

/**
 * Asks for fullscreen on every trusted key press or pointer press while it
 * is wanted and the page is windowed (rules 1 and 2 above). Returns a
 * function that removes the listeners.
 */
export function installGestureFullscreen(
  doc: Document,
  options: GestureFullscreenOptions,
  target: EventTarget = doc,
): () => void {
  const onGesture = (event: Event): void => {
    if (event.isTrusted === false) return;
    const key = event as KeyboardEvent;
    if (key.key === "Escape") return;
    // A shortcut (⌘W, ⌘R, Ctrl+Tab) is the browser's, not a reading key.
    if (isShortcut(key)) return;
    if (!hasUserActivation(doc)) return;
    if (options.ignore?.(event) === true) return;
    if (!options.wanted()) return;
    if (doc.fullscreenElement != null) return;
    if (windowFillsScreen(doc)) return;
    enterFullscreen(doc);
  };
  for (const type of GESTURES) target.addEventListener(type, onGesture);
  return () => {
    for (const type of GESTURES) target.removeEventListener(type, onGesture);
  };
}

/**
 * Whether the window already covers the screen: the browser is in its own
 * fullscreen (`display-mode: fullscreen`), or the page's view is at least
 * the screen's size.
 */
export function windowFillsScreen(doc: Document): boolean {
  const view = doc.defaultView;
  if (view === null) return false;
  if (view.matchMedia?.("(display-mode: fullscreen)").matches === true) {
    return true;
  }
  return (
    view.innerWidth >= view.screen.width &&
    view.innerHeight >= view.screen.height
  );
}

/**
 * Asks for element fullscreen on the whole page, then locks Escape
 * (Keyboard Lock, where the engine has it). Must run inside a user gesture;
 * a refusal leaves the page windowed, quietly.
 */
export function enterFullscreen(doc: Document): void {
  const root = doc.documentElement;
  if (typeof root.requestFullscreen !== "function") return;
  try {
    const pending = root.requestFullscreen();
    if (pending && typeof pending.then === "function") {
      pending.then(() => lockEscape(doc), noop);
    }
  } catch {
    // Older engines throw synchronously: same outcome, stay windowed.
  }
}

/** Leaves element fullscreen, if the page is in it. Never throws. */
export function exitFullscreen(doc: Document): void {
  if (doc.fullscreenElement == null) return;
  try {
    const pending = doc.exitFullscreen();
    if (pending && typeof pending.catch === "function") pending.catch(noop);
  } catch {
    // Nothing to leave after all.
  }
}

/**
 * True unless the engine reports that no user activation is in force
 * (`navigator.userActivation`, where it exists): a key the browser does
 * not count as a gesture would only earn a logged refusal.
 */
function hasUserActivation(doc: Document): boolean {
  const activation = (
    doc.defaultView?.navigator as
      | { userActivation?: { isActive?: boolean } }
      | undefined
  )?.userActivation;
  return activation?.isActive !== false;
}

interface KeyboardLock {
  lock(keys: string[]): Promise<void>;
}

function lockEscape(doc: Document): void {
  const keyboard = (
    doc.defaultView?.navigator as { keyboard?: KeyboardLock } | undefined
  )?.keyboard;
  if (keyboard === undefined || typeof keyboard.lock !== "function") return;
  try {
    keyboard.lock(["Escape"]).catch(noop);
  } catch {
    // No lock: the browser keeps the first Esc, as before.
  }
}

function noop(): void {
  // Ignored on purpose: staying windowed is a valid outcome.
}
