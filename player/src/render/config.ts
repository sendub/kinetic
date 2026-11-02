// The `c` config screen (docs/plan.md Phase 9, README `c` bullet): a
// minimal panel holding the player's settings — the configurable reading
// speed (docs/plan.md Phase 16: a minus button, a draggable slider, a plus
// button and the current speed in smaller text at the row's right; the
// slider's own range is the stepper's 0.25-3.0 in 0.25 steps, and the
// readout shows the multiplier and the per-character allowance it gives),
// two options of how Tab skips, under their own "When Tab skips" heading
// so neither reads as a switch that starts skipping (docs/plan.md Phase
// 18): "Skip unseen content too" (the `skipAll` boolean) and "Play videos
// in full" (`skipPlaysVideos`); then Phase 13's `playAllRoutes`
// zero-interactivity route playback with a one-line note, plus
// the "Progress" group (docs/plan.md Phase 21): "Export progress" (the
// shell downloads `<storyId>-progress.json`), "Import progress" (a file
// picker; the shell checks the file and either shows its refusal in this
// panel's message line or asks the confirmation box) and Phase 16's
// "Reset progress", which opens the confirmation box
// (render/confirm.ts). The three are actions and change no setting
// themselves. No other UI.
//
// Every control click produces the full next settings through `onChange`,
// so the shell applies it live (machine.setSettings) and persists it from
// one place; the panel never reads storage. Like the bookmark panel, the
// pure rules are exported and tested below, and the DOM half only applies
// them. While the panel is open the timeline is suspended (keys.ts
// suspendTimeline); `c` or Escape closes it, as does a click outside the
// controls (backdrop) — the slider counts as a control, so grabbing it
// never closes the panel.

import type { MachineSettings } from "../machine/types";

/** The reading-speed range the stepper and the slider walk, and its step. */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 3.0;
export const SPEED_STEP = 0.25;

/**
 * One stepper press: `delta` steps of SPEED_STEP, snapped back onto the
 * 0.25 grid (a persisted or hand-built value cannot walk off it) and
 * clamped to [SPEED_MIN, SPEED_MAX].
 */
export function stepSpeed(current: number, delta: number): number {
  const moved =
    Math.round((current + delta * SPEED_STEP) / SPEED_STEP) * SPEED_STEP;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, moved));
}

/**
 * The readout at the row's right (smaller than the row's label): the
 * multiplier and the approximate milliseconds per code point it gives (base
 * `msPerChar` / speed) — the hold rule of docs/content-format.md, "Timing",
 * in one line.
 */
export function speedLabel(readingSpeed: number, msPerChar: number): string {
  const perChar = Math.round(msPerChar / readingSpeed);
  return `${readingSpeed.toFixed(2)}x — ~${String(perChar)} ms/char`;
}

/**
 * The skip options' heading and labels (docs/plan.md Phase 18): two options
 * of how Tab skips, not switches that start a skip.
 */
export const SKIP_SECTION = "When Tab skips";
export const SKIP_ALL_TEXT = "Skip unseen content too";
export const SKIP_VIDEOS_TEXT = "Play videos in full";
/** The heading over Export / Import / Reset progress (Phase 21). */
export const PROGRESS_SECTION = "Progress";
/**
 * The line under the Progress heading (Phase 22): saving needs no action;
 * Export / Import only carry progress to another browser.
 */
export const PROGRESS_NOTE =
  "saved in this browser automatically · export/import only to switch browser";
/**
 * The line beside Play all routes: what turning it On does, so it reads true
 * in either position (Phase 22).
 */
export const PLAY_ALL_NOTE =
  "when on, choices pick themselves after a countdown";

/** The skip-all switch's text state, mirroring its aria-pressed value. */
export function skipAllLabel(skipAll: boolean): string {
  return skipAll ? "On" : "Off";
}

/** The skip-plays-videos switch's text state, same two states (Phase 18). */
export function skipVideosLabel(skipPlaysVideos: boolean): string {
  return skipPlaysVideos ? "On" : "Off";
}

/** The play-all-routes switch's text state, same two states (Phase 13). */
export function playAllLabel(playAllRoutes: boolean): string {
  return playAllRoutes ? "On" : "Off";
}

export interface ConfigOverlay {
  isOpen(): boolean;
  /** Shows the panel, filled with the current settings, no message. */
  open(): void;
  close(): void;
  /**
   * The Progress group's message line (Phase 21): an import refusal or an
   * export's confirmation, in the panel itself. Empty text hides it.
   */
  showMessage(text: string): void;
}

export interface ConfigOverlayOptions {
  /** The `#app` element; the panel is its sibling, as the bookmark panel's. */
  root: HTMLElement;
  /** The settings in force, read fresh whenever the panel opens. */
  settings(): MachineSettings;
  /** A control moved: the full next settings, for live apply and persist. */
  onChange(next: MachineSettings): void;
  /**
   * The "Reset progress" row's control: open the confirmation box
   * (render/confirm.ts). A settings change is NOT produced here — the
   * row is an action, not an option (docs/plan.md Phase 16).
   */
  onReset(): void;
  /** "Export progress" (Phase 21): the shell builds and downloads the file. */
  onExport(): void;
  /**
   * "Import progress" (Phase 21): the file the reader picked. The shell
   * checks it, then shows a refusal (`showMessage`) or asks to confirm.
   */
  onImport(file: File): void;
}

export function mountConfigOverlay({
  root,
  settings,
  onChange,
  onReset,
  onExport,
  onImport,
}: ConfigOverlayOptions): ConfigOverlay {
  const doc = root.ownerDocument;

  const panel = doc.createElement("div");
  panel.id = "config";
  panel.className = "config";
  panel.hidden = true; // `c` opens; `c`, Escape or a backdrop click closes

  const title = doc.createElement("h2");
  title.className = "config-title";
  title.textContent = "Config";

  const hint = doc.createElement("p");
  hint.className = "config-hint";
  hint.textContent = "click a control to change it · c or Esc closes";

  const speedRow = doc.createElement("div");
  speedRow.className = "config-row";
  const speedLabelEl = doc.createElement("span");
  speedLabelEl.className = "config-label";
  speedLabelEl.textContent = "Reading speed";
  const speedDown = doc.createElement("button");
  speedDown.className = "config-step";
  speedDown.type = "button";
  speedDown.textContent = "−";
  speedDown.setAttribute("aria-label", "Decrease reading speed");
  speedDown.setAttribute("data-config-action", "speed-down");
  // The slider between the two buttons (docs/plan.md Phase 16): a native
  // range input, so the arrow keys and a drag both fire `input` and need no
  // extra code here. Its range is the stepper's, so both controls and the
  // persisted value share one grid. `data-config-action` marks it a control:
  // a click on the track must not read as backdrop.
  const speedSlider = doc.createElement("input");
  speedSlider.type = "range";
  speedSlider.className = "config-slider";
  speedSlider.min = String(SPEED_MIN);
  speedSlider.max = String(SPEED_MAX);
  speedSlider.step = String(SPEED_STEP);
  speedSlider.setAttribute("aria-label", "Reading speed");
  speedSlider.setAttribute("data-config-action", "speed-slider");
  const speedValue = doc.createElement("span");
  speedValue.className = "config-value config-speed-value";
  const speedUp = doc.createElement("button");
  speedUp.className = "config-step";
  speedUp.type = "button";
  speedUp.textContent = "+";
  speedUp.setAttribute("aria-label", "Increase reading speed");
  speedUp.setAttribute("data-config-action", "speed-up");
  speedRow.append(speedLabelEl, speedDown, speedSlider, speedUp, speedValue);

  const skipHeading = doc.createElement("p");
  skipHeading.className = "config-section";
  skipHeading.textContent = SKIP_SECTION;

  const skipRow = doc.createElement("div");
  skipRow.className = "config-row config-option";
  const skipLabelEl = doc.createElement("span");
  skipLabelEl.className = "config-label";
  skipLabelEl.textContent = SKIP_ALL_TEXT;
  const skipToggle = doc.createElement("button");
  skipToggle.className = "config-toggle config-skip-all";
  skipToggle.type = "button";
  skipToggle.setAttribute("role", "switch");
  skipToggle.setAttribute("data-config-action", "skip-all");
  skipRow.append(skipLabelEl, skipToggle);

  // "Play videos in full" (`skipPlaysVideos`, docs/plan.md Phase 18): a skip burst plays each
  // video it reaches as forward reading would; Space aborts one.
  const skipVideoRow = doc.createElement("div");
  skipVideoRow.className = "config-row config-option";
  const skipVideoLabelEl = doc.createElement("span");
  skipVideoLabelEl.className = "config-label";
  skipVideoLabelEl.textContent = SKIP_VIDEOS_TEXT;
  const skipVideoToggle = doc.createElement("button");
  skipVideoToggle.className = "config-toggle config-skip-videos";
  skipVideoToggle.type = "button";
  skipVideoToggle.setAttribute("role", "switch");
  skipVideoToggle.setAttribute("data-config-action", "skip-videos");
  skipVideoRow.append(skipVideoLabelEl, skipVideoToggle);

  // `Play all routes` (docs/plan.md Phase 13): zero-interactivity route
  // playback, its own persisted setting like skip-all.
  const playRow = doc.createElement("div");
  playRow.className = "config-row";
  const playLabelEl = doc.createElement("span");
  playLabelEl.className = "config-label";
  playLabelEl.textContent = "Play all routes";
  const playToggle = doc.createElement("button");
  playToggle.className = "config-toggle config-play-all";
  playToggle.type = "button";
  playToggle.setAttribute("role", "switch");
  playToggle.setAttribute("data-config-action", "play-all");
  const playNote = doc.createElement("span");
  playNote.className = "config-note";
  playNote.textContent = PLAY_ALL_NOTE;
  playRow.append(playLabelEl, playToggle, playNote);

  // The Progress group (docs/plan.md Phase 21): Export, Import and Reset,
  // indented under their heading like the skip options, every control in
  // the same column.
  const progressHeading = doc.createElement("p");
  progressHeading.className = "config-section";
  progressHeading.textContent = PROGRESS_SECTION;
  const progressNote = doc.createElement("p");
  progressNote.className = "config-note config-option config-group-note";
  progressNote.textContent = PROGRESS_NOTE;

  const actionRow = (
    label: string,
    text: string,
    aria: string,
    action: string,
  ): HTMLElement => {
    const row = doc.createElement("div");
    row.className = "config-row config-option";
    const labelEl = doc.createElement("span");
    labelEl.className = "config-label";
    labelEl.textContent = label;
    const button = doc.createElement("button");
    button.className = `config-toggle config-${action}`;
    button.type = "button";
    button.textContent = text;
    button.setAttribute("aria-label", aria);
    button.setAttribute("data-config-action", action);
    row.append(labelEl, button);
    return row;
  };
  const exportRow = actionRow(
    "Export progress",
    "Export",
    "Export this story's progress to a file",
    "export-progress",
  );
  const importRow = actionRow(
    "Import progress",
    "Import…",
    "Import progress from a file, replacing this browser's",
    "import-progress",
  );
  // The picker: a hidden file input the Import button clicks. Its own
  // (bubbling) click is marked a control, so it never reads as backdrop.
  const importFile = doc.createElement("input");
  importFile.type = "file";
  importFile.accept = ".json,application/json";
  importFile.hidden = true;
  importFile.setAttribute("data-config-action", "import-file");
  importRow.append(importFile);

  // `Reset progress` (docs/plan.md Phase 16): an action row, not a switch.
  // It shows on every open — fresh state included, because "you have
  // nothing to clear" is simple and honest. Its control opens the
  // confirmation box (render/confirm.ts); the panel itself changes no
  // setting and clears nothing until the box confirms.
  const resetRow = doc.createElement("div");
  resetRow.className = "config-row config-option";
  const resetLabelEl = doc.createElement("span");
  resetLabelEl.className = "config-label";
  resetLabelEl.textContent = "Reset progress";
  const resetButton = doc.createElement("button");
  resetButton.className = "config-toggle config-reset";
  resetButton.type = "button";
  resetButton.textContent = "Reset…";
  resetButton.setAttribute("aria-label", "Reset all progress for this content");
  resetButton.setAttribute("data-config-action", "reset-progress");
  resetRow.append(resetLabelEl, resetButton);

  // The Progress group's message line: a refusal or a confirmation, read
  // out as a status, hidden while empty.
  const message = doc.createElement("p");
  message.className = "config-message";
  message.setAttribute("role", "status");
  message.hidden = true;

  panel.append(
    title,
    hint,
    speedRow,
    skipHeading,
    skipRow,
    skipVideoRow,
    playRow,
    progressHeading,
    progressNote,
    exportRow,
    importRow,
    resetRow,
    message,
  );
  root.appendChild(panel);

  // The values on show, kept so the next control click edits the whole
  // settings object; refreshed from the shell on every open.
  let current: MachineSettings = settings();

  function paint(next: MachineSettings): void {
    current = next;
    speedSlider.value = String(next.readingSpeed);
    speedValue.textContent = speedLabel(next.readingSpeed, next.msPerChar);
    skipToggle.textContent = skipAllLabel(next.skipAll);
    skipToggle.setAttribute("aria-pressed", String(next.skipAll));
    skipVideoToggle.textContent = skipVideosLabel(next.skipPlaysVideos);
    skipVideoToggle.setAttribute("aria-pressed", String(next.skipPlaysVideos));
    playToggle.textContent = playAllLabel(next.playAllRoutes);
    playToggle.setAttribute("aria-pressed", String(next.playAllRoutes));
  }

  function move(next: MachineSettings): void {
    paint(next);
    onChange(next);
  }

  // One listener for the whole panel, as in bookmarks.ts: a control acts,
  // any other click is backdrop and closes.
  panel.addEventListener("click", (event) => {
    const target = event.target;
    const control =
      target instanceof Element ? target.closest("[data-config-action]") : null;
    if (control === null) {
      close();
      return;
    }
    const action = control.getAttribute("data-config-action");
    if (action === "speed-down") {
      move({ ...current, readingSpeed: stepSpeed(current.readingSpeed, -1) });
    } else if (action === "speed-up") {
      move({ ...current, readingSpeed: stepSpeed(current.readingSpeed, 1) });
    } else if (action === "skip-all") {
      move({ ...current, skipAll: !current.skipAll });
    } else if (action === "skip-videos") {
      move({ ...current, skipPlaysVideos: !current.skipPlaysVideos });
    } else if (action === "play-all") {
      move({ ...current, playAllRoutes: !current.playAllRoutes });
    } else if (action === "reset-progress") {
      // An action, not a settings move: the box confirms, the reset
      // reloads — the panel simply asks.
      onReset();
    } else if (action === "export-progress") {
      onExport();
    } else if (action === "import-progress") {
      importFile.click(); // opens the picker; `change` below has the file
    }
  });

  importFile.addEventListener("change", () => {
    const file = importFile.files?.[0];
    // Re-arm: choosing the same file again must fire `change` again.
    importFile.value = "";
    if (file !== undefined) onImport(file);
  });

  function showMessage(text: string): void {
    message.textContent = text;
    message.hidden = text === "";
  }

  // A drag or an arrow key: the slider's own `input` event carries the new
  // value, and `stepSpeed(_, 0)` snaps it onto the grid and clamps it to the
  // range — the same rule a stepper press goes through, so a mid-drag value
  // cannot leave the legal steps.
  speedSlider.addEventListener("input", () => {
    const raw = Number.parseFloat(speedSlider.value);
    if (Number.isNaN(raw)) return; // a cleared input is no value at all
    move({ ...current, readingSpeed: stepSpeed(raw, 0) });
  });

  function close(): void {
    panel.hidden = true;
  }

  paint(current);

  return {
    isOpen() {
      return !panel.hidden;
    },
    open() {
      paint(settings()); // always the values now in force, never a stale copy
      showMessage("");
      panel.hidden = false;
    },
    close,
    showMessage,
  };
}
