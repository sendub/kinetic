import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { uiLanguages } from "./catalogue";
import {
  autonym,
  bestLanguageMatch,
  readingFactor,
  startingLanguage,
  textDirection,
  uiLanguageFor,
} from "./languages";

describe("bestLanguageMatch: a reader's languages against a game's", () => {
  it("takes the same tag first, case aside", () => {
    expect(bestLanguageMatch(["de"], ["en", "de", "de-AT"])).toBe("de");
    expect(bestLanguageMatch(["pt-br"], ["en", "pt-PT", "pt-BR"])).toBe(
      "pt-BR",
    );
  });

  it("takes the same language and script: zh-TW takes zh-Hant, zh-CN zh-Hans", () => {
    const game = ["en", "zh-Hans", "zh-Hant"];
    expect(bestLanguageMatch(["zh-TW"], game)).toBe("zh-Hant");
    expect(bestLanguageMatch(["zh-CN"], game)).toBe("zh-Hans");
    expect(bestLanguageMatch(["zh-HK"], game)).toBe("zh-Hant");
    expect(bestLanguageMatch(["zh"], game)).toBe("zh-Hans");
  });

  it("never matches another script", () => {
    expect(bestLanguageMatch(["zh-CN"], ["en", "zh-Hant"])).toBeNull();
    expect(bestLanguageMatch(["zh-TW"], ["en", "zh-Hans"])).toBeNull();
    expect(bestLanguageMatch(["sr-Latn"], ["en", "sr"])).toBeNull();
  });

  it("ignores the region: de-AT takes de", () => {
    expect(bestLanguageMatch(["de-AT"], ["en", "de"])).toBe("de");
    expect(bestLanguageMatch(["en-GB"], ["en", "de"])).toBe("en");
    expect(bestLanguageMatch(["fr-CA"], ["en", "fr"])).toBe("fr");
  });

  it("takes es-419 for a Latin American Spanish before plain es", () => {
    const game = ["en", "es", "es-419"];
    expect(bestLanguageMatch(["es-MX"], game)).toBe("es-419");
    expect(bestLanguageMatch(["es-AR"], game)).toBe("es-419");
    expect(bestLanguageMatch(["es-ES"], game)).toBe("es");
    expect(bestLanguageMatch(["es"], game)).toBe("es");
    expect(bestLanguageMatch(["es-MX"], ["en", "es"])).toBe("es");
    expect(bestLanguageMatch(["es-ES"], ["en", "es-419"])).toBe("es-419");
  });

  it("prefers a regionless tag over another region", () => {
    expect(bestLanguageMatch(["pt-AO"], ["en", "pt-BR", "pt"])).toBe("pt");
  });

  it("goes through the reader's languages in order", () => {
    expect(bestLanguageMatch(["fr", "de"], ["en", "de", "ja"])).toBe("de");
    expect(bestLanguageMatch(["ja-JP", "de"], ["en", "de", "ja"])).toBe("ja");
    expect(bestLanguageMatch(["fr", "it"], ["en", "de"])).toBeNull();
    expect(bestLanguageMatch([], ["en", "de"])).toBeNull();
  });

  it("skips what is not a tag", () => {
    expect(bestLanguageMatch(["", "!!", "de"], ["en", "de"])).toBe("de");
  });
});

describe("the game apps' cases (apps/host-language-cases.json, Phase 54 item 7)", () => {
  // The Mac app and the Windows program pick their own words' language by
  // the same rule, from the same cases (hostwords_test.go, the machost
  // scenario).
  const file = JSON.parse(
    readFileSync(
      new URL("../../../apps/host-language-cases.json", import.meta.url),
      "utf8",
    ),
  ) as {
    catalogue: string[];
    cases: { requested: string[]; expect: string | null }[];
  };

  it("are against the catalogue's languages, English first", () => {
    expect(file.catalogue).toEqual(uiLanguages());
  });

  it("match as the player matches", () => {
    for (const { requested, expect: want } of file.cases) {
      expect(
        bestLanguageMatch(requested, file.catalogue),
        String(requested),
      ).toBe(want);
    }
  });
});

describe("startingLanguage", () => {
  const game = { base: "en", languages: ["de", "ja", "ar"] };

  it("is the saved choice while the game still offers it", () => {
    expect(startingLanguage({ ...game, saved: "ja", requested: ["de"] })).toBe(
      "ja",
    );
    expect(startingLanguage({ ...game, saved: "en", requested: ["de"] })).toBe(
      "en",
    );
  });

  it("matches the browser when nothing usable is saved", () => {
    expect(startingLanguage({ ...game, saved: "", requested: ["de-AT"] })).toBe(
      "de",
    );
    expect(startingLanguage({ ...game, saved: "fr", requested: ["ja"] })).toBe(
      "ja",
    );
    expect(startingLanguage({ ...game, requested: ["ar-EG", "en"] })).toBe(
      "ar",
    );
  });

  it("falls back to the base", () => {
    expect(startingLanguage({ ...game, requested: ["fr", "it"] })).toBe("en");
    expect(
      startingLanguage({ base: "de", languages: [], requested: ["en-US"] }),
    ).toBe("de");
  });
});

describe("uiLanguageFor: the language of the player's own words", () => {
  const catalogue = ["en", "de", "pt", "zh-Hans"];

  it("is the best catalogue match of the system languages", () => {
    expect(uiLanguageFor({ requested: ["de-CH"], catalogue })).toBe("de");
    expect(uiLanguageFor({ requested: ["pt-BR"], catalogue })).toBe("pt");
    expect(uiLanguageFor({ requested: ["zh-CN"], catalogue })).toBe("zh-Hans");
  });

  it("takes the system languages in their order", () => {
    expect(uiLanguageFor({ requested: ["fr", "pt-BR", "de"], catalogue })).toBe(
      "pt",
    );
    expect(uiLanguageFor({ requested: ["zh-CN", "en"], catalogue })).toBe(
      "zh-Hans",
    );
    // English first in the system list wins over a later catalogue match.
    expect(uiLanguageFor({ requested: ["en-GB", "de"], catalogue })).toBe("en");
  });

  it("is English when no system language is in the catalogue", () => {
    expect(uiLanguageFor({ requested: ["ja"], catalogue })).toBe("en");
    expect(uiLanguageFor({ requested: ["zh-TW"], catalogue })).toBe("en");
    expect(uiLanguageFor({ requested: [], catalogue: ["en"] })).toBe("en");
  });

  it("takes no game pick: its only inputs are the system's and the catalogue", () => {
    // A pick of the game's original (English) under a system Chinese once
    // pinned the controls to English (docs/plan.md Phase 54 item 7c). The
    // input has no field for a pick, so one cannot reach the result: an
    // object carrying a stray `chosen` still gives the system's language.
    const withPick = {
      chosen: "en",
      requested: ["zh-Hans-CN"],
      catalogue,
    } as Parameters<typeof uiLanguageFor>[0];
    expect(uiLanguageFor(withPick)).toBe("zh-Hans");
  });
});

describe("textDirection", () => {
  it("is rtl for Arabic, Persian, Hebrew and Urdu", () => {
    for (const tag of [
      "ar",
      "ar-EG",
      "fa",
      "fa-IR",
      "he",
      "iw",
      "ur",
      "ps",
      "yi",
    ]) {
      expect(textDirection(tag)).toBe("rtl");
    }
  });

  it("is ltr for everything else", () => {
    for (const tag of [
      "en",
      "en-XA",
      "de",
      "ja",
      "zh-Hant",
      "ko",
      "hi",
      "th",
      "tr",
    ]) {
      expect(textDirection(tag)).toBe("ltr");
    }
  });
});

describe("readingFactor", () => {
  it("scales Chinese, Japanese and Korean by the measured ratios", () => {
    expect(readingFactor("zh-Hans")).toBe(2.85);
    expect(readingFactor("zh-CN")).toBe(2.85);
    expect(readingFactor("zh")).toBe(2.85);
    expect(readingFactor("zh-Hant")).toBe(2.82);
    expect(readingFactor("zh-TW")).toBe(2.82);
    expect(readingFactor("ja")).toBe(2.17);
    expect(readingFactor("ko")).toBe(1.96);
  });

  it("is 1 for every other language", () => {
    for (const tag of ["en", "de", "ar", "fr", "tr", "x"]) {
      expect(readingFactor(tag)).toBe(1);
    }
  });
});

describe("autonym", () => {
  it("names a language in itself, its first letter upper-cased", () => {
    expect(autonym("de")).toBe("Deutsch");
    expect(autonym("ja")).toBe("日本語");
    expect(autonym("es")).toBe("Español");
    expect(autonym("en")).toBe("English");
  });

  it("falls back to the file's name, else the tag, where Intl has no name", () => {
    expect(autonym("qaa", "Klingon")).toBe("Klingon");
    expect(autonym("qaa")).toBe("qaa");
  });
});
