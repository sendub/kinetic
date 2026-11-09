"""``kinetic-media posters``: find the video items whose poster is not the
frame at their ``startSeconds``, and plan the ship requests that fix
them (docs/extracting.md, "kinetic-media posters"; docs/plan.md
Phase 44).

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
  for the report's difference.

The check writes nothing but scratch files under ``work``. ``plan_fix``
turns the failures into ship requests, one per distinct (video source
sha256, startSeconds), from the ledger's source refs; ``media_cli``
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
from typing import Any

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
    difference: float | None = None

    @property
    def id(self) -> str:
        return str(self.item.get("id"))

    @property
    def file(self) -> str | None:
        file = self.item.get("file")
        return file if isinstance(file, str) else None

    @property
    def poster(self) -> str | None:
        poster = self.item.get("poster")
        return poster if isinstance(poster, str) else None

    def line(self) -> str:
        recorded = ", ".join(dict.fromkeys(json.dumps(v)
                                           for v in self.recorded))
        difference = ("unknown" if self.difference is None
                      else f"{self.difference:.2f}")
        return (f"FAIL {self.id}: file {self.file}, startSeconds "
                f"{json.dumps(self.start)}, poster startSeconds "
                f"{recorded or 'none'}, difference {difference} "
                f"({self.why})")


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
          work: Path) -> list[Finding]:
    """A finding per video item, in manifest order. `index` is
    ``made_index`` of the ledgers; `work` an empty scratch dir."""
    findings: list[Finding] = []
    for item in video_items(manifest):
        finding = Finding(item, _number(item.get("startSeconds")) or 0)
        if first_frame_all or finding.file in first_frame:
            finding.status = SKIPPED
        else:
            _by_ledger(finding, index)
        findings.append(finding)
    pending = [f for f in findings if f.status in (FAILED, _UNKNOWN)]
    _compare(pending, _FrameSources(index, folder, root, decoders, work),
             folder, jobs, work)
    return findings


def summary(findings: list[Finding]) -> str:
    counts = Counter(f.status for f in findings)
    checked = len(findings) - counts[SKIPPED]
    passed = counts[BY_LEDGER] + counts[BY_PIXELS]
    return (f"posters: {len(findings)} video items: {checked} checked, "
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


def pixel_difference(poster: Path, video: Path, start: int | float,
                     work: Path) -> float:
    """Mean absolute difference per channel (0-255) between `poster` and
    the frame of `video` at `start`, both 8-bit RGB. The frame is
    the one the poster recipe takes (``assets.frame_args``, pinned
    ffmpeg). A frame one column or row bigger (a transcode pads an odd
    source) is cropped to the poster. PixelError when either cannot be
    decoded or the sizes differ otherwise."""
    import numpy

    picture = _rgb(poster)
    with tempfile.TemporaryDirectory(dir=work) as td:
        png = Path(td) / "frame.png"
        error = assets.ffmpeg_error(assets.frame_args(float(start)), video,
                                    png)
        if error is not None:
            raise PixelError(f"no frame at {json.dumps(start)} s in "
                             f"{video.name}: {error}")
        frame = _rgb(png)
    height, width = picture.shape[:2]
    fh, fw = frame.shape[:2]
    if (fh, fw) != (height, width):
        if not (0 <= fh - height <= 1 and 0 <= fw - width <= 1):
            raise PixelError(f"poster is {width}x{height}, the frame "
                             f"{fw}x{fh}")
        frame = frame[:height, :width]
    return float(numpy.abs(picture.astype(numpy.int16)
                           - frame.astype(numpy.int16)).mean())


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
    """Fill in each finding's pixel difference, and settle _UNKNOWN ones
    by it. Each distinct (poster, frame source, start) is compared once,
    up to `jobs` at a time."""
    groups: dict[tuple[Any, ...], list[Finding]] = {}
    for finding in pending:
        poster = folder / finding.poster if finding.poster else None
        key = (poster, sources.path(finding.file), start_key(finding.start),
               finding.start)
        groups.setdefault(key, []).append(finding)

    def one(key: tuple[Any, ...]) -> tuple[float | None, str]:
        poster, video, _, start = key
        if poster is None or not poster.is_file():
            return None, "poster file not in the folder"
        if video is None:
            return None, "video file not in the folder"
        try:
            return pixel_difference(poster, video, start, work), ""
        except PixelError as exc:
            return None, str(exc)

    keys = list(groups)
    with ThreadPoolExecutor(max(1, jobs)) as pool:
        results = list(pool.map(one, keys))
    for key, (difference, problem) in zip(keys, results):
        for finding in groups[key]:
            finding.difference = difference
            if problem:
                finding.why += f", {problem}"
            if finding.status != _UNKNOWN:
                continue
            if difference is not None and difference <= POSTER_TOLERANCE:
                finding.status = BY_PIXELS
            else:
                finding.status = FAILED
                if difference is not None:
                    finding.why += f", above {POSTER_TOLERANCE}"


# --- fix ---------------------------------------------------------------------

@dataclass
class FixPlan:
    """Ship requests for the failures, one per distinct (video source
    sha256, startSeconds) in first-failure order; the failures each one
    fixes; and the failures no request can fix, with why."""

    requests: list[dict[str, Any]] = field(default_factory=list)
    keys: list[tuple[str, str]] = field(default_factory=list)
    fixes: list[list[Finding]] = field(default_factory=list)
    unfixable: list[tuple[Finding, str]] = field(default_factory=list)


def _request(made: dict[str, Any], start: int | float
             ) -> tuple[dict[str, Any] | None, str]:
    """The ship request (ship's ``--list`` shape) for a poster of the
    video `made` names at `start`, or None and why there is none."""
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
    if float(start) != 0:
        request["startSeconds"] = start
    try:
        (request,) = parse_requests([request])
    except ListError as exc:
        return None, f"its video's ledger source cannot be shipped: {exc}"
    return request, ""


def plan_fix(failures: list[Finding],
             index: dict[str, list[dict]]) -> FixPlan:
    plan = FixPlan()
    where: dict[tuple[str, str], int] = {}
    for finding in failures:
        records = index.get(finding.file or "", [])
        if not records:
            plan.unfixable.append((finding, "the ledger has no entry for its "
                                   "video, so it names no source to ship"))
            continue
        why = ""
        for made in records:
            request, why = _request(made, finding.start)
            if request is not None:
                break
        if request is None:
            plan.unfixable.append((finding, why))
            continue
        key = (str(_source_sha(made)), start_key(finding.start))
        if key not in where:
            where[key] = len(plan.requests)
            plan.requests.append(request)
            plan.keys.append(key)
            plan.fixes.append([])
        plan.fixes[where[key]].append(finding)
    return plan


def fixed_posters(plan: FixPlan, entries: list[dict[str, Any]],
                  media: dict[str, Any], failures: list[Finding]
                  ) -> tuple[dict[str, str], list[tuple[Finding, str]]]:
    """(item id -> new poster, in manifest order; the failures a shipped
    request did not fix, with why) from the ship's request `entries` (in
    ``plan.requests`` order) and the new ledger's `media`. A request
    fixes its items when the ledger records its poster as made at their
    start from the source the plan named."""
    index = made_index([media])
    posters: dict[int, str] = {}
    unfixed: list[tuple[Finding, str]] = []
    for (sha, key), fixes, request, entry in zip(
            plan.keys, plan.fixes, plan.requests, entries):
        result = entry["result"]
        poster = result.get("poster")
        why = ""
        if not isinstance(poster, str):
            why = (f"ship skipped {describe(request['source'])}: "
                   f"{result.get('decision')}: "
                   + "; ".join(result.get("notes") or []))
        elif not any(_source_sha(made) == sha
                     and (start := _poster_start(made)[1]) is not None
                     and start_key(start) == key
                     for made in index.get(poster, [])):
            why = (f"{describe(request['source'])} under the game root is "
                   "not the source the ledger records (its sha256 differs)")
        for finding in fixes:
            if why:
                unfixed.append((finding, why))
            else:
                posters[id(finding)] = poster
    remap = {f.id: posters[id(f)] for f in failures if id(f) in posters}
    return remap, unfixed
