import { describe, expect, it } from "vitest";
import type { Item, LanguageFile } from "../machine/types";
import {
  createGameWords,
  holdTextOf,
  isLanguageFileFor,
  loadLanguageFile,
  markLanguage,
} from "./gamewords";

const manifest = {
  title: " The Lantern ",
  version: "Episode 3",
} as const;

const line = (id: string, text?: string, speaker?: string): Item =>
  ({
    id,
    type: "text",
    ...(text === undefined ? {} : { text }),
    ...(speaker === undefined ? {} : { speaker }),
  }) as Item;

const GERMAN: LanguageFile = {
  language: "de",
  name: "Deutsch",
  title: { text: "Die Laterne", from: "00000000" },
  speakers: { Mei: "Mei", "Old Theo": "Der alte Theo", Blank: " " },
  items: {
    a: { text: "Du bist früh dran.", from: "1a2b3c4d" },
    blank: { text: "   " },
  },
  decisions: {
    outer: {
      prompt: { text: "Wohin jetzt?" },
      routes: { harbour: { text: "Zum Hafen" } },
    },
  },
};

describe("createGameWords: each string from the language file, else the base", () => {
  const words = createGameWords(manifest, GERMAN);

  it("names the base and the shown language", () => {
    expect(words.base).toBe("en");
    expect(words.shown).toBe("de");
    const base = createGameWords({ language: "fr" }, null);
    expect(base.base).toBe("fr");
    expect(base.shown).toBe("fr");
  });

  it("draws a translated item's text in the shown language", () => {
    expect(words.itemText(line("a", "You're early."))).toEqual({
      text: "Du bist früh dran.",
      lang: "de",
    });
  });

  it("falls back to the base per line, marked with the base's tag", () => {
    expect(words.itemText(line("b", "Missing here."))).toEqual({
      text: "Missing here.",
      lang: "en",
    });
    expect(words.itemText(line("blank", "Blank there."))).toEqual({
      text: "Blank there.",
      lang: "en",
    });
  });

  it("draws nothing for an item without text", () => {
    expect(words.itemText(line("a"))).toBeNull();
    expect(words.itemText(line("a", ""))).toBeNull();
    expect(words.itemText(undefined)).toBeNull();
  });

  it("draws a speaker through the table; the manifest's name stays the key", () => {
    expect(words.speaker("Old Theo")).toEqual({
      text: "Der alte Theo",
      lang: "de",
    });
    expect(words.speaker("Ana")).toEqual({ text: "Ana", lang: "en" });
    expect(words.speaker("Blank")).toEqual({ text: "Blank", lang: "en" });
    expect(words.speaker("constructor")).toEqual({
      text: "constructor",
      lang: "en",
    });
  });

  it("draws prompts and labels by decision and route id", () => {
    expect(words.prompt("outer", "Where now?")).toEqual({
      text: "Wohin jetzt?",
      lang: "de",
    });
    expect(words.label("outer", "harbour", "To the harbour")).toEqual({
      text: "Zum Hafen",
      lang: "de",
    });
    expect(words.label("outer", "hill", "Up the hill")).toEqual({
      text: "Up the hill",
      lang: "en",
    });
    expect(words.prompt("inner", "Which?")).toEqual({
      text: "Which?",
      lang: "en",
    });
  });

  it("draws the title translated and the version from the base", () => {
    expect(words.title()).toEqual({ text: "Die Laterne", lang: "de" });
    expect(words.version()).toEqual({ text: "Episode 3", lang: "en" });
    expect(createGameWords({}, GERMAN).title()).toBeNull();
    expect(createGameWords({ version: "  " }, GERMAN).version()).toBeNull();
  });

  it("with no file every string is the base's", () => {
    const base = createGameWords(manifest, null);
    expect(base.itemText(line("a", "You're early."))).toEqual({
      text: "You're early.",
      lang: "en",
    });
    expect(base.title()).toEqual({ text: "The Lantern", lang: "en" });
    expect(base.speaker("Old Theo")).toEqual({ text: "Old Theo", lang: "en" });
  });
});

describe("holdTextOf: the text the hold counts and its language's factor", () => {
  const japanese: LanguageFile = {
    language: "ja",
    items: { a: { text: "早いね。" } },
  };
  const words = createGameWords(manifest, japanese);

  it("takes the shown text and the factor of the language it is in", () => {
    expect(holdTextOf(words, line("a", "You're early."))).toEqual({
      text: "早いね。",
      factor: 2.17,
    });
  });

  it("a fallback line keeps the base's factor", () => {
    expect(holdTextOf(words, line("b", "Missing."))).toEqual({
      text: "Missing.",
      factor: 1,
    });
  });

  it("an item without text has none", () => {
    expect(holdTextOf(words, line("c"))).toEqual({
      text: undefined,
      factor: 1,
    });
  });
});

describe("markLanguage", () => {
  it("sets lang and the direction it runs", () => {
    const el = { lang: "", dir: "" };
    markLanguage(el, "ar");
    expect(el).toEqual({ lang: "ar", dir: "rtl" });
    markLanguage(el, "ja");
    expect(el).toEqual({ lang: "ja", dir: "ltr" });
  });
});

describe("isLanguageFileFor", () => {
  it("wants an object whose language is the tag", () => {
    expect(isLanguageFileFor({ language: "de" }, "de")).toBe(true);
    expect(isLanguageFileFor({ language: "ja" }, "de")).toBe(false);
    expect(isLanguageFileFor(null, "de")).toBe(false);
    expect(isLanguageFileFor(["de"], "de")).toBe(false);
  });
});

/** A page whose `lang/<tag>.js` runs `behave` when its script is added. */
function fakePage(
  behave: (
    tag: string,
    win: { KINETIC_LANGUAGES?: Record<string, unknown> },
  ) => "load" | "error" | "never",
) {
  const added: string[] = [];
  const removed: string[] = [];
  const win: { KINETIC_LANGUAGES?: Record<string, unknown> } = {};
  const document = {
    createElement: () => {
      const handlers: Record<string, () => void> = {};
      const script = {
        src: "",
        addEventListener: (type: string, handler: () => void) => {
          handlers[type] = handler;
        },
        remove: () => removed.push(script.src),
      };
      return { script, handlers };
    },
  };
  const doc = {
    createElement: () => {
      const made = document.createElement();
      return Object.assign(made.script, { handlers: made.handlers });
    },
    head: {
      appendChild: (script: {
        src: string;
        handlers: Record<string, () => void>;
      }) => {
        added.push(script.src);
        const tag = script.src.replace(/^lang\/|\.js$/g, "");
        const outcome = behave(tag, win);
        if (outcome !== "never") setTimeout(() => script.handlers[outcome]?.());
      },
    },
  };
  return {
    host: { document: doc as unknown as Document, window: win },
    added,
    removed,
    win,
  };
}

describe("loadLanguageFile: lang/<tag>.js by script tag", () => {
  it("loads the script and reads the file it sets", async () => {
    const page = fakePage((tag, win) => {
      (win.KINETIC_LANGUAGES as Record<string, unknown>)[tag] = {
        language: tag,
      };
      return "load";
    });
    const file = await loadLanguageFile(page.host, "de");
    expect(file).toEqual({ language: "de" });
    expect(page.added).toEqual(["lang/de.js"]);
    expect(page.removed).toEqual(["lang/de.js"]);
  });

  it("uses a file already set without loading again", async () => {
    const page = fakePage(() => "load");
    page.win.KINETIC_LANGUAGES = { ja: { language: "ja" } };
    expect(await loadLanguageFile(page.host, "ja")).toEqual({
      language: "ja",
    });
    expect(page.added).toEqual([]);
  });

  it("is null for a missing script, a wrong file, a slow one or a bad tag", async () => {
    const missing = fakePage(() => "error");
    expect(await loadLanguageFile(missing.host, "de")).toBeNull();
    const wrong = fakePage((_tag, win) => {
      (win.KINETIC_LANGUAGES as Record<string, unknown>).de = {
        language: "fr",
      };
      return "load";
    });
    expect(await loadLanguageFile(wrong.host, "de")).toBeNull();
    const silent = fakePage(() => "load");
    expect(await loadLanguageFile(silent.host, "de")).toBeNull();
    const slow = fakePage(() => "never");
    expect(await loadLanguageFile(slow.host, "de", 20)).toBeNull();
    const bad = fakePage(() => "load");
    expect(await loadLanguageFile(bad.host, "../x")).toBeNull();
    expect(bad.added).toEqual([]);
  });
});
