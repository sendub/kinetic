import { afterEach, describe, expect, it } from "vitest";
import { SOURCE_LANGUAGE, setUiLanguage, t, uiLanguages } from "./catalogue";
import { EN } from "./en";
import {
  enablePseudoLocale,
  PSEUDO_CLOSE,
  PSEUDO_LOCALE,
  PSEUDO_OPEN,
  pseudoCatalogue,
  pseudoText,
} from "./pseudo";

afterEach(() => setUiLanguage(SOURCE_LANGUAGE));

const inner = (text: string): string =>
  text.slice(PSEUDO_OPEN.length, -PSEUDO_CLOSE.length);

describe("pseudoText", () => {
  it("wraps, accents every ASCII letter and keeps placeholders", () => {
    const out = pseudoText("View {index} of {count}");
    expect(out.startsWith(PSEUDO_OPEN)).toBe(true);
    expect(out.endsWith(PSEUDO_CLOSE)).toBe(true);
    expect(out).toContain("{index}");
    expect(out).toContain("{count}");
    expect(out.replace(/\{[a-z]+\}/g, "")).not.toMatch(/[A-Za-z]/);
    expect(out.startsWith(`${PSEUDO_OPEN}Ṽíéŵ {index} óƒ {count}`)).toBe(true);
  });

  it("pads to about 140% of the English, placeholders not counted", () => {
    for (const text of [
      "On",
      "Settings",
      String(EN["confirm.reset.message"]),
    ]) {
      const grown = [...inner(pseudoText(text))].length;
      expect(grown / text.length).toBeGreaterThanOrEqual(1.4);
      expect(grown / text.length).toBeLessThan(1.4 + 3 / text.length);
    }
    const holder = inner(pseudoText("{detail}"));
    expect(holder).toBe("{detail}");
  });

  it("pads in short words, so a longer text can still wrap", () => {
    const words = inner(pseudoText(EN["confirm.reset.message"])).split(" ");
    for (const word of words.slice(-3)) {
      expect([...word].length).toBeLessThanOrEqual(5);
    }
  });
});

describe("the pseudo-locale catalogue", () => {
  it("has every English key, each wrapped, plurals form by form", () => {
    const pseudo = pseudoCatalogue();
    expect(Object.keys(pseudo)).toEqual(Object.keys(EN));
    for (const [key, message] of Object.entries(pseudo)) {
      const texts =
        typeof message === "string" ? [message] : Object.values(message);
      for (const text of texts) {
        expect(text?.startsWith(PSEUDO_OPEN), key).toBe(true);
      }
    }
  });

  it("is unreachable without the test flag", () => {
    expect(enablePseudoLocale(undefined)).toBe(null);
    expect(enablePseudoLocale("de")).toBe(null);
    setUiLanguage(PSEUDO_LOCALE);
    expect(t("config.title")).toBe("Settings");
    expect(uiLanguages()).not.toContain(PSEUDO_LOCALE);
  });

  it("serves the player's words once the flag asks for it", () => {
    expect(enablePseudoLocale(PSEUDO_LOCALE)).toBe(PSEUDO_LOCALE);
    setUiLanguage(PSEUDO_LOCALE);
    expect(t("config.title")).toBe(pseudoText("Settings"));
    expect(t("endcard.routes", { count: 1 })).toBe(
      pseudoText("{count} route still unseen.").replace("{count}", "1"),
    );
    setUiLanguage(SOURCE_LANGUAGE);
    expect(t("config.title")).toBe("Settings");
  });
});
