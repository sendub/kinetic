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
animation or video, an animation that holds its last frame as that
frame's picture, or a video that holds it as its `lastFrame` still
(item 9n6, ItemRecord.last_frame_of).

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

Pictures (docs/plan.md Phase 60 item 9n): a name resolves as Ren'Py
resolves it (``lookup``): its `image` definition, a string read as a
displayable (a file, a colour or another image name), another
displayable's first picture that resolves, then the implicit name
index; file names match whatever their case. A visual that still
resolves nowhere leaves the picture on screen as it was, its lines kept
over that picture and reported.

Solid colours (item 9n3): a shown colour (`"#rgb"` and the other hex
forms, `Solid(...)` of a literal colour, Ren'Py's built-in `black`) is a
still of that colour, made from nothing at the game's size
(``ItemRecord.generated``, one file per colour). A translucent one shown
over a picture cannot be laid over it: its lines are kept over the
picture, noted; on a `scene`, or with no picture before it, it shows
over the black of Ren'Py's empty scene. A colour replaced before any
line, pause, menu or transition showed it is no item.

Item 9n5: a bare `scene` (no image named) clears the layer, so it shows
the black still whatever the game's own `image black` is. A frame list's
solid-colour frames are generated stills too, a translucent one laid
over black, and an animation with one is held to item 9n3's rule for a
translucent colour. A solid colour's `scene x:` or `show x:` ATL block
that sets `alpha` (parser.atl_end_alpha: the value it ends at) gives the
colour that alpha, under the same rule; a block whose `alpha` the
converter cannot follow leaves the colour as it is, noted.

Transitions (docs/plan.md Phase 57 item 4): a scene/show's `with` clause
gives its visual's item the transition; a bare `with` gives it to the
visual still waiting to be emitted when that visual changed since the
last interaction (a line, a pause, a menu, an earlier `with`), as Ren'Py
applies a `with` to the changes since the last one. A `with` with no such
change gives nothing. kinetic_extract.presentation reads the expression.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import conditions
from .audio_cues import AudioFiles, AudioTrack, CueWalker
from .flow import follow_labels
from .media import probe_duration_seconds
from .parser import (_KEYWORD_ARG_RE, Event, FileParse, Report,
                     _call_arguments, atl_end_alpha, character_images,
                     nameless_characters, say_key, slug as _slug,
                     string_literal)
from .presentation import (CharacterColors, Resolved, TransitionCounts,
                           character_colors, resolve_transition,
                           transition_defines)

_INTERPOLATION_RE = re.compile(r"\[[^][]*\]")
# How a line under a visual that resolves nowhere is kept (Phase 60 item
# 9n): its ledger note and the visual's report say so.
KEPT = "kept over the last visual"
_INTERPOLATION_NOTE = " interpolation(s) literal in text"
# `image X = Movie(play="f.webm", ...)` (parser stores the value verbatim
# as an expression): the play file is the item's video (BUG 2), either
# quote (Phase 60 item 9n2).
_MOVIE_PLAY_RE = re.compile(
    r"""\bplay\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')""")
# How a Movie's arguments the folder's video items cannot show are noted
# (Phase 60 item 9n2): the others are shown as the item plays (`play`,
# `channel`, `loop=True`, and `loop=False` as `holdLastFrame`, item 9n4)
# or change nothing the reader sees (`fps`).
_MOVIE_SHOWN_ARGS = frozenset({"play", "channel", "fps"})
_MOVIE_ARG_NOTES = {
    "loop": "not True or False: the video loops under its lines",
    "size": "the player fits the video to the screen",
    "mask": "the video shows without its mask",
    "image": "the picture Ren'Py shows once the movie ends",
    "start_image": "the picture Ren'Py shows before the movie starts",
}
# The black still a line before any picture shows over (Phase 60 item
# 9n2), and its item's ledger note.
BLACK = "black"
BLACK_NOTE = ("no picture before this line: it shows over black, as "
              "Ren'Py's empty scene does (a black still at the game's size)")
# A menu before any picture hangs off a black still (Phase 60 item 9n3).
BLACK_MENU_NOTE = ("no picture before the menu at {}: its decision follows "
                   "a black still, as Ren'Py shows a menu over its empty "
                   "scene")
_QUOTED_RE = re.compile(r"\"((?:[^\"\\]|\\.)*)\"")
# Any quoted string of an image expression, either quote.
_ANY_QUOTED_RE = re.compile(r"\"((?:[^\"\\]|\\.)*)\"|'((?:[^'\\]|\\.)*)'")
# The call an image expression starts with: `ConditionSwitch(`, `im.Scale(`.
_CALL_HEAD_RE = re.compile(r"\s*([A-Za-z_][\w.]*)\s*\(")
# Displayables made of (condition, displayable) pairs: their pictures are
# every second positional argument.
_SWITCHES = frozenset({"ConditionSwitch", "ShowingSwitch"})
# Deepest chain of image names naming image names followed.
_MAX_DEPTH = 8

# The folder Ren'Py's loader also looks a file name up in
# (`config.search_prefixes` is `["", "images/"]`).
IMAGES_PREFIX = "images"

# Image names that are a solid colour with no definition: Ren'Py's
# built-in `black` (`image black = Solid("#000")`), and `white`, which
# Ren'Py does not define but the converter reads as its colour.
_SOLID_COLORS = {"black": (0, 0, 0, 255), "white": (255, 255, 255, 255)}
_HEX_RE = re.compile(r"#?([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})")
# A `Solid(...)` keyword that sizes it: no longer a colour filling the
# screen.
_SIZED_RE = re.compile(r"(?:x|y|xy)?(?:size|maximum|minimum)$|area$|"
                       r"(?:width|height)$")


def hex_colour(text: str, hash_needed: bool = True
               ) -> tuple[int, int, int, int] | None:
    """``(r, g, b, a)`` of a colour string as Ren'Py's ``Color`` reads
    it: `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` (the `#` optional
    unless ``hash_needed``), else None."""
    text = text.strip()
    if hash_needed and not text.startswith("#"):
        return None
    m = _HEX_RE.fullmatch(text)
    if m is None:
        return None
    digits = m.group(1)
    if len(digits) <= 4:
        digits = "".join(d * 2 for d in digits)
    if len(digits) == 6:
        digits += "ff"
    r, g, b, a = (int(digits[k:k + 2], 16) for k in range(0, 8, 2))
    return r, g, b, a


def solid_call(value: str) -> tuple[tuple[int, int, int, int] | None, str]:
    """A `Solid(...)` expression's colour, ``(r, g, b, a)``, and ``""``;
    or None and why the converter cannot show it as a screen of one
    colour (a colour it cannot read, or a size given)."""
    head = _CALL_HEAD_RE.match(value)
    args = _call_arguments(value, head.end()) if head is not None else None
    if not args:
        return None, f"`{value}` names no colour the converter reads"
    colour_arg = None
    for k, arg in enumerate(args):
        m = _KEYWORD_ARG_RE.fullmatch(arg)
        if m is None and k == 0:
            colour_arg = arg
        elif m is not None and m.group(1) == "color":
            colour_arg = m.group(2).strip()
        elif m is not None and _SIZED_RE.match(m.group(1)):
            return None, (f"`{value}` is sized (`{m.group(1)}`), not a "
                          "screen of one colour")
    literal = (string_literal(colour_arg) if colour_arg is not None
               else None)
    colour = hex_colour(literal, hash_needed=False) \
        if literal is not None else None
    if colour is None and colour_arg is not None \
            and colour_arg.startswith("(") and colour_arg.endswith(")"):
        parts = _call_arguments(colour_arg[1:] + ")", 0) or []
        if len(parts) in (3, 4) and all(p.isdigit() and int(p) < 256
                                        for p in parts):
            values = [int(p) for p in parts] + [255]
            colour = (values[0], values[1], values[2], values[3])
    if colour is None:
        return None, f"`{value}` names no colour the converter reads"
    return colour, ""


def _named_file(ledger_rel: str, name: str) -> bool:
    """Whether a file the implicit index found (``game/<rel>``, or
    ``game/<archive>!<member>``) is one Ren'Py names ``name`` itself:
    ``<name>.<ext>`` at the top of game/, or under its images folder at
    any depth (its automatic image names)."""
    rel = ledger_rel.split("!", 1)[1] if "!" in ledger_rel \
        else ledger_rel.removeprefix("game/")
    path = Path(rel)
    if path.stem.lower() != name:
        return False
    return len(path.parts) == 1 or path.parts[0].lower() == IMAGES_PREFIX


def solid_key(rgb: tuple[int, int, int]) -> str:
    """The name a generated still of ``rgb`` goes by (ItemRecord.generated
    and its ledger source): ``"black"`` for black, as item 9n2 named it,
    else ``"#rrggbb"``."""
    return "black" if tuple(rgb) == (0, 0, 0) else \
        "#" + "".join(f"{c:02x}" for c in rgb)


def over_black(colour: tuple[int, int, int, int]) -> tuple[int, int, int]:
    """A colour laid over black: its alpha applied."""
    r, g, b, a = colour
    return tuple(round(c * a / 255) for c in (r, g, b))  # type: ignore


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
        return "video", m.group(1) if m.group(1) is not None else m.group(2)
    m = _QUOTED_RE.search(value)
    return "image", m.group(1) if m else None


def expression_refs(expr: str) -> list[str]:
    """The strings an image expression may show, in order (docs/plan.md
    Phase 60 item 9n): a `ConditionSwitch`'s (or `ShowingSwitch`'s)
    displayables, every second positional argument, skipping their
    conditions; else every quoted string in it."""
    m = _CALL_HEAD_RE.match(expr)
    if m is not None and m.group(1).rsplit(".", 1)[-1] in _SWITCHES:
        args = _call_arguments(expr, m.end()) or []
        positional = [a for a in args if not _KEYWORD_ARG_RE.fullmatch(a)]
        return [ref for arg in positional[1::2]
                for ref in expression_refs(arg)]
    return [q.group(1) if q.group(1) is not None else q.group(2)
            for q in _ANY_QUOTED_RE.finditer(expr)]


@dataclass
class _Target:
    """What an image name or a displayable string shows (docs/plan.md
    Phase 60 item 9n): a ``picture`` (``found`` the resolved ``(kind,
    ledger rel, file, source ref, candidates)``), an ``atl`` frame list
    (``found`` the parser.AtlImage), a ``solid`` colour (``found`` its
    ``(r, g, b, a)``, or None with ``reason`` when the converter cannot
    show it: item 9n3), ``unchanged`` (the visual stays as it was) or
    ``none`` (``reason`` says why)."""

    kind: str
    found: Any = None
    reason: str | None = None
    notes: list[str] = field(default_factory=list)
    # Notes for the item's ledger entry only, never reported (a Movie's
    # arguments not carried, item 9n2).
    extra: list[str] = field(default_factory=list)
    # A video item's fields from its Movie (`holdLastFrame` for
    # `loop=False`, item 9n4).
    timing: dict[str, Any] = field(default_factory=dict)


def movie_call(value: str) -> dict[str, str] | None:
    """A `Movie(...)` expression's keyword arguments (docs/plan.md Phase
    60 item 9n2), else None for any other expression."""
    head = _CALL_HEAD_RE.match(value)
    if head is None or head.group(1).rsplit(".", 1)[-1] != "Movie":
        return None
    args = _call_arguments(value, head.end())
    if args is None:
        return None
    keywords: dict[str, str] = {}
    for arg in args:
        m = _KEYWORD_ARG_RE.fullmatch(arg)
        if m is not None:
            keywords[m.group(1)] = m.group(2).strip()
    return keywords


def movie_timing(keywords: dict[str, str]) -> dict[str, Any]:
    """A Movie's video item fields: `holdLastFrame` for one that plays
    once (`loop=False`, docs/plan.md Phase 60 item 9n4)."""
    return {"holdLastFrame": True} if keywords.get("loop") == "False" \
        else {}


def movie_notes(keywords: dict[str, str]) -> list[str]:
    """One note per Movie argument the video item does not carry."""
    notes = []
    for key, value in keywords.items():
        if key in _MOVIE_SHOWN_ARGS or (key == "loop"
                                        and value in ("True", "False")):
            continue
        why = _MOVIE_ARG_NOTES.get(key, "no video item field holds it")
        notes.append(f"Movie argument `{key}={value}` not carried: {why}")
    return notes


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
    # The say statement the item's text came from ("game/<rel>:LINE",
    # with `#k` for a monologue's paragraph k > 0: parser.say_key), which
    # Ren'Py's translations are matched to (``source`` is the visual's
    # line for a media item); None for an item without text.
    text_source: str | None = None
    # The say statements the text is made of, ``(say key, text)`` in order:
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
    # A picture made from nothing but its ledger entry, a still of one
    # colour (solid_key: ``"black"``, the black still a line before any
    # picture shows over, Phase 60 item 9n2, or ``"#rrggbb"``, a shown
    # solid colour, item 9n3), which kinetic_extract.assets.ship_generated
    # ships once the game's size is known; None for a picture from a
    # game file.
    generated: str | None = None
    # A still that repeats a held video's picture (a route's start,
    # Phase 60 item 9n6): that video's record. The still's source is the
    # video's, and the asset pass ships the video's `lastFrame` as its
    # `file` (kinetic_extract.assets._ship_held_still).
    last_frame_of: "ItemRecord | None" = None


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
        # True when no file answers this visual (an ATL frame list with a
        # frame found nowhere): it is never the pending visual or shipped
        # as a placeholder (BUG 1); its lines are kept over the last
        # visual (item 9n).
        self.unresolved = False
        # Resolution notes carried onto the item's ledger entry (e.g. an
        # ambiguous implicit name).
        self.notes: list[str] = []
        # The item `transition` its `with` gave (docs/content-format.md,
        # "Transitions"); None: a cut.
        self.transition: dict[str, Any] | None = None
        # An animation's frames, (ledger rel, file path, source ref,
        # generated) each, a generated frame (a solid colour's still, item
        # 9n5) with no file but its ItemRecord.generated name, and its
        # timing fields (parser.AtlImage.timing).
        self.frames: list[tuple[str | None, Path | None,
                                dict[str, str] | None, str | None]] = []
        # The translucent solid-colour frames of a frame list (item 9n5),
        # laid over black: a `show` over a picture cannot show them.
        self.translucent: list[str] = []
        self.timing: dict[str, Any] = {}
        # The emitted visual this one repeats at a route's start (Phase
        # 60 item 8b), else None. A repeat no line takes is dropped.
        self.origin: _Pending | None = None
        # The picture a say statement's temporary attributes go back to
        # after their line (Phase 60 item 9m): dropped, too, when no line
        # takes it.
        self.quiet = False
        # Why an unresolved visual resolves nowhere (item 9n).
        self.reason: str | None = None
        # A picture made from nothing (ItemRecord.generated, item 9n2).
        self.generated: str | None = None
        # A solid colour no line, pause, menu or transition has shown yet
        # (item 9n3): replaced now, Ren'Py never shows it.
        self.unseen = False
        # The record emit_media made of it, once emitted.
        self.emitted: ItemRecord | None = None
        # For a still repeating a held video (item 9n6): that video's
        # record, whose `lastFrame` the still shows.
        self.held_video: ItemRecord | None = None

    @property
    def drops_bare(self) -> bool:
        """Whether, with no line taking it, it is dropped rather than
        emitted bare."""
        return self.origin is not None or self.quiet or self.unseen

    def repeat(self, menu_source: str, note: str | None = None) -> _Pending:
        """This emitted visual again, for a route's first line (or, with
        ``note``, a shared span's): no transition (no new entrance); an
        animation that holds its last frame is that frame's picture, and
        a video that holds it its `lastFrame` still (item 9n6), as
        Ren'Py shows them by then."""
        holds = bool(self.timing.get("holdLastFrame"))
        held_video = self.emitted if self.kind == "video" and holds \
            else None
        held = held_video is not None or (self.kind == "animation"
                                          and holds)
        if held_video is not None:
            # The video's source: the asset pass ships the still as the
            # video's `lastFrame` (assets._ship_held_still).
            again = _Pending("image", self.name, self.asset_rel,
                             self.asset_abs, self.source, self.source_ref)
            again.held_video = held_video
        elif held:
            rel, path, ref, generated = self.frames[-1]
            again = _Pending("image", self.name, rel, path, self.source, ref)
            again.generated = generated
        else:
            again = _Pending(self.kind, self.name, self.asset_rel,
                             self.asset_abs, self.source, self.source_ref)
            again.frames, again.timing = self.frames, self.timing
            again.generated = self.generated
            again.held_video = self.held_video
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
                   automatic_names: Callable[[], Iterable[str]] | None
                   = None,
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

    ``automatic_names()`` gives the names Ren'Py defines from the images
    folder (kinetic_extract.images.ImplicitImages.automatic_names), which
    a say statement's image attributes choose among with the `image`
    definitions (docs/plan.md Phase 60 item 9n); called once, when the
    first attributes are applied.
    """
    result = TimelineResult()
    cues = CueWalker(parses, audio_files or AudioFiles(game_dir))
    pending: _Pending | None = None
    colors = character_colors(parses)
    # Each Character's image tag, and the `image` definitions by tag with
    # their attributes, for say statements' image attributes (item 9m).
    image_tags = character_images(parses)
    # The Characters with no name, whose lines are narration (item 9m2).
    nameless = nameless_characters(parses)
    # Tag -> each image name with the tag and its attributes: the `image`
    # definitions and the images folder's names (item 9n), built when
    # first needed.
    tagged: dict[str, list[tuple[str, frozenset[str]]]] | None = None
    # The parse whose statement say_picture is applying.
    parsed_now: FileParse | None = None
    # Every loose file under game/ by its path, and by its path in
    # lowercase, for names that match only in case (item 9n), built when
    # first needed.
    loose_lower: tuple[dict[str, str], dict[str, str]] | None = None
    # The unresolved visual whose lines are kept over the picture on
    # screen (item 9n): (name, source, whether a movie, why: the end of
    # its lines' note), else None.
    stale: tuple[str, str, bool, str] | None = None
    # Image names whose stand-in picture was reported.
    stand_ins: set[str] = set()
    # A channel that plays video -> the file it plays (`play movie "f"`),
    # and the channel and name of the `Movie` image on screen that shows
    # what its channel plays (item 9n2), else None.
    movie_files: dict[str, str] = {}
    movie_shown: tuple[str, str] | None = None
    # The channels a `Movie` image with no `play` file shows.
    movie_channels: set[str] = set()
    for def_tag, def_value in image_defs.values():
        movie_args = movie_call(def_value) if def_tag == "expr" else None
        if movie_args is not None and "play" not in movie_args:
            movie_channels.add(string_literal(
                movie_args.get("channel", '"movie"')) or "movie")
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
    # Those a linear `if` chain held and let wait on (item 9l).
    released: set[int] = set()
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

    def real_name(rel: str) -> str | None:
        """The loose file under game/ that ``rel`` names, as spelled on
        disk: ``rel`` itself, else the one whose path is ``rel`` but for
        case, as Ren'Py's loader matches a name (its ``lower_map``; item
        9n), else None. On a volume that ignores case a file found under
        another spelling is named as it is spelled on disk, so the ledger
        rebuilds on one that does not."""
        nonlocal loose_lower
        if loose_lower is None:
            loose_lower = ({}, {})
            for dirpath, _dirs, files in os.walk(game_dir):
                for fname in sorted(files):
                    found = Path(dirpath, fname).relative_to(
                        game_dir).as_posix()
                    loose_lower[0][found] = found
                    loose_lower[1].setdefault(found.lower(), found)
        exact, lower = loose_lower
        return exact.get(rel) or lower.get(rel.lower())

    def asset_paths(rel: str | None, kind: str,
                    ) -> tuple[str | None, Path | None,
                               dict[str, str] | None]:
        """(ledger rel, file path, source ref) for a script reference:
        the loose file under game/, else under game/images/, else an
        archive member, a name that differs only in case matching
        (item 9n). Ren'Py's loader looks a file name up under each of
        `config.search_prefixes`, `""` then `"images/"`, so `image x =
        "day1/x.jpg"` plays `game/images/day1/x.jpg` (docs/plan.md Phase
        57 item 4d), and drops a leading `/` and repeated ones."""
        if rel is None:
            return None, None, None
        rel = re.sub(r"/+", "/", rel).lstrip("/") or rel
        for prefix in ("", f"{IMAGES_PREFIX}/"):
            path = game_dir / prefix / rel
            if path.is_file() or (not prefix and path.exists()):
                found = real_name(Path(prefix + rel).as_posix()) \
                    or Path(prefix + rel).as_posix()
                return (f"game/{found}", game_dir / found,
                        {"path": f"game/{found}"})
        if asset_lookup is not None:
            hit = (asset_lookup(rel, kind)
                   or asset_lookup(f"{IMAGES_PREFIX}/{rel}", kind))
            if hit is not None:
                return hit
        for prefix in ("", f"{IMAGES_PREFIX}/"):
            found = real_name(prefix + rel)
            if found is not None:
                return (f"game/{found}", game_dir / found,
                        {"path": f"game/{found}"})
        ledger_rel = f"game/{Path(rel).as_posix()}"
        return ledger_rel, game_dir / rel, {"path": ledger_rel}

    def file_target(rel: str, kind: str) -> _Target:
        """The picture a file name shows, found as Ren'Py's loader finds
        it (asset_paths), or none."""
        ledger_rel, abs_path, src_ref = asset_paths(rel, kind)
        if (src_ref is not None and "archive" in src_ref) \
                or (abs_path is not None and abs_path.is_file()):
            return _Target("picture", (kind, ledger_rel, abs_path, src_ref, 1))
        return _Target("none", reason=f"defined source asset {rel!r} not "
                       "found")

    def implicit_target(name: str, kind: str, reason: str) -> _Target:
        """The implicit image index's picture for ``name``, or none for
        ``reason``."""
        hit = (implicit_lookup(name, "video" if kind == "video" else "image")
               if implicit_lookup is not None else None)
        if hit is None:
            return _Target("none", reason=reason)
        ledger_rel, abs_path, src_ref, n = hit
        return _Target("picture", (kind, ledger_rel, abs_path, src_ref, n))

    def displayable(text: str, depth: int) -> _Target:
        """What a string shows where Ren'Py takes a displayable (its
        ``renpy.easy.displayable``): one starting with `#` is a solid
        colour, one with a dot a file, any other an image name (item 9n:
        `image a = "b c"` is the image `b c`). A string with a `[`
        substitutes a variable when shown: none the converter knows."""
        text = text.strip()
        if not text or "[" in text:
            return _Target("none", reason=(
                f"image {text!r} names a variable the converter does not "
                "know" if text else "an empty image name"))
        if text.startswith("#"):
            colour = hex_colour(text)
            return _Target("solid", colour, reason=None if colour else (
                f"{text!r} is no colour Ren'Py reads"))
        if "." in text:
            return file_target(text, "image")
        if depth >= _MAX_DEPTH:
            return _Target("none", reason=f"image {text!r} names image "
                           f"names more than {_MAX_DEPTH} deep")
        return lookup(" ".join(text.split()), depth + 1)

    def first_picture(refs: list[str], depth: int, what: str,
                      empty: str) -> _Target:
        """The first of ``refs`` that shows a picture or a frame list,
        noted as standing in for ``what``; else ``empty`` (``none`` or
        ``unchanged``)."""
        for ref in refs:
            got = displayable(ref, depth)
            if got.kind in ("picture", "atl"):
                got.notes.append(f"{what}: shows its first picture that "
                                 f"resolves, {ref!r}")
                return got
        if empty == "unchanged":
            return _Target("unchanged", notes=[
                f"{what} and shows no picture that resolves: the visual "
                "stays as it was"])
        return _Target("none", reason=f"{what} and shows no picture that "
                       "resolves")

    def lookup(name: str, depth: int = 0) -> _Target:
        """What a scene/show name shows (docs/extracting.md, "Finding a
        script's files"): its `image` definition first, a frame list, a
        `Movie(play=...)` video, a string read as a displayable, another
        displayable's first picture that resolves (item 9n); else, or
        when the definition shows nothing, the implicit name index
        (BUG 5), a bare `black` or `white` a solid colour when no file of
        its name is (item 9n3)."""
        defined = image_defs.get(name)
        if defined is None:
            got = implicit_target(name, "image", "no image definition or "
                                  "asset answers the name")
            if name not in _SOLID_COLORS:
                return got
            if got.kind == "picture" and _named_file(got.found[1], name):
                got.notes.append(f"image {name!r} is a solid colour: the "
                                 "file of its name shows in its place")
                return got
            # Not a file of another folder that only shares the basename
            # (a `gui/black.png`).
            return _Target("solid", _SOLID_COLORS[name])
        tag, value = defined
        if tag == "atl":
            return _Target("atl", value)
        kind = "image"
        if tag == "atl-other":
            # Ren'Py shows the block, never a file of the name.
            return first_picture(
                value.refs, depth,
                f"ATL image {name!r} ({value.source}) is not a frame list",
                "unchanged")
        movie = movie_call(value) if tag == "expr" else None
        if tag == "file":
            got = displayable(value, depth)
        elif movie is not None:
            # A Movie is its video (item 9n2): its `play` file, else what
            # its channel plays (``movie``).
            kind = "video"
            play = movie.get("play")
            played = string_literal(play) if play is not None else None
            if played is not None:
                got = file_target(played, "video")
            elif play is not None:
                got = _Target("none", reason=f"Movie `play={play}` names no "
                              "file the converter knows")
            else:
                channel = string_literal(movie.get("channel", '"movie"'))
                got = _Target("movie", found=channel or "movie")
            got.extra = movie_notes(movie)
            got.timing = movie_timing(movie)
        elif _MOVIE_PLAY_RE.search(value):
            kind, ref = def_value_target(defined)
            got = file_target(ref, kind)
        elif re.match(r"\s*Solid\s*\(", value):
            colour, why = solid_call(value)
            got = _Target("solid", colour, reason=why or None)
        else:
            head = _CALL_HEAD_RE.match(value)
            got = first_picture(
                expression_refs(value), depth,
                f"image {name!r} is {head.group(1) if head else 'an'} "
                "expression the converter cannot show", "none")
        if got.kind == "solid":
            # A file of the name (a black picture beside `image black =
            # "#000"`) shows in its place (item 9n), not a generated
            # still (item 9n3).
            fallback = implicit_target(name, kind, "")
            if fallback.kind == "picture":
                fallback.notes.append(
                    f"image {name!r} is a solid colour: the file of its "
                    "name shows in its place")
                return fallback
        if got.kind != "none":
            return got
        fallback = implicit_target(name, kind, got.reason or "")
        return fallback if fallback.kind != "none" else got

    def resolve_frame(ref: str, depth: int = 0) -> Any:
        """An ATL frame's picture, resolved as a displayable string is
        (``displayable``), or None: a file on disk, under images/ or in
        the archives, or an image name, a one-frame ATL image's frame
        included; a solid colour the converter shows is ``("solid", (r,
        g, b, a))`` (item 9n5). A video, a colour it cannot show or an
        animation is no frame."""
        got = displayable(ref, depth)
        if got.kind == "atl":
            atl = got.found
            return resolve_frame(atl.frames[0].ref, depth + 1) \
                if atl.still and depth < _MAX_DEPTH else None
        if got.kind == "picture" and got.found[0] == "image":
            return got.found
        if got.kind == "solid" and got.found is not None:
            return "solid", got.found
        return None

    def atl_pending(parsed: FileParse, source: str, name: str,
                    atl: Any) -> _Pending:
        """The visual an ATL frame list shows (parser.AtlImage): an
        animation of its frames; a still when it has one frame or every
        frame is one picture; unresolved, its ``reason`` naming the
        frame, when a frame resolves nowhere (item 9n: its lines are kept
        over the last visual). A solid-colour frame is a generated still
        of its colour (item 9n5), a translucent one laid over black and
        named in ``translucent``."""
        hits = []
        frames = []
        translucent = []
        for frame in atl.frames:
            hit = resolve_frame(frame.ref)
            if hit is None:
                pend = _Pending("image", name, None, None, source)
                pend.unresolved = True
                pend.reason = (f"ATL frame {frame.ref!r} of image {name!r} "
                               f"({frame.source}): no image definition or "
                               "asset answers it")
                return pend
            if hit[0] == "solid":
                colour = hit[1]
                if colour[3] < 255:
                    translucent.append(frame.ref)
                frames.append((None, None, None,
                               solid_key(over_black(colour))))
            else:
                hits.append(hit)
                frames.append((hit[1], hit[2], hit[3], None))
        if atl.still or len({(f[0], f[3]) for f in frames}) == 1:
            ledger_rel, abs_path, src_ref, generated = frames[0]
            pend = _Pending("image", name, ledger_rel, abs_path, source,
                            src_ref)
            pend.generated = generated
            pend.notes.append(
                f"ATL image ({atl.source}) with one frame: a still"
                if atl.still else
                f"ATL frames ({atl.source}) all show one picture: a still")
        else:
            pend = _Pending("animation", name, None, None, source)
            pend.frames = frames
            pend.timing = atl.timing()
            pend.notes.append(
                f"ATL frame list ({atl.source}): {len(frames)} frames")
        colours = sorted({f[3] for f in frames if f[3] is not None})
        if colours:
            pend.notes.append(
                "ATL solid-colour frames: a still of each colour at the "
                f"game's size ({', '.join(colours)})")
        if translucent:
            pend.translucent = translucent
            pend.notes.append(
                "ATL frames " + ", ".join(repr(r) for r in translucent)
                + " are translucent: laid over black")
        for hit in hits:
            if hit[4] > 1:
                chosen = hit[1].rsplit("!", 1)[-1]
                pend.notes.append(
                    f"ATL frame of {name!r} is ambiguous: {hit[4]} assets "
                    f"answer it; using the first in sorted order "
                    f"({chosen})")
        return pend

    def target_pending(parsed: FileParse, source: str, name: str,
                       got: _Target) -> _Pending | None:
        """The visual a looked-up name shows (``lookup``): a picture, or a
        frame list's animation or still (unresolved when a frame is), or
        a solid colour's generated still (item 9n3), over black when it
        is translucent; None for a colour the converter cannot show, an
        unchanged visual or none."""
        if got.kind == "solid" and got.found is not None:
            pend = solid_pending(source, name, got.found)
        elif got.kind == "atl":
            pend = atl_pending(parsed, source, name, got.found)
        elif got.kind == "picture":
            kind, ledger_rel, abs_path, src_ref, n = got.found
            pend = _Pending(kind, name, ledger_rel, abs_path, source,
                            src_ref)
            if n > 1:
                chosen = ledger_rel.rsplit("!", 1)[-1]
                pend.notes.append(
                    f"image name {name!r} is ambiguous: {n} assets answer "
                    f"it; using the first in sorted order ({chosen})")
        else:
            return None
        pend.notes[:0] = got.notes + got.extra
        if pend.kind == "video":
            pend.timing = dict(got.timing)
        return pend

    def solid_pending(source: str, name: str,
                      colour: tuple[int, int, int, int]) -> _Pending:
        """A still of one colour (item 9n3), laid over black when
        translucent, as on Ren'Py's empty scene."""
        rgb = over_black(colour)
        pend = _Pending("image", name, None, None, source)
        pend.generated = solid_key(rgb)
        written = "#" + "".join(f"{c:02x}" for c in rgb)
        pend.notes.append(
            f"solid colour {written}"
            + (f" (alpha {colour[3]}, laid over black)"
               if colour[3] < 255 else "")
            + ": a still of that colour at the game's size")
        return pend

    def bare_scene(event: Event) -> _Target:
        """What a `scene` naming no image shows (item 9n5): black, as
        Ren'Py clears the layer, noted when the game's own `image black`
        is not the built-in solid black."""
        got = _Target("solid", _SOLID_COLORS[BLACK])
        own = lookup(BLACK)
        if own.kind != "solid" or own.found != _SOLID_COLORS[BLACK]:
            got.extra.append(
                "a bare `scene` clears the layer: black, as Ren'Py shows "
                "it, not the game's own image 'black'")
        return got

    def atl_alpha(parsed: FileParse, event: Event, name: str,
                  got: _Target) -> tuple[_Target, float | None]:
        """A solid colour with the `alpha` its `scene x:`/`show x:` ATL
        block ends at (item 9n5), and that alpha; the colour as it is,
        and None, when the block sets none, or sets one the converter
        cannot follow (noted and reported)."""
        alpha, why = atl_end_alpha(event.atl)
        if why is not None:
            note = (f"ATL `alpha` of {name!r} at {event.source} not read "
                    f"({why}): the colour shows as without the block")
            parsed.reports.append(Report(event.source, name, note))
            return _Target("solid", got.found, notes=got.notes,
                           extra=got.extra + [note]), None
        if alpha is None:
            return got, None
        r, g, b, a = got.found
        faded = (r, g, b, round(a * max(0.0, alpha)))
        return _Target("solid", faded, notes=got.notes, extra=got.extra + [
            f"ATL block at {event.source} ends at alpha {alpha:g}: the "
            "colour shown with that alpha"]), alpha

    def play_video(parsed: FileParse, source: str, asset: str | None,
                   name: str) -> _Pending | None:
        """The visual a video file shows, or None when the file is found
        nowhere: the visual then stays as it was, its lines kept over it
        until `stop movie`, reported (item 9n)."""
        nonlocal stale
        ledger_rel, abs_path, src_ref = asset_paths(asset, "video")
        if not (src_ref is not None and "archive" in src_ref) \
                and (abs_path is None or not abs_path.exists()):
            stale = (Path(asset or "movie").stem, source, True,
                     "resolves nowhere")
            parsed.reports.append(Report(
                source, f"movie {asset}",
                f"unresolvedVisual: video asset {asset!r} not found; its "
                f"lines {KEPT}"))
            return None
        return _Pending("video", name, ledger_rel, abs_path, source, src_ref)

    def flush_bare() -> None:
        """Emit an unconsumed visual (replaced or at end of flow) bare;
        a route start's repeat of the menu's visual that no line took is
        dropped."""
        nonlocal pending
        if (pending is not None and not pending.consumed
                and not pending.drops_bare):
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
        item yet and no visual waiting that the `menu-open` would emit."""
        if not menu_stack or not menu_stack[-1]["starts"]:
            return False
        if len(result.items) > menu_stack[-1]["starts"][-1]:
            return False
        return pending is None or pending.consumed or pending.drops_bare

    def tags() -> dict[str, list[tuple[str, frozenset[str]]]]:
        """Tag -> each image name with the tag and its attributes: the
        `image` definitions, and the names Ren'Py gives the images
        folder's files (item 9n), which a definition of the same name
        replaces, as Ren'Py defines those only where none is."""
        nonlocal tagged
        if tagged is None:
            tagged = {}
            names = dict.fromkeys(image_defs)
            for auto in (automatic_names() if automatic_names else ()):
                names.setdefault(auto)
            for key in names:
                parts = key.split()
                if parts:
                    tagged.setdefault(parts[0], []).append(
                        (key, frozenset(parts[1:])))
        return tagged

    def attribute_name(tag: str, shown: list[str],
                       attrs: tuple[str, ...]) -> str:
        """The image a `show` of ``tag`` with ``attrs`` (`-x` removing x)
        picks while ``tag`` shows with the attributes ``shown``, as
        Ren'Py's ``choose_image`` picks among the `image` definitions
        and the images folder's names (``tags``): each of the name's
        attributes given or kept from the shown ones, every given one
        among them, the most attributes winning, a tie none. With no such definition, the name `show tag attrs` writes
        (the shown attributes, those removed aside, when none is given),
        which the files may answer."""
        remove = {a[1:] for a in attrs if a.startswith("-")}
        required = {a for a in attrs if not a.startswith("-")}
        allowed = required | {a for a in shown if a not in remove}
        best: list[str] = []
        size = -1
        for key, have in tags().get(tag, ()):
            if required <= have <= allowed:
                if len(have) > size:
                    best, size = [key], len(have)
                elif len(have) == size:
                    best.append(key)
        if len(best) == 1:
            return best[0]
        if required:
            return " ".join([tag] + [a for a in attrs
                                     if not a.startswith("-")])
        return " ".join([tag] + [a for a in shown if a not in remove])

    def say_name(tag: str, shown: list[str],
                 attrs: tuple[str, ...]) -> tuple[str, str | None]:
        """The image a say statement's attributes ``attrs`` show while
        ``tag`` shows with ``shown`` (item 9n3): the image named the tag
        and the attributes as written, when there is one and none removes
        (`-x`), as Ren'Py's ``apply_attributes`` takes it first; else the
        attribute choice (``attribute_name``). With it, the attribute
        choice the exact name won over, else None."""
        chosen = attribute_name(tag, shown, attrs)
        exact = " ".join((tag,) + attrs)
        if any(a.startswith("-") for a in attrs) or exact == chosen:
            return chosen, None
        if any(key == exact for key, _have in tags().get(tag, ())):
            return exact, chosen
        return chosen, None

    def show_name(name: str, scene: bool) -> str:
        """The image a `scene`/`show` of ``name`` that names no image
        shows, as Ren'Py's ``apply_attributes`` picks it (item 9n2): for
        a `show` of the tag of the picture on screen, the attribute
        choice of a say statement's attributes (``attribute_name``: the
        given ones, `-x` removing, the shown ones kept); for a `scene`,
        which clears the layer, the choice with none kept. ``name``
        itself when nothing else answers."""
        parts = name.split()
        if not parts:
            return name
        current = pending if pending is not None else on_screen
        shown = ((current.name or "").split()
                 if current is not None and not scene else [])
        return attribute_name(parts[0], shown[1:] if shown[:1] == parts[:1]
                              else [], tuple(parts[1:]))

    def say_pending(name: str, source: str) -> _Pending | None:
        """The picture an image name shows, resolved as a `show` of it is,
        or None when nothing answers it (nothing reported: the picture on
        screen stays)."""
        pend = target_pending(parsed_now, source, name, lookup(name))
        if pend is None or pend.unresolved:
            return None
        pend.notes.append(f"picture {name!r} from the image attributes of "
                          f"the say statement at {source}")
        return pend

    def say_picture(parsed: FileParse, event: Event
                    ) -> tuple[_Pending | None, str | None]:
        """Apply a say statement's image attributes (Phase 60 item 9m):
        when the speaker's Character names an image tag and the picture
        on screen has it, the attributes change that picture as `show tag
        attrs` would, and temporary (`@`) ones last for the one line: the
        answer is then the picture to go back to after it (None when it
        is the same), with no note. Otherwise the picture stays, and the
        note says why the attributes were ignored."""
        nonlocal pending, parsed_now
        parsed_now = parsed
        words = " ".join(event.attributes + (
            ("@",) + event.temporary if event.temporary else ()))
        tag = (None if event.speaker_named or event.speaker is None
               else image_tags.get(speaker_var(event.speaker)))
        if tag is None:
            return None, (f"image attributes {words!r} ignored: speaker "
                          f"{event.speaker!r} has no image tag the "
                          "converter reads (Character `image=`)")
        current = pending if pending is not None else on_screen
        shown = (current.name or "").split() if current is not None else []
        if not shown or shown[0] != tag:
            return None, (f"image attributes {words!r} ignored: no {tag!r} "
                          "picture on screen (Ren'Py then shows them in a "
                          "side image only)")
        name, passed = say_name(tag, shown[1:],
                                event.attributes + event.temporary)
        back = None
        if event.temporary:
            back_name, _passed = say_name(tag, shown[1:], event.attributes)
            if back_name != name:
                back = say_pending(back_name, event.source)
                if back is not None:
                    back.quiet = True
        if name == current.name:
            return back, None
        new = say_pending(name, event.source)
        if new is None:
            return None, (f"image attributes {words!r} ignored: no image "
                          f"answers {name!r}")
        if passed is not None:
            new.notes.append(
                f"picture {name!r} is the image named as the attributes are "
                "written (the exact name), which Ren'Py takes before its "
                f"attribute choice ({passed!r})")
        if pending is not None and not pending.consumed:
            # Replaced before any line showed it: the line shows the
            # changed picture in its place, with its transition.
            new.transition = pending.transition
        else:
            flush_bare()
        pending = new
        return back, None

    def emit_media(pend: _Pending, speaker: str | None,
                   text: str | None,
                   line_source: str | None = None,
                   named: bool = False) -> ItemRecord:
        nonlocal on_screen
        on_screen = pend
        item_id = result._next_id(_slug(pend.name or pend.asset_rel,
                                        "scene" if pend.kind == "image"
                                        else "movie"))
        item: dict[str, Any] = {"id": item_id, "type": pend.kind}
        record = ItemRecord(item=item, source=pend.source,
                            asset=pend.asset_rel, asset_abs=pend.asset_abs,
                            source_ref=pend.source_ref,
                            text_source=line_source,
                            generated=pend.generated,
                            last_frame_of=pend.held_video)
        pend.emitted = record
        record.notes.extend(pend.notes)
        if pend.kind == "animation":
            item.update(pend.timing)
            for k, (rel, path, ref, generated) in enumerate(pend.frames):
                record.frames.append(ItemRecord(
                    item={"id": f"{item_id}.f{k:03d}", "type": "image"},
                    source=pend.source, asset=rel, asset_abs=path,
                    source_ref=ref, generated=generated))
                if ref is not None and "archive" in ref:
                    record.notes.append(
                        f"frame {k} extracted from .rpa archive ({rel})")
            # The first frame stands for the animation in the size probe,
            # as an image item's one file does (a repeat is counted once).
            if pend.frames and pend.frames[0][1] is not None \
                    and pend.frames[0][1].exists() and pend.origin is None:
                result.source_images.append(pend.frames[0][1])
        elif pend.from_archive:
            # Provenance for assets resolved out of an .rpa archive
            # (kinetic_extract.rpa.AssetArchives): the ledger asset reads
            # "game/<archive>!<key>"; the `media` entry's source names the
            # archive and member with the member's sha256 and size.
            record.notes.append(
                f"asset extracted from .rpa archive ({pend.asset_rel})")
        if pend.kind == "animation" or pend.generated is not None:
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
            item.update(pend.timing)  # a Movie's `holdLastFrame`
            set_video_duration(record)
        apply_line(item, record, speaker, text, named)
        if pend.transition is not None:
            item["transition"] = dict(pend.transition)
        cues.attach(record)
        result.items.append(record)
        check_limit()
        return item

    def speaker_var(speaker: str) -> str:
        """The Character variable a say statement's speaker names: itself,
        or the `character` store's (`define character.e = ...`), which
        Ren'Py's say statement also looks in."""
        store = f"character.{speaker}"
        if (speaker not in characters and speaker not in nameless
                and (store in characters or store in nameless)):
            return store
        return speaker

    def apply_line(item: dict[str, Any], record: ItemRecord,
                   speaker: str | None, text: str | None,
                   named: bool = False) -> None:
        nonlocal last_line
        if text is None:
            return
        if speaker is not None and named:
            # `"Ann" "Hello."`: the speaker's name as written.
            item["speaker"] = speaker
        elif speaker is not None and (var := speaker_var(speaker)) \
                in nameless:
            # `Character(None, ...)`: Ren'Py shows the line as narration
            # (item 9m2), which is never coloured.
            record.notes.append(
                f"speaker {speaker!r} is a nameless Character: narration, "
                "as Ren'Py shows it")
            color = colors[var].text_color if var in colors else None
            if color is not None:
                record.notes.append(
                    f"speaker {speaker!r} text colour {color} not carried: "
                    "narration is never coloured")
        elif speaker is not None:
            item["speaker"] = characters.get(var, speaker)
            if var in colors:
                known = result.speaker_colors.setdefault(item["speaker"], [])
                if colors[var] not in known:
                    known.append(colors[var])
            if var in characters:
                record.notes.append(
                    f"speaker {speaker!r} display name from Character define")
            elif "." in speaker:
                record.notes.append(
                    f"dotted speaker {speaker!r}: no Character the converter "
                    "reads; its name kept as written")
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
        record.text_parts.append((say_key(event.source, event.paragraph),
                                  event.text))
        record.notes.append(f"extended by the extend line at {event.source}")
        note_interpolations(record)

    def resolve_awaiting(follows: dict[str, Any] | None = None) -> None:
        """The decisions waiting for their join's first item get it when
        an item came since their `menu-close`, else none. A menu opening
        (``follows``) right after one that got none would hang off that
        one's last route: it stays linear. An `if` chain doing so also
        holds the waiting decision (docs/plan.md Phase 60 item 9l), whose
        join's first item is then the first that follows: the chain's,
        or its join's."""
        for cand, count in awaiting:
            if len(result.items) > count:
                cand["continue_idx"] = count
            elif follows is not None and id(cand) in released:
                pass   # it gives up there: the menu stays a decision
            elif follows is not None:
                follows["reject"] = (
                    f"the menu follows the menu at "
                    f"{cand['record'].source} with no line between")
                if follows["record"].condition is not None:
                    follows.setdefault("held", []).append((cand, count))
        awaiting.clear()

    def release_held(ms: dict[str, Any], outcome: dict[str, Any] | None
                     ) -> None:
        """At a linear menu's close, the decisions it held (above) take
        its first item, else wait on with its join's path when the walk
        lays that out next (the outcome's ``awaits``), giving up at a
        menu that path meets before any item."""
        for cand, count in ms.get("held", ()):
            if len(result.items) > count:
                cand["continue_idx"] = count
            elif (outcome or {}).get("awaits"):
                awaiting.append((cand, count))
                released.add(id(cand))

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
                if pending is not None:
                    # A solid colour this shows is an item (item 9n3).
                    pending.unseen = False
            if event.kind == "with":
                if pending is not None and (event.name or "None") != "None":
                    pending.unseen = False
                got = read_transition(parsed, event.source,
                                      event.name or "None")
                if (fresh and pending is not None
                        and not pending.consumed):
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
                # `show expression "file"` shows the string as Ren'Py
                # reads a displayable (item 9n); a name, the image
                # Ren'Py's attribute choice picks (item 9n2).
                got = (displayable(event.asset, 0) if event.asset is not None
                       else bare_scene(event) if event.bare
                       else lookup(name))
                chosen = name
                if event.asset is None and got.kind == "none":
                    # No image of the exact name (Ren'Py's first pick).
                    alt = show_name(name, event.scene)
                    alt_got = lookup(alt) if alt != name else got
                    if alt_got.kind != "none":
                        chosen, got = alt, alt_got
                current = pending if pending is not None else on_screen
                if chosen != name and current is not None \
                        and current.name == chosen:
                    # `show eve` while `eve casual` shows: the picture
                    # stays.
                    fresh = False
                    continue
                if got.kind == "movie":
                    # A Movie with no `play` file shows what its channel
                    # plays (item 9n2), nothing while it plays nothing.
                    playing = movie_files.get(got.found)
                    if playing is None:
                        fresh = False
                        movie_shown = (got.found, chosen)
                        continue
                    pend = play_video(parsed, event.source, playing, chosen)
                    if pend is None:
                        fresh = False
                        movie_shown = (got.found, chosen)
                        continue
                    pend.timing = dict(got.timing)
                    pend.notes[:0] = got.extra + [
                        f"Movie image {chosen!r} shows the {got.found!r} "
                        f"channel's video ({playing})"]
                    flush_bare()
                    stale = None
                    pending = pend
                    movie_shown = (got.found, chosen)
                    if clause is not None:
                        pending.transition = clause.transition
                    continue
                movie_shown = None
                faded = None
                if got.kind == "solid" and got.found is not None \
                        and event.atl is not None:
                    got, faded = atl_alpha(parsed, event, name, got)
                if got.kind == "solid" and (
                        got.found is None
                        or (got.found[3] < 255 and not event.scene
                            and (pending is not None
                                 or on_screen is not None))):
                    # A colour the converter cannot show, or a translucent
                    # one shown over a picture, which a still cannot lay
                    # over it (item 9n3): the picture stays, its lines
                    # kept over it, reported. A `scene` clears to black,
                    # which a translucent colour is laid over.
                    fresh = False
                    why = (f"is a solid colour the converter cannot show "
                           f"({got.reason})" if got.found is None else
                           "is a translucent solid colour (#"
                           + "".join(f"{c:02x}" for c in got.found)
                           + (f", its ATL `alpha` ending at {faded:g}"
                              if faded is not None else "")
                           + "), which a still cannot lay over the "
                           "picture")
                    stale = (name, event.source, False, why)
                    parsed.reports.append(Report(
                        event.source, name, f"solid colour: {name!r} {why}; "
                        f"its lines {KEPT}"))
                    continue
                if got.kind == "unchanged":
                    # An ATL image showing no picture (a flash): the
                    # visual stays as it was (item 9n).
                    fresh = False
                    if name not in stand_ins:
                        stand_ins.add(name)
                        parsed.reports.append(Report(
                            event.source, name, got.notes[0]))
                    continue
                pend = target_pending(parsed, event.source, chosen, got)
                if pend is not None and chosen != name:
                    pend.notes.append(
                        f"picture {chosen!r} chosen by the attributes of "
                        f"`{'scene' if event.scene else 'show'} {name}`, "
                        "as Ren'Py chooses an image")
                if pend is not None and pend.translucent \
                        and not event.scene \
                        and (pending is not None or on_screen is not None):
                    # A frame list with a translucent colour frame shown
                    # over a picture (item 9n5), as a translucent colour
                    # is (item 9n3): the picture stays.
                    fresh = False
                    why = ("is a frame list whose solid-colour frames "
                           + ", ".join(repr(r) for r in pend.translucent)
                           + " are translucent, which a still cannot lay "
                           "over the picture")
                    stale = (name, event.source, False, why)
                    parsed.reports.append(Report(
                        event.source, name, f"solid colour: {name!r} {why}; "
                        f"its lines {KEPT}"))
                    continue
                if pend is None or pend.unresolved:
                    # Item 9n: a visual that resolves nowhere leaves the
                    # picture on screen as it was, and its lines are kept
                    # over that one, reported (BUG 1 dropped them; it is
                    # still never shipped as a missing-file placeholder).
                    fresh = False
                    stale = (name, event.source, False, "resolves nowhere")
                    why = (pend.reason if pend is not None else got.reason)
                    parsed.reports.append(Report(
                        event.source, name,
                        f"unresolvedVisual: {why}; its lines {KEPT}"))
                    continue
                if got.notes and name not in stand_ins:
                    # A stand-in picture, reported once per image.
                    stand_ins.add(name)
                    parsed.reports.append(Report(event.source, name,
                                                 got.notes[0]))
                flush_bare()
                stale = None
                pending = pend
                # A solid colour replaced before anything shows it is no
                # item (item 9n3).
                pending.unseen = pend.generated is not None and clause is None
                if clause is not None:
                    pending.transition = clause.transition
            elif event.kind == "video":
                movie_shown = None
                pend = play_video(parsed, event.source, event.asset,
                                  Path(event.asset or "movie").stem)
                if pend is None:
                    fresh = False
                    continue
                fresh = True
                flush_bare()
                stale = None
                pending = pend
            elif event.kind == "audio" and movie_channels \
                    and (movie := cues.movie_play(event)) is not None \
                    and movie[0] in movie_channels:
                # `play movie "f"`: what a Movie image of the channel shows
                # (item 9n2), at once when one is on screen.
                channel, playing = movie
                if playing is None:
                    movie_files.pop(channel, None)
                    continue
                movie_files[channel] = playing
                if movie_shown is None or movie_shown[0] != channel:
                    continue
                pend = play_video(parsed, event.source, playing,
                                  movie_shown[1])
                if pend is None:
                    fresh = False
                    continue
                image = image_defs.get(movie_shown[1])
                pend.notes[:0] = (movie_notes(movie_call(image[1]) or {})
                                  if image is not None else []) + [
                    f"Movie image {movie_shown[1]!r} shows the {channel!r} "
                    f"channel's video ({playing})"]
                fresh = True
                flush_bare()
                stale = None
                pending = pend
            elif event.kind == "stop-movie":
                movie_files.pop("movie", None)
                flush_bare()
                if stale is not None and stale[2]:
                    # The movie that resolved nowhere ends.
                    stale = None
            elif (event.kind == "dialogue" and is_extend(event)
                  and last_line is not None):
                extend_line(last_line, event)
            elif event.kind == "dialogue":
                speaker = event.speaker
                if is_extend(event):
                    # No line before it in the walk: Ren'Py's
                    # narrator says it.
                    speaker = None
                restore, attribute_note = None, None
                if event.attributes or event.temporary:
                    restore, attribute_note = say_picture(parsed, event)
                if pending is None and on_screen is None:
                    # No picture before it (item 9n2): it shows over
                    # black, Ren'Py's empty scene, one black still for
                    # every such line (BUG 1 and item 9n dropped one
                    # whose visual resolved nowhere).
                    pending = _Pending("image", BLACK, None, None,
                                       event.source)
                    pending.generated = BLACK
                    pending.notes.append(BLACK_NOTE)
                if pending is not None and not pending.consumed:
                    emit_media(pending, speaker, event.text,
                               say_key(event.source, event.paragraph),
                               event.speaker_named)
                    pending.consumed = True
                else:
                    item_id = result._next_id("line")
                    item: dict[str, Any] = {"id": item_id,
                                            "type": "text"}
                    record = ItemRecord(item=item, source=event.source,
                                        asset=None,
                                        text_source=say_key(
                                            event.source, event.paragraph))
                    if pending is None:
                        record.notes.append(
                            "dialogue with no preceding visual in flow")
                    apply_line(item, record, speaker, event.text,
                               event.speaker_named)
                    cues.attach(record)
                    result.items.append(record)
                    check_limit()
                if stale is not None and last_line is not None:
                    last_line.notes.append(
                        f"{KEPT}: visual {stale[0]!r} at {stale[1]} "
                        f"{stale[3]}")
                if attribute_note is not None and last_line is not None:
                    last_line.notes.append(attribute_note)
                if restore is not None:
                    # The picture the temporary attributes go back to.
                    pending = restore
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
                if not result.items:
                    # No item before it (item 9n3): a black still, Ren'Py's
                    # empty scene, is the item the decision follows.
                    black = _Pending("image", BLACK, None, None,
                                     event.source)
                    black.generated = BLACK
                    black.notes.append(BLACK_MENU_NOTE.format(event.source))
                    emit_media(black, speaker=None, text=None)
                state = {
                    "record": parsed.menus[int(event.name)],
                    "parsed": parsed,
                    "index": int(event.name),
                    "after": len(result.items) - 1,
                    "starts": [],
                    # The visual on screen at the menu, which every
                    # route's first line is said over, and the one that
                    # resolved nowhere after it (item 9n).
                    "screen": on_screen,
                    "stale": stale,
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
                    stale = top["stale"]
            elif event.kind == "shared-mark":
                # Where the walk first read a shared span (Phase 60 item
                # 9i): what is on screen there, and what plays.
                span_marks[event.name or ""] = {
                    "screen": (pending if pending is not None
                               and not pending.consumed else on_screen),
                    "stale": stale,
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
                    stale = mark.get("stale")
                    if screen is not None and (
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
                    release_held(menu_stack[-1], event.outcome)
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
