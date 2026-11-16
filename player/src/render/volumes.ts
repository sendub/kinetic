// The sound controls (docs/plan.md Phase 47 item 7, Phase 52 item 10) beside
// `v` and the Esc screen's Sound row (render/config.ts): the `v` pill's
// words, the volume steps, and the Volumes sheet. The sheet has a row only
// for the sound the game has (render/soundrows.ts): Music, Effects, Voice;
// a game with none mounts no sheet, no Sound row and no `v`.
//
// The sheet opens from the Sound row's "Volumes..." over the Esc screen,
// styled and handled like the reset box (render/confirm.ts): centred, the
// screen frosted behind it, a click outside it closes it, and Escape
// closes it alone (main.ts asks it first). It is a modal dialog: focus
// goes to its first slider when it opens, Tab and Shift+Tab move through
// the controls on show and wrap at either end (the key map takes Tab
// everywhere else, for skip), and focus goes back to the button it came
// from when it closes. Each volume is a `- slider +` row like the
// auto-forward speed: a change applies and is saved at once through
// `onChange`. Music and ambience play while the sheet is open
// (render/audio.ts `setVolumesOpen`, told through `onOpenChange`); an
// Effects or Voice change asks `onSample` for a short sample at the new
// level, on each press of - or +, each arrow-key step and the end of a drag
// (the slider's `change`).
//
// The Voice row, when the game's lines need the voice model (`voiceModel`
// given): the model's own controls take the slider's place until it is
// installed, or a second line under it when recorded lines keep the slider
// (render/voicemodel.ts `voiceModelView` decides which show). Absent: a
// "Download voice model" button with its size and a "?" help (hover or
// keyboard focus, as the Esc screen's, with `aria-describedby`); installing:
// a progress bar with Cancel; an error: its words and Retry; unsupported:
// the button greyed out, the "?" giving the reason; ready: the slider, and
// a small "Remove voice model" beside the label, which asks first (main.ts).
// The status repaints while the sheet is open; a control that had focus and
// is hidden by it hands focus on, to the new slider when the model is
// ready. The Voice volume is the only control of spoken lines: at 0 none
// are made (render/spoken.ts `spokenOn`).

import type { MachineSettings } from "../machine/types";
import { mountTip, type Tip } from "./config";
import { onScrimClick } from "./scrim";
import type { SoundContent } from "./soundrows";
import type { VoiceStatus } from "./voiceclient";
import { MODEL_CHECKING, voiceModelView } from "./voicemodel";

/** The `v` pill (like Tab's and `a`'s mode pills). */
export const SOUND_ON_MESSAGE = "Sound on";
export const SOUND_OFF_MESSAGE = "Sound off";

/** The pill naming the state sound is now in. */
export function soundMessage(on: boolean): string {
  return on ? SOUND_ON_MESSAGE : SOUND_OFF_MESSAGE;
}

/** The volumes walk 0 to 1 in this step. */
export const VOLUME_STEP = 0.1;

/**
 * One press of - (`delta` -1) or + (1), or a drag's raw value (0): snapped
 * onto the 0.1 grid, counted in tenths so it lands on exact tenths (0.3,
 * never 0.30000000000000004), and clamped to 0-1.
 */
export function stepVolume(current: number, delta: number): number {
  const tenths = Math.round(current / VOLUME_STEP) + delta;
  return Math.min(10, Math.max(0, tenths)) / 10;
}

/** A volume's readout: "90%". */
export function volumeLabel(volume: number): string {
  return `${String(Math.round(volume * 100))}%`;
}

/** A setting the sheet changes. */
export type VolumeSetting = "musicVolume" | "effectsVolume" | "voiceVolume";
/** The groups whose change plays a sample (render/audio.ts `sample`). */
export type SampleGroup = "effects" | "voice";

/** One row of the sheet. */
export interface VolumeRow {
  readonly setting: VolumeSetting;
  readonly label: string;
  /** Its controls' `data-config-action` prefix: `volume-<name>-down`. */
  readonly name: string;
  /** The sample a change plays; null for Music, which plays already. */
  readonly sample: SampleGroup | null;
}

const ROWS: readonly VolumeRow[] = [
  { setting: "musicVolume", label: "Music", name: "music", sample: null },
  {
    setting: "effectsVolume",
    label: "Effects",
    name: "effects",
    sample: "effects",
  },
  { setting: "voiceVolume", label: "Voice", name: "voice", sample: "voice" },
];

/** The sheet's rows: only the kinds of sound the game has. */
export function volumeRows(content: SoundContent): readonly VolumeRow[] {
  return ROWS.filter((row) => {
    if (row.setting === "musicVolume") return content.music;
    if (row.setting === "effectsVolume") return content.effects;
    return content.voice;
  });
}

export const VOLUMES_TITLE = "Volumes";
export const VOLUMES_HINT = "Esc closes";

/** The voice engine as the Voice row uses it (main.ts: the voice client). */
export interface VoiceModelControls {
  status(): VoiceStatus | null;
  /** Calls `listener` on each status change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  onInstall(): void;
  onCancel(): void;
  /** Asks to remove the model (the shell confirms first). */
  onRemove(): void;
}

export interface VolumesOverlay {
  isOpen(): boolean;
  /**
   * Shows the sheet on the settings in force, focus on its first slider;
   * focus goes back to `opener` when it closes.
   */
  open(opener: HTMLElement | null): void;
  close(): void;
}

export interface VolumesOverlayOptions {
  /** The `#app` element; the sheet is a sibling of the other panels. */
  root: HTMLElement;
  /** What sound the game has: the rows. */
  content: SoundContent;
  /**
   * The voice engine, when some line needs the model (`content.needsModel`);
   * absent otherwise: the Voice row is a plain slider.
   */
  voiceModel?: VoiceModelControls;
  /** Another box (the confirmation) is over the sheet: it takes no Tab. */
  suspended?(): boolean;
  /** The settings in force, read on every open. */
  settings(): MachineSettings;
  /** A volume moved: the full next settings, to apply and save. */
  onChange(next: MachineSettings): void;
  /** An Effects or Voice change: play a sample at the new level. */
  onSample(group: SampleGroup): void;
  /** The sheet opened (true) or closed. */
  onOpenChange(open: boolean): void;
}

export function mountVolumesOverlay({
  root,
  content,
  voiceModel,
  suspended,
  settings,
  onChange,
  onSample,
  onOpenChange,
}: VolumesOverlayOptions): VolumesOverlay {
  const doc = root.ownerDocument;

  // The panel is the scrim over the Esc screen; the sheet is the box on it,
  // so a click on the scrim (outside the sheet) is told from one inside.
  const panel = doc.createElement("div");
  panel.id = "volumes";
  panel.className = "volumes";
  panel.hidden = true;
  const sheet = doc.createElement("div");
  sheet.className = "volumes-sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", "volumes-title");

  const title = doc.createElement("h2");
  title.className = "volumes-title";
  title.id = "volumes-title";
  title.textContent = VOLUMES_TITLE;

  const list = doc.createElement("div");
  list.className = "volumes-list";

  const button = (
    className: string,
    text: string,
    aria: string,
    action: string,
  ): HTMLButtonElement => {
    const el = doc.createElement("button");
    el.className = className;
    el.type = "button";
    el.textContent = text;
    if (aria !== "") el.setAttribute("aria-label", aria);
    el.setAttribute("data-config-action", action);
    return el;
  };

  // The rows, as the speed cell draws its own (config.ts): the label and
  // readout on the top line, then - slider + across the cell. Every
  // control carries `data-config-action`, so a click on one never asks
  // for fullscreen (config.ts `isSettingsControl`).
  const painters: ((next: MachineSettings) => void)[] = [];
  const sliders: HTMLInputElement[] = [];
  let current: MachineSettings = settings();
  /** Repaints the Voice row's model controls (none without a model). */
  let paintModel: () => void = () => undefined;
  /** The tip of the model's "?", reset on each open. */
  let modelTip: Tip | null = null;
  /** The controls a model state hides; each hands its focus on. */
  const modelControls: HTMLElement[] = [];

  function move(row: VolumeRow, volume: number): void {
    current = { ...current, [row.setting]: volume };
    paint(current);
    onChange(current);
  }

  for (const row of volumeRows(content)) {
    const cell = doc.createElement("div");
    cell.className = "config-row config-slide volume-row";
    cell.setAttribute("data-volume", row.setting);
    const label = doc.createElement("span");
    label.className = "config-label";
    label.textContent = row.label;
    const lower = row.label.toLowerCase();
    const down = button(
      "config-step",
      "−",
      `Decrease ${lower} volume`,
      `volume-${row.name}-down`,
    );
    const slider = doc.createElement("input");
    slider.type = "range";
    slider.className = "config-slider";
    slider.min = "0";
    slider.max = "1";
    slider.step = String(VOLUME_STEP);
    slider.setAttribute("aria-label", `${row.label} volume`);
    slider.setAttribute("data-config-action", `volume-${row.name}-slider`);
    const up = button(
      "config-step",
      "+",
      `Increase ${lower} volume`,
      `volume-${row.name}-up`,
    );
    const value = doc.createElement("span");
    value.className = "config-value";
    cell.append(label);
    const remove = row.setting === "voiceVolume" && voiceModel !== undefined;
    let removeButton: HTMLButtonElement | null = null;
    if (remove) {
      // Beside the label, small, once the model is installed.
      removeButton = button(
        "config-toggle volume-remove",
        "Remove voice model",
        "Remove the voice model from this computer to free its space",
        "volume-voice-remove",
      );
      removeButton.hidden = true;
      cell.append(removeButton);
    }
    cell.append(down, slider, up, value);
    list.append(cell);
    sliders.push(slider);

    const sample = (): void => {
      if (row.sample !== null) onSample(row.sample);
    };
    down.addEventListener("click", () => {
      move(row, stepVolume(current[row.setting], -1));
      sample();
    });
    up.addEventListener("click", () => {
      move(row, stepVolume(current[row.setting], 1));
      sample();
    });
    // A drag or an arrow key: `input` carries each value, snapped onto the
    // grid; `change` comes once a drag ends (and on each key step), when
    // the sample plays, so a drag is not a stutter of restarts.
    slider.addEventListener("input", () => {
      const raw = Number.parseFloat(slider.value);
      if (!Number.isNaN(raw)) move(row, stepVolume(raw, 0));
    });
    slider.addEventListener("change", sample);
    painters.push((next) => {
      slider.value = String(next[row.setting]);
      value.textContent = volumeLabel(next[row.setting]);
    });

    if (voiceModel !== undefined && removeButton !== null) {
      const model = voiceModel;
      const area = doc.createElement("div");
      area.className = "volume-model";
      const message = doc.createElement("span");
      message.className = "volume-model-message";
      const download = button(
        "config-toggle volume-model-download",
        "",
        "",
        "volume-model-download",
      );
      const tip = mountTip(
        doc,
        "voice-model",
        "the voice model",
        "",
        () => undefined,
      );
      modelTip = tip;
      download.setAttribute("aria-describedby", tip.id);
      const bar = doc.createElement("div");
      bar.className = "volume-progress";
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-label", "Voice model download");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      const fill = doc.createElement("span");
      fill.className = "volume-progress-fill";
      bar.append(fill);
      const percent = doc.createElement("span");
      percent.className = "volume-progress-value";
      const cancel = button(
        "config-toggle volume-model-cancel",
        "Cancel",
        "Cancel the voice model download",
        "volume-model-cancel",
      );
      const retry = button(
        "config-toggle volume-model-retry",
        "Retry",
        "Retry the voice model download",
        "volume-model-retry",
      );
      area.append(message, download, tip.element, bar, percent, cancel, retry);
      cell.append(area);
      modelControls.push(download, cancel, retry, removeButton);

      download.addEventListener("click", () => {
        if (download.getAttribute("disabled") === null) model.onInstall();
      });
      retry.addEventListener("click", () => model.onInstall());
      cancel.addEventListener("click", () => model.onCancel());
      removeButton.addEventListener("click", () => model.onRemove());

      const stepControls: HTMLElement[] = [down, slider, up, value];
      const dropRemove = removeButton;
      paintModel = () => {
        const status = model.status();
        const view = voiceModelView(status);
        const focused = doc.activeElement as HTMLElement | null;
        const hadFocus =
          focused !== null &&
          [...modelControls, slider].includes(focused as never);
        cell.setAttribute("data-state", status?.state ?? "checking");
        // The slider stands in for the model only with no recorded lines:
        // recorded lines keep it, and the model takes a second line.
        const sliderShown = content.recordedVoice || view.ready;
        for (const el of stepControls) el.hidden = !sliderShown;
        cell.setAttribute("data-slider", sliderShown ? "on" : "off");
        dropRemove.hidden = !view.removable;
        area.hidden = view.area === "none";
        message.hidden = view.area !== "checking" && view.area !== "error";
        message.textContent =
          view.area === "checking" ? MODEL_CHECKING : view.message;
        const shown = view.area === "download";
        download.hidden = !shown;
        download.textContent = view.label;
        if (view.disabled) {
          download.setAttribute("disabled", "");
          download.setAttribute("aria-disabled", "true");
        } else {
          download.removeAttribute("disabled");
          download.removeAttribute("aria-disabled");
        }
        tip.element.hidden = view.help === null;
        if (view.help !== null) tip.setText(view.help);
        bar.hidden = view.area !== "progress";
        percent.hidden = view.area !== "progress";
        cancel.hidden = view.area !== "progress";
        retry.hidden = view.area !== "error";
        bar.setAttribute("aria-valuenow", String(view.percent));
        fill.style.width = `${String(view.percent)}%`;
        percent.textContent = `${String(view.percent)}%`;
        // A control that had the focus and is hidden now hands it on: the
        // new slider once the model is ready, else the state's first
        // control, so the keyboard stays in the row.
        if (hadFocus && focused !== null && !isShown(focused)) {
          const target = view.ready
            ? slider
            : [download, cancel, retry].find(isFocusable);
          (target ?? done).focus({ preventScroll: true });
        }
      };
    }
  }

  const done = button(
    "confirm-button volumes-done",
    "Done",
    "",
    "volumes-done",
  );
  done.addEventListener("click", () => close());
  const hint = doc.createElement("p");
  hint.className = "volumes-hint";
  hint.textContent = VOLUMES_HINT;

  sheet.append(title, list, done, hint);
  panel.append(sheet);
  root.appendChild(panel);

  function paint(next: MachineSettings): void {
    for (const painter of painters) painter(next);
  }
  paint(current);

  /** Whether `el` and everything above it in the sheet is on show. */
  function isShown(el: HTMLElement): boolean {
    for (let e: HTMLElement | null = el; e !== null && e !== sheet; ) {
      if (e.hidden) return false;
      e = e.parentElement;
    }
    return true;
  }
  /** On show, and not greyed out: a control Tab can reach. */
  function isFocusable(el: HTMLElement): boolean {
    return isShown(el) && el.getAttribute("disabled") === null;
  }
  const focusables = (): HTMLElement[] =>
    [...sheet.querySelectorAll<HTMLElement>("button, input")].filter(
      isFocusable,
    );

  // A click on the scrim, outside the sheet, closes it (as one on the
  // reset box's backdrop cancels it); one inside it only acts on its
  // controls.
  // A drag that began on the sheet and ended on the scrim is not one
  // (render/scrim.ts).
  onScrimClick<MouseEvent>(panel, (event) => {
    if (event.target === panel) close();
  });

  // Focus kept inside: Tab and Shift+Tab move through the controls on show
  // and wrap. Taken in the capture phase, before the key map's own Tab
  // (skip, which a panel suspends), and wherever focus is, so a click on
  // the sheet's text that dropped focus to the page still Tabs back in.
  // Not while the confirmation box is over the sheet.
  doc.addEventListener(
    "keydown",
    (event) => {
      if (panel.hidden || event.key !== "Tab") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (suspended?.() === true) return;
      event.preventDefault();
      const controls = focusables();
      const at = controls.indexOf(doc.activeElement as HTMLElement);
      const last = controls.length - 1;
      const next = event.shiftKey
        ? at <= 0
          ? last
          : at - 1
        : at < 0 || at === last
          ? 0
          : at + 1;
      controls[next]?.focus();
    },
    true,
  );

  // The model's status, live while the sheet is open (and kept current
  // while it is shut, so it opens right).
  voiceModel?.subscribe(() => paintModel());
  paintModel();

  let opener: HTMLElement | null = null;

  function close(): void {
    if (panel.hidden) return;
    panel.hidden = true;
    onOpenChange(false);
    const back = opener;
    opener = null;
    back?.focus({ preventScroll: true });
  }

  return {
    isOpen() {
      return !panel.hidden;
    },
    open(from) {
      if (!panel.hidden) return;
      opener = from;
      current = settings();
      paint(current);
      paintModel();
      modelTip?.reset();
      panel.hidden = false;
      // The first slider on show; with none (the model stands in for the
      // Voice slider), the first control.
      const first = sliders.find(isFocusable) ?? focusables()[0] ?? done;
      first.focus({ preventScroll: true });
      onOpenChange(true);
    },
    close,
  };
}
