"""``kinetic-media posters``: find the video items whose poster is not the
frame at their ``startSeconds``, and plan the ship requests that fix
them (docs/extracting.md, "kinetic-media posters"; docs/plan.md
Phases 44 and 45).

docs/content-format.md ("Video playback ranges") makes a video item's
poster the frame at its ``startSeconds`` (0 when unset). The check:

- builds one lookup from the ledgers, once: media path -> every record
  that made it (the entry and its ``alsoFrom``), across a folder's
  build-ledger.json and media-ledger.json, so each item costs a few
  dict lookups however big the ledger is;
- passes a poster that a ``poster`` step at the item's start made from
  a source (by sha256) that also made the item's video file; a recorded
  other start or other source fails;
- compares pixels when the ledger cannot say (no entry for the poster
  or the video, or poster steps without ``startSeconds``): the poster
  against the frame at the start, from the video's original source when
  the ledger names it and it is still under the game root, else from
  the folder's video file. Above ``POSTER_TOLERANCE`` it fails. A poster
  that passes by ledger is never decoded; one that fails by ledger is,
  for the report's difference and the two frames' mean luma (a start
  below ``DARK_START_LUMA`` is a dark start).

A video that holds its last frame (``holdLastFrame``, docs/plan.md
Phase 60 item 9n6) has its ``lastFrame`` still checked the same way
(``LastFrameFinding``): by a ``lastFrame`` step at the item's
``endSeconds`` (null: the file's end) from the video's source, else by
pixels against the range's last frame, decoded as the ship step takes
it (``assets.last_frame_step``).

``read_items`` and ``select_items`` limit the check to the item ids a
``--items`` file lists. The check writes nothing but scratch files
under ``work``. ``plan_fix``
turns the failures into ship requests, one per distinct (video source
sha256, startSeconds), and for last frames (source sha256, startSeconds,
endSeconds), from the ledger's source refs; ``media_cli``
ships them with the code ``kinetic-media ship`` runs.
"""

from __future__ import annotations

import itertools
import json
import tempfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, NamedTuple

from . import assets, media_tools
from .decoders import Decoder, describe
from .media import sha256_file
from .rebuild import RebuildError, load_ledgers, read_ledger, source_ref
from .rpa import RpaError, open_archive
from .ship import ListError, parse_requests

MANIFEST_NAME = "manifest.json"

# The pixel check's pass limit: mean absolute difference per channel
# (0-255) between a poster and the frame at its item's start. Measured
# with the pinned tools (2026-11-09) on five 1080p VP9 videos from two
# corpus games, one 1080p VP8 video, and synthetic clips (test patterns
# and gradients, 96x54 to 640x360):
# - correct posters: an older JPEG q90 poster against the exact frame
#   0.02-1.36 at 1080p, up to 2.04 at 640x360; the frame of the folder's
#   H.264 transcode against the source's 0.04-1.23 at 1080p, up to 0.96
#   at 640x360; a JPEG q90 poster against the transcode's frame (neither
#   in the ledger) up to 1.51 at 1080p, 2.31 at 640x360;
# - wrong posters: frame 0 against the frame at a later start, on the
#   1080p game videos, 0.75-108; 15 of the 19 starts measured are above
#   3, the other four are a near-static logo fade (0.75) and slow loops
#   of one moving figure (2.53-2.74). Synthetic: 3.2-150.
# 3.0 passes every correct case at 640x360 and up. Tiny, sharp test
# patterns (96x54, 160x90) push a correct JPEG q90 poster to 3-9; such
# a poster fails, and --fix only ships a lossless one in its place.
POSTER_TOLERANCE = 3.0

# A FAIL line says "dark start" when the frame at the item's start has a
# mean Rec. 601 luma (0-255) below this. Measured with the pinned tools
# (2026-11-09), frames taken as the poster recipe takes them:
# - black or near-black starts: frame 0 of a fade-in from black 0.0
#   (three synthetic 640x360 clips, one corpus cutscene); a corpus
#   video's near-black first 0.25 s 1.7; one frame into a synthetic
#   1.5-2 s fade at 24 fps 1.5-2.4 (two frames in: 2.9-5.2);
# - real pictures, 452 videos from two corpus games, frames in the
#   first 1-3 s: a credits video 9.9-11.9; 73 videos named as night
#   scenes 10.8 at the darkest (median 36); every other frame 13.1 and
#   up (medians 64 and 90); a synthetic dim night scene 17.1.
# 6.0 sits in the gap between 2.4 and 9.9.
DARK_START_LUMA = 6.0

# Rec. 601 luma weights for R, G, B.
_LUMA = (0.299, 0.587, 0.114)

# Finding.status values.
BY_LEDGER, BY_PIXELS, FAILED, SKIPPED = "ledger", "pixels", "failed", \
    "skipped"
_UNKNOWN = "unknown"  # waiting for the pixel check


class InputError(Exception):
    """The check cannot start: no usable manifest or ledger."""


class PixelError(Exception):
    """The poster or the frame cannot be decoded and compared."""


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise InputError(f"{path}: cannot read the manifest: {exc}") \
            from exc
    if not isinstance(manifest, dict) or not isinstance(
            manifest.get("items"), list):
        raise InputError(f"{path}: not a Kinetic manifest (no \"items\" "
                         "array)")
    return manifest


def load_media(folder: Path, ledger: Path | None) -> list[dict[str, Any]]:
    """The ledger ``media`` sections to check against: `ledger` alone
    when given, else the folder's build-ledger.json and/or
    media-ledger.json, as ``rebuild`` reads them."""
    try:
        if ledger is not None:
            return [read_ledger(ledger)["media"]]
        return [found["media"] for _, found in load_ledgers(folder)]
    except RebuildError as exc:
        raise InputError(str(exc)) from exc


def made_index(sections: list[dict[str, Any]]) -> dict[str, list[dict]]:
    """Media path -> every record that made it (the entry, then its
    ``alsoFrom``), across all `sections`; two ledgers naming one path
    are merged."""
    index: dict[str, list[dict]] = {}
    for media in sections:
        for ref, entry in media.items():
            if not isinstance(entry, dict):
                continue
            also = entry.get("alsoFrom")
            index.setdefault(ref, []).extend(
                made for made in [entry, *(also if isinstance(also, list)
                                           else [])]
                if isinstance(made, dict))
    return index


def video_items(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """Every video item. Route items are spans of the one ``items``
    array (docs/content-format.md, "Branches"), so this is all of them."""
    return [item for item in manifest["items"]
            if isinstance(item, dict) and item.get("type") == "video"]


def held_items(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """Every video item that holds its last frame (``holdLastFrame``
    true), whose ``lastFrame`` the check checks too."""
    return [item for item in video_items(manifest)
            if item.get("holdLastFrame") is True]


_UNKNOWN_IDS_NAMED = 10  # an unknown-ids error names at most this many


def read_items(path: Path) -> list[str]:
    """The item ids a ``--items`` file lists: a JSON array of strings
    when its first non-blank character is ``[``, else one id per line
    (stripped; blank lines and lines starting with ``#`` ignored)."""
    try:
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError) as exc:
        raise InputError(f"{path}: cannot read the items file: {exc}") \
            from exc
    if not text.lstrip().startswith("["):
        return [line for line in (raw.strip() for raw in text.splitlines())
                if line and not line.startswith("#")]
    try:
        ids = json.loads(text)
    except json.JSONDecodeError as exc:
        raise InputError(f"{path}: not a JSON array of item ids: {exc}") \
            from exc
    if not isinstance(ids, list) or not all(isinstance(i, str)
                                            for i in ids):
        raise InputError(f"{path}: not a JSON array of item ids (strings)")
    return ids


def select_items(manifest: dict[str, Any], path: Path) -> set[str]:
    """The ids the ``--items`` file `path` lists, InputError naming
    those that are no manifest item's id, so a typo cannot select
    nothing. Ids of items that are not videos select nothing."""
    ids = read_items(path)
    known = {item["id"] for item in manifest["items"]
             if isinstance(item, dict) and isinstance(item.get("id"), str)}
    unknown = [i for i in dict.fromkeys(ids) if i not in known]
    if unknown:
        named = ", ".join(json.dumps(i) for i in
                          unknown[:_UNKNOWN_IDS_NAMED])
        more = len(unknown) - _UNKNOWN_IDS_NAMED
        are = "id is not a manifest item id" if len(unknown) == 1 else \
            "ids are not manifest item ids"
        raise InputError(f"{path}: {len(unknown)} listed {are}: {named}"
                         + (f" and {more} more" if more > 0 else ""))
    return set(ids)


def _number(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def start_key(value: int | float) -> str:
    """A start as the poster recipe takes it: ffmpeg's ``-ss`` gets six
    decimals (``assets.frame_args``) and ship makes one poster per video
    and this key, so starts with one key have one poster."""
    return f"{float(value):.6f}"


def _source_sha(made: dict[str, Any]) -> str | None:
    source = made.get("source")
    sha = source.get("sha256") if isinstance(source, dict) else None
    return sha if isinstance(sha, str) else None


def end_key(value: int | float | None) -> str:
    """A last frame's end as its recipe takes it: six decimals, as ffmpeg's
    ``-to`` gets it (``assets.last_frame_args``), or ``file`` for the
    file's end (null ``endSeconds``)."""
    return "file" if value is None else start_key(value)


def end_text(value: int | float | None) -> str:
    return "file end" if value is None else json.dumps(value)


_NO_END = object()  # a lastFrame step that records no endSeconds

# An end this close to a video item's `durationSeconds` is the file's
# end: ffmpeg's `-to` there and no `-to` leave the same last frame. A
# second is stated to six decimals everywhere an end is recorded, so a
# tighter match than one microsecond cannot be told apart; a frame's
# length would need the video probed, which the by-ledger check never
# does.
END_AT_DURATION_SECONDS = 1e-6


def ledger_end_key(value: int | float | None,
                   duration: int | float | None) -> str:
    """``end_key``, with an end within ``END_AT_DURATION_SECONDS`` of
    `duration` (the item's ``durationSeconds``) read as the file's end,
    so a recorded null end and an item end at the duration match, and
    the reverse."""
    if value is not None and duration is not None and \
            abs(float(value) - float(duration)) <= END_AT_DURATION_SECONDS:
        return end_key(None)
    return end_key(value)


def _last_frame_end(made: dict[str, Any]) -> tuple[bool, Any]:
    """(has a ``lastFrame`` step, its ``endSeconds``: a number, None for
    the file's end, or ``_NO_END`` when it records none)."""
    steps = made.get("steps")
    for step in steps if isinstance(steps, list) else []:
        if isinstance(step, dict) and step.get("step") == "lastFrame":
            end = step.get("endSeconds", _NO_END)
            if end is None:
                return True, None
            number = _number(end)
            return True, _NO_END if number is None else number
    return False, None


def _poster_start(made: dict[str, Any]) -> tuple[bool, int | float | None]:
    """(has a ``poster`` step, its ``startSeconds`` or None)."""
    steps = made.get("steps")
    for step in steps if isinstance(steps, list) else []:
        if isinstance(step, dict) and step.get("step") == "poster":
            return True, _number(step.get("startSeconds"))
    return False, None


@dataclass
class Finding:
    """One video item and what the check found."""

    item: dict[str, Any]
    start: int | float
    status: str = ""
    recorded: list[int | float] = field(default_factory=list)
    why: str = ""
    pixels: Comparison | None = None

    @property
    def id(self) -> str:
        return str(self.item.get("id"))

    @property
    def label(self) -> str:
        """How report lines name it: its item id."""
        return self.id

    @property
    def file(self) -> str | None:
        file = self.item.get("file")
        return file if isinstance(file, str) else None

    @property
    def poster(self) -> str | None:
        poster = self.item.get("poster")
        return poster if isinstance(poster, str) else None

    @property
    def still(self) -> str | None:
        """The still checked: the poster."""
        return self.poster

    def frame_key(self) -> tuple[Any, ...]:
        """Which frame of the video the still must be."""
        return ("start", start_key(self.start), self.start)

    def compare(self, still: Path, video: Path, work: Path) -> Comparison:
        return compare_pixels(still, video, self.start, work)

    def line(self) -> str:
        recorded = ", ".join(dict.fromkeys(json.dumps(v)
                                           for v in self.recorded))
        pixels = self.pixels
        if pixels is None:
            difference = "unknown"
            luma = "start luma unknown, poster luma unknown"
        else:
            difference = f"{pixels.difference:.2f}"
            luma = (f"start luma {pixels.start_luma:.1f}, poster luma "
                    f"{pixels.poster_luma:.1f}"
                    + (", dark start" if pixels.start_luma < DARK_START_LUMA
                       else ""))
        return (f"FAIL {self.id}: file {self.file}, startSeconds "
                f"{json.dumps(self.start)}, poster startSeconds "
                f"{recorded or 'none'}, difference {difference} "
                f"({self.why}), {luma}")


@dataclass
class LastFrameFinding(Finding):
    """One held video item's ``lastFrame`` and what the check found:
    ``end`` is its ``endSeconds`` (None: the file's end), ``near`` that
    end in seconds (its ``durationSeconds`` for the file's; None
    unknown), and ``recorded`` the ends its ledger records."""

    end: int | float | None = None
    near: float | None = None

    @property
    def label(self) -> str:
        return f"{self.id} lastFrame"

    @property
    def still(self) -> str | None:
        last = self.item.get("lastFrame")
        return last if isinstance(last, str) else None

    def frame_key(self) -> tuple[Any, ...]:
        return ("end", end_key(self.end), self.end, self.near)

    def compare(self, still: Path, video: Path, work: Path) -> Comparison:
        return compare_last_frame(still, video, self.end, self.near, work)

    def line(self) -> str:
        recorded = ", ".join(dict.fromkeys(end_text(v)
                                           for v in self.recorded))
        pixels = self.pixels
        if pixels is None:
            difference = "unknown"
            luma = "end luma unknown, lastFrame luma unknown"
        else:
            difference = f"{pixels.difference:.2f}"
            luma = (f"end luma {pixels.start_luma:.1f}, lastFrame luma "
                    f"{pixels.poster_luma:.1f}")
        return (f"FAIL {self.label}: file {self.file}, endSeconds "
                f"{end_text(self.end)}, lastFrame {self.still}, lastFrame "
                f"endSeconds {recorded or 'none'}, difference {difference} "
                f"({self.why}), {luma}")


def last_frame_finding(item: dict[str, Any]) -> LastFrameFinding:
    """A held video item's finding, its range's end read from it."""
    end = _number(item.get("endSeconds"))
    near = end if end is not None else _number(item.get("durationSeconds"))
    return LastFrameFinding(item, _number(item.get("startSeconds")) or 0,
                            end=end,
                            near=None if near is None else float(near))


def _by_ledger_last(finding: LastFrameFinding,
                    index: dict[str, list[dict]]) -> None:
    """``_by_ledger`` for a last frame: a ``lastFrame`` step at the
    item's end (an end at its ``durationSeconds`` is the file's,
    ``ledger_end_key``) from a source that made its video passes;
    another end or source fails; no record of an end leaves it to the
    pixels."""
    video = index.get(finding.file or "", [])
    sources = {sha for made in video if (sha := _source_sha(made))}
    duration = _number(finding.item.get("durationSeconds"))
    key = ledger_end_key(finding.end, duration)
    unknown = other_source = False
    for made in index.get(finding.still or "", []):
        is_last, end = _last_frame_end(made)
        if not is_last:
            continue
        if end is _NO_END:
            unknown = True
            continue
        finding.recorded.append(end)
        if ledger_end_key(end, duration) == key:
            if _source_sha(made) in sources:
                finding.status = BY_LEDGER
                return
            other_source = True
    finding.status = _UNKNOWN
    if finding.still not in index:
        finding.why = "pixels: lastFrame not in the ledger"
    elif not sources:
        finding.why = "pixels: video not in the ledger"
    elif unknown or not finding.recorded:
        finding.why = "pixels: the ledger records no lastFrame endSeconds"
    else:
        finding.status = FAILED
        finding.why = ("ledger: last frame made from another source"
                       if other_source else
                       "ledger: last frame made at another end")


def _by_ledger(finding: Finding, index: dict[str, list[dict]]) -> None:
    """Decide from the ledger: BY_LEDGER, FAILED, or _UNKNOWN (pixels)."""
    video = index.get(finding.file or "", [])
    sources = {sha for made in video if (sha := _source_sha(made))}
    key = start_key(finding.start)
    unknown = other_source = False
    for made in index.get(finding.poster or "", []):
        is_poster, start = _poster_start(made)
        if not is_poster:
            continue
        if start is None:
            unknown = True
            continue
        finding.recorded.append(start)
        if start_key(start) == key:
            if _source_sha(made) in sources:
                finding.status = BY_LEDGER
                return
            other_source = True
    finding.status = _UNKNOWN
    if finding.poster not in index:
        finding.why = "pixels: poster not in the ledger"
    elif not sources:
        finding.why = "pixels: video not in the ledger"
    elif unknown or not finding.recorded:
        finding.why = "pixels: the ledger records no poster startSeconds"
    else:
        finding.status = FAILED
        finding.why = ("ledger: poster made from another source"
                       if other_source else
                       "ledger: poster made at another start")


def check(manifest: dict[str, Any], index: dict[str, list[dict]],
          folder: Path, root: Path, decoders: list[Decoder],
          first_frame: set[str], first_frame_all: bool, jobs: int,
          work: Path, items: set[str] | None = None) -> list[Finding]:
    """A finding per video item, in manifest order: every one, or those
    whose id `items` holds (``select_items``); a held video's
    ``LastFrameFinding`` follows its poster's. `first_frame` and
    `first_frame_all` skip posters only. `index` is ``made_index`` of
    the ledgers; `work` an empty scratch dir."""
    findings: list[Finding] = []
    for item in video_items(manifest):
        if items is not None and item.get("id") not in items:
            continue
        finding = Finding(item, _number(item.get("startSeconds")) or 0)
        if first_frame_all or finding.file in first_frame:
            finding.status = SKIPPED
        else:
            _by_ledger(finding, index)
        findings.append(finding)
        if item.get("holdLastFrame") is True:
            last = last_frame_finding(item)
            _by_ledger_last(last, index)
            findings.append(last)
    pending = [f for f in findings if f.status in (FAILED, _UNKNOWN)]
    _compare(pending, _FrameSources(index, folder, root, decoders, work),
             folder, jobs, work)
    return findings


def summary(findings: list[Finding], of: int | None = None,
            of_held: int | None = None) -> str:
    """The summary line, then the last frames' when the manifest holds
    a held video (`of_held` its count when ``--items`` selected, else
    when any finding is one); `of` is the manifest's video item count
    when ``--items`` selected `findings` from them."""
    lasts = [f for f in findings if isinstance(f, LastFrameFinding)]
    line = _poster_summary([f for f in findings
                            if not isinstance(f, LastFrameFinding)], of)
    if not lasts and not of_held:
        return line
    counts = Counter(f.status for f in lasts)
    passed = counts[BY_LEDGER] + counts[BY_PIXELS]
    items = (f"{len(lasts)} held video items" if of_held is None else
             f"{len(lasts)} of {of_held} held video items selected")
    return (f"{line}\nlast frames: {items}: {len(lasts)} checked, "
            f"{passed} passed ({counts[BY_LEDGER]} by ledger, "
            f"{counts[BY_PIXELS]} by pixels), {counts[FAILED]} failed")


def _poster_summary(findings: list[Finding], of: int | None) -> str:
    counts = Counter(f.status for f in findings)
    checked = len(findings) - counts[SKIPPED]
    passed = counts[BY_LEDGER] + counts[BY_PIXELS]
    items = (f"{len(findings)} video items" if of is None else
             f"{len(findings)} of {of} video items selected")
    return (f"posters: {items}: {checked} checked, "
            f"{passed} passed ({counts[BY_LEDGER]} by ledger, "
            f"{counts[BY_PIXELS]} by pixels), {counts[FAILED]} failed, "
            f"{counts[SKIPPED]} skipped (first frame)")


# --- pixels ------------------------------------------------------------------

def _rgb(path: Path) -> Any:
    """`path` decoded to an (H, W, 3) uint8 array: Pillow's formats, else
    JPEG XL through the pinned libjxl (Pillow reads none)."""
    import numpy
    from PIL import Image

    try:
        with Image.open(path) as img:
            return numpy.asarray(img.convert("RGB"))
    except (OSError, ValueError):
        pass
    try:
        pixels = media_tools.jxl_decode(path.read_bytes())
        return numpy.asarray(Image.fromarray(pixels).convert("RGB"))
    except Exception as exc:  # noqa: BLE001 - not a decodable image
        raise PixelError(f"cannot decode {path.name}: "
                         f"{type(exc).__name__}: {exc}") from exc


class Comparison(NamedTuple):
    """A poster against the frame at its item's start, both 0-255:
    their mean absolute difference per channel, and the mean Rec. 601
    luma of each."""

    difference: float
    start_luma: float
    poster_luma: float


def _mean_luma(rgb: Any) -> float:
    import numpy

    return float((rgb.astype(numpy.float64) @ _LUMA).mean())


def compare_pixels(poster: Path, video: Path, start: int | float,
                   work: Path) -> Comparison:
    """`poster` against the frame of `video` at `start`, both 8-bit RGB.
    The frame is the one the poster recipe takes (``assets.frame_args``,
    pinned ffmpeg). A frame one column or row bigger (a transcode pads
    an odd source) is cropped to the poster. PixelError when either
    cannot be decoded or the sizes differ otherwise."""
    with tempfile.TemporaryDirectory(dir=work) as td:
        png = Path(td) / "frame.png"
        error = assets.ffmpeg_error(assets.frame_args(float(start)), video,
                                    png)
        if error is not None:
            raise PixelError(f"no frame at {json.dumps(start)} s in "
                             f"{video.name}: {error}")
        return _against(_rgb(poster), _rgb(png))


def compare_last_frame(still: Path, video: Path, end: int | float | None,
                       near: float | None, work: Path) -> Comparison:
    """`still` against the last frame of `video`'s range, the frame
    before `end` (None: the file's last frame), decoded as the ship step
    takes it (``assets.last_frame_step``): from a second before `near`,
    that end in seconds, and from the file's start when that window
    holds no frame (or `near` is unknown). Compared as
    ``compare_pixels`` compares a poster."""
    end_seconds = None if end is None else float(end)
    error = ""
    with tempfile.TemporaryDirectory(dir=work) as td:
        png = Path(td) / "frame.png"
        tries = [near, None] if near is not None else [None]
        for start in tries:
            step = assets.last_frame_step(end_seconds, start)
            error = assets.ffmpeg_error(step["args"], video, png)
            if error is None:
                return _against(_rgb(still), _rgb(png))
    raise PixelError(f"no frame before {end_text(end)} in {video.name}: "
                     f"{error}")


def _against(picture: Any, frame: Any) -> Comparison:
    """A still's pixels against a frame's, both (H, W, 3) uint8. A frame
    one column or row bigger (a transcode pads an odd source) is cropped
    to the still. PixelError when the sizes differ otherwise."""
    import numpy

    height, width = picture.shape[:2]
    fh, fw = frame.shape[:2]
    if (fh, fw) != (height, width):
        if not (0 <= fh - height <= 1 and 0 <= fw - width <= 1):
            raise PixelError(f"the still is {width}x{height}, the frame "
                             f"{fw}x{fh}")
        frame = frame[:height, :width]
    difference = float(numpy.abs(picture.astype(numpy.int16)
                                 - frame.astype(numpy.int16)).mean())
    return Comparison(difference, _mean_luma(frame), _mean_luma(picture))


class _FrameSources:
    """Which file a video's frames are decoded from, found once per
    manifest video file: its original source when a ledger record names
    one still under the game root with the recorded sha256 and size
    (after the decoder hooks, which must make the record's ``decode``
    steps), else the folder's own video file. Nothing is written outside
    `work` (an archive member is extracted there, not to the shared
    extraction cache)."""

    def __init__(self, index: dict[str, list[dict]], folder: Path,
                 root: Path, decoders: list[Decoder], work: Path) -> None:
        self.index, self.folder, self.root = index, folder, root
        self.decoders, self.work = decoders, work
        self.found: dict[str, Path | None] = {}
        self._seq = itertools.count()

    def path(self, file: str | None) -> Path | None:
        if file is None:
            return None
        if file not in self.found:
            found = next(filter(None, (self._original(made)
                                       for made in self.index.get(file, []))),
                         None)
            if found is None and (self.folder / file).is_file():
                found = self.folder / file
            self.found[file] = found
        return self.found[file]

    def _dir(self) -> Path:
        path = self.work / f"source-{next(self._seq)}"
        path.mkdir()
        return path

    def _original(self, made: dict[str, Any]) -> Path | None:
        source = made.get("source")
        if not isinstance(source, dict) or "project" in source:
            return None
        bare = source_ref(source)
        path = self._find(bare) if bare is not None else None
        if path is None or (sha256_file(path), path.stat().st_size) != (
                source.get("sha256"), source.get("bytes")):
            return None
        steps = made.get("steps")
        decode = [s for s in steps if isinstance(s, dict)
                  and s.get("step") == "decode"] \
            if isinstance(steps, list) else []
        if not decode and not self.decoders:
            return path
        try:
            return assets.run_steps(decode, path, bare, self.decoders,
                                    self._dir())
        except assets.StepError:
            return None

    def _find(self, bare: dict[str, Any]) -> Path | None:
        if "path" in bare:
            path = self.root / bare["path"]
            return path if path.is_file() else None
        archive = self.root / bare["archive"]
        if not archive.is_file():
            return None
        try:
            arc = open_archive(archive)
            if bare["member"] not in arc:
                return None
            dest = self._dir() / Path(bare["member"]).name
            arc.extract_to(bare["member"], dest)
            return dest
        except (RpaError, OSError):
            return None


def _compare(pending: list[Finding], sources: _FrameSources, folder: Path,
             jobs: int, work: Path) -> None:
    """Fill in each finding's pixel comparison, and settle _UNKNOWN ones
    by its difference. Each distinct (still, frame source, frame: a
    poster's start or a last frame's end) is compared once, up to `jobs`
    at a time."""
    groups: dict[tuple[Any, ...], list[Finding]] = {}
    for finding in pending:
        still = folder / finding.still if finding.still else None
        key = (still, sources.path(finding.file), finding.frame_key())
        groups.setdefault(key, []).append(finding)

    def one(key: tuple[Any, ...]) -> tuple[Comparison | None, str]:
        still, video, _ = key
        finding = groups[key][0]
        if still is None or not still.is_file():
            name = "lastFrame" if isinstance(finding, LastFrameFinding) \
                else "poster"
            return None, f"{name} file not in the folder"
        if video is None:
            return None, "video file not in the folder"
        try:
            return finding.compare(still, video, work), ""
        except PixelError as exc:
            return None, str(exc)

    keys = list(groups)
    with ThreadPoolExecutor(max(1, jobs)) as pool:
        results = list(pool.map(one, keys))
    for key, (pixels, problem) in zip(keys, results):
        for finding in groups[key]:
            finding.pixels = pixels
            if problem:
                finding.why += f", {problem}"
            if finding.status != _UNKNOWN:
                continue
            if pixels is not None and pixels.difference <= POSTER_TOLERANCE:
                finding.status = BY_PIXELS
            else:
                finding.status = FAILED
                if pixels is not None:
                    finding.why += f", above {POSTER_TOLERANCE}"


# --- fix ---------------------------------------------------------------------

@dataclass
class FixPlan:
    """Ship requests for the failures, one per distinct (video source
    sha256, startSeconds), and per (source sha256, startSeconds,
    endSeconds) for last frames, in first-failure order; the failures
    each one fixes; and the failures no request can fix, with why."""

    requests: list[dict[str, Any]] = field(default_factory=list)
    keys: list[tuple[str, ...]] = field(default_factory=list)
    fixes: list[list[Finding]] = field(default_factory=list)
    unfixable: list[tuple[Finding, str]] = field(default_factory=list)


# Why a failing last frame is not fixed when --fix has nowhere to write
# its new path.
NO_LAST_FRAME_REMAP = ("--fix needs --last-frame-remap FILE to fix a "
                       "lastFrame (it gets item id -> new lastFrame)")


def _request(made: dict[str, Any], finding: Finding
             ) -> tuple[dict[str, Any] | None, str]:
    """The ship request (ship's ``--list`` shape) for the still `finding`
    needs, of the video `made` names: a poster at its start, and for a
    last frame ``lastFrame`` with its ``endSeconds``; or None and why
    there is none."""
    source = made.get("source")
    if not isinstance(source, dict) or _source_sha(made) is None:
        return None, "its video's ledger record has no source sha256"
    if "project" in source:
        return None, (f"its video's source is in project "
                      f"{source['project']} of a several-project build: "
                      "ship its poster from that project's root")
    bare = source_ref(source)
    if bare is None:
        return None, "its video's ledger source names no path or archive " \
                     "member"
    request: dict[str, Any] = {"source": bare, "kind": "video"}
    if float(finding.start) != 0:
        request["startSeconds"] = finding.start
    if isinstance(finding, LastFrameFinding):
        request["lastFrame"] = True
        if finding.end is not None:
            request["endSeconds"] = finding.end
    try:
        (request,) = parse_requests([request])
    except ListError as exc:
        return None, f"its video's ledger source cannot be shipped: {exc}"
    return request, ""


def _fix_key(finding: Finding, sha: str) -> tuple[str, ...]:
    key = (sha, start_key(finding.start))
    if isinstance(finding, LastFrameFinding):
        return (*key, end_key(finding.end))
    return key


def plan_fix(failures: list[Finding], index: dict[str, list[dict]],
             last_frames: bool = True) -> FixPlan:
    """The ship requests that fix `failures`; with `last_frames` false
    (no ``--last-frame-remap``) a failing last frame is not fixable."""
    plan = FixPlan()
    where: dict[tuple[str, ...], int] = {}
    for finding in failures:
        if isinstance(finding, LastFrameFinding) and not last_frames:
            plan.unfixable.append((finding, NO_LAST_FRAME_REMAP))
            continue
        records = index.get(finding.file or "", [])
        if not records:
            plan.unfixable.append((finding, "the ledger has no entry for its "
                                   "video, so it names no source to ship"))
            continue
        why = ""
        for made in records:
            request, why = _request(made, finding)
            if request is not None:
                break
        if request is None:
            plan.unfixable.append((finding, why))
            continue
        key = _fix_key(finding, str(_source_sha(made)))
        if key not in where:
            where[key] = len(plan.requests)
            plan.requests.append(request)
            plan.keys.append(key)
            plan.fixes.append([])
        plan.fixes[where[key]].append(finding)
    return plan


def _made_as(made: dict[str, Any], key: tuple[str, ...]) -> bool:
    """Whether ledger record `made` makes the still `key` asks for: from
    source ``key[0]``, a poster at start ``key[1]``, or with ``key[2]``
    a last frame at that end."""
    if _source_sha(made) != key[0]:
        return False
    if len(key) == 3:
        is_last, end = _last_frame_end(made)
        return is_last and end is not _NO_END and end_key(end) == key[2]
    start = _poster_start(made)[1]
    return start is not None and start_key(start) == key[1]


def fixed_stills(plan: FixPlan, entries: list[dict[str, Any]],
                 media: dict[str, Any], failures: list[Finding]
                 ) -> tuple[dict[str, str], dict[str, str],
                            list[tuple[Finding, str]]]:
    """(item id -> new poster, item id -> new lastFrame, both in manifest
    order; the failures a shipped request did not fix, with why) from
    the ship's request `entries` (in ``plan.requests`` order) and the
    new ledger's `media`. A request fixes its items when the ledger
    records its still as made at their start (a last frame: their end)
    from the source the plan named."""
    index = made_index([media])
    made: dict[int, str] = {}
    unfixed: list[tuple[Finding, str]] = []
    for key, fixes, request, entry in zip(
            plan.keys, plan.fixes, plan.requests, entries):
        result = entry["result"]
        still = result.get("lastFrame" if len(key) == 3 else "poster")
        why = ""
        if not isinstance(still, str):
            why = (f"ship skipped {describe(request['source'])}: "
                   f"{result.get('decision')}: "
                   + "; ".join(result.get("notes") or []))
        elif not any(_made_as(one, key) for one in index.get(still, [])):
            why = (f"{describe(request['source'])} under the game root is "
                   "not the source the ledger records (its sha256 differs)")
        for finding in fixes:
            if why:
                unfixed.append((finding, why))
            else:
                made[id(finding)] = still
    posters = {f.id: made[id(f)] for f in failures if id(f) in made
               and not isinstance(f, LastFrameFinding)}
    lasts = {f.id: made[id(f)] for f in failures if id(f) in made
             and isinstance(f, LastFrameFinding)}
    return posters, lasts, unfixed
