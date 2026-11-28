"""Statement-subset parser for Ren'Py ``.rpy`` sources.

A line/indent based scanner over UTF-8 text (BOM tolerated). It recognizes
the statement subset in docs/stack.md §Converter decisions at label flow and
turns the script into a linear stream of events for the timeline builder.
Everything it does not recognize is reported (never fatal) so the build
ledger can list what was skipped.

Design notes:

- Comments are stripped outside quoted strings. The lines are Ren'Py's
  logical lines (renpy_lexer.story_lines, docs/plan.md Phase 60 item
  9m): a line runs on while a string or bracket is open, each at the
  index of its first physical line, the lines it runs onto blank.
- Say statements follow Ren'Py's grammar (renpy_lexer.parse_say): a
  lone string, or a speaker (a name, a dotted name or a string), image
  attributes and `@` temporary ones, then a string; each becomes a
  ``dialogue`` event carrying them, a triple-quoted string one per
  paragraph.
- A line ending in ":" opens a block: all following lines indented deeper
  than the opening line belong to it. ``label`` blocks continue the linear
  walk; blocks other than ``label`` and ``menu`` are skipped.
- ``menu`` is parsed structurally (docs/plan.md Phase 13; Phase 60 item
  4): the caption and the ``"label":`` choices are captured into a
  ``MenuRecord``, and each choice block is read as label flow into its
  own event list (its lines, audio, nested menus, `$` lines and the
  `jump`, `call` or `return` it ends in), carried by a ``fork`` event
  tagged with the record; kinetic_extract.flow walks each choice's path
  and lays it out between menu marker events, so the timeline can lay a
  branch decision over the items. The block's base lines are read as
  Ren'Py's parse_menu reads them (Phase 60 item 9o, _menu_line): choices
  in any quote, with arguments and an `if` test (each choice's test kept
  for kinetic_extract.conditions to word), a caption or say menuitem as
  the prompt, `set`, `with`, `$`, `pass` and later captions passed over;
  a `label` in a choice block is read as label flow. A menu whose shape
  the parser does not take (another line between choices, a statement
  before the first choice, an empty choice label, a lone conditional
  choice) is walked all the same, its ``parse_reason`` set, so its
  choices' lines are kept in a row and the timeline reports it; one
  with no choice at all is reported ``menu unsupported (...)`` and its
  block skipped, its jumps and calls followed — never fatal. A menu
  with one plain choice is no decision
  (Phase 60 item 3): its caption, if any, and its choice text become
  narration lines where the menu stood, and the choice block is read in
  place as label flow.
- An ``if``/``elif``/``else`` chain whose tests all read one variable
  the script sets (docs/plan.md Phase 60 item 6; kinetic_extract.
  conditions.read_chain, judged by every assignment of the project:
  _scan_assignments) is read as a menu is: a MenuRecord with its
  ``condition`` and a ``fork`` event whose ``bodies`` hold each arm read
  as label flow, an absent ``else`` an empty arm. Any other chain is
  reported, ``if chain not converted (why)``.
- ``jump``, ``call`` and ``return`` become flow events (``Event.flow``, a
  ``FlowStep``), and so do the jumps and calls inside an ``if`` chain
  that is not read, a ``while`` or a menu that is no decision (a
  ``fork`` event, one alternative per block). kinetic_extract.flow
  follows them from ``label start`` (docs/plan.md Phase 57 item 4e);
  the blocks' other statements are skipped as before.
- Audio statements (``play``, ``queue``, ``stop``, ``voice`` and literal
  ``$ renpy.music``/``renpy.sound`` calls, docs/plan.md Phase 47 item 8)
  become ``audio`` events, in label flow and in choice blocks alike;
  kinetic_extract.audio_statements reads them. Audio the walk cannot
  convert is reported: inside a skipped block (a screen, a transform,
  Python, an ``if`` chain that is not read), inside an unsupported menu,
  or in a form that is not read. ``define audio.x``, ``register_channel`` and
  ``register_statement`` are read on every line, blocks included.
- A ``with`` clause on ``scene``/``show`` rides on its visual event; a
  bare ``with`` (and a ``hide``'s clause) is a ``with`` event and a
  ``pause`` an ``interact`` event, so the timeline can give the item a
  ``transition`` (kinetic_extract.presentation reads the expression,
  the Character defines' colours and the ``define``d aliases kept in
  ``character_defs`` and ``simple_defines``).
"""

from __future__ import annotations

import ast
import fnmatch
import os
import re
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from . import conditions
from .audio_statements import (AudioChannel, AudioStatement, mentions_audio,
                               read_audio_define, read_channel, read_python,
                               read_statement)
from .renpy_lexer import (STATEMENT_WORDS, _Cursor, _parse_quoted,
                          item_text, parse_say, renpy_newlines, say_texts,
                          story_lines)

# A Character made by `define e = Character(...)` (with or without an
# init priority, `define -2 e = ...`), by `$ e = Character(...)`, or by
# `e = Character(...)` in an `init python` block; `DynamicCharacter`,
# `ADVCharacter` and `NVLCharacter` too. The display name is read from
# the arguments by character_name. The variable may be dotted, a store
# namespace's (`define c.ann = Character(...)`, docs/plan.md Phase 60
# item 9m); `store.` names the main store (define_var).
_DEFINE_CHAR_RE = re.compile(
    r"(?:define\s+(?:[+-]?\d+\s+)?|\$\s*)?"
    r"([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*=\s*"
    r"(Character|DynamicCharacter|ADVCharacter|NVLCharacter)\s*\(")
# A name argument the converter can read: a string literal, plain or
# wrapped in Ren'Py's translation markers `_()` or `__()`.
_NAME_ARG_RE = re.compile(
    r"""(?:(__?)\s*\(\s*)?("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')"""
    r"""\s*(\))?""", re.DOTALL)
_KEYWORD_ARG_RE = re.compile(r"([A-Za-z_]\w*)\s*=(?!=)\s*(.*)", re.DOTALL)
_DOTTED_NAME_RE = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*")
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
# A say line the say grammar (renpy_lexer.parse_say) does not take, read
# as before: a narration line whose quoted text comes first, or any
# identifier at the line head followed by a quoted string. The space
# between them is optional: the corpus writes both `al "..."` and
# `al"..."` (docs/extracting.md BUG 3), and the keywords the walker knows
# (`image`, `scene`, ...) are matched before this runs, so the looser form
# cannot capture them.
_SPEAKER_SAY_RE = re.compile(r"([A-Za-z_]\w*)\s*\"")
# A speaker written as a string literal, `"Ann" "Hello."`.
_QUOTED_WHO_RE = re.compile(r"[rRuU]?[\"'`]")
# The first word of a statement, which says which statement it is
# (Ren'Py matches a keyword, so `if(x):` is an `if`).
_STATEMENT_WORD_RE = re.compile(r"\$|[^\W\d]\w*")
# A `from` clause alone on its line, after its `call` (_join_from_clauses).
_FROM_CLAUSE_RE = re.compile(r"from\s+[A-Za-z_][\w.]*")
# `init python in NAME:`, whose assignments set the store NAME's variables.
_PY_IN_RE = re.compile(r"init(?:\s+[+-]?\d+)?\s+python\b.*\bin\s+"
                       r"([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*:")
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
# The assignments a condition's variable is read from (_scan_assignments):
# `$ x = ...` and its operators, `default`/`define x = ...`, a Python
# block's `x = ...`, a screen's SetVariable or ToggleVariable.
_SET_OPS = r"(\+=|-=|\*\*=|//=|[*/%&|^@]=|<<=|>>=|=)(?!=)"
_DOLLAR_SET_RE = re.compile(
    r"\$\s*(?:(?:renpy\.)?store\.)?([A-Za-z_]\w*)\s*" + _SET_OPS
    + r"\s*(.*)")
_STORE_DECL_RE = re.compile(
    r"(default|define)\s+(?:[+-]?\d+\s+)?((?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*)"
    r"\s*(\+=|\|=|=)(?!=)\s*(.*)")
_PY_SET_RE = re.compile(r"(?:store\.)?([A-Za-z_]\w*)\s*" + _SET_OPS)
_PY_BLOCK_RE = re.compile(r"(?:init\s+(?:[+-]?\d+\s+)?)?python\b[^:]*:")
_INIT_BLOCK_RE = re.compile(r"init(?:\s+[+-]?\d+)?\s*:")
_ACTION_SET_RE = re.compile(
    r"""\b(?:(?:SetVariable|ToggleVariable|VariableInputValue)\(|"""
    r"""(?:SetField|ToggleField|FieldInputValue)\(\s*store\s*,)"""
    r"""\s*["']([A-Za-z_]\w*)["']""")
# Item 9k's places that set a variable the converter does not read: a
# label's parameters, a call's keyword arguments, a `while` test's names
# and Python's `for` targets (loop variables), `$ a, b = ...`, and
# `setattr(store, "x", ...)`.
_LABEL_PARAMS_RE = re.compile(
    r"label\s+(" + _LABEL_NAME_RE.pattern + r")\s*\((.*)\)\s*(?:hide\s*)?:")
_CALL_ARGS_RE = re.compile(
    r"call\s+(" + _LABEL_NAME_RE.pattern + r")\s*\((.*)\)"
    r"(?:\s+from\s+\S+)?")
_WHILE_RE = re.compile(r"while\s+(.+):")
_FLOW_SITE_RE = re.compile(
    r"(call|jump)\s+(" + _LABEL_NAME_RE.pattern + r")\s*(?:\((.*)\))?"
    r"(?:\s+from\s+\S+)?")
_FOR_RE = re.compile(r"(?:async\s+)?for\s+(.+?)\s+in\s")
_UNPACK_RE = re.compile(
    r"\$\s*\(?\s*((?:(?:renpy\.)?store\.)?[A-Za-z_]\w*\s*"
    r"(?:,\s*(?:(?:renpy\.)?store\.)?[A-Za-z_]\w*\s*)+),?\s*\)?\s*=(?!=)")
_SETATTR_RE = re.compile(
    r"""\bsetattr\(\s*(?:renpy\.)?store\s*,\s*["']([A-Za-z_]\w*)["']""")
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

# docs/content-format.md caps enforced by the validator.
PROMPT_MAX = 199       # prompt "shorter than 200 characters"
LABEL_MAX = 119        # route label "shorter than 120 characters"
ID_MAX = 64            # docs/content-schema.json $defs/id pattern

_DEFAULT_PROMPT = "What happens next?"



_SLUG_BAD_RE = re.compile(r"[^A-Za-z0-9_-]+")


def slug(text: str | None, fallback: str, lead: bool = False) -> str:
    """Id-safe slug of a name: non-[A-Za-z0-9_-] runs become `-` (the
    item-id scheme of kinetic_extract.timeline, reused for branch ids).
    ``lead``: the slug starts an id (a route's, an item's), which must
    start with a letter or digit, so a leading `_` goes too (docs/plan.md
    Phase 60 item 9o2e); a slug after a prefix keeps it, as before."""
    raw = _SLUG_BAD_RE.sub("-", (text or "").strip()).strip("-")
    if lead:
        raw = raw.lstrip("_-")
    return raw[:60] if raw else fallback



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


# A whole string literal, double- or single-quoted.
_STRING_RE = re.compile(r""""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'""")


def string_at(text: str, pos: int = 0) -> tuple[str, int] | None:
    """The double- or single-quoted string literal at ``text[pos]``:
    (its text, the index after it), else None (docs/plan.md Phase 60
    item 9n2: an ATL frame may be either)."""
    if text[pos:pos + 1] == "'":
        m = _STRING_RE.match(text, pos)
        value = _literal_value(m.group(0)) if m is not None else None
        return (value, m.end()) if m is not None and value is not None \
            else None
    return _parse_quoted(text, pos)


def string_literal(text: str) -> str | None:
    """``text``'s value when it is one string literal, either quote, and
    nothing else, else None."""
    m = _STRING_RE.fullmatch(text.strip())
    return _literal_value(m.group(0)) if m is not None else None


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
    return define_var(m), value


def define_var(m: re.Match[str]) -> str:
    """The variable a Character statement (_DEFINE_CHAR_RE) sets, as a
    say statement names it: `store.e` is `e`."""
    var = m.group(1)
    return var[len("store."):] if var.startswith("store.") else var


def character_image(line: str) -> str | None:
    """The image tag a Character statement gives with a literal `image=`
    (the tag its say statements' image attributes change, Ren'Py's
    ``image_tag``), or None."""
    m = _DEFINE_CHAR_RE.match(line)
    args = _call_arguments(line, m.end()) if m else None
    for arg in args or []:
        kw = _KEYWORD_ARG_RE.fullmatch(arg)
        if kw is not None and kw.group(1) == "image":
            tag = _literal_value(kw.group(2).strip()) \
                if kw.group(2).strip()[:1] in "\"'" else None
            return tag.strip() or None if tag is not None else None
    return None


def parser_lines(text: str) -> list[str]:
    """A script's lines as the statement walk reads them
    (renpy_lexer.story_lines: each logical line at its first physical
    line's index), with a `call`'s `from` clause written alone on the
    next line joined onto the call (_join_from_clauses)."""
    lines = story_lines(text)
    _join_from_clauses(lines)
    return lines


def _join_from_clauses(lines: list[str]) -> None:
    """Join each `from NAME` line onto the `call` before it, in place. A
    `call x()` with its `from` clause alone on the next line is one
    statement, as the game's compiled script has it (Ren'Py itself
    refuses the indentation; docs/plan.md Phase 60 item 9m)."""
    prev = None
    for k, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        if (prev is not None and _FROM_CLAUSE_RE.fullmatch(stripped)
                and lines[prev].strip().startswith("call ")
                and " from " not in lines[prev]):
            lines[prev] = lines[prev].rstrip() + " " + stripped
            lines[k] = ""
            continue
        prev = k


def say_key(source: str, paragraph: int = 0) -> str:
    """The name of one say statement Ren'Py makes of a line: its source
    ("game/<rel>:LINE"), with `#k` added for paragraph k > 0 of a
    triple-quoted (monologue) string, whose paragraphs share the line
    (Event.paragraph). Item records' text parts and translation groups
    are matched by it."""
    return f"{source}#{paragraph}" if paragraph else source


def statement_word(line: str) -> str:
    """The keyword a stripped statement line starts with (`if(x):` is
    `if`), else its first space- or colon-separated part."""
    m = _STATEMENT_WORD_RE.match(line)
    return m.group(0) if m else line.split(" ", 1)[0].split(":", 1)[0]


def script_lines(text: str) -> list[str]:
    """A script's physical lines as Ren'Py numbers them (line ``n`` at
    index ``n - 1``), split at ``\\n``, ``\\r`` and ``\\r\\n`` only."""
    lines = renpy_newlines(text).split("\n")
    if lines[-1] == "":
        lines.pop()
    return lines


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
    ``alternatives`` (an empty one goes on after the fork). A menu that
    becomes a decision (docs/plan.md Phase 60 item 4) is a fork with
    ``menu`` its index in ``FileParse.menus`` and ``bodies`` each choice
    block's own events, story and flow alike, in place of
    ``alternatives``."""

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
    menu: int | None = None
    bodies: list[list["Event"]] = field(default_factory=list)
    # A chain on its label's parameter that every call gives a literal
    # (docs/plan.md Phase 60 item 9k): the ChainCondition whose arm the
    # walk takes at each call (``bodies`` the arms), no decision.
    pick: Any = None


@dataclass
class Event:
    """A recognized statement in linear flow order.

    A menu that becomes a decision is a ``fork`` event (``flow.menu``,
    ``flow.bodies``); kinetic_extract.flow lays it out for the timeline
    as marker events: ``menu-open`` (name is the menu's index in
    ``FileParse.menus``), ``choice-open`` (name is ``"<menu index>:<choice
    index>"``), and ``menu-close`` (name is the menu index again,
    ``outcome`` how each choice's path ended). What a choice's path reads
    sits between its ``choice-open`` and the next boundary, so the
    timeline can attribute items to route spans by position; the walk
    adds ``choice-text`` (a choice with nothing of its own, its text a
    line when the menu is a decision; before a menu nested in a choice's
    path, that choice's text, a ``route-lead`` when the nested menu is a
    decision) and ``path-end`` (the join's path ended before any story
    event) markers."""

    kind: str            # visual | video | dialogue | stop-movie | label |
                         # menu-open | choice-open | menu-close | audio |
                         # with (a bare `with`) | interact (a `pause`, or
                         # the implicit `with None` of a hide's clause) |
                         # jump | call | return | fork (``flow`` set) |
                         # set (a `$ x = ...` line of label flow, ``name``
                         # the variable; only kinetic_extract.flow's
                         # Resets reads it)
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
    # A dialogue event made from a one-choice menu's choice or caption
    # text, which Ren'Py translates in the language's `strings` block
    # (old/new), not in a dialogue block (kinetic_extract.translations).
    from_strings: bool = False
    # A `menu-close` marker's account of the walk (kinetic_extract.flow):
    # each choice's result and how it was proven, the join, or why the
    # menu stays linear.
    outcome: dict[str, Any] | None = None
    # A condition arm's label in parentheses (a `choice-text` marker of a
    # chain, docs/plan.md Phase 60 item 6): the arm's index, whose words
    # each language file gets in its own language.
    arm: int | None = None
    # A line in the converter's words (docs/plan.md Phase 60 item 9o: the
    # line before a menu that follows a decision's join), its key in
    # conditions.Words, which each language file says in its language.
    phrase: str | None = None
    # A say statement's image attributes, `-` ones removing, and its
    # temporary ones after `@` (docs/plan.md Phase 60 item 9m), which the
    # timeline applies to the speaker's picture.
    attributes: tuple[str, ...] = ()
    temporary: tuple[str, ...] = ()
    # The speaker is a name as written (`"Ann" "Hello."`), not a
    # Character's variable.
    speaker_named: bool = False
    # The paragraph of a triple-quoted (monologue) say string the line is,
    # from 0: Ren'Py makes a say statement, with its own translation, of
    # each (docs/plan.md Phase 60 item 9m2; say_key).
    paragraph: int = 0
    # A visual event of a `scene`, which clears the layer, so a name's
    # attributes choose with none kept from a picture shown before it
    # (docs/plan.md Phase 60 item 9n2); False for a `show`.
    scene: bool = False
    # A `scene` that names no image (`scene`, `scene with fade`), which
    # clears the layer to black whatever the game's own `image black` is
    # (docs/plan.md Phase 60 item 9n5); its name is still `black`.
    bare: bool = False
    # The ATL block of a `scene x:` or `show x:`, ``(lineno, text,
    # indent)`` per line (item 9n5 reads a solid colour's `alpha` in it).
    atl: list[tuple[int, str, int]] | None = None


@dataclass
class MenuRecord:
    """One ``menu:`` block parsed structurally, for branch detection.

    The parser fills the decision shape (id, prompt, choice labels and
    their lines) and rejects menus that fail the syntactic rules by
    setting ``skip_reason``; the walk and the timeline reject what they
    can only see after the walk (a choice's path rejoining content read
    elsewhere, every choice empty, no item before the menu); the CLI
    withdraws a candidate whose items the asset pass dropped. A record
    with ``skip_reason is None`` after the CLI pass became a manifest
    decision."""

    source: str            # "game/script.rpy:38"
    statement: str         # the `menu:` line text
    decision_id: str       # "menu-<label slug>-<line>", unique-checked
    prompt: str
    prompt_defaulted: bool  # no caption in the source; prompt synthesized
    choices: list[str] = field(default_factory=list)
    # Each choice's line ("game/script.rpy:39"), whose text a choice with
    # no item of its own becomes.
    choice_sources: list[str] = field(default_factory=list)
    # Per choice, the `$ x = ...`, `+=` and `-=` lines written directly in
    # its block, ``(variable, operator, expression)`` (Phase 60 item 6
    # reads them); the walk treats them as noise.
    assignments: list[list[tuple[str, str, str]]] = field(
        default_factory=list)
    # Per choice, the source of each of those lines.
    assignment_sources: list[list[str]] = field(default_factory=list)
    skip_reason: str | None = None
    # Why the parser keeps the menu linear (a line it does not take, a
    # lone conditional choice): its choices are still walked, their lines
    # kept in a row, and the timeline reports it (docs/plan.md Phase 60
    # item 9o).
    parse_reason: str | None = None
    # Per choice, its test (`"x" if cond:`), None for a plain choice
    # (item 9o); kinetic_extract.conditions words each one, and the
    # route's label is the choice's text with those words.
    choice_tests: list[str | None] = field(default_factory=list)
    # Per choice, its condition's phrase (conditions.choice_phrase), None
    # for a plain choice, and its route label in the base language.
    choice_phrases: list[Any] = field(default_factory=list)
    route_labels: list[str] = field(default_factory=list)
    # Whether the caption is a string (translated in `strings`), not a
    # say menuitem (`e "Which?"`, a say statement of its own).
    caption_strings: bool = True
    caption_source: str = ""
    # The base-indent lines passed over (`set`, `with`, `$`, `pass`, a
    # caption among the choices), ``(source, text)`` each.
    passed: list[tuple[str, str]] = field(default_factory=list)
    # A menu every choice of which reads nothing and meets the others at
    # the join (a stat choice): a decision whose routes are its choice
    # lines (item 9o; kinetic_extract.flow sets it).
    stat_choice: bool = False
    # The line before the menu when it follows another decision's join
    # with no line between (item 9o): its caption, or the converter's
    # words (``lead_phrase``, conditions.Words) in the base language.
    lead_text: str | None = None
    lead_phrase: str | None = None
    lead_used: bool = False
    # Why that line is there: ``join``, the menu follows a join (item
    # 9o); or the menu (or chain: the converter's words) would otherwise
    # hang off a shared span's last item (``span``, item 9o2), follows a
    # join past a `return` or an `if` that shows nothing (``return``), or
    # would hang off another decision's last route (``region``, item
    # 9o2b).
    lead_kind: str = "join"
    # Whether kinetic_extract.conditions.prepare has worded it (once),
    # in which base language and with which `--condition-names` words.
    worded: bool = False
    words_base: str = "en"
    words_names: dict[str, Any] = field(default_factory=dict)
    # An `if` chain read as a fork (docs/plan.md Phase 60 item 6): its
    # arms are the "choices", ``choices`` their labels once
    # kinetic_extract.conditions.prepare has worded them.
    condition: conditions.ChainCondition | None = None

    def line_of(self, k: int) -> tuple[str, bool]:
        """The line choice ``k`` with no item of its own becomes, and
        whether Ren'Py translates it in a `strings` block: its text, or a
        condition arm's label in parentheses (generated words)."""
        if self.condition is not None and k < len(self.condition.asides):
            return self.condition.asides[k], False
        return self.choices[k], True

    def label_of(self, k: int) -> str:
        """Choice ``k``'s route label: its text, with its condition in
        words for a conditional choice (item 9o)."""
        if k < len(self.route_labels) and self.route_labels[k]:
            return self.route_labels[k]
        return self.choices[k]



@dataclass
class FileParse:
    """Result of parsing one .rpy file."""

    relname: str
    events: list[Event] = field(default_factory=list)
    # Structural menu records, indexed by the number carried in this
    # file's menu marker events (docs/plan.md Phase 13).
    menus: list[MenuRecord] = field(default_factory=list)
    # name -> ("file", quoted path) | ("expr", verbatim non-quoted value,
    # e.g. `Movie(play="x.webm")` — kinetic_extract.timeline classifies it)
    # | ("atl", AtlImage), an `image name:` block read as a frame list,
    # | ("atl-other", AtlOther), any other `image name:` block.
    image_defs: dict[str, tuple[str, Any]] = field(default_factory=dict)
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
    # This file's assignments as an `if` chain's variable is read from
    # (_scan_assignments), and the project's by variable, which the chain
    # reader judges a condition by (parse_project gathers them).
    assignment_scan: list[conditions.Assignment] = field(
        default_factory=list)
    known_variables: dict[str, list[conditions.Assignment]] = field(
        default_factory=dict)
    # Item 9k: each label's parameters (full name -> conditions.Param,
    # in order) and each `call` or `jump` of a literal label, ``(label,
    # its argument list or None, source)`` (_scan_labels).
    label_params: dict[str, list[conditions.Param]] = field(
        default_factory=dict)
    call_sites: list[tuple[str, str | None, str]] = field(
        default_factory=list)
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


# The clauses that end a scene/show statement's image name, as Ren'Py's
# parser reads them (docs/plan.md Phase 60 item 9n: `behind`, `onlayer`,
# `zorder` and `as` were read as part of the name).
_SHOW_CLAUSES = frozenset({"at", "as", "behind", "onlayer", "zorder",
                           "with"})


def _name_tokens(rest: str) -> str:
    """Image-name tokens of a scene/show statement, up to its first clause
    (`at`, `with`, `as`, `behind`, `onlayer`, `zorder`) or the `:` of an
    ATL block (`show x:` names `x`)."""
    parts: list[str] = []
    for tok in rest.split():
        if tok in _SHOW_CLAUSES or tok == ":":
            break
        if tok.endswith(":"):
            parts.append(tok[:-1])
            break
        parts.append(tok)
    return " ".join(p for p in parts if p)


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


def _visual_event(source: str, rest: str, default: str | None) -> Event:
    """The visual event of a scene/show statement's ``rest``: its image
    name (``default`` when it names none), or for `expression "file"` (a
    literal string, which Ren'Py reads as a displayable) the string as
    the event's ``asset``; its `with` clause's expression."""
    transition = with_clause(rest)
    if rest.startswith("expression "):
        tail = rest[len("expression "):].lstrip()
        quoted = _parse_quoted(tail, 0)
        after = tail[quoted[1]:].split() if quoted is not None else ["+"]
        if quoted is not None and quoted[0] and (
                not after or after[0] in _SHOW_CLAUSES
                or after[0].startswith(":")):
            return Event("visual", source, name=quoted[0], asset=quoted[0],
                         transition=transition)
    return Event("visual", source, name=_name_tokens(rest) or default,
                 transition=transition)


@dataclass
class AtlOther:
    """An `image name:` ATL block that is not a frame list (docs/plan.md
    Phase 60 item 9n): the strings it shows, in order (each line or
    comma-joined clause that starts with a quoted string, at any depth),
    of which a `scene`/`show` shows the first that resolves; with none,
    the visual stays as it was."""

    source: str
    refs: list[str]


def _atl_refs(block: list[tuple[int, str, int]]) -> list[str]:
    """The quoted strings an ATL block's statements start with."""
    refs: list[str] = []
    for _lineno, text, _depth in block:
        for clause in _call_arguments(text + ")", 0) or [text]:
            parsed = string_at(clause)
            if parsed is not None and parsed[0]:
                refs.append(parsed[0])
    return refs


def _image_statement(raw_lines: list[str], i: int, line: str, rest: str,
                     indent: int, relname: str, source: str,
                     result: FileParse) -> tuple[int, bool]:
    """Read an `image` statement (``line``, ``rest`` after the keyword,
    ``i`` the index after it) into ``result.image_defs``; the index after
    it, past an ATL block read with it, and whether it opens a block the
    caller skips."""
    head, defined = _split_image_def(rest)
    if defined is None and rest.endswith(":"):
        # `image name:` opens an ATL block: a frame list is an
        # animation (docs/plan.md Phase 60 item 8), other ATL is
        # reported with the statement named, and shows its first
        # picture (item 9n).
        head = _name_tokens(rest[:-1])
        block, i = _gather_block(raw_lines, i, indent)
        image, notes = read_atl_image(block, relname, source)
        for note in notes:
            note.statement = note.statement or line
        result.reports.extend(notes)
        if image is not None:
            result.image_defs[head] = ("atl", image)
        elif head:
            result.image_defs[head] = ("atl-other",
                                       AtlOther(source, _atl_refs(block)))
        return i, False
    if defined is None:
        result.reports.append(Report(source, line, "image without a file"))
    else:
        result.image_defs[head] = defined
    return i, True


@dataclass
class AtlFrame:
    """One frame of an ATL frame list: the quoted string (a file when it
    has a dot, as Ren'Py's ``renpy.easy.displayable`` reads it, else an
    image name resolved as `show` resolves one) and how long it shows."""

    ref: str
    seconds: float
    source: str

    @property
    def is_file(self) -> bool:
        return "." in self.ref


@dataclass
class AtlImage:
    """An `image name:` ATL block read as a frame list (docs/plan.md
    Phase 60 item 8): an animation, or one frame shown as a still
    (``still``). ``loop_count`` and ``hold`` come from its `repeat`: a
    bare `repeat` loops (1, False), `repeat N` is (N, True), none (1,
    True)."""

    source: str
    frames: list[AtlFrame]
    loop_count: int = 1
    hold: bool = True
    still: bool = False

    def timing(self) -> dict[str, Any]:
        """The animation item's timing fields (docs/content-format.md,
        Items): `fps` alone when every frame shows as long, else
        `frameSeconds` with `fps` their average; `loopCount`;
        `holdLastFrame` when it holds."""
        seconds = [f.seconds for f in self.frames]
        out: dict[str, Any] = {"fps": len(seconds) / sum(seconds)}
        if len(set(seconds)) == 1:
            out["fps"] = 1 / seconds[0]
        else:
            out["frameSeconds"] = seconds
        out["loopCount"] = self.loop_count
        if self.hold:
            out["holdLastFrame"] = True
        return out


_ATL_NUMBER_RE = re.compile(r"(?:\d+(?:\.\d*)?|\.\d+)")
_ATL_WORD_RE = re.compile(r"([A-Za-z_]\w*)(?:\s+(\S.*))?")
# ATL keywords that are motion or structure, never a frame list's part.
_ATL_OTHER = frozenset({"block", "parallel", "choice", "on", "contains",
                        "time", "event", "linear", "warp", "circles",
                        "clockwise", "counterclockwise", "knot"})
NOT_CONVERTED = "image without a file: ATL statement `{}` ({}) not converted"


def _atl_pause(clause: str) -> float | None:
    """The seconds of an ATL pause clause, else None: `pause N` or a
    bare `N`, the number in any parentheses (`pause (0.5)`,
    `pause(0.5)`, `(0.5)`: docs/plan.md Phase 60 item 9n2)."""
    text = clause.strip()
    if text.startswith("pause") and text[5:6] in ("", " ", "\t", "("):
        text = text[5:].strip()
        if not text:
            return None
    while text.startswith("(") and text.endswith(")"):
        text = text[1:-1].strip()
    return float(text) if _ATL_NUMBER_RE.fullmatch(text) else None


def _is_motion(word: str) -> bool:
    """A warper (`linear`, `ease`, `easein_quad`, ...) or a structure
    keyword: ATL a frame list does not hold."""
    return word in _ATL_OTHER or word.startswith("ease")


def read_atl_image(block: list[tuple[int, str, int]], relname: str,
                   source: str) -> tuple[AtlImage | None, list[Report]]:
    """Read an `image name:` ATL block (``(lineno, text, indent)`` lines)
    as a frame list, or None with the report naming the first statement
    that is not one (docs/plan.md Phase 60 item 8). Frames are quoted
    strings, either quote, each followed by `pause N` or a bare number,
    in any parentheses (`pause (0.5)`, item 9n2), summed when
    several; a last `repeat` or `repeat N` sets the loops. A frame's
    `with` is a cut and a `function` is dropped, each reported; a frame
    with no time after it shows for none and is left out, except the
    last frame of a block with no `repeat`, which Ren'Py shows from then
    on: it takes the block's shortest pause and is the held frame. One
    frame is a still, its transform properties reported as not applied;
    over several frames a property is not converted."""
    reports: list[Report] = []
    frames: list[AtlFrame] = []
    props: list[tuple[str, str]] = []   # (source, clause)
    repeat: int | None = None
    repeated = False

    def reject(clause: str, at: str) -> tuple[None, list[Report]]:
        """The block stays `image without a file`, reported at its
        `image` statement, the statement that is not converted named."""
        return None, [Report(source, "", NOT_CONVERTED.format(clause, at))]

    if not block:
        return None, [Report(source, "", "image without a file")]
    top = block[0][2]
    for lineno, text, depth in block:
        at = f"{relname}:{lineno}"
        if depth != top or text.endswith(":"):
            return reject(text, at)
        for clause in _call_arguments(text + ")", 0) or [text]:
            if repeated:
                return reject(clause, at)
            word_m = _ATL_WORD_RE.fullmatch(clause)
            word, value = (word_m.group(1), word_m.group(2) or "") \
                if word_m else ("", "")
            parsed = string_at(clause)
            pause = _atl_pause(clause) if parsed is None else None
            if parsed is not None:
                tail = clause[parsed[1]:].strip()
                if tail.startswith("with ") or tail == "with":
                    reports.append(Report(at, clause, (
                        f"ATL frame transition `{tail}` not converted: "
                        "a cut")))
                elif tail:
                    props.append((at, tail))
                frames.append(AtlFrame(parsed[0], 0.0, at))
            elif pause is not None:
                if not frames:
                    return reject(clause, at)
                frames[-1].seconds += pause
            elif word == "repeat" and (not value or value.isdigit()):
                repeated, repeat = True, int(value) if value else None
                if repeat == 0:
                    return reject(clause, at)
            elif word in ("pass", "animation") and not value:
                continue
            elif word == "function" and value:
                reports.append(Report(at, clause, (
                    f"ATL `{clause}` not converted: dropped")))
            elif word and value and not _is_motion(word) \
                    and word not in ("pause", "repeat"):
                props.append((at, clause))
            else:
                return reject(clause, at)
    if not frames:
        return None, [Report(source, "", "image without a file")]
    if len(frames) == 1:
        if props:
            reports.append(Report(source, "", (
                "ATL image with one frame: a still; "
                + ", ".join(f"`{p}`" for _s, p in props)
                + " not applied")))
        frames[0].seconds = frames[0].seconds or 1.0
        return AtlImage(source, frames, still=True), reports
    if props:
        return reject(props[0][1], props[0][0])
    timed = [f.seconds for f in frames if f.seconds > 0]
    held = frames[-1] if repeated is False and not frames[-1].seconds \
        and timed else None
    if held is not None:
        held.seconds = min(timed)
    for frame in frames:
        if frame.seconds <= 0:
            reports.append(Report(frame.source, f"\"{frame.ref}\"", (
                "ATL frame with no pause after it shows for no time: "
                "left out")))
    frames = [f for f in frames if f.seconds > 0]
    if not frames:
        return reject(block[-1][1], f"{relname}:{block[-1][0]}")
    image = AtlImage(source, frames,
                     loop_count=repeat or 1,
                     hold=not repeated or repeat is not None,
                     still=len(frames) == 1)
    return image, reports


# ATL statements whose end the converter cannot tell (docs/plan.md Phase
# 60 item 9n5): structure, a loop, an event or a function.
_ATL_UNREAD = frozenset({"block", "parallel", "choice", "on", "contains",
                         "time", "event", "function", "repeat"})
_ATL_ALPHA_RE = re.compile(r"(?<![\w.])alpha\s+(\S+)")


def atl_end_alpha(block: list[tuple[int, str, int]] | None
                  ) -> tuple[float | None, str | None]:
    """The `alpha` a `scene x:` or `show x:` block ends at (docs/plan.md
    Phase 60 item 9n5): the last `alpha N` it sets, bare or after a
    warper and its time (`linear 1.0 alpha 0.5`: the end value), as
    ``(alpha, None)``; ``(None, None)`` when it sets no `alpha`; ``(None,
    why)`` when it does in a way the converter cannot follow: a value
    that is not a number, a nested block, or `block`, `parallel`,
    `choice`, `on`, `contains`, `time`, `event`, `function` or
    `repeat`."""
    if not block or not any(_ATL_ALPHA_RE.search(text)
                            for _n, text, _d in block):
        return None, None
    top = block[0][2]
    alpha: float | None = None
    for _lineno, text, depth in block:
        if depth != top or text.endswith(":"):
            return None, f"`{text}` opens a block"
        for clause in _call_arguments(text + ")", 0) or [text]:
            word = clause.split()[0] if clause.split() else ""
            if word in _ATL_UNREAD:
                return None, f"`{clause}`"
            for m in _ATL_ALPHA_RE.finditer(clause):
                value = m.group(1)
                if not _ATL_NUMBER_RE.fullmatch(value):
                    return None, f"`alpha {value}` is not a number"
                alpha = min(1.0, float(value))
    return alpha, None


def _is_creator_statement(line: str, names: set[str]) -> bool:
    """True when ``line`` starts with a creator-defined statement's
    name. Ren'Py matches registered statements before a say statement,
    so `sfx "boom"` is the statement, not a line spoken by `sfx`."""
    words = line.replace(":", " ").split()
    return any(words[:len(name.split())] == name.split() for name in names)


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
    keyword = statement_word(line)
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
    r"""(?:[A-Za-z_][\w.]*(?:\s+-?[-\w]+)*(?:\s*@(?:\s*-?[-\w]+)+)?\s*)?"""
    r"""(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(?:\s+with\s+\S+)?\s*$""")


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
        keyword = statement_word(text)
        if keyword in ("if", "while") and text.endswith(":"):
            alts = [_block_steps(entries[k + 1:j], relname, cur_global)]
            ends = keyword == "while"
            while (keyword == "if" and j < len(entries)
                   and entries[j][2] == indent
                   and statement_word(entries[j][1])
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
        if depth != indent or statement_word(head) \
                not in ("elif", "else"):
            break
        entries.append((j + 1, head, depth))
        block, j = _gather_block(raw_lines, j + 1, indent)
        entries += block
    steps = _block_steps(entries, relname, cur_global)
    return steps[0] if steps else None


def _chain_heads(raw_lines: list[str], i: int, lineno: int, line: str,
                 indent: int) -> tuple[list[tuple[int, str]], int]:
    """The `if`, `elif` and `else` heads of the chain whose `if` (``line``,
    raw line ``lineno``) was just read, ``(lineno, text)`` each, and the
    index after the chain's last block."""
    heads = [(lineno, line)]
    _block, j = _gather_block(raw_lines, i, indent)
    while j < len(raw_lines):
        content = strip_comment(raw_lines[j])
        if not content.strip():
            j += 1
            continue
        depth = len(content) - len(content.lstrip(" \t"))
        head = content.strip()
        if depth != indent or statement_word(head) \
                not in ("elif", "else"):
            break
        heads.append((j + 1, head))
        _block, j = _gather_block(raw_lines, j + 1, indent)
    return heads, j


def _handle_chain(raw_lines: list[str], i: int, relname: str, lineno: int,
                  line: str, indent: int, result: FileParse,
                  events: list[Event], cur_label: str | None,
                  cur_global: str | None) -> int:
    """Read the `if` chain whose head was just read; the index the scan
    resumes at, after its last block.

    A chain every test of which reads one variable the script sets
    (kinetic_extract.conditions.read_chain, by the project's assignments)
    becomes a MenuRecord with its ``condition`` and a ``fork`` event whose
    ``bodies`` hold each arm read as label flow, an absent `else` an empty
    arm (docs/plan.md Phase 60 item 6). Another (or one with a `label` in
    an arm, a place a jump could enter it from outside) is reported, `if
    chain not converted (why)`, its blocks skipped as before, their audio
    reported, their jumps and calls a fork the walk follows."""
    heads, j = _chain_heads(raw_lines, i, lineno, line, indent)
    source = f"{relname}:{lineno}"
    keywords = [statement_word(head)
                for _n, head in heads]
    spans = [(n, heads[k + 1][0] - 1 if k + 1 < len(heads) else j)
             for k, (n, _head) in enumerate(heads)]
    blocks = [[(m + 1, strip_comment(raw_lines[m]).strip())
               for m in range(start, stop)
               if strip_comment(raw_lines[m]).strip()]
              for start, stop in spans]
    tests = [None if kw == "else" else head[len(kw):].rstrip()[:-1].strip()
             for kw, (_n, head) in zip(keywords, heads)]
    read: conditions.ChainCondition | str
    if not all(head.endswith(":") for _n, head in heads):
        read = "an arm's head does not end in a colon"
    elif any(statement_word(text) == "label"
             for block in blocks for _m, text in block):
        read = "a label inside an arm, where a jump could enter it"
    else:
        read = conditions.read_chain(tests, result.known_variables)
    if isinstance(read, str):
        result.reports.append(Report(
            source, line, f"if chain not converted ({read}): its blocks "
            "skipped, the jumps and calls in them followed"))
        for kw, block in zip(keywords, blocks):
            result.reports.extend(
                Report(f"{relname}:{m}", text,
                       f"audio inside a skipped `{kw}` block: not converted")
                for m, text in block if mentions_audio(text))
        fork = _chain_fork(raw_lines, i, lineno, line, indent, relname,
                           cur_global)
        if fork is not None:
            events.append(Event("fork", source, text=line, flow=fork))
        return j
    bodies: list[list[Event]] = []
    for start, stop in spans:
        body: list[Event] = []
        _scan_lines(raw_lines, start, stop, relname, result, body,
                    cur_label, cur_global)
        bodies.append(body)
    read.heads = [head for _n, head in heads]
    read.label = cur_global
    read.written = list(read.heads)
    read.sources = [f"{relname}:{n}" for n, _head in heads]
    if keywords[-1] != "else":
        bodies.append([])
        read.tests.append(None)
        read.heads.append("")
        read.sources.append(source)
        read.absent_else = True
    record = MenuRecord(
        source=source, statement=line,
        decision_id=f"if-{slug(cur_label, Path(relname).stem)}"
                    f"-{lineno}"[:ID_MAX],
        prompt="", prompt_defaulted=False,
        choices=list(read.heads), choice_sources=list(read.sources),
        condition=read)
    step = FlowStep("fork", source, line, menu=len(result.menus),
                    bodies=bodies)
    read.step, read.record = step, record
    result.menus.append(record)
    events.append(Event("fork", source, text=line, flow=step))
    return j


@dataclass
class _MenuLine:
    """One line at a menu block's base indent, as Ren'Py's parse_menu
    reads it (docs/plan.md Phase 60 item 9o): a ``choice`` (``text``, its
    ``test`` after `if` or None), a ``caption`` (a string on its own
    line), a ``say`` menuitem (``speaker`` and ``text``), a line the walk
    does not need (``ignore``: `set`, `with`, a `$` line, `pass`) or
    ``other``."""

    kind: str
    text: str = ""
    test: str | None = None
    speaker: str | None = None


def _menu_line(text: str) -> _MenuLine:
    """Read one base-indent line of a menu block. A choice or caption's
    string may be double-, single- or back-quoted (an `r` prefix too), a
    choice may carry arguments, `"x" (badge=1) if cond:`."""
    word = statement_word(text)
    if word in ("set", "with", "$", "pass"):
        return _MenuLine("ignore")
    cur = _Cursor(text)
    literal = cur.string()
    if literal is not None:
        said = item_text(literal)
        if cur.eol():
            return _MenuLine("caption", said)
        cur.parenthesised()
        test = None
        if cur.keyword("if"):
            rest = text[cur.pos:].strip()
            if not rest.endswith(":") or not rest[:-1].strip():
                return _MenuLine("other")
            return _MenuLine("choice", said, rest[:-1].strip())
        cur.ws()
        if text[cur.pos:].strip() == ":":
            return _MenuLine("choice", said, test)
        return _MenuLine("other")
    say = parse_say(text, interact=False)
    if say is not None and say.who and not say.triple:
        return _MenuLine("say", item_text(say.literal), speaker=say.who)
    return _MenuLine("other")


def _one_choice(block: list[tuple[int, str, int]], caption: str | None,
                menu_lineno: int) -> list[tuple[int, str]] | None:
    """The narration lines of a one-choice menu, ``(lineno, text)``: its
    caption, if it has one, then its choice text, the choice's line last
    (its block follows it). None for any other menu: two or more choices,
    a conditional choice (`"x" if cond:`), a statement before the choice,
    a say menuitem, or any line after the choice or between choices the
    menu reader does not take. A line the walk does not need (`set`,
    `with`, `$`, `pass`) before the choice is passed over."""
    if not block:
        return None
    base = block[0][2]
    lines: list[tuple[int, str]] = []
    choice = None
    for lineno, text, indent in block:
        if indent > base:
            if choice is None:
                return None
            continue
        if indent < base or choice is not None:
            return None
        read = _menu_line(text)
        if read.kind == "ignore":
            continue
        if read.kind == "choice" and read.test is None:
            if not read.text.strip():
                return None
            choice = (lineno, read.text)
        elif read.kind == "caption" and caption is None and not lines:
            caption = read.text
            lines.append((lineno, read.text))
        else:
            return None
    if choice is None:
        return None
    if caption is not None and not lines:
        # The caption of a `menu "caption":` head, said on its line.
        lines.append((menu_lineno, caption))
    return lines + [choice]


# `$ x = ...`, `$ x += ...` or `$ x -= ...` on a plain or dotted name.
_CHOICE_ASSIGN_RE = re.compile(
    r"\$\s*([A-Za-z_][\w.]*)\s*(\+=|-=|=)(?!=)\s*(.+)")


@dataclass
class _MenuShape:
    """What _menu_choices reads of a menu block: why it stays linear (the
    first such reason, None for none), its caption, its choices
    ``(label, lineno)`` with each one's test (None when plain) and the
    lines passed over, ``(lineno, what)``, for the ledger."""

    reject: str | None
    caption: str | None
    caption_strings: bool
    caption_line: int | None
    choices: list[tuple[str, int]]
    tests: list[str | None]
    passed: list[tuple[int, str]]


def _menu_choices(block: list[tuple[int, str, int]], caption: str | None,
                  ) -> _MenuShape:
    """The structure of a menu block (``(lineno, text, indent)`` of its
    lines deeper than the `menu:` line), as Ren'Py's parse_menu reads it
    (docs/plan.md Phase 60 item 9o): the lines at the block's base indent
    are choices (`"text":`, `"text" if cond:`, either quote, arguments
    allowed), captions (a string alone: the first before any choice is
    the prompt, a later one is passed over), a say menuitem (`e "Which
    one?"`, the prompt when it comes first) and lines the walk does not
    need (`set`, `with`, a `$` line, `pass`), passed over. A `label`
    inside a choice block is read as label flow. Anything else at the
    base indent, a statement before the first choice, a dedented line or
    an empty choice label is a reason to stay linear; the block is still
    read to its end, so every choice is known."""
    base = block[0][2]
    shape = _MenuShape(None, caption, True, None, [], [], [])

    def reject(why: str) -> None:
        if shape.reject is None:
            shape.reject = why

    for lineno, text, indent in block:
        if indent > base:
            if not shape.choices:
                reject("statement before the first choice")
            continue
        if indent < base:
            reject(f"unexpected indent at line {lineno}")
            continue
        read = _menu_line(text)
        if read.kind == "choice":
            if not read.text.strip():
                reject("empty choice label")
            shape.choices.append((read.text.strip()[:LABEL_MAX], lineno))
            shape.tests.append(read.test)
        elif read.kind in ("caption", "say") and shape.caption is None \
                and not shape.choices:
            shape.caption = read.text
            shape.caption_strings = read.kind == "caption"
            shape.caption_line = lineno
        elif read.kind in ("caption", "say", "ignore"):
            shape.passed.append((lineno, text))
        else:
            reject(f"unsupported line between choices: {text}")
    return shape


def _choice_assignments(block: list[tuple[int, str, int]]
                        ) -> list[tuple[int, tuple[str, str, str]]]:
    """The `$` assignments written directly in a choice block (not in a
    block inside it), each ``(lineno, (variable, operator,
    expression))`` in order."""
    if not block:
        return []
    depth = block[0][2]
    out: list[tuple[int, tuple[str, str, str]]] = []
    for lineno, text, indent in block:
        m = _CHOICE_ASSIGN_RE.fullmatch(text) if indent == depth else None
        if m is not None:
            out.append((lineno, (m.group(1), m.group(2),
                                 m.group(3).strip())))
    return out


def _handle_menu(raw_lines: list[str], i: int, relname: str,
                 menu_lineno: int, menu_line: str, menu_indent: int,
                 result: FileParse, events: list[Event],
                 cur_label: str | None,
                 cur_global: str | None = None) -> int:
    """Parse the menu block whose ``menu:`` line was just read.

    ``i`` is the index of the line after the ``menu:`` line; the answer is
    the index the outer scan resumes at. A menu with one plain choice
    gives narration lines (its caption, its choice text) and resumes the
    scan inside its choice block, read as label flow. A menu with
    choices (docs/plan.md Phase 60 items 4 and 9o) appends a MenuRecord
    and a ``fork`` event tagged with it whose ``bodies`` hold each choice
    block read as label flow (_scan_lines: its lines, audio, nested
    menus, labels, `$` lines and the `jump`, `call` or `return` it ends
    in); kinetic_extract.flow lays the choices out between menu markers.
    One whose shape the parser does not take (_menu_choices) has its
    ``parse_reason`` set: walked the same, it stays linear. A menu with no
    choice is reported ``menu unsupported (reason)`` and its block
    contributes nothing to the stream but a ``fork`` event of its jumps
    and calls (the walk follows those, docs/plan.md Phase 57 item 4e).
    Never fatal."""
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

    single = _one_choice(block, caption, menu_lineno)
    if single is not None:
        for lineno, text in single:
            events.append(Event("dialogue", f"{relname}:{lineno}",
                                text=text, from_strings=True))
        # The outer scan reads the choice block, the lines after the
        # choice line, as label flow.
        return single[-1][0]

    shape = _menu_choices(block, caption) if block else None
    choices = shape.choices if shape is not None else []
    reject = shape.reject if shape is not None else "empty menu"
    if reject is None and not choices:
        reject = "no choices"
    elif reject is None and len(choices) < 2:
        reject = "fewer than two choices"
    if shape is not None:
        caption = shape.caption
    record = MenuRecord(
        source=source, statement=menu_line,
        decision_id=f"menu-{slug(cur_label, Path(relname).stem)}"
                    f"-{menu_lineno}"[:ID_MAX],
        prompt=(caption if caption is not None else _DEFAULT_PROMPT)
               [:PROMPT_MAX],
        prompt_defaulted=caption is None,
        choices=[label for label, _lineno in choices],
        choice_sources=[f"{relname}:{lineno}" for _label, lineno in choices],
        choice_tests=list(shape.tests) if shape is not None else [],
        caption_strings=shape is None or shape.caption_strings,
        caption_source=f"{relname}:{shape.caption_line}"
        if shape is not None and shape.caption_line is not None
        else source,
        passed=[(f"{relname}:{n}", text) for n, text in shape.passed]
        if shape is not None else [])
    menu_idx = len(result.menus)
    result.menus.append(record)
    if not choices:
        record.skip_reason = reject
        result.reports.append(Report(
            source, menu_line,
            f"menu unsupported ({reject}): branch skipped, linear flow kept"))
        result.reports.extend(
            Report(f"{relname}:{lineno}", text, AUDIO_IN_MENU)
            for lineno, text, _indent in block if mentions_audio(text))
        alts = menu_alternatives(block, relname, cur_global)
        if any(alts):
            events.append(Event(
                "fork", source, text=menu_line,
                flow=FlowStep("fork", source, menu_line, alternatives=alts)))
        return j
    # A menu that stays linear for its shape still has its choices walked
    # as a decision's are (docs/plan.md Phase 60 item 9o): each one's
    # lines are kept in a row, and the timeline reports the menu.
    record.parse_reason = reject

    # Each choice block, read as label flow into its own event list: the
    # raw lines after its choice line up to the next line at the block's
    # base indent (a choice, or a line passed over), the last up to the
    # menu's end.
    bodies: list[list[Event]] = []
    starts = [lineno for _label, lineno in choices]
    base = block[0][2]
    for k, start in enumerate(starts):
        stop = next((n - 1 for n, _text, indent in block
                     if n > start and indent <= base), j)
        body: list[Event] = []
        _scan_lines(raw_lines, start, stop, relname, result, body,
                    cur_label, cur_global)
        bodies.append(body)
        found = _choice_assignments(
            [entry for entry in block if start < entry[0] <= stop])
        record.assignments.append([a for _n, a in found])
        record.assignment_sources.append([f"{relname}:{n}"
                                          for n, _a in found])
    events.append(Event(
        "fork", source, text=menu_line,
        flow=FlowStep("fork", source, menu_line, menu=menu_idx,
                      bodies=bodies)))
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
    `define audio.x` names and registered channels. A Character made in
    an `init python in NAME:` block is the store NAME's (`NAME.var`)."""
    scope: str | None = None
    # The `init python in NAME:` block the line is in: (NAME, its indent).
    store: tuple[str, int] | None = None
    for n, raw in enumerate(raw_lines):
        text = strip_comment(raw)
        if "'" in text or "\"" in text:
            result.literals.update(name_literals(text))
        _scan_code(raw_lines, n, text, relname, result)
        stripped = text.strip()
        indent = len(text) - len(text.lstrip(" \t"))
        if stripped and store is not None and indent <= store[1]:
            store = None
        named_store = _PY_IN_RE.fullmatch(stripped)
        if named_store:
            store = (named_store.group(1), indent)
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
        if _DEFINE_CHAR_RE.match(stripped):
            line = _call_text(raw_lines, n)
            if store is not None and not line.startswith(("define", "$")):
                line = f"{store[0]}.{line}"
            _read_character(line, f"{relname}:{n + 1}", result)
        if "renpy.image" in text:
            _renpy_image(raw_lines, n, text, result)
        if "register_channel(" in text:
            channel = read_channel(_call_text(raw_lines, n))
            if channel is None:
                result.reports.append(Report(
                    f"{relname}:{n + 1}", text.strip(),
                    "register_channel with arguments that are not "
                    "literals: channel not read"))
            else:
                result.channels[channel.name] = channel


# `renpy.image(` where a line's code calls it (docs/plan.md Phase 60 item
# 9n2).
_RENPY_IMAGE_RE = re.compile(r"(?<![\w.])renpy\.image\s*\(")


def _renpy_image(raw_lines: list[str], n: int, text: str,
                 result: FileParse) -> None:
    """Record a literal `renpy.image("name", d)` call on line ``n`` (in a
    `$` line or a Python block, over several lines too) as an `image`
    statement is recorded (docs/plan.md Phase 60 item 9n2): a name that
    is a string literal, or a tuple of them, and ``d`` a string literal
    (read as a displayable) or another expression kept verbatim. A call
    whose name is computed defines nothing the converter knows."""
    m = _RENPY_IMAGE_RE.search(text)
    if m is None:
        return
    line = _continued(raw_lines, n, text.strip())[0]
    m = _RENPY_IMAGE_RE.search(line)
    args = _call_arguments(line, m.end()) if m is not None else None
    if not args or len(args) != 2 or _KEYWORD_ARG_RE.fullmatch(args[0]):
        return
    head, value = args
    parts = ([head] if not head.startswith("(") else
             [a for a in (_call_arguments(head[1:] + ")", 0) or [])])
    words = [string_literal(part) for part in parts]
    if not words or None in words:
        return
    name = " ".join(" ".join(w for w in words if w).split())
    keyword = _KEYWORD_ARG_RE.fullmatch(value)
    if keyword is not None:
        value = keyword.group(2).strip()
    literal = string_literal(value)
    if name:
        result.image_defs[name] = (("file", literal) if literal is not None
                                   else ("expr", value))


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
    var = define_var(m)
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


def _screen_event(events: list[Event], source: str, line: str) -> None:
    """A ``screen`` flow event for a `show screen`/`call screen` line."""
    name = screen_shown(line)
    if name is not None:
        events.append(Event("screen", source, text=line, flow=FlowStep(
            "screen", source, line, name)))


def _audio_event(result: FileParse, events: list[Event], source: str,
                 line: str, read: AudioStatement | str | None) -> None:
    """Add an audio statement's event, or report why it is not read."""
    if isinstance(read, AudioStatement):
        events.append(Event("audio", source, cue=read))
    elif isinstance(read, str):
        result.reports.append(Report(source, line, read))


def creator_statement_names(text: str) -> set[str]:
    """The names a script registers with `renpy.register_statement`."""
    raw_lines = parser_lines(text)
    names: set[str] = set()
    for n, raw in enumerate(raw_lines):
        if "register_statement(" in raw:
            m = _REGISTER_STATEMENT_RE.search(_call_text(raw_lines, n))
            if m:
                names.add(m.group(1))
    return names


def label_parameters(text: str) -> list[conditions.Param]:
    """A label's parameter list ``text`` as conditions.Param, in order:
    each name, its default when that is a literal (else UNKNOWN, and
    UNKNOWN for none), and whether a positional argument binds it."""
    try:
        args = ast.parse(f"def f({text}): pass").body[0].args
    except (SyntaxError, ValueError, IndexError, AttributeError):
        return [conditions.Param(name, conditions.UNKNOWN, False)
                for name in _parameters(text)]
    positional = args.posonlyargs + args.args
    defaults = [None] * (len(positional) - len(args.defaults)) \
        + list(args.defaults)
    out = [conditions.Param(a.arg, conditions.literal_node(d), True)
           for a, d in zip(positional, defaults)]
    out += [conditions.Param(a.arg, conditions.literal_node(d), False)
            for a, d in zip(args.kwonlyargs, args.kw_defaults)]
    out += [conditions.Param(a.arg, conditions.UNKNOWN, False)
            for a in (args.vararg, args.kwarg) if a is not None]
    return out


def _scan_labels(raw_lines: list[str], relname: str,
                 result: "FileParse | None" = None) -> list[str | None]:
    """Each line's global label (None outside labels), and into
    ``result`` the labels' parameters and the `call`/`jump` sites of
    literal labels (FileParse.label_params, call_sites; item 9k)."""
    scopes: list[str | None] = []
    scope: str | None = None
    py_indent: int | None = None
    for n, raw in enumerate(raw_lines):
        text = strip_comment(raw)
        stripped = text.strip()
        indent = len(text) - len(text.lstrip(" \t"))
        if stripped and py_indent is not None and indent <= py_indent:
            py_indent = None
        if stripped and indent == 0:
            m = _LABEL_FULL_RE.match(stripped)
            scope = (full_label(m.group(1), scope).split(".")[0]
                     if m else None)
        scopes.append(scope)
        if not stripped or result is None or py_indent is not None:
            continue
        if _PY_BLOCK_RE.fullmatch(stripped):
            py_indent = indent
            continue
        source = f"{relname}:{n + 1}"
        m = _LABEL_PARAMS_RE.fullmatch(stripped)
        if m:
            result.label_params[full_label(m.group(1), scope)] = \
                label_parameters(m.group(2))
            continue
        m = _FLOW_SITE_RE.fullmatch(stripped)
        if m and m.group(2) not in ("expression", "screen"):
            result.call_sites.append((full_label(m.group(2), scope),
                                      m.group(3), source))
    return scopes


def call_arguments(statement: str) -> str | None:
    """The argument list of a `call label(...)` statement, None without
    one."""
    m = _FLOW_SITE_RE.fullmatch(statement.strip())
    return m.group(3) if m else None


def _parameters(text: str) -> list[str]:
    """The names a label's parameter list ``text`` binds (`n`, `mood="x"`,
    `*args`, `**kw`)."""
    try:
        args = ast.parse(f"def f({text}): pass").body[0].args
    except (SyntaxError, ValueError, IndexError, AttributeError):
        return re.findall(r"(?:^|,)\s*\**([A-Za-z_]\w*)", text)
    every = args.posonlyargs + args.args + args.kwonlyargs
    every += [a for a in (args.vararg, args.kwarg) if a is not None]
    return [a.arg for a in every]


def _keywords(text: str) -> list[str]:
    """The keyword arguments' names of a call's argument list ``text``."""
    try:
        call = ast.parse(f"f({text})", mode="eval").body
    except (SyntaxError, ValueError):
        return re.findall(r"(?:^|,)\s*([A-Za-z_]\w*)\s*=(?!=)", text)
    return [k.arg for k in getattr(call, "keywords", []) if k.arg]


def _names_read(text: str) -> list[str]:
    """The variables a test ``text`` reads (not the functions it calls;
    `store.x` is `x`)."""
    try:
        node = ast.parse(text.strip(), mode="eval")
    except (SyntaxError, ValueError):
        return []
    called = {id(n.func) for n in ast.walk(node) if isinstance(n, ast.Call)}
    out: list[str] = []
    for n in ast.walk(node):
        if id(n) in called:
            continue
        if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) \
                and n.value.id == "store":
            out.append(n.attr)
        elif isinstance(n, ast.Name) and n.id != "store":
            out.append(n.id)
    return list(dict.fromkeys(out))


def _scan_assignments(raw_lines: list[str], relname: str
                      ) -> list[conditions.Assignment]:
    """Every place the script sets a plain variable, for the `if` chain
    reader (kinetic_extract.conditions): `$ x = ...` (``=``, ``+=``,
    ``-=``; another is ``operator``; in an `init:` block a `$ x =` is a
    ``define``), `default`/`define x = ...`, and as ``python`` an
    assignment in a Python block (`python:`, `init python:`, functions in
    them), and the places item 9k names that the converter does not read
    (conditions.UNREAD_OPS): a label's parameters, a call's keyword
    arguments, loop variables (a `while` test's names, Python's `for`
    targets), `$ a, b = ...`, `setattr(store, ...)`, another operator,
    and a screen's `SetVariable`, `ToggleVariable`, `SetField(store,
    ...)`, `ToggleField(store, ...)` or input value."""
    out: list[conditions.Assignment] = []
    py_indent: int | None = None
    init_indent: int | None = None
    for n, raw in enumerate(raw_lines):
        text = strip_comment(raw)
        stripped = text.strip()
        if not stripped:
            continue
        indent = len(text) - len(text.lstrip(" \t"))
        if py_indent is not None and indent <= py_indent:
            py_indent = None
        if init_indent is not None and indent <= init_indent:
            init_indent = None
        source = f"{relname}:{n + 1}"
        for m in _ACTION_SET_RE.finditer(stripped):
            out.append(conditions.Assignment(m.group(1), "screen", "",
                                             source))
        for m in _SETATTR_RE.finditer(stripped):
            out.append(conditions.Assignment(m.group(1), "python", "",
                                             source))
        m = _WHILE_RE.fullmatch(stripped)
        if m:
            for var in _names_read(m.group(1)):
                out.append(conditions.Assignment(
                    var, "loop", conditions.fit(stripped, 60), source))
        if py_indent is not None:
            m = _FOR_RE.match(stripped)
            if m:
                for var in re.findall(r"[A-Za-z_]\w*", m.group(1)):
                    out.append(conditions.Assignment(
                        var, "loop", conditions.fit(stripped, 60), source))
            m = _PY_SET_RE.match(stripped)
            if m:
                out.append(conditions.Assignment(m.group(1), "python",
                                                 stripped, source))
            continue
        m = _LABEL_PARAMS_RE.fullmatch(stripped)
        if m:
            for var in _parameters(m.group(2)):
                out.append(conditions.Assignment(var, "parameter",
                                                 m.group(1), source))
            continue
        m = _CALL_ARGS_RE.fullmatch(stripped)
        if m:
            for var in _keywords(m.group(2)):
                out.append(conditions.Assignment(var, "argument",
                                                 m.group(1), source))
            continue
        m = _UNPACK_RE.match(stripped)
        if m:
            for var in m.group(1).split(","):
                out.append(conditions.Assignment(
                    var.strip().rpartition(".")[2], "unpack", stripped,
                    source))
            continue
        if _PY_BLOCK_RE.fullmatch(stripped):
            py_indent = indent
            continue
        if _INIT_BLOCK_RE.fullmatch(stripped):
            init_indent = indent
            continue
        m = _STORE_DECL_RE.fullmatch(stripped)
        if m:
            whole = _STORE_DECL_RE.fullmatch(
                _continued(raw_lines, n, stripped, 5000)[0]) or m
            op = m.group(1) if m.group(3) == "=" else "operator"
            out.append(conditions.Assignment(m.group(2), op, whole.group(4),
                                             source))
            continue
        m = _DOLLAR_SET_RE.fullmatch(stripped)
        if m:
            whole = _DOLLAR_SET_RE.fullmatch(
                _continued(raw_lines, n, stripped, 5000)[0]) or m
            op = m.group(2) if m.group(2) in ("=", "+=", "-=") \
                else "operator"
            if op == "=" and init_indent is not None:
                op = "define"
            out.append(conditions.Assignment(m.group(1), op, whole.group(3),
                                             source))
    scopes = _scan_labels(raw_lines, relname)
    return [replace(a, scope=scopes[int(a.source.rpartition(":")[2]) - 1])
            for a in out]


def parse_file(text: str, relname: str,
               creator_statements: set[str] = frozenset(),
               variables: dict[str, list[conditions.Assignment]]
               | None = None) -> FileParse:
    """Parse one .rpy source; never raises on unknown statements.
    ``creator_statements`` are statement names other files register;
    ``variables`` every assignment of the project by variable (default:
    this file's own), which an `if` chain is read by."""
    result = FileParse(relname=relname,
                       creator_statements=set(creator_statements))
    raw_lines = parser_lines(text)
    result.assignment_scan = _scan_assignments(raw_lines, relname)
    _scan_labels(raw_lines, relname, result)
    result.known_variables = (variables if variables is not None else
                              conditions.by_variable(result.assignment_scan))
    _scan_settings(raw_lines, relname, result)
    result.story_reports_from = len(result.reports)
    result.creator_statements |= creator_statement_names(text)

    _scan_lines(raw_lines, 0, len(raw_lines), relname, result,
                result.events, None, None)
    return result


def _scan_lines(raw_lines: list[str], start: int, stop: int, relname: str,
                result: FileParse, events: list[Event],
                cur_label: str | None, cur_global: str | None) -> None:
    """The statement walk over ``raw_lines[start:stop]``: its events go to
    ``events`` (the file's stream, or a menu choice block's own list),
    its reports, menus and definitions to ``result``. ``cur_label`` is the
    label whose body the lines are in, ``cur_global`` the global label
    local ones belong to."""
    skip_indent: int | None = None  # depth of the line that opened a block
    skip_opener = ""                # that line's keyword
    # The skipped block is an `init:` or `init N:` block, whose `image`
    # statements are read (docs/plan.md Phase 60 item 9n), and the depth
    # of its first line, where they stand.
    skip_init = False
    init_top: int | None = None
    i = start
    while i < stop:
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
                if skip_init:
                    init_top = indent if init_top is None else init_top
                    if indent == init_top and statement_word(line) == "image":
                        # An ATL block under it is read with it; the
                        # init block's skip covers any other.
                        i, _opens = _image_statement(
                            raw_lines, i, line,
                            line[len("image"):].strip(), indent, relname,
                            source, result)
                        continue
                if mentions_audio(line):
                    result.reports.append(Report(
                        source, line, f"audio inside a skipped "
                        f"`{skip_opener}` block: not converted"))
                continue
            skip_indent = None
        keyword = statement_word(line)
        rest = line[len(keyword):].strip()
        if rest.startswith(":"):
            rest = rest[1:].strip()

        def open_block() -> None:
            nonlocal skip_indent, skip_opener, skip_init, init_top
            if line.endswith(":"):
                skip_indent = indent
                skip_opener = keyword
                skip_init = bool(_INIT_BLOCK_RE.fullmatch(line))
                init_top = None

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
                events.append(Event(step.kind, source, text=line,
                                           flow=step))
                continue
            assigned = _DOLLAR_SET_RE.fullmatch(line)
            if assigned and events is result.events:
                # Where label flow sets a variable, for the walk order of
                # an if chain's initial value (docs/plan.md Phase 60 item
                # 6c); the walk itself passes over it.
                events.append(Event("set", source, name=assigned.group(1)))
            _audio_event(result, events, source, line, read_python(line))
            continue
        if keyword == "default":
            continue
        if keyword == "with" and rest:
            events.append(Event("with", source, name=rest))
            continue
        if keyword == "pause":
            events.append(Event("interact", source))
            continue
        if keyword == "return":
            events.append(Event(
                "return", source, text=line,
                flow=FlowStep("return", source, line)))
            continue
        if keyword in _QUIET_STATEMENT_KEYWORDS:
            continue
        if keyword == "image":
            i, opens = _image_statement(raw_lines, i, line, rest, indent,
                                        relname, source, result)
            if opens:
                # `image x:` opens an ATL block, whose quoted frames are
                # not lines of dialogue.
                open_block()
            continue
        if keyword == "scene":
            visual = _visual_event(source, rest, None)
            visual.scene = True
            if visual.name is None:
                visual.name, visual.bare = "black", True
            events.append(visual)
            if line.endswith(":"):
                # `scene x:`: an ATL block, whose lines are no statements.
                visual.atl = _gather_block(raw_lines, i, indent)[0]
                open_block()
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
                _screen_event(events, source, line)
                continue
            visual = _visual_event(source, rest, None)
            if visual.name:
                events.append(visual)
            else:
                result.reports.append(Report(source, line, "show without an image"))
            if line.endswith(":"):
                # `show x:` with an ATL block names x (docs/plan.md Phase
                # 60 item 9n); the block's lines are no statements.
                visual.atl = _gather_block(raw_lines, i, indent)[0]
                open_block()
            continue
        if keyword == "hide":
            result.reports.append(
                Report(source, line, "hide skipped (visual unchanged)"))
            clause = with_clause(rest)
            if clause is not None:
                # `hide x with t` is `with None`, `hide x`, `with t`: the
                # hide changes no picture the folder shows.
                events.append(Event("interact", source))
                events.append(Event("with", source, name=clause))
            continue
        if keyword == "movie":
            quoted = _parse_quoted(rest, rest.find("\""))
            if quoted is None:
                result.reports.append(
                    Report(source, line, "movie without a file"))
            else:
                events.append(Event("video", source, asset=quoted[0]))
            continue
        if keyword == "stop" and rest == "movie":
            events.append(Event("stop-movie", source))
            continue
        if keyword in _AUDIO_KEYWORDS:
            # A playlist may run over several lines; its lines are not
            # statements of their own.
            line, i = _continued(raw_lines, lineno - 1, line)
            read = read_statement(line)
            if read is None:
                result.reports.append(
                    Report(source, line, f"unsupported statement: {line}"))
            _audio_event(result, events, source, line, read)
            continue
        if keyword == "menu":
            named = _NAMED_MENU_RE.match(line)
            if named:
                # `menu name:` is a label too: a jump to it shows the menu.
                events.append(Event(
                    "label", source, name=full_label(named.group(1),
                                                     cur_global)))
            i = _handle_menu(raw_lines, i, relname, lineno, line, indent,
                             result, events, cur_label, cur_global)
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
                events.append(Event("label", source, name=name))
            continue
        if keyword in {"jump", "call"}:
            step = flow_statement(line, source, cur_global)
            if isinstance(step, FlowStep):
                events.append(Event(keyword, source, text=line,
                                           flow=step))
            elif step is not None:
                result.reports.append(Report(source, line, step))
                _screen_event(events, source, line)
            open_block()
            continue
        if keyword == "screen":
            block, _j = _gather_block(raw_lines, i, indent)
            _screen_flow(line, block, relname, result)
        if keyword == "if" and line.endswith(":"):
            # A chain on one variable the script sets is a fork of its
            # arms (docs/plan.md Phase 60 item 6); another is skipped as
            # before, its jumps and calls followed.
            i = _handle_chain(raw_lines, i, relname, lineno, line, indent,
                              result, events, cur_label, cur_global)
            continue
        if keyword == "while" and line.endswith(":"):
            # Its block is skipped (and reported) as before; the jumps
            # and calls in it are followed (kinetic_extract.flow).
            fork = _chain_fork(raw_lines, i, lineno, line, indent, relname,
                               cur_global)
            if fork is not None:
                events.append(Event("fork", source, text=line,
                                           flow=fork))
        if keyword in _QUIET_BLOCK_KEYWORDS:
            open_block()
            continue

        # Dialogue: a say statement (docs/plan.md Phase 60 item 9m): a
        # lone string, or a speaker (a name, a dotted name or a string),
        # image attributes, `@` temporary ones, then a string; a
        # triple-quoted string is a line per paragraph. Never a
        # statement's keyword (Ren'Py tries those first).
        say = None if keyword in STATEMENT_WORDS else parse_say(line)
        if say is not None:
            speaker, named = say.who, False
            if speaker is not None and _QUOTED_WHO_RE.match(speaker):
                speaker, named = item_text(speaker), True
            for k, said in enumerate(say_texts(say)):
                events.append(Event(
                    "dialogue", source, text=said, speaker=speaker,
                    attributes=tuple(say.attributes),
                    temporary=tuple(say.temporary), speaker_named=named,
                    paragraph=k))
            continue
        # Lines the say grammar does not take, read as before.
        quoted_start = line.find("\"")
        if quoted_start == 0:
            parsed = _parse_quoted(line, 0)
            if parsed:
                events.append(
                    Event("dialogue", source, text=parsed[0]))
            continue
        m = _SPEAKER_SAY_RE.match(line)
        if m:
            parsed = _parse_quoted(line, quoted_start)
            if parsed:
                events.append(
                    Event("dialogue", source, text=parsed[0],
                          speaker=m.group(1)))
            continue

        result.reports.append(
            Report(source, line, f"unrecognized statement: {line}"))
        open_block()


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
    # An `if` chain's variable may be set in any file.
    variables = conditions.by_variable(
        [a for rel, text in texts
         for a in _scan_assignments(parser_lines(text), rel)])
    parses: list[tuple[str, FileParse]] = []
    image_defs: dict[str, tuple[str, Any]] = {}
    characters: dict[str, str] = {}
    kinds: dict[str, str] = {}
    for rel, text in texts:
        parsed = parse_file(text, rel, creator, variables)
        parses.append((rel, parsed))
        image_defs.update(parsed.image_defs)
        for var in parsed.character_defs:
            characters.pop(var, None)
            kinds.pop(var, None)
        characters.update(parsed.characters)
        kinds.update(parsed.character_kinds)
    characters.update(kind_names(characters, kinds))
    return parses, image_defs, characters, sources


def _kind_argument(statement: str) -> str | None:
    """A Character statement's `kind=` value as written, stripped, or
    None when it gives none."""
    m = _DEFINE_CHAR_RE.match(statement)
    for arg in (_call_arguments(statement, m.end()) or []) if m else []:
        kw = _KEYWORD_ARG_RE.fullmatch(arg)
        if kw is not None and kw.group(1) == "kind":
            return kw.group(2).strip()
    return None


def _literal_kind(statement: str) -> str | None:
    """A Character statement's `kind=` when it is a plain (dotted) name,
    else None."""
    kind = _kind_argument(statement)
    return kind if kind and _DOTTED_NAME_RE.fullmatch(kind) else None


def character_images(parses: list[tuple[str, FileParse]]
                     ) -> dict[str, str]:
    """Variable -> the image tag of each Character define that gives one
    (character_image), a later define replacing an earlier one; a define
    without `image=` takes its literal `kind=`'s, as Ren'Py copies a
    kind's properties."""
    own: dict[str, str | None] = {}
    kinds: dict[str, str] = {}
    for _rel, parsed in parses:
        for var, (_source, statement) in parsed.character_defs.items():
            own[var] = character_image(statement)
            kinds.pop(var, None)
            kind = _literal_kind(statement)
            if kind is not None:
                kinds[var] = kind
    out: dict[str, str] = {}
    for var in own:
        seen, at = {var}, var
        while own.get(at) is None and at in kinds and kinds[at] not in seen:
            at = kinds[at]
            seen.add(at)
        if own.get(at) is not None:
            out[var] = own[at]
    return out


# Ren'Py's own Characters with no name (renpy/common): the kinds `adv`
# and `nvl`, and `narrator`, `nvl_narrator`, `centered` and `vcentered`,
# each `Character(None, ...)`. A game's own define of the name wins.
BUILTIN_NAMELESS = frozenset({"adv", "nvl", "narrator", "nvl_narrator",
                              "centered", "vcentered"})


def character_nameless(line: str) -> bool | None:
    """Whether a Character statement (_DEFINE_CHAR_RE) makes a Character
    with no name: True when its name (the first positional argument or
    `name=`) is `None`, False when it gives another name, None when it
    gives none, its name then its `kind=`'s (Ren'Py's default kind,
    `adv`, has none). Arguments the converter cannot read (`*args`,
    `**kwargs`, an unclosed call) are a name it does not know: False."""
    m = _DEFINE_CHAR_RE.match(line)
    args = _call_arguments(line, m.end()) if m else None
    if args is None:
        return False
    for arg in args:
        if arg.startswith("*"):
            return False
        kw = _KEYWORD_ARG_RE.fullmatch(arg)
        if kw is None:
            return arg == "None"
        if kw.group(1) == "name":
            return kw.group(2).strip() == "None"
    return None


def nameless_characters(parses: list[tuple[str, FileParse]]) -> set[str]:
    """The variables whose Character has no name (docs/plan.md Phase 60
    item 9m2), whose lines Ren'Py shows as narration: a define whose name
    is `None`; one with no name argument whose literal `kind=` is
    nameless, through a chain of kinds, or that gives no `kind=` (Ren'Py's
    default kind, `adv`, has no name); and Ren'Py's own nameless
    Characters (BUILTIN_NAMELESS) the game does not define. A later
    define replaces an earlier one; a `kind` the converter cannot read
    gives no answer."""
    own: dict[str, bool | None] = {}
    kinds: dict[str, str | None] = {}
    for _rel, parsed in parses:
        for var, (_source, statement) in parsed.character_defs.items():
            own[var] = character_nameless(statement)
            kinds[var] = _literal_kind(statement)
            if (own[var] is None and kinds[var] is None
                    and _kind_argument(statement) is not None):
                own[var] = False        # a kind the converter cannot read

    def nameless(var: str, seen: frozenset[str]) -> bool:
        if var not in own:
            return var in BUILTIN_NAMELESS
        if own[var] is not None:
            return own[var]
        kind = kinds[var]
        if kind is None:
            return True                 # Ren'Py's default kind, `adv`
        return kind not in seen and nameless(kind, seen | {kind})

    found = {var for var in own if nameless(var, frozenset({var}))}
    return found | {var for var in BUILTIN_NAMELESS if var not in own}


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
