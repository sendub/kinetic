"""Ren'Py's presentation the converter carries (docs/plan.md Phase 57
item 4; docs/extracting.md, "Colours and transitions").

Two readings, both of literals only:

- Speaker colours: a `define x = Character(...)`'s literal `color`,
  `who_color` and `what_color`, inherited through a literal `kind=`, as
  the manifest's `characters` entries (docs/content-format.md,
  "Characters").
- Transitions: a `with` expression (a clause on `scene`/`show`/`hide` or
  a bare `with` statement) as an item `transition`
  (docs/content-format.md, "Transitions"): Ren'Py's `dissolve` and
  `fade`, `Dissolve(t)`, `Fade(out, hold, in)` and names `define`d as
  any of those. Anything else is a cut, counted by name.

The parser keeps the raw statements (kinetic_extract.parser); this
module reads them, and the timeline applies them.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from .parser import (_DEFINE_CHAR_RE, _KEYWORD_ARG_RE, FileParse, Report,
                     _call_arguments, _literal_value)

# The colour forms Ren'Py's Color reads from a string, `#` optional:
# rgb, rgba, rrggbb, rrggbbaa.
_HEX_RE = re.compile(r"#?([0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})")
_STRING_RE = re.compile(r"""("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')""")
_NUMBER_RE = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")
_NAME_RE = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*")
_CALL_RE = re.compile(r"([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(")

# Ren'Py's own transitions with fixed values, from
# renpy/common/00definitions.rpy: `define dissolve = Dissolve(0.5)` and
# `define fade = Fade(0.5, 0.0, 0.5)`.
DISSOLVE_SECONDS = 0.5
BUILTIN = {
    "dissolve": {"kind": "dissolve", "seconds": DISSOLVE_SECONDS},
    "fade": {"kind": "fade", "out": 0.5, "hold": 0.0, "in": 0.5},
}
MAX_SECONDS = 5.0      # docs/content-schema.json, $defs/dissolve and fade
_COLOR_KEYS = ("color", "who_color", "what_color")
_BLACK = "#000000"


def normalize_color(text: str) -> str | None:
    """`#rrggbb` in lowercase for a colour string as Ren'Py's Color reads
    it (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, the `#` optional), its
    alpha dropped; None for anything else."""
    m = _HEX_RE.fullmatch(text.strip())
    if m is None:
        return None
    digits = m.group(1).lower()
    if len(digits) in (3, 4):
        digits = "".join(ch * 2 for ch in digits[:3])
    return "#" + digits[:6]


def _string_literal(value: str) -> str | None:
    """The text of a whole-value string literal, else None."""
    if _STRING_RE.fullmatch(value.strip()) is None:
        return None
    return _literal_value(value.strip())


# --- speaker colours ------------------------------------------------------

@dataclass(frozen=True)
class CharacterColors:
    """A Character define's colours, after `kind=` inheritance."""

    var: str
    source: str          # "game/script.rpy:3"
    order: int           # definition order across the walked files
    name_color: str | None
    text_color: str | None

    def entry(self) -> dict[str, str]:
        """The manifest `characters` entry."""
        out: dict[str, str] = {}
        if self.name_color:
            out["nameColor"] = self.name_color
        if self.text_color:
            out["textColor"] = self.text_color
        return out


@dataclass
class _Define:
    source: str
    statement: str
    order: int
    kind: str | None
    own: dict[str, str]          # "name" / "text" -> #rrggbb


def _read_define(statement: str, source: str, order: int,
                 reports: list[Report]) -> tuple[str, _Define] | None:
    """A Character define's own literal colours and `kind=` name; the
    colours it cannot read are reported."""
    m = _DEFINE_CHAR_RE.match(statement)
    if m is None:
        return None
    args = _call_arguments(statement, m.end())
    if args is None:
        return None
    found: dict[str, str] = {}
    kind = None
    for arg in args:
        kw = _KEYWORD_ARG_RE.fullmatch(arg)
        if kw is None:
            continue
        key, value = kw.group(1), kw.group(2).strip()
        if key == "kind":
            kind = value if _NAME_RE.fullmatch(value) else None
        elif key in _COLOR_KEYS:
            text = _string_literal(value)
            color = normalize_color(text) if text is not None else None
            if color is None:
                reports.append(Report(source, statement, (
                    f"Character {key}={value} is not a literal colour: "
                    "not converted")))
            else:
                found[key] = color
    own: dict[str, str] = {}
    name = found.get("who_color") or found.get("color")
    if name:
        own["name"] = name
    if "what_color" in found:
        own["text"] = found["what_color"]
    return m.group(1), _Define(source, statement, order, kind, own)


def character_colors(parses: list[tuple[str, FileParse]],
                     ) -> dict[str, CharacterColors]:
    """Variable -> colours of every Character define in the walked
    files, a later define of a variable replacing an earlier one (as
    Ren'Py's `define` does). A literal `kind=` naming another define
    inherits its colours under the define's own; any other `kind`
    (Ren'Py's `adv`, `nvl`, an expression) gives nothing. Unreadable
    colours are reported in their file's parse."""
    defines: dict[str, _Define] = {}
    order = 0
    for _rel, parsed in parses:
        for var, (source, statement) in parsed.character_defs.items():
            read = _read_define(statement, source, order, parsed.reports)
            order += 1
            if read is not None:
                defines[read[0]] = read[1]

    resolved: dict[str, dict[str, str]] = {}

    def colors_of(var: str, seen: frozenset[str]) -> dict[str, str]:
        if var in resolved:
            return resolved[var]
        define = defines[var]
        inherited: dict[str, str] = {}
        if define.kind in defines and define.kind not in seen:
            inherited = colors_of(define.kind, seen | {var})
        resolved[var] = {**inherited, **define.own}
        return resolved[var]

    out: dict[str, CharacterColors] = {}
    for var, define in defines.items():
        colors = colors_of(var, frozenset({var}))
        if colors:
            out[var] = CharacterColors(var, define.source, define.order,
                                       colors.get("name"),
                                       colors.get("text"))
    return out


def characters_table(candidates: list[dict[str, list[CharacterColors]]],
                     speakers: set[str], reports: list[Report],
                     ) -> dict[str, dict[str, str]]:
    """The manifest's `characters`: for each speaker an item shows, the
    colours of the first define (in definition order; several projects
    in project order) with that display name and a colour. A later
    define with the same name and other colours is reported."""
    table: dict[str, dict[str, str]] = {}
    for speaker in sorted(speakers):
        found = [c for per_project in candidates
                 for c in sorted(per_project.get(speaker, []),
                                 key=lambda c: c.order)]
        if not found:
            continue
        first = found[0]
        table[speaker] = first.entry()
        for other in found[1:]:
            if other.entry() != first.entry():
                reports.append(Report(other.source, f"define {other.var}", (
                    f"speaker {speaker!r} has other colours here than at "
                    f"{first.source}: the first define is kept")))
    return table


# --- transitions ----------------------------------------------------------

@dataclass(frozen=True)
class Resolved:
    """A `with` expression read: the item `transition`, or the name it
    is cut under, and any notes about how it was read."""

    transition: dict[str, Any] | None
    cut: str | None = None
    notes: tuple[str, ...] = ()


def _number(value: str | None) -> float | None:
    if value is None or _NUMBER_RE.fullmatch(value.strip()) is None:
        return None
    return float(value)


def _call_args(expr: str) -> tuple[str, list[str], dict[str, str]] | None:
    """(callee, positional, keyword) of a whole-expression call."""
    m = _CALL_RE.match(expr)
    if m is None:
        return None
    args = _call_arguments(expr, m.end())
    if args is None:
        return None
    # The call must be the whole expression.
    depth_end = _call_end(expr, m.end())
    if depth_end is None or expr[depth_end:].strip():
        return None
    positional: list[str] = []
    keyword: dict[str, str] = {}
    for arg in args:
        kw = _KEYWORD_ARG_RE.fullmatch(arg)
        if kw is None:
            positional.append(arg)
        else:
            keyword[kw.group(1)] = kw.group(2).strip()
    return m.group(1), positional, keyword


def _call_end(text: str, start: int) -> int | None:
    """The index after the `)` closing the call opened before `start`."""
    depth, quote, i = 0, "", start
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
                return i + 1
            depth -= 1
        i += 1
    return None


def _arg(positional: list[str], keyword: dict[str, str], index: int,
         *names: str) -> str | None:
    if index < len(positional):
        return positional[index]
    for name in names:
        if name in keyword:
            return keyword[name]
    return None


def _clamp(value: float, low: float, what: str,
           notes: list[str]) -> float:
    clamped = min(max(value, low), MAX_SECONDS)
    if clamped != value:
        notes.append(f"{what} {value:g} s clamped to {clamped:g} s")
    return clamped


def _dissolve(positional: list[str], keyword: dict[str, str],
              name: str) -> Resolved:
    seconds = _number(_arg(positional, keyword, 0, "time"))
    if seconds is None:
        return Resolved(None, name)
    if seconds <= 0:
        return Resolved(None, f"{name}({seconds:g})")
    notes: list[str] = []
    seconds = _clamp(seconds, 0, f"{name} time", notes)
    return Resolved({"kind": "dissolve", "seconds": seconds}, None,
                    tuple(notes))


def _fade(positional: list[str], keyword: dict[str, str],
          name: str) -> Resolved:
    times = [_number(_arg(positional, keyword, 0, "out_time")),
             _number(_arg(positional, keyword, 1, "hold_time")),
             _number(_arg(positional, keyword, 2, "in_time"))]
    if any(t is None for t in times):
        return Resolved(None, name)
    notes: list[str] = []
    out, hold, fade_in = (_clamp(t, 0, f"{name} {part}", notes)
                          for t, part in zip(times, ("out", "hold", "in")))
    if out == 0 and fade_in == 0:
        return Resolved(None, f"{name}(0, {hold:g}, 0)")
    color_arg = keyword.get("color")
    if color_arg is None and len(positional) > 3:
        color_arg = positional[3]
    if color_arg is not None:
        text = _string_literal(color_arg)
        color = normalize_color(text) if text is not None else None
        if color != _BLACK:
            notes.append(f"{name} colour {color or color_arg} drawn as "
                         "black (the fade goes through black)")
    return Resolved({"kind": "fade", "out": out, "hold": hold,
                     "in": fade_in}, None, tuple(notes))


def _cut_name(expr: str) -> str:
    """The name a cut is counted under: the name as written, a call's
    callee, or the expression itself, shortened."""
    m = _CALL_RE.match(expr)
    if m is not None:
        return m.group(1)
    return expr if len(expr) <= 40 else expr[:37] + "..."


def resolve_transition(expr: str, defines: dict[str, str],
                       depth: int = 0) -> Resolved:
    """The transition a `with` expression gives. ``defines`` are the
    walked files' `define NAME = value` texts; a name defined there wins
    over Ren'Py's built-in of the same name, as in Ren'Py. `None` and
    every other transition are cuts; a define aliasing an unsupported
    transition is cut under its own name."""
    expr = expr.strip()
    if expr == "None":
        return Resolved(None, "None")
    if _NAME_RE.fullmatch(expr):
        if expr in defines and depth < 10:
            got = resolve_transition(defines[expr], defines, depth + 1)
            if got.transition is None:
                return Resolved(None, expr)
            return got
        if expr in BUILTIN:
            return Resolved(dict(BUILTIN[expr]))
        return Resolved(None, expr)
    call = _call_args(expr)
    if call is not None:
        callee, positional, keyword = call
        if callee == "Dissolve":
            return _dissolve(positional, keyword, callee)
        if callee == "Fade":
            return _fade(positional, keyword, callee)
    return Resolved(None, _cut_name(expr))


def transition_defines(parses: list[tuple[str, FileParse]]
                       ) -> dict[str, str]:
    """Every plain `define NAME = value` of the walked files, a later one
    replacing an earlier one."""
    out: dict[str, str] = {}
    for _rel, parsed in parses:
        out.update(parsed.simple_defines)
    return out


@dataclass
class TransitionCounts:
    """What the walk made of the `with` expressions it met."""

    # Expressions read as a dissolve or a fade, applied or not.
    read: int = 0
    # Name -> times cut (`None`, an unsupported transition).
    cut: Counter[str] = field(default_factory=Counter)

    def add(self, other: TransitionCounts) -> None:
        self.read += other.read
        self.cut.update(other.cut)


def transition_summary(items: list[dict[str, Any]],
                       counts: TransitionCounts) -> tuple[str, dict]:
    """The run summary's line and the ledger's `transitions` record:
    the transitions kept on the manifest's items by kind, those read
    that changed no picture the folder shows, and the cuts by name."""
    kept = Counter(item["transition"]["kind"] for item in items
                   if isinstance(item.get("transition"), dict))
    unused = max(counts.read - sum(kept.values()), 0)
    kept_text = ", ".join(f"{kind} {kept[kind]}" for kind in sorted(kept))
    cut_text = ", ".join(f"{name} x{n}" for name, n in
                         sorted(counts.cut.items(),
                                key=lambda kv: (-kv[1], kv[0])))
    line = (f"transitions: kept {kept_text or 'none'}; "
            f"with no picture change {unused}; "
            f"cut: {cut_text or 'none'}")
    record = {"kept": dict(sorted(kept.items())), "noPictureChange": unused,
              "cut": dict(sorted(counts.cut.items()))}
    return line, record
