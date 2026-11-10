"""Ren'Py audio statements read from script text (docs/plan.md Phase 47,
item 8).

This module is syntax only: it turns one line into an ``AudioStatement``
(or the reason it cannot be converted) and reads the init-time settings
the cue mapping needs (``define audio.x``, ``register_channel``). Names
and files are resolved later, by kinetic_extract.audio_cues, once every
script has been parsed.

The forms follow Ren'Py's own parsers (renpy/common/000statements.rpy and
00voice.rpy, 8.3): ``play``, ``queue`` and ``stop`` take a channel name,
then (play and queue) a file expression, then clauses in any order:
``fadein``, ``fadeout``, ``loop``, ``noloop``, ``if_changed``, ``volume``
and ``channel``. The file expression is evaluated in the ``audio``
namespace, so a bare name means ``audio.<name>``. ``voice`` takes a file
expression alone. ``$ renpy.music.play/queue/stop(...)`` and
``renpy.sound.play/queue/stop(...)`` are read when their arguments are
literals (``renpy.sound.play`` never loops unless asked: its ``loop``
defaults to False, where the statement takes the channel's default).
"""

from __future__ import annotations

import ast
import io
import re
import tokenize
from dataclasses import dataclass, field

__all__ = [
    "AudioChannel", "AudioRef", "AudioStatement", "mentions_audio",
    "read_audio_define", "read_channel", "read_python", "read_statement",
    "EXPRESSION", "PLAYLIST", "PYTHON", "SET_VOLUME", "SUSTAIN",
    "UNPARSEABLE",
]

# Report reasons for forms that are recognized but not converted.
EXPRESSION = ("audio file named by an expression or variable: "
              "not converted")
PLAYLIST = "playlist: only the first track converted"
PYTHON = ("audio Python other than a literal renpy.music or renpy.sound "
          "call: not converted")
SET_VOLUME = "set_volume not converted"
SUSTAIN = "voice sustain not converted"
UNPARSEABLE = "audio statement not understood: not converted"

_FLAGS = {"loop": ("loop", True), "noloop": ("loop", False),
          "if_changed": ("if_changed", True)}
_VALUE_CLAUSES = {
    "play": {"fadein", "fadeout", "volume", "channel"},
    "queue": {"fadein", "volume", "channel"},
    "stop": {"fadeout", "channel"},
}
_FLAG_CLAUSES = {"play": {"loop", "noloop", "if_changed"},
                 "queue": {"loop", "noloop"}, "stop": set()}

# The calls that start, stop or change sound. Queries such as
# `renpy.music.is_playing()` are not audio to convert.
_AUDIO_PY_RE = re.compile(
    r"renpy\.(?:music|sound)\.(?:play|queue|stop|set_volume|set_pause|"
    r"set_pan)\b|renpy\.play\s*\(")
_SCREEN_AUDIO_RE = re.compile(
    r"\b(?:Play|Queue|PlaySound|PlayCharacterVoice)\s*\(|"
    r"\b(?:activate_sound|hover_sound)\b")
# A statement, not Python that happens to start with the word
# (`stop = True`, `voice = Character(...)`).
_STATEMENT_RE = re.compile(
    r"(?:play|queue|stop)\s+[A-Za-z_]\w*\b(?!\s*[=(.\[])|voice\s+[\"'A-Za-z_]")
_DEFINE_RE = re.compile(
    r"\s*(?:define\s+(?:-?\d+\s+)?)?audio\.([A-Za-z_]\w*)\s*=\s*(.+?)\s*$")

# Positional parameters of the Python calls read, with each call's
# action, default channel and default loop (None: the channel's).
_CALLS = {
    "renpy.music.play": ("play", "music", None, (
        "filenames", "channel", "loop", "fadeout", "synchro_start",
        "fadein", "tight", "if_changed", "relative_volume")),
    "renpy.music.queue": ("queue", "music", None, (
        "filenames", "channel", "loop", "clear_queue", "fadein", "tight",
        "relative_volume")),
    "renpy.music.stop": ("stop", "music", None, ("channel", "fadeout")),
    "renpy.sound.play": ("play", "sound", False, (
        "filename", "channel", "fadeout", "fadein", "tight", "loop",
        "relative_volume")),
    "renpy.sound.queue": ("queue", "sound", False, (
        "filename", "channel", "clear_queue", "fadein", "tight", "loop",
        "relative_volume")),
    "renpy.sound.stop": ("stop", "sound", None, ("channel", "fadeout")),
}
_REGISTER_PARAMS = ("name", "mixer", "loop", "stop_on_mute", "tight",
                    "file_prefix", "file_suffix", "buffer_queue", "movie")


@dataclass(frozen=True)
class AudioRef:
    """One file reference: a string (``kind`` "file") or a name in the
    ``audio`` namespace (``kind`` "name")."""

    kind: str
    value: str


@dataclass
class AudioStatement:
    """One audio statement, before its names and files are resolved.

    ``refs`` holds the files of a play or queue (more than one is a
    playlist) or a voice line; it is empty for a stop. ``loop`` None
    means the channel's default. ``notes`` are reasons for parts of the
    statement that cannot be converted while the rest can (a fade given
    by a variable, say); the parser reports each."""

    action: str               # play | queue | stop | voice
    channel: str
    statement: str
    refs: list[AudioRef] = field(default_factory=list)
    loop: bool | None = None
    fadein: float | None = None
    fadeout: float | None = None
    volume: float | None = None
    if_changed: bool = False
    notes: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AudioChannel:
    """A channel registered with ``renpy.music.register_channel``.

    ``loop`` is the default-loop argument as written: True or False, or
    None when it was given as None. An absent argument is True: plays on
    the channel loop by default in every Ren'Py read (``Channel``'s
    constructor). An explicit None loops up to Ren'Py 8.3 and not from
    8.4, where the absent default became a sentinel; the cue mapping
    decides with the game's own Ren'Py version. ``movie`` channels play
    video, not sound."""

    name: str
    mixer: str | None = None
    loop: bool | None = True
    file_prefix: str = ""
    file_suffix: str = ""
    movie: bool = False


def _tokens(text: str) -> list[tokenize.TokenInfo] | None:
    """Python tokens of a one-line ``text`` (None when it does not
    tokenize), without the trailing NEWLINE/ENDMARKER."""
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(text).readline))
    except (tokenize.TokenError, SyntaxError, IndentationError):
        return None
    return [t for t in toks if t.type not in (
        tokenize.NEWLINE, tokenize.NL, tokenize.ENDMARKER, tokenize.COMMENT,
        tokenize.INDENT, tokenize.DEDENT)]


def _refs(node: ast.expr, bare_names: bool) -> list[AudioRef] | None:
    """The file references an expression names, or None for anything
    other than strings and audio names (a list of them is a playlist).
    ``bare_names``: a plain name means ``audio.<name>`` (statements are
    evaluated in the audio namespace; Python code is not)."""
    elements = node.elts if isinstance(node, (ast.List, ast.Tuple)) \
        else [node]
    refs: list[AudioRef] = []
    for el in elements:
        if isinstance(el, ast.Constant) and isinstance(el.value, str):
            refs.append(AudioRef("file", el.value))
        elif isinstance(el, ast.Name) and bare_names:
            refs.append(AudioRef("name", el.id))
        elif (isinstance(el, ast.Attribute) and isinstance(el.value, ast.Name)
              and el.value.id == "audio"):
            refs.append(AudioRef("name", el.attr))
        else:
            return None
    return refs or None


def _number(node: ast.expr) -> float | None:
    try:
        value = ast.literal_eval(node)
    except (ValueError, SyntaxError, TypeError):
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _parse_expr(src: str) -> ast.expr | None:
    try:
        return ast.parse(src.strip(), mode="eval").body
    except SyntaxError:
        return None


def _split_clauses(rest: str, toks: list[tokenize.TokenInfo],
                   keywords: set[str],
                   has_head: bool) -> list[tuple[str, str]]:
    """Cut ``rest`` at each clause keyword at bracket depth 0: the head
    (``""`` key) then ``(keyword, value source)`` pairs in order. With
    ``has_head`` the first token is always the head's, as Ren'Py reads
    the file expression before any clause: `play music loop` plays
    `audio.loop`."""
    parts: list[tuple[str, int, int]] = [("", 0, len(rest))]
    depth, head_seen = 0, not has_head
    for tok in toks:
        if tok.type == tokenize.OP and tok.string in "([{":
            depth += 1
        elif tok.type == tokenize.OP and tok.string in ")]}":
            depth -= 1
        elif depth == 0 and head_seen and tok.type == tokenize.NAME \
                and tok.string in keywords:
            name, start, _end = parts[-1]
            parts[-1] = (name, start, tok.start[1])
            parts.append((tok.string, tok.end[1], len(rest)))
        head_seen = True
    return [(name, rest[start:end].strip()) for name, start, end in parts]


def read_statement(line: str) -> AudioStatement | str | None:
    """Read a ``play``/``queue``/``stop``/``voice`` statement.

    Answers the statement, a report reason when it is an audio statement
    that cannot be converted, or None when the line is none of these
    (``stop movie`` is the video statement, read by the parser)."""
    keyword = line.split(None, 1)[0] if line.strip() else ""
    rest = line[len(keyword):].strip()
    if keyword == "voice":
        return _read_voice(line, rest)
    if keyword not in _VALUE_CLAUSES or not rest:
        return None
    toks = _tokens(rest)
    if not toks or toks[0].type != tokenize.NAME:
        return UNPARSEABLE
    channel = toks[0].string
    if keyword == "stop" and channel == "movie":
        return None
    rest = rest[toks[0].end[1]:]
    toks = _tokens(rest) or []
    stmt = AudioStatement(keyword, channel, line)
    flags, values = _FLAG_CLAUSES[keyword], _VALUE_CLAUSES[keyword]
    parts = _split_clauses(rest, toks, flags | values,
                           has_head=keyword != "stop")
    head = parts[0][1]
    if keyword == "stop":
        if head:
            return UNPARSEABLE
    else:
        node = _parse_expr(head) if head else None
        if node is None:
            return UNPARSEABLE if not head else EXPRESSION
        refs = _refs(node, bare_names=True)
        if refs is None:
            return EXPRESSION
        stmt.refs = refs
    for name, value in parts[1:]:
        reason = _apply_clause(stmt, name, value)
        if reason is not None:
            return reason
    return stmt


def _apply_clause(stmt: AudioStatement, name: str,
                  value: str) -> str | None:
    """Set one clause on ``stmt``; a reason when the whole statement
    cannot be converted."""
    if name in _FLAGS:
        if value:
            return UNPARSEABLE
        attr, flag = _FLAGS[name]
        setattr(stmt, attr, flag)
        return None
    node = _parse_expr(value) if value else None
    if node is None:
        return UNPARSEABLE
    if name == "channel":
        if not (isinstance(node, ast.Constant) and isinstance(node.value,
                                                                str)):
            return "audio channel named by an expression: not converted"
        stmt.channel = node.value
        return None
    number = _number(node)
    if number is None:
        stmt.notes.append(f"{name} given by an expression: ignored")
        return None
    _set_number(stmt, name, number)
    return None


def _set_number(stmt: AudioStatement, name: str, number: float) -> None:
    if name in ("volume", "relative_volume"):
        if not 0 <= number <= 1:
            stmt.notes.append(f"volume {number:g} is outside 0-1: clamped")
            number = min(max(number, 0.0), 1.0)
        stmt.volume = number
    elif name == "fadein":
        stmt.fadein = max(number, 0.0)
    elif name == "fadeout":
        stmt.fadeout = max(number, 0.0)


def _read_voice(line: str, rest: str) -> AudioStatement | str:
    if rest == "sustain":
        return SUSTAIN
    node = _parse_expr(rest) if rest else None
    if node is None:
        return UNPARSEABLE
    refs = _refs(node, bare_names=True)
    if refs is None or len(refs) != 1 or isinstance(node, (ast.List,
                                                            ast.Tuple)):
        return EXPRESSION
    return AudioStatement("voice", "voice", line, refs)


def _dotted(node: ast.expr) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{_dotted(node.value)}.{node.attr}"
    return ""


def read_python(line: str) -> AudioStatement | str | None:
    """Read a one-line ``$`` statement (``line`` with or without the
    ``$``): a literal ``renpy.music``/``renpy.sound`` play, queue or
    stop answers the statement; ``set_volume`` and any other audio
    Python answer their report reason; anything else None."""
    code = line[1:].strip() if line.startswith("$") else line.strip()
    if not _AUDIO_PY_RE.search(code):
        return None
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return PYTHON
    call = tree.body[0].value if len(tree.body) == 1 and isinstance(
        tree.body[0], ast.Expr) else None
    name = _dotted(call.func) if isinstance(call, ast.Call) else ""
    if name not in _CALLS:
        return SET_VOLUME if "set_volume" in code else PYTHON
    assert isinstance(call, ast.Call)
    return _from_call(line.strip(), name, call)


def _from_call(line: str, name: str, call: ast.Call) -> AudioStatement | str:
    action, channel, loop, params = _CALLS[name]
    if len(call.args) > len(params) or any(
            isinstance(a, ast.Starred) for a in call.args) or any(
            kw.arg is None for kw in call.keywords):
        return PYTHON
    args = dict(zip(params, call.args))
    args |= {kw.arg: kw.value for kw in call.keywords if kw.arg}
    stmt = AudioStatement(action, channel, line, loop=loop)
    files = args.pop("filenames", None) or args.pop("filename", None)
    if action != "stop":
        refs = _refs(files, bare_names=False) if files is not None else None
        if refs is None:
            return EXPRESSION
        stmt.refs = refs
    for key, node in args.items():
        reason = _call_arg(stmt, key, node)
        if reason is not None:
            return reason
    return stmt


def _call_arg(stmt: AudioStatement, key: str, node: ast.expr) -> str | None:
    if key in ("channel", "loop", "if_changed"):
        try:
            value = ast.literal_eval(node)
        except (ValueError, SyntaxError, TypeError):
            return PYTHON
        if key == "channel":
            if not isinstance(value, str):
                return PYTHON
            stmt.channel = value
        elif key == "loop":
            stmt.loop = None if value is None else bool(value)
        else:
            stmt.if_changed = bool(value)
        return None
    if key in ("fadein", "fadeout", "relative_volume"):
        number = _number(node)
        if number is None:
            label = "volume" if key == "relative_volume" else key
            stmt.notes.append(f"{label} given by an expression: ignored")
        else:
            _set_number(stmt, key, number)
    return None


def mentions_audio(line: str) -> bool:
    """True when a line the walk skips (inside a screen, a transform, a
    Python block, an unsupported menu...) plays or changes sound."""
    text = line.strip()
    if text.startswith("$"):
        text = text[1:].strip()
    if _STATEMENT_RE.match(text) and not text.startswith("stop movie"):
        return True
    return bool(_AUDIO_PY_RE.search(text) or _SCREEN_AUDIO_RE.search(text))


def read_audio_define(line: str) -> tuple[str, str | None] | None:
    """``define audio.NAME = value`` (or ``audio.NAME = value`` in an init
    block) as (name, file); the file is None when the value is not a
    string literal."""
    m = _DEFINE_RE.match(line)
    if not m:
        return None
    node = _parse_expr(m.group(2))
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return m.group(1), node.value
    return m.group(1), None


def read_channel(text: str) -> AudioChannel | None:
    """A ``register_channel(...)`` call with literal arguments (``text``
    is the whole call, possibly over several lines joined), else None."""
    start = text.find("register_channel")
    call = text[start:] if start != -1 else ""
    depth = 0
    for tok in _tokens(call) or []:
        if tok.type == tokenize.OP and tok.string in "([{":
            depth += 1
        elif tok.type == tokenize.OP and tok.string in ")]}":
            depth -= 1
            if depth == 0:
                call = call[:tok.end[1]]
                break
    node = _parse_expr(call) if call else None
    if not isinstance(node, ast.Call):
        return None
    args = dict(zip(_REGISTER_PARAMS, node.args))
    args |= {kw.arg: kw.value for kw in node.keywords if kw.arg}
    try:
        values = {k: ast.literal_eval(v) for k, v in args.items()
                  if k in _REGISTER_PARAMS}
    except (ValueError, SyntaxError, TypeError):
        return None
    name = values.get("name")
    if not isinstance(name, str):
        return None
    mixer = values.get("mixer")
    loop = values["loop"] if "loop" in values else True
    return AudioChannel(
        name, mixer if isinstance(mixer, str) else None,
        None if loop is None else bool(loop),
        str(values.get("file_prefix") or ""),
        str(values.get("file_suffix") or ""),
        bool(values.get("movie")) or name == "movie")
