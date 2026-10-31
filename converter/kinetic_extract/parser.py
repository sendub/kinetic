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

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

_DEFINE_CHAR_RE = re.compile(
    r"define\s+([A-Za-z_]\w*)\s*=\s*Character\(\s*\"((?:[^\"\\]|\\.)*)\"")
# The speaker is any identifier at the line head followed by a quoted
# string. The space between them is optional: the corpus writes both
# `em "..."` and `em"..."` (docs/extracting.md BUG 3), and the keywords
# the walker knows (`image`, `scene`, ...) are matched before this runs,
# so the looser form cannot capture them.
_SPEAKER_SAY_RE = re.compile(r"([A-Za-z_]\w*)\s*\"")
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
    # name -> ("file", quoted path) | ("expr", verbatim non-quoted value,
    # e.g. `Movie(play="x.webm")` — kinetic_extract.timeline classifies it).
    image_defs: dict[str, tuple[str, str]] = field(default_factory=dict)
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
            head, defined = _split_image_def(rest)
            if defined is None:
                result.reports.append(
                    Report(source, line, "image without a file"))
            else:
                result.image_defs[head] = defined
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
    symlinked game dir — the game-c case
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


def parse_project(game_dir: Path, files_glob: str | None = None,
                  cache_dir: Path | None = None,
                  ) -> tuple[list[tuple[str, FileParse]],
                             dict[str, str], dict[str, str], dict]:
    """Parse the project's script sources in filename order.

    ``.rpy`` sources are read directly; a ``.rpyc`` with no same-stem
    ``.rpy`` (a compiled-only script) is decompiled in memory through the
    vendored unrpyc and parsed from that text (nothing is written into the
    corpus; the text is cached — see kinetic_extract.rpyc). When both a
    ``.rpy`` and a ``.rpyc`` exist for one stem, the ``.rpy`` wins and the
    stale ``.rpyc`` is left alone (the survey's stale-twin case).

    Script members inside ``game/*.rpa`` archives join the same
    filename-ordered walk (an archive-only game like game-e keeps
    its scripts in ``scripts.rpa``); a loose file always beats an
    archive member with the same key, and the ledger names the source
    ``game/<archive>!<key>``. A ``.rpyc`` member decompiles through the
    same rpyc.py path after being extracted to the shared cache dir.

    ``files_glob`` restricts which files feed the walk (relative to
    ``game/``, filename order; default every ``.rpy`` and its ``.rpyc``).

    Returns ``(parses, image_defs, characters, sources)`` where ``parses``
    is the per-file parse list (the decompiled entries carry a
    ``.rpyc``-suffixed ``relname``) and ``sources`` records provenance for
    the ledger: ``decompiled`` (``.rpyc`` parsed via unrpyc),
    ``ignoredTwins`` (``.rpyc`` skipped because a ``.rpy`` won),
    ``failed`` (``.rpyc`` that could not be decompiled), ``rpaScripts``
    (script members read from ``.rpa`` archives), ``rpaIgnoredTwins``
    (archive members skipped because the key exists loose), and
    ``rpaFailed`` (archives whose index could not be read). Concatenating
    the files in filename order is an MVP simplification.
    """
    rpy_files = sorted(game_dir.glob(files_glob or "*.rpy"))
    rpyc_files = sorted(game_dir.glob(_rpyc_glob(files_glob)))

    # Merge both kinds into one filename-ordered plan. A .rpy always beats a
    # same-stem .rpyc (which may be stale); a .rpyc is used only when no
    # .rpy exists on disk for it.
    plan: list[tuple[str, Path | None, str, object, str]] = []
    # (sort_key, loose path or None, kind, RpaArchive or None, member key)
    sources: dict = {"decompiled": [], "ignoredTwins": [], "failed": [],
                     "rpaScripts": [], "rpaIgnoredTwins": [],
                     "rpaFailed": []}
    for path in rpy_files:
        plan.append((path.name, path, "rpy", None, ""))
    for path in rpyc_files:
        twin = path.with_suffix(".rpy")
        if twin.exists():
            sources["ignoredTwins"].append(
                {"rpyc": _ledger_rel(path, game_dir),
                 "kept": _ledger_rel(twin, game_dir)})
            continue
        plan.append((path.name, path, "rpyc", None, ""))
    from . import rpa as rpa_mod
    try:
        archive_entries, rpa_failed, rpa_ignored = rpa_mod.script_entries(
            game_dir, files_glob)
    except rpa_mod.RpaError as exc:  # index unreadable even while listing
        archive_entries, rpa_failed, rpa_ignored = [], [
            {"archive": str(game_dir), "error": str(exc)}], []
    sources["rpaFailed"].extend(rpa_failed)
    for arc in rpa_ignored:
        sources["rpaIgnoredTwins"].append(
            {"member": arc, "reason": "loose file with the same key"})
    for arc, key, kind in archive_entries:
        plan.append((Path(key).name, None, kind, arc, key))
    plan.sort(key=lambda entry: entry[0])

    parses: list[tuple[str, FileParse]] = []
    image_defs: dict[str, str] = {}
    characters: dict[str, str] = {}
    for _key, path, kind, arc, member in plan:
        if path is not None:
            rel = _ledger_rel(path, game_dir)
        else:
            rel = f"{_ledger_rel(arc.path, game_dir)}!{member}"
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
        parsed = parse_file(text, rel)
        parses.append((rel, parsed))
        image_defs.update(parsed.image_defs)
        characters.update(parsed.characters)
    return parses, image_defs, characters, sources
