// The shell that binds machine state to the DOM (docs/plan.md Phase 5). The
// subscribe/notify seam is the only coupling to the machine: this module reads
// state, it never mutates it, and the leaf renderers stay independent of each
// other and of the machine's commands.

import type { Machine } from "../machine/machine";
import type { MachineState, Manifest } from "../machine/types";
import { createTextOverlayLayer } from "./overlay";
import { createVisualLayer } from "./visual";

/** A route announcement pill's visible hold (docs/plan.md Phase 18). */
export const ROUTE_PILL_MS = 1600;

export interface Shell {
  /** The `h` toggle: hide or show the text overlay, visual untouched. */
  toggleText(): void;
  setTextVisible(visible: boolean): void;
  isTextVisible(): boolean;
  /**
   * The key help's black screen (docs/plan.md Phase 13b): false hides the
   * whole stage — media included, playing elements — while the help is up;
   * true restores it. The hidden attribute, with `.stage[hidden]` declared
   * in index.html so the panel-level rule beats `.display` of `.stage`.
   */
  setStageVisible(visible: boolean): void;
  /** The visual element currently painted, for `b`-key thumbnail capture. */
  currentVisual(): HTMLImageElement | HTMLVideoElement | null;
  /**
   * A small transient notice — the `b` confirmation flash (Phase 8). It is
   * its own element, outside `#overlay`, so `h` never touches it, and it
   * fades and removes itself; nothing lingers on screen.
   */
  flash(message: string): void;
  /**
   * Show several pills in order — the route announcements' "Back to try
   * another route" before its "Route: <label>". Each message holds for
   * ROUTE_PILL_MS (~1.6 s, docs/plan.md Phase 18) before the next replaces
   * it.
   */
  flashSequence(messages: readonly string[]): void;
  unmount(): void;
}

export interface ShellOptions {
  /** The `#app` element from index.html. */
  root: HTMLElement;
  manifest: Manifest;
  machine: Machine;
}

export function mountShell({ root, manifest, machine }: ShellOptions): Shell {
  const doc = root.ownerDocument;
  const stage = doc.createElement("div");
  stage.id = "stage";
  stage.className = "stage";
  const overlay = doc.createElement("div");
  overlay.id = "overlay";
  overlay.className = "overlay";
  // The ending hint (docs/plan.md Phase 18): a quiet standing line while an
  // ending shows and content is still unseen. Outside `#overlay` so the
  // caption layer never repaints it; `h` hides it with the captions.
  const endingHint = doc.createElement("div");
  endingHint.id = "ending-hint";
  endingHint.textContent = "Some content is still unseen.";
  endingHint.hidden = true;
  Object.assign(endingHint.style, {
    position: "fixed",
    top: "3%",
    left: "50%",
    transform: "translateX(-50%)",
    color: "rgba(244, 239, 230, 0.78)",
    textShadow: "0 1px 3px rgba(0, 0, 0, 0.9)",
    font: "italic 400 clamp(12px, 1.5vh, 16px)/1.3 ui-sans-serif, system-ui, sans-serif",
    letterSpacing: "0.03em",
    pointerEvents: "none",
    userSelect: "none",
    zIndex: "5",
  });
  root.replaceChildren(stage, overlay, endingHint);

  const visuals = createVisualLayer(stage, manifest, {
    // A standalone video's `ended` (or an autoplay rejection, see
    // render/visual.ts) is the machine's media-end signal.
    onVideoEnded: () => machine.mediaEnded(),
  });
  const captions = createTextOverlayLayer(overlay);
  let textVisible = true;
  // The decision overlay hides the story text while it waits for an
  // answer (docs/plan.md Phase 13): a caption under the prompt would be
  // the item the decision hangs off, not anything the reader can act on.
  // `h` keeps its own state underneath — closing the choice restores it.
  let choiceOpen = false;
  let endingHintDue = false;

  function applyCaptions(): void {
    captions.setHidden(!textVisible || choiceOpen);
    endingHint.hidden = !textVisible || !endingHintDue;
  }

  function render(state: MachineState): void {
    // The visual is the machine's, so a `text` item keeps the earlier media
    // on screen; the caption is the cursor's own line. Playback mode
    // (still / loop-once / loop-forever) derives from the same state.
    visuals.update(manifest.items[machine.visualIndex()], state);
    captions.update(manifest.items[state.cursor]);
    choiceOpen = state.choice !== undefined;
    endingHintDue = state.endingHint === true;
    applyCaptions();
    schedulePreload(state);
  }

  // Decode preload (docs/plan.md Phase 12, docs/perf.md): warm the next
  // media files when the machine is idle — the item settled (it waits on
  // the reader) or skip is dwelling — so a file's fetch + decode never
  // lands on the navigation frame. One idle task at a time, reading the
  // cursor WHEN IT RUNS: a fast run of state changes stays one preload, and
  // requestIdleCallback keeps it off busy frames (a ~0 ms timer where the
  // host has no idle API).
  let preloadQueued = false;
  const requestIdle: (fn: () => void) => void =
    typeof globalThis.requestIdleCallback === "function"
      ? (fn) => {
          globalThis.requestIdleCallback(fn, { timeout: 200 });
        }
      : (fn) => {
          globalThis.setTimeout(fn, 0);
        };

  function schedulePreload(state: MachineState): void {
    if (!(state.settled || state.skipping) || preloadQueued) return;
    preloadQueued = true;
    requestIdle(() => {
      preloadQueued = false;
      visuals.preloadUpcoming(machine.getState().cursor);
    });
  }

  function setTextVisible(visible: boolean): void {
    textVisible = visible;
    applyCaptions();
  }

  // The confirmation flash (docs/plan.md Phase 8): a pill centred near the
  // top that fades itself away. Styled inline because the player's contract
  // is "index.html + app.js + manifest.js" — no new file, and `h` never
  // reaches it because it is not the overlay. `#flash` is the driver's
  // selector for "a bookmark was taken".
  let flashElement: HTMLElement | null = null;
  let flashTimers: ReturnType<typeof setTimeout>[] = [];
  // Queue timers for a pending `flashSequence` message. They live apart
  // from `flashTimers` on purpose: `flash` clears its own pill's timers,
  // and must never cancel the message still queued behind it.
  const sequenceTimers: ReturnType<typeof setTimeout>[] = [];

  function clearFlash(): void {
    for (const timer of flashTimers) globalThis.clearTimeout(timer);
    flashTimers = [];
    if (flashElement !== null) {
      flashElement.remove();
      flashElement = null;
    }
  }

  function flash(message: string, holdMs = 900): void {
    clearFlash(); // a second `b` replaces the first pill, mid-fade included
    const pill = doc.createElement("div");
    pill.id = "flash";
    pill.setAttribute("aria-hidden", "true"); // a machine echo, not a caption
    pill.textContent = message;
    Object.assign(pill.style, {
      position: "fixed",
      top: "8%",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "8px 18px",
      borderRadius: "999px",
      background: "rgba(10, 10, 12, 0.72)",
      border: "1px solid rgba(244, 239, 230, 0.22)",
      color: "#f4efe6",
      font: "500 clamp(13px, 1.6vh, 17px)/1.3 ui-sans-serif, system-ui, sans-serif",
      letterSpacing: "0.04em",
      pointerEvents: "none", // clicks pass through; the list stays clickable
      userSelect: "none",
      zIndex: "10",
      opacity: "1",
      transition: "opacity 400ms ease",
    });
    root.appendChild(pill);
    flashElement = pill;
    flashTimers.push(
      globalThis.setTimeout(() => {
        pill.style.opacity = "0";
        flashTimers.push(globalThis.setTimeout(clearFlash, 450));
      }, holdMs),
    );
  }

  function flashSequence(messages: readonly string[]): void {
    // A new announcement wins: a message of the previous sequence still
    // queued would otherwise land on top of this one's fresher pill.
    for (const timer of sequenceTimers) globalThis.clearTimeout(timer);
    sequenceTimers.length = 0;
    let delay = 0;
    for (const message of messages) {
      sequenceTimers.push(
        globalThis.setTimeout(() => flash(message, ROUTE_PILL_MS), delay),
      );
      delay += ROUTE_PILL_MS; // one route pill's visible hold (Phase 18)
    }
  }

  const unsubscribe = machine.subscribe(render);
  render(machine.getState());

  return {
    toggleText() {
      setTextVisible(!textVisible);
    },
    setTextVisible,
    isTextVisible() {
      return textVisible;
    },
    setStageVisible(visible: boolean) {
      stage.hidden = !visible; // `.stage[hidden]` in index.html paints black
    },
    currentVisual() {
      return visuals.currentVisual();
    },
    flash,
    flashSequence,
    unmount() {
      unsubscribe();
      machine.destroy();
      visuals.destroy();
      clearFlash();
      for (const timer of sequenceTimers) globalThis.clearTimeout(timer);
      sequenceTimers.length = 0;
      root.replaceChildren();
    },
  };
}

/** Renders a load failure in place of content. Never touches the console. */
export function mountError(root: HTMLElement, message: string): void {
  const notice = root.ownerDocument.createElement("div");
  notice.id = "error-state";
  notice.className = "notice";
  notice.textContent = message;
  root.replaceChildren(notice);
}
