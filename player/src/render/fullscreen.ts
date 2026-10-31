// First-gesture fullscreen (docs/plan.md Phase 5, docs/stack.md: fullscreen
// needs a user gesture, so the app enters it on the first keypress or click).

const GESTURES = ["keydown", "pointerdown"] as const;

/**
 * Requests fullscreen on the first key press or pointer press anywhere, then
 * removes both listeners so it fires exactly once.
 *
 * Two guards keep the console clean, because a plain `file://` open is
 * expected to log nothing. A synthetic event (`isTrusted` false) is not a
 * user gesture, so it is skipped without consuming the once-only slot:
 * Blink logs a failure for a call it cannot honour even when the rejection is
 * handled. And a real-but-denied request — an iframe without the allowance, a
 * gesture the browser did not accept — is swallowed, since fullscreen is a
 * nicety and never a reason for an uncaught error.
 *
 * Returns a function that removes the listeners early.
 */
export function installFirstGestureFullscreen(
  doc: Document,
  target: EventTarget = doc,
): () => void {
  const onGesture = (event: Event): void => {
    if (event.isTrusted === false) return;
    remove();
    requestFullscreen(doc);
  };
  const remove = (): void => {
    for (const type of GESTURES) target.removeEventListener(type, onGesture);
  };
  for (const type of GESTURES) target.addEventListener(type, onGesture);
  return remove;
}

function requestFullscreen(doc: Document): void {
  if (doc.fullscreenElement !== null) return; // already fullscreen: nothing to do
  try {
    const pending = doc.documentElement.requestFullscreen();
    if (pending && typeof pending.catch === "function") pending.catch(noop);
  } catch {
    // Older engines throw synchronously: same outcome, stay windowed.
  }
}

function noop(): void {
  // Ignored on purpose: staying windowed is a valid outcome.
}
