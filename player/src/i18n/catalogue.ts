// The player's own words (docs/plan.md Phase 54 item 2): every string the
// player draws or names for assistive tech comes from here by key, never
// from a literal in a render module. English (./en.ts) is the source of
// truth; other languages are compiled from player/locales/<tag>.po into
// ./locales.generated.ts by scripts/i18n.mjs (docs/verify-player.md,
// "The player's words"). A lookup falls back to English per message: a key
// a language lacks, or a language the catalogue lacks, reads the English.
//
// A message is a string with `{name}` placeholders, or a plural message:
// an object keyed by CLDR plural category (`one`, `other`, and for some
// languages `zero`, `two`, `few`, `many`), the category picked by
// `Intl.PluralRules` for the active language from the `count` parameter.
// Number parameters are written with `Intl.NumberFormat` (no grouping, so
// the English reads as it always has).
//
// The active UI language changes at runtime (`setUiLanguage`): every
// mounted component draws its words through `localized`, which redraws
// them on each change, so a switch needs no reload. DOM-free: the machine
// (choice countdown words) reads it too.

import { EN } from "./en.ts";
import { LOCALES } from "./locales.generated.ts";

/** A CLDR plural category. */
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

/** A plural message: one text per category the language uses. */
export type PluralMessage = { readonly other: string } & {
  readonly [category in Exclude<PluralCategory, "other">]?: string;
};

export type Message = string | PluralMessage;

/** One language's messages by key (a partial one falls back to English). */
export type Catalogue = Readonly<Record<string, Message>>;

/** Every key the player draws. */
export type MessageKey = keyof typeof EN;

/** Placeholder values: numbers are formatted for the language. */
export type MessageParams = Readonly<Record<string, string | number>>;

/** The source language and the fallback for every message. */
export const SOURCE_LANGUAGE = "en";

let active = SOURCE_LANGUAGE;
/** Catalogues added at runtime (the test-only pseudo-locale, ./pseudo.ts). */
const added = new Map<string, Catalogue>();
const listeners = new Set<() => void>();

/** The catalogue for `tag`, or undefined (English then serves). */
function catalogueFor(tag: string): Catalogue | undefined {
  return added.get(tag) ?? LOCALES[tag];
}

/** The languages the catalogue has, English first. */
export function uiLanguages(): string[] {
  return [SOURCE_LANGUAGE, ...Object.keys(LOCALES)];
}

/** Adds (or replaces) a language at runtime; ./pseudo.ts only. */
export function addCatalogue(tag: string, catalogue: Catalogue): void {
  added.set(tag, catalogue);
}

/** The UI language in force (a BCP 47 tag). */
export function uiLanguage(): string {
  return active;
}

/**
 * Switches the UI language: every `localized` drawing and every
 * `onUiLanguageChange` listener runs again. A tag the catalogue lacks is
 * kept (the document is marked with it) and reads English.
 */
export function setUiLanguage(tag: string): void {
  if (tag === active) return;
  active = tag;
  for (const listener of [...listeners]) listener();
}

/** Calls `listener` after each change of language; returns the unsubscribe. */
export function onUiLanguageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Runs `draw` now and again after each change of language: a component
 * puts its words on screen inside it. Returns the unsubscribe.
 */
export function localized(draw: () => void): () => void {
  draw();
  return onUiLanguageChange(draw);
}

const numberFormats = new Map<string, Intl.NumberFormat>();
const pluralRules = new Map<string, Intl.PluralRules>();

/** A language tag `Intl` accepts: `tag`, else English. */
function intlTag(tag: string): string {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? SOURCE_LANGUAGE;
  } catch {
    return SOURCE_LANGUAGE;
  }
}

/**
 * `value` written for the UI language. With no options: an integer or
 * decimal with no grouping (`1234`, as the English always read).
 */
export function formatNumber(
  value: number,
  options: Intl.NumberFormatOptions = { useGrouping: false },
): string {
  const tag = intlTag(active);
  const key = `${tag}\u0000${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(tag, options);
    numberFormats.set(key, format);
  }
  return format.format(value);
}

/** The plural category of `count` in the UI language. */
export function pluralCategory(count: number): PluralCategory {
  const tag = intlTag(active);
  let rules = pluralRules.get(tag);
  if (rules === undefined) {
    rules = new Intl.PluralRules(tag);
    pluralRules.set(tag, rules);
  }
  return rules.select(count) as PluralCategory;
}

/** The raw message for `key` in the UI language, else English. */
function messageFor(key: string): Message | undefined {
  return catalogueFor(active)?.[key] ?? (EN as Catalogue)[key];
}

/** Fills `{name}` placeholders; an unknown one is left as written. */
export function interpolate(text: string, params: MessageParams = {}): string {
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) return whole;
    return typeof value === "number" ? formatNumber(value) : value;
  });
}

/**
 * The message `key` in the UI language with its placeholders filled. A
 * plural message picks its category from `params.count` (0 when absent);
 * a category the language's text lacks reads its `other`.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const message = messageFor(key);
  if (message === undefined) return key;
  if (typeof message === "string") return interpolate(message, params);
  const count = Number(params?.count ?? 0);
  const text = message[pluralCategory(count)] ?? message.other;
  return interpolate(text, params);
}
