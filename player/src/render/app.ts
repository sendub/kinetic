// The shell that binds machine state to the DOM (docs/plan.md Phase 5). The
// subscribe/notify seam is the only coupling to the machine: this module reads
// state, it never mutates it, and the leaf renderers stay independent of each
// other and of the machine's commands.

import type { Machine } from "../machine/machine";
import type { MachineState, Manifest } from "../machine/types";
import { createTextOverlayLayer } from "./overlay";
import { createVisualLayer } from "./visual";

declare global {
  interface Window {
    /**
     * Verification seam (docs/verify-player.md): commands the key map does
     * not own yet (wheel in Phase 7, skip, `e`) driven straight off the
     * machine by the headless driver. Production code never reads it.
     */
    __kineticDebug?: { machine: Machine };
  }
}

export interface Shell {
  /** The `h` toggle: hide or show the text overlay, visual untouched. */
  toggleText(): void;
  setTextVisible(visible: boolean): void;
  isTextVisible(): boolean;
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

  const unsubscribe = machine.subscribe(render);
  render(machine.getState());

  // Expose the machine for the verification driver only (see declare global).
  const view = doc.defaultView;
  if (view !== null) view.__kineticDebug = { machine };

  return {
    toggleText() {
      setTextVisible(!textVisible);
    },
    setTextVisible,
    isTextVisible() {
      return textVisible;
    },
    unmount() {
      unsubscribe();
      machine.destroy();
      visuals.destroy();
      if (view !== null && view.__kineticDebug?.machine === machine) {
        delete view.__kineticDebug;
      }
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
