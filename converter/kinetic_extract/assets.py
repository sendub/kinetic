"""Asset pass: ship every referenced asset at its TRUE format (docs/plan.md
Phase 10, Phase 9b policy).

Formats are sniffed from content (Pillow, magic bytes, ffprobe), never from
file extensions - corpus extensions lie. Policies:

- Images in a browser-compatible format (png/jpeg/webp/gif) ship
  byte-identical at their true ext, unless a verified lossless JPEG XL
  (libjxl via imagecodecs, effort 9, one thread) is strictly smaller, in
  which case ``.jxl`` ships (docs/plan.md Phase 25). PNG/GIF/WebP decode
  to 8-bit pixels, encode lossless and must decode back to identical
  pixels; 16-bit PNGs, a non-sRGB ICC profile or EXIF orientation keep
  the original. JPEG uses JPEG XL recompression and must reconstruct the
  original JPEG bytes exactly. Lossy (VP8) WebP is never tried: its
  exact JXL is always larger. Animated images are never re-encoded (the
  libjxl binding takes no frame durations). ``.jxl`` sources that libjxl
  decodes ship unchanged. A kept original's ``preserve`` step carries the
  ``reason`` no JXL replaced it.
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
- Videos: ffprobe container + codec decide. Any MKV source (Matroska
  DocType ``matroska`` in the EBML header, or a Matroska-family file
  named ``.mkv``) ships byte-identical as ``.mkv`` whatever its codecs
  (docs/plan.md Phase 25); when no target browser plays its video codec
  the item gets a warning and a note, never a transcode. Other
  browser-native combinations (mp4/mov + h264/hevc, webm/m4v +
  vp8/vp9/av1) copy byte-identical keeping the container extension;
  everything else transcodes to bitexact H.264 faststart MP4. A copied
  video's ``preserve`` step records its ``codec``.
- Every tool is the pinned one (``media_tools``): ffmpeg/ffprobe from
  ``.media-tools/<platform>/``, single-threaded and bitexact; Pillow save
  parameters are spelled out in full.
- Posters are the frame AT ``startSeconds`` (``-ss`` after ``-i``, exact
  output seek) rendered to bitexact PNG, then RGB JPEG; the ledger's
  ``poster`` step is the complete recipe (``run_poster_step`` runs it).
  The poster is made before the video ships: when it fails, the video
  item is dropped (nothing ships for it) and reported with ffmpeg's
  error, never given the video as its poster.
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
from .media import (content_ref, image_size, probe_duration_seconds,
                    sha256_file)
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

# h264/hevc want an MP4-family container; VP/AV1 want webm/m4v
# (docs/content-format.md, Phase 9b). MKV is not listed: it is copied
# whatever the codec (Phase 25).
_NATIVE_CODEC_EXTS = {
    "h264": {"mp4", "mov"},
    "hevc": {"mp4", "mov"},
    "vp8": {"webm", "m4v"},
    "vp9": {"webm", "m4v"},
    "av1": {"webm", "m4v"},
}

# Video codecs some target browser decodes inside MKV: Chrome 156 played
# each of these in a headless probe (HEVC through the platform decoder,
# so not with --disable-gpu); MPEG-4 Part 2, MPEG-2, Theora, MJPEG,
# ProRes and FFV1 failed (docs/content-format.md). Safari plays no MKV.
_MKV_PLAYABLE_CODECS = {"h264", "hevc", "vp8", "vp9", "av1"}

_EBML_MAGIC = b"\x1a\x45\xdf\xa3"
_EBML_DOCTYPE_ID = b"\x42\x82"

_EXT_TO_PIL = {"png": "PNG", "jpeg": "JPEG", "jpg": "JPEG", "webp": "WEBP",
               "gif": "GIF", "bmp": "BMP", "tiff": "TIFF"}


# Pixel formats whose decoded pixels may become lossless JPEG XL (JPEG
# takes JPEG XL recompression instead; docs/plan.md Phase 25).
_JXL_PIXEL_FORMATS = {"png", "gif", "webp"}
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
            # The bare JXL codestream magic is only 2 bytes: sniff_image
            # accepts "jxl" only when libjxl decodes the whole file.
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
    if sniff_magic(data) == "jxl" and _jxl_decodes(data):
        return "jxl", 0  # Pillow reads no JPEG XL; libjxl must decode it
    head = data[:64]
    for magic, fmt in _CARVE_MAGICS:
        at = head.find(magic)
        if at > 0 and _decodes(data[at:]):
            return fmt, at
    return None, 0


def _jxl_decodes(data: bytes) -> bool:
    """Whether the pinned libjxl decodes `data` (a ``.jxl`` source ships
    only when it is a whole image)."""
    try:
        media_tools.jxl_decode(data)
    except Exception:  # noqa: BLE001 - any decode failure: not an image
        return False
    return True


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
        # ffprobe names every Matroska file "matroska,webm"; the EBML
        # DocType tells MKV from WebM.
        container = "mkv" if matroska_doctype(path) == "matroska" \
            else "webm"
    else:
        container = None
    return container, codec


def matroska_doctype(path: Path) -> str | None:
    """The EBML header's DocType ("matroska", "webm"), or None."""
    try:
        with path.open("rb") as fh:
            head = fh.read(4096)
    except OSError:
        return None
    if not head.startswith(_EBML_MAGIC):
        return None
    at = head.find(_EBML_DOCTYPE_ID, len(_EBML_MAGIC))
    if at < 0 or at + 3 > len(head):
        return None
    first = head[at + 2]
    width = next((n for n in range(1, 9) if first & (0x80 >> (n - 1))), 0)
    if not width:
        return None
    size = first & (0xFF >> width)
    for b in head[at + 3:at + 2 + width]:
        size = (size << 8) | b
    start = at + 2 + width
    raw = head[start:start + size]
    return raw.rstrip(b"\x00").decode("ascii", "replace") or None


def is_mkv(source: Path, container: str | None) -> bool:
    """An MKV source: Matroska DocType, or a Matroska-family file named
    ``.mkv`` (copied unchanged whatever the codec, Phase 25)."""
    return container == "mkv" or (
        container == "webm" and source.suffix.lower() == ".mkv")


def video_is_native(source: Path) -> tuple[bool, str | None, str | None]:
    """(keep as-is, shipped ext, codec) for a source video. MKV sources
    are always kept, as ``.mkv``."""
    container, codec = probe_video(source)
    if is_mkv(source, container):
        return True, "mkv", codec
    src_ext = source.suffix.lower().lstrip(".")
    ext = src_ext if src_ext in {"mp4", "mov", "m4v", "webm"} \
        else (container or "mp4")
    allowed = _NATIVE_CODEC_EXTS.get(codec or "")
    native = bool(allowed and ext in allowed)
    return native, ext, codec


def mkv_unplayable_note(codec: str | None) -> str | None:
    """The warning for an MKV whose video codec no target browser plays,
    else None."""
    if codec in _MKV_PLAYABLE_CODECS:
        return None
    return f"MKV codec {codec or 'unknown'}: no target browser plays it"


def _jxl_input_mode(img: Any) -> str | None:
    """The Pillow mode whose pixels go to libjxl for `img` (palette ->
    RGB/RGBA, bilevel -> L), or None (16-bit, float, CMYK, ...)."""
    mode = img.mode
    if mode == "P":
        mode = "RGBA" if _has_alpha(img) else "RGB"
    elif mode == "1":
        mode = "L"
    return mode if mode in _JXL_MODES else None


_EXIF_ORIENTATION = 0x0112


def _pixels_not_exact(data: bytes, fmt: str, img: Any) -> str | None:
    """Why `img`'s 8-bit pixels would not show what the browser shows for
    `data`, or None when they do."""
    if fmt == "png" and data[12:16] == b"IHDR" and data[24] == 16:
        # Pillow reads 16-bit RGB(A) as 8-bit RGB(A): never lossless.
        return "16-bit PNG"
    mode = _jxl_input_mode(img)
    if mode is None:
        return f"pixel mode {img.mode} not encodable losslessly"
    icc = img.info.get("icc_profile")
    if icc and not _icc_is_srgb_for(img, icc):
        # The pixel encode carries no profile (sRGB is assumed), so a
        # colour-managed browser would show different colours.
        return "embedded ICC profile is not sRGB for these pixels"
    orientation = img.getexif().get(_EXIF_ORIENTATION, 1)
    if orientation != 1:
        return f"EXIF orientation {orientation}"
    return None


def _icc_is_srgb_for(img: Any, icc: bytes) -> bool:
    """Whether converting `img`'s own pixels from its embedded profile to
    sRGB (the pinned Pillow's LittleCMS) changes none of them: then the
    untagged JXL, which browsers read as sRGB, shows the same colours.
    Games often embed an sRGB profile (GIMP's built-in sRGB, say)."""
    from PIL import ImageCms

    rgb = img.convert("RGB")
    try:
        src = ImageCms.ImageCmsProfile(BytesIO(icc))
        out = ImageCms.profileToProfile(rgb, src, ImageCms.createProfile("sRGB"),
                                        outputMode="RGB")
    except (ImageCms.PyCMSError, OSError, ValueError):
        return False
    return out is not None and out.tobytes() == rgb.tobytes()


@dataclass
class JxlCandidate:
    """A verified JPEG XL of an image (``out`` and its ledger ``step``), or
    why there is none (``reason``)."""

    out: bytes | None = None
    step: dict[str, Any] | None = None
    reason: str | None = None


def _codec_error(what: str, exc: Exception) -> JxlCandidate:
    return JxlCandidate(reason=f"{what} failed: {type(exc).__name__}")


def _jpeg_candidate(data: bytes) -> JxlCandidate:
    """JPEG XL recompression, kept only if it reconstructs `data` byte for
    byte (no pixel comparison: libjxl's and Pillow's JPEG decoders round
    differently, and the reconstruction proves nothing was lost)."""
    try:
        out = media_tools.jxl_recompress_jpeg(data)
    except Exception as exc:  # noqa: BLE001 - libjxl refuses some JPEGs
        return _codec_error("jpeg recompression", exc)
    try:
        back = media_tools.jxl_reconstruct_jpeg(out)
    except Exception as exc:  # noqa: BLE001
        return _codec_error("jpeg reconstruction", exc)
    if back != data:
        return JxlCandidate(
            reason="jpeg reconstruction differs from the original bytes")
    return JxlCandidate(out, {"step": "jxl", "mode": "jpeg-recompression",
                              "threads": 1,
                              "verify": "jpeg-bytes-identical"})


def _pixel_candidate(data: bytes, fmt: str) -> JxlCandidate:
    """Decode `data` to pixels, encode lossless JPEG XL, decode that back:
    kept only if every pixel (compared in RGBA) is identical."""
    import numpy
    from PIL import Image

    try:
        with Image.open(BytesIO(data)) as orig:
            orig.load()
            icc = orig.info.get("icc_profile")
            why = _pixels_not_exact(data, fmt, orig)
            if why is not None:
                return JxlCandidate(reason=why)
            mode = _jxl_input_mode(orig)
            pixels = numpy.asarray(orig if orig.mode == mode
                                   else orig.convert(mode))
            try:
                out = media_tools.jxl_encode_lossless(pixels)
                back = Image.fromarray(media_tools.jxl_decode(out))
            except Exception as exc:  # noqa: BLE001
                return _codec_error("jxl encode", exc)
            if orig.size != back.size or \
                    orig.convert("RGBA").tobytes() \
                    != back.convert("RGBA").tobytes():
                return JxlCandidate(reason="decoded JXL pixels differ")
    except (OSError, ValueError) as exc:
        return _codec_error("pixel decode", exc)
    step = {"step": "jxl", "mode": "lossless", "pixels": mode,
            "effort": media_tools.JXL_EFFORT, "threads": 1,
            "verify": "pixels-identical"}
    if icc:
        step["iccProfile"] = "dropped: maps these pixels to sRGB unchanged"
    return JxlCandidate(out, step)


LOSSY_WEBP_REASON = "lossy WebP: exact JPEG XL is always larger"


def webp_is_lossy(data: bytes) -> bool:
    """Whether a WebP's (first) image is a lossy VP8 bitstream, read from
    the RIFF chunks without decoding: a simple file starts with its
    ``VP8 `` or ``VP8L`` chunk; an extended (``VP8X``) one carries it
    after other chunks, inside the first ``ANMF`` frame when animated."""
    at, end = 12, len(data)
    while at + 8 <= end:
        fourcc = data[at:at + 4]
        size = int.from_bytes(data[at + 4:at + 8], "little")
        if fourcc == b"VP8 ":
            return True
        if fourcc == b"VP8L":
            return False
        if fourcc == b"ANMF":
            at, end = at + 8 + 16, min(end, at + 8 + size)
            continue
        at += 8 + size + (size & 1)
    return False


def jxl_candidate(data: bytes, fmt: str) -> JxlCandidate:
    """The verified lossless JPEG XL for a still image in `fmt`, whatever
    its size (the caller applies the smaller-only rule).

    Lossy WebP is not tried: its exact JXL was larger in every measured
    file (docs/extracting.md) at about 27 s each."""
    if fmt == "webp" and webp_is_lossy(data):
        return JxlCandidate(reason=LOSSY_WEBP_REASON)
    if not jxl_available():
        return JxlCandidate(reason="jxl unavailable")
    if fmt == "jpeg":
        return _jpeg_candidate(data)
    if fmt in _JXL_PIXEL_FORMATS:
        return _pixel_candidate(data, fmt)
    return JxlCandidate(reason=f"jxl not tried for {fmt}")


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
        jxl = jxl_candidate(png_bytes, "png")
        if jxl.out is not None:
            candidates.append((len(jxl.out), "jxl", jxl.out,
                               [PNG_STEP, jxl.step]))
        else:
            notes.append(f"no jxl candidate: {jxl.reason}")
        candidates.sort(key=lambda c: c[0])
        _, ext, out, steps = candidates[0]
        notes.append("converted to " + ext +
                     (" (alpha kept lossless)" if alpha else ""))
        return ext, out, notes, steps


PRESERVE_STEP = {"step": "preserve"}
ANIMATED_REASON = ("animated (the pinned libjxl encode takes no "
                   "frame durations or loop count)")


def _keep(data: bytes, ext: str, decision: str, reason: str | None,
          notes: list[str]) -> tuple[str, bytes, str, list[str], list[dict]]:
    """Ship the original bytes; the ledger's preserve step says why no
    JPEG XL replaced them."""
    if reason is None:
        return ext, data, decision, notes, [PRESERVE_STEP]
    notes.append(f"{reason}: kept original")
    return ext, data, decision, notes, [{**PRESERVE_STEP, "reason": reason}]


def decide_image_ship(data: bytes, fmt: str, wrapped: bool,
                      ) -> tuple[str, bytes, str, list[str], list[dict]]:
    """(ext, bytes, decision, notes, ledger steps) for effective image
    `data` (after any carve, which the caller records).

    A browser-compatible still image ships as verified lossless JPEG XL
    when that is strictly smaller, else unchanged; animated images and
    ``.jxl`` sources ship unchanged; anything else is converted."""
    notes: list[str] = []
    keep = "carved" if wrapped else "preserve"
    if fmt == "jxl":
        return _keep(data, "jxl", keep, None, notes)
    if fmt in COMPATIBLE_EXTS:
        ext = "jpg" if fmt == "jpeg" else fmt
        if is_animated(data, fmt):
            return _keep(data, ext, keep, ANIMATED_REASON, notes)
        jxl = jxl_candidate(data, fmt)
        if jxl.out is None:
            return _keep(data, ext, keep, jxl.reason, notes)
        if len(jxl.out) >= len(data):
            return _keep(data, ext, keep,
                         f"jxl {len(jxl.out)} >= original {len(data)} bytes",
                         notes)
        notes.append(f"jxl {len(jxl.out)} < original {len(data)}")
        return ("jxl", jxl.out, ("carved" if wrapped else "jxl"), notes,
                [jxl.step])
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


def ffmpeg_error(args: list[str], source: Path, out: Path) -> str | None:
    """Run the pinned ffmpeg with `args`, paths filled in: None when it
    wrote `out`, else what went wrong (ffmpeg's last stderr line, with
    the two paths shortened to their file names)."""
    fill = {INPUT: str(source), OUTPUT: str(out)}
    proc = _run([str(media_tools.tool_path("ffmpeg")),
                 *(fill.get(a, a) for a in args)])
    if proc is None:
        return "ffmpeg could not be run"
    if proc.returncode == 0 and out.exists():
        return None
    lines = [ln.strip() for ln in proc.stderr.splitlines() if ln.strip()]
    if not lines:
        return (f"exit {proc.returncode}, no output written"
                if proc.returncode else "no output written (no frame?)")
    return (lines[-1].replace(str(source), source.name)
            .replace(str(out), out.name))


def run_ffmpeg(args: list[str], source: Path, out: Path) -> bool:
    """Run the pinned ffmpeg with `args`, paths filled in."""
    return ffmpeg_error(args, source, out) is None


def transcode_video(source: Path, out: Path) -> bool:
    """Bitexact H.264 faststart MP4 transcode; True on success."""
    return run_ffmpeg(transcode_args(), source, out)


def extract_frame_png(source: Path, png: Path, start_seconds: float) -> bool:
    """The frame at start_seconds (exact output seek) as bitexact PNG."""
    return run_ffmpeg(frame_args(start_seconds), source, png)


def _save_poster_jpeg(frame: Path, out_jpg: Path, mode: str,
                      params: dict[str, Any]) -> str | None:
    """Pillow: frame -> `mode` -> JPEG with `params`; None or the error."""
    from PIL import Image

    try:
        with Image.open(frame) as img:
            img.load()
            img.convert(mode).save(out_jpg, "JPEG", **params)
    except (OSError, ValueError) as exc:
        return f"Pillow: {type(exc).__name__}: {exc}"
    return None


def poster_jpeg(png: Path, out_jpg: Path) -> bool:
    """A poster JPEG (q90, fixed Pillow params) from a frame PNG."""
    step = poster_step(0.0)
    return _save_poster_jpeg(png, out_jpg, step["mode"],
                             step["jpeg"]) is None


def poster_step(start_seconds: float) -> dict[str, Any]:
    """The ledger recipe of a poster, complete: ffmpeg runs ``args``
    (frame selection is ``-ss startSeconds`` after ``-i``, one frame, no
    scaling) writing a ``frameFormat`` file, then Pillow converts it to
    ``mode`` and saves JPEG with the ``jpeg`` params. `run_poster_step`
    runs exactly this dict."""
    return {"step": "poster", "startSeconds": start_seconds,
            "args": frame_args(start_seconds), "frameFormat": "png",
            "mode": "RGB", "jpeg": _jpeg_params(POSTER_JPEG_QUALITY)}


def run_poster_step(step: dict[str, Any], source: Path,
                    out_jpg: Path) -> str | None:
    """Make a poster from a ledger ``poster`` step: None on success, else
    what failed (ffmpeg's or Pillow's error)."""
    with tempfile.TemporaryDirectory() as td:
        frame = Path(td) / f"frame.{step['frameFormat']}"
        error = ffmpeg_error(step["args"], source, frame)
        if error is not None:
            return f"ffmpeg: {error}"
        return _save_poster_jpeg(frame, out_jpg, step["mode"], step["jpeg"])


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


def extract_poster(source: Path, out_jpg: Path,
                   start_seconds: float) -> str | None:
    """Write the frame at start_seconds (exact output seek) as poster
    JPEG; None on success, else the error."""
    return run_poster_step(poster_step(start_seconds), source, out_jpg)


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
    # video sha256 @ startSeconds -> (poster ref, None) or (None, error)
    poster_share: dict[str, tuple[str | None, str | None]] = {}
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
            f"unsupported image format (not a decodable image, no PNG/JPEG "
            f"signature in head of {source.name}): item dropped from "
            "manifest")
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
                poster_share: dict[str, tuple[str | None, str | None]],
                scratch: Path) -> int:
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

    # The poster first, into scratch: a video without one ships nothing.
    start = float(record.item.get("startSeconds") or 0.0)
    poster_key = f"{digest}@{start:.6f}"
    made_poster: Path | None = None
    cached = poster_share.get(poster_key)
    if cached is None:
        made_poster = scratch / "poster.jpg"
        error = extract_poster(source, made_poster, start)
        if error is not None:
            made_poster.unlink(missing_ok=True)
            poster_share[poster_key] = (None, error)
            cached = (None, error)
    if cached is not None and cached[0] is None:
        note = (f"poster failed for {record.asset}: {cached[1]}: item "
                "dropped from manifest")
        meta["decision"] = "skipped"
        meta["warning"] = note
        record.notes.append(note)
        record.skipped = True
        return 1

    if digest in video_share:
        shipped, decision, steps = video_share[digest]
        already = True
    else:
        native, ext, _ = video_is_native(source)
        if native:
            shipped, already = placed.copy_file(source, digest, ext)
            decision = "copy"
            steps = [{**PRESERVE_STEP, "codec": codec or "unknown"}]
        else:
            made = scratch / "transcode.mp4"
            if not transcode_video(source, made):
                made.unlink(missing_ok=True)
                if made_poster is not None:
                    made_poster.unlink(missing_ok=True)
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
    if shipped.endswith(".mkv"):  # only MKV sources ship as .mkv
        warning = mkv_unplayable_note(codec)
        if warning:
            meta["warning"] = warning
            record.notes.append(warning)

    if made_poster is not None:
        poster, _ = placed.move_file(made_poster, "jpg")
        poster_share[poster_key] = (poster, None)
    else:
        poster = cached[0]
    placed.record(poster, "poster", src, found.steps + [poster_step(start)])
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
    size = image_size(path)
    if size is not None:
        sizes.append(size)
