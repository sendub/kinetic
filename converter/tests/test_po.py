"""The PO reader and writer (docs/plan.md Phase 56, item 8;
converter/kinetic_extract/po.py)."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from kinetic_extract import po

SAMPLE = r'''# Translator's note
#
#. An extracted comment
#: manifest.json:12
#, fuzzy, c-format
#| msgid "Old text"
msgctxt "item:a"
msgid "Hello, \"world\"\n"
"second line\twith a tab and a \\ backslash"
msgstr ""
"Hallo, "
"\"Welt\"\nzweite Zeile\tmit Tab und \\"

msgid "no context"
msgstr "kein Kontext"

msgctxt "plural"
msgid "one file"
msgid_plural "%d files"
msgstr[0] "eine Datei"
msgstr[1] "%d Dateien"

#~ msgctxt "item:gone"
#~ msgid ""
#~ "an obsolete "
#~ "string"
#~ msgstr "veraltet"
'''

HEADER = ('msgid ""\nmsgstr ""\n"Language: de\\n"\n'
          '"Content-Type: text/plain; charset=UTF-8\\n"\n'
          '"X-Kinetic-Story: a-story\\n"\n\n')


def test_reads_every_part_of_an_entry() -> None:
    catalog = po.parse(HEADER + SAMPLE)
    assert catalog.header == {"Language": "de",
                              "Content-Type": "text/plain; charset=UTF-8",
                              "X-Kinetic-Story": "a-story"}
    first, plain, plural, gone = catalog.entries
    assert first.msgctxt == "item:a"
    assert first.msgid == ('Hello, "world"\nsecond line\twith a tab and a '
                           '\\ backslash')
    assert first.msgstr == 'Hallo, "Welt"\nzweite Zeile\tmit Tab und \\'
    assert first.translator_comments == ["Translator's note", ""]
    assert first.extracted_comments == ["An extracted comment"]
    assert first.references == ["manifest.json:12"]
    assert first.flags == ["fuzzy", "c-format"] and first.fuzzy
    assert first.previous == ['msgid "Old text"']
    assert not first.obsolete
    assert plain.msgctxt is None and plain.msgstr == "kein Kontext"
    assert not plain.fuzzy
    assert plural.msgid_plural == "%d files"
    assert plural.msgstr_plural == {0: "eine Datei", 1: "%d Dateien"}
    assert gone.obsolete and gone.msgctxt == "item:gone"
    assert gone.msgid == "an obsolete string" and gone.msgstr == "veraltet"


def test_crlf_and_a_byte_order_mark_read_the_same() -> None:
    text = HEADER + SAMPLE
    plain = po.parse(text)
    odd = po.parse("\ufeff" + text.replace("\n", "\r\n"))
    assert odd == plain


def test_read_takes_utf8_bytes(tmp_path: Path) -> None:
    path = tmp_path / "x.po"
    path.write_bytes(("\ufeff" + HEADER + 'msgctxt "c"\nmsgid "Ä"\n'
                      'msgstr "日本"\n').encode("utf-8"))
    assert po.read(path).entries[0].msgstr == "日本"
    path.write_bytes(b'msgid "\xff"\nmsgstr ""\n')
    with pytest.raises(po.PoError, match="not UTF-8"):
        po.read(path)


def test_escapes_octal_and_hex() -> None:
    entry = po.parse('msgctxt "c"\nmsgid "a\\101\\x42\\a\\?"\n'
                     'msgstr ""\n').entries[0]
    assert entry.msgid == "aAB\a?"


@pytest.mark.parametrize("text, why", [
    ('msgid "a"\n', "msgid with no msgstr"),
    ('msgstr "a"\n', "msgstr before msgid"),
    ('msgid "a\nmsgstr ""\n', "cannot read"),
    ('msgid "a"b"\nmsgstr ""\n', "unescaped quote"),
    ('msgid "\\q"\nmsgstr ""\n', "unknown escape"),
    ('"stray"\n', "continues no field"),
    ('msgid "a"\nmsgstr ""\nwhat\n', "cannot read"),
])
def test_a_malformed_file_names_its_line(text: str, why: str) -> None:
    with pytest.raises(po.PoError, match=why):
        po.parse(text)


def test_writes_short_strings_on_one_line_and_breaks_after_newlines() -> None:
    catalog = po.Catalog(header={"Language": "de"}, entries=[
        po.Entry(msgctxt="c", msgid="short", msgstr="kurz",
                 extracted_comments=["context"], flags=["fuzzy"]),
        po.Entry(msgctxt="d", msgid="one\ntwo\n", msgstr=""),
    ])
    assert po.dumps(catalog) == (
        'msgid ""\nmsgstr "Language: de\\n"\n\n'
        '#. context\n#, fuzzy\nmsgctxt "c"\nmsgid "short"\nmsgstr "kurz"\n\n'
        'msgctxt "d"\nmsgid ""\n"one\\n"\n"two\\n"\nmsgstr ""\n')


def test_long_strings_wrap_at_79_columns_after_spaces() -> None:
    text = " ".join(["word"] * 40)
    lines = po.field_lines("msgid", text)
    assert lines[0] == 'msgid ""'
    assert all(len(line) <= po.PAGE_WIDTH for line in lines)
    assert all(line.endswith(' "') for line in lines[1:-1])
    assert po.unquote('"' + "".join(line[1:-1] for line in lines[1:])
                      + '"') == text


def test_an_unbreakable_string_stays_whole() -> None:
    assert po.field_lines("msgid", "x" * 100) == [f'msgid "{"x" * 100}"']


def test_wide_characters_count_two_columns() -> None:
    lines = po.field_lines("msgstr", "日本語" * 20)
    assert lines[0] == 'msgstr ""'
    # 38 wide characters fill 76 of the 77 columns inside the quotes.
    assert [len(line) for line in lines[1:]] == [40, 24]


def test_obsolete_entries_write_with_their_prefix() -> None:
    entry = po.Entry(msgctxt="item:gone", msgid="", msgstr="weg",
                     obsolete=True, translator_comments=["kept"])
    text = po.dumps(po.Catalog(entries=[entry]))
    assert text.endswith('# kept\n#~ msgctxt "item:gone"\n#~ msgid ""\n'
                         '#~ msgstr "weg"\n')
    assert po.parse(text).entries == [
        po.Entry(msgctxt="item:gone", msgid="", msgstr="weg", obsolete=True,
                 translator_comments=["kept"], line=entry_line(text))]


def entry_line(text: str) -> int:
    return text.split("\n").index("# kept") + 1


ROUND_TRIP = [
    "plain",
    "",
    "line one\nline two\n\nafter a blank line",
    "ends with a newline\n",
    'quotes " and \\ backslashes and \t tabs',
    " ".join(["long"] * 50),
    "「こんにちは」と彼は言った。これはとても長い日本語の文章で、折り返しがどこで"
    "起きるかを確かめるためのものです。",
    "نص عربي طويل بما يكفي ليلتف عند حد التسعة والسبعين عمودًا في ملف الترجمة "
    "هذا.",
    "Ein Satz mit Bindestrich-Wörtern wie Kinetic-Sprachdemo und "
    "Route-1-Ende, lang genug für einen Umbruch.",
]


@pytest.mark.parametrize("text", ROUND_TRIP)
def test_written_text_reads_back(text: str) -> None:
    catalog = po.Catalog(header={"Language": "ja"}, entries=[
        po.Entry(msgctxt="c", msgid=text, msgstr=text)])
    back = po.parse(po.dumps(catalog))
    assert back.header == catalog.header
    assert (back.entries[0].msgid, back.entries[0].msgstr) == (text, text)


def poedit_style(text: str) -> str:
    """`text`'s strings rewrapped another way: every msgid/msgstr split
    into quoted pieces of at most 20 characters, no empty first string."""
    out = []
    for line in text.split("\n"):
        for keyword in ("msgid ", "msgstr "):
            if line.startswith(keyword + '"'):
                out.append(("KEY", keyword, po.unquote(line[len(keyword):])))
                break
        else:
            if line.startswith('"') and out and out[-1][0] == "KEY":
                kind, keyword, value = out.pop()
                out.append((kind, keyword, value + po.unquote(line)))
            else:
                out.append(("LINE", line, None))
    lines = []
    for kind, first, value in out:
        if kind == "LINE":
            lines.append(first)
            continue
        body = po.quote(value)[1:-1]
        pieces = [body[i:i + 20] for i in range(0, len(body), 20)] or [""]
        # Never split an escape.
        merged: list[str] = []
        for piece in pieces:
            if merged and (merged[-1].endswith("\\")
                           and not merged[-1].endswith("\\\\")):
                merged[-1] += piece
            else:
                merged.append(piece)
        lines.append(f'{first}"{merged[0]}"')
        lines += [f'"{p}"' for p in merged[1:]]
    return "\n".join(lines)


def test_a_differently_wrapped_file_reads_the_same() -> None:
    catalog = po.Catalog(header={"Language": "de", "X-Kinetic-Story": "s"},
                         entries=[po.Entry(msgctxt=f"c{i}", msgid=t,
                                           msgstr=t[::-1])
                                  for i, t in enumerate(ROUND_TRIP)])
    text = po.dumps(catalog)
    rewrapped = poedit_style(text)
    assert rewrapped != text
    plain, other = po.parse(text), po.parse(rewrapped)
    assert other.header == plain.header
    assert [(e.msgctxt, e.msgid, e.msgstr) for e in other.entries] == \
        [(e.msgctxt, e.msgid, e.msgstr) for e in plain.entries]


@pytest.mark.skipif(shutil.which("msgcat") is None,
                    reason="GNU gettext's msgcat is not installed")
def test_gnu_msgcat_leaves_the_written_file_unchanged(tmp_path: Path) -> None:
    """The writer wraps as gettext does: msgcat rewrites nothing."""
    catalog = po.Catalog(
        header={"Language": "de",
                "Content-Type": "text/plain; charset=UTF-8"},
        entries=[po.Entry(msgctxt=f"c{i}", msgid=t, msgstr=t,
                          extracted_comments=["a comment"])
                 for i, t in enumerate(ROUND_TRIP)]
        + [po.Entry(msgctxt="gone", msgid="", msgstr="old text",
                    obsolete=True)])
    path = tmp_path / "x.po"
    path.write_text(po.dumps(catalog), encoding="utf-8")
    proc = subprocess.run(["msgcat", str(path)], capture_output=True,
                          text=True, check=True)
    assert proc.stdout == path.read_text(encoding="utf-8")
