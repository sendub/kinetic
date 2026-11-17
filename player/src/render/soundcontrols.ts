// The sound controls follow the language shown (docs/plan.md Phase 56 item
// 6b): the Esc screen's Sound row with its Volumes... button, `v` and the
// keys' row for it show while the language shown has a sound the reader
// can turn (render/soundrows.ts `soundContent`: music, effects or a video's
// sound, the same in every language, or that language's voice, recorded or
// live), and go when it has none. Decided at boot for the starting
// language, and again on every switch, without a reload: a language whose
// voice gives sound where the base gives none brings them, a language with
// no sound at all takes them away (the Volumes sheet closing, if open).
//
// The voice client (render/voiceclient.ts) is made the first time a
// language shown needs the voice model (`needsModel`: a host that offers
// voice, and a line that would be spoken live), at boot when the starting
// language does, and never in a game whose every line in every language
// is recorded or silent, which then sends the host nothing. Once made it
// stays: switching back and forth asks for nothing again.
//
// The state is kept here, apart from main.ts, so the rule is tested alone
// (soundcontrols.test.ts); main.ts wires its callbacks to the screens.

import type { SoundContent } from "./soundrows";

export interface SoundControlsOptions {
  /** What the starting language has. */
  readonly initial: SoundContent;
  /**
   * The sound is mounted (render/audio.ts `mountAudio` gave a player); read
   * on each decision, since the voice client is made before the mount.
   */
  audio(): boolean;
  /** Make the voice client: called once at most, when first needed. */
  makeVoiceClient(): void;
  /** The controls show (true) or go: called on a change only, never at boot. */
  show(shown: boolean): void;
  /** The language shown now has `content` (each switch, never at boot). */
  onContent(content: SoundContent): void;
}

export interface SoundControls {
  /** The controls show now. */
  shown(): boolean;
  /** What the language shown has now. */
  content(): SoundContent;
  /** A language was shown: decide again with what it has. */
  set(content: SoundContent): void;
}

/**
 * The controls' state for the starting language's `content`. Makes the
 * voice client at once when that language needs the model.
 */
export function createSoundControls(
  options: SoundControlsOptions,
): SoundControls {
  let current = options.initial;
  let voiceMade = false;
  const needVoice = (content: SoundContent): void => {
    if (voiceMade || !content.needsModel) return;
    voiceMade = true;
    options.makeVoiceClient();
  };
  const shown = (): boolean => options.audio() && current.any;
  needVoice(current);
  return {
    shown,
    content: () => current,
    set(next) {
      const before = shown();
      needVoice(next);
      current = next;
      options.onContent(next);
      const after = shown();
      if (after !== before) options.show(after);
    },
  };
}
