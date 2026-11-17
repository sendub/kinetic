// The pseudo-locale, for tests only (docs/plan.md Phase 56 item 2;
// docs/verify-player.md, "The player's words"): tag `en-XA`, every English
// message with its letters accented, padded to about 140% of its length
// (as German or Finnish may run) and wrapped in ⟦ ⟧, placeholders kept as
// written. A screen drawn in it shows at a glance any word that does not
// come from the catalogue (no markers) and any box too tight for a longer
// language. Readers never reach it: the player turns it on only when a
// test launcher put `KINETIC_TEST_LOCALE` on the page (main.ts).

import {
  addCatalogue,
  type Catalogue,
  type Message,
  type PluralMessage,
} from "./catalogue.ts";
import { EN } from "./en.ts";

/** The pseudo-locale's tag (a private-use region, never a real language). */
export const PSEUDO_LOCALE = "en-XA";

declare global {
  // Test only: player/scripts/testing/testlocale.mjs sets it.
  var KINETIC_TEST_LOCALE: string | undefined;
}

const ACCENTED: Readonly<Record<string, string>> = {
  a: "á",
  b: "ƀ",
  c: "ç",
  d: "ð",
  e: "é",
  f: "ƒ",
  g: "ĝ",
  h: "ĥ",
  i: "í",
  j: "ĵ",
  k: "ķ",
  l: "ļ",
  m: "ḿ",
  n: "ñ",
  o: "ó",
  p: "ṗ",
  q: "ʠ",
  r: "ŕ",
  s: "š",
  t: "ţ",
  u: "ú",
  v: "ṽ",
  w: "ŵ",
  x: "ẋ",
  y: "ý",
  z: "ž",
  A: "Á",
  B: "Ɓ",
  C: "Ç",
  D: "Ð",
  E: "É",
  F: "Ƒ",
  G: "Ĝ",
  H: "Ĥ",
  I: "Í",
  J: "Ĵ",
  K: "Ķ",
  L: "Ļ",
  M: "Ṁ",
  N: "Ñ",
  O: "Ó",
  P: "Ṗ",
  Q: "Ǫ",
  R: "Ŕ",
  S: "Š",
  T: "Ţ",
  U: "Ú",
  V: "Ṽ",
  W: "Ŵ",
  X: "Ẋ",
  Y: "Ý",
  Z: "Ž",
};

/** The opening and closing markers. */
export const PSEUDO_OPEN = "⟦";
export const PSEUDO_CLOSE = "⟧";

/** How much longer a pseudo message is than its English. */
export const PSEUDO_GROWTH = 0.4;

const PLACEHOLDER = /(\{[A-Za-z0-9_]+\})/;

/**
 * One English text as the pseudo-locale draws it: letters accented,
 * placeholders untouched, padded with short accented words to about 140%
 * of the English length (placeholders not counted), wrapped in the markers.
 */
export function pseudoText(text: string): string {
  let length = 0;
  const body = text
    .split(PLACEHOLDER)
    .map((part) => {
      if (PLACEHOLDER.test(part)) return part;
      length += [...part].length;
      return [...part].map((ch) => ACCENTED[ch] ?? ch).join("");
    })
    .join("");
  const extra = Math.ceil(length * PSEUDO_GROWTH);
  // Words of at most five letters, as a longer language's would break.
  const filler = "ẋýžŵƀ";
  let pad = "";
  for (let left = extra; left > 0; ) {
    const word = Math.min(5, Math.max(1, left - 1));
    pad += ` ${filler.slice(0, word)}`;
    left -= word + 1;
  }
  return `${PSEUDO_OPEN}${body}${pad}${PSEUDO_CLOSE}`;
}

/** A message of any shape in the pseudo-locale. */
export function pseudoMessage(message: Message): Message {
  if (typeof message === "string") return pseudoText(message);
  const out: Record<string, string> = {};
  for (const [category, text] of Object.entries(message)) {
    if (text !== undefined) out[category] = pseudoText(text);
  }
  return out as PluralMessage;
}

/** The whole English catalogue in the pseudo-locale. */
export function pseudoCatalogue(source: Catalogue = EN): Catalogue {
  const out: Record<string, Message> = {};
  for (const [key, message] of Object.entries(source)) {
    out[key] = pseudoMessage(message);
  }
  return out;
}

/**
 * Adds the pseudo-locale to the catalogue when a test launcher asked for
 * it (`flag` is `window.KINETIC_TEST_LOCALE`); returns its tag, or null
 * for every reader.
 */
export function enablePseudoLocale(flag: unknown): string | null {
  if (flag !== PSEUDO_LOCALE) return null;
  addCatalogue(PSEUDO_LOCALE, pseudoCatalogue());
  return PSEUDO_LOCALE;
}
