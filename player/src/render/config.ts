// The settings section of the Esc screen (docs/plan.md Phase 9; Phase 26
// "Settings live on the Esc screen; `c` dropped": main.ts mounts it into
// the `#help` panel, under the key grid): the player's settings — the configurable reading
// speed (docs/plan.md Phase 16: a minus button, a draggable slider, a plus
// button and the current speed in smaller text at the row's right; the
// slider's own range is the stepper's 0.25-3.0 in 0.25 steps, and the
// readout shows the multiplier and the per-character allowance it gives),
// two options of how Tab skips, under their own "When Tab skips" heading
// so neither reads as a switch that starts skipping (docs/plan.md Phase
// 18): "Skip unseen content too" (the `skipAll` boolean) and "Play videos
// in full" (`skipPlaysVideos`); then Phase 13's `playAllRoutes`
// zero-interactivity route playback, its note behind a "?", plus
// the "Progress" group (docs/plan.md Phase 21): "Export progress" (the
// shell downloads `<storyId>-progress.json` and says "Progress exported"
// in the pill), "Import progress" (a file picker; the shell checks the
// file and either says its refusal in the pill or asks the confirmation
// box) and Phase 16's "Reset progress", which opens the confirmation box
// (render/confirm.ts). The three are actions and change no setting
// themselves. A game with sound the reader can control adds one Sound row
// under Play all routes (docs/plan.md Phase 47 item 7, Phase 52 item 10):
// sound on or off, the setting `v` turns, and "Volumes...", which opens the
// volumes sheet (render/volumes.ts), where the voice model's download lives
// too. A game with no sound has no such row. No other UI.
//
// The notes of the speed, Play all routes and the Progress group sit
// behind a "?" (docs/plan.md Phase 43 item 12, `mountTip`): a button whose
// tip shows on hover or keyboard focus, and a click or tap toggles it. The
// screen keeps no message line: a notice is the shell's pill (render/app.ts
// `notify`), so nothing on the screen moves when one shows.
//
// Each group (the speed cell, the skip options under their heading, Play
// all routes, Progress; render/windowcontrols.ts adds Game window) is one
// `.config-group` element, so index.html can share any spare height of the
// settings column between the gaps between groups and nowhere else.
//
// Every control click produces the full next settings through `onChange`,
// so the shell applies it live (machine.setSettings) and persists it from
// one place; the panel never reads storage. Like the bookmark panel, the
// pure rules are exported and tested below, and the DOM half only applies
// them. While the screen is open the timeline is suspended (keys.ts
// suspendTimeline); Escape or Space closes it (main.ts). A click never
// closes it (docs/plan.md Phase 24): one outside the controls (backdrop) is
// inert, and the slider and the file picker count as controls.

import { formatNumber, localized, t } from "../i18n/catalogue.ts";
import type { MachineSettings } from "../machine/types";
import { wordingFor } from "./wording.ts";

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
 * multiplier and, in parentheses, the approximate milliseconds per code
 * point it gives (base `msPerChar` / speed) — the hold rule of
 * docs/content-format.md, "Timing", in one line: `1.00x (~60 ms/char)`,
 * its numbers written for the UI language.
 */
export function speedLabel(readingSpeed: number, msPerChar: number): string {
  return t("config.speed.readout", {
    speed: formatNumber(readingSpeed, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: false,
    }),
    ms: Math.round(msPerChar / readingSpeed),
  });
}

/**
 * The words of the settings (docs/plan.md Phases 13, 18, 21, 22, 24, 26,
 * 43, 47) are the catalogue's `config.*` messages (../i18n/en.ts): the
 * skip options under "When Tab skips", two options of how Tab skips, not
 * switches that start a skip; the Progress heading's line, "Progress ·
 * saved automatically"; the speed row named for auto-forward, which it
 * paces (the stored setting keeps its `readingSpeed` key); the tips
 * behind the "?"s; and the pills an export or an unreadable import file
 * shows (no file name: the browser or app may rename it).
 */

/** A switch's text state, mirroring its aria-pressed value. */
function onOff(on: boolean): string {
  return on ? t("config.on") : t("config.off");
}

/** The skip-all switch's text state, mirroring its aria-pressed value. */
export function skipAllLabel(skipAll: boolean): string {
  return onOff(skipAll);
}

/** The skip-plays-videos switch's text state, same two states (Phase 18). */
export function skipVideosLabel(skipPlaysVideos: boolean): string {
  return onOff(skipPlaysVideos);
}

/** The play-all-routes switch's text state, same two states (Phase 13). */
export function playAllLabel(playAllRoutes: boolean): string {
  return onOff(playAllRoutes);
}

/**
 * The state a "?" tip is in (`mountTip`): `idle` shows it only while the
 * "?" is hovered or has keyboard focus; `open` keeps it shown (a click or
 * tap); `shut` keeps it hidden even under the pointer or focus that would
 * show it, until those leave (a second click, so it visibly closes).
 */
export type TipState = "idle" | "open" | "shut";

/** A click or tap on the "?": open unless it was pinned open. Pure. */
export function tipAfterClick(state: TipState): TipState {
  return state === "open" ? "shut" : "open";
}

/**
 * The pointer or keyboard focus left the "?": a shut tip goes back to
 * showing on the next hover or focus; an open one stays open. Pure.
 */
export function tipAfterLeave(state: TipState): TipState {
  return state === "shut" ? "idle" : state;
}

export interface Tip {
  /** The "?" and its tip, for the label line it follows. */
  readonly element: HTMLElement;
  /** Back to idle (the screen reopening, or another tip opening). */
  reset(): void;
  /** The tip's words, which the "?" and anything it describes read. */
  setText(text: string): void;
  /** The "?"'s accessible name ("About ..."). */
  setName(name: string): void;
  /** The tip's element id, for another control's `aria-describedby`. */
  readonly id: string;
}

/**
 * A "?" after a label (docs/plan.md Phase 43 item 12): a real button, named
 * `name` ("About auto-forward speed"), whose tip is in the DOM and is its description
 * (aria-describedby), never a `title` (slow, unstyled, unreliable in
 * WKWebView and WebView2). index.html shows the tip on hover and on
 * keyboard focus, styled in the sheet's palette and kept inside the sheet.
 * A click or tap toggles it (`tipAfterClick`), reported through
 * `onOpen` so the panel shows one tip at a time. It carries
 * `data-config-action`, so the panel's click handler takes it for a
 * control that changes nothing, and a click on it never asks for
 * fullscreen (`isSettingsControl`). Space and Escape still close the
 * screen: the keymap takes them before the button could.
 */
export function mountTip(
  doc: Document,
  key: string,
  name: string,
  text: string,
  onOpen: (tip: Tip) => void,
): Tip {
  const wrap = doc.createElement("span");
  wrap.className = "config-tipwrap";
  const button = doc.createElement("button");
  button.className = "config-tip";
  button.type = "button";
  button.setAttribute("aria-label", name);
  button.setAttribute("data-config-action", `tip-${key}`);
  const body = doc.createElement("span");
  body.className = "config-tip-text";
  body.id = `config-tip-${key}`;
  body.setAttribute("role", "tooltip");
  body.textContent = text;
  button.setAttribute("aria-describedby", body.id);
  wrap.append(button, body);

  let state: TipState = "idle";
  const set = (next: TipState): void => {
    state = next;
    wrap.setAttribute("data-tip", next);
  };
  const tip: Tip = {
    element: wrap,
    reset: () => set("idle"),
    setText: (next) => {
      body.textContent = next;
    },
    setName: (next) => {
      button.setAttribute("aria-label", next);
    },
    id: body.id,
  };
  set("idle");
  button.addEventListener("click", () => {
    set(tipAfterClick(state));
    if (state === "open") onOpen(tip);
  });
  const leave = (): void => set(tipAfterLeave(state));
  wrap.addEventListener("pointerleave", leave);
  button.addEventListener("blur", leave);
  return tip;
}

/**
 * Whether `target` is one of the settings' controls (every one carries
 * `data-config-action`, the window controls and the "?" tips included). A
 * key or click on one never asks for fullscreen (render/fullscreen.ts): a
 * request would spend the gesture the control may need itself (Import's
 * file picker) or race its own effect (the Window half).
 */
export function isSettingsControl(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  return (
    typeof el?.closest === "function" &&
    el.closest("[data-config-action]") != null
  );
}

export interface ConfigOverlay {
  /**
   * The section's element: the window controls (render/windowcontrols.ts,
   * Phase 43) mount at its end.
   */
  readonly panel: HTMLElement;
  isOpen(): boolean;
  /** Shows the panel, filled with the current settings, every tip idle. */
  open(): void;
  /** Repaints from the settings in force (`v` turned sound on or off). */
  refresh(): void;
  /**
   * Shows the Sound row (true) or takes it away (docs/plan.md Phase 56 item
   * 6b: it follows what the language shown can play). Only with `sound`
   * given; it starts shown.
   */
  setSound(shown: boolean): void;
  close(): void;
}

export interface ConfigOverlayOptions {
  /**
   * A game app hosts the page (render/wording.ts): its words name no
   * browser. Read on every open, since the host may arrive late.
   */
  app?(): boolean;
  /** The Esc screen's panel (`#help`); the section is its last child. */
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
   * checks it, then says a refusal in the pill or asks to confirm.
   */
  onImport(file: File): void;
  /**
   * The game has sound with controls (docs/plan.md Phase 47 item 7, Phase
   * 52 item 10): a Sound row joins Play all routes' group, its switch the
   * `soundOn` setting and its Volumes... button `onVolumes`, given the
   * button (focus goes back to it when the sheet closes). Absent: no Sound
   * row, ever. Given, `setSound` takes the row away and brings it back.
   */
  sound?: { onVolumes(opener: HTMLElement): void };
}

export function mountConfigOverlay({
  root,
  settings,
  onChange,
  onReset,
  onExport,
  onImport,
  sound,
  app = () => false,
}: ConfigOverlayOptions): ConfigOverlay {
  const doc = root.ownerDocument;

  const panel = doc.createElement("div");
  panel.id = "config";
  panel.className = "config";
  panel.hidden = true; // shown and hidden with the Esc screen (main.ts)

  const title = doc.createElement("h2");
  title.className = "config-title";

  // The "?" tips, one shown at a time; every one idle again on open.
  const tips: Tip[] = [];
  const tipFor = (key: string): Tip => {
    const tip = mountTip(doc, key, "", "", (opened) => {
      for (const other of tips) if (other !== opened) other.reset();
    });
    tips.push(tip);
    return tip;
  };

  // One group of the column (index.html's `.config-group`).
  const group = (...children: HTMLElement[]): HTMLElement => {
    const el = doc.createElement("div");
    el.className = "config-group";
    el.append(...children);
    return el;
  };

  const speedRow = doc.createElement("div");
  speedRow.className = "config-row config-slide config-speed";
  // The label's words, then its "?" (Phase 43 item 12): the note on what
  // else the speed paces, which used to be a line under the row.
  const speedLabelEl = doc.createElement("span");
  speedLabelEl.className = "config-label";
  const speedTip = tipFor("speed");
  const speedDown = doc.createElement("button");
  speedDown.className = "config-step";
  speedDown.type = "button";
  speedDown.textContent = "−";
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
  speedSlider.setAttribute("data-config-action", "speed-slider");
  const speedValue = doc.createElement("span");
  speedValue.className = "config-value config-speed-value";
  const speedUp = doc.createElement("button");
  speedUp.className = "config-step";
  speedUp.type = "button";
  speedUp.textContent = "+";
  speedUp.setAttribute("data-config-action", "speed-up");
  speedRow.append(speedLabelEl, speedDown, speedSlider, speedUp, speedValue);

  const skipHeading = doc.createElement("p");
  skipHeading.className = "config-section";

  const skipRow = doc.createElement("div");
  skipRow.className = "config-row config-option";
  const skipLabelEl = doc.createElement("span");
  skipLabelEl.className = "config-label";
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
  const skipVideoToggle = doc.createElement("button");
  skipVideoToggle.className = "config-toggle config-skip-videos";
  skipVideoToggle.type = "button";
  skipVideoToggle.setAttribute("role", "switch");
  skipVideoToggle.setAttribute("data-config-action", "skip-videos");
  skipVideoRow.append(skipVideoLabelEl, skipVideoToggle);

  // `Play all routes` (docs/plan.md Phase 13): zero-interactivity route
  // playback, its own persisted setting like skip-all. One line like the
  // skip switches: its note, what On does, is behind its "?" (Phase 43
  // item 12).
  const playRow = doc.createElement("div");
  playRow.className = "config-row";
  const playLabelEl = doc.createElement("span");
  playLabelEl.className = "config-label";
  const playTip = tipFor("play-all");
  const playToggle = doc.createElement("button");
  playToggle.className = "config-toggle config-play-all";
  playToggle.type = "button";
  playToggle.setAttribute("role", "switch");
  playToggle.setAttribute("data-config-action", "play-all");
  playRow.append(playLabelEl, playToggle);

  // Sound (docs/plan.md Phase 47 item 7), for a game with audio only: one
  // row under Play all routes, in its group, its Volumes... button before
  // its switch so the switch lines up with the others.
  const soundRow = doc.createElement("div");
  soundRow.className = "config-row";
  const soundLabelEl = doc.createElement("span");
  soundLabelEl.className = "config-label";
  const volumesButton = doc.createElement("button");
  volumesButton.className = "config-toggle config-volumes";
  volumesButton.type = "button";
  volumesButton.setAttribute("aria-haspopup", "dialog");
  volumesButton.setAttribute("data-config-action", "volumes");
  const soundToggle = doc.createElement("button");
  soundToggle.className = "config-toggle config-sound";
  soundToggle.type = "button";
  soundToggle.setAttribute("role", "switch");
  soundToggle.setAttribute("data-config-action", "sound");
  soundRow.append(soundLabelEl, volumesButton, soundToggle);

  // The Progress group (docs/plan.md Phase 21): Export, Import and Reset,
  // indented under their heading like the skip options, every control in
  // the same column. The heading's line says saving is automatic, and its
  // "?" holds the rest of Phase 22's note (Phase 43 item 12).
  const progressHeading = doc.createElement("p");
  progressHeading.className = "config-section";
  const progressSaved = doc.createElement("span");
  progressSaved.className = "config-section-aside";
  const progressTip = tipFor("progress");

  const actionRow = (action: string): HTMLElement => {
    const row = doc.createElement("div");
    row.className = "config-row config-option";
    const labelEl = doc.createElement("span");
    labelEl.className = "config-label";
    const button = doc.createElement("button");
    button.className = `config-toggle config-${action}`;
    button.type = "button";
    button.setAttribute("data-config-action", action);
    row.append(labelEl, button);
    return row;
  };
  /** An action row's words: its label, its button and the button's name. */
  const labelRow = (
    row: HTMLElement,
    label: string,
    text: string,
    aria: string,
  ): void => {
    row.children[0].textContent = label;
    row.children[1].textContent = text;
    row.children[1].setAttribute("aria-label", aria);
  };
  const exportRow = actionRow("export-progress");
  const importRow = actionRow("import-progress");
  const importButton = importRow.children[1] as HTMLElement;
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
  const resetRow = actionRow("reset-progress");
  resetRow.children[1].className = "config-toggle config-reset";

  const playGroup = group(playRow, ...(sound === undefined ? [] : [soundRow]));
  panel.append(
    title,
    group(speedRow),
    group(skipHeading, skipRow, skipVideoRow),
    playGroup,
    group(progressHeading, exportRow, importRow, resetRow),
  );
  root.appendChild(panel);

  // The values on show, kept so the next control click edits the whole
  // settings object; refreshed from the shell on every open.
  let current: MachineSettings = settings();

  // The section's words, drawn again in each new UI language. The
  // browser's or the app's (render/wording.ts) are the host's at the time;
  // `paint` follows a host that arrives later.
  localized(() => {
    title.textContent = t("config.title");
    const speedName = t("config.speed.label");
    speedLabelEl.replaceChildren(speedName, speedTip.element);
    speedTip.setName(t("config.speed.about"));
    speedTip.setText(t("config.speed.tip"));
    speedDown.setAttribute("aria-label", t("config.speed.decrease"));
    speedSlider.setAttribute("aria-label", speedName);
    speedUp.setAttribute("aria-label", t("config.speed.increase"));
    skipHeading.textContent = t("config.skip.section", { tab: "Tab" });
    skipLabelEl.textContent = t("config.skip.all");
    skipVideoLabelEl.textContent = t("config.skip.videos");
    playLabelEl.replaceChildren(t("config.playAll"), playTip.element);
    playTip.setName(t("config.playAll.about"));
    playTip.setText(t("config.playAll.tip"));
    soundLabelEl.textContent = t("config.sound");
    volumesButton.textContent = t("config.sound.volumes");
    volumesButton.setAttribute("aria-label", t("config.sound.volumesAria"));
    soundToggle.setAttribute("aria-label", t("config.sound"));
    progressSaved.textContent = ` · ${t("config.progress.saved")}`;
    progressHeading.replaceChildren(
      t("config.progress.section"),
      progressSaved,
      progressTip.element,
    );
    progressTip.setName(t("config.progress.about"));
    labelRow(
      exportRow,
      t("config.export.label"),
      t("config.export.button"),
      t("config.export.aria"),
    );
    labelRow(
      importRow,
      t("config.import.label"),
      t("config.import.button"),
      wordingFor(app()).importAria,
    );
    labelRow(
      resetRow,
      t("config.reset.label"),
      t("config.reset.button"),
      t("config.reset.aria"),
    );
    paint(current);
  });

  function paint(next: MachineSettings): void {
    current = next;
    // The host may have arrived since the mount: words follow it.
    const words = wordingFor(app());
    progressTip.setText(words.progressTip);
    importButton.setAttribute("aria-label", words.importAria);
    speedSlider.value = String(next.readingSpeed);
    speedValue.textContent = speedLabel(next.readingSpeed, next.msPerChar);
    skipToggle.textContent = skipAllLabel(next.skipAll);
    skipToggle.setAttribute("aria-pressed", String(next.skipAll));
    skipVideoToggle.textContent = skipVideosLabel(next.skipPlaysVideos);
    skipVideoToggle.setAttribute("aria-pressed", String(next.skipPlaysVideos));
    playToggle.textContent = playAllLabel(next.playAllRoutes);
    playToggle.setAttribute("aria-pressed", String(next.playAllRoutes));
    soundToggle.textContent = onOff(next.soundOn);
    soundToggle.setAttribute("aria-pressed", String(next.soundOn));
  }

  function move(next: MachineSettings): void {
    paint(next);
    onChange(next);
  }

  // One listener for the whole panel: a control acts, any other click is
  // backdrop and inert — only Escape or Space closes (Phase 24). A "?"
  // (`tip-…`) is a control with no action here: its own listener toggles
  // its tip, and no setting changes.
  panel.addEventListener("click", (event) => {
    const target = event.target;
    const control =
      target instanceof Element ? target.closest("[data-config-action]") : null;
    if (control === null) return;
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
    } else if (action === "sound") {
      move({ ...current, soundOn: !current.soundOn });
    } else if (action === "volumes") {
      sound?.onVolumes(volumesButton);
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

  return {
    panel,
    isOpen() {
      return !panel.hidden;
    },
    open() {
      paint(settings()); // always the values now in force, never a stale copy
      for (const tip of tips) tip.reset();
      panel.hidden = false;
    },
    refresh() {
      paint(settings());
    },
    setSound(shown) {
      if (sound === undefined || shown === (soundRow.parentElement !== null)) {
        return;
      }
      // Out of the group, not hidden: its rounded ends and hairlines go by
      // the rows it holds (index.html's `.config-row`).
      if (shown) playGroup.append(soundRow);
      else soundRow.remove();
    },
    close,
  };
}
