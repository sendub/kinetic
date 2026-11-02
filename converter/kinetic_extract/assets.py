"""Asset pass: ship every referenced asset at its TRUE format (docs/plan.md
Phase 10, Phase 9b policy).

Formats are sniffed from content (Pillow, magic bytes, ffprobe), never from
file extensions - corpus extensions lie. Policies:

- Images in a browser-compatible format (png/jpeg/webp/gif) ship
  byte-identical at their true ext, unless a verified
  lossless JPEG XL encode (libjxl via imagecodecs, effort 9, one thread;
  PNG/GIF pixels encode losslessly, JPEG uses JPEG XL recompression; the
  result is decoded back and pixel-compared) is strictly smaller, in which
  case ``.jxl`` ships. WebP never becomes JXL (yet: docs/plan.md Phase 25).
  Animated images are never re-encoded.
- Other image formats (bmp, tiff, ...) are decoded with Pillow; the smallest
  of (PNG, JPEG q92, JXL) ships, lossless-first when the image
  has alpha (PNG or JXL only).
- Wrapped/obfuscated images (a PNG/JPEG signature inside the first 64
  bytes, none at offset 0) are carved from the signature and follow the
  same preserve-or-JXL rule, recorded as ``carved``, provided the carved
  bytes decode as a whole image. Game-specific wrappers are undone first
  by ``--decoder`` hooks (``decoders``), over the complete source
  bytes, before any sniffing; their ``decode`` steps lead the ledger
  entry. Anything else is
  ``skipped``: the item is dropped from the manifest and reported.
- Videos: ffprobe container + codec decide. Browser-native combinations
  (mp4/mov + h264/hevc, webm/m4v + vp8/vp9/av1, mkv/webm + vp9/av1) copy
  byte-identical keeping the container extension; everything else
  transcodes to bitexact H.264 faststart MP4. MKV is Chromium-class; the
  copy decision is recorded for a Safari-targeting rebuild (docs
  content-format).
- Every tool is the pinned one (``media_tools``): ffmpeg/ffprobe from
  ``.media-tools/<platform>/``, single-threaded and bitexact; Pillow save
  parameters are spelled out in full.
- Posters are the frame AT ``startSeconds`` (``-ss`` after ``-i``, exact
  output seek) rendered to bitexact PNG, then JPEG.
- Every shipped file, posters included, is content-addressed:
  ``media/<h[:2]>/<h>.<ext>`` with ``h`` the sha256 of the bytes shipped
  (``media.content_ref``, docs/plan.md Phase 25). Identical outputs,
  whatever their sources, are one path written once (one ledger
  ``media`` entry, other sources under ``alsoFrom``). Files are hashed in chunks; a transcode or poster is made in a
  scratch dir inside the output folder, hashed, then moved into place.
  Identical source bytes are also remembered per run so they are encoded
  once. The asset pass sets the item's ``file``/``poster``; manifest and
  ledger paths are that same ref, so no path drift is possible.

Every decision and sniffed format lands in the build ledger's item
entry; every output gets a ``media`` entry (source identity and hash,
ordered steps with their parameters, tool versions, output hash) built
from the same argument lists and parameter dicts the encoders run with,
so recipe and record cannot drift (docs/extracting.md, "Build ledger").
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any

from . import decoders as decoder_hooks
from . import media_tools
from .media import content_ref, probe_duration_seconds, sha256_file
from .timeline import ItemRecord

COMPATIBLE_EXTS = {"png", "jpeg", "jpg", "webp", "gif"}
JPEG_QUALITY = 92
POSTER_JPEG_QUALITY = 90

# Magic signatures for the Pillow-less fallback and the wrapped scan.
_IMAGE_MAGICS: list[tuple[bytes, str]] = [
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpeg"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
    (b"BM", "bmp"),
    (b"II*\x00", "tiff"),
    (b"MM\x00*", "tiff"),
    (b"\xff\x0a", "jxl"),  # bare JXL codestream
    (b"JXL \r\n\x87\n", "jxl"),  # ISOBMFF JXL (at offset 12)
]
_RIFF_WEBP = b"WEBP"
_CARVE_MAGICS = [(b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpeg")]

_PIL_FORMATS = {"PNG": "png", "JPEG": "jpeg", "GIF": "gif", "WEBP": "webp",
                "BMP": "bmp", "TIFF": "tiff"}

# h264/hevc want an MP4-family container; VP/AV1 want webm/m4v/mkv
# (docs/content-format.md, Phase 9b; MKV playback is Chromium-class).
_NATIVE_CODEC_EXTS = {
    "h264": {"mp4", "mov"},
    "hevc": {"mp4", "mov"},
    "vp8": {"webm", "m4v"},
    "vp9": {"webm", "m4v", "mkv"},
    "av1": {"webm", "m4v", "mkv"},
}

_EXT_TO_PIL = {"png": "PNG", "jpeg": "JPEG", "jpg": "JPEG", "webp": "WEBP",
               "gif": "GIF", "bmp": "BMP", "tiff": "TIFF"}


# Formats whose JXL candidate is tried today (what the earlier cjxl path
# accepted; WebP waits for docs/plan.md Phase 25 item 25.5).
_JXL_SOURCE_FORMATS = {"png", "gif", "jpeg"}
# Pillow modes imagecodecs encodes directly (8-bit L, LA, RGB, RGBA).
_JXL_MODES = {"L", "LA", "RGB", "RGBA"}


def _run(cmd: list[str]) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(cmd, capture_output=True, text=True,
                              check=False)
    except OSError:
        return None


def jxl_available() -> bool:
    """Whether the pinned imagecodecs build carries libjxl."""
    return media_tools.jxl_available()


def sniff_magic(data: bytes) -> str | None:
    """Canonical image format from magic bytes at the head, or None."""
    if data[:4] == b"RIFF" and data[8:12] == _RIFF_WEBP:
        return "webp"
    if data[:12].endswith(b"JXL \r\n\x87\n"):
        return "jxl"
    for magic, fmt in _IMAGE_MAGICS:
        if data.startswith(magic):
            # The bare JXL codestream magic is 2 bytes and collides with
            # nothing realistic; require a plausible 3rd byte.
            if fmt == "jxl" and magic == b"\xff\x0a" and len(data) > 2 \
                    and data[2] not in (0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
                                        0x06, 0x07, 0x0a):
                continue
            return fmt
    return None


def sniff_image(data: bytes) -> tuple[str | None, int]:
    """(canonical format or None, carve offset).

    Pillow answers when the data opens as a recognized image at offset 0.
    Otherwise the first 64 bytes are scanned for a PNG/JPEG signature
    (wrapped image): the returned offset is where the real image starts,
    provided the bytes from there decode as a whole image.
    """
    from PIL import Image

    try:
        with Image.open(BytesIO(data)) as img:
            fmt = _PIL_FORMATS.get(img.format)
            if fmt is None:
                fmt = sniff_magic(data)
            if fmt:
                return fmt, 0
    except (OSError, ValueError):
        pass
    head = data[:64]
    for magic, fmt in _CARVE_MAGICS:
        at = head.find(magic)
        if at > 0 and _decodes(data[at:]):
            return fmt, at
    return None, 0


def _decodes(data: bytes) -> bool:
    """Whether Pillow fully decodes `data`: a carve counts only when the
    bytes after the signature are a whole image, so a wrapper that also
    alters the body (one a decoder hook must undo) is skipped, never
    shipped as a broken image."""
    from PIL import Image

    try:
        with Image.open(BytesIO(data)) as img:
            img.load()
    except Exception:  # noqa: BLE001 - any decode failure: not an image
        return False
    return True


def is_animated(data: bytes, fmt: str) -> bool:
    """Whether the image data holds more than one frame."""
    from PIL import Image

    if fmt not in ("gif", "webp", "png"):
        return False
    try:
        with Image.open(BytesIO(data)) as img:
            return int(getattr(img, "n_frames", 1)) > 1
    except (OSError, ValueError):
        return False


def probe_video(path: Path) -> tuple[str | None, str | None]:
    """(container ext, video codec) via ffprobe, or (None, None)."""
    proc = _run([*media_tools.ffprobe_cmd(),
                 "-show_entries", "format=format_name",
                 "-show_entries", "stream=codec_type,codec_name",
                 "-of", "json", str(path)])
    if proc is None or proc.returncode != 0:
        return None, None
    try:
        info = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None, None
    codec = None
    has_video = False
    for stream in info.get("streams", []):
        if stream.get("codec_type") == "video":
            has_video = True
            codec = stream.get("codec_name")
            break
    if not has_video:
        return None, None
    tokens = set((info.get("format", {}).get("format_name") or "").split(","))
    if tokens & {"mp4", "mov", "m4a", "3gp", "mj2"}:
        container = "mp4"
    elif tokens & {"matroska", "webm"}:
        container = "webm" if "webm" in tokens else "mkv"
    else:
        container = None
    return container, codec


def video_is_native(source: Path) -> tuple[bool, str | None, str | None]:
    """(keep as-is, shipped ext, codec) for a source video."""
    container, codec = probe_video(source)
    src_ext = source.suffix.lower().lstrip(".")
    ext = src_ext if src_ext in {"mp4", "mov", "m4v", "webm", "mkv"} \
        else (container or "mp4")
    allowed = _NATIVE_CODEC_EXTS.get(codec or "")
    native = bool(allowed and ext in allowed)
    return native, ext, codec


def _jxl_input_mode(img: Any) -> str | None:
    """The Pillow mode whose pixels go to libjxl for `img` (palette ->
    RGB/RGBA, bilevel -> L), or None (16-bit, float, CMYK, ...)."""
    mode = img.mode
    if mode == "P":
        mode = "RGBA" if _has_alpha(img) else "RGB"
    elif mode == "1":
        mode = "L"
    return mode if mode in _JXL_MODES else None


def _jxl_pixels(img: Any) -> Any | None:
    """The uint8 array imagecodecs encodes for `img`, or None (mode not
    representable losslessly)."""
    import numpy

    mode = _jxl_input_mode(img)
    if mode is None:
        return None
    return numpy.asarray(img if img.mode == mode else img.convert(mode))


def jxl_step(data: bytes, fmt: str) -> dict[str, Any]:
    """The ledger step for `_encode_jxl_lossless(data, fmt)`'s output."""
    if fmt == "jpeg":
        return {"step": "jxl", "mode": "jpeg-recompression", "threads": 1}
    from PIL import Image

    with Image.open(BytesIO(data)) as img:
        pixels = _jxl_input_mode(img)
    return {"step": "jxl", "mode": "lossless", "pixels": pixels,
            "effort": media_tools.JXL_EFFORT, "threads": 1}


def _encode_jxl_lossless(data: bytes, fmt: str) -> bytes | None:
    """Verified lossless JXL bytes for `data`, or None (fail/mismatch).

    PNG/GIF pixels encode losslessly; JPEG uses JPEG XL recompression.
    Either way the JXL is decoded back and must show pixels identical to
    the source (as the browser renders them, compared in RGBA).
    """
    from PIL import Image

    if fmt not in _JXL_SOURCE_FORMATS or not jxl_available():
        return None
    try:
        with Image.open(BytesIO(data)) as orig:
            orig.load()
            if fmt == "jpeg":
                out = media_tools.jxl_recompress_jpeg(data)
            else:
                pixels = _jxl_pixels(orig)
                if pixels is None:
                    return None
                out = media_tools.jxl_encode_lossless(pixels)
            back = Image.fromarray(media_tools.jxl_decode(out))
            if orig.size != back.size:
                return None
            # Compare what the browser would render: a palette PNG decodes
            # to RGB through a different mode but must show identical
            # pixels for the encode to count as lossless.
            if orig.convert("RGBA").tobytes() != back.convert("RGBA").tobytes():
                return None
    except Exception:  # noqa: BLE001 - any codec failure keeps the original
        return None
    return out


_PNG_PARAMS = {"optimize": True}  # zlib level 9, no time chunks
PNG_STEP = {"step": "convert", "format": "png", "params": _PNG_PARAMS}


def _encode_png(img: Any) -> bytes:
    buf = BytesIO()
    img.save(buf, "PNG", **_PNG_PARAMS)
    return buf.getvalue()


def _encode_jpeg(img: Any) -> bytes:
    buf = BytesIO()
    img.convert("RGB").save(buf, "JPEG", **_jpeg_params(JPEG_QUALITY))
    return buf.getvalue()


def jpeg_step() -> dict[str, Any]:
    return {"step": "convert", "format": "jpeg", "mode": "RGB",
            "params": _jpeg_params(JPEG_QUALITY)}


def _jpeg_params(quality: int) -> dict[str, Any]:
    """Every Pillow JPEG save knob, fixed (4:2:0, baseline, no optimize)."""
    return {"quality": quality, "subsampling": 2, "optimize": False,
            "progressive": False}


def _has_alpha(img: Any) -> bool:
    if img.mode in ("RGBA", "LA"):
        lo, _ = img.getchannel("A").getextrema()
        return lo < 255  # fully-opaque RGBA has no real transparency
    return img.mode == "P" and "transparency" in img.info


def convert_incompatible(data: bytes,
                         ) -> tuple[str, bytes, list[str], list[dict]]:
    """Decode a non-browser image and pick the smallest ship candidate.

    Lossless-first for transparency: alpha images consider PNG and JXL
    only; opaque images consider PNG, JPEG q92, and JXL (of the PNG).
    Returns (ext, bytes, notes, ledger steps).
    """
    from PIL import Image

    notes: list[str] = []
    with Image.open(BytesIO(data)) as img:
        img.load()
        alpha = _has_alpha(img)
        png_bytes = _encode_png(img)
        candidates: list[tuple[int, str, bytes, list[dict]]] = [
            (len(png_bytes), "png", png_bytes, [PNG_STEP])]
        if not alpha:
            jpeg_bytes = _encode_jpeg(img)
            candidates.append((len(jpeg_bytes), "jpg", jpeg_bytes,
                               [jpeg_step()]))
        if jxl_available():
            jxl = _encode_jxl_lossless(png_bytes, "png")
            if jxl is not None:
                candidates.append((len(jxl), "jxl", jxl,
                                   [PNG_STEP, jxl_step(png_bytes, "png")]))
            else:
                notes.append("jxl unavailable for converted image")
        candidates.sort(key=lambda c: c[0])
        _, ext, out, steps = candidates[0]
        notes.append("converted to " + ext +
                     (" (alpha kept lossless)" if alpha else ""))
        return ext, out, notes, steps


PRESERVE_STEP = {"step": "preserve"}


def decide_image_ship(data: bytes, fmt: str, wrapped: bool,
                      ) -> tuple[str, bytes, str, list[str], list[dict]]:
    """(ext, bytes, decision, notes, ledger steps) for effective image
    `data` (after any carve, which the caller records)."""
    notes: list[str] = []
    keep = "carved" if wrapped else "preserve"
    if fmt in COMPATIBLE_EXTS:
        ext = "jpg" if fmt == "jpeg" else fmt
        if is_animated(data, fmt):
            notes.append("animated: always preserved byte-identical")
            return ext, data, keep, notes, [PRESERVE_STEP]
        jxl = _encode_jxl_lossless(data, fmt)
        if jxl is None:
            if fmt not in _JXL_SOURCE_FORMATS:
                notes.append(f"jxl not tried for {fmt}: kept original")
            elif jxl_available():
                notes.append("jxl round-trip failed: kept original")
        elif len(jxl) < len(data):
            notes.append(f"jxl {len(jxl)} < original {len(data)}")
            return ("jxl", jxl, ("carved" if wrapped else "jxl"), notes,
                    [jxl_step(data, fmt)])
        else:
            notes.append(f"jxl {len(jxl)} >= original {len(data)}: kept")
        return ext, data, keep, notes, [PRESERVE_STEP]
    ext, out, conv_notes, steps = convert_incompatible(data)
    notes += conv_notes
    return (ext, out, ("carved" if wrapped else "decode-convert"), notes,
            steps)


# ffmpeg argument lists after the binary, with "{input}"/"{output}" where
# the paths go: exactly what runs and what the ledger records.
INPUT, OUTPUT = "{input}", "{output}"


def transcode_args() -> list[str]:
    """Bitexact H.264 faststart MP4 transcode."""
    return [*media_tools.FFMPEG_GLOBAL, "-y",
            *media_tools.FFMPEG_DECODE, "-i", INPUT,
            "-c:v", "libx264", "-preset", "veryfast",
            "-pix_fmt", "yuv420p", "-c:a", "aac",
            *media_tools.FFMPEG_ENCODE,
            "-movflags", "+faststart", OUTPUT]


def frame_args(start_seconds: float) -> list[str]:
    """The frame at start_seconds (exact output seek) as bitexact PNG."""
    return [*media_tools.FFMPEG_GLOBAL, "-y",
            *media_tools.FFMPEG_DECODE, "-i", INPUT,
            "-ss", f"{start_seconds:.6f}", "-frames:v", "1", "-an",
            *media_tools.FFMPEG_ENCODE, OUTPUT]


def run_ffmpeg(args: list[str], source: Path, out: Path) -> bool:
    """Run the pinned ffmpeg with `args`, paths filled in."""
    fill = {INPUT: str(source), OUTPUT: str(out)}
    proc = _run([str(media_tools.tool_path("ffmpeg")),
                 *(fill.get(a, a) for a in args)])
    return proc is not None and proc.returncode == 0 and out.exists()


def transcode_video(source: Path, out: Path) -> bool:
    """Bitexact H.264 faststart MP4 transcode; True on success."""
    return run_ffmpeg(transcode_args(), source, out)


def extract_frame_png(source: Path, png: Path, start_seconds: float) -> bool:
    """The frame at start_seconds (exact output seek) as bitexact PNG."""
    return run_ffmpeg(frame_args(start_seconds), source, png)


def poster_jpeg(png: Path, out_jpg: Path) -> bool:
    """A poster JPEG (q90, fixed Pillow params) from a frame PNG."""
    from PIL import Image

    try:
        with Image.open(png) as img:
            img.load()
            img.convert("RGB").save(out_jpg, "JPEG",
                                    **_jpeg_params(POSTER_JPEG_QUALITY))
    except (OSError, ValueError):
        return False
    return True


def poster_step(start_seconds: float) -> dict[str, Any]:
    """The ledger recipe of `extract_poster`: ffmpeg frame to PNG, then
    Pillow JPEG (RGB) with these params."""
    return {"step": "poster", "startSeconds": start_seconds,
            "args": frame_args(start_seconds), "frameFormat": "png",
            "jpeg": _jpeg_params(POSTER_JPEG_QUALITY)}


def _step_tools(step: dict[str, Any]) -> tuple[str, ...]:
    """The tools whose version decides a step's output bytes."""
    name = step["step"]
    if name == "jxl":
        return (("imagecodecs", "libjxl")
                if step["mode"] == "jpeg-recompression"
                else ("Pillow", "numpy", "imagecodecs", "libjxl"))
    return {"convert": ("Pillow",), "transcode": ("ffmpeg",),
            "poster": ("ffmpeg", "Pillow")}.get(name, ())


def steps_tools(steps: list[dict[str, Any]],
                tools: dict[str, Any]) -> dict[str, str | None]:
    """name -> version of every tool `steps` used (none for preserve or
    carve), read from the run's ``mediaTools``."""
    used: dict[str, str | None] = {}
    for step in steps:
        for name in _step_tools(step):
            value = tools.get(name)
            used[name] = value.get("version") if isinstance(value, dict) \
                else value
    return used


def extract_poster(source: Path, out_jpg: Path, start_seconds: float) -> bool:
    """Write the frame at start_seconds (exact output seek) as poster JPEG."""
    with tempfile.TemporaryDirectory() as td:
        png = Path(td) / "frame.png"
        return (extract_frame_png(source, png, start_seconds)
                and poster_jpeg(png, out_jpg))


class _Placed:
    """Per-run record of the content-addressed files already written, and
    the ledger's ``media`` entry for each (docs/extracting.md, "Build
    ledger")."""

    def __init__(self, out_dir: Path, tools: dict[str, Any]) -> None:
        self.out_dir = out_dir
        self.tools = tools
        self.written: set[str] = set()
        self.media: dict[str, dict[str, Any]] = {}

    def _target(self, ref: str) -> Path:
        path = self.out_dir / ref
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def put_bytes(self, data: bytes, ext: str) -> tuple[str, bool]:
        """Ship in-memory bytes; returns (ref, already written this run)."""
        ref = content_ref(hashlib.sha256(data).hexdigest(), ext)
        if ref in self.written:
            return ref, True
        self._target(ref).write_bytes(data)
        self.written.add(ref)
        return ref, False

    def copy_file(self, source: Path, digest: str, ext: str
                  ) -> tuple[str, bool]:
        """Ship a source file unchanged; ``digest`` is its streamed sha256."""
        ref = content_ref(digest, ext)
        if ref in self.written:
            return ref, True
        shutil.copyfile(source, self._target(ref))
        self.written.add(ref)
        return ref, False

    def move_file(self, made: Path, ext: str) -> tuple[str, bool]:
        """Ship a file made in scratch space: hash it streamed, move it."""
        ref = content_ref(sha256_file(made), ext)
        if ref in self.written:
            made.unlink()
            return ref, True
        os.replace(made, self._target(ref))
        self.written.add(ref)
        return ref, False

    def record(self, ref: str, kind: str, source: dict[str, Any],
               steps: list[dict[str, Any]]) -> None:
        """Note that `source` through `steps` makes output `ref`.

        The first source (in item order) is the entry's ``source``; any
        other source that makes the same bytes is listed once under
        ``alsoFrom`` with its own steps (a carved copy, say)."""
        made = {"source": source, "steps": steps}
        tools = steps_tools(steps, self.tools)
        if tools:
            made["tools"] = tools
        entry = self.media.get(ref)
        if entry is None:
            self.media[ref] = {
                "kind": kind,
                "sha256": Path(ref).stem,
                "bytes": (self.out_dir / ref).stat().st_size,
                **made,
            }
            return
        identity = _source_identity(source)
        others = entry.get("alsoFrom", [])
        if identity == _source_identity(entry["source"]) or any(
                identity == _source_identity(o["source"]) for o in others):
            return
        entry["alsoFrom"] = sorted(
            [*others, made], key=lambda o: json.dumps(o, sort_keys=True))


def _source_identity(source: dict[str, Any]) -> tuple[str, ...]:
    if "archive" in source:
        return ("archive", source["archive"], source["member"])
    return ("path", source["path"])


def _source(record: ItemRecord, digest: str, size: int) -> dict[str, Any]:
    """The item's source ref plus the raw source bytes' sha256 and size."""
    ref = record.source_ref or {"path": str(record.asset)}
    return {**ref, "sha256": digest, "bytes": size}


def _set_media(item: dict[str, Any], file: str,
               poster: str | None = None) -> None:
    """Set ``file`` (and ``poster``) right after ``id``/``type``, so the
    manifest's key order stays id, type, file, poster, then the rest."""
    rest = {k: v for k, v in item.items()
            if k not in ("id", "type", "file", "poster")}
    head = {"id": item["id"], "type": item["type"], "file": file}
    if poster is not None:
        head["poster"] = poster
    item.clear()
    item.update(head | rest)


@dataclass
class _Input:
    """One media source as the asset pass sees it: ``path`` holds the
    bytes to sniff and ship (a scratch copy when a decoder hook changed
    them), ``sha256``/``size`` are the RAW source's, ``steps`` the decode
    steps (empty without hooks)."""

    path: Path
    sha256: str
    size: int
    steps: list[dict[str, Any]]

    @property
    def digest(self) -> str:
        """sha256 of the bytes at ``path`` (the decoded ones, if any)."""
        return self.steps[-1]["outputSha256"] if self.steps else self.sha256


def _read_input(record: ItemRecord, source: Path,
                decoders: list[decoder_hooks.Decoder], scratch: Path,
                memo: dict[tuple[str, ...], _Input]) -> _Input:
    """The item's source, run through the decoder hooks (complete bytes,
    before any format detection); once per distinct source."""
    ref = record.source_ref or {"path": str(record.asset)}
    key = _source_identity(ref)
    if key in memo:
        return memo[key]
    if not decoders:
        found = _Input(source, sha256_file(source), source.stat().st_size,
                       [])
    else:
        data = source.read_bytes()
        out, steps = decoder_hooks.apply(decoders, data, ref)
        path = source
        if steps:
            # Same file name, so extension-based choices (a video's
            # container ext) see what they would without the wrapper.
            path = scratch / "decoded" / str(len(memo)) / source.name
            path.parent.mkdir(parents=True)
            path.write_bytes(out)
        found = _Input(path, hashlib.sha256(data).hexdigest(), len(data),
                       steps)
    memo[key] = found
    return found


def run_asset_pass(records: list[ItemRecord], out_dir: Path,
                   tools: dict[str, Any],
                   decoders: list[decoder_hooks.Decoder] | None = None,
                   decoded_sizes: list[tuple[int, int]] | None = None,
                   ) -> tuple[int, dict[str, dict[str, Any]]]:
    """Ship every referenced asset at its TRUE format (docs/plan.md Phase 10)
    under its content-addressed path (Phase 25).

    Mutates each record: item file/poster fields point at shipped files,
    ``record.asset_meta`` carries the decision and the output paths (and
    ``record.skipped`` marks items dropped from the manifest). ``tools``
    is the run's ``mediaTools`` (media_tools.run_tools). ``decoders``
    are the ``--decoder`` hooks, run over every source first; a hook's
    failure raises ``decoders.DecoderError`` and ends the pass; the size
    of each image a hook decoded is appended to ``decoded_sizes`` (for
    the display-size probe, which saw only the wrapped file). Returns
    the skipped count and the ledger's ``media`` section: output path ->
    entry.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    placed = _Placed(out_dir, tools)
    skipped = 0
    # effective-source sha256 -> (shipped ref, decision, steps): identical
    # sources encode once.
    image_share: dict[str, tuple[str, str, list[dict]]] = {}
    video_share: dict[str, tuple[str, str, list[dict]]] = {}
    poster_share: dict[str, str] = {}
    inputs: dict[tuple[str, ...], _Input] = {}
    with tempfile.TemporaryDirectory(prefix=".kinetic-tmp-",
                                     dir=out_dir) as scratch:
        for record in records:
            item = record.item
            kind = item.get("type")
            if kind not in ("image", "video"):
                continue
            source = record.asset_abs
            if source is None or not source.is_file():
                record.asset_meta["decision"] = "missing-source"
                record.notes.append(
                    "source asset missing: item dropped from manifest")
                record.skipped = True
                skipped += 1
                continue
            found = _read_input(record, source, list(decoders or ()),
                                Path(scratch), inputs)
            if kind == "image":
                skipped += _ship_image(record, found, placed, image_share)
                if found.steps and decoded_sizes is not None \
                        and not record.skipped:
                    _add_size(found.path, decoded_sizes)
            else:
                skipped += _ship_video(record, found, placed, video_share,
                                       poster_share, Path(scratch))
    return skipped, dict(sorted(placed.media.items()))


def _shared_note(record: ItemRecord, shipped: str) -> None:
    record.notes.append(f"shares shipped file {shipped!r} (identical "
                        "output)")


def _ship_image(record: ItemRecord, found: _Input, placed: _Placed,
                share: dict[str, tuple[str, str, list[dict]]]) -> int:
    source = found.path
    data = source.read_bytes()
    fmt, offset = sniff_image(data)
    meta: dict[str, Any] = record.asset_meta
    meta["sniffedFormat"] = fmt or "unknown"
    if fmt is None:
        meta["decision"] = "skipped"
        record.notes.append(
            f"unsupported image format (no PNG/JPEG signature in head of "
            f"{source.name}): item dropped from manifest")
        record.skipped = True
        return 1
    effective = data[offset:]
    digest = (hashlib.sha256(effective).hexdigest() if offset
              else found.digest)
    if digest in share:
        shipped, decision, steps = share[digest]
        already = True
    else:
        ext, out_bytes, decision, notes, steps = decide_image_ship(
            effective, fmt, offset > 0)
        shipped, already = placed.put_bytes(out_bytes, ext)
        share[digest] = (shipped, decision, steps)
        record.notes.extend(notes)
    carve = [{"step": "carve", "offset": offset}] if offset else []
    placed.record(shipped, "image", _source(record, found.sha256, found.size),
                  found.steps + carve + steps)
    _set_media(record.item, shipped)
    meta["decision"] = decision
    meta["file"] = shipped
    if already:
        _shared_note(record, shipped)
    return 0


def _ship_video(record: ItemRecord, found: _Input, placed: _Placed,
                video_share: dict[str, tuple[str, str, list[dict]]],
                poster_share: dict[str, str], scratch: Path) -> int:
    source = found.path
    meta: dict[str, Any] = record.asset_meta
    container, codec = probe_video(source)
    meta["sniffedFormat"] = container or "unknown"
    meta["codec"] = codec or "unknown"
    if container is None:
        meta["decision"] = "skipped"
        record.notes.append(
            f"unprobeable video {source.name}: item dropped from manifest")
        record.skipped = True
        return 1
    if found.steps:
        _reprobe_duration(record, source)
    digest = found.digest
    src = _source(record, found.sha256, found.size)
    if digest in video_share:
        shipped, decision, steps = video_share[digest]
        already = True
    else:
        native, ext, _ = video_is_native(source)
        if native:
            shipped, already = placed.copy_file(source, digest, ext)
            decision, steps = "copy", [PRESERVE_STEP]
            if ext == "mkv":
                record.notes.append("mkv kept native: Chromium-class; "
                                    "convert to mp4 for Safari")
        else:
            made = scratch / "transcode.mp4"
            if not transcode_video(source, made):
                made.unlink(missing_ok=True)
                meta["decision"] = "skipped"
                record.notes.append(
                    f"transcode failed for {source.name}: item dropped")
                record.skipped = True
                return 1
            shipped, already = placed.move_file(made, "mp4")
            decision = "transcode"
            steps = [{"step": "transcode", "args": transcode_args()}]
            record.notes.append(
                f"transcoded {codec}/{container} to h264 mp4 (faststart)")
        video_share[digest] = (shipped, decision, steps)
    placed.record(shipped, "video", src, found.steps + steps)
    if already:
        _shared_note(record, shipped)
    meta["decision"] = decision
    meta["file"] = shipped

    start = float(record.item.get("startSeconds") or 0.0)
    poster_key = f"{digest}@{start:.6f}"
    if poster_key in poster_share:
        poster = poster_share[poster_key]
    else:
        made = scratch / "poster.jpg"
        if extract_poster(source, made, start):
            poster, _ = placed.move_file(made, "jpg")
        else:
            made.unlink(missing_ok=True)
            record.notes.append(
                "poster extraction failed; falling back to source ext")
            poster = shipped  # last resort: first-frame still = the file
        poster_share[poster_key] = poster
    if poster != shipped:
        placed.record(poster, "poster", src,
                      found.steps + [poster_step(start)])
    _set_media(record.item, shipped, poster)
    meta["poster"] = poster
    return 0


_DURATION_PLACEHOLDER = "durationSeconds placeholder 1.0"


def _reprobe_duration(record: ItemRecord, decoded: Path) -> None:
    """The timeline probed the raw (still wrapped) file; a decoded video's
    real duration replaces the placeholder it got there."""
    duration = probe_duration_seconds(decoded)
    if duration is None:
        return
    record.item["durationSeconds"] = duration
    record.notes[:] = [n for n in record.notes
                       if not n.startswith(_DURATION_PLACEHOLDER)]


def _add_size(path: Path, sizes: list[tuple[int, int]]) -> None:
    from PIL import Image

    try:
        with Image.open(path) as img:
            sizes.append(img.size)
    except (OSError, ValueError):
        pass
