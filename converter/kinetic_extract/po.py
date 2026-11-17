"""A small gettext PO reader and writer (docs/plan.md Phase 56, item 8;
docs/translating.md).

tools/translations.py exports a game's strings to PO for translators and
imports their work back. This module reads what translators' tools
write and writes what they expect:

- the header entry (``msgid ""`` with no ``msgctxt``), its ``Key: value``
  lines read into an ordered dict;
- ``msgctxt``, ``msgid``, ``msgstr``, and plural entries
  (``msgid_plural``, ``msgstr[n]``), read but unused by Kinetic;
- strings split over several quoted lines, with the C escapes gettext
  uses (``\\n``, ``\\t``, ``\\"``, ``\\\\`` and the rest, octal and hex);
- comments: translator ``#``, extracted ``#.``, reference ``#:``, flags
  ``#,`` (``fuzzy``) and previous ``#|``;
- obsolete entries (``#~``), read with ``obsolete`` set;
- UTF-8, a leading byte order mark and CRLF line ends tolerated.

Writing wraps strings as GNU gettext does (``msgcat``, ``msgmerge``, and
Poedit, which follows it): a string that fits in 79 columns with no line
break before its end stays on its keyword's line; any other starts with
an empty string and continues one quoted line per piece, a piece ending
after each ``\\n`` and the lines filled up to 79 columns, broken after
spaces, after a hyphen inside a word and between CJK characters
(a simplified form of the Unicode line breaking gettext uses; wide
characters count two columns). Reading does not depend on the wrapping,
so a file rewrapped by any tool reads back the same.

Standard library only: tools/ import this module straight from
converter/, without the converter installed.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

PAGE_WIDTH = 79
FUZZY = "fuzzy"


class PoError(ValueError):
    """A PO file that cannot be read; the message names the line."""


@dataclass
class Entry:
    """One PO entry. ``msgctxt`` None means the entry has no context
    (distinct from an empty one)."""

    msgid: str = ""
    msgstr: str = ""
    msgctxt: str | None = None
    msgid_plural: str | None = None
    msgstr_plural: dict[int, str] = field(default_factory=dict)
    translator_comments: list[str] = field(default_factory=list)
    extracted_comments: list[str] = field(default_factory=list)
    references: list[str] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)
    previous: list[str] = field(default_factory=list)
    obsolete: bool = False
    line: int = 0

    @property
    def fuzzy(self) -> bool:
        return FUZZY in self.flags


@dataclass
class Catalog:
    """A PO file: its header fields (in order), the header entry's own
    comments and flags, and the other entries in file order."""

    header: dict[str, str] = field(default_factory=dict)
    entries: list[Entry] = field(default_factory=list)
    header_comments: list[str] = field(default_factory=list)
    header_flags: list[str] = field(default_factory=list)


# --- reading -----------------------------------------------------------------

_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "a": "\a", "b": "\b",
            "f": "\f", "v": "\v", '"': '"', "\\": "\\", "?": "?", "'": "'"}
_KEYWORD = re.compile(
    r"(msgctxt|msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s*(\".*\")$")


def unquote(literal: str, line: int = 0) -> str:
    """The text of one quoted PO string (``"..."``), escapes undone."""
    def fail(why: str) -> PoError:
        return PoError(f"line {line}: {why}: {literal}")

    if len(literal) < 2 or literal[0] != '"' or literal[-1] != '"':
        raise fail("not a quoted string")
    body = literal[1:-1]
    out: list[str] = []
    i = 0
    while i < len(body):
        ch = body[i]
        if ch == '"':
            raise fail("unescaped quote")
        if ch != "\\":
            out.append(ch)
            i += 1
            continue
        if i + 1 >= len(body):
            raise fail("a backslash ends the string")
        nxt = body[i + 1]
        if nxt in _ESCAPES:
            out.append(_ESCAPES[nxt])
            i += 2
        elif nxt in "01234567":
            digits = re.match(r"[0-7]{1,3}", body[i + 1:]).group(0)
            out.append(chr(int(digits, 8)))
            i += 1 + len(digits)
        elif nxt == "x":
            found = re.match(r"[0-9a-fA-F]+", body[i + 2:])
            if found is None:
                raise fail("\\x with no digits")
            out.append(chr(int(found.group(0), 16)))
            i += 2 + len(found.group(0))
        else:
            raise fail(f"unknown escape \\{nxt}")
    return "".join(out)


def parse_header(text: str) -> dict[str, str]:
    """The header entry's ``Key: value`` lines, keyed as written."""
    fields: dict[str, str] = {}
    for line in text.split("\n"):
        key, colon, value = line.partition(":")
        if colon and key.strip():
            fields[key.strip()] = value.strip()
    return fields


class _Reader:
    def __init__(self) -> None:
        self.entries: list[Entry] = []
        self.entry = Entry()
        self.has_id = False
        self.has_str = False
        self.append = None  # extends the field a continuation line continues

    def finish(self) -> None:
        if self.has_id:
            if not self.has_str:
                raise PoError(f"line {self.entry.line}: msgid with no msgstr")
            self.entries.append(self.entry)
        elif self.entry.msgctxt is not None:
            raise PoError(f"line {self.entry.line}: msgctxt with no msgid")
        self.entry = Entry()
        self.has_id = self.has_str = False
        self.append = None

    def comment(self, line: str, number: int) -> None:
        if self.has_str:
            self.finish()
        if not self.has_id and not self.entry.line:
            self.entry.line = number
        kind, body = line[:2], line[2:].strip()
        if kind == "#,":
            self.entry.flags += [f.strip() for f in line[2:].split(",")
                                 if f.strip()]
        elif kind == "#.":
            self.entry.extracted_comments.append(body)
        elif kind == "#:":
            self.entry.references.append(body)
        elif kind == "#|":
            self.entry.previous.append(body)
        else:
            text = line[1:]
            self.entry.translator_comments.append(
                text[1:] if text.startswith(" ") else text)

    def keyword(self, line: str, number: int, obsolete: bool) -> None:
        if line.startswith('"'):
            if self.append is None:
                raise PoError(f"line {number}: a string continues no field")
            self.append(unquote(line, number))
            return
        match = _KEYWORD.match(line)
        if match is None:
            raise PoError(f"line {number}: cannot read: {line}")
        keyword, plural, literal = match.groups()
        value = unquote(literal, number)
        if keyword in ("msgctxt", "msgid") and self.has_str:
            self.finish()
        if keyword == "msgctxt" and self.has_id:
            raise PoError(f"line {number}: msgctxt after msgid")
        if not self.has_id and keyword not in ("msgctxt", "msgid"):
            raise PoError(f"line {number}: {keyword} before msgid")
        if not self.entry.line:
            self.entry.line = number
        if obsolete:
            self.entry.obsolete = True
        entry = self.entry
        if keyword == "msgctxt":
            entry.msgctxt = value

            def more(text: str) -> None:
                entry.msgctxt += text
        elif keyword == "msgid":
            entry.msgid = value
            self.has_id = True

            def more(text: str) -> None:
                entry.msgid += text
        elif keyword == "msgid_plural":
            entry.msgid_plural = value

            def more(text: str) -> None:
                entry.msgid_plural += text
        elif plural is not None:
            n = int(plural)
            entry.msgstr_plural[n] = value
            self.has_str = True

            def more(text: str) -> None:
                entry.msgstr_plural[n] += text
        else:
            entry.msgstr = value
            self.has_str = True

            def more(text: str) -> None:
                entry.msgstr += text
        self.append = more


def parse(text: str) -> Catalog:
    """Read a PO file's text. Raises PoError naming the line it cannot
    read."""
    if text.startswith("﻿"):
        text = text[1:]
    reader = _Reader()
    for number, raw in enumerate(text.replace("\r\n", "\n").split("\n"), 1):
        line = raw.strip()
        if not line:
            if reader.has_id:
                reader.finish()
            continue
        if line.startswith("#~"):
            body = line[2:].lstrip()
            if body.startswith("|") or not body:
                continue  # an obsolete entry's previous string
            if reader.has_str and not reader.entry.obsolete:
                reader.finish()
            reader.keyword(body, number, obsolete=True)
        elif line.startswith("#"):
            reader.comment(line, number)
        else:
            if reader.entry.obsolete and reader.has_id:
                reader.finish()
            reader.keyword(line, number, obsolete=False)
    reader.finish()

    catalog = Catalog()
    found_header = False
    for entry in reader.entries:
        if (not found_header and not entry.obsolete
                and entry.msgctxt is None and entry.msgid == ""
                and entry.msgid_plural is None):
            found_header = True
            catalog.header = parse_header(entry.msgstr)
            catalog.header_comments = entry.translator_comments
            catalog.header_flags = entry.flags
            continue
        catalog.entries.append(entry)
    return catalog


def read(path: Path) -> Catalog:
    """Read the PO file at `path` (UTF-8)."""
    try:
        text = Path(path).read_bytes().decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PoError(f"not UTF-8 text (byte {exc.start})") from None
    return parse(text)


# --- writing -----------------------------------------------------------------

_ESCAPED = {"\\": "\\\\", '"': '\\"', "\n": "\\n", "\t": "\\t", "\r": "\\r",
            "\a": "\\a", "\b": "\\b", "\f": "\\f", "\v": "\\v"}

# Characters a line never breaks before (closing punctuation, marks that
# stay with what precedes them) and after (opening punctuation), and the
# quotation marks it breaks on neither side of.
_NO_BREAK_BEFORE = set(")]}!?,.;:/%"
                       "、。，．：；！？"
                       "」』〉》】〕〗〙"
                       "）］｝ーゝゞヽヾ"
                       "々・…‥"
                       "ぁぃぅぇぉっゃゅ"
                       "ょゎァィゥェォッ"
                       "ャュョヮヵヶ")
_NO_BREAK_AFTER = set("([{「『〈《【〔〖〘"
                      "（［｛„")
_QUOTES = set("\"'«»‘’“”‹›")


def quote(text: str) -> str:
    """`text` as one quoted PO string, escaped as gettext escapes it."""
    return '"' + "".join(_ESCAPED.get(c, c) for c in text) + '"'


def _width(ch: str) -> int:
    if unicodedata.combining(ch) or unicodedata.category(ch) in ("Mn", "Me",
                                                                 "Cf"):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


def _ideographic(ch: str) -> bool:
    return unicodedata.east_asian_width(ch) in ("W", "F") \
        and unicodedata.category(ch)[0] in "LNS"


def _break_before(text: str, i: int) -> bool:
    """Whether a line may break before text[i] (0 < i < len(text))."""
    prev, ch = text[i - 1], text[i]
    if ch in _NO_BREAK_BEFORE or ch == " ":
        return False
    if prev == " ":
        # After spaces, unless they follow opening punctuation.
        j = i - 1
        while j > 0 and text[j - 1] == " ":
            j -= 1
        return j > 0 and text[j - 1] not in _NO_BREAK_AFTER
    if ch in _QUOTES:
        return False
    if prev in _NO_BREAK_AFTER or prev in _QUOTES:
        return False
    if prev == "-":
        return i >= 2 and text[i - 2].isalpha() and ch.isalpha()
    return _ideographic(prev) or _ideographic(ch)


def _pieces(text: str) -> list[tuple[str, int]]:
    """`text` cut at its break opportunities: (escaped piece, columns)."""
    pieces: list[tuple[str, int]] = []
    start = 0
    for i in range(1, len(text) + 1):
        if i == len(text) or _break_before(text, i):
            chunk = text[start:i]
            escaped = "".join(_ESCAPED.get(c, c) for c in chunk)
            width = sum(len(_ESCAPED[c]) if c in _ESCAPED else _width(c)
                        for c in chunk)
            pieces.append((escaped, width))
            start = i
    return pieces


def _fill(pieces: list[tuple[str, int]], start: int, width: int
          ) -> list[str]:
    """The pieces in lines of at most `width` columns, the first line
    starting at column `start`; a piece wider than a line has one alone."""
    lines = [""]
    column = start
    for text, cols in pieces:
        if lines[-1] and column + cols > width:
            lines.append("")
            column = 0
        lines[-1] += text
        column += cols
    return lines


def field_lines(keyword: str, value: str, prefix: str = "",
                width: int = PAGE_WIDTH) -> list[str]:
    """`keyword` and its string `value` as PO lines, wrapped as gettext
    wraps them; `prefix` ("#~ " for an obsolete entry) starts each."""
    portions = re.split(r"(?<=\n)", value)
    if len(portions) > 1 and portions[-1] == "":
        portions.pop()
    # Columns for a line's text: the line, its quotes and prefix included,
    # fits in `width`.
    room = width - 2 - len(prefix)
    first = _fill(_pieces(portions[0]), len(keyword) + 1, room)
    if len(portions) == 1 and len(first) == 1:
        return [f'{prefix}{keyword} "{first[0]}"']
    out = [f'{prefix}{keyword} ""']
    for portion in portions:
        out += [f'{prefix}"{text}"' for text in _fill(_pieces(portion), 0,
                                                     room)]
    return out


def header_text(fields: dict[str, str]) -> str:
    """The header entry's msgstr for `fields`."""
    return "".join(f"{key}: {value}\n" for key, value in fields.items())


def _entry_lines(entry: Entry) -> list[str]:
    lines = [f"# {c}" if c else "#" for c in entry.translator_comments]
    lines += [f"#. {c}" for c in entry.extracted_comments]
    lines += [f"#: {c}" for c in entry.references]
    if entry.flags:
        lines.append("#, " + ", ".join(entry.flags))
    lines += [f"#| {c}" for c in entry.previous]
    prefix = "#~ " if entry.obsolete else ""
    if entry.msgctxt is not None:
        lines += field_lines("msgctxt", entry.msgctxt, prefix)
    lines += field_lines("msgid", entry.msgid, prefix)
    if entry.msgid_plural is not None:
        lines += field_lines("msgid_plural", entry.msgid_plural, prefix)
        for n in sorted(entry.msgstr_plural):
            lines += field_lines(f"msgstr[{n}]", entry.msgstr_plural[n],
                                 prefix)
    else:
        lines += field_lines("msgstr", entry.msgstr, prefix)
    return lines


def dumps(catalog: Catalog) -> str:
    """The PO file's text for `catalog`: the header entry, then each
    entry, a blank line between them."""
    head = Entry(msgstr=header_text(catalog.header),
                 translator_comments=catalog.header_comments,
                 flags=catalog.header_flags)
    blocks = ["\n".join(_entry_lines(entry))
              for entry in [head, *catalog.entries]]
    return "\n\n".join(blocks) + "\n"
