// The reset-confirmation box (docs/plan.md Phase 16, "Reset progress"):
// the `c` screen's "Reset progress" row opens this centered panel, and
// nothing is cleared until the reader confirms. Same visual family as the
// other overlays (`#confirm`, index.html), and while it is open the
// machine is suspended exactly like behind `h`/`t`/`c` (main.ts folds
// `isOpen` into its screen gate). Its keys — y resets, Escape/n
// cancel — arrive through the shell's key map like every other overlay's;
// the panel itself only draws the two controls and routes clicks: a
// button acts, any other click is backdrop and cancels.
//
// `resetProgress` (below) is the whole confirm-side rule: flush, delete
// both stores, reload. Kept out of main.ts so it is testable with the
// memory backend and a stubbed reload.

import type { Storage } from "../storage/types";

/** The panel's message, verbatim from docs/plan.md Phase 16's wording. */
export const RESET_MESSAGE =
  "Reset all progress for this content? This clears resume position, " +
  "seen items, routes, bookmarks and settings.";

export interface ConfirmOverlay {
  isOpen(): boolean;
  /** Shows the panel over the config screen. */
  open(): void;
  close(): void;
}

export interface ConfirmOverlayOptions {
  /** The `#app` element; the panel is a sibling of the other panels. */
  root: HTMLElement;
  /** "Reset" pressed or y: the shell runs the reset and reloads. */
  onConfirm(): void;
  /** "Cancel" pressed, Escape/n, or a backdrop click: close, touch nothing. */
  onCancel(): void;
}

export function mountConfirmOverlay({
  root,
  onConfirm,
  onCancel,
}: ConfirmOverlayOptions): ConfirmOverlay {
  const doc = root.ownerDocument;

  const panel = doc.createElement("div");
  panel.id = "confirm";
  panel.className = "confirm";
  panel.hidden = true; // the config row opens it; its controls close it

  const title = doc.createElement("h2");
  title.className = "confirm-title";
  title.textContent = "Reset progress";

  const message = doc.createElement("p");
  message.className = "confirm-message";
  message.textContent = RESET_MESSAGE;

  const actions = doc.createElement("div");
  actions.className = "confirm-actions";
  const resetButton = doc.createElement("button");
  resetButton.className = "confirm-button confirm-reset";
  resetButton.type = "button";
  resetButton.textContent = "Reset";
  resetButton.setAttribute("data-confirm-action", "reset");
  const cancelButton = doc.createElement("button");
  cancelButton.className = "confirm-button confirm-cancel";
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  cancelButton.setAttribute("data-confirm-action", "cancel");
  actions.append(resetButton, cancelButton);

  const hint = doc.createElement("p");
  hint.className = "confirm-hint";
  hint.textContent = "y resets · Esc / n cancels";

  panel.append(title, message, actions, hint);
  root.appendChild(panel);

  // One listener, as in config.ts: a control acts, any other click is
  // backdrop and cancels. The panel closes first, so a callback that
  // decides not to reload (a failed delete still reloads; cancel simply
  // returns) cannot leave a stale box on screen.
  panel.addEventListener("click", (event) => {
    const target = event.target;
    const control =
      target instanceof Element
        ? target.closest("[data-confirm-action]")
        : null;
    panel.hidden = true;
    if (control === null) {
      onCancel();
      return;
    }
    if (control.getAttribute("data-confirm-action") === "reset") onConfirm();
    else onCancel();
  });

  return {
    isOpen() {
      return !panel.hidden;
    },
    open() {
      panel.hidden = false;
    },
    close() {
      panel.hidden = true;
    },
  };
}

/**
 * The confirmed reset, in order, every step awaited:
 *
 * 1. `flush` — let the immediate writer's in-flight/pending state write
 *    COMMIT first, or it would land after the delete and resurrect the
 *    row it just wrote.
 * 2. both deletes — each promise resolves on transaction commit
 *    (storage/types.ts), so the rows are gone for good before step 3.
 * 3. `reload` — a real fresh boot: help overlay, item 1, default
 *    settings. A reload is the honest "first ever play"; re-initialising
 *    the renderer, machine and overlays in place would replay half of
 *    main.ts's startup by hand and prove less.
 *
 * A failed delete never blocks the reload: the page reloads either way,
 * and a dead storage reads as a fresh start anyway (the noop adapter's
 * whole behaviour).
 *
 * The verify-step-40 lesson in one line: over `file://` IndexedDB, a
 * reload that races an uncommitted delete strands the next boot — every
 * delete above is COMMITTED before `reload` runs.
 */
export async function resetProgress(deps: {
  flush(): Promise<void>;
  storage: Storage;
  reload(): void;
}): Promise<void> {
  await deps.flush().catch(() => {});
  await Promise.all([
    deps.storage.deleteState().catch(() => {}),
    deps.storage.deleteBookmarks().catch(() => {}),
  ]);
  deps.reload();
}
