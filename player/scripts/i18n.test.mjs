import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EN } from "../src/i18n/en.ts";
import { pseudoCatalogue } from "../src/i18n/pseudo.ts";
import {
  buildModule,
  buildPot,
  compilePo,
  EN_SOURCE,
  generateI18n,
  localeTags,
  placeholdersOf,
  readNotes,
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

  it("finds placeholders", () => {
    expect(placeholdersOf("{a} and {b} and {a}")).toEqual(["{a}", "{b}"]);
    expect(placeholdersOf("none")).toEqual([]);
  });
});
