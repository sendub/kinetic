// The voice model's words and states for the Volumes sheet's Voice row
// (docs/plan.md Phase 52 item 10; the row itself is render/volumes.ts).
// Pure: the download's size, its progress, the "?" help, and what the row
// shows for each status of the voice engine (render/voiceclient.ts).
//
// A game app's error or unsupported machine comes with a `code` (docs/plan.md
// Phase 56 item 7; apps/README.md, "The voice bridge"), which the player
// words from its catalogue (`voice.code.<code>`); the host's `message` is
// an English detail for its log. Only a code the player does not know (or
// none, from an older app) shows the general words with that detail.

import { formatNumber, type MessageKey, t } from "../i18n/catalogue.ts";
import type { VoiceStatus } from "./voiceclient";

/** The row's words until the host gives a status. */
export function modelChecking(): string {
  return t("voice.checking");
}

/**
 * A download's size in GB (1e9 bytes), to one decimal place, written for
 * the UI language: "3.3 GB".
 */
export function gigabytes(bytes: number): string {
  return formatNumber(bytes / 1e9, {
    style: "unit",
    unit: "gigabyte",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false,
  });
}

/** The download button's words: "Download voice model (3.3 GB)". */
export function downloadLabel(bytes: number): string {
  return t("voice.download", { size: gigabytes(bytes) });
}

/** An install's progress in whole percent, 0 to 100 (0 with no total). */
export function installPercent(status: VoiceStatus): number {
  const { done, total } = status;
  if (done === undefined || total === undefined || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
}

/** The codes a game app sends with an error or an unsupported machine. */
export const VOICE_CODES = [
  "apple-silicon",
  "macos-version",
  "unsupported-system",
  "no-nvidia",
  "nvidia-driver",
  "disk-space",
  "download-failed",
  "hash-mismatch",
  "pip-failed",
  "install-failed",
  "folder-failed",
  "helper-failed",
  "helper-crashed",
  "lock-failed",
] as const;

const KNOWN_CODES: ReadonlySet<string> = new Set(VOICE_CODES);

/**
 * The words for a status in `error` or `unsupported`: the catalogue's for
 * its `code` (with its version or sizes); for an unknown code, or none,
 * the general words (`voice.failed`, `voice.unsupported`) and the host's
 * English `message` as a detail when it gave one.
 */
export function voiceProblem(status: VoiceStatus): string {
  const code = status.code;
  if (code !== undefined && KNOWN_CODES.has(code)) {
    return t(`voice.code.${code}` as MessageKey, {
      version: status.version ?? "?",
      need: gigabytes(status.needBytes ?? 0),
      free: gigabytes(status.freeBytes ?? 0),
    });
  }
  const general = t(
    status.state === "unsupported" ? "voice.unsupported" : "voice.failed",
  );
  const detail = status.message?.trim() ?? "";
  return detail === "" ? general : t("voice.detail", { text: general, detail });
}

/**
 * What the "?" beside the download says: what the model is and why it is
 * downloaded; on a machine that cannot run it, why not (`voiceProblem`).
 */
export function modelHelp(status: VoiceStatus): string {
  if (status.state === "unsupported") return voiceProblem(status);
  return t("voice.help", { size: gigabytes(status.downloadBytes) });
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
        message: voiceProblem(status),
      };
    case "ready":
      return { ...base, area: "none", ready: true, removable: true, label };
  }
}
