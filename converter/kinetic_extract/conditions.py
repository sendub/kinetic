"""Conditions become decisions (docs/plan.md Phase 60 item 6;
docs/extracting.md, "Conditions").

An `if`/`elif`/`else` chain whose tests all read one variable the game's
script sets (`$ x = ...`, `+=`, `-=`, `default`, `define`) is read by the
parser as a fork whose arms carry their statements (read_chain decides at
the `if`, from every assignment of the project: scan in
kinetic_extract.parser), and the walk lays it out as it lays out a menu's
choices (kinetic_extract.flow). Before the walk, prepare() decides what
kind of decision each chain becomes and words its routes:

- **follows**: every assignment of the variable but its `default` or
  `define` is a literal in the choice blocks of one menu, or in label
  flow before it (item 6c: the walk's program proves one value as the
  menu opens, kinetic_extract.flow.Resets). Each choice gives the
  variable a value (its last assignment, else that value or the
  default);
  each arm's routes are the choices whose value takes it (the first arm
  whose test holds), labelled "If you chose: A or B", and the decision
  `follows` that menu's (kinetic_extract.timeline checks it became one;
  else the decision is ordinary with the same labels). An absent `else`
  that some choice takes is laid out as a line, its label in
  parentheses, and dropped when the decision follows, unless it is
  needed as the second route.
- **ranges**: a counter (`+=`/`-=`, or whole numbers) tested against
  whole numbers. Each arm's whole numbers (an arm takes what earlier arms
  leave) are said as ranges: "love 3 or more", "love 1 or 2", "love
  under 1"; the rest of an `else` that takes more than two ranges is
  "Otherwise".
- **words**: any other test. An arm only menu choices' assignments can
  take is "If you chose: ..."; else the test in words: "met is set",
  "met is not set", "ending is good", "ending is not good", an `else`
  the opposite of the one test before it, else "Otherwise".

A chain on its own label's parameter that every call of the label gives
a literal is a ``pick`` (item 9k: call_picks): no decision, the walk
takes at each call the arm its value picks (kinetic_extract.flow). A
chain on a variable some place the converter does not read sets (a
label parameter some call gives an expression, a loop, a random roll or
another call's value, Python code, a screen action: Assignment.unread),
or on `_return`, is classified as above from what it does read and the
reader picks; ``unread`` says why (the ledger's `readerPicks`).

An arm no value takes (every place that sets the variable read; for a
``pick``, no call's value) or, for a counter, whose numbers earlier arms
take is dropped, reported (`if arm never taken`); a chain left with one
arm is read in line. An ordinary decision's absent
`else` is a route whose one line is its label in parentheses. The prompt
is "Which fits your story so far?". The words are the `converter.*`
phrases of the player's catalogue (player/src/i18n/en.ts), which `npm run
i18n` writes to converter/condition-words.json (WORDS_FILE) in every
language it has: the base text is in the game's base language, each
language file's in its tag's words (English where the catalogue lacks
the tag or the phrase: ``english_for``), a choice's text in a label that
language's `strings` translation. ``--condition-names`` maps a variable
to reader words (names_option).
"""

from __future__ import annotations

import ast
import json
import operator
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

from . import paths

WORDS_FILE = paths.CONDITION_WORDS_FILE
KEY = "converter.condition."
ENGLISH = "en"
# The content format's caps (parser.LABEL_MAX, PROMPT_MAX).
LABEL_MAX = 119
PROMPT_MAX = 199
KINDS = ("follows", "ranges", "words")


class _Unknown:
    def __repr__(self) -> str:
        return "UNKNOWN"


# A value the converter cannot read (Python, an expression, a counter's).
UNKNOWN: Any = _Unknown()


# --------------------------------------------------------------------------
# Assignments
# --------------------------------------------------------------------------

# The places a variable is set that the converter does not read (item 9k),
# each with what it says of the variable; ``value`` fills ``{value}``.
UNREAD_OPS = {
    "parameter": "is a parameter of label {value}",
    "argument": "is set by an argument of `call {value}`",
    "loop": "is a loop variable ({value})",
    "python": "is set in Python code",
    "screen": "is set by a screen action",
    "operator": "is changed with another operator than =, += or -=",
    "unpack": "is set by unpacking a tuple",
}
# Run-time state first when a variable has several (read_chain's reason).
_FIRST_UNREAD = ("parameter", "argument", "loop")


@dataclass(frozen=True)
class Assignment:
    """One place the script sets a variable: ``op`` is ``=``, ``+=`` or
    ``-=`` (a `$` line), ``default`` or ``define``, which the converter
    reads when ``value`` is a literal, or one of UNREAD_OPS: a label's
    ``parameter`` or a call's keyword ``argument`` (``value`` the label),
    a ``loop`` variable (Python's `for`, a `while` test), ``python`` (a
    Python block or function, `setattr(store, ...)`), a ``screen``
    action or input value, another ``operator``, ``unpack``."""

    var: str
    op: str
    value: str
    source: str
    # The global label whose block the line is in, None outside labels.
    scope: str | None = None

    def literal(self) -> Any:
        """The value it sets when that is a literal, else UNKNOWN."""
        if self.op not in ("=", "default", "define"):
            return UNKNOWN
        try:
            value = ast.literal_eval(self.value.strip())
        except (ValueError, SyntaxError, TypeError, MemoryError,
                RecursionError):
            return UNKNOWN
        return value if _plain(value) else UNKNOWN

    def unread(self) -> str | None:
        """None when the converter reads what this sets (a literal `=`,
        `default` or `define`, `+=`/`-=` of a literal), else what it says
        of the variable: "is a parameter of label scene", "is set from a
        call to renpy.random.randint", "starts as a list"."""
        if self.op in UNREAD_OPS:
            return UNREAD_OPS[self.op].format(value=self.value)
        text = self.value.strip()
        try:
            value = ast.literal_eval(text)
        except (ValueError, SyntaxError, TypeError, MemoryError,
                RecursionError):
            value = UNKNOWN
        if value is not UNKNOWN and _plain(value):
            return None
        if self.op in ("+=", "-="):
            return "is changed by an expression, not a literal"
        if value is not UNKNOWN:
            kind = type(value).__name__
            return (f"starts as a {kind}" if self.op != "="
                    else f"is set to a {kind}") + ", not one value"
        try:
            node = ast.parse(text, mode="eval").body
        except (SyntaxError, ValueError):
            return "is set from an expression, not a literal"
        if isinstance(node, ast.Call):
            return f"is set from a call to {_dotted(node.func) or 'a function'}"
        if isinstance(node, (ast.Name, ast.Attribute)) and _dotted(node):
            return f"is set from another variable ({_dotted(node)})"
        return "is set from an expression, not a literal"


def _plain(value: Any) -> bool:
    return value is None or isinstance(value, (bool, int, float, str))


def literal_node(node: ast.AST | None) -> Any:
    """The plain literal ``node`` is, else UNKNOWN (also for None)."""
    if node is None:
        return UNKNOWN
    try:
        value = ast.literal_eval(node)
    except (ValueError, SyntaxError, TypeError, MemoryError,
            RecursionError):
        return UNKNOWN
    return value if _plain(value) else UNKNOWN


@dataclass(frozen=True)
class Param:
    """A label's parameter: its ``default`` when that is a literal, else
    UNKNOWN (and UNKNOWN for none); ``positional`` when a positional
    argument binds it (not `*args`, `**kw` or keyword-only)."""

    name: str
    default: Any
    positional: bool


def call_values(args: str | None, params: list[Param]) -> dict[str, Any]:
    """Each parameter's value at a `call` (or `jump`: ``args`` None) of
    a label with ``params``: its literal positional or keyword argument,
    else its literal default; UNKNOWN for anything else (an expression,
    `*x` or `**x` in the call)."""
    out = {p.name: p.default for p in params}
    if not args or not args.strip():
        return out
    try:
        call = ast.parse(f"f({args})", mode="eval").body
    except (SyntaxError, ValueError):
        call = None
    if not isinstance(call, ast.Call) or any(
            isinstance(a, ast.Starred) for a in call.args) or any(
            k.arg is None for k in call.keywords):
        return {p.name: UNKNOWN for p in params}
    positional = [p.name for p in params if p.positional]
    for name, node in zip(positional, call.args):
        out[name] = literal_node(node)
    for keyword in call.keywords:
        if keyword.arg in out:
            out[keyword.arg] = literal_node(keyword.value)
    return out


def by_variable(assignments: list[Assignment]
                ) -> dict[str, list[Assignment]]:
    out: dict[str, list[Assignment]] = {}
    for a in assignments:
        out.setdefault(a.var, []).append(a)
    return out


def _whole(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


# --------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------

_OPS: dict[type, str] = {
    ast.Eq: "==", ast.NotEq: "!=", ast.Lt: "<", ast.LtE: "<=",
    ast.Gt: ">", ast.GtE: ">=", ast.Is: "is", ast.IsNot: "is not",
    ast.In: "in", ast.NotIn: "not in"}
_FLIPPED = {"==": "==", "!=": "!=", "<": ">", "<=": ">=", ">": "<",
            ">=": "<="}
_NEGATED = {"==": "!=", "!=": "==", "<": ">=", "<=": ">", ">": "<=",
            ">=": "<", "is": "is not", "is not": "is", "in": "not in",
            "not in": "in"}
_COMPARE: dict[str, Callable[[Any, Any], bool]] = {
    "==": operator.eq, "!=": operator.ne, "<": operator.lt,
    "<=": operator.le, ">": operator.gt, ">=": operator.ge}
ORDERING = frozenset({"<", "<=", ">", ">="})
# Roots of dotted names that are not the story's own variables.
_NOT_STORY = {
    "persistent": "persistent data, kept across playthroughs",
    "renpy": "Ren'Py's own state",
    "config": "Ren'Py's settings",
    "preferences": "the reader's preferences",
    "_preferences": "the reader's preferences",
    "achievement": "Ren'Py's achievements",
}
# Ren'Py's own run-time names a chain reads (item 9k): `_return` is a
# variable the reader picks the value of (RETURNED), the rest stay
# unconverted.
RETURNED = "is the value a call or `call screen` returned"
_RUN_TIME = {
    "_in_replay": "is whether a replay is playing (the label a gallery "
                  "replays)",
    "_args": "is the arguments of the call that reached the label",
    "_kwargs": "is the arguments of the call that reached the label",
}


@dataclass(frozen=True)
class Test:
    """One arm's test on ``var``: ``truth`` (``positive``: `x`, else
    `not x`), or ``op`` with ``values`` (one literal; `in` and `not in`
    a tuple of them)."""

    var: str
    op: str = ""
    values: tuple[Any, ...] = ()
    positive: bool = True

    def holds(self, value: Any) -> bool:
        if not self.op:
            return bool(value) == self.positive
        if self.op in ("in", "not in"):
            try:
                found = value in self.values
            except TypeError:
                found = False
            return found == (self.op == "in")
        other = self.values[0]
        if self.op == "is":
            return value is other
        if self.op == "is not":
            return value is not other
        try:
            return bool(_COMPARE[self.op](value, other))
        except TypeError:
            return False

    def negated(self) -> "Test":
        if not self.op:
            return Test(self.var, positive=not self.positive)
        return Test(self.var, _NEGATED[self.op], self.values)

    def whole_numbers(self) -> list[tuple[int | None, int | None]] | None:
        """The whole numbers it holds for, as ranges, or None when it
        tests anything but whole numbers."""
        if not self.op:
            zero = [(0, 0)]
            return complement(zero) if self.positive else zero
        if not all(_whole(v) for v in self.values) \
                or self.op in ("is", "is not"):
            return None
        if self.op in ("in", "not in"):
            got = normal([(v, v) for v in self.values])
            return got if self.op == "in" else complement(got)
        n = self.values[0]
        return {"==": [(n, n)], "!=": complement([(n, n)]),
                "<": [(None, n - 1)], "<=": [(None, n)],
                ">": [(n + 1, None)], ">=": [(n, None)]}[self.op]

    def truth(self) -> bool | None:
        """True for a test that the variable is set (truthy), False for
        one that it is not, None for another test."""
        if not self.op:
            return self.positive
        if self.op in ("==", "is") and self.values[0] is True:
            return True
        if self.op in ("==", "is") and self.values[0] in (False, None) \
                and not _whole(self.values[0]):
            return False
        if self.op in ("!=", "is not") and self.values[0] is True:
            return False
        if self.op in ("!=", "is not") and self.values[0] in (False, None) \
                and not _whole(self.values[0]):
            return True
        return None


def _dotted(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        head = _dotted(node.value)
        return None if head is None else f"{head}.{node.attr}"
    return None


def _variable(node: ast.AST) -> tuple[str | None, str | None]:
    """(the variable ``node`` reads, None) or (None, why it is none)."""
    if isinstance(node, ast.Name):
        name = node.id
    elif isinstance(node, ast.Attribute):
        dotted = _dotted(node)
        if dotted is None:
            return None, "reads part of an expression, not a variable"
        head, _sep, rest = dotted.partition(".")
        if head == "store" and "." not in rest:
            name = rest
        else:
            why = _NOT_STORY.get(head, "not a variable the script sets")
            return None, f"reads {dotted}: {why}"
    elif isinstance(node, ast.Call):
        func = _dotted(node.func)
        return None, f"calls {func or 'a function'}"
    else:
        return None, "tests an expression, not one variable"
    if name == "_return":
        return name, None
    if name in _RUN_TIME:
        return None, f"{name} {_RUN_TIME[name]}: run-time state"
    if name.startswith("_"):
        return None, f"{name} starts with _ (Ren'Py's own or private state)"
    if name in _NOT_STORY:
        return None, f"reads {name}: {_NOT_STORY[name]}"
    return name, None


def _literals(node: ast.AST, many: bool) -> tuple[Any, ...] | None:
    try:
        value = ast.literal_eval(node)
    except (ValueError, SyntaxError, TypeError, MemoryError,
            RecursionError):
        return None
    if many:
        if not isinstance(value, (tuple, list, set, frozenset)):
            return None
        values = tuple(value)
        return values if all(_plain(v) for v in values) else None
    return (value,) if _plain(value) else None


def read_test(text: str) -> tuple[Test | None, str | None]:
    """(the test, None) for an arm's condition text, or (None, why the
    converter does not read it)."""
    try:
        node = ast.parse(text.strip(), mode="eval").body
    except (SyntaxError, ValueError):
        return None, "not a Python test the converter reads"
    negate = False
    while isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        negate, node = not negate, node.operand
    if isinstance(node, ast.BoolOp):
        return None, ("joins tests with and/or: not a condition on one "
                      "variable")
    if isinstance(node, ast.Compare):
        if len(node.ops) != 1:
            return None, "a chained comparison"
        op = _OPS.get(type(node.ops[0]))
        left, right = node.left, node.comparators[0]
        if op is None:
            return None, "not a test the converter reads"
        name, why = _variable(left)
        if name is None and op in _FLIPPED and not isinstance(
                left, (ast.Name, ast.Attribute, ast.Call)):
            # `3 <= love`: the variable on the right.
            name, why = _variable(right)
            left, right, op = right, left, _FLIPPED[op]
            if name is None:
                return None, why
        elif name is None:
            return None, why
        values = _literals(right, op in ("in", "not in"))
        if values is None:
            return None, (f"compares {name} with something that is not a "
                          "literal")
        if op in ("is", "is not") and not all(
                v is None or isinstance(v, bool) for v in values):
            return None, f"tests {name} with `is` against a value"
        test = Test(name, op, values)
    else:
        name, why = _variable(node)
        if name is None:
            return None, why
        test = Test(name)
    return (test.negated() if negate else test), None


@dataclass
class ChainCondition:
    """An `if` chain the parser reads as a fork (read_chain), and what
    prepare() made of it."""

    variable: str
    # Each arm's test, None for an `else` (the last, which the parser
    # adds as an empty arm when the chain has none: ``absent_else``).
    tests: list[Test | None]
    heads: list[str]       # each arm's head line, "" for an absent else
    sources: list[str]     # each arm's head line source
    absent_else: bool
    # The chain's heads as written, arms never taken included.
    written: list[str] = field(default_factory=list)
    # The parser's fork step and record (its ``bodies``, ``choices``).
    step: Any = field(default=None, compare=False, repr=False)
    record: Any = field(default=None, compare=False, repr=False)
    prepared: bool = False
    kind: str | None = None
    # follows: the menu record followed, and per arm its choices that take
    # the arm; an absent else dropped when the decision follows.
    follow: Any = field(default=None, compare=False, repr=False)
    when: list[list[int]] = field(default_factory=list)
    # follows, when label flow resets the variable before the menu and a
    # choice there sets nothing (item 6c): the value that choice keeps,
    # the resets last on a way to the menu and the `default` when a way
    # passes none (``{"value", "resets", "default"}``; docs/plan.md
    # Phase 60 item 9b).
    start: dict[str, Any] | None = None
    drop_when_following: list[bool] = field(default_factory=list)
    phrases: list[tuple[Any, ...]] = field(default_factory=list)
    asides: list[str] = field(default_factory=list)
    base: str = ENGLISH
    names: dict[str, Any] = field(default_factory=dict)
    # Whether a choice of the decision it follows takes no route and
    # passes it (the CLI sets it as it writes `follows`).
    passes: bool = False
    # The languages (base and language files) whose words for this
    # decision fell back to English for a phrase.
    english_for: set[str] = field(default_factory=set)
    # Why the reader picks the arm, when a place the converter does not
    # read sets the variable (unread_reason; item 9k), else None.
    unread: str | None = None
    # The global label the chain is in (the parser sets it): a chain on
    # its parameter that every call gives a literal is a ``pick``.
    label: str | None = None

    def arm_of(self, value: Any) -> int:
        """The arm a value takes: the first whose test holds."""
        for k, test in enumerate(self.tests):
            if test is None or test.holds(value):
                return k
        return len(self.tests) - 1

    def render(self, tag: str, choice: Callable[[str], str] | None = None,
               ) -> tuple[str, list[str], list[str], bool]:
        """(prompt, route labels, asides, fell back to English) in
        ``tag``'s words, each choice text through ``choice``."""
        words = Words(tag)
        def name(var: str) -> str:
            return name_for(self.names, var, tag, self.base)
        labels = [fit(render(p, words, name, choice or (lambda t: t)),
                      LABEL_MAX) for p in self.phrases]
        asides = [words.say("aside", label=label) for label in labels]
        prompt = fit(words.say("prompt"), PROMPT_MAX)
        return prompt, labels, asides, words.fell_back


def read_chain(conditions: list[str | None],
               variables: dict[str, list[Assignment]],
               ) -> ChainCondition | str:
    """The chain whose arms' conditions are ``conditions`` (None for an
    `else`), or why it stays as before: a test the converter does not
    read, more than one variable, a variable the script does not set, a
    test by size on what is not a whole number. A chain on a variable
    some place the converter does not read sets, or on `_return`, has
    ``unread`` (unread_reason; item 9k)."""
    tests: list[Test | None] = []
    for text in conditions:
        if text is None:
            tests.append(None)
            continue
        test, why = read_test(text)
        if test is None:
            return why or "not a test the converter reads"
        tests.append(test)
    names = list(dict.fromkeys(t.var for t in tests if t is not None))
    if len(names) != 1:
        return (f"reads more than one variable ({', '.join(names)}): not "
                "a condition on one variable")
    var = names[0]
    sets = variables.get(var, [])
    reason = unread_reason(var, sets)
    if not sets and reason is None:
        return f"{var} is not set by the script ($, default or define)"
    for test in tests:
        if test is None or test.op not in ORDERING:
            continue
        if not _whole(test.values[0]):
            return (f"compares {var} by size with {test.values[0]!r}, not "
                    "a whole number")
        other = next((v for v in (a.literal() for a in sets)
                      if v is not UNKNOWN and not _whole(v)), UNKNOWN)
        if other is not UNKNOWN:
            return (f"compares {var} by size, but the script also sets it "
                    f"to {other!r}")
    return ChainCondition(var, tests, [], [], False, unread=reason)


def unread_reason(var: str, sets: list[Assignment]) -> str | None:
    """Why the reader, not the script as the converter reads it, picks
    ``var``'s arm (item 9k): `_return`, or the first place that sets it
    the converter does not read (Assignment.unread; a label parameter, an
    argument or a loop first), with its source and how many more; None
    when every place is read."""
    if var == "_return":
        return f"_return {RETURNED}"
    unread = [(a, why) for a in sets if (why := a.unread()) is not None]
    if not unread:
        return None
    unread.sort(key=lambda pair: pair[0].op not in _FIRST_UNREAD)
    first, why = unread[0]
    more = len(unread) - 1
    return (f"{var} {why} at {first.source}"
            + (f", and {more} more place{'s' if more > 1 else ''} the "
               "converter does not read set it" if more else ""))


# --------------------------------------------------------------------------
# Whole-number ranges: sorted, disjoint inclusive (low, high), None open
# --------------------------------------------------------------------------

Ranges = list[tuple[int | None, int | None]]


def normal(ranges: Ranges) -> Ranges:
    def low(r: tuple[int | None, int | None]) -> float:
        return float("-inf") if r[0] is None else r[0]
    out: Ranges = []
    for lo, hi in sorted(ranges, key=low):
        if lo is not None and hi is not None and lo > hi:
            continue
        if out:
            plo, phi = out[-1]
            if phi is None or (lo is not None and lo <= phi + 1) \
                    or lo is None:
                out[-1] = (plo, None if phi is None or hi is None
                           else max(phi, hi))
                continue
        out.append((lo, hi))
    return out


def complement(ranges: Ranges) -> Ranges:
    out: Ranges = []
    at: int | None = None   # the lowest number not yet covered; None: -inf
    open_low = True
    for lo, hi in normal(ranges):
        if lo is not None and (open_low or at is None or at <= lo - 1):
            out.append((None if open_low else at, lo - 1))
        if hi is None:
            return out
        at, open_low = hi + 1, False
    out.append((None if open_low else at, None))
    return out


def union(a: Ranges, b: Ranges) -> Ranges:
    return normal(a + b)


def minus(a: Ranges, b: Ranges) -> Ranges:
    return complement(union(complement(a), b))


# --------------------------------------------------------------------------
# Phrases and words
# --------------------------------------------------------------------------

def or_join(parts: list[tuple[Any, ...]]) -> tuple[Any, ...]:
    out = parts[0]
    for part in parts[1:]:
        out = ("or", out, part)
    return out


def range_phrase(var: str, ranges: Ranges, rest: bool) -> tuple[Any, ...]:
    if rest and len(ranges) > 2:
        return ("otherwise",)
    parts: list[tuple[Any, ...]] = []
    for lo, hi in ranges:
        if lo is None and hi is None:
            return ("otherwise",)
        if lo is None:
            parts.append(("under", var, hi + 1))
        elif hi is None:
            parts.append(("atLeast", var, lo))
        elif lo == hi:
            parts.append(("exactly", var, lo))
        elif hi == lo + 1:
            parts.append(("either", var, lo, hi))
        else:
            parts.append(("between", var, lo, hi))
    return or_join(parts)


def words_phrase(var: str, test: Test) -> tuple[Any, ...] | None:
    truth = test.truth()
    if truth is not None:
        return ("set", var) if truth else ("notSet", var)
    if test.op in ("==", "in"):
        return ("is", var, or_join([("value", v) for v in test.values]))
    if test.op in ("!=", "not in") and len(test.values) == 1:
        return ("isNot", var, ("value", test.values[0]))
    return None


def value_text(value: Any) -> str:
    return value if isinstance(value, str) else repr(value)


def fit(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit - 1] + "…"


def render(phrase: tuple[Any, ...], words: "Words",
           name: Callable[[str], str], choice: Callable[[str], str]) -> str:
    kind = phrase[0]
    if kind == "text":
        return choice(phrase[1])
    if kind == "value":
        return value_text(phrase[1])
    if kind == "or":
        return words.say("or", first=render(phrase[1], words, name, choice),
                         second=render(phrase[2], words, name, choice))
    if kind == "chose":
        return words.say("chose",
                         choice=render(phrase[1], words, name, choice))
    if kind in ("atLeast", "under", "exactly"):
        return words.say(kind, name=name(phrase[1]), n=str(phrase[2]))
    if kind in ("between", "either"):
        return words.say(kind, name=name(phrase[1]), low=str(phrase[2]),
                         high=str(phrase[3]))
    if kind in ("set", "notSet"):
        return words.say(kind, name=name(phrase[1]))
    if kind in ("is", "isNot"):
        return words.say(kind, name=name(phrase[1]),
                         value=render(phrase[2], words, name, choice))
    return words.say("otherwise")


@lru_cache(maxsize=None)
def load_words() -> dict[str, dict[str, str]]:
    """converter/condition-words.json's languages: tag -> key -> text
    (SystemExit when it cannot be read)."""
    try:
        table = json.loads(Path(WORDS_FILE).read_text(encoding="utf-8"))
        languages = table["languages"]
        if not isinstance(languages.get(ENGLISH), dict):
            raise KeyError(ENGLISH)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        raise SystemExit(
            f"kinetic-extract: cannot read the condition words "
            f"{WORDS_FILE} ({exc}); run `npm run i18n` in player/ to write "
            "it") from None
    return {tag: words for tag, words in languages.items()
            if isinstance(words, dict)}


# Spanish of Latin America and the Caribbean (player/src/i18n/
# languages.ts, REGION_GROUPS).
_ES_419 = frozenset("AR BO BR BZ CL CO CR CU DO EC GT HN MX NI PA PE PR "
                    "PY SV US UY VE".split())


def match_tag(tag: str, available: list[str]) -> str | None:
    """The catalogue language for a game's ``tag``, as the player matches
    a reader's language (player/src/i18n/languages.ts, in short): the
    same tag; else the same language, Chinese by script (a Taiwan, Hong
    Kong or Macau region is Traditional), `es` of a Latin American region
    `es-419`, `pt` `pt-BR` unless another region is named, else the plain
    language, else its first regional form. None when none."""
    lower = {t.lower(): t for t in available}
    if tag.lower() in lower:
        return lower[tag.lower()]
    parts = tag.replace("_", "-").split("-")
    lang = parts[0].lower()
    script = next((p.title() for p in parts[1:]
                   if len(p) == 4 and p.isalpha()), "")
    region = next((p.upper() for p in parts[1:]
                   if (len(p) == 2 and p.isalpha())
                   or (len(p) == 3 and p.isdigit())), "")
    same = sorted(t for t in available if t.split("-")[0].lower() == lang)
    if not same:
        return None
    def find(name: str) -> str | None:
        return lower.get(name.lower())
    if lang == "zh":
        want = script or ("Hant" if region in ("TW", "HK", "MO") else "Hans")
        return find(f"zh-{want}")
    if lang == "es" and region in _ES_419 and find("es-419"):
        return find("es-419")
    if lang == "pt":
        return find("pt-BR" if region in ("", "BR") else "pt-PT") or same[0]
    return find(lang) or same[0]


class Words:
    """The converter's phrases in one language, English for one it lacks
    (``fell_back`` then True)."""

    def __init__(self, tag: str) -> None:
        table = load_words()
        self.english = table[ENGLISH]
        found = match_tag(tag, list(table))
        self.own = table.get(found, {}) if found else {}
        self.is_english = found == ENGLISH
        self.fell_back = False

    def say(self, key: str, **params: str) -> str:
        full = KEY + key
        text = self.own.get(full)
        if text is None:
            text = self.english.get(full, "")
            self.fell_back = self.fell_back or not self.is_english
        for param, value in params.items():
            text = text.replace("{" + param + "}", value)
        return text


def name_for(names: dict[str, Any], var: str, tag: str, base: str) -> str:
    """The reader's words for ``var`` in ``tag``: the names file's one
    string, or its entry for the language (matched as match_tag does),
    else for the base language, else the variable's name."""
    entry = names.get(var)
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict):
        for want in (tag, base):
            found = match_tag(want, list(entry))
            if found is not None:
                return entry[found]
    return var


def names_option(text: str) -> dict[str, Any]:
    """`--condition-names FILE`: a JSON object mapping a variable to its
    reader words, a string for every language or an object of language
    tag to string. ValueError (argparse's message) when it is not."""
    try:
        data = json.loads(Path(text).read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"cannot read {text}: {exc.strerror or exc}") \
            from None
    except ValueError as exc:
        raise ValueError(f"{text} is not JSON: {exc}") from None
    if not isinstance(data, dict):
        raise ValueError(f"{text} is not a JSON object of variable names")
    for var, entry in data.items():
        if isinstance(entry, str) and entry.strip():
            continue
        if isinstance(entry, dict) and entry and all(
                isinstance(k, str) and isinstance(v, str) and v.strip()
                for k, v in entry.items()):
            continue
        raise ValueError(
            f"{text}: {var!r} must name the variable in words: a string, "
            "or an object of language tag to string")
    return data


# --------------------------------------------------------------------------
# prepare: kinds, dead arms, labels
# --------------------------------------------------------------------------

Before = Callable[[Any, dict[str, Any], Any],
                  list[tuple[Any, str | None]] | None]


def _followed(var: str, sets: list[Assignment],
              choice_of: dict[str, tuple[Any, int]],
              before: Before | None = None,
              ) -> tuple[Any, list[Any], dict[str, Any] | None] | None:
    """(the menu record, each choice's value, where the value of the
    choices that set nothing came from when label flow reset it, as
    ChainCondition.start) when every assignment of ``var`` but one
    `default`/`define` is a literal, in that one menu's choice blocks or
    in label flow before it (item 6c: ``before``, the walk's
    Resets.values_before, gives the one value those leave as the menu
    opens, which the choices that set nothing keep); else None."""
    defaults = [a for a in sets if a.op in ("default", "define")]
    others = [a for a in sets if a.op not in ("default", "define")]
    if len(defaults) > 1 or not others:
        return None
    default = defaults[0].literal() if defaults else None
    if default is UNKNOWN:
        return None
    chosen = [a for a in others if a.source in choice_of]
    resets = [a for a in others if a.source not in choice_of]
    if not chosen or len({id(choice_of[a.source][0]) for a in chosen}) != 1:
        return None
    if any(a.op != "=" or a.literal() is UNKNOWN for a in others):
        return None
    record = choice_of[chosen[0].source][0]
    if getattr(record, "condition", None) is not None:
        return None
    initial = default
    start = None
    if resets:
        got = None if before is None else before(
            record, {a.source: a.literal() for a in resets}, default)
        if not got:
            return None
        initial = got[0][0]
        if any(type(v) is not type(initial) or v != initial
               for v, _source in got):
            return None
        start = {"value": initial,
                 "resets": [s for _v, s in got if s is not None],
                 "default": defaults[0].source
                 if defaults and any(s is None for _v, s in got) else None}
    values = [initial] * len(record.choices)
    for a in chosen:
        values[choice_of[a.source][1]] = a.literal()
    if len({choice_of[a.source][1] for a in chosen}) == len(values):
        start = None   # every choice sets it: no choice keeps the start
    return record, values, start


def start_sources(start: dict[str, Any]) -> str:
    """Where a ChainCondition.start (or the ledger's `startingValue`)
    came from, in words: "the reset at A", "the resets at A and B" (each
    last on a way to the menu), then "and the default at C" when a way
    passes none."""
    resets = [str(r) for r in start.get("resets") or []]
    said = (f"the reset{'s' if len(resets) != 1 else ''} at "
            + (", ".join(resets[:-1]) + " and " + resets[-1]
               if len(resets) > 1 else "".join(resets)))
    if start.get("default"):
        said += f" and the default at {start['default']}"
    return said


def classify(cond: ChainCondition, sets: list[Assignment],
             choice_of: dict[str, tuple[Any, int]],
             before: Before | None = None) -> list[int]:
    """Set ``cond``'s kind and phrases (and for `follows` its record and
    `when`); the arms no value takes, which the caller drops. ``before``
    as for _followed."""
    var = cond.variable
    count = len(cond.tests)
    cond.drop_when_following = [False] * count
    cond.phrases = [("otherwise",)] * count
    followed = _followed(var, sets, choice_of, before)
    if followed is not None:
        record, values, cond.start = followed
        taken: list[list[int]] = [[] for _ in range(count)]
        for c, value in enumerate(values):
            taken[cond.arm_of(value)].append(c)
        cond.kind, cond.follow, cond.when = "follows", record, taken
        for k in range(count):
            if taken[k]:
                cond.phrases[k] = ("chose", or_join(
                    [("text", record.choices[c]) for c in taken[k]]))
        explicit = sum(1 for k in range(count - 1) if taken[k])
        if cond.absent_else and taken[-1] and explicit >= 2:
            cond.drop_when_following[-1] = True
        return [k for k in range(count) if not taken[k]]
    known = [a.literal() for a in sets]
    ranges = [t.whole_numbers() if t is not None else [] for t in cond.tests]
    numeric = all(r is not None for r in ranges) and all(
        v is UNKNOWN or _whole(v) for v in known) and (
        any(a.op in ("+=", "-=") for a in sets)
        or any(_whole(v) for v in known)
        or any(t is not None and t.op in ORDERING for t in cond.tests))
    if numeric:
        cond.kind = "ranges"
        before: Ranges = []
        dead = []
        for k, test in enumerate(cond.tests):
            own = complement(before) if test is None \
                else minus(ranges[k] or [], before)
            before = union(before, own)
            if not own:
                dead.append(k)
            else:
                cond.phrases[k] = range_phrase(var, own, test is None)
        return dead
    cond.kind = "words"
    taking: list[list[Assignment]] = [[] for _ in range(count)]
    for a, value in zip(sets, known):
        if value is UNKNOWN:
            for arm in taking:
                arm.append(a)
        else:
            taking[cond.arm_of(value)].append(a)
    dead = []
    for k, test in enumerate(cond.tests):
        arm = taking[k]
        if not arm:
            dead.append(k)
            continue
        if all(a.source in choice_of for a in arm):
            choices = list(dict.fromkeys(
                choice_of[a.source][0].choices[choice_of[a.source][1]]
                for a in arm))
            cond.phrases[k] = ("chose", or_join([("text", c)
                                                 for c in choices]))
            continue
        if test is None:
            earlier = [t for t in cond.tests[:k] if t is not None]
            test = earlier[0].negated() if len(earlier) == 1 else None
        phrase = words_phrase(var, test) if test is not None else None
        cond.phrases[k] = phrase or ("otherwise",)
    return dead


def call_picks(cond: ChainCondition, sets: list[Assignment],
               params_of: dict[str, list[Param]],
               sites_of: dict[str, list[tuple[str | None, str]]]
               ) -> list[Any] | str | None:
    """The values every call (or jump) of the chain's label gives its
    variable, when it is that label's parameter, each is a literal (an
    argument or the parameter's default) and nothing else in the label's
    block sets it (item 9k): the walk then takes, at each call, the arm
    its value picks. Why not, for a call that gives no literal (the
    reader picks: a words decision); None for a chain on anything but
    its label's parameter."""
    var, label = cond.variable, cond.label or ""
    params = params_of.get(label)
    if params is None or not any(p.name == var for p in params):
        return None
    if any(a.scope == cond.label and a.op not in ("parameter", "argument")
           for a in sets):
        return None
    values = []
    for args, source in sites_of.get(label) or [(None, "")]:
        value = call_values(args, params)[var]
        if value is UNKNOWN:
            text = _argument_text(args, params, var)
            why = (Assignment(var, "=", text, source).unread() if text
                   else f"is a parameter of label {label} that the call "
                        "gives no literal")
            return f"{var} {why} at {source or 'a call of ' + label}"
        values.append(value)
    return values


def _argument_text(args: str | None, params: list[Param], var: str
                   ) -> str | None:
    """The expression a call's argument list ``args`` gives parameter
    ``var``, as written, None when it gives none."""
    try:
        call = ast.parse(f"f({args or ''})", mode="eval").body
    except (SyntaxError, ValueError):
        return None
    if not isinstance(call, ast.Call):
        return None
    for keyword in call.keywords:
        if keyword.arg == var:
            return ast.unparse(keyword.value)
    positional = [p.name for p in params if p.positional]
    if var in positional and positional.index(var) < len(call.args):
        node = call.args[positional.index(var)]
        if not isinstance(node, ast.Starred):
            return ast.unparse(node)
    return None


def pick(cond: ChainCondition, values: list[Any]) -> list[int]:
    """Make ``cond`` a ``pick`` (call_picks gave ``values``); the arms no
    call's value takes, which the caller drops."""
    count = len(cond.tests)
    cond.kind = "pick"
    cond.unread = None
    cond.drop_when_following = [False] * count
    cond.phrases = [("otherwise",)] * count
    taken = {cond.arm_of(value) for value in values}
    return [k for k in range(count) if k not in taken]


def never_taken(cond: ChainCondition, places: int) -> str:
    """Why an arm classify found dead never runs: a counter's arm whose
    numbers the arms before it took, else one no value takes, which
    read_chain allows only when it read every place that sets the
    variable (item 9k)."""
    if cond.kind == "ranges":
        return "the arms before it take every whole number it tests"
    if cond.kind == "pick":
        return (f"no call of label {cond.label} gives {cond.variable} a "
                "value it takes")
    every = f"all {places}" if places > 1 else "the one"
    plural = "s" if places > 1 else ""
    return (f"{every} place{plural} that set{'' if plural else 's'} "
            f"{cond.variable} {'are' if plural else 'is'} read, and none "
            "gives a value it takes")


def _dead_records(events: list[Any], parsed: Any, reason: str) -> None:
    for event in events:
        flow = getattr(event, "flow", None)
        if event.kind == "fork" and flow is not None \
                and flow.menu is not None:
            parsed.menus[flow.menu].skip_reason = reason
            for body in flow.bodies:
                _dead_records(body, parsed, reason)


def prepare(parses: list[tuple[str, Any]], base: str | None = None,
            names: dict[str, Any] | None = None,
            start_label: str | None = None) -> None:
    """Classify every chain the parser read (classify), drop the arms no
    value takes (reported) and read a chain left with one arm in line;
    word the rest in the ``base`` language (default English) with the
    ``names`` file's words. Label flow's resets before a menu are placed
    by the walk's program from ``start_label`` (default `start`;
    kinetic_extract.flow.Resets, built once, when a chain needs it).
    Runs once per chain."""
    from .flow import Resets
    from .parser import Report

    base = base or ENGLISH
    names = names or {}
    every = by_variable([a for _rel, parsed in parses
                         for a in getattr(parsed, "assignment_scan", [])])
    choice_of: dict[str, tuple[Any, int]] = {}
    for _rel, parsed in parses:
        for record in parsed.menus:
            for k, sources in enumerate(
                    getattr(record, "assignment_sources", [])):
                for source in sources:
                    choice_of[source] = (record, k)

    # Item 9k: each label's parameters, and each label's `call`/`jump`
    # sites' argument lists (None: none).
    params_of: dict[str, list[Param]] = {}
    sites_of: dict[str, list[tuple[str | None, str]]] = {}
    for _rel, parsed in parses:
        for label, params in getattr(parsed, "label_params", {}).items():
            params_of.setdefault(label, params)
        for label, args, source in getattr(parsed, "call_sites", []):
            sites_of.setdefault(label, []).append((args, source))

    resets: list[Resets] = []

    def before(record: Any, sets: dict[str, Any],
               initial: Any) -> list[tuple[Any, str | None]] | None:
        if not resets:
            resets.append(Resets(parses, start_label))
        return resets[0].values_before(record, sets, initial)

    def process(events: list[Any], parsed: Any) -> list[Any]:
        out: list[Any] = []
        for event in events:
            flow = getattr(event, "flow", None)
            if event.kind != "fork" or flow is None or flow.menu is None:
                out.append(event)
                continue
            record = parsed.menus[flow.menu]
            cond = record.condition
            if cond is not None and not cond.prepared:
                cond.prepared = True
                cond.base, cond.names = base, names
                sets = every.get(cond.variable, [])
                values = call_picks(cond, sets, params_of, sites_of)
                if isinstance(values, str):
                    cond.unread, values = values, None
                if values is not None:
                    dead = pick(cond, values)
                else:
                    if cond.unread:
                        # The reader picks: no value is known, so every
                        # arm is one some value takes.
                        sets = sets + [Assignment(cond.variable, "python",
                                                  "", "")]
                    dead = classify(cond, sets, choice_of, before)
                for k in reversed(dead):
                    if cond.heads[k]:
                        parsed.reports.append(Report(
                            cond.sources[k], cond.heads[k],
                            "if arm never taken: "
                            + never_taken(cond, len(sets))
                            + "; its lines left out"))
                    _dead_records(flow.bodies[k], parsed,
                                  "inside an if arm never taken")
                    for column in (flow.bodies, record.choices,
                                   record.choice_sources, cond.tests,
                                   cond.heads, cond.sources, cond.phrases,
                                   cond.drop_when_following):
                        del column[k]
                    if cond.when:
                        del cond.when[k]
                if len(flow.bodies) == 1:
                    head = cond.heads[0] or "the absent else"
                    giver = (f"call of label {cond.label} gives"
                             if cond.kind == "pick" else
                             "value the script gives")
                    record.skip_reason = (
                        f"every {giver} {cond.variable} takes one arm "
                        f"({head}): read in line")
                    out += process(flow.bodies[0], parsed)
                    continue
                if cond.kind == "pick":
                    record.skip_reason = (
                        f"each call of label {cond.label} takes the arm "
                        f"its {cond.variable} picks: no decision")
                    out.append(type(event)(
                        "fork", event.source, text=event.text,
                        flow=type(flow)(
                            "fork", flow.source, flow.statement,
                            bodies=[process(body, parsed)
                                    for body in flow.bodies],
                            pick=cond)))
                    continue
                prompt, labels, asides, fell = cond.render(base)
                record.prompt, record.choices = prompt, labels
                cond.asides = asides
                if fell:
                    cond.english_for.add(base)
            flow.bodies[:] = [process(body, parsed) for body in flow.bodies]
            out.append(event)
        return out

    for _rel, parsed in parses:
        parsed.events[:] = process(parsed.events, parsed)


def chains(parses: list[tuple[str, Any]]) -> list[ChainCondition]:
    """Every chain the parser read, in file order."""
    return [record.condition for _rel, parsed in parses
            for record in parsed.menus
            if getattr(record, "condition", None) is not None]
