// The shell that binds machine state to the DOM (docs/plan.md Phase 5). The
// subscribe/notify seam is the only coupling to the machine: this module reads
// state, it never mutates it, and the leaf renderers stay independent of each
// other and of the machine's commands.

import type { Machine } from "../machine/machine";
import type { MachineState, Manifest } from "../machine/types";
import { createTextOverlayLayer } from "./overlay";
import { createVisualLayer } from "./visual";

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
  root.replaceChildren(stage, overlay);

  const visuals = createVisualLayer(stage, manifest, {
    // A standalone video's `ended` (or an autoplay rejection, see
    // render/visual.ts) is the machine's media-end signal.
    onVideoEnded: () => machine.mediaEnded(),
  });
  const captions = createTextOverlayLayer(overlay);
  let textVisible = true;

  function render(state: MachineState): void {
    // The visual is the machine's, so a `text` item keeps the earlier media
    // on screen; the caption is the cursor's own line. Playback mode
    // (still / loop-once / loop-forever) derives from the same state.
    visuals.update(manifest.items[machine.visualIndex()], state);
    captions.update(manifest.items[state.cursor]);
  }

  function setTextVisible(visible: boolean): void {
    textVisible = visible;
    captions.setHidden(!visible);
  }

  // The confirmation flash (docs/plan.md Phase 8): a pill centred near the
  // top that fades itself away. Styled inline because the player's contract
  // is "index.html + app.js + manifest.js" — no new file, and `h` never
  // reaches it because it is not the overlay. `#flash` is the driver's
  // selector for "a bookmark was taken".
  let flashElement: HTMLElement | null = null;
  let flashTimers: ReturnType<typeof setTimeout>[] = [];

  function clearFlash(): void {
    for (const timer of flashTimers) globalThis.clearTimeout(timer);
    flashTimers = [];
    if (flashElement !== null) {
      flashElement.remove();
      flashElement = null;
    }
  }

  function flash(message: string): void {
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
      }, 900),
    );
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
    unmount() {
      unsubscribe();
      machine.destroy();
      visuals.destroy();
      clearFlash();
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
