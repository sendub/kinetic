// What an item's voice is in the language shown (docs/plan.md Phase 54
// item 6; docs/content-format.md, "Translations"): a recording, a line
// the voice engine speaks live, or nothing. One pure rule (`lineVoice`),
// which the machine's voice hold, the sound, spoken lines and the Volumes
// sheet's Voice row all read, through `createLineVoices`.
//
// When the item's text shown comes from the language file (not a fallback):
// 1. the file's own recorded line for the item (`voice.items`), if any;
// 2. else, with the file's `keepOriginalVoice` and a manifest `audio.voice`,
//    that base recording, like subtitles;
// 3. else a live line of the translated text, in the engine's language for
//    the file's tag, when the speaker has a voice (or, with no speaker, the
//    game has a narrator) and the engine speaks that language;
// 4. else nothing. A base recording never plays under a translation
//    without `keepOriginalVoice`.
// When the text shown is the base's (no language file in use, or this
// item's string falls back), it is the manifest's own rule: its
// `audio.voice`, else a live line of the base text in the engine's
// language for the manifest's `language` (render/spoken.ts `spokenLine`).
// A language the engine does not speak is silent: nothing is asked for.
//
// Whether a live line is then asked for is spoken lines' business (a host
// that offers voice, the Voice volume up, the engine ready).
//
// A language file's track ids are its own: the sound keys them apart from
// the manifest's (`languageTrackKey`), so `de`'s `line-1` never meets the
// manifest's `line-1`.

import type {
  AudioTrack,
  Item,
  LanguageFile,
  Manifest,
} from "../machine/types";
import { fileItemText, ownEntry } from "./gamewords.ts";
import { DEFAULT_LANGUAGE, mediaPathError } from "./manifest.ts";
import {
  type Cast,
  castVoice,
  makeSpokenLine,
  type SpokenLine,
  spokenLine,
  voiceKeyOf,
} from "./spoken.ts";

/**
 * The languages the voice engine speaks: Chatterbox multilingual's language
 * ids, as the helper keeps them (apps/voice/kinetic_voice/engine.py
 * `LANGUAGES`, which refuses a `speak` in any other; its test checks the
 * two lists agree).
 */
export const ENGINE_LANGUAGES: readonly string[] = [
  "ar",
  "da",
  "de",
  "el",
  "en",
  "es",
  "fi",
  "fr",
  "he",
  "hi",
  "it",
  "ja",
  "ko",
  "ms",
  "nl",
  "no",
  "pl",
  "pt",
  "ru",
  "sv",
  "sw",
  "tr",
  "zh",
];

/** Primary subtags the engine knows by another id (engine.py too). */
const ENGINE_ALIASES: Readonly<Record<string, string>> = { nb: "no", nn: "no" };

/**
 * The engine's language id for the BCP 47 tag `tag`, by its primary
 * language subtag (`pt-BR` and `pt-PT` are `pt`, `zh-Hans` and `zh-Hant`
 * `zh`, `nb` and `nn` `no`); null when the engine does not speak it.
 */
export function engineLanguage(tag: string): string | null {
  const primary = tag.split("-", 1)[0]?.toLowerCase() ?? "";
  // A prototype key ("constructor") reads as no alias: not a string.
  const alias: unknown = ENGINE_ALIASES[primary];
  const id = typeof alias === "string" ? alias : primary;
  return ENGINE_LANGUAGES.includes(id) ? id : null;
}

/** What an item's voice is: a recorded track, or a line spoken live. */
export type LineVoice =
  | {
      readonly kind: "recorded";
      /** The track's key in the sound's table (`languageTrackKey` for a file's). */
      readonly track: string;
    }
  | { readonly kind: "live"; readonly line: SpokenLine };

/** The language shown: the manifest's base tag and the file in use, if any. */
export interface ShownLanguage {
  readonly base: string;
  /** Null: the base is shown. */
  readonly file: LanguageFile | null;
}

/** A language file's track id, keyed apart from the manifest's ids. */
export function languageTrackKey(tag: string, id: string): string {
  return `lang:${tag}:${id}`;
}

/** A language file's track as the sound plays it, or null when it is unusable. */
function usableTrack(value: unknown): AudioTrack | null {
  if (typeof value !== "object" || value === null) return null;
  const track = value as Partial<AudioTrack>;
  if (typeof track.file !== "string" || mediaPathError(track.file) !== null) {
    return null;
  }
  const length = track.durationSeconds;
  if (typeof length !== "number" || !Number.isFinite(length) || length <= 0) {
    return null;
  }
  return value as AudioTrack;
}

/** The track id the file's `voice.items` gives `itemId`, when it names a usable track. */
function fileRecording(file: LanguageFile, itemId: string): string | null {
  const voice = (file as { voice?: unknown }).voice;
  const id = ownEntry(ownEntry(voice, "items"), itemId);
  if (typeof id !== "string") return null;
  return usableTrack(ownEntry(ownEntry(voice, "tracks"), id)) === null
    ? null
    : id;
}

/**
 * Item `item`'s voice with `shown` the language on show (see the header);
 * null for silence.
 */
export function lineVoice(
  item: Item | undefined,
  cast: Cast,
  shown: ShownLanguage,
): LineVoice | null {
  if (item === undefined) return null;
  const { file } = shown;
  const text = fileItemText(file, item.id);
  if (file === null || text === null) {
    // The base text: the manifest's own rule.
    const recorded = item.audio?.voice;
    if (recorded !== undefined) return { kind: "recorded", track: recorded };
    const lang = engineLanguage(shown.base);
    if (lang === null) return null;
    const line = spokenLine(item, cast, true, lang);
    return line === null ? null : { kind: "live", line };
  }
  const own = fileRecording(file, item.id);
  if (own !== null) {
    return { kind: "recorded", track: languageTrackKey(file.language, own) };
  }
  const base = item.audio?.voice;
  if (file.keepOriginalVoice === true && base !== undefined) {
    return { kind: "recorded", track: base };
  }
  const lang = engineLanguage(file.language);
  const voice = voiceKeyOf(item);
  if (lang === null || castVoice(cast, voice) === undefined) return null;
  return { kind: "live", line: makeSpokenLine(voice, text, lang) };
}

/** The voices of a game's items in one shown language. */
export interface LineVoices {
  readonly shown: ShownLanguage;
  /** Item `index`'s voice (`lineVoice`). */
  at(index: number): LineVoice | null;
  /** Item `index`'s live line, or null. */
  live(index: number): SpokenLine | null;
  /** Item `index`'s recorded track key, or null. */
  recorded(index: number): string | null;
  /**
   * The language file's usable voice tracks, by `languageTrackKey`; empty
   * for the base.
   */
  readonly tracks: Readonly<Record<string, AudioTrack>>;
}

/** The voices of `manifest`'s items with `file` shown (null: the base). */
export function createLineVoices(
  manifest: Pick<Manifest, "items" | "language" | "voices" | "narrator">,
  file: LanguageFile | null,
): LineVoices {
  const shown: ShownLanguage = {
    base: manifest.language ?? DEFAULT_LANGUAGE,
    file,
  };
  const tracks: Record<string, AudioTrack> = {};
  if (file !== null) {
    const table = ownEntry((file as { voice?: unknown }).voice, "tracks");
    if (typeof table === "object" && table !== null) {
      for (const id of Object.keys(table)) {
        const track = usableTrack(ownEntry(table, id));
        if (track !== null) tracks[languageTrackKey(file.language, id)] = track;
      }
    }
  }
  const at = (index: number): LineVoice | null =>
    lineVoice(manifest.items[index], manifest, shown);
  return {
    shown,
    at,
    live(index) {
      const voice = at(index);
      return voice?.kind === "live" ? voice.line : null;
    },
    recorded(index) {
      const voice = at(index);
      return voice?.kind === "recorded" ? voice.track : null;
    },
    tracks,
  };
}
