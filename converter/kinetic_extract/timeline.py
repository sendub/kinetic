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

from .media import probe_duration_seconds
from .parser import Event, FileParse, Report, slug as _slug

_INTERPOLATION_RE = re.compile(r"\[[^][]*\]")
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


@dataclass
class ItemRecord:
    """One manifest item plus its ledger entry.

    The asset pass (assets.py) later sets the item's ``file`` (and a video's
    ``poster``) to the content-addressed shipped path, fills ``asset_meta``
    (sniffed format, ship decision, output ``file``/``poster``) and sets
    ``skipped`` for items whose asset is missing or unsupported; skipped items are kept in the ledger but dropped
    from the manifest.
    """

    item: dict[str, Any]
    source: str
    asset: str | None
    asset_abs: Path | None = None
    # Where the asset's bytes come from, relative to the project root:
    # {"path": "game/<rel>"} for a loose file or {"archive":
    # "game/<name>.rpa", "member": "<key>"} for an archive member (the
    # ledger's `media` source, docs/extracting.md "Build ledger").
    source_ref: dict[str, str] | None = None
    notes: list[str] = field(default_factory=list)
    asset_meta: dict[str, Any] = field(default_factory=dict)
    skipped: bool = False


def set_video_duration(record: ItemRecord) -> None:
    """A video item's ``durationSeconds``, probed from its source file, or
    the placeholder 1.0 with a note when it cannot be probed (the asset
    pass re-probes a source a decoder hook changed). kinetic-extract's
    timeline and ``kinetic-media ship`` both set it here."""
    path = record.asset_abs
    duration = (probe_duration_seconds(path)
                if path is not None and path.exists() else None)
    if duration is None:
        duration = 1.0
        record.notes.append(
            "durationSeconds placeholder 1.0: ffprobe unavailable "
            "for source video")
    record.item["durationSeconds"] = duration


@dataclass
class TimelineResult:
    items: list[ItemRecord] = field(default_factory=list)
    source_images: list[Path] = field(default_factory=list)  # for size probe
    # Sizes of images a --decoder hook unwrapped (the raw files above do
    # not open); the asset pass adds them, the size probe counts them.
    decoded_sizes: list[tuple[int, int]] = field(default_factory=list)
    # Menu regions that passed the conservative shape check, as
    # {"record": MenuRecord, "after_idx": int,
    #  "route_spans": [(label, start_idx, end_idx)]}
    # with indices into ``items`` (docs/plan.md Phase 13). The CLI turns
    # these into manifest `branches` once the asset pass is known.
    branch_candidates: list[dict[str, Any]] = field(default_factory=list)

    def _next_id(self, slug: str) -> str:
        return f"{slug}-{len(self.items) + 1:03d}"


class _Pending:
    """The current visual, before lines attach to it."""

    def __init__(self, kind: str, name: str | None, asset_rel: str | None,
                 asset_abs: Path | None, source: str,
                 source_ref: dict[str, str] | None = None):
        self.kind = kind          # image | video
        self.name = name
        self.asset_rel = asset_rel   # project-root-relative, for the ledger
        self.asset_abs = asset_abs   # on-disk path (may not exist)
        self.source = source
        self.source_ref = source_ref
        # True when the asset was resolved from an .rpa archive (asset_rel
        # is then "game/<archive>!<key>" and asset_abs the extracted
        # cache file).
        self.from_archive = bool(source_ref and "archive" in source_ref)
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

    ``asset_lookup(rel, kind) -> ("game/<archive>!<key>", extracted_path,
    source_ref) | None`` is
    the .rpa archive fallback (kinetic_extract.rpa.AssetArchives.lookup):
    consulted only when a referenced asset is not on disk next to the
    script; a hit ships the extracted member instead.

    ``implicit_lookup(name, kind) -> (ledger_rel, path, source_ref,
    candidate_count) | None`` is the implicit image index
    (kinetic_extract.images.ImplicitImages.lookup): consulted when a
    scene/show name has no definition, or its defined file exists
    nowhere. Explicit definitions win over it (docs/extracting.md BUG 5).

    Media items carry no ``file``/``poster`` yet: the shipped path is the
    hash of the shipped bytes, known only once the asset pass has made
    them (docs/plan.md Phase 25).
    """
    result = TimelineResult()
    pending: _Pending | None = None
    started = start_label is None
    menu_state: dict[str, Any] | None = None  # open menu region (Phase 13)

    def check_limit() -> None:
        if max_items is not None and len(result.items) >= max_items:
            raise _SliceDone()

    def asset_paths(rel: str | None, kind: str,
                    ) -> tuple[str | None, Path | None,
                               dict[str, str] | None]:
        """(ledger rel, file path, source ref) for a script reference:
        the loose file under game/, else an archive member."""
        if rel is None:
            return None, None, None
        target = game_dir / rel
        ledger_rel = f"game/{Path(rel).as_posix()}"
        if not target.exists() and asset_lookup is not None:
            hit = asset_lookup(rel, kind)
            if hit is not None:
                return hit
        return ledger_rel, target, {"path": ledger_rel}

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
        item: dict[str, Any] = {"id": item_id, "type": pend.kind}
        record = ItemRecord(item=item, source=pend.source,
                            asset=pend.asset_rel, asset_abs=pend.asset_abs,
                            source_ref=pend.source_ref)
        record.notes.extend(pend.notes)
        if pend.from_archive:
            # Provenance for assets resolved out of an .rpa archive
            # (kinetic_extract.rpa.AssetArchives): the ledger asset reads
            # "game/<archive>!<key>"; the `media` entry's source names the
            # archive and member with the member's sha256 and size.
            record.notes.append(
                f"asset extracted from .rpa archive ({pend.asset_rel})")
        if pend.asset_abs is not None:
            if not pend.asset_abs.exists():
                record.notes.append(
                    f"source asset {pend.asset_rel!r} not found yet")
            elif pend.kind == "image":
                result.source_images.append(pend.asset_abs)
        else:
            record.notes.append("no source asset resolved")
        if pend.kind == "video":
            set_video_duration(record)
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

    def close_menu(parsed: FileParse, ms: dict[str, Any]) -> None:
        """Judge an opened menu region when its `menu-close` arrives.

        The region's items are exactly those emitted between the choice
        boundaries (every boundary flushes the pending visual first), so
        adjacency is index arithmetic: each choice block must own a
        non-empty contiguous run of items, an item may only be an image
        or text item, and an item must precede the menu. A failure keeps
        the emitted items in the linear flow (as always) and records the
        menu as unsupported; it is never fatal."""
        record = ms["record"]
        starts = ms["starts"]
        ends = starts[1:] + [len(result.items)]
        reason = None
        if ms["after"] < 0:
            reason = "no item precedes the menu in the walked flow"
        elif len(starts) != len(record.choices):
            reason = "choice count does not match the walked blocks"
        else:
            for k, (s, e) in enumerate(zip(starts, ends)):
                if s >= e:
                    reason = f"choice {k + 1} produced no item"
                    break
                types = {result.items[i].item["type"] for i in range(s, e)}
                if not types <= {"image", "text"}:
                    reason = (f"choice {k + 1} contains a "
                              f"{sorted(types - {'image', 'text'})[0]} item")
                    break
        if reason is not None:
            record.skip_reason = reason
            parsed.reports.append(Report(
                record.source, record.statement,
                f"menu unsupported ({reason}): branch skipped, "
                "linear flow kept"))
            return
        result.branch_candidates.append({
            "record": record,
            "after_idx": ms["after"],
            "route_spans": [(record.choices[k], starts[k], ends[k] - 1)
                            for k in range(len(starts))],
        })

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
                    resolved = None  # (kind, ledger_rel, abs, src_ref, n)
                    if ref is not None:
                        ledger_rel, abs_path, src_ref = asset_paths(
                            ref, kind)
                        if (src_ref is not None and "archive" in src_ref) \
                                or (abs_path is not None
                                    and abs_path.exists()):
                            resolved = (kind, ledger_rel, abs_path,
                                        src_ref, 1)
                    if resolved is None and implicit_lookup is not None:
                        hit = implicit_lookup(
                            name, "video" if kind == "video" else "image")
                        if hit is not None:
                            ledger_rel, abs_path, src_ref, n = hit
                            resolved = (kind, ledger_rel, abs_path,
                                        src_ref, n)
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
                    kind, ledger_rel, abs_path, src_ref, n = resolved
                    pending = _Pending(kind, name, ledger_rel, abs_path,
                                       event.source, src_ref)
                    if n > 1:
                        chosen = ledger_rel.rsplit("!", 1)[-1]
                        pending.notes.append(
                            f"image name {name!r} is ambiguous: {n} assets "
                            f"answer it; using the first in sorted order "
                            f"({chosen})")
                elif event.kind == "video":
                    ledger_rel, abs_path, src_ref = asset_paths(
                        event.asset, "video")
                    flush_bare()
                    pending = _Pending(
                        "video", Path(event.asset or "movie").stem,
                        ledger_rel, abs_path, event.source, src_ref)
                    if not pending.from_archive and (abs_path is None
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
                elif event.kind == "menu-open":
                    # The lead-in ends here: a trailing visual becomes the
                    # decision's `after` item, and the region starts empty.
                    flush_bare()
                    menu_state = {
                        "record": parsed.menus[int(event.name)],
                        "after": len(result.items) - 1,
                        "starts": [],
                    }
                elif event.kind == "choice-open":
                    if menu_state is not None:
                        flush_bare()
                        menu_state["starts"].append(len(result.items))
                elif event.kind == "menu-close":
                    if menu_state is not None:
                        flush_bare()
                        close_menu(parsed, menu_state)
                        menu_state = None
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
