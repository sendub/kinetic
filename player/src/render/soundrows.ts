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
//
// With a game's language shown (docs/plan.md Phase 56 item 6), the Voice
// row and the model follow what that language would play: each item's
// voice as render/linevoice.ts `lineVoice` gives it, a recording (the
// manifest's, under `keepOriginalVoice` or a fallback line, or the language
// file's own) or a live line in a language the engine speaks. So a language
// whose every line is recorded offers no download. main.ts derives it again
// on each language switch.

import type { Manifest } from "../machine/types";
import { createLineVoices, type LineVoices } from "./linevoice";

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
 * (`kineticHost.voice`). `voices`: each item's voice in the language shown
 * (absent: the base's). One pass over the items, ended early once every
 * answer is known.
 */
export function soundContent(
  manifest: Manifest,
  hostVoice: boolean,
  voices: LineVoices = createLineVoices(manifest, null),
): SoundContent {
  const known = new Set(Object.keys(manifest.audio?.tracks ?? {}));
  const has = (id: string | null | undefined): boolean =>
    typeof id === "string" && known.has(id);
  let music = false;
  let effects = false;
  let recordedVoice = false;
  let needsModel = false;
  for (const [index, item] of manifest.items.entries()) {
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
    }
    if (!recordedVoice || (hostVoice && !needsModel)) {
      const voice = voices.at(index);
      if (!recordedVoice) recordedVoice = voice?.kind === "recorded";
      if (hostVoice && !needsModel) needsModel = voice?.kind === "live";
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
