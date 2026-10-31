"""Timeline builder: parse events -> ordered manifest items + ledger notes.

Model (docs/plan.md Phase 10): a linear walk of the script's flow. Each
``scene``/``show``/``movie`` sets the current visual; the first dialogue
line under a fresh visual attaches to that media item, and later lines
become ``text`` items over the same visual. ``stop movie`` ends a video
context. Media references use the ``<id>.<ext>`` naming convention of
docs/content-format.md; the real asset files arrive with the next task, so
the build ledger keeps the source asset paths.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .media import media_ext, probe_duration_seconds
from .parser import Event, FileParse, Report

_INTERPOLATION_RE = re.compile(r"\[[^][]*\]")
_SLUG_BAD_RE = re.compile(r"[^A-Za-z0-9_-]+")
# `image X = Movie(play="f.webm", ...)` (parser stores the value verbatim
# as an expression): the play file is the item's video (BUG 2).
_MOVIE_PLAY_RE = re.compile(r"\bplay\s*=\s*\"((?:[^\"\\]|\\.)*)\"")
_QUOTED_RE = re.compile(r"\"((?:[^\"\\]|\\.)*)\"")

# Image names Ren'Py renders without a file: a plain black/white screen.
_SOLID_COLORS = frozenset({"black", "white"})


def def_value_target(defined: tuple[str, str]) -> tuple[str, str | None]:
    """(kind, file) for a stored image-def value.

    A quoted file answers as an image; a `Movie(play="…")` expression
    answers as a video with that play file (docs/extracting.md BUG 2);
    any other expression falls back to its first quoted file, as before;
    an expression without a file answers (kind, None).
    """
    kind_tag, value = defined
    if kind_tag == "file":
        return "image", value
    m = _MOVIE_PLAY_RE.search(value)
    if m:
        return "video", m.group(1)
    m = _QUOTED_RE.search(value)
    return "image", m.group(1) if m else None


def _slug(name: str | None, fallback: str) -> str:
    raw = _SLUG_BAD_RE.sub("-", (name or "").strip()).strip("-")
    return raw[:60] if raw else fallback


@dataclass
class ItemRecord:
    """One manifest item plus its ledger entry.

    The asset pass (assets.py) later fills ``asset_meta`` (sniffed format,
    ship decision, sizes, shipped file) and sets ``skipped`` for items whose
    asset is unsupported; skipped items are kept in the ledger but dropped
    from the manifest.
    """

    item: dict[str, Any]
    source: str
    asset: str | None
    asset_abs: Path | None = None
    notes: list[str] = field(default_factory=list)
    asset_meta: dict[str, Any] = field(default_factory=dict)
    skipped: bool = False


@dataclass
class TimelineResult:
    items: list[ItemRecord] = field(default_factory=list)
    source_images: list[Path] = field(default_factory=list)  # for size probe

    def _next_id(self, slug: str) -> str:
        return f"{slug}-{len(self.items) + 1:03d}"


class _Pending:
    """The current visual, before lines attach to it."""

    def __init__(self, kind: str, name: str | None, asset_rel: str | None,
                 asset_abs: Path | None, source: str, from_archive: bool
                 = False):
        self.kind = kind          # image | video
        self.name = name
        self.asset_rel = asset_rel   # project-root-relative, for the ledger
        self.asset_abs = asset_abs   # on-disk path (may not exist)
        self.source = source
        # True when the asset was resolved from an .rpa archive (asset_rel
        # is then "rpa!<key>" and asset_abs the extracted cache file).
        self.from_archive = from_archive
        self.consumed = False    # a dialogue line already formed the item
        # True when no file answers this visual: it and the lines under it
        # are dropped, never shipped as a placeholder (BUG 1).
        self.unresolved = False
        # Resolution notes carried onto the item's ledger entry (e.g. an
        # ambiguous implicit name).
        self.notes: list[str] = []


class _SliceDone(Exception):
    """Raised internally to stop the walk once a slice is complete."""


def build_timeline(parses: list[tuple[str, FileParse]],
                   image_defs: dict[str, tuple[str, str]],
                   characters: dict[str, str],
                   game_dir: Path,
                   start_label: str | None = None,
                   max_items: int | None = None,
                   asset_lookup=None,
                   implicit_lookup=None,
                   ) -> TimelineResult:
    """Walk all parsed files (already in filename order) linearly.

    Slice options (docs/plan.md Phase 11): ``start_label`` skips all flow
    before that label is defined; ``max_items`` stops the walk after that
    many items. Both unset (default) means the whole project.

    ``asset_lookup(rel, kind) -> ("rpa!<key>", extracted_path) | None`` is
    the .rpa archive fallback (kinetic_extract.rpa.AssetArchives.lookup):
    consulted only when a referenced asset is not on disk next to the
    script; a hit ships the extracted member instead.

    ``implicit_lookup(name, kind) -> (ledger_rel, path, from_archive,
    candidate_count) | None`` is the implicit image index
    (kinetic_extract.images.ImplicitImages.lookup): consulted when a
    scene/show name has no definition, or its defined file exists
    nowhere. Explicit definitions win over it (docs/extracting.md BUG 5).
    """
    result = TimelineResult()
    pending: _Pending | None = None
    started = start_label is None

    def check_limit() -> None:
        if max_items is not None and len(result.items) >= max_items:
            raise _SliceDone()

    def asset_paths(rel: str | None,
                    kind: str) -> tuple[str | None, Path | None, bool]:
        if rel is None:
            return None, None, False
        target = game_dir / rel
        ledger_rel = f"game/{Path(rel).as_posix()}"
        if not target.exists() and asset_lookup is not None:
            hit = asset_lookup(rel, kind)
            if hit is not None:
                return hit[0], hit[1], True
        return ledger_rel, target, False

    def flush_bare() -> None:
        """Emit an unconsumed visual (replaced or at end of flow) bare.
        An unresolved visual was already reported at its statement; it is
        dropped, never emitted (BUG 1)."""
        nonlocal pending
        if (pending is not None and not pending.consumed
                and not pending.unresolved):
            emit_media(pending, speaker=None, text=None)
        pending = None

    def emit_media(pend: _Pending, speaker: str | None,
                   text: str | None) -> ItemRecord:
        item_id = result._next_id(_slug(pend.name or pend.asset_rel,
                                        "scene" if pend.kind == "image"
                                        else "movie"))
        ext = media_ext(pend.asset_rel, pend.kind)
        item: dict[str, Any] = {"id": item_id, "type": pend.kind}
        record = ItemRecord(item=item, source=pend.source,
                            asset=pend.asset_rel, asset_abs=pend.asset_abs)
        record.notes.extend(pend.notes)
        if pend.from_archive:
            # Provenance for assets resolved out of an .rpa archive
            # (kinetic_extract.rpa.AssetArchives): the ledger asset reads
            # "rpa!<key>" and the extracted member's byte size is recorded.
            record.asset_meta["rpaSource"] = pend.asset_rel
            if pend.asset_abs is not None and pend.asset_abs.is_file():
                record.asset_meta["rpaExtractedBytes"] = (
                    pend.asset_abs.stat().st_size)
            record.notes.append(
                f"asset extracted from .rpa archive ({pend.asset_rel})")
        if pend.asset_abs is not None:
            if not pend.asset_abs.exists():
                record.notes.append(
                    f"source asset {pend.asset_rel!r} not found yet")
            elif pend.kind == "image":
                result.source_images.append(pend.asset_abs)
        else:
            record.notes.append("no source asset resolved; placeholder name")
        if pend.kind == "video":
            item["file"] = f"{item_id}.{ext}"
            item["poster"] = f"{item_id}.poster.jpg"
            duration = (probe_duration_seconds(pend.asset_abs)
                        if pend.asset_abs and pend.asset_abs.exists()
                        else None)
            if duration is None:
                duration = 1.0
                record.notes.append(
                    "durationSeconds placeholder 1.0: ffprobe unavailable "
                    "for source video")
            item["durationSeconds"] = duration
        else:
            item["file"] = f"{item_id}.{ext}"
        apply_line(item, record, speaker, text)
        result.items.append(record)
        check_limit()
        return item

    def apply_line(item: dict[str, Any], record: ItemRecord,
                   speaker: str | None, text: str | None) -> None:
        if text is None:
            return
        if speaker is not None:
            item["speaker"] = characters.get(speaker, speaker)
            if speaker in characters:
                record.notes.append(
                    f"speaker {speaker!r} display name from Character define")
        item["text"] = text
        count = len(_INTERPOLATION_RE.findall(text))
        if count:
            record.notes.append(
                f"kept {count} interpolation(s) literal in text")

    try:
        for _rel, parsed in parses:
            for event in parsed.events:
                if not started:
                    if event.kind == "label" and event.name == start_label:
                        started = True
                    continue
                check_limit()
                if event.kind == "visual":
                    name = event.name or "black"
                    if name in _SOLID_COLORS and name not in image_defs:
                        # A solid screen carries no media; the visual is
                        # cleared.
                        flush_bare()
                        parsed.reports.append(Report(
                            event.source, f"scene {name}",
                            "solid color screen: no media item"))
                        continue
                    # Resolution order (docs/extracting.md BUG 5): the
                    # explicit definition first — a `Movie(play=…)` def
                    # answers as a video (BUG 2) — then its file on disk
                    # or in the archives, then the implicit name index.
                    defined = image_defs.get(name)
                    kind, ref = def_value_target(defined) if defined \
                        else ("image", None)
                    resolved = None  # (kind, ledger_rel, abs, from_arc, n)
                    if ref is not None:
                        ledger_rel, abs_path, from_arc = asset_paths(
                            ref, kind)
                        if from_arc or (abs_path is not None
                                        and abs_path.exists()):
                            resolved = (kind, ledger_rel, abs_path,
                                        from_arc, 1)
                    if resolved is None and implicit_lookup is not None:
                        hit = implicit_lookup(
                            name, "video" if kind == "video" else "image")
                        if hit is not None:
                            ledger_rel, abs_path, from_arc, n = hit
                            resolved = (kind, ledger_rel, abs_path,
                                        from_arc, n)
                    flush_bare()
                    if resolved is None:
                        # BUG 1: an item whose visual never resolves is
                        # dropped — never shipped as a missing-file
                        # placeholder the validator and player must fail.
                        reason = (
                            f"droppedUnresolved: defined source asset "
                            f"{ref!r} not found" if ref is not None else
                            "droppedUnresolved: no image definition or "
                            "asset answers the name")
                        parsed.reports.append(
                            Report(event.source, name, reason))
                        pending = _Pending("image", name, None, None,
                                           event.source)
                        pending.unresolved = True
                        continue
                    kind, ledger_rel, abs_path, from_arc, n = resolved
                    pending = _Pending(kind, name, ledger_rel, abs_path,
                                       event.source, from_arc)
                    if n > 1:
                        chosen = ledger_rel.rsplit("!", 1)[-1]
                        pending.notes.append(
                            f"image name {name!r} is ambiguous: {n} assets "
                            f"answer it; using the first in sorted order "
                            f"({chosen})")
                elif event.kind == "video":
                    ledger_rel, abs_path, from_arc = asset_paths(
                        event.asset, "video")
                    flush_bare()
                    pending = _Pending(
                        "video", Path(event.asset or "movie").stem,
                        ledger_rel, abs_path, event.source, from_arc)
                    if not from_arc and (abs_path is None
                                         or not abs_path.exists()):
                        # Same rule as scene refs (BUG 1): the video file
                        # must exist for the item to ship.
                        parsed.reports.append(Report(
                            event.source, f"movie {event.asset}",
                            f"droppedUnresolved: video asset "
                            f"{event.asset!r} not found"))
                        pending.unresolved = True
                elif event.kind == "stop-movie":
                    flush_bare()
                elif event.kind == "dialogue":
                    if pending is not None and pending.unresolved:
                        # The line belongs to a dropped visual (BUG 1):
                        # a text item needs a visual, so it drops with it.
                        parsed.reports.append(Report(
                            event.source, event.text,
                            "droppedUnresolved: line dropped with its "
                            "unresolved visual"))
                        continue
                    if pending is not None and not pending.consumed:
                        emit_media(pending, event.speaker, event.text)
                        pending.consumed = True
                    else:
                        item_id = result._next_id("line")
                        item: dict[str, Any] = {"id": item_id,
                                                "type": "text"}
                        record = ItemRecord(item=item, source=event.source,
                                            asset=None)
                        if pending is None:
                            record.notes.append(
                                "dialogue with no preceding visual in flow")
                        apply_line(item, record, event.speaker, event.text)
                        result.items.append(record)
                        check_limit()
            flush_bare()
    except _SliceDone:
        pass

    if start_label is not None and not started:
        raise SystemExit(
            f"kinetic-extract: label {start_label!r} not found in the "
            "parsed script")
    if not result.items and start_label is None and max_items is None:
        raise SystemExit("kinetic-extract: script produced no items")
    return result
