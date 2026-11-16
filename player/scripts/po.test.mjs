import { describe, expect, it } from "vitest";
import { parsePo, poField, quote, unquote } from "./po.mjs";

const SAMPLE = `# Translator's note on the file.
msgid ""
msgstr ""
"Project-Id-Version: Kinetic player\\n"
"Language: de\\n"
"Plural-Forms: nplurals=2; plural=(n != 1);\\n"

# A translator's comment.
#. Esc screen: the heading.
#: src/render/help.ts:12
#, fuzzy, c-format
#| msgid "Old keys"
msgctxt "help.title"
msgid "Keys"
msgstr "Tasten"

msgctxt "confirm.reset.message"
msgid ""
"Reset all progress? "
"This clears everything."
msgstr ""
"Allen Fortschritt zurücksetzen? "
"Das löscht alles."
#. No blank line before this entry.
msgctxt "x.escapes"
msgid "a\\tb \\"q\\" back\\\\slash\\nnew \\101\\x42"
msgstr ""

#~ msgctxt "gone"
#~ msgid "Old"
#~ msgstr "Alt"

msgid "file"
msgid_plural "files"
msgstr[0] "Datei"
msgstr[1] "Dateien"
`;

describe("parsePo", () => {
  const { header, entries } = parsePo(SAMPLE);

  it("reads the header's fields", () => {
    expect(header["Project-Id-Version"]).toBe("Kinetic player");
    expect(header.Language).toBe("de");
    expect(header["Plural-Forms"]).toBe("nplurals=2; plural=(n != 1);");
    expect(header.fuzzy).toBeUndefined();
  });

  it("reads msgctxt, msgid and msgstr, with every kind of comment", () => {
    const [first] = entries;
    expect(first.context).toBe("help.title");
    expect(first.id).toBe("Keys");
    expect(first.str).toBe("Tasten");
    expect(first.translator).toEqual(["A translator's comment."]);
    expect(first.extracted).toEqual(["Esc screen: the heading."]);
    expect(first.references).toEqual(["src/render/help.ts:12"]);
    expect(first.previous).toEqual(['msgid "Old keys"']);
    expect([...first.flags]).toEqual(["fuzzy", "c-format"]);
  });

  it("joins multi-line strings", () => {
    const entry = entries.find((e) => e.context === "confirm.reset.message");
    expect(entry.id).toBe("Reset all progress? This clears everything.");
    expect(entry.str).toBe("Allen Fortschritt zurücksetzen? Das löscht alles.");
  });

  it("starts an entry at a comment with no blank line, and undoes escapes", () => {
    const entry = entries.find((e) => e.context === "x.escapes");
    expect(entry.extracted).toEqual(["No blank line before this entry."]);
    expect(entry.id).toBe('a\tb "q" back\\slash\nnew AB');
    expect(entry.str).toBe("");
  });

  it("skips obsolete entries and reads plural ones", () => {
    expect(entries.some((e) => e.context === "gone")).toBe(false);
    const plural = entries.at(-1);
    expect(plural.id).toBe("file");
    expect(plural.idPlural).toBe("files");
    expect(plural.strs).toEqual(["Datei", "Dateien"]);
    expect(entries).toHaveLength(4);
  });

  it("reads a fuzzy header", () => {
    const parsed = parsePo('#, fuzzy\nmsgid ""\nmsgstr "Language: ja\\n"\n');
    expect(parsed.header).toEqual({ Language: "ja", fuzzy: true });
    expect(parsed.entries).toEqual([]);
  });

  it("reads CRLF line ends and a byte-order mark", () => {
    const parsed = parsePo('\uFEFFmsgctxt "k"\r\nmsgid "a"\r\nmsgstr "b"\r\n');
    expect(parsed.entries[0]).toMatchObject({
      context: "k",
      id: "a",
      str: "b",
    });
  });

  it("names the line of what it cannot read", () => {
    expect(() => parsePo('msgid "a"\nmsgstr "b"\nnonsense\n')).toThrow(
      /line 3/,
    );
    expect(() => parsePo('msgid "a\n')).toThrow(/line 1/);
    expect(() => parsePo('msgid "a"\n\nmsgstr "b"\n')).toThrow(/no msgstr/);
    expect(() => parsePo('"stray"\n')).toThrow(/continues no field/);
    expect(() => parsePo('msgstr "b"\n')).toThrow(/before msgid/);
    expect(() => unquote('"bad \\q"')).toThrow(/unknown escape/);
  });
});

describe("writing", () => {
  it("quotes with escapes that read back", () => {
    const text = 'tab\there "quoted" back\\slash\nline';
    expect(unquote(quote(text))).toBe(text);
  });

  it("writes a multi-line text as one string per line", () => {
    expect(poField("msgid", "one")).toBe('msgid "one"');
    expect(poField("msgid", "ends with a break\n")).toBe(
      'msgid "ends with a break\\n"',
    );
    expect(poField("msgid", "first\nsecond")).toBe(
      'msgid ""\n"first\\n"\n"second"',
    );
    const back = parsePo(`${poField("msgid", "first\nsecond")}\nmsgstr ""\n`);
    expect(back.entries[0].id).toBe("first\nsecond");
  });
});
