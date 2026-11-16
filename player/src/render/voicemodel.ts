// The voice model's words and states for the Volumes sheet's Voice row
// (docs/plan.md Phase 52 item 10; the row itself is render/volumes.ts).
// Pure: the download's size, its progress, the "?" help, and what the row
// shows for each status of the voice engine (render/voiceclient.ts).

import type { VoiceStatus } from "./voiceclient";

/** The row's words until the host gives a status. */
export const MODEL_CHECKING = "Checking…";
/** The help of a machine that cannot run the voices, when the host gives no reason. */
export const MODEL_UNSUPPORTED =
  "Spoken lines are not available on this computer.";
/** An error's words when the host gives none. */
export const MODEL_FAILED = "The voice model could not be downloaded.";

/** A download's size in GB (1e9 bytes), to one decimal place: "3.3 GB". */
export function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** The download button's words: "Download voice model (3.3 GB)". */
export function downloadLabel(bytes: number): string {
  return `Download voice model (${gigabytes(bytes)})`;
}

/** An install's progress in whole percent, 0 to 100 (0 with no total). */
export function installPercent(status: VoiceStatus): number {
  const { done, total } = status;
  if (done === undefined || total === undefined || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
}

/**
 * What the "?" beside the download says: what the model is and why it is
 * downloaded; on a machine that cannot run it, why not (the host's
 * `message`).
 */
export function modelHelp(status: VoiceStatus): string {
  if (status.state === "unsupported") {
    return status.message ?? MODEL_UNSUPPORTED;
  }
  return (
    "Spoken lines are made on this computer from the characters' voices. " +
    `The voice model is downloaded once (${gigabytes(status.downloadBytes)}) ` +
    "and every Kinetic game on this computer shares it."
  );
}

/** Which of the model's controls the Voice row shows in place of its slider. */
export type ModelArea =
  /** No status yet. */
  | "checking"
  /** The download button, greyed out when `disabled`. */
  | "download"
  /** The progress bar and Cancel. */
  | "progress"
  /** The message and Retry. */
  | "error"
  /** Installed: nothing but the slider. */
  | "none";

export interface ModelView {
  readonly area: ModelArea;
  /** The download button is greyed out: a machine that cannot run it. */
  readonly disabled: boolean;
  /** The "?" help text; null: no "?". */
  readonly help: string | null;
  /** The model is installed and ready: the slider shows. */
  readonly ready: boolean;
  /** The model is installed, so it can be removed. */
  readonly removable: boolean;
  /** The install's progress, 0 to 100. */
  readonly percent: number;
  /** The download button's words. */
  readonly label: string;
  /** An error's words. */
  readonly message: string;
}

/** The Voice row's view of `status` (null: the host has not said yet). */
export function voiceModelView(status: VoiceStatus | null): ModelView {
  const base: ModelView = {
    area: "checking",
    disabled: false,
    help: null,
    ready: false,
    removable: false,
    percent: 0,
    label: "",
    message: "",
  };
  if (status === null) return base;
  const label = downloadLabel(status.downloadBytes);
  switch (status.state) {
    case "absent":
      return { ...base, area: "download", label, help: modelHelp(status) };
    case "unsupported":
      return {
        ...base,
        area: "download",
        disabled: true,
        label,
        help: modelHelp(status),
      };
    case "installing":
      return {
        ...base,
        area: "progress",
        label,
        percent: installPercent(status),
      };
    case "error":
      return {
        ...base,
        area: "error",
        label,
        message: status.message ?? MODEL_FAILED,
      };
    case "ready":
      return { ...base, area: "none", ready: true, removable: true, label };
  }
}
