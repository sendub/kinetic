// A game's words in the shown language (docs/plan.md Phase 56 item 3;
// docs/content-format.md, "Translations"). The manifest holds the base
// language's text; a language file, `lang/<tag>.js`, translates some or
// all of it. `createGameWords` answers, for each string the player draws
// (an item's text, a speaker's name, a decision's prompt, a route's label,
// the game's name and release), the text to draw and the language it is
// in: the language file's when it has that string, else the base's, so a
// missing line shows the original marked with the base's tag. Pure: the
// DOM half below only loads a file.
//
// The manifest's `speaker` stays the speaker's identity everywhere else
// (voices, tools, the seen logic): only the drawn name changes.

import { readingFactor, textDirection } from "../i18n/languages.ts";
import type { Item, LanguageFile, Manifest } from "../machine/types";
import { DEFAULT_LANGUAGE, isLanguageTag } from "./manifest.ts";

/** A string as drawn: its text and the language it is in. */
export interface ShownText {
  readonly text: string;
  /** The tag to set as the element's `lang`. */
  readonly lang: string;
}

/** The manifest's words as one language shows them. */
export interface GameWords {
  /** The manifest's own language. */
  readonly base: string;
  /** The language shown (the base when no file is in use). */
  readonly shown: string;
  /** An item's text, or null when it has none to draw. */
  itemText(item: Item | undefined): ShownText | null;
  /** The drawn name of a manifest speaker. */
  speaker(name: string): ShownText;
  /** A decision's prompt (`base`, the manifest's, when untranslated). */
  prompt(decisionId: string, base: string): ShownText;
  /** A route's label (`base`, the manifest's, when untranslated). */
  label(decisionId: string, routeId: string, base: string): ShownText;
  /** The game's name: null when the manifest names none. */
  title(): ShownText | null;
  /** The game's release: null when the manifest gives none. */
  version(): ShownText | null;
}

/** A manifest text field, trimmed, or null when blank or not text. */
function plain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** A language file's translated text, when it is usable text. */
function translated(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" && text.trim() !== "" ? text : null;
}

/** An own property of a plain object, never one from its prototype. */
function own(record: unknown, key: string): unknown {
  if (typeof record !== "object" || record === null) return undefined;
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

/**
 * The language file's text for item `itemId`, or null when it has none
 * to draw (the item then shows the base text): the test of "this line is
 * translated" that render/linevoice.ts uses for the voice.
 */
export function fileItemText(
  file: LanguageFile | null,
  itemId: string,
): string | null {
  return file === null ? null : translated(own(file.items, itemId));
}

/**
 * An own property of a language file's table, never one from its
 * prototype (render/linevoice.ts reads its `voice` block through it).
 */
export function ownEntry(record: unknown, key: string): unknown {
  return own(record, key);
}

/**
 * The words of `manifest` shown through `file` (null: the base alone).
 * Every string falls back to the manifest's on its own.
 */
export function createGameWords(
  manifest: Pick<Manifest, "language" | "title" | "version">,
  file: LanguageFile | null,
): GameWords {
  const base = manifest.language ?? DEFAULT_LANGUAGE;
  const shown = file?.language ?? base;
  const pick = (from: unknown, fallback: string): ShownText => {
    const text = file === null ? null : translated(from);
    return text === null
      ? { text: fallback, lang: base }
      : { text, lang: shown };
  };
  return {
    base,
    shown,
    itemText(item) {
      if (item === undefined) return null;
      const text = item.text;
      if (text === undefined || text === "") return null;
      return pick(own(file?.items, item.id), text);
    },
    speaker(name) {
      const drawn = own(file?.speakers, name);
      return typeof drawn === "string" && drawn.trim() !== ""
        ? { text: drawn, lang: shown }
        : { text: name, lang: base };
    },
    prompt(decisionId, fallback) {
      return pick(own(own(file?.decisions, decisionId), "prompt"), fallback);
    },
    label(decisionId, routeId, fallback) {
      const routes = own(own(file?.decisions, decisionId), "routes");
      return pick(own(routes, routeId), fallback);
    },
    title() {
      const name = plain(manifest.title);
      if (name === null) return null;
      const shownTitle = pick(file?.title, name);
      return { ...shownTitle, text: shownTitle.text.trim() };
    },
    version() {
      const release = plain(manifest.version);
      if (release === null) return null;
      const shownVersion = pick(file?.version, release);
      return { ...shownVersion, text: shownVersion.text.trim() };
    },
  };
}

/**
 * Marks `element` as holding text in `lang`: its `lang`, and its `dir`
 * (right to left for Arabic, Persian, Hebrew, Urdu and the like), so a
 * fallback line carries the base's tag and its own direction.
 */
export function markLanguage(
  element: { lang: string; dir: string },
  lang: string,
): void {
  element.lang = lang;
  element.dir = textDirection(lang);
}

/**
 * An item's text and the reading-time factor of the language it is shown
 * in (the machine's `MachineWords.itemText`): a fallback line keeps the
 * base's factor.
 */
export function holdTextOf(
  words: GameWords,
  item: Item | undefined,
): { text: string | undefined; factor: number } {
  const shown = words.itemText(item);
  if (shown === null) return { text: item?.text, factor: 1 };
  return { text: shown.text, factor: readingFactor(shown.lang) };
}

declare global {
  /** Language files by tag, filled by each `lang/<tag>.js` as it loads. */
  var KINETIC_LANGUAGES: Record<string, unknown> | undefined;
}

/** The page's part a language file's script needs. */
export interface LanguageLoaderHost {
  readonly document: Document;
  readonly window: { KINETIC_LANGUAGES?: Record<string, unknown> };
}

/** How long a language file's script may take before it counts as failed. */
export const LANGUAGE_LOAD_TIMEOUT_MS = 10000;

/**
 * Whether `value` is a usable language file for `tag`: an object whose
 * `language` is the tag. The validator is the authority on the rest; a
 * string or table of the wrong shape falls back per string.
 */
export function isLanguageFileFor(
  value: unknown,
  tag: string,
): value is LanguageFile {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { language?: unknown }).language === tag
  );
}

/**
 * Loads `lang/<tag>.js` as a classic script, as `manifest.js` is loaded,
 * so it works over `file://`; resolves with the language file it sets on
 * `window.KINETIC_LANGUAGES[tag]`, or null when the script is missing,
 * fails, takes longer than `timeoutMs`, or sets something that is not a
 * language file for `tag`. A file already set (an earlier load) is used
 * as it is. The path resolves against the page, which sits in the content
 * folder, as every media path does (render/manifest.ts).
 */
export function loadLanguageFile(
  host: LanguageLoaderHost,
  tag: string,
  timeoutMs = LANGUAGE_LOAD_TIMEOUT_MS,
): Promise<LanguageFile | null> {
  const { document: doc, window: win } = host;
  // A tag is canonical (the manifest's `languages` keeps no other), so
  // the path names a file in `lang/` and nothing else.
  if (!isLanguageTag(tag)) return Promise.resolve(null);
  win.KINETIC_LANGUAGES = win.KINETIC_LANGUAGES ?? {};
  const read = (): LanguageFile | null => {
    const value = win.KINETIC_LANGUAGES?.[tag];
    return isLanguageFileFor(value, tag) ? value : null;
  };
  const ready = read();
  if (ready !== null) return Promise.resolve(ready);
  return new Promise((resolve) => {
    const script = doc.createElement("script");
    let done = false;
    const finish = (file: LanguageFile | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      script.remove();
      resolve(file);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    script.addEventListener("load", () => finish(read()));
    script.addEventListener("error", () => finish(null));
    script.src = `lang/${tag}.js`;
    doc.head.appendChild(script);
  });
}
