"""Timeline builder: parse events -> ordered manifest items + ledger notes.

Model (docs/plan.md Phase 10): a linear walk of the script's flow. Each
``scene``/``show``/``movie`` sets the current visual; the first dialogue
line under a fresh visual attaches to that media item, and later lines
become ``text`` items over the same visual. ``stop movie`` ends a video
context. Media references use the ``<id>.<ext>`` naming convention of
docs/content-format.md; the real asset files arrive with the next task, so
the build ledger keeps the source asset paths. Audio statements attach to
the next item emitted through kinetic_extract.audio_cues (docs/plan.md
Phase 47 item 8): each record's ``audio`` and the result's
``audio_tracks``.

Menus (docs/plan.md Phase 13; Phase 60 item 4): the walk lays each
decision menu out between marker events (kinetic_extract.flow); the items
between them are the routes, menus nested in a route included, and the
first item of the join's path is the `continueAt`. A route may hold any
item (Phase 60 item 8b). A route with no item before a menu nested in it
gets its choice text as its first line (item 8c), so the nested decision
hangs inside the route. A `text` item shows the nearest earlier media
item in array order, so a route after the first whose first line is said
over the visual on screen at the menu, when an earlier route changed the
visual, gets that line on a repeat of the menu's visual: the same picture,
animation or video, or an animation that holds its last frame as that
frame's picture.

Conditions (docs/plan.md Phase 60 item 6): an `if` chain the walk lays
out as a menu becomes a candidate the same way. One on what a single
menu's choices set follows that menu's decision when it became one before
the chain opened (``follows``, each kept arm's ``when`` from
kinetic_extract.conditions); the absent `else` such a decision passes is
then never emitted. A line that is an arm's label in parentheses keeps
its arm (ItemRecord.condition_arm) for the language files' words.

ATL frame lists (docs/plan.md Phase 60 item 8): a `scene`/`show` of a
name the parser read as an `image name:` frame list (parser.AtlImage)
is an ``animation`` item whose frames resolve as ``show`` names do; its
record's ``frames`` are one image record per frame, which the asset pass
ships. One frame, or one picture throughout, is a still image item.

Transitions (docs/plan.md Phase 57 item 4): a scene/show's `with` clause
gives its visual's item the transition; a bare `with` gives it to the
visual still waiting to be emitted when that visual changed since the
last interaction (a line, a pause, a menu, an earlier `with`), as Ren'Py
applies a `with` to the changes since the last one. A `with` with no such
change gives nothing. kinetic_extract.presentation reads the expression.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import conditions
from .audio_cues import AudioFiles, AudioTrack, CueWalker
from .flow import follow_labels
from .media import probe_duration_seconds
from .parser import Event, FileParse, Report, slug as _slug
from .presentation import (CharacterColors, Resolved, TransitionCounts,
                           character_colors, resolve_transition,
                           transition_defines)

_INTERPOLATION_RE = re.compile(r"\[[^][]*\]")
_INTERPOLATION_NOTE = " interpolation(s) literal in text"
# `image X = Movie(play="f.webm", ...)` (parser stores the value verbatim
# as an expression): the play file is the item's video (BUG 2).
_MOVIE_PLAY_RE = re.compile(r"\bplay\s*=\s*\"((?:[^\"\\]|\\.)*)\"")
_QUOTED_RE = re.compile(r"\"((?:[^\"\\]|\\.)*)\"")

# The folder Ren'Py's loader also looks a file name up in
# (`config.search_prefixes` is `["", "images/"]`).
IMAGES_PREFIX = "images"

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
    # The item's audio cues in the content format's item `audio` shape,
    # naming ids of TimelineResult.audio_tracks (kinetic_extract.
    # audio_cues); kept out of `item` until the tracks ship.
    audio: dict[str, Any] | None = None
    # The say statement the item's text came from ("game/<rel>:LINE"),
    # which Ren'Py's translations are matched to (``source`` is the
    # visual's line for a media item); None for an item without text.
    text_source: str | None = None
    # The say statements the text is made of, ``(source, text)`` in order:
    # the line itself, then each ``extend`` line that continues it (Ren'Py
    # shows the line and its extensions in one box). Their translations
    # are joined the same way (kinetic_extract.translations).
    text_parts: list[tuple[str, str]] = field(default_factory=list)
    # The sources of the parts Ren'Py translates in a language's `strings`
    # block, not a dialogue block: a one-choice menu's choice and caption
    # (kinetic_extract.parser, Event.from_strings).
    string_sources: set[str] = field(default_factory=set)
    # Language tag -> the item's text in that language, read from the
    # game's tl/ folders (kinetic_extract.translations).
    translations: dict[str, str] = field(default_factory=dict)
    # Language tag -> the base text a translation was made from, when it
    # is not the item's text now (a translation of English that has
    # changed since, kept so the validator reports it stale).
    translation_bases: dict[str, str] = field(default_factory=dict)
    # An animation's frames, one image record each (``item`` holds only an
    # id and the type): the asset pass ships each as an image item's file
    # and gives the animation their shipped paths as its `frames`.
    frames: list["ItemRecord"] = field(default_factory=list)
    # A line that is a condition arm's label in parentheses (docs/plan.md
    # Phase 60 item 6): ``(chain, arm index)``, whose words each language
    # file gets in its own language (kinetic_extract.translations).
    condition_arm: tuple[Any, int] | None = None


def set_video_duration(record: ItemRecord,
                       probe: Callable[[Path], float | None]
                       = probe_duration_seconds) -> None:
    """A video item's ``durationSeconds``, probed from its source file, or
    the placeholder 1.0 with a note when it cannot be probed (the asset
    pass re-probes a source a decoder hook changed). kinetic-extract's
    timeline and ``kinetic-media ship`` both set it here; `probe` is
    ``probe_duration_seconds`` or a memo of it."""
    path = record.asset_abs
    duration = (probe(path)
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
    # Menu regions that passed the shape check, as
    # {"record": MenuRecord, "after_idx": int,
    #  "route_spans": [(label, start_idx, end_idx)],
    #  "results": [route result], "how": [how the walk proved it],
    #  "continuing": route index | None, "continue_idx": int | None,
    #  "join": the join's source | None}
    # with indices into ``items`` (docs/plan.md Phase 13; Phase 60 item 4
    # for the results and the join). The CLI turns these into manifest
    # `branches` once the asset pass is known.
    branch_candidates: list[dict[str, Any]] = field(default_factory=list)
    # Track id -> the track the items' audio cues name.
    audio_tracks: dict[str, AudioTrack] = field(default_factory=dict)
    # Speaker display name -> the coloured Character defines whose lines
    # the walk gave that name (kinetic_extract.presentation).
    speaker_colors: dict[str, list[CharacterColors]] = field(
        default_factory=dict)
    # The `with` expressions met: how many read as a transition, and the
    # cuts by name.
    transitions: TransitionCounts = field(default_factory=TransitionCounts)
    # What the walk reached and left (kinetic_extract.flow): the ledger's
    # `walk` and the summary's lines.
    walk: dict[str, Any] = field(default_factory=dict)
    walk_summary: list[str] = field(default_factory=list)

    def _next_id(self, slug: str) -> str:
        return f"{slug}-{len(self.items) + 1:03d}"


class _Pending:
    """The current visual, before lines attach to it."""

    def __init__(self, kind: str, name: str | None, asset_rel: str | None,
                 asset_abs: Path | None, source: str,
                 source_ref: dict[str, str] | None = None):
        self.kind = kind          # image | video | animation
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
        # The item `transition` its `with` gave (docs/content-format.md,
        # "Transitions"); None: a cut.
        self.transition: dict[str, Any] | None = None
        # An animation's frames, (ledger rel, file path, source ref) each,
        # and its timing fields (parser.AtlImage.timing).
        self.frames: list[tuple[str, Path, dict[str, str] | None]] = []
        self.timing: dict[str, Any] = {}
        # The emitted visual this one repeats at a route's start (Phase
        # 60 item 8b), else None. A repeat no line takes is dropped.
        self.origin: _Pending | None = None

    def repeat(self, menu_source: str, note: str | None = None) -> _Pending:
        """This emitted visual again, for a route's first line (or, with
        ``note``, a shared span's): no transition (no new entrance); an
        animation that holds its last frame is that frame's picture, as
        Ren'Py shows it by then."""
        held = self.kind == "animation" and bool(
            self.timing.get("holdLastFrame"))
        if held:
            rel, path, ref = self.frames[-1]
            again = _Pending("image", self.name, rel, path, self.source, ref)
        else:
            again = _Pending(self.kind, self.name, self.asset_rel,
                             self.asset_abs, self.source, self.source_ref)
            again.frames, again.timing = self.frames, self.timing
        again.notes = list(self.notes) + [note or (
            f"repeats the visual on screen at the menu at {menu_source}"
            f"{' (its held last frame)' if held else ''}: a route's first "
            "line, which would otherwise show an earlier route's visual")]
        again.origin = self.origin or self
        return again


def finish_candidates(candidates: list[dict[str, Any]]) -> None:
    """Each candidate's `continueAt` and continuing route (docs/plan.md
    Phase 60 item 4): a decision whose choices meet where an enclosing
    one's do takes that one's `continueAt`; the continuing route is the
    last that reaches the join. A decision with no join item is a pure
    choice: its routes that reached the join end there (`"ending"`), as
    every route did before the walk proved joins."""
    def continue_of(cand: dict[str, Any], depth: int = 0) -> int | None:
        if "link" in cand:
            state = cand["link"]
            outer = state.get("cand") if state is not None else None
            return (continue_of(outer, depth + 1)
                    if outer is not None and depth < 64 else None)
        return cand["continue_idx"]

    for cand in candidates:
        cand["continue_idx"] = continue_of(cand)
    for cand in candidates:
        state = cand.pop("link", None)
        if state is not None and state.get("cand") is not None:
            # The CLI drops this join too if it withdraws that decision.
            cand["joins_with"] = state["cand"]
        joining = [k for k, r in enumerate(cand["results"])
                   if r == "continue"]
        # The continuing route's `then` may name only a span of its own
        # decision that continues (docs/content-format.md, rule 30).
        own = {span["key"]: span for span in cand.get("shared", [])}
        then = cand.get("then") or [None] * len(cand["results"])
        eligible = [k for k in joining if then[k] is None or (
            then[k] in own and own[then[k]]["result"] == "continue")]
        if cand["continue_idx"] is None or not eligible:
            cand["continue_idx"] = None
            for k in joining:
                cand["results"][k] = "ending"
                cand["how"][k] += (", which has no item of its own: a "
                                   "pure choice")
            for span in own.values():
                if span["result"] == "continue":
                    span["result"] = "ending"
                    span["how"] += (", which has no item of its own: a "
                                    "pure choice")
        else:
            cand["continuing"] = eligible[-1]


class _SliceDone(Exception):
    """Raised internally to stop the walk once a slice is complete."""


def build_timeline(parses: list[tuple[str, FileParse]],
                   image_defs: dict[str, tuple[str, Any]],
                   characters: dict[str, str],
                   game_dir: Path,
                   start_label: str | None = None,
                   max_items: int | None = None,
                   asset_lookup=None,
                   implicit_lookup=None,
                   audio_files: AudioFiles | None = None,
                   also_labels: list[str] | None = None,
                   include_unreached: bool = False,
                   ) -> TimelineResult:
    """Walk the parsed files' story as Ren'Py runs it, from `label start`
    through jumps, calls and fall-through (kinetic_extract.flow; file-name
    order when there is no `label start`).

    Slice options (docs/plan.md Phase 11): ``start_label`` starts the walk
    at that label instead of `start`; ``max_items`` stops the walk after
    that many items. Both unset (default) means the whole project.
    ``also_labels`` are walked after the story, then, with
    ``include_unreached``, every label still unreached that holds
    dialogue (kinetic_extract.flow).

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

    ``audio_files`` (kinetic_extract.audio_cues.AudioFiles) finds the
    audio files the cues name; by default loose files under
    ``game_dir`` only.
    """
    result = TimelineResult()
    cues = CueWalker(parses, audio_files or AudioFiles(game_dir))
    pending: _Pending | None = None
    colors = character_colors(parses)
    defines = transition_defines(parses)
    # Whether the pending visual changed since the last interaction, so
    # a bare `with` applies to it.
    fresh = False
    # Note -> (parse, first source, statement, uses) for how transitions
    # were read (a clamped time, a fade colour), reported once each.
    transition_notes: dict[str, list[Any]] = {}
    # Chains the CLI did not prepare (a direct call): English words.
    conditions.prepare(parses)
    walk = follow_labels(parses, start_label, also_labels, include_unreached)
    result.walk, result.walk_summary = walk.record, walk.summary
    # The open menu regions, innermost last (Phase 13; nested since Phase
    # 60 item 4).
    menu_stack: list[dict[str, Any]] = []
    # Decisions whose `continueAt` is the join's first item, not yet seen:
    # each (candidate, item count at its `menu-close`).
    awaiting: list[tuple[dict[str, Any], int]] = []
    # The item the last say statement's text went to, which an `extend`
    # line continues; None at a menu's boundaries (a route's line never
    # continues the lead-in's) and before the first line.
    last_line: ItemRecord | None = None
    # The visual of the last media item emitted: the one a `text` item
    # emitted now would show (array order).
    on_screen: _Pending | None = None
    # Each shared span's key -> the visual and ambience where the walk
    # first read it (its `shared-mark`), restored at its `shared-open`.
    span_marks: dict[str, dict[str, Any]] = {}
    # Each shared span's key -> the decisions whose choices meet at it.
    span_joins: dict[str, list[dict[str, Any]]] = {}

    def check_limit() -> None:
        if max_items is not None and len(result.items) >= max_items:
            raise _SliceDone()

    def read_transition(parsed: FileParse, source: str,
                        expr: str) -> Resolved:
        """Read a `with` expression, counting it and noting how."""
        got = resolve_transition(expr, defines)
        if got.transition is not None:
            result.transitions.read += 1
        else:
            result.transitions.cut[got.cut or expr] += 1
        for note in got.notes:
            seen = transition_notes.setdefault(
                note, [parsed, source, f"with {expr}", 0])
            seen[3] += 1
        return got

    def asset_paths(rel: str | None, kind: str,
                    ) -> tuple[str | None, Path | None,
                               dict[str, str] | None]:
        """(ledger rel, file path, source ref) for a script reference:
        the loose file under game/, else under game/images/, else an
        archive member. Ren'Py's loader looks a file name up under each
        of `config.search_prefixes`, `""` then `"images/"`, so
        `image x = "day1/x.jpg"` plays `game/images/day1/x.jpg`
        (docs/plan.md Phase 57 item 4d)."""
        if rel is None:
            return None, None, None
        target = game_dir / rel
        ledger_rel = f"game/{Path(rel).as_posix()}"
        if not target.exists():
            in_images = game_dir / IMAGES_PREFIX / rel
            if in_images.is_file():
                images_rel = f"game/{IMAGES_PREFIX}/{Path(rel).as_posix()}"
                return images_rel, in_images, {"path": images_rel}
            if asset_lookup is not None:
                hit = (asset_lookup(rel, kind)
                       or asset_lookup(f"{IMAGES_PREFIX}/{rel}", kind))
                if hit is not None:
                    return hit
        return ledger_rel, target, {"path": ledger_rel}

    def resolve_name(name: str) -> tuple[str, str | None, Any]:
        """``(kind, defined file, resolved)`` for a scene/show name, with
        ``resolved`` ``(kind, ledger_rel, abs, src_ref, n)`` or None.
        Resolution order (docs/extracting.md BUG 5): the explicit
        definition first — a `Movie(play=…)` def answers as a video
        (BUG 2) — then its file on disk or in the archives, then the
        implicit name index."""
        defined = image_defs.get(name)
        kind, ref = def_value_target(defined) \
            if defined and defined[0] != "atl" else ("image", None)
        resolved = None
        if ref is not None:
            ledger_rel, abs_path, src_ref = asset_paths(ref, kind)
            if (src_ref is not None and "archive" in src_ref) \
                    or (abs_path is not None and abs_path.exists()):
                resolved = (kind, ledger_rel, abs_path, src_ref, 1)
        if resolved is None and implicit_lookup is not None:
            hit = implicit_lookup(
                name, "video" if kind == "video" else "image")
            if hit is not None:
                ledger_rel, abs_path, src_ref, n = hit
                resolved = (kind, ledger_rel, abs_path, src_ref, n)
        return kind, ref, resolved

    def resolve_frame(ref: str, depth: int = 0) -> Any:
        """An ATL frame's picture as ``resolve_name`` resolves one, or
        None: a quoted file (it has a dot) on disk, under images/ or in
        the archives; else an image name, a one-frame ATL image's frame
        included. A video, a solid colour or an animation is no frame."""
        if "." in ref:
            ledger_rel, abs_path, src_ref = asset_paths(ref, "image")
            if (src_ref is not None and "archive" in src_ref) \
                    or (abs_path is not None and abs_path.is_file()):
                return ("image", ledger_rel, abs_path, src_ref, 1)
            return None
        defined = image_defs.get(ref)
        if defined is not None and defined[0] == "atl":
            atl = defined[1]
            return resolve_frame(atl.frames[0].ref, depth + 1) \
                if atl.still and depth < 8 else None
        if ref in _SOLID_COLORS and defined is None:
            return None
        kind, _file, resolved = resolve_name(ref)
        return resolved if kind == "image" else None

    def atl_pending(parsed: FileParse, source: str, name: str,
                    atl: Any) -> _Pending:
        """The visual an ATL frame list shows (parser.AtlImage): an
        animation of its frames; a still when it has one frame or every
        frame is one picture; dropped with its lines, reported, when a
        frame resolves nowhere (BUG 1)."""
        hits = []
        for frame in atl.frames:
            hit = resolve_frame(frame.ref)
            if hit is None:
                parsed.reports.append(Report(source, name, (
                    f"droppedUnresolved: ATL frame {frame.ref!r} of image "
                    f"{name!r} ({frame.source}): no image definition or "
                    "asset answers it")))
                pend = _Pending("image", name, None, None, source)
                pend.unresolved = True
                return pend
            hits.append(hit)
        if atl.still or len({hit[1] for hit in hits}) == 1:
            _kind, ledger_rel, abs_path, src_ref, n = hits[0]
            pend = _Pending("image", name, ledger_rel, abs_path, source,
                            src_ref)
            pend.notes.append(
                f"ATL image ({atl.source}) with one frame: a still"
                if atl.still else
                f"ATL frames ({atl.source}) all show one picture: a still")
        else:
            pend = _Pending("animation", name, None, None, source)
            pend.frames = [(hit[1], hit[2], hit[3]) for hit in hits]
            pend.timing = atl.timing()
            pend.notes.append(
                f"ATL frame list ({atl.source}): {len(hits)} frames")
        for hit in hits:
            if hit[4] > 1:
                chosen = hit[1].rsplit("!", 1)[-1]
                pend.notes.append(
                    f"ATL frame of {name!r} is ambiguous: {hit[4]} assets "
                    f"answer it; using the first in sorted order "
                    f"({chosen})")
        return pend

    def flush_bare() -> None:
        """Emit an unconsumed visual (replaced or at end of flow) bare.
        An unresolved visual was already reported at its statement; it is
        dropped, never emitted (BUG 1), as is a route start's repeat of
        the menu's visual that no line took."""
        nonlocal pending
        if (pending is not None and not pending.consumed
                and not pending.unresolved and pending.origin is None):
            emit_media(pending, speaker=None, text=None)
        pending = None

    def repeat_at_route_start(ms: dict[str, Any]) -> None:
        """A route's first line is said over the visual on screen at the
        menu; when an earlier route emitted another visual since, that
        line's item repeats the menu's (Phase 60 item 8b)."""
        nonlocal pending
        at_menu = ms["screen"]
        if at_menu is None or on_screen is None:
            return
        if (on_screen.origin or on_screen) is not (at_menu.origin
                                                   or at_menu):
            pending = at_menu.repeat(ms["record"].source)

    def route_needs_lead() -> bool:
        """Whether a menu opening now, nested in a route, would hang off
        an item before that route (Phase 60 item 8c): the route has no
        item yet and no visual waiting that the `menu-open` would emit.
        A route whose visual is unresolved drops its lines, so it gets
        none: close_menu keeps that nested menu linear."""
        if not menu_stack or not menu_stack[-1]["starts"]:
            return False
        if len(result.items) > menu_stack[-1]["starts"][-1]:
            return False
        return pending is None or pending.consumed or (
            pending.origin is not None and not pending.unresolved)

    def emit_media(pend: _Pending, speaker: str | None,
                   text: str | None,
                   line_source: str | None = None) -> ItemRecord:
        nonlocal on_screen
        on_screen = pend
        item_id = result._next_id(_slug(pend.name or pend.asset_rel,
                                        "scene" if pend.kind == "image"
                                        else "movie"))
        item: dict[str, Any] = {"id": item_id, "type": pend.kind}
        record = ItemRecord(item=item, source=pend.source,
                            asset=pend.asset_rel, asset_abs=pend.asset_abs,
                            source_ref=pend.source_ref,
                            text_source=line_source)
        record.notes.extend(pend.notes)
        if pend.kind == "animation":
            item.update(pend.timing)
            for k, (rel, path, ref) in enumerate(pend.frames):
                record.frames.append(ItemRecord(
                    item={"id": f"{item_id}.f{k:03d}", "type": "image"},
                    source=pend.source, asset=rel, asset_abs=path,
                    source_ref=ref))
                if ref is not None and "archive" in ref:
                    record.notes.append(
                        f"frame {k} extracted from .rpa archive ({rel})")
            # The first frame stands for the animation in the size probe,
            # as an image item's one file does (a repeat is counted once).
            if pend.frames and pend.frames[0][1].exists() \
                    and pend.origin is None:
                result.source_images.append(pend.frames[0][1])
        elif pend.from_archive:
            # Provenance for assets resolved out of an .rpa archive
            # (kinetic_extract.rpa.AssetArchives): the ledger asset reads
            # "game/<archive>!<key>"; the `media` entry's source names the
            # archive and member with the member's sha256 and size.
            record.notes.append(
                f"asset extracted from .rpa archive ({pend.asset_rel})")
        if pend.kind == "animation":
            pass
        elif pend.asset_abs is not None:
            if not pend.asset_abs.exists():
                record.notes.append(
                    f"source asset {pend.asset_rel!r} not found yet")
            elif pend.kind == "image" and pend.origin is None:
                result.source_images.append(pend.asset_abs)
        else:
            record.notes.append("no source asset resolved")
        if pend.kind == "video":
            set_video_duration(record)
        apply_line(item, record, speaker, text)
        if pend.transition is not None:
            item["transition"] = dict(pend.transition)
        cues.attach(record)
        result.items.append(record)
        check_limit()
        return item

    def apply_line(item: dict[str, Any], record: ItemRecord,
                   speaker: str | None, text: str | None) -> None:
        nonlocal last_line
        if text is None:
            return
        if speaker is not None:
            item["speaker"] = characters.get(speaker, speaker)
            if speaker in colors:
                known = result.speaker_colors.setdefault(item["speaker"], [])
                if colors[speaker] not in known:
                    known.append(colors[speaker])
            if speaker in characters:
                record.notes.append(
                    f"speaker {speaker!r} display name from Character define")
        item["text"] = text
        if record.text_source is not None:
            record.text_parts = [(record.text_source, text)]
        note_interpolations(record)
        last_line = record

    def is_extend(event: Event) -> bool:
        """Ren'Py's `extend` speaker, unless the game defines its own."""
        return event.speaker == "extend" and "extend" not in characters

    def note_interpolations(record: ItemRecord) -> None:
        record.notes = [n for n in record.notes
                        if not n.endswith(_INTERPOLATION_NOTE)]
        count = len(_INTERPOLATION_RE.findall(record.item["text"]))
        if count:
            record.notes.append(f"kept {count}{_INTERPOLATION_NOTE}")

    def extend_line(record: ItemRecord, event: Event) -> None:
        """An `extend` line continues `record`, the last line's item:
        Ren'Py shows the line with this text added, as written, in one
        box with the same speaker (``_Extend`` in
        renpy/common/00library.rpy; its ``{fast}`` only shows the earlier
        part at once)."""
        cues.extend_line()
        record.item["text"] += event.text
        record.text_parts.append((event.source, event.text))
        record.notes.append(f"extended by the extend line at {event.source}")
        note_interpolations(record)

    def resolve_awaiting(follows: dict[str, Any] | None = None) -> None:
        """The decisions waiting for their join's first item get it when
        an item came since their `menu-close`, else none. A menu opening
        (``follows``) right after one that got none would hang off that
        one's last route: it stays linear."""
        for cand, count in awaiting:
            if len(result.items) > count:
                cand["continue_idx"] = count
            elif follows is not None:
                follows["reject"] = (
                    f"the menu follows the menu at "
                    f"{cand['record'].source} with no line between")
        awaiting.clear()

    def close_menu(parsed: FileParse, ms: dict[str, Any],
                   outcome: dict[str, Any] | None) -> None:
        """Judge an opened menu region when its `menu-close` arrives.

        The region's items are exactly those emitted between the choice
        boundaries (every boundary flushes the pending visual first), so
        adjacency is index arithmetic: each choice block must own a
        non-empty contiguous run of items (a choice with nothing of its
        own has its text, kinetic_extract.flow), of any type (Phase 60
        item 8b), and an item must precede the menu. The walk's
        ``outcome`` gives each route's result and how it was proven, or
        why the menu stays linear (a path rejoining content read
        elsewhere, every choice empty). A failure keeps the emitted items
        in the linear flow (as always) and records the menu as
        unsupported; it is never fatal."""
        record = ms["record"]
        starts = ms["starts"]
        # Shared spans follow the last route (Phase 60 item 9i).
        span_starts = ms.get("spans", [])
        region_end = span_starts[0][1] if span_starts else len(result.items)
        ends = starts[1:] + [region_end]
        dropped = ms.get("drop", set())
        outcome = outcome or {}
        reason = ms.get("reject") or outcome.get("linear")
        if reason is None and ms["after"] < 0:
            reason = "no item precedes the menu in the walked flow"
        elif reason is None and len(menu_stack) > 1 \
                and ms["after"] < menu_stack[-2]["starts"][-1]:
            reason = "no item of its enclosing route precedes the menu"
        elif reason is None and len(starts) != len(record.choices):
            reason = "choice count does not match the walked blocks"
        elif reason is None:
            for k, (s, e) in enumerate(zip(starts, ends)):
                if s >= e and k not in dropped:
                    reason = f"choice {k + 1} produced no item"
                    break
        if reason is not None:
            record.skip_reason = reason
            what = "if chain" if record.condition is not None else "menu"
            parsed.reports.append(Report(
                record.source, record.statement,
                f"{what} unsupported ({reason}): branch skipped, "
                "linear flow kept"))
            return
        kept = [k for k in range(len(starts)) if k not in dropped]
        results = list(outcome.get("results")
                       or ["ending"] * len(starts))
        how = list(outcome.get("how") or [""] * len(starts))
        shared = []
        bounds = [start for _key, start in span_starts[1:]] + [
            len(result.items)]
        laid = {span["key"]: span for span in outcome.get("shared", [])}
        for (key, start), stop in zip(span_starts, bounds):
            if key in laid and start < stop:
                # A span whose items were all dropped is none: its
                # routes act on their own result, and a decision joining
                # at it has no join item.
                shared.append({**laid[key], "start": start, "end": stop - 1})
            else:
                for joined in span_joins.get(key, []):
                    joined["continue_idx"] = None
        gone = set(laid) - {span["key"] for span in shared}
        then_of = {k: key for k, key in (outcome.get("then") or {}).items()
                   if key not in gone}
        cand = {
            "record": record,
            "after_idx": ms["after"],
            "route_spans": [(record.choices[k], starts[k], ends[k] - 1)
                            for k in kept],
            "results": [results[k] for k in kept],
            "how": [how[k] for k in kept],
            "continuing": None,
            "continue_idx": None,
            "join": outcome.get("join"),
            "shared": shared,
            "then": [then_of.get(k) for k in kept],
        }
        if record.condition is not None:
            # Decision made from a condition (Phase 60 item 6): its arms
            # kept, the decision it follows (when that one is a
            # candidate) and whether an arm was left out for it.
            cand["arms"] = kept
            cand["follows"] = ms.get("follows")
            cand["dropped"] = bool(dropped)
        result.branch_candidates.append(cand)
        ms["cand"] = cand
        for span in shared:
            for joined in span_joins.get(span["key"], []):
                # The CLI drops that join too if it withdraws this one.
                joined["joins_with"] = cand
        link = outcome.get("link")
        if outcome.get("join_span") is not None:
            # Its choices meet at a shared tail (Phase 60 item 9i): its
            # `continueAt` is the span's first item.
            span_joins.setdefault(outcome["join_span"], []).append(cand)
        elif link is not None:
            # The choices meet where an enclosing menu's do: its
            # `continueAt`, past the enclosing route's end, is theirs.
            cand["link"] = next(
                (open_ms for open_ms in reversed(menu_stack)
                 if open_ms["parsed"] is link[0]
                 and open_ms["index"] == link[1]), None)
        elif "continue" in results and outcome.get("join"):
            awaiting.append((cand, len(result.items)))

    def follows_menu(ms: dict[str, Any]) -> None:
        """A chain on what one menu's choices set follows that menu's
        decision (Phase 60 item 6) when the menu became one before the
        chain opened: it is closed, a candidate, not enclosing the chain.
        Then the absent `else` such a decision passes is left out; else
        the chain is an ordinary decision, every arm a route."""
        cond = ms["record"].condition
        if cond is None or cond.kind != "follows" or cond.follow is None:
            return
        followed = next((c for c in reversed(result.branch_candidates)
                         if c["record"] is cond.follow), None)
        if followed is None or any(open_ms["record"] is cond.follow
                                   for open_ms in menu_stack):
            return
        ms["follows"] = followed
        ms["drop"] = {k for k, drop in enumerate(cond.drop_when_following)
                      if drop}

    def end_route(ms: dict[str, Any]) -> None:
        """Close the route block (or shared span) before the boundary
        just reached."""
        if ms.get("spans"):
            has_item = len(result.items) > ms["spans"][-1][1]
            cues.route_end(result.items[-1] if has_item else None,
                           keep_state=False)
        elif ms["starts"]:
            has_item = len(result.items) > ms["starts"][-1]
            cues.route_end(result.items[-1] if has_item else None)

    try:
        for parsed, event in walk.events:
            if event.kind == "flush":
                # A file's end, in a file-order walk.
                flush_bare()
                continue
            check_limit()
            if menu_stack and menu_stack[-1].get("suppress") \
                    and event.kind not in ("choice-open", "menu-close"):
                # The absent `else` a following decision leaves out
                # (Phase 60 item 6): its one line, never shown; kept as a
                # route when no other arm reaches the join to pass to.
                top = menu_stack[-1]
                if (event.outcome or {}).get("others_join", True):
                    continue
                top["suppress"] = False
                top["drop"].discard(len(top["starts"]) - 1)
            if event.kind == "route-lead":
                if not route_needs_lead():
                    continue
                # The enclosing route's choice text, as a line (Phase 60
                # item 8c): the nested decision hangs off it.
                event = Event("dialogue", event.source, text=event.text,
                              from_strings=event.from_strings,
                              arm=event.arm)
            if event.kind in ("dialogue", "interact", "menu-open",
                              "choice-open", "menu-close",
                              "stop-movie", "path-end", "shared-open"):
                fresh = False
            if event.kind == "with":
                got = read_transition(parsed, event.source,
                                      event.name or "None")
                if (fresh and pending is not None
                        and not pending.consumed
                        and not pending.unresolved):
                    pending.transition = got.transition
                fresh = False
                continue
            if event.kind == "visual":
                # A `with` clause: `with None`, the statement, then
                # the clause's `with`, so the visual takes it and the
                # changes before it are settled.
                clause = (read_transition(parsed, event.source,
                                          event.transition)
                          if event.transition is not None else None)
                fresh = clause is None
                name = event.name or "black"
                if name in _SOLID_COLORS and name not in image_defs:
                    # A solid screen carries no media; the visual is
                    # cleared.
                    flush_bare()
                    parsed.reports.append(Report(
                        event.source, f"scene {name}",
                        "solid color screen: no media item"))
                    continue
                defined = image_defs.get(name)
                if defined is not None and defined[0] == "atl":
                    # An ATL frame list (docs/plan.md Phase 60 item 8).
                    flush_bare()
                    pending = atl_pending(parsed, event.source, name,
                                          defined[1])
                    if clause is not None:
                        pending.transition = clause.transition
                    continue
                kind, ref, resolved = resolve_name(name)
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
                if clause is not None:
                    pending.transition = clause.transition
                if n > 1:
                    chosen = ledger_rel.rsplit("!", 1)[-1]
                    pending.notes.append(
                        f"image name {name!r} is ambiguous: {n} assets "
                        f"answer it; using the first in sorted order "
                        f"({chosen})")
            elif event.kind == "video":
                fresh = True
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
            elif (event.kind == "dialogue" and is_extend(event)
                  and last_line is not None
                  and not (pending is not None and pending.unresolved)):
                extend_line(last_line, event)
            elif event.kind == "dialogue":
                speaker = event.speaker
                if is_extend(event):
                    # No line before it in the walk: Ren'Py's
                    # narrator says it.
                    speaker = None
                if pending is not None and pending.unresolved:
                    # The line belongs to a dropped visual (BUG 1):
                    # a text item needs a visual, so it drops with it.
                    parsed.reports.append(Report(
                        event.source, event.text,
                        "droppedUnresolved: line dropped with its "
                        "unresolved visual"))
                    cues.line_dropped()
                    last_line = None
                    continue
                if pending is not None and not pending.consumed:
                    emit_media(pending, speaker, event.text,
                               event.source)
                    pending.consumed = True
                else:
                    item_id = result._next_id("line")
                    item: dict[str, Any] = {"id": item_id,
                                            "type": "text"}
                    record = ItemRecord(item=item, source=event.source,
                                        asset=None,
                                        text_source=event.source)
                    if pending is None:
                        record.notes.append(
                            "dialogue with no preceding visual in flow")
                    apply_line(item, record, speaker, event.text)
                    cues.attach(record)
                    result.items.append(record)
                    check_limit()
                if event.from_strings and last_line is not None:
                    last_line.string_sources.add(event.source)
                if event.arm is not None and last_line is not None \
                        and menu_stack:
                    last_line.condition_arm = (
                        menu_stack[-1]["record"].condition, event.arm)
            elif event.kind == "path-end":
                # The join's path ended before an item of its own.
                flush_bare()
                last_line = None
                resolve_awaiting()
            elif event.kind == "menu-open":
                # The lead-in ends here: a trailing visual becomes the
                # decision's `after` item, and the region starts empty.
                flush_bare()
                last_line = None
                state = {
                    "record": parsed.menus[int(event.name)],
                    "parsed": parsed,
                    "index": int(event.name),
                    "after": len(result.items) - 1,
                    "starts": [],
                    # The visual on screen at the menu, which every
                    # route's first line is said over.
                    "screen": on_screen,
                }
                resolve_awaiting(state)
                follows_menu(state)
                cues.menu_open()
                menu_stack.append(state)
            elif event.kind == "choice-open":
                if menu_stack:
                    flush_bare()
                    last_line = None
                    resolve_awaiting()
                    end_route(menu_stack[-1])
                    top = menu_stack[-1]
                    top["suppress"] = len(top["starts"]) in top.get(
                        "drop", ())
                    top["starts"].append(len(result.items))
                    cues.route_start()
                    repeat_at_route_start(top)
            elif event.kind == "shared-mark":
                # Where the walk first read a shared span (Phase 60 item
                # 9i): what is on screen there, and what plays.
                span_marks[event.name or ""] = {
                    "screen": (pending if pending is not None
                               and not pending.consumed else on_screen),
                    "ambience": cues.snapshot()}
            elif event.kind == "shared-open":
                if menu_stack:
                    flush_bare()
                    last_line = None
                    resolve_awaiting()
                    end_route(menu_stack[-1])
                    menu_stack[-1].setdefault("spans", []).append(
                        (event.name or "", len(result.items)))
                    for joined in span_joins.get(event.name or "", []):
                        joined["continue_idx"] = len(result.items)
                    mark = span_marks.get(event.name or "", {})
                    cues.span_start(mark.get("ambience"))
                    screen = mark.get("screen")
                    if screen is not None and screen.unresolved:
                        pending = screen   # its lines drop, as they would
                    elif screen is not None and (
                            on_screen is None
                            or (on_screen.origin or on_screen)
                            is not (screen.origin or screen)):
                        pending = screen.repeat(
                            event.source,
                            f"repeats the visual on screen where the walk "
                            f"first read the shared span at {event.source}: "
                            "the span's first line, which would otherwise "
                            "show its decision's last route's visual")
            elif event.kind == "menu-close":
                if menu_stack:
                    flush_bare()
                    last_line = None
                    resolve_awaiting()
                    end_route(menu_stack[-1])
                    close_menu(parsed, menu_stack[-1], event.outcome)
                    cues.menu_close()
                    menu_stack.pop()
            elif event.kind == "audio":
                cues.statement(parsed, event)
        flush_bare()
    except _SliceDone:
        pass
    resolve_awaiting()
    finish_candidates(result.branch_candidates)
    for note, (parsed, source, statement, uses) in transition_notes.items():
        parsed.reports.append(Report(
            source, statement,
            f"transition: {note} ({uses} use{'s' if uses != 1 else ''}; "
            "this is the first)"))
    for known in result.speaker_colors.values():
        known.sort(key=lambda c: c.order)
    cues.finish()
    result.audio_tracks = cues.tracks

    if not result.items and start_label is None and max_items is None:
        raise SystemExit("kinetic-extract: script produced no items")
    return result
