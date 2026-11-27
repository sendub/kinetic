"""A small Ren'Py lexer: logical lines, string literals and say
statements, as Ren'Py 8's ``renpy/lexer.py`` and ``renpy/parser.py`` read
them (docs/plan.md Phase 56 item 9b; Phase 60 item 9m). The parser reads
the story through it (``story_lines``, ``parse_say``) and
kinetic_extract.translations computes say statements' identifiers with
it; it never runs Ren'Py."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_QUOTE_ESCAPES = {"\"": "\"", "\\": "\\", "n": "\n", "#": "#", "[": "["}


def renpy_newlines(text: str) -> str:
    """A script's text as Ren'Py's lexer reads it: a leading BOM gone,
    ``\\r\\n`` and ``\\r`` made ``\\n``, its only line break. Other
    characters ``str.splitlines`` breaks at (``\\x0b``, ``\\x0c``,
    ``\\x1c`` to ``\\x1e``, ``\\x85``, U+2028, U+2029) stay in the line."""
    return text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")


def _parse_quoted(text: str, pos: int) -> tuple[str, int] | None:
    """Parse a double-quoted string starting at text[pos]; return (value, end)."""
    if pos >= len(text) or text[pos] != "\"":
        return None
    out: list[str] = []
    i = pos + 1
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            nxt = text[i + 1]
            out.append(_QUOTE_ESCAPES.get(nxt, "\\" + nxt))
            i += 2
            continue
        if ch == "\"":
            return "".join(out), i + 1
        out.append(ch)
        i += 1
    return "".join(out), len(text)  # unterminated string: take the rest


def logical_lines(text: str) -> list[tuple[int, str]]:
    """``(line number, text)`` per logical line, as Ren'Py's
    ``list_logical_lines`` divides a file: a ``#`` outside a string runs
    to the end of the line, a newline inside brackets or a string (or
    after a backslash) continues the line, blank and comment-only lines
    are dropped. The text keeps everything else as written."""
    data = renpy_newlines(text)
    data += "\n"
    out: list[tuple[int, str]] = []
    pos, number, n = 0, 1, len(data)
    while pos < n:
        # Blank lines, comment-only lines and backslash-newlines.
        m = _IGNORED_LINES_RE.match(data, pos)
        number += m.group(0).count("\n")
        pos = m.end()
        if pos >= n:
            break
        start, parts, depth = number, [], 0
        while pos < n:
            c = data[pos]
            if c in "\"'`":
                q = 3 if data[pos:pos + 3] == c * 3 else 1
                end = pos + q
                while end < n:
                    if data[end] == "\\":
                        end += 2
                        continue
                    if data[end:end + q] == c * q:
                        end += q
                        break
                    end += 1
                literal = data[pos:end]
                number += literal.count("\n")
                parts.append(literal)
                pos = end
                continue
            if c == "#":
                pos = data.index("\n", pos)
                continue
            if c == "\\" and data[pos + 1:pos + 2] == "\n":
                parts.append("\\\n")
                pos += 2
                number += 1
                continue
            if c == "\n":
                pos += 1
                number += 1
                if depth > 0:
                    parts.append("\n")
                    continue
                break
            if c in "([{":
                depth += 1
            elif c in ")]}":
                depth = max(0, depth - 1)
            parts.append(c)
            pos += 1
        line = "".join(parts)
        if line.strip():
            out.append((start, line))
    return out


def _literal_end(data: str, pos: int) -> int | None:
    """The index after the string literal opening at ``data[pos]`` (one
    of Ren'Py's quotes, tripled or not), or None when it never closes."""
    c = data[pos]
    q = 3 if data[pos:pos + 3] == c * 3 else 1
    end = pos + q
    while end < len(data):
        if data[end] == "\\":
            end += 2
            continue
        if data[end:end + q] == c * q:
            return end + q
        end += 1
    return None


def story_lines(text: str) -> list[str]:
    """A script's lines as the parser reads them: one entry per physical
    line (``parser.script_lines``), each logical line (Ren'Py's
    ``list_logical_lines``) at the index of the physical line it starts
    on, the lines it runs onto left blank. A logical line runs on while a
    bracket or a string is open, or after a backslash; a ``#`` outside a
    string runs to the end of the line and is dropped. Each join is one
    space, and so are the spaces around a line break in a string that is
    not triple-quoted, as Ren'Py reads its text (a triple-quoted string
    keeps its line breaks for its paragraphs, say_texts). A string or
    bracket left open to the end of the file, which Ren'Py refuses, is
    read line by line instead: the string to the end of its line, the
    lines from the bracket's on as they are."""
    data = renpy_newlines(text)
    physical = data.split("\n")
    if physical[-1] == "":
        physical.pop()
    out = [""] * len(physical)
    pos, number, n = 0, 0, len(data)
    while pos < n:
        start, parts, depth = number, [], 0
        while pos < n:
            c = data[pos]
            if c in "\"'`":
                end = _literal_end(data, pos)
                if end is None:
                    eol = data.find("\n", pos)
                    end = n if eol < 0 else eol
                literal = data[pos:end]
                if "\n" in literal:
                    number += literal.count("\n")
                    if literal[:3] != c * 3:
                        literal = re.sub(r"[ \t]*\n[ \t\n]*", " ", literal)
                parts.append(literal)
                pos = end
                continue
            if c == "#":
                eol = data.find("\n", pos)
                pos = n if eol < 0 else eol
                continue
            if c == "\\" and data[pos + 1:pos + 2] == "\n":
                parts.append(" ")
                pos += 2
                number += 1
                continue
            if c == "\n":
                pos += 1
                number += 1
                if depth == 0:
                    break
                parts.append(" ")
                while pos < n and data[pos] in " \t":
                    pos += 1
                continue
            if c in "([{":
                depth += 1
            elif c in ")]}":
                depth = max(0, depth - 1)
            parts.append(c)
            pos += 1
        if depth > 0 and pos >= n:
            out[start:] = physical[start:]
            break
        line = "".join(parts)
        if line.strip() and start < len(out):
            out[start] = line
    return out


_STRING_RE = re.compile(
    r"""[rRuUbBfF]{0,2}(?:"(?:[^\\"]|\\.)*"|'(?:[^\\']|\\.)*'"""
    r"""|`(?:[^\\`]|\\.)*`)""", re.DOTALL)
_TRIPLE_RE = re.compile(
    r'r?(?:"""(?:[^\\]|\\.)*?"""|' r"'''(?:[^\\]|\\.)*?'''"
    r"|```(?:[^\\]|\\.)*?```)", re.DOTALL)
_WORD_RE = re.compile(r"[^\W\d]\w*")
_IMAGE_WORD_RE = re.compile(r"[-\w]+")
_FLOAT_RE = re.compile(r"[+-]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?")
_OPERATOR_RE = re.compile(
    r"(<>|<<|<=|<|>>|>=|>|!=|==|\||\^|&|\+|-|\*\*|\*|//|/|%|~|@|:=|\bor\b"
    r"|\band\b|\bnot\b|\bin\b|\bis\b)")
_KEYWORDS = frozenset({"as", "if", "in", "return", "with", "while"})
_PLAIN_STRING_RE = re.compile(
    r"""r?(?:"(?:[^\\"]|\\.)*"|'(?:[^\\']|\\.)*'|`(?:[^\\`]|\\.)*`)""",
    re.DOTALL)
_IGNORED_LINES_RE = re.compile(r"(?:[ \t]*\n|[ \t]*#[^\n]*\n|[ \t]*\\\n)*")


class _Cursor:
    """A position in one logical line, with the few lexer methods a say
    statement needs (Ren'Py's ``renpy.lexer.Lexer``)."""

    def __init__(self, text: str) -> None:
        self.text, self.pos = text, 0

    def ws(self) -> None:
        """Skip whitespace as Ren'Py's ``skip_whitespace`` does
        (``\\s``: U+00A0 and other Unicode spaces too) and
        backslash-newlines."""
        while self.pos < len(self.text):
            if self.text[self.pos].isspace():
                self.pos += 1
            elif self.text.startswith("\\\n", self.pos):
                self.pos += 2
            else:
                break

    def eol(self) -> bool:
        self.ws()
        return self.pos >= len(self.text)

    def match(self, regex: re.Pattern[str]) -> str | None:
        self.ws()
        m = regex.match(self.text, self.pos)
        if m is None or not m.group(0):
            return None
        self.pos = m.end()
        return m.group(0)

    def keyword(self, word: str) -> bool:
        self.ws()
        m = _WORD_RE.match(self.text, self.pos)
        if m and m.group(0) == word:
            self.pos = m.end()
            return True
        return False

    def string(self) -> str | None:
        """A non-triple string literal as written (Ren'Py's ``string``
        accepts an optional ``r`` prefix only)."""
        self.ws()
        if self.text.startswith(("'''", '"""', "```", "r'''", 'r"""'),
                                self.pos):
            return None
        m = _PLAIN_STRING_RE.match(self.text, self.pos)
        if m is None:
            return None
        self.pos = m.end()
        return m.group(0)

    def triple_string(self) -> str | None:
        return self.match(_TRIPLE_RE)

    def name(self) -> str | None:
        old = self.pos
        word = self.match(_WORD_RE)
        if word is None:
            return None
        if (word in ("r", "u", "ur")
                and self.text[self.pos:self.pos + 1] in "\"'`"
                and self.pos < len(self.text)) or word in _KEYWORDS:
            self.pos = old
            return None
        return word

    def parenthesised(self) -> str | None:
        """A bracketed run, ``(...)``, ``[...]`` or ``{...}``, as
        written."""
        self.ws()
        if self.pos >= len(self.text) or self.text[self.pos] not in "([{":
            return None
        start, depth = self.pos, 0
        while self.pos < len(self.text):
            c = self.text[self.pos]
            if c in "\"'`":
                m = _STRING_RE.match(self.text, self.pos)
                self.pos = m.end() if m else self.pos + 1
                continue
            if c in "([{":
                depth += 1
            elif c in ")]}":
                depth -= 1
                if depth == 0:
                    self.pos += 1
                    return self.text[start:self.pos]
            self.pos += 1
        self.pos = start
        return None

    def simple_expression(self, operator: bool = True) -> str | None:
        """Ren'Py's ``simple_expression``: a name, string, number or
        bracketed run, then dotted names and bracketed trailers; with
        `operator`, more of them joined by operators. The text as
        written, stripped."""
        start = self.pos
        while True:
            while operator and self.match(_OPERATOR_RE):
                pass
            if self.eol():
                break
            if not (self.match(_STRING_RE) or self.name()
                    or self.match(_FLOAT_RE) or self.parenthesised()):
                break
            while True:
                self.ws()
                if self.eol():
                    break
                if self.text.startswith(".", self.pos):
                    self.pos += 1
                    if self.match(_WORD_RE) is None:
                        return None
                    continue
                if self.parenthesised() is not None:
                    continue
                break
            if operator and self.match(_OPERATOR_RE):
                continue
            break
        text = self.text[start:self.pos].strip()
        return text or None


def renpy_string(literal: str) -> str:
    """A string literal's value as Ren'Py's lexer reads it: delimiters
    off, then, unless raw, runs of spaces and newlines collapsed to one
    space and the escapes expanded (``\\n`` a newline, ``\\{`` ``{{``,
    ``\\[`` ``[[``, ``\\%`` ``%%``, ``\\uXXXX``, any other character
    itself)."""
    raw = literal.startswith("r")
    if raw:
        literal = literal[1:]
    q = 3 if literal[:3] in ('"""', "'''", "```") else 1
    s = literal[q:-q]
    if raw:
        return s
    s = re.sub(r"[ \n]+", " ", s)
    return re.sub(r"\\(u([0-9a-fA-F]{1,4})|.)", _dequote, s)


def _dequote(m: re.Match[str]) -> str:
    """One escape of a Ren'Py string literal, as its lexer expands it."""
    c = m.group(1)
    if c == "{":
        return "{{"
    if c == "[":
        return "[["
    if c == "%":
        return "%%"
    if c == "n":
        return "\n"
    if c[0] == "u":
        return chr(int(m.group(2), 16)) if m.group(2) else ""
    return c


def encode_say_string(s: str) -> str:
    """Ren'Py's ``encode_say_string``: the canonical literal of a say
    statement's text."""
    s = s.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')
    s = re.sub(r"(?<= ) ", "\\ ", s)
    return '"' + s + '"'


def item_text(literal: str) -> str:
    """A string literal read as the converter reads the item texts
    (``parser._parse_quoted``), for a translation to match what the
    manifest shows. A literal over several lines has each line break
    and the indentation around it made one space, as Ren'Py does."""
    if literal[:1] in "rRuU" and literal[1:2] in "\"'`":
        literal = literal[1:]
    if "\n" in literal:
        literal = re.sub(r"[ \t]*\n[ \t\n]*", " ", literal)
    quote = literal[:1]
    if quote != '"':
        inner = literal[1:-1].replace("\\" + quote, quote)
        literal = '"' + inner.replace('"', '\\"') + '"'
    parsed = _parse_quoted(literal, 0)
    return parsed[0] if parsed else ""


def _decode(body: str) -> str:
    """A string's body with its escapes read as the converter reads say
    text (_parse_quoted)."""
    out: list[str] = []
    i = 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            nxt = body[i + 1]
            out.append(_QUOTE_ESCAPES.get(nxt, "\\" + nxt))
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def say_texts(say: Say) -> list[str]:
    """The item texts of a say statement, read as the converter reads say
    text (item_text): one, or for a triple-quoted string one per
    paragraph, as Ren'Py's monologue mode makes a say statement of each
    paragraph between blank lines, a paragraph's line breaks and runs of
    spaces one space (``Lexer.triple_string``). A raw triple-quoted
    string is one text, as written."""
    if not say.triple:
        return [item_text(say.literal)]
    if say.literal.startswith("r"):
        return [say.literal[4:-3]]
    body = re.sub(r" *\n *", "\n", say.literal[3:-3])
    out = []
    for part in body.split("\n\n"):
        part = part.strip()
        if part:
            out.append(_decode(re.sub(r"[ \n]+", " ", part)))
    return out


@dataclass
class Say:
    """A say statement's parts, as Ren'Py's parser keeps them."""

    who: str | None
    literal: str
    attributes: list[str] = field(default_factory=list)
    temporary: list[str] = field(default_factory=list)
    interact: bool = True
    identifier: str | None = None
    arguments: str | None = None
    with_: str | None = None
    triple: bool = False

    def whats(self) -> list[str]:
        """The texts Ren'Py makes of the literal: one, or for a
        triple-quoted (monologue) string one per paragraph, as
        ``Lexer.triple_string`` splits it with the default delimiter,
        a blank line."""
        if not self.triple:
            return [renpy_string(self.literal)]
        if self.literal.startswith("r"):
            return [self.literal[4:-3]]
        out = []
        for part in re.sub(r" *\n *", "\n", self.literal[3:-3]).split(
                "\n\n"):
            part = part.strip()
            if part:
                part = re.sub(r"[ \n]+", " ", part)
                out.append(re.sub(r"\\(u([0-9a-fA-F]{1,4})|.)",
                                  _dequote, part))
        return out

    def code(self, what: str | None = None) -> str:
        """Ren'Py's ``Say.get_code()`` (for one text of a monologue,
        `what`)."""
        parts: list[str] = []
        if self.who:
            parts.append(self.who)
        parts.extend(self.attributes)
        if self.temporary:
            parts.append("@")
            parts.extend(self.temporary)
        parts.append(encode_say_string(
            renpy_string(self.literal) if what is None else what))
        if not self.interact:
            parts.append("nointeract")
        if self.identifier:
            parts += ["id", self.identifier]
        if self.arguments:
            parts.append(_argument_code(self.arguments))
        if self.with_:
            parts += ["with", self.with_]
        return " ".join(parts)


def _split_top(text: str, sep: str = ",") -> list[str]:
    """`text` split at `sep` outside brackets and strings."""
    out, depth, start, i = [], 0, 0, 0
    while i < len(text):
        c = text[i]
        if c in "\"'`":
            m = _STRING_RE.match(text, i)
            i = m.end() if m else i + 1
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == sep and depth == 0:
            out.append(text[start:i])
            start = i + 1
        i += 1
    out.append(text[start:])
    return out


def _argument_code(arguments: str) -> str:
    """Ren'Py's ``ArgumentInfo.get_code()`` for an argument list written
    ``(...)``: each argument stripped, ``name=value`` without spaces
    around the ``=``, joined with ``, ``."""
    inner = arguments.strip()[1:-1]
    args = []
    for arg in _split_top(inner):
        arg = arg.strip()
        if not arg:
            continue
        m = re.fullmatch(r"([^\W\d]\w*)\s*=(?!=)\s*(.*)", arg, re.DOTALL)
        if m:
            arg = f"{m[1]}={m[2].strip()}"
        elif arg.startswith("**"):
            arg = "**" + arg[2:].strip()
        elif arg.startswith("*"):
            arg = "*" + arg[1:].strip()
        args.append(arg)
    return "(" + ", ".join(args) + ")"


def _finish_say(cur: _Cursor, say: Say) -> bool:
    """Ren'Py's ``finish_say`` clauses: ``nointeract``, ``with``,
    ``id`` and an argument list, in any order. False when one is
    malformed."""
    while True:
        if cur.keyword("nointeract"):
            say.interact = False
        elif cur.keyword("with"):
            say.with_ = cur.simple_expression()
            if say.with_ is None:
                return False
        elif cur.keyword("id"):
            say.identifier = cur.match(_WORD_RE)
            if say.identifier is None:
                return False
        else:
            args = cur.parenthesised()
            if args is None or not args.startswith("("):
                return True
            say.arguments = args


def _attributes(cur: _Cursor) -> list[str]:
    out = []
    while True:
        old = cur.pos
        word = cur.match(_IMAGE_WORD_RE)
        if word is None:
            break
        if word in _KEYWORDS or (word in ("r", "u")
                                 and cur.text[cur.pos:cur.pos + 1]
                                 in "\"'`"):
            cur.pos = old
            break
        out.append(word)
    return out


def parse_say(text: str, interact: bool = True) -> Say | None:
    """The say statement on a logical line (Ren'Py's ``say_statement``:
    a lone string, or a speaker expression, attributes, ``@`` temporary
    attributes and a string), or None when the line is not one. The
    caller has ruled out the other statements by their keywords."""
    cur = _Cursor(text)
    literal = cur.triple_string()
    triple = literal is not None
    if literal is None:
        literal = cur.string()
    if literal is not None:
        say = Say(None, literal, interact=interact, triple=triple)
        if _finish_say(cur, say) and cur.eol():
            return say
    cur = _Cursor(text)
    who = cur.simple_expression(operator=False)
    if who is None:
        return None
    attributes = _attributes(cur)
    temporary: list[str] = []
    cur.ws()
    if cur.text.startswith("@", cur.pos):
        cur.pos += 1
        temporary = _attributes(cur)
    literal = cur.triple_string()
    triple = literal is not None
    if literal is None:
        literal = cur.string()
    if literal is None:
        return None
    say = Say(who, literal, attributes, temporary, interact=interact,
              triple=triple)
    if not _finish_say(cur, say) or not cur.eol():
        return None
    return say


# First words of the statements Ren'Py parses before trying a say
# statement (renpy/parser.py `@statement` names and the statements
# renpy/common registers); a line starting with one is never a say.
STATEMENT_WORDS = frozenset(
    "$ IF call camera default define hide if elif else image init jump "
    "label menu pass python return rpy scene screen show style testcase "
    "testsuite transform translate while with window pause play queue "
    "stop voice nvl layeredimage".split())
