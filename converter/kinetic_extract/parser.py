"""Statement-subset parser for Ren'Py ``.rpy`` sources.

A line/indent based scanner over UTF-8 text (BOM tolerated). It recognizes
the statement subset in docs/stack.md §Converter decisions at label flow and
turns the script into a linear stream of events for the timeline builder.
Everything it does not recognize is reported (never fatal) so the build
ledger can list what was skipped.

Design notes:

- Comments are stripped outside quoted strings.
- A line ending in ":" opens a block: all following lines indented deeper
  than the opening line belong to it. ``label`` blocks continue the linear
  walk; blocks other than ``label`` and ``menu`` are skipped.
- ``menu`` is parsed structurally (docs/plan.md Phase 13): the caption and
  the ``"label":`` choice blocks are captured into a ``MenuRecord`` and the
  choice bodies feed the linear event stream between ``menu-open`` /
  ``choice-open`` / ``menu-close`` marker events, so the timeline can lay a
  branch decision over the items. A menu that fails the conservative shape
  (a non-quoted or conditional choice, a nested menu, a flow or unknown
  statement inside a choice block, fewer than two choices) is reported
  with ``menu unsupported (...)`` and its whole block is skipped, as before
  — never fatal.
- ``jump``, ``call`` and ``return`` become flow events (``Event.flow``, a
  ``FlowStep``), and so do the jumps and calls inside an ``if``/``elif``/
  ``else`` chain, a ``while`` or a menu the walk does not convert (a
  ``fork`` event, one alternative per block). kinetic_extract.flow follows
  them from ``label start`` (docs/plan.md Phase 57 item 4e); the blocks'
  other statements are skipped as before.
- Audio statements (``play``, ``queue``, ``stop``, ``voice`` and literal
  ``$ renpy.music``/``renpy.sound`` calls, docs/plan.md Phase 47 item 8)
  become ``audio`` events, in label flow and in choice blocks alike;
  kinetic_extract.audio_statements reads them. Audio the walk cannot
  convert is reported: inside a skipped block (a screen, a transform,
  Python, an ``if``), inside an unsupported menu, or in a form that is
  not read. ``define audio.x``, ``register_channel`` and
  ``register_statement`` are read on every line, blocks included.
- A ``with`` clause on ``scene``/``show`` rides on its visual event; a
  bare ``with`` (and a ``hide``'s clause) is a ``with`` event and a
  ``pause`` an ``interact`` event, so the timeline can give the item a
  ``transition`` (kinetic_extract.presentation reads the expression,
  the Character defines' colours and the ``define``d aliases kept in
  ``character_defs`` and ``simple_defines``).
"""

from __future__ import annotations

import fnmatch
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from .audio_statements import (AudioChannel, AudioStatement, mentions_audio,
                               read_audio_define, read_channel, read_python,
                               read_statement)

# A Character made by `define e = Character(...)` (with or without an
# init priority, `define -2 e = ...`), by `$ e = Character(...)`, or by
# `e = Character(...)` in an `init python` block; `DynamicCharacter`,
# `ADVCharacter` and `NVLCharacter` too. The display name is read from
# the arguments by character_name.
_DEFINE_CHAR_RE = re.compile(
    r"(?:define\s+(?:[+-]?\d+\s+)?|\$\s*)?([A-Za-z_]\w*)\s*=\s*"
    r"(Character|DynamicCharacter|ADVCharacter|NVLCharacter)\s*\(")
# A name argument the converter can read: a string literal, plain or
# wrapped in Ren'Py's translation markers `_()` or `__()`.
_NAME_ARG_RE = re.compile(
    r"""(?:(__?)\s*\(\s*)?("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')"""
    r"""\s*(\))?""", re.DOTALL)
_KEYWORD_ARG_RE = re.compile(r"([A-Za-z_]\w*)\s*=(?!=)\s*(.*)", re.DOTALL)
_DOTTED_NAME_RE = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*")
# The speaker is any identifier at the line head followed by a quoted
# string. The space between them is optional: the corpus writes both
# `al "..."` and `al"..."` (docs/extracting.md BUG 3), and the keywords
# the walker knows (`image`, `scene`, ...) are matched before this runs,
# so the looser form cannot capture them.
# The project settings that name the story (docs/plan.md Phase 21, Story
# ID): `define config.save_directory = "..."` (or the older
# `config.save_directory = "..."` inside an `init python` block), and
# `config.name`, plain or `_()`-wrapped. Only a string literal counts:
# `None` or an expression names nothing. Single or double quotes.
# `config.version` (the manifest `version`, docs/plan.md Phase 51) the
# same way, except that the literal must be the whole value: `"1." +
# str(build)` gives no version rather than its first part.
_CONFIG_STRING_RE = re.compile(
    r"""\s*(?:define\s+)?"""
    r"""config\.(save_directory|name|voice_filename_format|version)"""
    r"""\s*=\s*"""
    r"""(_\(\s*)?(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')""")
_WHOLE_VALUE_SETTINGS = frozenset({"version"})
_SPEAKER_SAY_RE = re.compile(r"([A-Za-z_]\w*)\s*\"")
# `define NAME = value` with a plain name: transition aliases
# (kinetic_extract.presentation) are read from these.
_SIMPLE_DEFINE_RE = re.compile(
    r"define\s+(?:[+-]?\d+\s+)?([A-Za-z_]\w*)\s*=(?!=)\s*(.+)")
# The `with` clause ending a scene/show/hide statement.
_WITH_CLAUSE_RE = re.compile(r"(?:^|\s)with\s+(?=\S)")
_QUOTED_TEXT_RE = re.compile(r""""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'""")
_LABEL_HEAD_RE = re.compile(r"^label\s+([A-Za-z_]\w*)")
# A label's whole name: a global one, `global.local`, or `.local` (a local
# label of the global label above it).
_LABEL_NAME_RE = re.compile(r"\.?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?")
_LABEL_FULL_RE = re.compile(r"^label\s+(" + _LABEL_NAME_RE.pattern + ")")
# A screen's `Jump("x")` and `Call("x")` actions with a literal label, and
# the screens it includes with `use`.
_SCREEN_ACTION_RE = re.compile(
    r"""\b(Jump|Call)\(\s*(?:"([^"]*)"|'([^']*)')\s*[,)]""")
_SCREEN_USE_RE = re.compile(r"use\s+([A-Za-z_]\w*)")
_SCREEN_HEAD_RE = re.compile(r"screen\s+([A-Za-z_]\w*)")
# An assignment to a plain name, and a screen's SetVariable action.
_ASSIGN_RE = re.compile(
    r"(?:\$\s*|define\s+(?:[+-]?\d+\s+)?|default\s+)?(?:store\.)?"
    r"([A-Za-z_]\w*)\s*=(?!=)\s*(.+)")
_SET_VARIABLE_RE = re.compile(
    r"""SetVariable\(\s*["']([A-Za-z_]\w*)["']\s*,\s*([^)]*)\)""")
_DEF_RE = re.compile(r"def\s+([A-Za-z_]\w*)\s*\(")
# A named menu, `menu name:`, which is also a label.
_NAMED_MENU_RE = re.compile(r"menu\s+(" + _LABEL_NAME_RE.pattern + r")\s*:")
# `$ renpy.jump("x")` and `$ renpy.call("x")` with a literal label.
_PY_FLOW_RE = re.compile(
    r"""\$\s*renpy\.(jump|call)\(\s*(?:"([^"]*)"|'([^']*)'|(.*?))\s*[,)]""")
# `renpy.register_statement("name", ...)`: a creator-defined statement.
_REGISTER_STATEMENT_RE = re.compile(
    r"register_statement\(\s*(?:name\s*=\s*)?[\"']([^\"']+)[\"']")
_AUDIO_KEYWORDS = frozenset({"play", "queue", "stop", "voice"})
CREATOR_STATEMENT = "creator-defined statement: not converted"
SHOW_SCREEN = "show screen: a screen, not an image; not converted"
CALL_SCREEN = "call screen: a screen, not converted; the walk goes on after it"
AUDIO_IN_MENU = "audio inside an unsupported menu: not converted"

# Block-opening keywords whose contents the walker skips silently (the
# statement itself is recognized).
_QUIET_BLOCK_KEYWORDS = frozenset({"init", "python", "screen", "transform"})
# Single-line statements skipped without a report.
_QUIET_STATEMENT_KEYWORDS = frozenset(
    {"window", "with", "pause", "return", "default", "$"})
# Cosmetics that may sit inside a menu choice block without disqualifying
# it: they change no flow and no state (unlike `return` or `$`).
_MENU_NOISE_KEYWORDS = frozenset({"window", "with", "pause"})

# docs/content-format.md caps enforced by the validator.
PROMPT_MAX = 199       # prompt "shorter than 200 characters"
LABEL_MAX = 119        # route label "shorter than 120 characters"
ID_MAX = 64            # docs/content-schema.json $defs/id pattern

_DEFAULT_PROMPT = "What happens next?"

_QUOTE_ESCAPES = {"\"": "\"", "\\": "\\", "n": "\n", "#": "#", "[": "["}


_SLUG_BAD_RE = re.compile(r"[^A-Za-z0-9_-]+")


def slug(text: str | None, fallback: str) -> str:
    """Id-safe slug of a name: non-[A-Za-z0-9_-] runs become `-` (the
    item-id scheme of kinetic_extract.timeline, reused for branch ids)."""
    raw = _SLUG_BAD_RE.sub("-", (text or "").strip()).strip("-")
    return raw[:60] if raw else fallback



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


def _call_arguments(text: str, start: int) -> list[str] | None:
    """The arguments of the call whose `(` is just before `start`, split
    at the commas outside brackets and strings, each stripped; None when
    the call does not close."""
    out, depth, quote, i, begin = [], 0, "", start, start
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == "\\":
                i += 1
            elif ch == quote:
                quote = ""
        elif ch in "\"'":
            quote = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            if depth == 0:
                out.append(text[begin:i].strip())
                return [a for a in out if a]
            depth -= 1
        elif ch == "," and depth == 0:
            out.append(text[begin:i].strip())
            begin = i + 1
        i += 1
    return None


def _literal_value(literal: str) -> str | None:
    """A double- or single-quoted literal's text, as the converter reads
    say text (_parse_quoted)."""
    if literal[:1] == "'":
        inner = literal[1:-1].replace("\\'", "'")
        literal = '"' + inner.replace('"', '\\"') + '"'
    parsed = _parse_quoted(literal, 0)
    return parsed[0] if parsed else None


def character_kind(line: str) -> str | None:
    """The `kind=` name of a Character statement (_DEFINE_CHAR_RE) that
    gives no name argument, which Ren'Py then takes from its kind; None
    otherwise, or when `kind` is not a plain name."""
    m = _DEFINE_CHAR_RE.match(line)
    args = _call_arguments(line, m.end()) if m else None
    if args is None:
        return None
    kind = None
    for arg in args:
        kw = _KEYWORD_ARG_RE.fullmatch(arg)
        if kw is None or kw.group(1) == "name":
            return None
        if kw.group(1) == "kind":
            kind = kw.group(2).strip()
    return kind if kind and _DOTTED_NAME_RE.fullmatch(kind) else None


def character_name(line: str) -> tuple[str, str] | None:
    """``(variable, display name)`` of a Character statement
    (_DEFINE_CHAR_RE: `define x = Character(...)`, `$ x = ...` or an
    `init python` assignment, `DynamicCharacter(...)` and the others),
    or None when it is not one or its name is not a literal the
    converter can read. The name is the first
    positional argument or `name=`, a string literal, plain or wrapped in
    `_()` or `__()` (Ren'Py's translation markers, so the name is the
    text a `translate ... strings` block translates); a longer
    expression starting with such a literal (`"Ana" + x`) gives the
    literal, the part the converter can read. A dynamic
    character (`DynamicCharacter("var")`, or `dynamic=True`) names a
    variable whose value Ren'Py shows: its name reads `[var]`, as
    `Character("[var]")` does, kept literal like any interpolation."""
    m = _DEFINE_CHAR_RE.match(line)
    if m is None:
        return None
    args = _call_arguments(line, m.end())
    if args is None:
        return None
    dynamic = m.group(2) == "DynamicCharacter"
    name_arg = None
    for arg in args:
        kw = _KEYWORD_ARG_RE.fullmatch(arg)
        if kw is None:
            if name_arg is None:
                name_arg = arg
        elif kw.group(1) == "name":
            name_arg = kw.group(2).strip()
        elif kw.group(1) == "dynamic":
            dynamic = kw.group(2).strip() == "True"
    if name_arg is None:
        return None
    # An expression starting with a literal (`"Ana " + str(n)`) gives
    # that literal, as the converter read names before item 9b.
    lit = _NAME_ARG_RE.match(name_arg)
    if lit is None or bool(lit.group(1)) != bool(lit.group(3)):
        return None
    value = _literal_value(lit.group(2))
    if value is None:
        return None
    if dynamic:
        value = value.strip()
        if (lit.group(1) or lit.end() != len(name_arg)
                or not _DOTTED_NAME_RE.fullmatch(value)):
            return None
        value = f"[{value}]"
    return m.group(1), value


def strip_comment(line: str) -> str:
    """Remove a ``#`` comment that is not inside a quoted string, double-
    or single-quoted (`color='#fff'` keeps its colour)."""
    quote = ""
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == "\\" and quote and i + 1 < len(line):
            i += 2
            continue
        if ch == "\"" or (ch == "'" and quote != "\""):
            if not quote:
                quote = ch
            elif quote == ch:
                quote = ""
        elif ch == "#" and not quote:
            return line[:i].rstrip()
        i += 1
    return line.rstrip()


@dataclass
class Report:
    """One ledger note: what was skipped/reported and where."""

    source: str          # "game/script.rpy:12"
    statement: str       # the source line text
    reason: str


@dataclass
class FlowStep:
    """A statement that moves the walk (kinetic_extract.flow): ``jump``,
    ``call`` (``target`` the label, None for `expression`, a computed
    target), ``return``, a ``label`` inside a block the walk does not
    convert (a place a jump can land), ``screen`` (`show screen` or `call
    screen`, ``target`` the screen, whose `Jump` and `Call` actions the
    walk follows), or a ``fork``: the blocks of an `if` chain, a `while`
    or a menu the walk does not convert, each block's own steps in
    ``alternatives`` (an empty one goes on after the fork)."""

    kind: str                 # jump | call | return | label | screen | fork
    source: str               # "game/script.rpy:12"
    statement: str = ""
    target: str | None = None
    alternatives: list[list["FlowStep"]] = field(default_factory=list)
    # A computed jump or call: the label-like string literals written in
    # its own expression (`call expression choice(["a", "b"])`), which
    # kinetic_extract.flow tries first, and the global label it is in
    # (whose assignments to its variables tie labels to it).
    candidates: list[str] = field(default_factory=list)
    scope: str | None = None


@dataclass
class Event:
    """A recognized statement in linear flow order.

    Menu structure arrives as marker events: ``menu-open`` (name is the
    menu's index in ``FileParse.menus``), ``choice-open`` (name is
    ``"<menu index>:<choice index>"``), and ``menu-close`` (name is the
    menu index again). The statements of a choice block sit between its
    ``choice-open`` and the next boundary, so the timeline can attribute
    items to route spans by position."""

    kind: str            # visual | video | dialogue | stop-movie | label |
                         # menu-open | choice-open | menu-close | audio |
                         # with (a bare `with`) | interact (a `pause`, or
                         # the implicit `with None` of a hide's clause) |
                         # jump | call | return | fork (``flow`` set)
    source: str
    text: str = ""       # dialogue text (dialogue events)
    speaker: str | None = None
    asset: str | None = None   # source image/video path relative to game/
    name: str | None = None    # image name (visual) or raw statement text
                               # (the `with` expression of a with event)
    cue: AudioStatement | None = None  # the statement (audio events)
    # The `with` clause's expression on a scene/show (visual events).
    transition: str | None = None
    # The flow statement (jump, call, return and fork events).
    flow: FlowStep | None = None


@dataclass
class MenuRecord:
    """One ``menu:`` block parsed structurally, for branch detection.

    The parser fills the decision shape (id, prompt, choice labels) and
    rejects menus that fail the conservative syntactic rules by setting
    ``skip_reason``; the timeline rejects shape problems it can only see
    after the walk (no item precedes the menu, an empty choice span); the
    CLI withdraws a candidate whose items the asset pass dropped. A record
    with ``skip_reason is None`` after the CLI pass became a manifest
    decision."""

    source: str            # "game/script.rpy:38"
    statement: str         # the `menu:` line text
    decision_id: str       # "menu-<label slug>-<line>", unique-checked
    prompt: str
    prompt_defaulted: bool  # no caption in the source; prompt synthesized
    choices: list[str] = field(default_factory=list)
    skip_reason: str | None = None



@dataclass
class FileParse:
    """Result of parsing one .rpy file."""

    relname: str
    events: list[Event] = field(default_factory=list)
    # Structural menu records, indexed by the number carried in this
    # file's menu marker events (docs/plan.md Phase 13).
    menus: list[MenuRecord] = field(default_factory=list)
    # name -> ("file", quoted path) | ("expr", verbatim non-quoted value,
    # e.g. `Movie(play="x.webm")` — kinetic_extract.timeline classifies it).
    image_defs: dict[str, tuple[str, str]] = field(default_factory=dict)
    characters: dict[str, str] = field(default_factory=dict)   # var -> display
    # var -> (source, statement) of each Character define, the call
    # joined onto one line (kinetic_extract.presentation reads colours).
    character_defs: dict[str, tuple[str, str]] = field(default_factory=dict)
    # var -> its `kind=` name, for a Character with no name argument
    # (parse_project gives it the kind's display name).
    character_kinds: dict[str, str] = field(default_factory=dict)
    # name -> value text of every other `define NAME = value` with a
    # plain name (transition aliases).
    simple_defines: dict[str, str] = field(default_factory=dict)
    reports: list[Report] = field(default_factory=list)
    # First string literal assigned to `config.save_directory`,
    # `config.name` (the manifest storyId and title), `config.version`
    # (the manifest version) or `config.voice_filename_format` in this
    # file, by setting name.
    config: dict[str, str] = field(default_factory=dict)
    # `define audio.NAME = "file"` names; None when the value is not a
    # string literal (an expression the converter cannot follow).
    audio_defs: dict[str, str | None] = field(default_factory=dict)
    # Channels registered with literal `register_channel` arguments.
    channels: dict[str, AudioChannel] = field(default_factory=dict)
    # Creator-defined statement names (`renpy.register_statement`)
    # known while parsing: this file's own and those parse_project found
    # in the project's other files.
    creator_statements: set[str] = field(default_factory=set)
    # The label-like string literals written anywhere in the file's code
    # (name_literals), candidates for a computed jump or call.
    literals: set[str] = field(default_factory=set)
    # Every assignment the code makes, ``(variable, scope, expression)``:
    # `$ x = ...`, `x = ...` in a python block, `define`/`default x =
    # ...` and a screen's `SetVariable("x", ...)`; the scope is the global
    # label the line is in, None outside labels (init and python blocks,
    # screens). kinetic_extract.flow follows a computed target's variable
    # through them.
    assignments: list[tuple[str, str | None, str]] = field(
        default_factory=list)
    # Function name -> the text of its body (`def name(...):` in Python).
    functions: dict[str, str] = field(default_factory=dict)
    # Screen name -> its literal `Jump`/`Call` actions as jump and call
    # steps, in order, and the screens it includes with `use`.
    screens: dict[str, tuple[list[FlowStep], list[str]]] = field(
        default_factory=dict)
    # Index of the first report the statement walk made: those before it
    # are settings read on every line, which hold whether or not the walk
    # reaches them (kinetic_extract.flow drops the walk's reports from
    # labels it does not reach).
    story_reports_from: int = 0


def with_clause(rest: str) -> str | None:
    """The expression of the `with` clause ending a scene/show/hide
    statement's ``rest`` (an ATL block's `:` left off), or None. The
    clause is the last `with` outside quoted strings, so `show text
    "with you" with dissolve` gives `dissolve`."""
    masked = _QUOTED_TEXT_RE.sub(lambda q: "\"" + "x" * (len(q.group(0)) - 2)
                                 + "\"", rest)
    found = list(_WITH_CLAUSE_RE.finditer(masked))
    if not found:
        return None
    expr = rest[found[-1].end():].strip()
    if expr.endswith(":"):
        expr = expr[:-1].strip()
    return expr or None


def _name_tokens(rest: str) -> str:
    """Image-name tokens of a scene/show statement, up to `at`/`with`."""
    parts: list[str] = []
    tokens = rest.split()
    for tok in tokens:
        if tok in {"at", "with"}:
            break
        parts.append(tok)
    return " ".join(parts)


def _split_image_def(rest: str) -> tuple[str, tuple[str, str] | None]:
    """Split an `image` statement into (name, (kind, value) | None).

    Ren'Py writes definitions three ways the corpus uses:
    `name "file"`, `name = "file"`, and `name = Movie(play="file.webm")`.
    The name is every token up to the first `=` when one precedes the
    first quote — the whole line up to the quote otherwise. Cutting at
    the quote instead registered `image x = Movie(play="m.webm")` under
    the key `x = Movie(play` (docs/extracting.md BUG 2). A quoted value
    is parsed and stored as `("file", path)`; anything else keeps the
    parens and is stored verbatim as `("expr", value)` for the timeline
    to read (it recognizes `Movie(play="…")`). None means the line
    carries no file at all.
    """
    quote_at = rest.find("\"")
    eq_at = rest.find("=")
    if eq_at != -1 and (quote_at == -1 or eq_at < quote_at):
        name = rest[:eq_at]
        value = rest[eq_at + 1:].strip()
        if not value:
            return " ".join(name.split()), None
        if value.startswith("\""):
            parsed = _parse_quoted(value, 0)
            return " ".join(name.split()), ("file", parsed[0]) if parsed \
                else None
        return " ".join(name.split()), ("expr", value)
    if quote_at == -1:
        return _name_tokens(rest), None
    name = rest[:quote_at]
    parsed = _parse_quoted(rest, quote_at)
    return " ".join(name.split()), ("file", parsed[0]) if parsed else None


def _is_creator_statement(line: str, names: set[str]) -> bool:
    """True when ``line`` starts with a creator-defined statement's
    name. Ren'Py matches registered statements before a say statement,
    so `sfx "boom"` is the statement, not a line spoken by `sfx`."""
    words = line.replace(":", " ").split()
    return any(words[:len(name.split())] == name.split() for name in names)


def _classify_menu_statement(src: str, line: str,
                             creator: set[str] = frozenset()):
    """Classify one line inside a menu choice block.

    Answers ``("event", Event)``, ``("noise", None)``, or
    ``("reject", reason)``. Only image/text-item statements (scene/show
    and dialogue), audio statements and pure cosmetics (window/with/pause)
    keep the menu eligible (docs/plan.md Phase 13, conservative
    extraction): a nested ``menu``, a flow statement
    (``jump``/``call``/``return``), a video statement, and any unknown
    statement disqualify the whole menu, which is then reported and
    skipped as before. An audio statement that cannot be converted keeps
    the menu too: it answers a ``report`` event (``name`` the reason)
    that the menu handler turns into a report (Phase 47 item 8)."""
    keyword = line.split(" ", 1)[0].split(":", 1)[0]
    rest = line[len(keyword):].strip()
    if rest.startswith(":"):
        rest = rest[1:].strip()
    if _is_creator_statement(line, creator):
        return "reject", f"creator-defined statement in a choice block: {line}"
    read = _read_audio(keyword, line)
    if isinstance(read, AudioStatement):
        return "event", Event("audio", src, cue=read)
    if isinstance(read, str):
        return "event", Event("report", src, text=line, name=read)
    if keyword == "menu":
        return "reject", "nested menu inside a choice block"
    if keyword == "scene":
        return "event", Event("visual", src,
                              name=_name_tokens(rest) or "black",
                              transition=with_clause(rest))
    if keyword == "show":
        if rest.startswith("layer "):
            return "reject", "show layer inside a choice block"
        if rest.startswith("screen "):
            return "event", Event("report", src, text=line, name=SHOW_SCREEN)
        name = _name_tokens(rest)
        if not name:
            return "reject", f"show without an image: {line}"
        return "event", Event("visual", src, name=name,
                              transition=with_clause(rest))
    if keyword == "with" and rest:
        return "event", Event("with", src, name=rest)
    if keyword == "pause":
        return "event", Event("interact", src)
    if keyword in {"jump", "call", "return"}:
        return "reject", (f"{keyword} inside a choice block "
                          "(flow does not continue in place)")
    if keyword in _MENU_NOISE_KEYWORDS:
        return "noise", None
    # Video/state/control statements: recognized, but their presence in a
    # choice block breaks the conservative shape. (`$` and `default` are
    # caught below as unrecognized, like any unknown statement.)
    if keyword in {"movie", "stop", "hide", "image", "define", "label",
                   "init", "python", "screen", "transform", "if", "elif",
                   "else"}:
        return "reject", f"unsupported in a choice block: {line}"
    quoted_start = line.find("\"")
    if quoted_start == 0:
        parsed = _parse_quoted(line, 0)
        if parsed:
            return "event", Event("dialogue", src, text=parsed[0])
        return "reject", f"unrecognized statement in a choice block: {line}"
    m = _SPEAKER_SAY_RE.match(line)
    if m and quoted_start != -1:
        parsed = _parse_quoted(line, quoted_start)
        if parsed:
            return "event", Event("dialogue", src, text=parsed[0],
                                  speaker=m.group(1))
    return "reject", f"unrecognized statement in a choice block: {line}"


def _read_audio(keyword: str, line: str) -> AudioStatement | str | None:
    """The audio statement on ``line``, a report reason, or None."""
    if line.startswith("$"):
        return read_python(line)
    if keyword in _AUDIO_KEYWORDS:
        return read_statement(line)
    return None


def full_label(name: str, cur_global: str | None) -> str:
    """A label name as Ren'Py stores it: `.local` under the global label
    above it becomes `global.local`."""
    if name.startswith("."):
        return f"{cur_global}{name}" if cur_global else name[1:]
    return name


def flow_statement(line: str, source: str, cur_global: str | None
                   ) -> FlowStep | str | None:
    """The flow step of a `jump`, `call`, `return` or literal
    `$ renpy.jump/call(...)` line; a report reason for one the walk cannot
    read (`call screen`, no target); None for any other line."""
    keyword = line.split(" ", 1)[0].split(":", 1)[0]
    if keyword == "return" or line == "$ renpy.return_statement()":
        return FlowStep("return", source, line)
    if line.startswith("$"):
        m = _PY_FLOW_RE.match(line)
        if m is None:
            return None
        literal = m.group(2) if m.group(2) is not None else m.group(3)
        target = (literal.strip() if literal is not None
                  and _LABEL_NAME_RE.fullmatch(literal.strip()) else None)
        if target:
            return FlowStep(m.group(1), source, line,
                            full_label(target, cur_global))
        return FlowStep(m.group(1), source, line, None,
                        candidates=name_literals(line), scope=cur_global)
    if keyword not in ("jump", "call"):
        return None
    words = line[len(keyword):].strip().split()
    if not words:
        return f"{keyword} without a target"
    if words[0] == "expression":
        return FlowStep(keyword, source, line, None,
                        candidates=name_literals(line), scope=cur_global)
    if keyword == "call" and words[0] == "screen":
        return CALL_SCREEN
    m = _LABEL_NAME_RE.match(words[0])
    if m is None:
        return f"{keyword} without a target"
    return FlowStep(keyword, source, line, full_label(m.group(0), cur_global))


# A string literal, double- or single-quoted, with what precedes it (an
# `f` prefix makes it an f-string, whose text is not a name).
_LITERAL_RE = re.compile(r"""(\w?)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')""")
# A say statement or a menu choice: its quoted text is not a name.
_SAY_LINE_RE = re.compile(
    r"""(?:[A-Za-z_]\w*\s*)?(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')"""
    r"""(?:\s+with\s+\S+)?\s*$""")


def name_literals(line: str) -> list[str]:
    """The string literals on a line of code that could name a label
    (`"day_2"`, `'ch1.end'`), in order; none from a say statement, a menu
    choice or an f-string (kinetic_extract.flow's candidates for a
    computed jump or call)."""
    text = line.strip()
    if text.startswith(("\"", "'")) or _SAY_LINE_RE.fullmatch(text):
        return []
    return code_literals(text)


def code_literals(text: str) -> list[str]:
    """The label-like string literals in a piece of code (an expression,
    a function body), in order; none from an f-string."""
    out: list[str] = []
    for m in _LITERAL_RE.finditer(text):
        if m.group(1) in ("f", "F"):
            continue
        value = m.group(2) if m.group(2) is not None else m.group(3)
        if _LABEL_NAME_RE.fullmatch(value) and not value.startswith("."):
            out.append(value)
    return out


def screen_shown(line: str) -> str | None:
    """The screen a `show screen x` or `call screen x` line shows."""
    words = line.split()
    if len(words) >= 3 and words[0] in ("show", "call") \
            and words[1] == "screen":
        m = re.match(r"[A-Za-z_]\w*", words[2])
        return m.group(0) if m else None
    return None


def _screen_flow(head: str, block: list[tuple[int, str, int]],
                 relname: str, result: FileParse) -> None:
    """Record a `screen` statement's literal `Jump`/`Call` actions and
    `use`d screens (``block`` its lines)."""
    m = _SCREEN_HEAD_RE.match(head)
    if m is None:
        return
    actions: list[FlowStep] = []
    uses: list[str] = []
    for lineno, text, _indent in block:
        for act in _SCREEN_ACTION_RE.finditer(text):
            target = act.group(2) if act.group(2) is not None \
                else act.group(3)
            if _LABEL_NAME_RE.fullmatch(target.strip()):
                actions.append(FlowStep(act.group(1).lower(),
                                        f"{relname}:{lineno}", text,
                                        target.strip()))
        use = _SCREEN_USE_RE.match(text)
        if use:
            uses.append(use.group(1))
    result.screens.setdefault(m.group(1), (actions, uses))


def _block_steps(entries: list[tuple[int, str, int]], relname: str,
                 cur_global: str | None) -> list[FlowStep]:
    """The flow steps of a block the walk does not convert, in order:
    ``entries`` holds ``(lineno, text, indent)`` for its lines. An `if`
    chain, a `while` and a menu inside become ``fork`` steps (an `if` with
    no `else`, and a `while`, also go on past it); other blocks
    (`python:` and the like) are not looked into. A fork with no flow in
    any block is left out."""
    steps: list[FlowStep] = []
    k = 0
    while k < len(entries):
        lineno, text, indent = entries[k]
        j = k + 1
        while j < len(entries) and entries[j][2] > indent:
            j += 1
        src = f"{relname}:{lineno}"
        keyword = text.split(" ", 1)[0].split(":", 1)[0]
        if keyword in ("if", "while") and text.endswith(":"):
            alts = [_block_steps(entries[k + 1:j], relname, cur_global)]
            ends = keyword == "while"
            while (keyword == "if" and j < len(entries)
                   and entries[j][2] == indent
                   and entries[j][1].split(" ", 1)[0].split(":", 1)[0]
                   in ("elif", "else")):
                head = j
                j += 1
                while j < len(entries) and entries[j][2] > indent:
                    j += 1
                alts.append(_block_steps(entries[head + 1:j], relname,
                                         cur_global))
                ends = entries[head][1].startswith("else")
            if keyword == "while" or not ends:
                alts.append([])
            if any(alts):
                steps.append(FlowStep("fork", src, text, alternatives=alts))
        elif keyword == "menu" and text.endswith(":"):
            named = _NAMED_MENU_RE.match(text)
            if named:
                steps.append(FlowStep("label", src, text,
                                      full_label(named.group(1), cur_global)))
            alts = menu_alternatives(entries[k + 1:j], relname, cur_global)
            if any(alts):
                steps.append(FlowStep("fork", src, text, alternatives=alts))
        elif keyword == "label" and _LABEL_FULL_RE.match(text):
            # A label inside the block: a jump to it runs the rest of the
            # block from here, its own block first.
            name = _LABEL_FULL_RE.match(text).group(1)
            steps.append(FlowStep("label", src, text,
                                  full_label(name, cur_global)))
            steps += _block_steps(entries[k + 1:j], relname, cur_global)
        elif screen_shown(text) is not None:
            steps.append(FlowStep("screen", src, text, screen_shown(text)))
        else:
            step = flow_statement(text, src, cur_global)
            if isinstance(step, FlowStep):
                steps.append(step)
        k = j
    return steps


def menu_alternatives(block: list[tuple[int, str, int]], relname: str,
                      cur_global: str | None) -> list[list[FlowStep]]:
    """The flow steps of each choice of a menu block (its lines deeper
    than the `menu:` line), one list per choice in order."""
    if not block:
        return []
    base = min(indent for _n, _t, indent in block)
    alts: list[list[FlowStep]] = []
    k = 0
    while k < len(block):
        _lineno, text, indent = block[k]
        j = k + 1
        while j < len(block) and block[j][2] > indent:
            j += 1
        if indent == base and text.endswith(":"):
            alts.append(_block_steps(block[k + 1:j], relname, cur_global))
        k = j
    return alts


def _gather_block(raw_lines: list[str], start: int, indent: int,
                  ) -> tuple[list[tuple[int, str, int]], int]:
    """``(lineno, text, indent)`` of the non-blank lines from index
    ``start`` deeper than ``indent``, and the index after them."""
    block: list[tuple[int, str, int]] = []
    j = start
    while j < len(raw_lines):
        content = strip_comment(raw_lines[j])
        if not content.strip():
            j += 1
            continue
        depth = len(content) - len(content.lstrip(" \t"))
        if depth <= indent:
            break
        block.append((j + 1, content.strip(), depth))
        j += 1
    return block, j


def _chain_fork(raw_lines: list[str], i: int, lineno: int, line: str,
                indent: int, relname: str, cur_global: str | None,
                ) -> FlowStep | None:
    """The fork step of the `if` chain or `while` whose head (``line``,
    raw line ``lineno``) was just read, ``i`` the index after it; None
    when none of its blocks moves the walk."""
    entries = [(lineno, line, indent)]
    block, j = _gather_block(raw_lines, i, indent)
    entries += block
    while line.startswith("if") and j < len(raw_lines):
        content = strip_comment(raw_lines[j])
        if not content.strip():
            j += 1
            continue
        depth = len(content) - len(content.lstrip(" \t"))
        head = content.strip()
        if depth != indent or head.split(" ", 1)[0].split(":", 1)[0] \
                not in ("elif", "else"):
            break
        entries.append((j + 1, head, depth))
        block, j = _gather_block(raw_lines, j + 1, indent)
        entries += block
    steps = _block_steps(entries, relname, cur_global)
    return steps[0] if steps else None


def _parse_menu_body(block: list[tuple[int, str, int]], relname: str,
                     caption: str | None, creator: set[str] = frozenset()):
    """Classify the interior lines of a menu block.

    ``block`` holds ``(lineno, text, indent)`` for every non-blank line
    deeper than the ``menu:`` line, in order; ``caption`` is the caption
    taken from the ``menu "…":`` head, if any. Answers
    ``(reject reason | None, caption, choices)`` where choices is a list
    of ``(label, choice-line source, body events)``. Choice lines sit at
    the base indent; every body line must classify as an event or noise,
    so choice blocks are adjacent in file order with only skipped noise
    between them by construction."""
    base = block[0][2]
    choices: list[tuple[str, str, list[Event]]] = []
    for (lineno, text, indent) in block:
        src = f"{relname}:{lineno}"
        if indent <= base:
            if indent < base:
                return (f"unexpected indent at line {lineno}",
                        caption, choices)
            if text.startswith("\"") and text.endswith(":"):
                parsed = _parse_quoted(text, 0)
                label = parsed[0].strip() if parsed else ""
                if not label:
                    return "empty choice label", caption, choices
                choices.append((label[:LABEL_MAX], src, []))
            elif (caption is None and not choices
                  and len(text) > 1 and text.startswith("\"")
                  and text.endswith("\"")):
                parsed = _parse_quoted(text, 0)
                if parsed is None:
                    return f"unsupported line between choices: {text}", \
                        caption, choices
                caption = parsed[0]
            else:
                return (f"unsupported line between choices: {text}",
                        caption, choices)
            continue
        if not choices:
            return ("statement before the first choice", caption, choices)
        kind, payload = _classify_menu_statement(src, text, creator)
        if kind == "reject":
            return payload, caption, choices
        if kind == "event":
            choices[-1][2].append(payload)
    return None, caption, choices


def _handle_menu(raw_lines: list[str], i: int, relname: str,
                 menu_lineno: int, menu_line: str, menu_indent: int,
                 result: FileParse, cur_label: str | None,
                 cur_global: str | None = None) -> int:
    """Parse the menu block whose ``menu:`` line was just read.

    ``i`` is the index of the line after the ``menu:`` line; the answer is
    the index the outer scan resumes at. A menu passing the conservative
    rules (two or more plain quoted choices, each body parsing to events
    or noise) appends a MenuRecord plus marker events; anything else is
    reported ``menu unsupported (reason)`` and its block contributes
    nothing to the stream but a ``fork`` event when its choices jump or
    call (the walk follows those, docs/plan.md Phase 57 item 4e). Never
    fatal."""
    source = f"{relname}:{menu_lineno}"
    head_rest = menu_line[len("menu"):].strip()
    if head_rest.startswith(":"):
        head_rest = head_rest[1:].strip()
    caption = None
    if head_rest.startswith("\""):
        parsed = _parse_quoted(head_rest, 0)
        caption = parsed[0] if parsed else None

    block: list[tuple[int, str, int]] = []  # (lineno, text, indent)
    j = i
    while j < len(raw_lines):
        content = strip_comment(raw_lines[j])
        if not content.strip():
            j += 1
            continue
        indent = len(content) - len(content.lstrip(" \t"))
        if indent <= menu_indent:
            break
        block.append((j + 1, content.strip(), indent))
        j += 1

    if not block:
        reject, caption, choices = "empty menu", caption, []
    else:
        reject, caption, choices = _parse_menu_body(
            block, relname, caption, result.creator_statements)
    if reject is None and not choices:
        reject = "no choices"
    elif reject is None and len(choices) < 2:
        reject = "fewer than two choices"
    if reject:
        result.reports.append(Report(
            source, menu_line,
            f"menu unsupported ({reject}): branch skipped, linear flow kept"))
        result.reports.extend(
            Report(f"{relname}:{lineno}", text, AUDIO_IN_MENU)
            for lineno, text, _indent in block if mentions_audio(text))
        result.menus.append(MenuRecord(
            source=source, statement=menu_line,
            decision_id=f"menu-{slug(cur_label, Path(relname).stem)}"
                        f"-{menu_lineno}"[:ID_MAX],
            prompt=(caption if caption is not None else _DEFAULT_PROMPT)
                   [:PROMPT_MAX],
            prompt_defaulted=caption is None,
            choices=[label[:LABEL_MAX] for label, _src, _body in choices],
            skip_reason=reject))
        alts = menu_alternatives(block, relname, cur_global)
        if any(alts):
            result.events.append(Event(
                "fork", source, text=menu_line,
                flow=FlowStep("fork", source, menu_line, alternatives=alts)))
        return j

    record = MenuRecord(
        source=source, statement=menu_line,
        decision_id=f"menu-{slug(cur_label, Path(relname).stem)}"
                    f"-{menu_lineno}"[:ID_MAX],
        prompt=(caption if caption is not None else _DEFAULT_PROMPT)
               [:PROMPT_MAX],
        prompt_defaulted=caption is None,
        choices=[label for label, _src, _body in choices])
    menu_idx = len(result.menus)
    result.menus.append(record)
    result.events.append(Event("menu-open", source, name=str(menu_idx)))
    for k, (_label, choice_src, body) in enumerate(choices):
        result.events.append(
            Event("choice-open", choice_src, name=f"{menu_idx}:{k}"))
        for event in body:
            if event.kind == "report":
                result.reports.append(
                    Report(event.source, event.text, event.name or ""))
            else:
                result.events.append(event)
    result.events.append(
        Event("menu-close", f"{relname}:{block[-1][0]}",
              name=str(menu_idx)))
    return j


def _bracket_depth(text: str) -> int:
    """Brackets ``text`` opens and leaves open, quoted strings aside."""
    depth, quote, i = 0, "", 0
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == "\\":
                i += 1
            elif ch == quote:
                quote = ""
        elif ch in "\"'":
            quote = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        i += 1
    return depth


def _continued(raw_lines: list[str], n: int, line: str,
               limit: int = 50) -> tuple[str, int]:
    """``line`` (raw line ``n``, stripped) joined with the lines its open
    brackets run onto, as Ren'Py joins them, and the index of the line
    after the last one used (at most ``limit`` more)."""
    depth = _bracket_depth(line)
    k = n
    while depth > 0 and k + 1 < len(raw_lines) and k - n < limit:
        k += 1
        more = strip_comment(raw_lines[k]).strip()
        line += " " + more
        depth += _bracket_depth(more)
    return line, k + 1


def _call_text(raw_lines: list[str], n: int) -> str:
    """Line ``n`` joined with the lines a call written over several
    lines runs onto."""
    return _continued(raw_lines, n, strip_comment(raw_lines[n]).strip())[0]


def _whole_enough(m: re.Match[str], text: str) -> bool:
    """Whether a config setting's literal counts: always, except for a
    setting in `_WHOLE_VALUE_SETTINGS`, whose literal must end the line
    (after the `)` of a `_()` wrapper)."""
    if m.group(1) not in _WHOLE_VALUE_SETTINGS:
        return True
    rest = text[m.end():].strip()
    return rest == (")" if m.group(2) else "")


def _scan_settings(raw_lines: list[str], relname: str,
                   result: FileParse) -> None:
    """Read the settings that live in `init` and `python` blocks the
    statement walk skips, so every line is scanned, block or not: the
    story id, title and version config, the voice file format,
    `define audio.x` names and registered channels."""
    scope: str | None = None
    for n, raw in enumerate(raw_lines):
        text = strip_comment(raw)
        if "'" in text or "\"" in text:
            result.literals.update(name_literals(text))
        _scan_code(raw_lines, n, text, relname, result)
        stripped = text.strip()
        if stripped and text[:1] not in " \t":  # Ren'Py's indent
            head = _LABEL_FULL_RE.match(stripped)
            scope = (None if head is None else
                     full_label(head.group(1), scope).split(".", 1)[0])
        if stripped:
            assigned = _ASSIGN_RE.fullmatch(stripped)
            if assigned:
                # A list or table may run over many lines.
                whole = _ASSIGN_RE.fullmatch(
                    _continued(raw_lines, n, stripped, 5000)[0])
                value = (whole or assigned).group(2)
                result.assignments.append((assigned.group(1), scope, value))
                # Its continued lines (`"label": "x",`) start with a
                # quote, as a say line does, so name_literals skips them.
                result.literals.update(code_literals(value))
            for act in _SET_VARIABLE_RE.finditer(stripped):
                result.assignments.append((act.group(1), None,
                                           act.group(2)))
        m = _CONFIG_STRING_RE.match(text)
        if m and m.group(1) not in result.config and _whole_enough(m, text):
            value = m.group(3) if m.group(3) is not None else m.group(4)
            result.config[m.group(1)] = value
        defined = read_audio_define(text)
        if defined is not None:
            result.audio_defs[defined[0]] = defined[1]
        if _DEFINE_CHAR_RE.match(text.strip()):
            _read_character(_call_text(raw_lines, n), f"{relname}:{n + 1}",
                            result)
        if "register_channel(" in text:
            channel = read_channel(_call_text(raw_lines, n))
            if channel is None:
                result.reports.append(Report(
                    f"{relname}:{n + 1}", text.strip(),
                    "register_channel with arguments that are not "
                    "literals: channel not read"))
            else:
                result.channels[channel.name] = channel


def _scan_code(raw_lines: list[str], n: int, text: str, relname: str,
               result: FileParse) -> None:
    """Record a Python function's body (``def name(...):`` on line ``n``)
    as its lines joined, for kinetic_extract.flow's computed targets."""
    m = _DEF_RE.match(text.strip())
    if m is None:
        return
    indent = len(text) - len(text.lstrip(" \t"))
    block, _j = _gather_block(raw_lines, n + 1, indent)
    body = "\n".join(t for _l, t, _i in block)
    result.functions.setdefault(m.group(1), body)
    result.literals.update(code_literals(body))


def _read_character(line: str, source: str, result: FileParse) -> None:
    """Record a Character statement, in a block or not: `define`, `$` or
    an `init python` assignment (Phase 57 item 4c). A later one for the
    same variable replaces an earlier one, as running them would."""
    m = _DEFINE_CHAR_RE.match(line)
    var = m.group(1)
    result.character_defs[var] = (source, line)
    result.characters.pop(var, None)
    result.character_kinds.pop(var, None)
    named = character_name(line)
    if named is not None:
        result.characters[var] = named[1]
    else:
        kind = character_kind(line)
        if kind is not None:
            result.character_kinds[var] = kind


def _screen_event(result: FileParse, source: str, line: str) -> None:
    """A ``screen`` flow event for a `show screen`/`call screen` line."""
    name = screen_shown(line)
    if name is not None:
        result.events.append(Event("screen", source, text=line, flow=FlowStep(
            "screen", source, line, name)))


def _audio_event(result: FileParse, source: str, line: str,
                 read: AudioStatement | str | None) -> None:
    """Add an audio statement's event, or report why it is not read."""
    if isinstance(read, AudioStatement):
        result.events.append(Event("audio", source, cue=read))
    elif isinstance(read, str):
        result.reports.append(Report(source, line, read))


def creator_statement_names(text: str) -> set[str]:
    """The names a script registers with `renpy.register_statement`."""
    raw_lines = text.lstrip("\ufeff").splitlines()
    names: set[str] = set()
    for n, raw in enumerate(raw_lines):
        if "register_statement(" in raw:
            m = _REGISTER_STATEMENT_RE.search(_call_text(raw_lines, n))
            if m:
                names.add(m.group(1))
    return names


def parse_file(text: str, relname: str,
               creator_statements: set[str] = frozenset()) -> FileParse:
    """Parse one .rpy source; never raises on unknown statements.
    ``creator_statements`` are statement names other files register."""
    result = FileParse(relname=relname,
                       creator_statements=set(creator_statements))
    raw_lines = text.lstrip("\ufeff").splitlines()
    _scan_settings(raw_lines, relname, result)
    result.story_reports_from = len(result.reports)
    result.creator_statements |= creator_statement_names(text)

    skip_indent: int | None = None  # depth of the line that opened a block
    skip_opener = ""                # that line's keyword
    cur_label: str | None = None    # label whose body the walk is in
    cur_global: str | None = None   # the global label local ones belong to
    i = 0
    while i < len(raw_lines):
        raw = raw_lines[i]
        lineno = i + 1
        i += 1
        content = strip_comment(raw)
        if not content.strip():
            continue
        indent = len(content) - len(content.lstrip(" \t"))
        line = content.strip()
        source = f"{relname}:{lineno}"
        if skip_indent is not None:
            if indent > skip_indent:
                if mentions_audio(line):
                    result.reports.append(Report(
                        source, line, f"audio inside a skipped "
                        f"`{skip_opener}` block: not converted"))
                continue
            skip_indent = None
        keyword = line.split(" ", 1)[0].split(":", 1)[0]
        rest = line[len(keyword):].strip()
        if rest.startswith(":"):
            rest = rest[1:].strip()

        def open_block() -> None:
            nonlocal skip_indent, skip_opener
            if line.endswith(":"):
                skip_indent = indent
                skip_opener = keyword

        if _is_creator_statement(line, result.creator_statements):
            result.reports.append(Report(source, line, CREATOR_STATEMENT))
            open_block()
            continue

        if keyword == "define":
            if _DEFINE_CHAR_RE.match(line):
                # A Character call may run over several lines; they are
                # not statements of their own. _scan_settings read it.
                line, i = _continued(raw_lines, lineno - 1, line)
            elif _SIMPLE_DEFINE_RE.match(line):
                line, i = _continued(raw_lines, lineno - 1, line)
                m = _SIMPLE_DEFINE_RE.match(line)
                result.simple_defines[m.group(1)] = m.group(2).strip()
            # other defines: skipped silently
            continue
        if line.startswith("$"):
            # A call may run over several lines (a playlist, a
            # Character); they are not statements of their own.
            line, i = _continued(raw_lines, lineno - 1, line)
            step = flow_statement(line, source, cur_global)
            if isinstance(step, FlowStep):
                result.events.append(Event(step.kind, source, text=line,
                                           flow=step))
                continue
            _audio_event(result, source, line, read_python(line))
            continue
        if keyword == "default":
            continue
        if keyword == "with" and rest:
            result.events.append(Event("with", source, name=rest))
            continue
        if keyword == "pause":
            result.events.append(Event("interact", source))
            continue
        if keyword == "return":
            result.events.append(Event(
                "return", source, text=line,
                flow=FlowStep("return", source, line)))
            continue
        if keyword in _QUIET_STATEMENT_KEYWORDS:
            continue
        if keyword == "image":
            head, defined = _split_image_def(rest)
            if defined is None:
                result.reports.append(
                    Report(source, line, "image without a file"))
            else:
                result.image_defs[head] = defined
            # `image x:` opens an ATL block, whose quoted frames are not
            # lines of dialogue.
            open_block()
            continue
        if keyword == "scene":
            name = _name_tokens(rest)
            result.events.append(
                Event("visual", source, name=name or "black",
                      transition=with_clause(rest)))
            continue
        if keyword == "show":
            if rest.startswith("layer "):
                result.reports.append(
                    Report(source, line, "transform statement (reported, skipped)"))
                open_block()
                continue
            if rest.startswith("screen "):
                # `show screen x` shows a screen, which is not converted
                # (Phase 57 item 4d: it used to be read as image `screen
                # x` and dropped); the walk follows its Jump and Call
                # actions (kinetic_extract.flow).
                result.reports.append(Report(source, line, SHOW_SCREEN))
                _screen_event(result, source, line)
                continue
            name = _name_tokens(rest)
            if name:
                result.events.append(
                    Event("visual", source, name=name,
                          transition=with_clause(rest)))
            else:
                result.reports.append(Report(source, line, "show without an image"))
            continue
        if keyword == "hide":
            result.reports.append(
                Report(source, line, "hide skipped (visual unchanged)"))
            clause = with_clause(rest)
            if clause is not None:
                # `hide x with t` is `with None`, `hide x`, `with t`: the
                # hide changes no picture the folder shows.
                result.events.append(Event("interact", source))
                result.events.append(Event("with", source, name=clause))
            continue
        if keyword == "movie":
            quoted = _parse_quoted(rest, rest.find("\""))
            if quoted is None:
                result.reports.append(
                    Report(source, line, "movie without a file"))
            else:
                result.events.append(Event("video", source, asset=quoted[0]))
            continue
        if keyword == "stop" and rest == "movie":
            result.events.append(Event("stop-movie", source))
            continue
        if keyword in _AUDIO_KEYWORDS:
            # A playlist may run over several lines; its lines are not
            # statements of their own.
            line, i = _continued(raw_lines, lineno - 1, line)
            read = read_statement(line)
            if read is None:
                result.reports.append(
                    Report(source, line, f"unsupported statement: {line}"))
            _audio_event(result, source, line, read)
            continue
        if keyword == "menu":
            named = _NAMED_MENU_RE.match(line)
            if named:
                # `menu name:` is a label too: a jump to it shows the menu.
                result.events.append(Event(
                    "label", source, name=full_label(named.group(1),
                                                     cur_global)))
            i = _handle_menu(raw_lines, i, relname, lineno, line, indent,
                             result, cur_label, cur_global)
            continue
        if keyword == "label":
            # The label body is the linear flow itself: never skipped. The
            # event marks the position the walk goes to on a jump or call
            # to it, and starts at for `label start` or --label
            # (kinetic_extract.flow). Its name is the whole name, a local
            # label's under its global one.
            m = _LABEL_HEAD_RE.match(line)
            if m:
                cur_label = m.group(1)
            full = _LABEL_FULL_RE.match(line)
            if full:
                name = full_label(full.group(1), cur_global)
                if "." not in full.group(1):
                    cur_global = name
                result.events.append(Event("label", source, name=name))
            continue
        if keyword in {"jump", "call"}:
            step = flow_statement(line, source, cur_global)
            if isinstance(step, FlowStep):
                result.events.append(Event(keyword, source, text=line,
                                           flow=step))
            elif step is not None:
                result.reports.append(Report(source, line, step))
                _screen_event(result, source, line)
            open_block()
            continue
        if keyword == "screen":
            block, _j = _gather_block(raw_lines, i, indent)
            _screen_flow(line, block, relname, result)
        if keyword in ("if", "while") and line.endswith(":"):
            # Its blocks are skipped (and reported) as before; the jumps
            # and calls in them are followed (kinetic_extract.flow).
            fork = _chain_fork(raw_lines, i, lineno, line, indent, relname,
                               cur_global)
            if fork is not None:
                result.events.append(Event("fork", source, text=line,
                                           flow=fork))
        if keyword in _QUIET_BLOCK_KEYWORDS:
            open_block()
            continue

        # Dialogue: `Speaker "text"` or a bare `"text"` narration line.
        quoted_start = line.find("\"")
        if quoted_start == 0:
            parsed = _parse_quoted(line, 0)
            if parsed:
                result.events.append(
                    Event("dialogue", source, text=parsed[0]))
            continue
        m = _SPEAKER_SAY_RE.match(line)
        if m:
            parsed = _parse_quoted(line, quoted_start)
            if parsed:
                result.events.append(
                    Event("dialogue", source, text=parsed[0],
                          speaker=m.group(1)))
            continue

        result.reports.append(
            Report(source, line, f"unrecognized statement: {line}"))
        open_block()

    return result


def _rpyc_glob(files_glob: str | None) -> str:
    """Glob for candidate .rpyc twins of the .rpy pattern in ``files_glob``.

    Default (None) matches every .rpyc. A ``*.rpy``/``name.rpy`` pattern
    maps to the matching ``.rpyc`` so ``--files`` keeps restricting both
    kinds; any other pattern is used verbatim (a caller may target .rpyc
    directly).
    """
    if files_glob is None:
        return "*.rpyc"
    if files_glob.endswith(".rpy"):
        return files_glob[:-len(".rpy")] + ".rpyc"
    return files_glob


def _ledger_rel(path: Path, game_dir: Path) -> str:
    """The ledger location ``game/<rel>`` for a file under ``game_dir``.

    Paths come from ``game_dir`` globs, so they share their textual
    prefix with the directory itself. Resolving the file through a
    symlinked game dir — the game C case
    (docs/extracting.md BUG 4) — lands outside the project root and
    ``relative_to`` raised; the prefix is therefore taken unresolved
    first, with ``os.path.realpath`` applied to BOTH sides as the
    fallback so a real-vs-real comparison never escapes the tree.
    """
    try:
        return f"game/{path.relative_to(game_dir).as_posix()}"
    except ValueError:
        root = os.path.realpath(game_dir)
        real = os.path.realpath(path)
        if real.startswith(root + os.sep):
            return f"game/{real[len(root) + 1:]}"
        return f"game/{Path(real).name}"


def _in_tl(path: Path, game_dir: Path) -> bool:
    """Whether `path` (a glob result under `game_dir`) is under tl/."""
    try:
        return path.relative_to(game_dir).parts[:1] == ("tl",)
    except ValueError:
        return False


def _hidden(path: Path, game_dir: Path) -> bool:
    """Whether a name on `path` below `game_dir` starts with `.`: Ren'Py's
    loader (`walkdir` in renpy/loader.py) skips such files and folders."""
    try:
        parts = path.relative_to(game_dir).parts
    except ValueError:
        parts = (path.name,)
    return any(part.startswith(".") for part in parts)


@dataclass
class ScriptSource:
    """One script the walk reads: a loose file (``path``) or an archive
    member (``archive``, a kinetic_extract.rpa.RpaArchive, and its key)."""

    key: str                    # its path under game/, "x.rpy"
    rel: str                    # its ledger name, "game/x.rpy" or
                                # "game/<archive>.rpa!x.rpy"
    kind: str                   # "rpy" or "rpyc"
    path: Path | None = None
    archive: object | None = None


@dataclass
class WalkedScripts:
    """The scripts the walk reads and what was left out, for the ledger
    (parse_project's ``sources``)."""

    entries: list[ScriptSource]     # in walk order
    ignored_twins: list[dict]       # loose .rpyc skipped for a .rpy
    rpa_ignored: list[dict]         # archive members skipped
    rpa_failed: list[dict]          # archives whose index is unreadable


def walked_scripts(game_dir: Path,
                   files_glob: str | None = None) -> WalkedScripts:
    """Decide which scripts the walk reads (docs/extracting.md, "Which
    scripts are walked"); the walk and the translation identifiers both
    use this, so a script that is not walked neither shadows another nor
    feeds identifiers.

    The game's scripts, outside ``tl/`` (Ren'Py's translations, never
    story flow, whatever ``--files`` says): every loose ``.rpy`` and
    ``.rpyc`` under ``game/``, at any depth, as Ren'Py loads them (a file
    or folder whose name starts with ``.`` aside, as Ren'Py's loader
    skips it), and every script member of the ``game/*.rpa`` archives.
    One source per path: a loose file beats an archive member with the
    same key, an earlier archive (name order) a later one, and a ``.rpy``
    (loose or archived) beats the ``.rpyc`` with the same path, which may
    be stale. ``--files`` then chooses: a
    ``.rpy`` matching it and a ``.rpyc`` matching it with ``.rpy`` read
    as ``.rpyc`` (so ``*.rpy`` takes a compiled script that has no
    ``.rpy``), loose files by glob from ``game/``, archive members by
    their key or file name. Entries are in filename order (loose
    ``.rpy``, loose ``.rpyc``, then archive members in archive and key
    order, stably sorted by file name); a source left out that
    ``--files`` chose is listed with the reason."""
    from . import rpa as rpa_mod
    game_dir = Path(game_dir)

    def scripts(pattern: str) -> list[Path]:
        return [p for p in sorted(game_dir.glob(pattern))
                if p.name.endswith((".rpy", ".rpyc"))
                and not _in_tl(p, game_dir)
                and not _hidden(p, game_dir) and p.is_file()]

    def chosen(key: str) -> bool:
        """Whether ``--files`` chooses the script at this path."""
        if files_glob is None:
            return True
        pattern = files_glob if key.endswith(".rpy") \
            else _rpyc_glob(files_glob)
        return fnmatch.fnmatch(key, pattern) \
            or fnmatch.fnmatch(Path(key).name, pattern)

    def key_of(path: Path) -> str:
        return _ledger_rel(path, game_dir)[len("game/"):]

    loose: dict[str, Path] = {}
    for pattern in ["**/*.rpy", "**/*.rpyc"]:
        for path in scripts(pattern):
            loose.setdefault(key_of(path), path)
    archived: dict[str, object] = {}
    entries: list[ScriptSource] = []
    ignored_twins: list[dict] = []
    rpa_ignored: list[dict] = []
    rpa_failed: list[dict] = []
    for arc in rpa_mod.archives_in(game_dir):
        try:
            names = arc.names()
        except rpa_mod.RpaError as exc:
            rpa_failed.append({"archive": arc.path.name, "error": str(exc)})
            continue
        for key in names:
            if not rpa_mod.is_script(key):
                continue
            if key not in loose and key not in archived:
                archived[key] = arc
            elif chosen(key):
                rpa_ignored.append({
                    "member": key, "archive": _ledger_rel(arc.path, game_dir),
                    "reason": ("loose file with the same key" if key in loose
                               else "an earlier archive has the same key")})

    def rpy_twin(key: str) -> str | None:
        """The ledger name of the .rpy that beats a .rpyc, if any."""
        twin = key[:-1]
        if twin in loose:
            return _ledger_rel(loose[twin], game_dir)
        if twin in archived:
            return f"{_ledger_rel(archived[twin].path, game_dir)}!{twin}"
        return None

    # Loose files in glob order: the order the walk has always had for
    # files with the same name in different folders.
    for pattern, kind in ((files_glob or "**/*.rpy", "rpy"),
                          (_rpyc_glob(files_glob) if files_glob
                           else "**/*.rpyc", "rpyc")):
        for path in scripts(pattern):
            key = key_of(path)
            if not key.endswith(f".{kind}"):
                continue
            kept = rpy_twin(key) if kind == "rpyc" else None
            if kept is not None:
                ignored_twins.append({"rpyc": f"game/{key}", "kept": kept})
            else:
                entries.append(ScriptSource(key, f"game/{key}", kind, path))
    for key, arc in archived.items():   # archive order, then key order
        if not chosen(key):
            continue
        kind = "rpy" if key.endswith(".rpy") else "rpyc"
        where = _ledger_rel(arc.path, game_dir)
        kept = rpy_twin(key) if kind == "rpyc" else None
        if kept is not None:
            rpa_ignored.append({"member": key, "archive": where,
                                "reason": "a .rpy with the same path",
                                "kept": kept})
        else:
            entries.append(ScriptSource(key, f"{where}!{key}", kind,
                                        archive=arc))
    entries.sort(key=lambda e: Path(e.key).name)
    return WalkedScripts(entries, ignored_twins, rpa_ignored, rpa_failed)


def parse_project(game_dir: Path, files_glob: str | None = None,
                  cache_dir: Path | None = None,
                  ) -> tuple[list[tuple[str, FileParse]],
                             dict[str, str], dict[str, str], dict]:
    """Parse the project's script sources in filename order.

    The scripts are those walked_scripts chooses. ``.rpy`` sources are
    read directly; a ``.rpyc`` (a compiled-only script) is decompiled in
    memory through the vendored unrpyc and parsed from that text (nothing
    is written into the corpus; the text is cached — see
    kinetic_extract.rpyc); an archive member is read from its archive, a
    ``.rpyc`` member after being extracted to the shared cache dir, and
    the ledger names it ``game/<archive>!<key>``.

    ``files_glob`` restricts which files feed the walk (relative to
    ``game/``, filename order; default every loose ``.rpy``, every
    archived one, and each ``.rpyc`` without a ``.rpy``).

    Returns ``(parses, image_defs, characters, sources)`` where ``parses``
    is the per-file parse list (the decompiled entries carry a
    ``.rpyc``-suffixed ``relname``) and ``sources`` records provenance for
    the ledger: ``decompiled`` (``.rpyc`` parsed via unrpyc),
    ``ignoredTwins`` (loose ``.rpyc`` skipped because a ``.rpy`` won),
    ``failed`` (``.rpyc`` that could not be decompiled), ``rpaScripts``
    (script members read from ``.rpa`` archives), ``rpaIgnoredTwins``
    (archive members skipped, with the reason: the key exists loose or in
    an earlier archive, or a ``.rpy`` has the same path), and
    ``rpaFailed`` (archives whose index could not be read). The story
    walk does not follow this order: kinetic_extract.flow reads the
    parses from `label start` (file-name order only without one).
    """
    from . import rpa as rpa_mod
    walked = walked_scripts(game_dir, files_glob)
    sources: dict = {"decompiled": [], "ignoredTwins": walked.ignored_twins,
                     "failed": [], "rpaScripts": [],
                     "rpaIgnoredTwins": walked.rpa_ignored,
                     "rpaFailed": walked.rpa_failed}
    texts: list[tuple[str, str]] = []
    for entry in walked.entries:
        path, kind, arc, member, rel = (entry.path, entry.kind,
                                        entry.archive, entry.key, entry.rel)
        if kind == "rpy":
            if path is not None:
                text = path.read_text(encoding="utf-8-sig")
            else:
                try:
                    text = arc.open(member).decode("utf-8-sig")
                except rpa_mod.RpaError as exc:
                    sources["failed"].append(
                        {"source": rel, "error": str(exc)})
                    continue
                sources["rpaScripts"].append(rel)
        else:
            from . import rpyc as rpyc_mod
            try:
                if path is not None:
                    text = rpyc_mod.decompile_text(path, cache_dir)
                else:
                    extracted = rpa_mod.extract_cached(arc, member)
                    text = rpyc_mod.decompile_text(extracted, cache_dir)
            except (rpyc_mod.RpycError, rpa_mod.RpaError) as exc:
                sources["failed"].append(
                    {"source": rel, "error": str(exc)})
                continue
            sources["decompiled"].append(rel)
            if path is None:
                sources["rpaScripts"].append(rel)
        texts.append((rel, text))
    # A statement is often registered in another file than its uses.
    creator = set().union(*(creator_statement_names(t) for _r, t in texts))
    parses: list[tuple[str, FileParse]] = []
    image_defs: dict[str, str] = {}
    characters: dict[str, str] = {}
    kinds: dict[str, str] = {}
    for rel, text in texts:
        parsed = parse_file(text, rel, creator)
        parses.append((rel, parsed))
        image_defs.update(parsed.image_defs)
        for var in parsed.character_defs:
            characters.pop(var, None)
            kinds.pop(var, None)
        characters.update(parsed.characters)
        kinds.update(parsed.character_kinds)
    characters.update(kind_names(characters, kinds))
    return parses, image_defs, characters, sources


def kind_names(characters: dict[str, str],
               kinds: dict[str, str]) -> dict[str, str]:
    """var -> display name for each Character with no name argument,
    taken from its `kind=` as Ren'Py does, through a chain of kinds;
    a kind with no name the converter knows gives none."""
    out: dict[str, str] = {}
    for var in kinds:
        seen, kind = {var}, kinds[var]
        while kind in kinds and kind not in characters and kind not in seen:
            seen.add(kind)
            kind = kinds[kind]
        if kind in characters:
            out[var] = characters[kind]
    return out
