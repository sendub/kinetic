// What sound a game has, and so which sound controls it shows (docs/plan.md
// Phase 52 item 10): the Volumes sheet's Music, Effects and Voice rows, and
// with none of them no Volumes... button, no Sound row on the Esc screen and
// no `v`. Derived from the manifest once (main.ts), here, in one place.
//
// A row shows when something on its volume exists (render/audiorules.ts
// `groupVolume` names the volume each kind of sound uses):
// - Music: music or ambience, from a track the game defines;
// - Effects: one-shots, and a video's own sound (it plays on Effects);
// - Voice: a recorded voice line (`audio.voice`), or, in a game app whose
//   host offers voice, a line the voice model would speak: an item the live
//   rule (render/spoken.ts `spokenLine`) speaks, so with text, a cast voice
//   and no recorded line. The model is offered only then (`needsModel`).

import type { Manifest } from "../machine/types";
import { spokenLine } from "./spoken";

export interface SoundContent {
  /** Music or ambience: the Music row. */
  readonly music: boolean;
  /** One-shots or a video's sound: the Effects row. */
  readonly effects: boolean;
  /** Some item has a recorded voice line. */
  readonly recordedVoice: boolean;
  /**
   * The voice model is wanted: the host offers voice and some line has no
   * recording and would be spoken. The voice client exists only then.
   */
  readonly needsModel: boolean;
  /** The Voice row shows: recorded lines, or the model is wanted. */
  readonly voice: boolean;
  /** Any row shows, so the Volumes... button, Sound row and `v` do. */
  readonly any: boolean;
}

/**
 * The content of `manifest`. `hostVoice`: the host offers voice
 * (`kineticHost.voice`). One pass over the items, ended early once every
 * answer is known.
 */
export function soundContent(
  manifest: Manifest,
  hostVoice: boolean,
): SoundContent {
  const known = new Set(Object.keys(manifest.audio?.tracks ?? {}));
  const has = (id: string | null | undefined): boolean =>
    typeof id === "string" && known.has(id);
  let music = false;
  let effects = false;
  let recordedVoice = false;
  let needsModel = false;
  for (const item of manifest.items) {
    const audio = item.audio;
    if (audio !== undefined) {
      if (!music) {
        music =
          has(audio.music) || (audio.ambience ?? []).some((id) => has(id));
      }
      if (!effects) {
        effects =
          (audio.sfx ?? []).some((cue) => has(cue.track)) ||
          ("videoSound" in audio && has(audio.videoSound?.track));
      }
      if (!recordedVoice) recordedVoice = audio.voice !== undefined;
    }
    if (hostVoice && !needsModel) {
      needsModel = spokenLine(item, manifest, true) !== null;
    }
    if (music && effects && recordedVoice && (needsModel || !hostVoice)) break;
  }
  const voice = recordedVoice || needsModel;
  return {
    music,
    effects,
    recordedVoice,
    needsModel,
    voice,
    any: music || effects || voice,
  };
}
