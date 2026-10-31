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
  walk; ``menu`` and other blocks are skipped, with ``menu`` reported as an
  unsupported branch.
- ``jump``/``call`` targets known in the same file are noted and the walk
  continues linearly (no real control flow); unknown targets are reported as
  cross-file calls/jumps.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

_DEFINE_CHAR_RE = re.compile(
    r"define\s+([A-Za-z_]\w*)\s*=\s*Character\(\s*\"((?:[^\"\\]|\\.)*)\"")
_SPEAKER_SAY_RE = re.compile(r"([A-Za-z_]\w*)\s+\"")
_LABEL_HEAD_RE = re.compile(r"^label\s+([A-Za-z_]\w*)")

# Block-opening keywords whose contents the walker skips silently (the
# statement itself is recognized).
_QUIET_BLOCK_KEYWORDS = frozenset({"init", "python", "screen", "transform"})
# Single-line statements skipped without a report.
_QUIET_STATEMENT_KEYWORDS = frozenset(
    {"window", "with", "pause", "return", "default", "$"})

_QUOTE_ESCAPES = {"\"": "\"", "\\": "\\", "n": "\n", "#": "#", "[": "["}


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


def strip_comment(line: str) -> str:
    """Remove a ``#`` comment that is not inside a quoted string."""
    in_quote = False
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == "\\" and in_quote and i + 1 < len(line):
            i += 2
            continue
        if ch == "\"":
            in_quote = not in_quote
        elif ch == "#" and not in_quote:
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
class Event:
    """A recognized statement in linear flow order."""

    kind: str            # visual | video | dialogue | stop-movie | label
    source: str
    text: str = ""       # dialogue text (dialogue events)
    speaker: str | None = None
    asset: str | None = None   # source image/video path relative to game/
    name: str | None = None    # image name (visual) or raw statement text


@dataclass
class FileParse:
    """Result of parsing one .rpy file."""

    relname: str
    events: list[Event] = field(default_factory=list)
    image_defs: dict[str, str] = field(default_factory=dict)   # name -> file
    characters: dict[str, str] = field(default_factory=dict)   # var -> display
    reports: list[Report] = field(default_factory=list)


def _label_names(lines: list[str]) -> set[str]:
    """All label names defined in the file (for jump/call resolution)."""
    names: set[str] = set()
    for line in lines:
        m = _LABEL_HEAD_RE.match(line)
        if m:
            names.add(m.group(1))
    return names


def _name_tokens(rest: str) -> str:
    """Image-name tokens of a scene/show statement, up to `at`/`with`."""
    parts: list[str] = []
    tokens = rest.split()
    for tok in tokens:
        if tok in {"at", "with"}:
            break
        parts.append(tok)
    return " ".join(parts)


def _split_image_def(rest: str) -> tuple[str, str | None]:
    """Split `name "file"` (Ren'Py also allows `name = "file"`).

    Returns (image name, file or None when the line has no quoted file).
    """
    quote_at = rest.find("\"")
    if quote_at == -1:
        return _name_tokens(rest), None
    name = rest[:quote_at]
    if name.rstrip().endswith("="):
        name = name.rstrip()[:-1]
    parsed = _parse_quoted(rest, quote_at)
    return " ".join(name.split()), parsed[0] if parsed else None


def parse_file(text: str, relname: str) -> FileParse:
    """Parse one .rpy source; never raises on unknown statements."""
    result = FileParse(relname=relname)
    raw_lines = text.lstrip("\ufeff").splitlines()
    labels = _label_names(raw_lines)

    skip_indent: int | None = None  # depth of the line that opened a block
    for lineno, raw in enumerate(raw_lines, start=1):
        content = strip_comment(raw)
        if not content.strip():
            continue
        indent = len(content) - len(content.lstrip(" \t"))
        if skip_indent is not None:
            if indent > skip_indent:
                continue
            skip_indent = None
        line = content.strip()
        source = f"{relname}:{lineno}"
        keyword = line.split(" ", 1)[0].split(":", 1)[0]
        rest = line[len(keyword):].strip()
        if rest.startswith(":"):
            rest = rest[1:].strip()

        def open_block() -> None:
            nonlocal skip_indent
            if line.endswith(":"):
                skip_indent = indent

        if keyword == "define":
            m = _DEFINE_CHAR_RE.match(line)
            if m:
                name, display = m.group(1), _parse_quoted(f"\"{m.group(2)}\"", 0)
                result.characters[name] = display[0] if display else m.group(2)
            # other defines: skipped silently
            continue
        if keyword in {"$", "default"}:
            continue
        if keyword in _QUIET_STATEMENT_KEYWORDS:
            continue
        if keyword == "image":
            head, quoted = _split_image_def(rest)
            if quoted is None:
                result.reports.append(
                    Report(source, line, "image without a file"))
            else:
                result.image_defs[head] = quoted
            continue
        if keyword == "scene":
            name = _name_tokens(rest)
            result.events.append(
                Event("visual", source, name=name or "black"))
            continue
        if keyword == "show":
            if rest.startswith("layer "):
                result.reports.append(
                    Report(source, line, "transform statement (reported, skipped)"))
                open_block()
                continue
            name = _name_tokens(rest)
            if name:
                result.events.append(
                    Event("visual", source, name=name))
            else:
                result.reports.append(Report(source, line, "show without an image"))
            continue
        if keyword == "hide":
            result.reports.append(
                Report(source, line, "hide skipped (visual unchanged)"))
            continue
        if keyword == "movie":
            quoted = _parse_quoted(rest, rest.find("\""))
            if quoted is None:
                result.reports.append(
                    Report(source, line, "movie without a file"))
            else:
                result.events.append(Event("video", source, asset=quoted[0]))
            continue
        if keyword == "stop":
            if rest == "movie":
                result.events.append(Event("stop-movie", source))
            else:
                result.reports.append(
                    Report(source, line, f"unsupported statement: {line}"))
            open_block()
            continue
        if keyword == "menu":
            result.reports.append(
                Report(source, line, "menu unsupported: branch skipped, "
                                     "linear flow kept"))
            open_block()
            continue
        if keyword == "label":
            # The label body is the linear flow itself: never skipped. The
            # event marks the position so a slice can start here (--label).
            m = _LABEL_HEAD_RE.match(line)
            if m:
                result.events.append(Event("label", source, name=m.group(1)))
            continue
        if keyword in {"jump", "call"}:
            target = rest.split(":", 1)[0].split()[0] if rest.split() else ""
            if not target:
                result.reports.append(
                    Report(source, line, f"{keyword} without a target"))
            elif target in labels:
                result.reports.append(
                    Report(source, line,
                           f"{keyword} {target}: followed linearly"))
            else:
                result.reports.append(
                    Report(source, line,
                           f"{keyword} target {target!r} not in this file "
                           "(cross-file call)"))
            open_block()
            continue
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


def parse_project(game_dir: Path, files_glob: str | None = None,
                  ) -> tuple[list[tuple[str, FileParse]],
                             dict[str, str], dict[str, str]]:
    """Parse game/*.rpy in filename order, or only the files matching
    ``files_glob`` (a pattern relative to game/, still in filename order).

    Returns (per-file parses, merged image defs, merged character defs).
    Concatenating files in filename order is an MVP simplification.
    """
    files = sorted(game_dir.glob(files_glob or "*.rpy"))
    project_root = game_dir.parent
    parses: list[tuple[str, FileParse]] = []
    image_defs: dict[str, str] = {}
    characters: dict[str, str] = {}
    for path in files:
        rel = path.resolve().relative_to(project_root.resolve()).as_posix()
        text = path.read_text(encoding="utf-8-sig")
        parsed = parse_file(text, rel)
        parses.append((rel, parsed))
        image_defs.update(parsed.image_defs)
        characters.update(parsed.characters)
    return parses, image_defs, characters
