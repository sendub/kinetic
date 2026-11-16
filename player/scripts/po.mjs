// A small gettext PO reader and writer for the player's catalogue
// (docs/plan.md Phase 54 item 2; scripts/i18n.mjs uses it). It reads what
// translators' tools write: the header entry, `msgctxt`, multi-line
// strings, C escapes, comments (`#.` extracted, `#:` references, `# `
// translator, `#|` previous), flags (`#, fuzzy`), plural entries
// (`msgid_plural`, `msgstr[n]`, read but unused here) and obsolete `#~`
// entries (skipped). A fuzzy entry is still an entry: the catalogue's
// drafts say they are drafts in their header, not per entry.

const ESCAPES = {
  n: "\n",
  t: "\t",
  r: "\r",
  a: "\x07",
  b: "\b",
  f: "\f",
  v: "\v",
  '"': '"',
  "\\": "\\",
  "?": "?",
  "'": "'",
};

/** The text of one quoted PO string (`"..."`), escapes undone. */
export function unquote(literal, lineNo = 0) {
  const fail = (why) => {
    throw new Error(`PO line ${lineNo}: ${why}: ${literal}`);
  };
  if (literal.length < 2 || literal[0] !== '"' || literal.at(-1) !== '"') {
    fail("not a quoted string");
  }
  const body = literal.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') fail("unescaped quote");
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[++i];
    if (next === undefined) fail("a backslash ends the string");
    if (next in ESCAPES) {
      out += ESCAPES[next];
    } else if (/[0-7]/.test(next)) {
      const digits = /^[0-7]{1,3}/.exec(body.slice(i))[0];
      out += String.fromCharCode(Number.parseInt(digits, 8));
      i += digits.length - 1;
    } else if (next === "x") {
      const digits = /^[0-9a-fA-F]+/.exec(body.slice(i + 1))?.[0];
      if (digits === undefined) fail("\\x with no digits");
      out += String.fromCharCode(Number.parseInt(digits, 16));
      i += digits.length;
    } else {
      fail(`unknown escape \\${next}`);
    }
  }
  return out;
}

/** `text` as one quoted PO string. */
export function quote(text) {
  return `"${text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")}"`;
}

/**
 * `keyword` and its string as PO lines: one line, or, when the text has a
 * line break before its end, an empty first string and a line per break.
 */
export function poField(keyword, text) {
  const breaks = text.slice(0, -1).includes("\n");
  if (!breaks) return `${keyword} ${quote(text)}`;
  const parts = text.split(/(?<=\n)/);
  return [`${keyword} ""`, ...parts.map(quote)].join("\n");
}

function emptyEntry(line) {
  return {
    context: undefined,
    id: undefined,
    idPlural: undefined,
    str: undefined,
    strs: [],
    flags: new Set(),
    extracted: [],
    references: [],
    translator: [],
    previous: [],
    line,
  };
}

/**
 * The header entry's fields (`Key: value` lines of its msgstr), keyed as
 * written.
 */
export function parseHeader(text) {
  const header = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) header[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return header;
}

/**
 * Reads a PO file: `{ header, entries }`. `header` holds the header
 * entry's fields (and `fuzzy`, its flag); each entry has `context`, `id`,
 * `idPlural`, `str` (`strs` for a plural entry), `flags` (a Set),
 * `extracted`, `references`, `translator` and `previous` comment lines,
 * and `line` (where it starts). Throws on a malformed line, naming it.
 */
export function parsePo(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const entries = [];
  let entry = emptyEntry(1);
  // The field the next continuation string extends.
  let field = null;
  let commentsOnly = true;

  const finish = () => {
    if (entry.id !== undefined) {
      if (entry.str === undefined && entry.strs.length === 0) {
        throw new Error(`PO line ${entry.line}: msgid with no msgstr`);
      }
      entries.push(entry);
    }
  };
  const begin = (lineNo) => {
    finish();
    entry = emptyEntry(lineNo);
    field = null;
    commentsOnly = true;
  };

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();
    if (line === "") {
      if (entry.id !== undefined) begin(lineNo + 1);
      return;
    }
    if (line.startsWith("#~")) return; // obsolete: not part of the catalogue
    if (line.startsWith("#")) {
      // A comment after a complete entry starts the next one.
      if (entry.id !== undefined && !commentsOnly) begin(lineNo);
      if (entry.id === undefined) entry.line = Math.min(entry.line, lineNo);
      const body = line.slice(2).trim();
      if (line.startsWith("#,")) {
        for (const flag of line.slice(2).split(",")) {
          if (flag.trim() !== "") entry.flags.add(flag.trim());
        }
      } else if (line.startsWith("#.")) entry.extracted.push(body);
      else if (line.startsWith("#:")) entry.references.push(body);
      else if (line.startsWith("#|")) entry.previous.push(body);
      else entry.translator.push(line.slice(1).trim());
      return;
    }
    if (line.startsWith('"')) {
      if (field === null) {
        throw new Error(`PO line ${lineNo}: a string continues no field`);
      }
      field.append(unquote(line, lineNo));
      return;
    }
    const match =
      /^(msgctxt|msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s+(".*")$/.exec(line);
    if (match === null)
      throw new Error(`PO line ${lineNo}: cannot read: ${line}`);
    const [, keyword, plural, literal] = match;
    const value = unquote(literal, lineNo);
    // A msgctxt or msgid after a msgstr starts a new entry.
    if (
      (keyword === "msgctxt" || keyword === "msgid") &&
      (entry.str !== undefined || entry.strs.length > 0)
    ) {
      begin(lineNo);
    }
    if (
      entry.id === undefined &&
      keyword !== "msgctxt" &&
      keyword !== "msgid"
    ) {
      throw new Error(`PO line ${lineNo}: ${keyword} before msgid`);
    }
    commentsOnly = false;
    if (keyword === "msgctxt") {
      entry.context = value;
      field = { append: (more) => (entry.context += more) };
    } else if (keyword === "msgid") {
      entry.id = value;
      field = { append: (more) => (entry.id += more) };
    } else if (keyword === "msgid_plural") {
      entry.idPlural = value;
      field = { append: (more) => (entry.idPlural += more) };
    } else if (plural !== undefined) {
      const n = Number(plural);
      entry.strs[n] = value;
      field = { append: (more) => (entry.strs[n] += more) };
    } else {
      entry.str = value;
      field = { append: (more) => (entry.str += more) };
    }
  });
  finish();

  const headerAt = entries.findIndex(
    (e) => e.id === "" && e.context === undefined,
  );
  let header = {};
  if (headerAt >= 0) {
    const [found] = entries.splice(headerAt, 1);
    header = parseHeader(found.str ?? "");
    if (found.flags.has("fuzzy")) header.fuzzy = true;
  }
  return { header, entries };
}
