// Languages by tag (docs/plan.md Phase 54 item 3): which of a game's
// languages a reader starts in, which catalogue language the player's own
// words take, which way a language's text runs, how long its lines are
// held, and what it calls itself. Pure and DOM-free: `Intl` only, with a
// small fallback where a browser lacks a part of it.

/** One language a reader's browser asks for, in its order of preference. */
export type RequestedLanguages = readonly string[];

/** The parts of a tag the matching compares, likely subtags filled in. */
interface LikelyTag {
  readonly language: string;
  readonly script: string;
  readonly region: string;
  /** The region as the tag itself wrote it ("" when it named none). */
  readonly ownRegion: string;
}

/**
 * Spanish of Latin America and the Caribbean, `es-419`: the regions CLDR
 * gives it as their parent (its `parentLocales`), so `es-MX` takes a
 * game's `es-419` before its plain `es`.
 */
const REGION_GROUPS: Readonly<Record<string, ReadonlySet<string>>> = {
  "419": new Set([
    "AR",
    "BO",
    "BR",
    "BZ",
    "CL",
    "CO",
    "CR",
    "CU",
    "DO",
    "EC",
    "GT",
    "HN",
    "MX",
    "NI",
    "PA",
    "PE",
    "PR",
    "PY",
    "SV",
    "US",
    "UY",
    "VE",
  ]),
};

/** `tag` with its likely script and region (`Intl.Locale.maximize`), or null. */
function likely(tag: string): LikelyTag | null {
  try {
    const locale = new Intl.Locale(tag);
    const full = locale.maximize();
    return {
      language: full.language,
      script: full.script ?? "",
      region: full.region ?? "",
      ownRegion: locale.region ?? "",
    };
  } catch {
    // No `Intl.Locale` (or a tag it refuses): the subtags as written.
    const parts = tag.split(/[-_]/);
    const language = (parts[0] ?? "").toLowerCase();
    if (!/^[a-z]{2,3}$/.test(language)) return null;
    const script = parts.find((p, i) => i > 0 && /^[A-Za-z]{4}$/.test(p));
    const region = parts.find(
      (p, i) => i > 0 && /^([A-Za-z]{2}|[0-9]{3})$/.test(p),
    );
    const own = region?.toUpperCase() ?? "";
    return {
      language,
      script: script === undefined ? "" : titleCase(script),
      region: own,
      ownRegion: own,
    };
  }
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Whether `region` belongs to the group a three-digit region names. */
function inGroup(group: string, region: string): boolean {
  return REGION_GROUPS[group]?.has(region) === true;
}

/**
 * The best of `available` for ONE requested tag, or null: the same tag
 * (case aside); else the same language, script and region once likely
 * subtags are filled in (`zh-TW` takes `zh-Hant`, whose region is TW);
 * else the same language and script with a region group holding the
 * requested region (`es-MX` takes `es-419`); else the same language and
 * script whatever the region, a tag naming no region first (`de-AT` takes
 * `de`, `es-MX` takes `es` when there is no `es-419`). A different script
 * never matches: `zh-CN` (Simplified) does not take `zh-Hant`.
 */
function matchOne(
  requested: string,
  available: readonly string[],
): string | null {
  const exact = available.find(
    (tag) => tag.toLowerCase() === requested.toLowerCase(),
  );
  if (exact !== undefined) return exact;
  const want = likely(requested);
  if (want === null) return null;
  const candidates = available
    .map((tag) => ({ tag, full: likely(tag) }))
    .filter(
      (c): c is { tag: string; full: LikelyTag } =>
        c.full !== null &&
        c.full.language === want.language &&
        c.full.script === want.script,
    );
  if (candidates.length === 0) return null;
  const sameRegion = candidates.find((c) => c.full.region === want.region);
  if (sameRegion !== undefined) return sameRegion.tag;
  const grouped = candidates.find((c) =>
    inGroup(c.full.ownRegion, want.region),
  );
  if (grouped !== undefined) return grouped.tag;
  const plain = candidates.find((c) => c.full.ownRegion === "");
  return (plain ?? candidates[0]).tag;
}

/**
 * The best of `available` for a reader asking for `requested`, in its
 * order (`navigator.languages`): the first requested tag with any match
 * (`matchOne`) wins, so a reader's first choice beats a closer match of
 * their second. Null when nothing matches.
 */
export function bestLanguageMatch(
  requested: RequestedLanguages,
  available: readonly string[],
): string | null {
  for (const tag of requested) {
    if (typeof tag !== "string" || tag === "") continue;
    const found = matchOne(tag, available);
    if (found !== null) return found;
  }
  return null;
}

/** What decides a game's starting language. */
export interface StartingLanguageInput {
  /** The manifest's `language`: the base. */
  readonly base: string;
  /** The manifest's `languages`: the language files. */
  readonly languages: readonly string[];
  /** The reader's saved choice for this story ("" or absent: none). */
  readonly saved?: string;
  /** `navigator.languages`. */
  readonly requested: RequestedLanguages;
}

/**
 * The language a game opens in (docs/plan.md Phase 54): the reader's saved
 * choice while the game still offers it; else the best match of the
 * browser's languages among the base and the language files; else the
 * base.
 */
export function startingLanguage({
  base,
  languages,
  saved,
  requested,
}: StartingLanguageInput): string {
  const offered = [base, ...languages];
  if (saved !== undefined && saved !== "" && offered.includes(saved)) {
    return saved;
  }
  return bestLanguageMatch(requested, offered) ?? base;
}

/** What decides the language of the player's own words. */
export interface UiLanguageInput {
  /** The language the reader picked on the Esc screen; "" or absent: none. */
  readonly chosen?: string;
  /** `navigator.languages`. */
  readonly requested: RequestedLanguages;
  /** The catalogue's languages (`uiLanguages()`), English first. */
  readonly catalogue: readonly string[];
}

/** The catalogue's source language, the last resort. */
const ENGLISH = "en";

/**
 * The language of the player's own words (docs/plan.md Phase 54): the
 * language the reader picked when the catalogue has it (a loose match:
 * a pick of `pt-BR` takes a catalogue's `pt-BR`, else its `pt`); with no
 * pick made, the browser's language when the catalogue has it; otherwise
 * English.
 */
export function uiLanguageFor({
  chosen,
  requested,
  catalogue,
}: UiLanguageInput): string {
  if (chosen !== undefined && chosen !== "") {
    return bestLanguageMatch([chosen], catalogue) ?? ENGLISH;
  }
  return bestLanguageMatch(requested, catalogue) ?? ENGLISH;
}

/** Scripts written right to left (Unicode's RTL scripts in use). */
const RTL_SCRIPTS = new Set([
  "Arab",
  "Hebr",
  "Thaa",
  "Syrc",
  "Nkoo",
  "Adlm",
  "Rohg",
  "Mand",
  "Samr",
]);

/** Languages written right to left, for a browser without `maximize`. */
const RTL_LANGUAGES = new Set([
  "ar",
  "fa",
  "he",
  "iw",
  "ur",
  "ps",
  "sd",
  "ug",
  "yi",
  "dv",
  "ckb",
  "ks",
]);

const directions = new Map<string, "rtl" | "ltr">();

/** The text direction of `tag`'s language: "rtl" or "ltr". */
export function textDirection(tag: string): "rtl" | "ltr" {
  let direction = directions.get(tag);
  if (direction === undefined) {
    direction = directionOf(tag);
    directions.set(tag, direction);
  }
  return direction;
}

function directionOf(tag: string): "rtl" | "ltr" {
  try {
    const locale = new Intl.Locale(tag) as Intl.Locale & {
      getTextInfo?: () => { direction?: string };
      textInfo?: { direction?: string };
    };
    const info = locale.getTextInfo?.() ?? locale.textInfo;
    if (info?.direction === "rtl" || info?.direction === "ltr") {
      return info.direction;
    }
    const script = locale.maximize().script;
    if (script !== undefined) return RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
  } catch {
    // An unknown tag or no Intl.Locale: the table below.
  }
  const language = tag.split(/[-_]/)[0]?.toLowerCase() ?? "";
  return RTL_LANGUAGES.has(language) ? "rtl" : "ltr";
}

/**
 * Reading time per language (docs/plan.md Phase 54; docs/content-format.md
 * "Timing"): `msPerChar` is scaled by this factor for a line in that
 * language, because the hold counts code points and these scripts say as
 * much in far fewer of them. The factor is 1 / (characters of the
 * translation / characters of the English), measured over parallel
 * translations of a converted corpus game (2026-11-16): every dialogue
 * line with both its English original and its translation, the speaker
 * and quotes stripped, `{tags}` and `[variables]` removed, code points
 * counted as the hold counts them:
 *
 *   Simplified Chinese  4390 lines, 68356 / 194531 = 0.351, factor 2.85
 *   Traditional Chinese 4304 lines, 67580 / 190569 = 0.355, factor 2.82
 *   Japanese            4417 lines, 90580 / 196193 = 0.462, factor 2.17
 *   Korean              4507 lines, 101777 / 199108 = 0.511, factor 1.96
 *
 * (German came out at 1.18 and French at 1.16: an alphabetic script's
 * longer text already gets its longer hold, so every other language
 * keeps 1.)
 */
const READING_FACTORS: Readonly<Record<string, number>> = {
  "zh-Hans": 2.85,
  "zh-Hant": 2.82,
  ja: 2.17,
  ko: 1.96,
};

const factors = new Map<string, number>();

/** The reading-time factor of `tag`'s language: 1 unless the table has it. */
export function readingFactor(tag: string): number {
  let factor = factors.get(tag);
  if (factor === undefined) {
    factor = factorOf(tag);
    factors.set(tag, factor);
  }
  return factor;
}

function factorOf(tag: string): number {
  const full = likely(tag);
  if (full === null) return 1;
  if (full.language === "zh") {
    // Chinese without a known script reads as Simplified, its likely one.
    return READING_FACTORS[full.script === "Hant" ? "zh-Hant" : "zh-Hans"];
  }
  return READING_FACTORS[full.language] ?? 1;
}

/**
 * `tag`'s language named in itself (`Intl.DisplayNames`), its first letter
 * upper-cased as that language does it (`Deutsch`, `Español`, `日本語`);
 * `fallback` (a language file's `name`) when the browser has no name for
 * it and gives back the tag, or `tag` itself without one.
 */
export function autonym(tag: string, fallback?: string): string {
  let named: string | undefined;
  try {
    named = new Intl.DisplayNames([tag], { type: "language" }).of(tag);
  } catch {
    named = undefined;
  }
  if (named === undefined || named === "" || named === tag) {
    return fallback !== undefined && fallback.trim() !== ""
      ? fallback.trim()
      : tag;
  }
  const first = String.fromCodePoint(named.codePointAt(0) ?? 0);
  let upper = first;
  try {
    upper = first.toLocaleUpperCase(tag);
  } catch {
    upper = first.toUpperCase();
  }
  return upper + named.slice(first.length);
}
