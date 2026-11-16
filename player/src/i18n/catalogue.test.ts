import { afterEach, describe, expect, it } from "vitest";
import {
  addCatalogue,
  formatNumber,
  interpolate,
  localized,
  onUiLanguageChange,
  pluralCategory,
  SOURCE_LANGUAGE,
  setUiLanguage,
  t,
  uiLanguage,
  uiLanguages,
} from "./catalogue";
import { applyDocumentLanguage } from "./document";
import { EN } from "./en";

// A made-up language for the tests: some keys, a plural with Polish's
// categories (one, few, many, other), one wrong placeholder-free text.
addCatalogue("pl", {
  "config.title": "Ustawienia",
  "map.count.screens": {
    one: "{count} ekran",
    few: "{count} ekrany",
    many: "{count} ekranów",
    other: "{count} ekranu",
  },
  "endcard.routes": { other: "{count} tras" },
});

afterEach(() => setUiLanguage(SOURCE_LANGUAGE));

describe("t: lookup in English", () => {
  it("reads a message by key", () => {
    expect(t("config.title")).toBe("Settings");
    expect(t("help.title")).toBe("Keys");
  });

  it("fills placeholders, numbers formatted without grouping", () => {
    expect(t("pill.segment", { index: 2, count: 3 })).toBe("View 2 of 3");
    expect(t("pill.route", { label: "The {odd} one" })).toBe(
      "Route: The {odd} one",
    );
    expect(t("map.count.screens", { count: 12345 })).toBe("12345 screens");
  });

  it("leaves a placeholder it was given no value for", () => {
    expect(interpolate("a {b} c", {})).toBe("a {b} c");
  });

  it("picks English plural forms by count", () => {
    expect(t("endcard.routes", { count: 1 })).toBe("1 route still unseen.");
    expect(t("endcard.routes", { count: 0 })).toBe("0 routes still unseen.");
    expect(t("endcard.routes", { count: 2 })).toBe("2 routes still unseen.");
    expect(t("map.count.bookmarks", { count: 1 })).toBe("1 bookmark");
  });

  it("keeps the speed readout's English exactly", () => {
    const speed = formatNumber(1, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    expect(t("config.speed.readout", { speed, ms: 60 })).toBe(
      "1.00x (~60 ms/char)",
    );
  });

  it("every English message is a non-empty string or has an other form", () => {
    for (const [key, message] of Object.entries(EN)) {
      if (typeof message === "string") {
        expect(message, key).not.toBe("");
      } else {
        expect(message.other, key).not.toBe("");
      }
    }
  });
});

describe("another language", () => {
  it("reads its own words and falls back to English per message", () => {
    setUiLanguage("pl");
    expect(t("config.title")).toBe("Ustawienia");
    expect(t("help.title")).toBe("Keys");
  });

  it("picks the language's own plural categories with Intl.PluralRules", () => {
    setUiLanguage("pl");
    expect(pluralCategory(1)).toBe("one");
    expect(pluralCategory(3)).toBe("few");
    expect(pluralCategory(5)).toBe("many");
    expect(t("map.count.screens", { count: 1 })).toBe("1 ekran");
    expect(t("map.count.screens", { count: 3 })).toBe("3 ekrany");
    expect(t("map.count.screens", { count: 5 })).toBe("5 ekranów");
    expect(t("map.count.screens", { count: 1.5 })).toBe("1,5 ekranu");
  });

  it("reads `other` where a translation lacks the category", () => {
    setUiLanguage("pl");
    expect(t("endcard.routes", { count: 1 })).toBe("1 tras");
  });

  it("formats numbers for the language", () => {
    setUiLanguage("pl");
    expect(formatNumber(0.5, { style: "percent" })).toBe("50%");
    setUiLanguage("de");
    expect(formatNumber(1.25)).toBe("1,25");
  });

  it("a language the catalogue lacks reads English, and keeps its tag", () => {
    setUiLanguage("xx-unknown");
    expect(uiLanguage()).toBe("xx-unknown");
    expect(t("config.title")).toBe("Settings");
    expect(t("endcard.routes", { count: 1 })).toBe("1 route still unseen.");
  });

  it("an unparseable tag formats numbers as English does", () => {
    setUiLanguage("not a tag!");
    expect(formatNumber(1.5)).toBe("1.5");
  });

  it("lists the compiled languages after English", () => {
    expect(uiLanguages()[0]).toBe("en");
  });
});

describe("switching the UI language live", () => {
  it("tells listeners, once per real change", () => {
    const seen: string[] = [];
    const stop = onUiLanguageChange(() => seen.push(uiLanguage()));
    setUiLanguage("pl");
    setUiLanguage("pl");
    setUiLanguage("en");
    stop();
    setUiLanguage("pl");
    expect(seen).toEqual(["pl", "en"]);
  });

  it("localized draws now and after each change, until unsubscribed", () => {
    const drawn: string[] = [];
    const stop = localized(() => drawn.push(t("config.title")));
    setUiLanguage("pl");
    setUiLanguage("en");
    stop();
    setUiLanguage("pl");
    expect(drawn).toEqual(["Settings", "Ustawienia", "Settings"]);
  });

  it("marks the document root with the UI language", () => {
    const doc = { documentElement: { lang: "" } };
    const stop = applyDocumentLanguage(doc);
    expect(doc.documentElement.lang).toBe("en");
    setUiLanguage("pl");
    expect(doc.documentElement.lang).toBe("pl");
    stop();
  });
});
