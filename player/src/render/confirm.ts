// The confirmation box (docs/plan.md Phase 16, "Reset progress"; Phase
// 21, "Import progress"): the Esc screen's "Reset progress" row — or an
// import file that passed its checks — opens this centered panel, and
// nothing is changed until the reader confirms. Each opening brings its
// own request (title, message, button, hint and the action), so one box
// serves both. Same visual family as the
// other overlays (`#confirm`, index.html), and while it is open the
// machine is suspended exactly like behind the map and the Esc screen (main.ts folds
// `isOpen` into its screen gate). Its keys — y resets, Escape/n
// cancel (y imports, for an import) — arrive through the shell's key map
// like every other overlay's;
// the panel itself only draws the two controls and routes clicks: a
// button acts, any other click is backdrop and cancels.
//
// `resetProgress` (below) is the whole confirm-side rule: flush, delete
// both stores, reload. Kept out of main.ts so it is testable with the
// memory backend and a stubbed reload.

import { localized, t } from "../i18n/catalogue.ts";
import type { Storage } from "../storage/types";
import { onScrimClick } from "./scrim";
import { BROWSER_WORDING, type Wording } from "./wording";

/**
 * What one opening of the box asks, and what confirming does. Its words
 * are read when drawn (getters over the catalogue), so a box redraws in a
 * new UI language.
 */
export interface ConfirmRequest {
  readonly title: string;
  readonly message: string;
  /** The confirm button's text. */
  readonly confirmLabel: string;
  /** The key line under the buttons. */
  readonly hint: string;
  /** The confirm button or y: the shell's action (it may reload). */
  onConfirm(): void;
}

/** The keys a box's hint names, as keyboards print them. */
const HINT_KEYS = { yes: "y", esc: "Esc", no: "n" } as const;

/** The Phase 16 reset, asked in its own words (docs/plan.md Phase 16). */
export function resetRequest(onConfirm: () => void): ConfirmRequest {
  return {
    get title() {
      return t("confirm.reset.title");
    },
    get message() {
      return t("confirm.reset.message");
    },
    get confirmLabel() {
      return t("confirm.reset.button");
    },
    get hint() {
      return t("confirm.reset.hint", HINT_KEYS);
    },
    onConfirm,
  };
}

/**
 * The Phase 21 import, asked once the file passed its checks; `title` is
 * the manifest's game name (absent: "this story"); `words` is the
 * browser's or the app's (render/wording.ts).
 */
export function importRequest(
  title: string | undefined,
  onConfirm: () => void,
  words: Wording = BROWSER_WORDING,
): ConfirmRequest {
  return {
    get title() {
      return t("confirm.import.title");
    },
    get message() {
      return words.importConfirm(title);
    },
    get confirmLabel() {
      return t("confirm.import.button");
    },
    get hint() {
      return t("confirm.import.hint", HINT_KEYS);
    },
    onConfirm,
  };
}

/**
 * Removing the voice model (docs/plan.md Phase 52 item 10, the Volumes
 * sheet's "Remove voice model"): the engine and its model leave this
 * computer, for every Kinetic game, and the sheet offers the download
 * again.
 */
export function removeVoicesRequest(onConfirm: () => void): ConfirmRequest {
  return {
    get title() {
      return t("confirm.removeVoices.title");
    },
    get message() {
      return t("confirm.removeVoices.message");
    },
    get confirmLabel() {
      return t("confirm.removeVoices.button");
    },
    get hint() {
      return t("confirm.removeVoices.hint", HINT_KEYS);
    },
    onConfirm,
  };
}

export interface ConfirmOverlay {
  isOpen(): boolean;
  /** Shows the panel over the Esc screen, asking `request`. */
  open(request: ConfirmRequest): void;
  /** The y key: closes the box and runs the open request's action. */
  accept(): void;
  close(): void;
}

export interface ConfirmOverlayOptions {
  /** The `#app` element; the panel is a sibling of the other panels. */
  root: HTMLElement;
  /** "Cancel" pressed, Escape/n, or a backdrop click: close, touch nothing. */
  onCancel(): void;
}

export function mountConfirmOverlay({
  root,
  onCancel,
}: ConfirmOverlayOptions): ConfirmOverlay {
  const doc = root.ownerDocument;

  const panel = doc.createElement("div");
  panel.id = "confirm";
  panel.className = "confirm";
  panel.hidden = true; // the config row opens it; its controls close it

  const title = doc.createElement("h2");
  title.className = "confirm-title";

  const message = doc.createElement("p");
  message.className = "confirm-message";

  const actions = doc.createElement("div");
  actions.className = "confirm-actions";
  const confirmButton = doc.createElement("button");
  confirmButton.className = "confirm-button confirm-reset";
  confirmButton.type = "button";
  confirmButton.setAttribute("data-confirm-action", "confirm");
  const cancelButton = doc.createElement("button");
  cancelButton.className = "confirm-button confirm-cancel";
  cancelButton.type = "button";
  cancelButton.setAttribute("data-confirm-action", "cancel");
  actions.append(confirmButton, cancelButton);

  const hint = doc.createElement("p");
  hint.className = "confirm-hint";

  panel.append(title, message, actions, hint);
  root.appendChild(panel);

  // The request on show; null while the box is closed, so a stray `y`
  // can never run an action twice.
  let asked: ConfirmRequest | null = null;

  function close(): void {
    panel.hidden = true;
    asked = null;
  }

  function accept(): void {
    const request = asked;
    close();
    request?.onConfirm();
  }

  // One listener, as in config.ts: a control acts, any other click is
  // backdrop and cancels. The panel closes first, so a callback that
  // decides not to reload (a failed delete still reloads; cancel simply
  // returns) cannot leave a stale box on screen.
  // A press that began on the box and ended on the backdrop is a drag,
  // not a click on the backdrop (render/scrim.ts).
  onScrimClick<MouseEvent>(panel, (event) => {
    const target = event.target;
    const control =
      target instanceof Element
        ? target.closest("[data-confirm-action]")
        : null;
    if (control?.getAttribute("data-confirm-action") === "confirm") {
      accept();
      return;
    }
    close();
    onCancel();
  });

  // The words, the open request's included, in the UI language in force.
  function draw(): void {
    cancelButton.textContent = t("confirm.cancel");
    if (asked === null) return;
    title.textContent = asked.title;
    message.textContent = asked.message;
    confirmButton.textContent = asked.confirmLabel;
    hint.textContent = asked.hint;
  }
  localized(draw);

  return {
    isOpen() {
      return !panel.hidden;
    },
    open(request) {
      asked = request;
      draw();
      panel.hidden = false;
    },
    accept,
    close,
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
