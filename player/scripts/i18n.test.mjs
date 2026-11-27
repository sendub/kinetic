import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EN } from "../src/i18n/en.ts";
import { pseudoCatalogue } from "../src/i18n/pseudo.ts";
import {
  auditLocale,
  buildConverterWords,
  buildHostWords,
  buildModule,
  buildPot,
  CONVERTER_WORDS_FILE,
  compilePo,
  EN_SOURCE,
  generateI18n,
  LOCALES_DIR,
  localeTags,
  placeholdersOf,
  readNotes,
  sourceDigest,
  staleI18n,
} from "./i18n.mjs";
import { parsePo, poField } from "./po.mjs";

describe("the English catalogue's notes", () => {
  it("every key has a doc comment for translators", () => {
    const notes = readNotes(readFileSync(EN_SOURCE, "utf8"));
    for (const key of Object.keys(EN)) {
      expect(notes[key], key).toBeTruthy();
    }
  });

  it("refuses a key with no note", () => {
    expect(() => buildPot({ "x.y": "Hi" }, {})).toThrow(/"x.y" has no doc/);
  });
});

describe("messages.pot", () => {
  const { header, entries } = parsePo(buildPot());

  it("is a template: a header and an empty msgstr for each entry", () => {
    expect(header["Content-Type"]).toBe("text/plain; charset=UTF-8");
    expect(entries.every((entry) => entry.str === "")).toBe(true);
  });

  it("has one entry per message, msgctxt the key and msgid the English", () => {
    const help = entries.find((e) => e.context === "help.hint");
    expect(help.id).toBe("{esc} or {space} closes");
    expect(help.extracted).toEqual([
      "Esc screen, title bar: the keys that close the screen.",
      "Placeholders: {esc}, {space}.",
    ]);
  });

  it("gives a plural message one entry per English category", () => {
    const forms = entries.filter((e) =>
      e.context.startsWith("endcard.routes#"),
    );
    expect(forms.map((e) => e.context)).toEqual([
      "endcard.routes#one",
      "endcard.routes#other",
    ]);
    expect(forms[0].id).toBe("{count} route still unseen.");
    expect(forms[0].extracted.at(-1)).toBe(
      'Plural form "one" (CLDR), chosen by {count}.',
    );
  });

  it("counts every message: strings once, plurals per form", () => {
    const expected = Object.values(EN).reduce(
      (n, m) => n + (typeof m === "string" ? 1 : Object.keys(m).length),
      0,
    );
    expect(entries).toHaveLength(expected);
  });
});

/** A PO file that translates `catalogue` (key -> message) entry by entry. */
function poFor(catalogue, header = "") {
  const blocks = [`msgid ""\nmsgstr "${header}"`];
  for (const [key, message] of Object.entries(catalogue)) {
    const forms =
      typeof message === "string"
        ? [[key, message]]
        : Object.entries(message).map(([c, text]) => [`${key}#${c}`, text]);
    for (const [context, text] of forms) {
      blocks.push(
        [
          poField("msgctxt", context),
          poField("msgid", "source"),
          poField("msgstr", text),
        ].join("\n"),
      );
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

describe("compilePo", () => {
  it("compiles every message back to the catalogue it was written from", () => {
    const pseudo = pseudoCatalogue();
    const { catalogue, problems } = compilePo(poFor(pseudo));
    expect(problems).toEqual([]);
    expect(catalogue).toEqual(pseudo);
  });

  it("skips untranslated entries and uses fuzzy ones", () => {
    const text = [
      'msgid ""\nmsgstr "Language: de\\n"',
      '#, fuzzy\nmsgctxt "config.title"\nmsgid "Settings"\nmsgstr "Einstellungen"',
      'msgctxt "help.title"\nmsgid "Keys"\nmsgstr ""',
    ].join("\n\n");
    const { catalogue, problems } = compilePo(text);
    expect(problems).toEqual([]);
    expect(catalogue).toEqual({ "config.title": "Einstellungen" });
  });

  it("takes a language's own plural categories", () => {
    const { catalogue, problems } = compilePo(
      poFor({
        "map.count.screens": {
          one: "{count} ekran",
          few: "{count} ekrany",
          many: "{count} ekranów",
          other: "{count} ekranu",
        },
      }),
    );
    expect(problems).toEqual([]);
    expect(catalogue["map.count.screens"]).toEqual({
      one: "{count} ekran",
      few: "{count} ekrany",
      many: "{count} ekranów",
      other: "{count} ekranu",
    });
  });

  it("allows a plural form without {count}, as a language's 'one' may be", () => {
    const { problems } = compilePo(
      poFor({
        "endcard.routes": { one: "Eine Route", other: "{count} Routen" },
      }),
    );
    expect(problems).toEqual([]);
  });

  it("leaves out and reports what it cannot use", () => {
    const { catalogue, problems } = compilePo(
      [
        'msgctxt "no.such.key"\nmsgid "x"\nmsgstr "y"',
        'msgctxt "help.hint"\nmsgid "x"\nmsgstr "{esc} schließt"',
        'msgctxt "pill.route"\nmsgid "x"\nmsgstr "Route: {name}"',
        'msgctxt "config.title#one"\nmsgid "x"\nmsgstr "Einstellung"',
        'msgctxt "endcard.routes"\nmsgid "x"\nmsgstr "Routen"',
        'msgctxt "endcard.routes#lots"\nmsgid "x"\nmsgstr "Routen"',
        'msgctxt "map.count.bookmarks#one"\nmsgid "x"\nmsgstr "{count} Lesezeichen"',
        'msgid "no context"\nmsgstr "kein Kontext"',
        'msgid "file"\nmsgid_plural "files"\nmsgstr[0] "Datei"',
      ].join("\n\n"),
      EN,
      "de.po",
    );
    expect(catalogue).toEqual({});
    expect(problems).toEqual([
      'de.po:1: unknown key "no.such.key"',
      'de.po:5: "help.hint" placeholders differ from the English (missing {space})',
      'de.po:9: "pill.route" placeholders differ from the English (extra {name}, missing {label})',
      'de.po:13: "config.title" is not a plural message',
      'de.po:17: "endcard.routes" is a plural message: msgctxt "endcard.routes#<category>"',
      'de.po:21: "lots" is no plural category',
      "de.po:29: no msgctxt (the message's key)",
      "de.po:32: msgid_plural is not used (msgctxt key#category is)",
      'de.po: "map.count.bookmarks" has no "other" form; left out',
    ]);
  });
});

describe("auditLocale: a complete catalogue in its language", () => {
  const draft = "# Kinetic player: X.\n# An unreviewed draft.\n";
  /** A full translation of EN with `forms` for each plural message. */
  function full(forms, header = draft) {
    const catalogue = {};
    for (const [key, message] of Object.entries(EN)) {
      catalogue[key] = typeof message === "string" ? message : forms(message);
    }
    return header + poFor(catalogue);
  }

  it("passes a full translation with the language's plural forms", () => {
    const ru = full((m) => ({
      one: m.other,
      few: m.other,
      many: m.other,
      other: m.other,
    }));
    expect(auditLocale("ru", ru)).toEqual([]);
    expect(
      auditLocale(
        "ja",
        full((m) => ({ other: m.other })),
      ),
    ).toEqual([]);
  });

  it("names a missing plural category the language uses", () => {
    const text = full((m) => ({ one: m.one, other: m.other }));
    expect(auditLocale("pl", text)).toContain(
      'pl.po: "map.count.screens" lacks the "few" form pl uses',
    );
  });

  it("lets a form drop {count} only where its category is one number", () => {
    const one = (m) => ({
      one: m.one.replaceAll("{count}", "1").replaceAll("{count} ", ""),
      other: m.other,
    });
    // German "one" is 1 alone; Croatian "one" is also 21, 31 ...
    expect(auditLocale("de", full(one))).toEqual([]);
    const hr = full((m) => ({ ...one(m), few: m.other }));
    expect(auditLocale("hr", hr)).toContain(
      'hr.po: "map.count.screens#one" lacks {count}',
    );
    // {played} varies whatever the category.
    const played = full((m) => ({
      one: m.one.replaceAll("{played}", "x"),
      other: m.other,
    }));
    expect(auditLocale("de", played)).toContain(
      'de.po: "map.decision.played#one" lacks {played}',
    );
  });

  it("holds the converter's words to the same rule as the player's", () => {
    const text = full((m) => m);
    const blank = text.replace(
      /(msgctxt "converter\.condition\.prompt"\nmsgid "[^"]*"\nmsgstr )"[^"]*"/,
      '$1""',
    );
    expect(blank).not.toBe(text);
    expect(auditLocale("de", blank)).toEqual([
      'de.po: "converter.condition.prompt" is not translated',
    ]);
    const lost = text.replace(
      /(msgctxt "converter\.condition\.atLeast"\nmsgid "[^"]*"\nmsgstr )"[^"]*"/,
      '$1"{name} {count} oder mehr"',
    );
    expect(lost).not.toBe(text);
    const found = auditLocale("de", lost);
    expect(found).toContain(
      'de.po: "converter.condition.atLeast" is not translated',
    );
    expect(found.join("\n")).toMatch(
      /"converter\.condition\.atLeast" placeholders differ from the English \(extra \{count\}, missing \{n\}\)/,
    );
  });

  it("names an untranslated message and a header with no draft mark", () => {
    const text = full((m) => m, "# Kinetic player.\n").replace(
      /msgctxt "help.title"\nmsgid "source"\nmsgstr "Keys"/,
      'msgctxt "help.title"\nmsgid "source"\nmsgstr ""',
    );
    expect(auditLocale("de", text)).toEqual([
      "de.po: the header does not say it is an unreviewed draft",
      'de.po: "help.title" is not translated',
    ]);
  });

  it("every player/locales/<tag>.po is complete, with matching placeholders", () => {
    const tags = localeTags();
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      const text = readFileSync(join(LOCALES_DIR, `${tag}.po`), "utf8");
      expect(auditLocale(tag, text), tag).toEqual([]);
    }
  });
});

describe("the generated files", () => {
  it("are up to date (run `npm run i18n` after changing en.ts or a .po)", () => {
    expect(staleI18n()).toEqual([]);
  });

  it("the module holds every compiled language", () => {
    expect(buildModule({})).toContain(
      "export const LOCALES: Readonly<Record<string, Catalogue>> = {};",
    );
    const one = buildModule({ de: { "config.title": "Einstellungen" } });
    expect(one).toContain('"de": {\n    "config.title": "Einstellungen"\n  }');
  });

  it("compiles each <tag>.po of a folder under its tag", () => {
    const dir = mkdtempSync(join(tmpdir(), "kinetic-locales-"));
    try {
      writeFileSync(
        join(dir, "pt-BR.po"),
        poFor({ "config.title": "Configurações" }),
      );
      writeFileSync(join(dir, "messages.pot"), buildPot());
      expect(localeTags(dir)).toEqual(["pt-BR"]);
      const { module, problems } = generateI18n(dir);
      expect(problems).toEqual([]);
      expect(module).toContain(
        '"pt-BR": {\n    "config.title": "Configurações"',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the game apps' table holds the host.* messages alone, English first, and the sources' digest", () => {
    const table = JSON.parse(
      buildHostWords(
        { de: { "host.menu.view": "Darstellung", "config.title": "X" } },
        "abc",
        { "host.menu.view": "View", "host.menu.reload": "Reload", "x.y": "Hi" },
      ),
    );
    expect(table.source).toBe("abc");
    expect(Object.keys(table.languages)).toEqual(["en", "de"]);
    expect(table.languages.en).toEqual({
      "host.menu.view": "View",
      "host.menu.reload": "Reload",
    });
    // A message the language lacks is left out: the apps read English.
    expect(table.languages.de).toEqual({ "host.menu.view": "Darstellung" });
    const shipped = JSON.parse(
      readFileSync(join(LOCALES_DIR, "..", "..", "apps", "host-words.json")),
    );
    expect(Object.keys(shipped.languages)).toEqual(["en", ...localeTags()]);
    expect(shipped.source).toBe(sourceDigest());
    for (const [tag, words] of Object.entries(shipped.languages)) {
      expect(Object.keys(words), tag).toEqual(
        Object.keys(EN).filter((key) => key.startsWith("host.")),
      );
    }
  });

  it("the converter's table holds the converter.* messages alone, English first", () => {
    const table = JSON.parse(
      buildConverterWords(
        {
          fr: {
            "converter.condition.otherwise": "Sinon",
            "config.title": "X",
          },
          de: {},
        },
        {
          "converter.condition.otherwise": "Otherwise",
          "converter.condition.prompt": "Which?",
          "x.y": "Hi",
        },
      ),
    );
    expect(Object.keys(table.languages)).toEqual(["en", "fr", "de"]);
    expect(table.languages.en).toEqual({
      "converter.condition.otherwise": "Otherwise",
      "converter.condition.prompt": "Which?",
    });
    // A message the language lacks is left out: the converter writes
    // English for it and says so.
    expect(table.languages.fr).toEqual({
      "converter.condition.otherwise": "Sinon",
    });
    expect(table.languages.de).toEqual({});
    const shipped = JSON.parse(readFileSync(CONVERTER_WORDS_FILE, "utf8"));
    expect(Object.keys(shipped.languages)).toEqual(["en", ...localeTags()]);
    expect(Object.keys(shipped.languages.en)).toEqual(
      Object.keys(EN).filter((key) => key.startsWith("converter.")),
    );
    expect(shipped.languages.en["converter.condition.prompt"]).toBe(
      "Which fits your story so far?",
    );
  });

  it("the converter's table gives every language every phrase, the English placeholders kept", () => {
    const shipped = JSON.parse(readFileSync(CONVERTER_WORDS_FILE, "utf8"));
    const keys = Object.keys(EN).filter((key) => key.startsWith("converter."));
    expect(keys.length).toBeGreaterThan(0);
    for (const tag of localeTags()) {
      const words = shipped.languages[tag];
      expect(Object.keys(words), tag).toEqual(keys);
      for (const key of keys) {
        expect(placeholdersOf(words[key]).sort(), `${tag} ${key}`).toEqual(
          placeholdersOf(EN[key]).sort(),
        );
      }
    }
  });

  it("the sources' digest changes with a PO file", () => {
    const dir = mkdtempSync(join(tmpdir(), "kinetic-locales-"));
    try {
      writeFileSync(join(dir, "de.po"), poFor({ "config.title": "A" }));
      const before = sourceDigest(dir);
      expect(sourceDigest(dir)).toBe(before);
      writeFileSync(join(dir, "de.po"), poFor({ "config.title": "B" }));
      expect(sourceDigest(dir)).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds placeholders", () => {
    expect(placeholdersOf("{a} and {b} and {a}")).toEqual(["{a}", "{b}"]);
    expect(placeholdersOf("none")).toEqual([]);
  });
});
