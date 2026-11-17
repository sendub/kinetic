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
- Videos: the measured rule (docs/plan.md Phase 26). ffprobe gives the
  true container (ISO-BMFF major brand: mp4/m4v/mov/3gp; EBML DocType:
  webm/mkv; never the file name), video codec and codec tag; a stream
  Safari and Chrome both play there (``KEEP_VIDEO``, HEVC only as
  ``hvc1``) ships byte-identical at the container's extension, an
  H.264/HEVC/VP9 stream anywhere else (``REMUX_VIDEO``) is copied
  unchanged into bitexact faststart MP4 (``remux``, video stream only),
  and every other codec transcodes to bitexact H.264 faststart MP4.
  Audio never decides (videos play muted). A copied video's
  ``preserve`` step records its ``codec``.
- Audio (``kind: "audio"`` requests; docs/plan.md Phase 47): ffprobe's
  container and first audio stream decide, never the name. A codec
  every engine plays in its container (``KEEP_AUDIO``) ships
  byte-identical; Vorbis, Opus, AAC or MP3 elsewhere is copied
  unchanged into WebM, M4A or MP3 (``COPY_AUDIO``, ``remux``); anything
  else becomes Opus in WebM at 128 kb/s, stereo at most (``transcode``).
  Cover art (an attached picture) is not a video. A source with a real
  video stream ships its first audio stream by the same copy-or-Opus
  rule
  (``extract``), unless its ``volumedetect`` maximum is below
  ``SILENT_MAX_VOLUME_DB`` (decision ``silent``) or it has no audio
  stream (``no audio``): neither ships anything. ``durationSeconds`` is
  the shipped file's decoded samples over its rate; a file that does
  not decode is skipped, never given a placeholder. A record whose item
  says it ``loops`` (music, ambience, a video's sound) never ships a
  format whose decode shifts a loop's start
  (``audio_format.LOOP_UNSAFE``): what would ship as MP3 or as Opus in
  WebM is re-encoded to AAC in M4A at ``LOOP_BITRATE`` instead. Beside
  each audio output goes its script, ``<file>.js`` (``audio_format``),
  recorded as the ledger entry's ``script``.
- Every tool is the pinned one (``media_tools``): ffmpeg/ffprobe from
  ``.media-tools/<platform>/``, single-threaded and bitexact; Pillow save
  parameters are spelled out in full.
- Posters are the frame AT ``startSeconds`` (``-ss`` after ``-i``, exact
  output seek) rendered to bitexact PNG, saved by Pillow as RGB PNG
  (fixed params), then put through the still-image rule: verified
  lossless JPEG XL when strictly smaller, else that PNG. The ledger's
  ``poster`` step (``run_poster_step`` runs it) plus the ``jxl`` or
  ``preserve`` step after it are the complete recipe. Older ledgers'
  ``poster`` steps with ``jpeg`` params (RGB JPEG q90) still run, so
  they rebuild; nothing new ships with them. A re-ship into a folder
  whose ledger already holds an output made by the same recipe from the
  same source (a transcode, a poster) reuses that file, verified,
  instead of making it again.
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
  once, and across runs by the reuse cache (``media_cache``): an image
  decision, transcode or poster made before from the same bytes, recipe
  and tools is not made again. The asset pass sets the item's ``file``/``poster``; manifest and
  ledger paths are that same ref, so no path drift is possible.

Every decision and sniffed format lands in the build ledger's item
entry; every output gets a ``media`` entry (source identity and hash,
ordered steps with their parameters, tool versions, output hash) built
from the same argument lists and parameter dicts the encoders run with,
so recipe and record cannot drift (docs/extracting.md, "Build ledger").
Every candidate is made by running its step dict through
``run_image_step``/``run_file_step``, and ``run_steps`` replays a whole
recorded list for ``kinetic-media rebuild`` with those same functions.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, replace
from io import BytesIO
from pathlib import Path
from typing import Any

from . import audio_format
from . import decoders as decoder_hooks
from . import media_tools
from .media_cache import MediaCache
from .media import (HASH_CHUNK, content_ref, image_size,
                    probe_duration_seconds, reuse_existing, sha256_file)
from .timeline import ItemRecord
from .workers import Workers

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

# The measured video rule (docs/plan.md Phase 26, "Video playability
# measured, not assumed"): Safari 26.6.2 on an M2 and headless Chrome 156,
# 2026-11-02, agreed by the user. Video track only: the player plays
# videos muted, so audio never decides (the picture played next to every
# audio codec probed).
#
# KEEP_VIDEO: container -> video codecs BOTH browsers play in it; such a
# file ships byte-identical at that container's extension. HEVC counts
# only when tagged ``hvc1`` (Safari plays no ``hev1``).
KEEP_VIDEO = {
    "mp4": {"h264", "hevc", "vp9"},
    "mov": {"h264", "hevc"},
    "m4v": {"h264", "hevc"},
    "3gp": {"h264"},
    "webm": {"vp8", "vp9"},
    "mkv": {"vp8", "vp9"},
}
# Codecs both browsers play in MP4: anywhere else (MKV, AVI, MPEG-TS,
# MPEG-PS, ...) or as HEVC ``hev1``, only the container or tag fails, so
# the stream is copied into MP4 (``remux``), never re-encoded. Every
# other codec (AV1, MPEG-4 Part 2, MPEG-2, MJPEG, ProRes, H.263, Theora,
# FFV1, VP8 outside WebM/MKV, unknown) transcodes to H.264 MP4.
REMUX_VIDEO = {"h264", "hevc", "vp9"}
HEVC_TAG = "hvc1"
# ISO-BMFF major brands of 3GPP files (3gp4/3gp5/3gp6/3ge6/3gg6...).
_3GP_BRANDS = ("3gp", "3ge", "3gg", "3gr", "3gs")

KEEP, REMUX, TRANSCODE = "keep", "remux", "transcode"

# The audio rule (docs/plan.md Phase 47, item 2; docs/extracting.md,
# "Audio policy"). KEEP_AUDIO: container (as `_container` names it) ->
# (audio codecs every engine plays there, the extension it ships at);
# such a file ships byte-identical. Ogg is never kept: WebKit misreads
# its duration and runs its clock 4-7% slow, and Chrome plays it past
# its end (measured 2026-11-09).
KEEP_AUDIO = {
    "mp3": ({"mp3"}, "mp3"),
    "mp4": ({"aac"}, "m4a"),
    "wav": ({"pcm_u8", "pcm_s16le", "pcm_s24le", "pcm_s32le",
             "pcm_f32le"}, "wav"),
    "flac": ({"flac"}, "flac"),
    "webm": ({"vorbis", "opus"}, "webm"),
}
# Codec -> (ffmpeg muxer, extension) its stream is copied into, unchanged,
# from any other container (Ogg, CAF, Matroska, ADTS, WAV, a video...).
# Every other codec is re-encoded to Opus in WebM at AUDIO_BITRATE.
COPY_AUDIO = {"vorbis": ("webm", "webm"), "opus": ("webm", "webm"),
              "aac": ("ipod", "m4a"), "mp3": ("mp3", "mp3")}
AUDIO_BITRATE = "128k"
# A looping track that would ship as MP3 or as Opus in WebM (decodes
# that shift a loop's start, audio_format.LOOP_UNSAFE) is re-encoded to
# AAC in M4A with ffmpeg's own encoder, at this rate. AAC starts exactly
# in Chrome and WebKit (WebKit's extra samples at the end lie past the
# decoded duration the pinned ffmpeg gives it) and plays in every Safari
# and in both app hosts.
# About 64 kb/s a channel is the usual rule of thumb for transparent
# AAC; ffmpeg's own encoder is not the best one, and most such sources
# are lossy already, so 96 a channel (stereo) leaves room for both.
LOOP_BITRATE = "192k"
# A video's sound whose volumedetect max_volume is below this ships
# nothing (decision SILENT). Measured 2026-11-09 with the pinned ffmpeg
# on the 9,470 loose video files of 22 corpus game folders (converter
# output folders left out): 2,309 carry an audio stream. 1,666 of those
# are digital silence, max_volume -91.0 dB (1,646) or -90.3 dB (20);
# the other 643 peak at -45.4 dB or louder, with nothing in between.
# -70 dB sits about 20 dB above the silence and 25 dB below the quietest
# audible stream.
SILENT_MAX_VOLUME_DB = -70.0
COPY, EXTRACT, SILENT, NO_AUDIO = "copy", "extract", "silent", "no audio"
NO_SOUND = (SILENT, NO_AUDIO)


@dataclass(frozen=True)
class VideoProbe:
    """What ffprobe found: the true container, the first video stream's
    codec, its codec tag (``hvc1``/``hev1`` for HEVC in ISO-BMFF) and its
    coded width and height (None when ffprobe reports none)."""

    container: str
    codec: str | None
    tag: str | None
    width: int | None = None
    height: int | None = None


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
                              encoding="utf-8", errors="replace",
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


def probe_video(path: Path) -> VideoProbe | None:
    """The true container, video codec and codec tag via ffprobe, or None
    when ffprobe finds no video stream. The container comes from the
    bytes, never the file name: ``mp4``, ``m4v``, ``3gp`` or ``mov`` by
    the ISO-BMFF major brand, ``webm`` or ``mkv`` by the EBML DocType,
    else ffprobe's first format name (``avi``, ``mpegts``, ...)."""
    proc = _run([*media_tools.ffprobe_cmd(),
                 "-show_entries", "format=format_name:format_tags=major_brand",
                 "-show_entries", "stream=codec_type,codec_name,"
                 "codec_tag_string,width,height",
                 "-of", "json", str(path)])
    if proc is None or proc.returncode != 0:
        return None
    try:
        info = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None
    stream = next((s for s in info.get("streams", [])
                   if s.get("codec_type") == "video"), None)
    if stream is None:
        return None
    codec = stream.get("codec_name")
    tag = stream.get("codec_tag_string")
    container = _container(info.get("format", {}), path,
                           codec in {"vp8", "vp9", "av1"})
    return VideoProbe(container, codec, tag, _dimension(stream, "width"),
                      _dimension(stream, "height"))


def _container(fmt: dict[str, Any], path: Path, webm_codec: bool) -> str:
    """The true container from ffprobe's ``format`` section: ``mp4``,
    ``m4v``, ``3gp`` or ``mov`` by the ISO-BMFF major brand, ``webm`` or
    ``mkv`` by the EBML DocType (``webm`` only when `webm_codec`, the
    stream's codec being one WebM allows), else ffprobe's first format
    name."""
    names = (fmt.get("format_name") or "").split(",")
    tokens = set(names)
    if tokens & {"mp4", "mov", "m4a", "3gp", "mj2"}:
        brand = ((fmt.get("tags") or {}).get("major_brand") or "").strip()
        # A QuickTime file has brand "qt" or no ftyp box at all.
        return ("mov" if brand in {"", "qt"}
                else "m4v" if brand.upper().startswith("M4V")
                else "3gp" if brand.lower().startswith(_3GP_BRANDS)
                else "mp4")
    if tokens & {"matroska", "webm"}:
        # ffprobe names every Matroska file "matroska,webm"; the EBML
        # DocType tells WebM from MKV. A WebM DocType around a codec WebM
        # does not allow is plain Matroska to a browser: call it MKV.
        webm = matroska_doctype(path) == "webm" and webm_codec
        return "webm" if webm else "mkv"
    return names[0] or "unknown"


@dataclass(frozen=True)
class AudioProbe:
    """What ffprobe found for an audio request: the true container
    (``_container``), the first audio stream's codec (None when there is
    no audio stream), whether a real video stream is present (cover
    art, a stream with disposition ``attached_pic``, is not one) and the
    first audio stream's channel count (None when unknown)."""

    container: str
    codec: str | None
    video: bool
    channels: int | None = None


def probe_audio(path: Path) -> AudioProbe | None:
    """`path`'s container, first audio codec and whether it is a video,
    via ffprobe; None when ffprobe cannot read it."""
    proc = _run([*media_tools.ffprobe_cmd(),
                 "-show_entries", "format=format_name:format_tags=major_brand",
                 "-show_entries", "stream=codec_type,codec_name,channels"
                 ":stream_disposition=attached_pic",
                 "-of", "json", str(path)])
    if proc is None or proc.returncode != 0:
        return None
    try:
        info = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None
    streams = info.get("streams", [])
    audio = next((s for s in streams if s.get("codec_type") == "audio"),
                 None)
    codec = audio.get("codec_name") if audio else None
    video = any(s.get("codec_type") == "video"
                and not (s.get("disposition") or {}).get("attached_pic")
                for s in streams)
    channels = audio.get("channels") if audio else None
    return AudioProbe(_container(info.get("format", {}), path,
                                 codec in {"vorbis", "opus"}),
                      codec, video,
                      channels if isinstance(channels, int) else None)


def _dimension(stream: dict[str, Any], key: str) -> int | None:
    value = stream.get(key)
    return value if isinstance(value, int) and value > 0 else None


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


def video_decision(container: str | None, codec: str | None,
                   tag: str | None = None) -> str:
    """The measured video rule: ``keep`` when both Safari and Chrome play
    this container + video codec (+ HEVC tag), ``remux`` when only the
    container or the HEVC tag fails (copy the stream into MP4),
    ``transcode`` when the codec fails in either browser."""
    if codec in KEEP_VIDEO.get(container or "", ()) \
            and (codec != "hevc" or tag == HEVC_TAG):
        return KEEP
    return REMUX if codec in REMUX_VIDEO else TRANSCODE


def remux_reason(container: str, codec: str, tag: str | None) -> str:
    """Why a stream is copied into MP4 (the ledger ``remux`` step's
    ``reason``)."""
    if codec == "hevc" and container in KEEP_VIDEO \
            and "hevc" in KEEP_VIDEO[container]:
        return f"hevc tagged {tag or 'unknown'}: Safari plays only hvc1"
    return (f"{codec} in {container}: Safari or Chrome plays no {codec} in "
            f"{container}; MP4 carries the same stream")


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
    step = {"step": "jxl", "mode": "jpeg-recompression", "threads": 1,
            "verify": "jpeg-bytes-identical"}
    try:
        out = run_image_step(step, data)
    except Exception as exc:  # noqa: BLE001 - libjxl refuses some JPEGs
        return _codec_error("jpeg recompression", exc)
    try:
        back = media_tools.jxl_reconstruct_jpeg(out)
    except Exception as exc:  # noqa: BLE001
        return _codec_error("jpeg reconstruction", exc)
    if back != data:
        return JxlCandidate(
            reason="jpeg reconstruction differs from the original bytes")
    return JxlCandidate(out, step)


def _pixel_candidate(data: bytes, fmt: str) -> JxlCandidate:
    """Decode `data` to pixels, encode lossless JPEG XL, decode that back:
    kept only if every pixel (compared in RGBA) is identical."""
    from PIL import Image

    try:
        with Image.open(BytesIO(data)) as orig:
            orig.load()
            icc = orig.info.get("icc_profile")
            why = _pixels_not_exact(data, fmt, orig)
            if why is not None:
                return JxlCandidate(reason=why)
            step = {"step": "jxl", "mode": "lossless",
                    "pixels": _jxl_input_mode(orig),
                    "effort": media_tools.JXL_EFFORT, "threads": 1,
                    "verify": "pixels-identical"}
            try:
                out = run_image_step(step, data)
                back = Image.fromarray(media_tools.jxl_decode(out))
            except Exception as exc:  # noqa: BLE001
                return _codec_error("jxl encode", exc)
            if orig.size != back.size or \
                    orig.convert("RGBA").tobytes() \
                    != back.convert("RGBA").tobytes():
                return JxlCandidate(reason="decoded JXL pixels differ")
    except (OSError, ValueError) as exc:
        return _codec_error("pixel decode", exc)
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
POSTER_PNG_PARAMS = _PNG_PARAMS  # the poster frame's Pillow PNG save


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
    png_bytes = run_image_step(PNG_STEP, data)
    candidates: list[tuple[int, str, bytes, list[dict]]] = [
        (len(png_bytes), "png", png_bytes, [PNG_STEP])]
    if not alpha:
        jpeg = jpeg_step()
        jpeg_bytes = run_image_step(jpeg, data)
        candidates.append((len(jpeg_bytes), "jpg", jpeg_bytes, [jpeg]))
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


def image_recipe() -> dict[str, Any]:
    """Every parameter ``decide_image_ship`` can encode with: the reuse
    cache's recipe for an image decision (``media_cache``)."""
    return {"png": PNG_STEP, "jpeg": jpeg_step(),
            "jxlEffort": media_tools.JXL_EFFORT}


def decide_image_cached(cache: MediaCache | None, data: bytes, digest: str,
                        fmt: str, wrapped: bool,
                        ) -> tuple[str, bytes, str, list[str], list[dict]]:
    """``decide_image_ship`` through the reuse cache: a hit returns the
    remembered decision and its verified output bytes without encoding or
    comparing anything. `digest` is the sha256 of `data`."""
    if cache is None:
        return decide_image_ship(data, fmt, wrapped)
    key = cache.key("image", digest, {"format": fmt, "wrapped": wrapped,
                                      **image_recipe()})
    memo = cache.get(key)
    if memo is not None:
        try:
            out_sha = memo["sha256"]
            out = data if out_sha == digest else cache.get_bytes(out_sha)
            if out is not None:
                return (memo["ext"], out, memo["decision"],
                        list(memo["notes"]), memo["steps"])
        except (KeyError, TypeError):
            pass  # a memo of another shape: decide again
    ext, out, decision, notes, steps = decide_image_ship(data, fmt, wrapped)
    out_sha = hashlib.sha256(out).hexdigest()
    if out_sha != digest:
        cache.put_bytes(out, out_sha)
    cache.put(key, {"ext": ext, "sha256": out_sha, "decision": decision,
                    "notes": notes, "steps": steps})
    return ext, out, decision, notes, steps


def file_step_cached(cache: MediaCache | None, step: dict[str, Any],
                     source: Path, digest: str, out: Path) -> str | None:
    """``run_file_step`` (transcode, remux, poster) through the reuse cache:
    a hit copies the verified remembered output to `out`. `digest` is
    the sha256 of `source`. Failures are not remembered."""
    if cache is None:
        return run_file_step(step, source, out)
    key = cache.key(step["step"], digest, step)
    memo = cache.get(key)
    if memo is not None and isinstance(memo.get("sha256"), str) \
            and cache.copy_to(memo["sha256"], out):
        return None
    error = run_file_step(step, source, out)
    if error is None:
        made = sha256_file(out)
        cache.put_file(out, made)
        cache.put(key, {"sha256": made})
    return error


# ffmpeg argument lists after the binary, with "{input}"/"{output}" where
# the paths go: exactly what runs and what the ledger records.
INPUT, OUTPUT = "{input}", "{output}"


def even_pad_filter(width: int | None, height: int | None) -> str | None:
    """The ffmpeg filter chain that makes an odd width or height even, or
    None when both are even (or unknown). libx264 with yuv420p needs even
    dimensions; one column/row is added on the right/bottom and filled
    with a copy of the last source column/row (``fillborders`` smear), so
    no source pixel is lost or resampled and no visible border appears.
    The padding runs on 4:4:4 pixels (``format=yuv444p`` first): padding
    an odd-sized 4:2:0 frame in place gave different bytes from run to
    run with the pinned ffmpeg 9.0.2, the 4:4:4 chain the same bytes
    every run. The numbers are literal: the ledger holds exactly what
    ran."""
    if width is None or height is None or (width % 2 == 0
                                            and height % 2 == 0):
        return None
    right, bottom = width % 2, height % 2
    return (f"format=yuv444p,pad={width + right}:{height + bottom}:0:0,"
            f"fillborders=left=0:right={right}:top=0:bottom={bottom}"
            ":mode=smear")


def transcode_args(video_filter: str | None = None) -> list[str]:
    """Bitexact H.264 faststart MP4 transcode; `video_filter` (``-vf``)
    only when given, so the plain recipe is unchanged."""
    vf = ["-vf", video_filter] if video_filter else []
    return [*media_tools.FFMPEG_GLOBAL, "-y",
            *media_tools.FFMPEG_DECODE, "-i", INPUT, *vf,
            "-c:v", "libx264", "-preset", "veryfast",
            "-pix_fmt", "yuv420p", "-c:a", "aac",
            *media_tools.FFMPEG_ENCODE,
            "-movflags", "+faststart", OUTPUT]


def remux_args(codec: str) -> list[str]:
    """Copy the first video stream, unchanged, into bitexact faststart
    MP4 (HEVC tagged hvc1). Audio, subtitle, data and attachment streams
    are dropped: the player plays videos muted, and one recipe with no
    per-audio-codec table cannot fail on a track MP4 cannot hold."""
    tag = ["-tag:v", HEVC_TAG] if codec == "hevc" else []
    return [*media_tools.FFMPEG_GLOBAL, "-y",
            *media_tools.FFMPEG_DECODE, "-i", INPUT,
            "-map", "0:v:0", "-c:v", "copy", *tag,
            "-an", "-sn", "-dn",
            *media_tools.FFMPEG_ENCODE,
            "-movflags", "+faststart", "-f", "mp4", OUTPUT]


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


def transcode_step(probe: VideoProbe | None = None) -> dict[str, Any]:
    """The ledger recipe of a transcode (``run_file_step`` runs it). An
    odd-sized source (`probe`) gets the even-pad filter in ``args`` and a
    ``reason``; an even one gets the plain recipe, no extra fields."""
    width = probe.width if probe else None
    height = probe.height if probe else None
    video_filter = even_pad_filter(width, height)
    step: dict[str, Any] = {"step": "transcode",
                            "args": transcode_args(video_filter)}
    if video_filter:
        step["reason"] = (
            f"{width}x{height} has an odd dimension: H.264 yuv420p needs "
            f"even ones, so it is padded to {width + width % 2}x"
            f"{height + height % 2} repeating the last column/row")
    return step


def remux_step(probe: VideoProbe) -> dict[str, Any]:
    """The ledger recipe of a remux (``run_file_step`` runs it)."""
    codec = probe.codec or "unknown"
    return {"step": "remux", "args": remux_args(codec),
            "reason": remux_reason(probe.container, codec, probe.tag)}


def transcode_video(source: Path, out: Path,
                    probe: VideoProbe | None = None) -> bool:
    """Bitexact H.264 faststart MP4 transcode (`probe` gives the size an
    odd source is padded from); True on success."""
    return run_file_step(transcode_step(probe), source, out) is None


def extract_frame_png(source: Path, png: Path, start_seconds: float) -> bool:
    """The frame at start_seconds (exact output seek) as bitexact PNG."""
    return run_ffmpeg(frame_args(start_seconds), source, png)


_POSTER_SAVE = {"png": "PNG", "jpeg": "JPEG"}


def _save_poster(frame: Path, out: Path, mode: str, fmt: str,
                 params: dict[str, Any]) -> str | None:
    """Pillow: frame -> `mode` -> `fmt` (png or jpeg) with `params`; None
    or the error."""
    from PIL import Image

    try:
        with Image.open(frame) as img:
            img.load()
            img.convert(mode).save(out, _POSTER_SAVE[fmt], **params)
    except (OSError, ValueError) as exc:
        return f"Pillow: {type(exc).__name__}: {exc}"
    return None


def poster_jpeg(png: Path, out_jpg: Path) -> bool:
    """A JPEG poster (q90, fixed Pillow params; the recipe of ledgers
    before lossless posters) from a frame PNG."""
    step = jpeg_poster_step(0.0)
    return _save_poster(png, out_jpg, step["mode"], "jpeg",
                        step["jpeg"]) is None


def poster_step(start_seconds: float) -> dict[str, Any]:
    """The ledger recipe of a poster frame, complete: ffmpeg runs ``args``
    (frame selection is ``-ss startSeconds`` after ``-i``, one frame, no
    scaling) writing a ``frameFormat`` file, then Pillow converts it to
    ``mode`` and saves PNG with the ``png`` params. `run_poster_step`
    runs exactly this dict. The image rule then follows as its own
    ledger step (`extract_poster`): ``jxl`` when a verified lossless JPEG
    XL is smaller, else ``preserve`` (the PNG ships)."""
    return {"step": "poster", "startSeconds": start_seconds,
            "args": frame_args(start_seconds), "frameFormat": "png",
            "mode": "RGB", "png": dict(POSTER_PNG_PARAMS)}


def jpeg_poster_step(start_seconds: float) -> dict[str, Any]:
    """The lossy JPEG poster recipe ledgers recorded before lossless
    posters. Nothing new ships with it; ``run_poster_step`` still runs it
    so those ledgers rebuild to the same bytes."""
    return {"step": "poster", "startSeconds": start_seconds,
            "args": frame_args(start_seconds), "frameFormat": "png",
            "mode": "RGB", "jpeg": _jpeg_params(POSTER_JPEG_QUALITY)}


def poster_format(step: dict[str, Any]) -> str:
    """The image format a ledger ``poster`` step writes: ``png`` (the
    lossless recipe) or ``jpeg`` (older ledgers)."""
    return "png" if "png" in step else "jpeg"


def run_poster_step(step: dict[str, Any], source: Path,
                    out: Path) -> str | None:
    """Make a poster from a ledger ``poster`` step (PNG or the older
    JPEG recipe): None on success, else what failed (ffmpeg's or
    Pillow's error)."""
    fmt = poster_format(step)
    with tempfile.TemporaryDirectory() as td:
        frame = Path(td) / f"frame.{step['frameFormat']}"
        error = ffmpeg_error(step["args"], source, frame)
        if error is not None:
            return f"ffmpeg: {error}"
        return _save_poster(frame, out, step["mode"], fmt, step[fmt])


@dataclass
class Poster:
    """A made poster: ``ext`` and ``data`` to ship and its ledger
    ``steps`` (the ``poster`` step, then ``jxl`` or ``preserve``), or the
    ``error`` that stopped it."""

    ext: str = ""
    data: bytes = b""
    steps: list[dict[str, Any]] | None = None
    error: str | None = None


def extract_poster(source: Path, start_seconds: float,
                   cache: MediaCache | None = None,
                   digest: str | None = None) -> Poster:
    """The poster of video `source`: the frame at `start_seconds` (exact
    output seek) as PNG, then the image rule (``decide_image_ship``):
    verified lossless JPEG XL when strictly smaller, else that PNG.
    `cache` (with `digest`, the sha256 of `source`) is the reuse cache."""
    step = poster_step(start_seconds)
    digest = digest or sha256_file(source)
    with tempfile.TemporaryDirectory() as td:
        png = Path(td) / "poster.png"
        error = file_step_cached(cache, step, source, digest, png)
        if error is not None:
            return Poster(error=error)
        data = png.read_bytes()
    ext, out, _, _, image_steps = decide_image_cached(
        cache, data, hashlib.sha256(data).hexdigest(), "png", False)
    return Poster(ext, out, [step, *image_steps])


# --- audio -------------------------------------------------------------------

def audio_copy_args(codec: str) -> list[str]:
    """Copy the first audio stream, unchanged, into `codec`'s COPY_AUDIO
    container, bitexact. M4A gets faststart, as MP4 video does. MP3 gets
    no Xing/LAME header: from it ffmpeg's decoder would trim 529 samples
    the source never trimmed, and the copy must decode to the source's
    samples. No ID3 tag either: the bytes are the MPEG frames alone."""
    muxer, _ = COPY_AUDIO[codec]
    extra = {"ipod": ["-movflags", "+faststart"],
             "mp3": ["-write_xing", "0", "-id3v2_version", "0"]}.get(
        muxer, [])
    return [*media_tools.FFMPEG_GLOBAL, "-y",
            *media_tools.FFMPEG_DECODE, "-i", INPUT,
            "-map", "0:a:0", "-c:a", "copy",
            *media_tools.FFMPEG_ENCODE, *extra, "-f", muxer, OUTPUT]


def _downmix(channels: int | None) -> list[str]:
    """``-ac 2`` for a source of more than 2 `channels`; mono and stereo
    keep theirs, with the plain recipe."""
    return ["-ac", "2"] if channels is not None and channels > 2 else []


def audio_transcode_args(channels: int | None = None) -> list[str]:
    """The first audio stream re-encoded to Opus in WebM, bitexact, at
    AUDIO_BITRATE (libopus resamples what is not an Opus rate to 48 kHz),
    more than 2 `channels` downmixed to stereo."""
    return [*media_tools.FFMPEG_GLOBAL, "-y",
            *media_tools.FFMPEG_DECODE, "-i", INPUT,
            "-map", "0:a:0", *_downmix(channels), "-c:a", "libopus",
            "-b:a", AUDIO_BITRATE,
            *media_tools.FFMPEG_ENCODE, "-f", "webm", OUTPUT]


def audio_loop_args(channels: int | None = None) -> list[str]:
    """The first audio stream re-encoded to AAC in faststart M4A with
    ffmpeg's own encoder, bitexact, at LOOP_BITRATE, more than 2
    `channels` downmixed to stereo. The muxer's edit list records the
    encoder's priming, so the decode starts on the first sample."""
    return [*media_tools.FFMPEG_GLOBAL, "-y",
            *media_tools.FFMPEG_DECODE, "-i", INPUT,
            "-map", "0:a:0", *_downmix(channels), "-c:a", "aac",
            "-b:a", LOOP_BITRATE, *media_tools.FFMPEG_ENCODE,
            "-movflags", "+faststart", "-f", "ipod", OUTPUT]


def audio_step(probe: AudioProbe,
               loops: bool = False) -> dict[str, Any] | None:
    """The ledger recipe (``run_file_step`` runs it) that makes a file
    every engine plays from `probe`'s first audio stream, or None when
    the source ships as it is (``preserve``). For a track that `loops`,
    a file that would ship in a format whose decode shifts the start
    (MP3, Opus in WebM) is re-encoded to AAC in M4A instead."""
    codec = probe.codec or "unknown"
    kept, kept_ext = KEEP_AUDIO.get(probe.container, (set(), ""))
    keep = not probe.video and codec in kept
    copy = codec in COPY_AUDIO
    ships = ((kept_ext, codec) if keep else
             (COPY_AUDIO[codec][1], codec) if copy else ("webm", "opus"))
    unsafe = audio_format.LOOP_UNSAFE.get(ships) if loops else None
    whose = (f"{codec} sound of a {probe.container} video" if probe.video
             else f"{codec} in {probe.container}")
    if unsafe is not None:
        name, effect = unsafe
        return {"step": EXTRACT if probe.video else TRANSCODE,
                "args": audio_loop_args(probe.channels),
                "reason": f"{whose} loops, and as {name} {effect}: "
                          f"re-encoded to aac m4a at {LOOP_BITRATE}b/s"}
    if keep:
        return None
    args = audio_copy_args(codec) if copy \
        else audio_transcode_args(probe.channels)
    target = (f"copied into {COPY_AUDIO[codec][1]}" if copy else
              f"re-encoded to opus webm at {AUDIO_BITRATE}b/s")
    if probe.video:
        return {"step": EXTRACT, "args": args, "reason": f"{whose}: {target}"}
    return {"step": REMUX if copy else TRANSCODE, "args": args,
            "reason": f"{whose} is not kept: {target}"}


_MUXER_EXTS = {"mp4": "mp4", "webm": "webm", "ipod": "m4a", "mp3": "mp3"}


def file_step_ext(step: dict[str, Any]) -> str:
    """The extension of the file a file step writes: a poster's image
    format; for ffmpeg steps the ``-f`` muxer's (``ipod`` is ``.m4a``),
    and ``mp4`` for a video transcode, which names no muxer."""
    if step.get("step") == "poster":
        return {"png": "png", "jpeg": "jpg"}[poster_format(step)]
    args = step.get("args") or []
    at = args.index("-f") + 1 if "-f" in args else len(args)
    muxer = args[at] if at < len(args) else "mp4"
    return _MUXER_EXTS.get(muxer, muxer)


def audio_ext(probe: AudioProbe, step: dict[str, Any] | None) -> str:
    """The extension `probe`'s audio ships at, after `step` (None: kept)."""
    if step is None:
        return KEEP_AUDIO[probe.container][1]
    return file_step_ext(step)


# volumedetect reports its levels at the info log level.
_LOUDNESS_GLOBAL = ["-nostdin", "-hide_banner", "-nostats", "-v", "info",
                    "-filter_threads", "1"]
_MAX_VOLUME = re.compile(r"max_volume: (-?(?:inf|\d+(?:\.\d+)?)) dB")


def loudness_args() -> list[str]:
    """volumedetect over the first audio stream, nothing written."""
    return [*_LOUDNESS_GLOBAL, *media_tools.FFMPEG_DECODE, "-i", INPUT,
            "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"]


def duration_args() -> list[str]:
    """The first audio stream decoded to 8-bit mono PCM WAV on stdout:
    the fmt chunk gives the rate the decoder produced, the data chunk
    one block per sample."""
    return [*media_tools.FFMPEG_GLOBAL, *media_tools.FFMPEG_DECODE,
            "-i", INPUT, "-map", "0:a:0", "-ac", "1", "-c:a", "pcm_u8",
            *media_tools.FFMPEG_ENCODE, "-f", "wav", "-"]


def _ffmpeg_with(args: list[str], source: Path) -> list[str]:
    return [str(media_tools.tool_path("ffmpeg")),
            *(str(source) if a == INPUT else a for a in args)]


def max_volume(path: Path) -> float | None:
    """volumedetect's max_volume (dBFS) of `path`'s first audio stream,
    or None when ffmpeg decodes no samples from it."""
    proc = _run(_ffmpeg_with(loudness_args(), path))
    if proc is None or proc.returncode != 0:
        return None
    found = _MAX_VOLUME.findall(proc.stderr)
    return float(found[-1]) if found else None


_WAV_HEAD = 4096  # far more than ffmpeg's RIFF, fmt and data headers


def decoded_duration(path: Path) -> float | None:
    """Decoded samples over sample rate of `path`'s first audio stream,
    to 6 decimals, counted from what ffmpeg decodes (container headers
    can misstate it: a VBR MP3 without a Xing header); None when it does
    not decode to any sample."""
    head, total = b"", 0
    try:
        with subprocess.Popen(_ffmpeg_with(duration_args(), path),
                              stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL) as proc:
            assert proc.stdout is not None
            while chunk := proc.stdout.read(HASH_CHUNK):
                head += chunk[:_WAV_HEAD - len(head)]
                total += len(chunk)
    except OSError:
        return None
    layout = _wav_layout(head)
    if proc.returncode != 0 or layout is None:
        return None
    rate, block, data_at = layout
    samples = (total - data_at) // block
    return round(samples / rate, 6) if samples > 0 and rate > 0 else None


def _wav_layout(head: bytes) -> tuple[int, int, int] | None:
    """(sample rate, block align, offset of the sample data) from a WAV
    header, or None. The data chunk's size field is not trusted: on a
    pipe ffmpeg cannot fill it in."""
    if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
        return None
    at, fmt = 12, None
    while at + 8 <= len(head):
        chunk = head[at:at + 4]
        size = int.from_bytes(head[at + 4:at + 8], "little")
        if chunk == b"fmt " and at + 22 <= len(head):
            fmt = (int.from_bytes(head[at + 12:at + 16], "little"),
                   int.from_bytes(head[at + 20:at + 22], "little"))
        elif chunk == b"data":
            return (*fmt, at + 8) if fmt and fmt[1] > 0 else None
        at += 8 + size + (size & 1)
    return None


def _measured(cache: MediaCache | None, op: str, digest: str,
              args: list[str], measure: Callable[[], float | None],
              ) -> float | None:
    """`measure()` of the bytes whose sha256 is `digest`, through the
    reuse cache (keyed by `op` and its ffmpeg `args`): a hit decodes
    nothing. A failure is not remembered."""
    if cache is None:
        return measure()
    key = cache.key(op, digest, {"args": args})
    memo = cache.get(key)
    if memo is not None and isinstance(memo.get("value"), (int, float)):
        return float(memo["value"])
    value = measure()
    if value is not None:
        cache.put(key, {"value": value})
    return value


@dataclass
class AudioWork:
    """The slow part of shipping one audio source, made the same way by
    the in-order pass and by a worker: a video's sound ``max_volume``
    (None for an audio file), then, unless that is silent, the file the
    step made (None when the source, or an earlier output, ships) and
    the decoded ``duration`` of what ships; or the ``error`` that
    stopped it."""

    max_volume: float | None = None
    made: Path | None = None
    duration: float | None = None
    error: str | None = None

    def silent(self) -> bool:
        return self.max_volume is not None \
            and self.max_volume < SILENT_MAX_VOLUME_DB


def audio_work(source: Path, probe: AudioProbe, step: dict[str, Any] | None,
               digest: str, cache: MediaCache | None, out: Path,
               reuse: Path | None = None) -> AudioWork:
    """Measure a video's loudness, run `step` (None: the source ships)
    from `source` (bytes sha256 `digest`) to `out`, and decode what
    ships for its duration. `reuse` is an earlier ledger's output of
    `step`, still in the folder: it ships instead, and is only
    decoded."""
    work = AudioWork()
    if probe.video:
        work.max_volume = _measured(cache, "audio-loudness", digest,
                                    loudness_args(),
                                    lambda: max_volume(source))
        if work.max_volume is None:
            work.error = "its sound does not decode"
            return work
        if work.silent():
            return work
    if reuse is not None:
        ships, ships_sha = reuse, reuse.stem
    elif step is None:
        ships, ships_sha = source, digest
    else:
        error = file_step_cached(cache, step, source, digest, out)
        if error is not None:
            out.unlink(missing_ok=True)
            work.error = f"{step['step']} failed: {error}"
            return work
        ships, ships_sha = out, sha256_file(out)
        work.made = out
    work.duration = _measured(cache, "audio-duration", ships_sha,
                              duration_args(),
                              lambda: decoded_duration(ships))
    if work.duration is None:
        if work.made is not None:
            work.made.unlink(missing_ok=True)
            work.made = None
        work.error = "it does not decode to any audio sample"
    return work


# --- step runner -------------------------------------------------------------
#
# A ledger ``steps`` list is executed by these functions and nothing else:
# the converter makes each candidate by running the step dict it then
# records, and ``kinetic-media rebuild`` runs the recorded dicts through
# ``run_steps``. A recipe and the code that ran it cannot drift apart.

IMAGE_STEPS = ("carve", "preserve", "convert", "jxl")
FILE_STEPS = ("transcode", "remux", "extract", "poster")
_PIL_SAVE = {"png": "PNG", "jpeg": "JPEG"}


class StepError(Exception):
    """A ledger step cannot be run: unsupported, or it failed."""


def _unsupported(step: dict[str, Any]) -> StepError:
    detail = f" mode {step.get('mode')!r}" if step.get("step") == "jxl" \
        else f" format {step.get('format')!r}" \
        if step.get("step") == "convert" else ""
    return StepError(f"unsupported step {step.get('step')!r}{detail}")


def _jxl_pixels(data: bytes, mode: str) -> Any:
    """`data` decoded by Pillow as an (H, W[, C]) uint8 array in `mode`."""
    import numpy
    from PIL import Image

    with Image.open(BytesIO(data)) as img:
        img.load()
        return numpy.asarray(img if img.mode == mode else img.convert(mode))


def run_image_step(step: dict[str, Any], data: bytes) -> bytes:
    """One image ledger step (carve, preserve, convert, jxl) over `data`.

    Raises StepError for a step this code does not know; codec errors
    propagate (the converter turns them into a kept original)."""
    name = step.get("step")
    if name == "carve":
        return data[int(step["offset"]):]
    if name == "preserve":
        return data
    if name == "convert" and step.get("format") in _PIL_SAVE:
        from PIL import Image

        with Image.open(BytesIO(data)) as img:
            img.load()
            out = img.convert(step["mode"]) if "mode" in step else img
            buf = BytesIO()
            out.save(buf, _PIL_SAVE[step["format"]], **step["params"])
            return buf.getvalue()
    if name == "jxl" and step.get("mode") == "jpeg-recompression":
        return media_tools.jxl_recompress_jpeg(data)
    if name == "jxl" and step.get("mode") == "lossless" \
            and step.get("pixels") in _JXL_MODES:
        return media_tools.jxl_encode_lossless(
            _jxl_pixels(data, step["pixels"]), effort=int(step["effort"]))
    raise _unsupported(step)


def run_file_step(step: dict[str, Any], source: Path,
                  out: Path) -> str | None:
    """One file ledger step (transcode, remux, extract, poster) from
    `source` to `out`: None on success, else what failed. StepError when
    unsupported."""
    name = step.get("step")
    if name in ("transcode", "remux", "extract"):
        error = ffmpeg_error(step["args"], source, out)
        return None if error is None else f"ffmpeg: {error}"
    if name == "poster":
        return run_poster_step(step, source, out)
    raise _unsupported(step)


def hook_func(spec: str) -> str:
    return spec.rpartition(":")[2]


def decode_identity(step: dict[str, Any]) -> tuple[str, ...]:
    """What a ``decode`` step must reproduce: the hook's function name
    and code sha256, input and output sha256. The module spelling may
    differ (a hook package moved), the code may not."""
    return (hook_func(step.get("hook", "")), step.get("hookSha256", ""),
            step.get("inputSha256", ""), step.get("outputSha256", ""))


def run_steps(steps: list[dict[str, Any]], source: Path,
              source_ref: dict[str, Any],
              decoders: list[decoder_hooks.Decoder], work: Path) -> Path:
    """Make a ledger entry's output again: `source` (the raw source file)
    through every step, in order, inside the empty directory `work`.
    Returns the output file (`source` itself when nothing changes it).

    The decoder hooks run first exactly as the asset pass runs them
    (``decoders.apply`` over the complete bytes, the given hooks in
    order); the ``decode`` steps that makes must equal the recorded ones.
    Raises StepError naming what is unsupported, differs or failed."""
    recorded = [s for s in steps if s.get("step") == "decode"]
    rest = steps[len(recorded):]
    if any(s.get("step") == "decode" for s in rest):
        raise StepError("decode steps must lead the entry")
    current = source
    if decoders or recorded:
        data = source.read_bytes()
        try:
            out, made = decoder_hooks.apply(decoders, data, source_ref)
        except decoder_hooks.DecoderError as exc:
            raise StepError(str(exc)) from exc
        if [decode_identity(s) for s in made] != \
                [decode_identity(s) for s in recorded]:
            raise StepError(
                f"decode steps differ from the ledger (hooks now change "
                f"the source {len(made)} time(s), recorded "
                f"{len(recorded)})")
        if made:
            # Same file name as the asset pass's decoded copy.
            current = work / "decoded" / source.name
            current.parent.mkdir(parents=True)
            current.write_bytes(out)
    for n, step in enumerate(rest):
        name = step.get("step")
        if name in IMAGE_STEPS:
            if name == "preserve":
                continue
            try:
                out = run_image_step(step, current.read_bytes())
            except StepError:
                raise
            except Exception as exc:  # noqa: BLE001 - reported per entry
                raise StepError(f"step {name} failed: "
                                f"{type(exc).__name__}: {exc}") from exc
            current = work / f"step-{n}"
            current.write_bytes(out)
        elif name in FILE_STEPS:
            made_file = work / f"step-{n}.{file_step_ext(step)}"
            error = run_file_step(step, current, made_file)
            if error is not None:
                raise StepError(f"step {name} failed: {error}")
            current = made_file
        else:
            raise _unsupported(step)
    return current


def _step_tools(step: dict[str, Any]) -> tuple[str, ...]:
    """The tools whose version decides a step's output bytes."""
    name = step["step"]
    if name == "jxl":
        return (("imagecodecs", "libjxl")
                if step["mode"] == "jpeg-recompression"
                else ("Pillow", "numpy", "imagecodecs", "libjxl"))
    return {"convert": ("Pillow",), "transcode": ("ffmpeg",),
            "remux": ("ffmpeg",), "extract": ("ffmpeg",),
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


class _Placed:
    """Per-run record of the content-addressed files already written, and
    the ledger's ``media`` entry for each (docs/extracting.md, "Build
    ledger"). A file already at its content path with the right sha256
    is left untouched (it may be hard-linked elsewhere); one with other
    bytes raises ``media.ExistingFileError`` and is never overwritten."""

    def __init__(self, out_dir: Path, tools: dict[str, Any],
                 scratch: Path) -> None:
        self.out_dir = out_dir
        self.tools = tools
        # New outputs are written here first, then renamed into place
        # (same filesystem), so a crash never leaves a partial file under
        # a content-addressed name.
        self.scratch = scratch
        self._seq = itertools.count()
        self.written: set[str] = set()
        self.scripts: set[str] = set()
        self.media: dict[str, dict[str, Any]] = {}
        # source sha256 -> refs, of the earlier ledger's entries (`prior`)
        self.by_source: dict[str, list[str]] = {}

    def add_prior(self, media: dict[str, dict[str, Any]]) -> None:
        """Start from an earlier ledger's ``media`` section."""
        self.media.update(json.loads(json.dumps(media)))
        for ref, entry in self.media.items():
            for made in (entry, *entry.get("alsoFrom", [])):
                sha = (made.get("source") or {}).get("sha256")
                if isinstance(sha, str) and ref not in \
                        self.by_source.setdefault(sha, []):
                    self.by_source[sha].append(ref)

    def _target(self, ref: str) -> Path:
        path = self.out_dir / ref
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def _publish(self, target: Path, write: Callable[[Path], Any]) -> None:
        """`write` a scratch file, then rename it to `target`: the
        output appears whole or not at all."""
        tmp = self.scratch / f"publish-{next(self._seq)}"
        try:
            write(tmp)
            os.replace(tmp, target)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

    def put_bytes(self, data: bytes, ext: str) -> tuple[str, bool]:
        """Ship in-memory bytes; returns (ref, already written this run)."""
        ref = content_ref(hashlib.sha256(data).hexdigest(), ext)
        if ref in self.written:
            return ref, True
        target = self._target(ref)
        if not reuse_existing(target):
            self._publish(target, lambda tmp: tmp.write_bytes(data))
        self.written.add(ref)
        return ref, False

    def copy_file(self, source: Path, digest: str, ext: str
                  ) -> tuple[str, bool]:
        """Ship a source file unchanged; ``digest`` is its streamed sha256."""
        ref = content_ref(digest, ext)
        if ref in self.written:
            return ref, True
        target = self._target(ref)
        if not reuse_existing(target):
            self._publish(target,
                          lambda tmp: shutil.copyfile(source, tmp))
        self.written.add(ref)
        return ref, False

    def move_file(self, made: Path, ext: str) -> tuple[str, bool]:
        """Ship a file made in scratch space: hash it streamed, move it."""
        ref = content_ref(sha256_file(made), ext)
        if ref in self.written:
            made.unlink()
            return ref, True
        target = self._target(ref)
        if reuse_existing(target):
            made.unlink()
        else:
            os.replace(made, target)
        self.written.add(ref)
        return ref, False

    def put_script(self, ref: str) -> None:
        """Write the script beside the audio output `ref` (once a run:
        one already right is left untouched, one with other bytes is
        replaced) and record its sha256 and size as the entry's
        ``script``."""
        if ref in self.scripts:
            return
        script = audio_format.write_script(self.out_dir, ref)
        self.media[ref]["script"] = {
            "sha256": hashlib.sha256(script).hexdigest(),
            "bytes": len(script)}
        self.scripts.add(ref)

    def prior(self, kind: str, source_sha256: str,
              prefix: list[dict[str, Any]]) -> tuple[str, list[dict]] | None:
        """An output an earlier ledger (``media``) records for this source
        whose steps start with `prefix` and whose tools are this run's,
        still in the folder with its bytes: (ref, its steps), else None.
        A re-ship into the same folder reuses it instead of encoding
        (a transcode, say) again, with or without the reuse cache."""
        for ref, steps in self.recorded(kind, source_sha256, prefix):
            if ref in self.written or reuse_existing(self.out_dir / ref):
                self.written.add(ref)
                return ref, steps
        return None

    def recorded(self, kind: str, source_sha256: str,
                 prefix: list[dict[str, Any]],
                 ) -> list[tuple[str, list[dict]]]:
        """Every (ref, steps) the earlier ledger records that `prior`
        would accept, in its order, before checking the files: no I/O,
        no side effects (the parallel pass asks it ahead of time)."""
        found: list[tuple[str, list[dict]]] = []
        for ref in self.by_source.get(source_sha256, ()):
            entry = self.media[ref]
            if entry.get("kind") != kind:
                continue
            for made in (entry, *entry.get("alsoFrom", [])):
                steps = made.get("steps")
                if (made.get("source", {}).get("sha256") != source_sha256
                        or not isinstance(steps, list)
                        or steps[:len(prefix)] != prefix
                        or made.get("tools", {})
                        != steps_tools(steps, self.tools)):
                    continue
                found.append((ref, steps))
        return found

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
    """Which source file this is: its path (or archive + member) and, in
    a several-project game, the project it is under."""
    project = (str(source["project"]),) if "project" in source else ()
    if "archive" in source:
        return ("archive", source["archive"], source["member"], *project)
    return ("path", source["path"], *project)


def bare_source(source: dict[str, Any]) -> dict[str, Any]:
    """A source ref as one project names it, without the several-project
    ``project`` index: what decoder hooks are given, here and in a
    rebuild."""
    return {k: v for k, v in source.items() if k != "project"}


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
        out, steps = decoder_hooks.apply(decoders, data,
                                         bare_source(ref))
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
                   media: dict[str, dict[str, Any]] | None = None,
                   cache: MediaCache | None = None,
                   workers: Workers | None = None,
                   progress: Callable[[int], None] | None = None,
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
    the display-size probe, which saw only the wrapped file). ``media``
    is an earlier ledger's ``media`` section to build on (``kinetic-media
    ship`` into an existing folder): its entries are kept, and a source
    making one of its outputs again joins that entry (``alsoFrom``) or,
    when it is the entry's own source, changes nothing. ``cache`` is the
    reuse cache (``media_cache.open_cache``): image decisions,
    transcodes, remuxes, posters and audio measurements it remembers for
    the same input bytes, recipe and tools are not made again.
    ``workers`` (``kinetic-media ship --jobs``) makes the encodes (image
    decisions, posters, transcodes, remuxes and each audio source's
    ``audio_work``) ahead of time on worker threads, each distinct one
    once;
    the records are still placed and recorded one by one in order, by
    the same code, so the outputs and the ledger are the same as
    without. ``progress`` is called with the number of records done
    after each one. Returns the
    skipped count and the ledger's ``media`` section: output path ->
    entry.

    This is the one media function: kinetic-extract passes the items its
    story walk made, ``kinetic-media ship`` one record per list request.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    skipped = 0
    with tempfile.TemporaryDirectory(prefix=".kinetic-tmp-",
                                     dir=out_dir) as scratch:
        run = _Pass(_Placed(out_dir, tools, Path(scratch)), Path(scratch),
                    list(decoders or ()), cache)
        if media:
            run.placed.add_prior(media)
        try:
            if workers is not None:
                run.ahead = _Ahead(workers, Path(scratch) / "ahead", cache)
                _plan_ahead(records, run)
            for done, record in enumerate(records, start=1):
                skipped += _ship_record(record, run, decoded_sizes)
                if progress is not None:
                    progress(done)
        finally:
            if workers is not None:
                # Before the scratch dir goes: no task may still write
                # into it (unused ones are dropped, running ones end).
                workers.close()
    return skipped, dict(sorted(run.placed.media.items()))


@dataclass
class _Pass:
    """One asset pass's state. The share maps make identical inputs
    encode once: effective-source sha256 -> (shipped ref, decision,
    steps) for images and videos, (sha256, loops) -> the outcome for
    audio;
    ``<video sha256>@<startSeconds>`` -> (poster ref, its steps after
    any decode steps) or (None, error) for posters. ``inputs``,
    ``sniffs``, ``probes`` and ``audio_probes`` remember per-source
    reads (``_read_input``, ``sniff_image``, ``probe_video``,
    ``probe_audio``)."""

    placed: _Placed
    scratch: Path
    decoders: list[decoder_hooks.Decoder]
    cache: MediaCache | None
    ahead: _Ahead | None = None

    def __post_init__(self) -> None:
        self.image_share: dict[str, tuple[str, str, list[dict]]] = {}
        self.video_share: dict[str, tuple[str, str, list[dict]]] = {}
        self.poster_share: dict[str, tuple[str | None, Any]] = {}
        self.audio_share: dict[tuple[str, bool], _AudioOutcome] = {}
        self.inputs: dict[tuple[str, ...], _Input] = {}
        self.sniffs: dict[Path, tuple[str | None, int, str]] = {}
        self.probes: dict[Path, VideoProbe | None] = {}
        self.audio_probes: dict[Path, AudioProbe | None] = {}

    def input(self, record: ItemRecord) -> _Input | None:
        """The record's source (after the hooks), or None when missing."""
        source = record.asset_abs
        if source is None or not source.is_file():
            return None
        return _read_input(record, source, self.decoders, self.scratch,
                           self.inputs)

    def sniff(self, found: _Input, data: bytes) -> tuple[str | None, int,
                                                         str]:
        """(format, carve offset, sha256 of the effective bytes) of the
        image bytes `data` read from ``found.path``."""
        if found.path not in self.sniffs:
            fmt, offset = sniff_image(data)
            digest = (hashlib.sha256(data[offset:]).hexdigest() if offset
                      else found.digest)
            self.sniffs[found.path] = (fmt, offset, digest)
        return self.sniffs[found.path]

    def probe(self, found: _Input) -> VideoProbe | None:
        if found.path not in self.probes:
            self.probes[found.path] = probe_video(found.path)
        return self.probes[found.path]

    def audio_probe(self, found: _Input) -> AudioProbe | None:
        if found.path not in self.audio_probes:
            self.audio_probes[found.path] = probe_audio(found.path)
        return self.audio_probes[found.path]


MEDIA_TYPES = ("image", "video", "audio")


def _ship_record(record: ItemRecord, run: _Pass,
                 decoded_sizes: list[tuple[int, int]] | None) -> int:
    """Place one record's media (in record order); 1 when skipped."""
    kind = record.item.get("type")
    if kind not in MEDIA_TYPES:
        return 0
    found = run.input(record)
    if found is None:
        record.asset_meta["decision"] = "missing-source"
        record.notes.append("source asset missing: item dropped from "
                            "manifest")
        record.skipped = True
        return 1
    if kind == "video":
        return _ship_video(record, found, run)
    if kind == "audio":
        return _ship_audio(record, found, run)
    skipped = _ship_image(record, found, run)
    if found.steps and decoded_sizes is not None and not record.skipped:
        _add_size(found.path, decoded_sizes)
    return skipped


class _Ahead:
    """Encodes made ahead of the in-order pass on worker threads.

    Each task is keyed by exactly what the in-order pass would encode
    (the effective input's sha256, plus the start time for a poster) and
    calls the same function the in-order pass would; its output goes to
    a scratch file (never held in memory while it waits), which the
    in-order pass reads back and places as if it had just made it. A
    key the in-order pass never asks for (a video whose every poster
    failed, say) only costs the work; one it asks for that was not
    planned is made there and then."""

    def __init__(self, workers: Workers, scratch: Path,
                 cache: MediaCache | None) -> None:
        self.workers = workers
        self.scratch = scratch
        scratch.mkdir()
        self.cache = cache
        self._seq = itertools.count()

    def _file(self, ext: str) -> Path:
        return self.scratch / f"{next(self._seq)}.{ext}"

    def image(self, path: Path, offset: int, digest: str, fmt: str,
              wrapped: bool) -> None:
        self.workers.submit(("image", digest), self._image, path, offset,
                            digest, fmt, wrapped, self._file("out"))

    def _image(self, path: Path, offset: int, digest: str, fmt: str,
               wrapped: bool, out: Path) -> tuple[Any, ...]:
        data = path.read_bytes()[offset:]
        ext, made, decision, notes, steps = decide_image_cached(
            self.cache, data, digest, fmt, wrapped)
        same = made is data or made == data
        if not same:
            out.write_bytes(made)
        return ext, None if same else out, decision, notes, steps

    def take_image(self, digest: str, data: bytes,
                   ) -> tuple[str, bytes, str, list[str], list[dict]] | None:
        key = ("image", digest)
        if not self.workers.has(key):
            return None
        ext, out, decision, notes, steps = self.workers.result(key)
        made = data if out is None else _take_file(out)
        return ext, made, decision, notes, steps

    def poster(self, source: Path, start: float, digest: str) -> None:
        self.workers.submit(("poster", digest, start), self._poster, source,
                            start, digest, self._file("poster"))

    def _poster(self, source: Path, start: float, digest: str,
                out: Path) -> Poster:
        made = extract_poster(source, start, self.cache, digest)
        if made.error is None:
            out.write_bytes(made.data)
            made.data = b""
        return made, out

    def take_poster(self, digest: str, start: float) -> Poster | None:
        key = ("poster", digest, start)
        if not self.workers.has(key):
            return None
        made, out = self.workers.result(key)
        if made.error is not None:
            return made
        return Poster(made.ext, _take_file(out), made.steps)

    def video(self, step: dict[str, Any], source: Path, digest: str) -> None:
        self.workers.submit(("video", digest), self._video, step, source,
                            digest, self._file("mp4"), video=True)

    def _video(self, step: dict[str, Any], source: Path, digest: str,
               out: Path) -> tuple[str | None, Path]:
        return file_step_cached(self.cache, step, source, digest, out), out

    def take_video(self, digest: str) -> tuple[str | None, Path] | None:
        key = ("video", digest)
        return self.workers.result(key) if self.workers.has(key) else None

    def audio(self, source: Path, probe: AudioProbe,
              step: dict[str, Any] | None, digest: str, loops: bool) -> None:
        """``audio_work`` on a worker: in the video lane when it runs an
        ffmpeg step, else (a kept file's decode) with the stills."""
        self.workers.submit(("audio", digest, loops), audio_work, source,
                            probe, step, digest, self.cache,
                            self._file(audio_ext(probe, step)),
                            video=step is not None)

    def take_audio(self, digest: str, loops: bool) -> AudioWork | None:
        key = ("audio", digest, loops)
        return self.workers.result(key) if self.workers.has(key) else None


def _take_file(path: Path) -> bytes:
    data = path.read_bytes()
    path.unlink()
    return data


def _plan_ahead(records: list[ItemRecord], run: _Pass) -> None:
    """Queue every encode the in-order pass will ask for, in record
    order, each distinct one once, on ``run.ahead``'s workers. It reads
    sources, runs the decoder hooks, sniffs and probes exactly as the
    in-order pass would (through the same memos, so that pass does none
    of it again) and skips what an earlier ledger already holds."""
    ahead = run.ahead
    assert ahead is not None
    planned_posters: set[str] = set()
    planned_videos: set[str] = set()
    planned_audio: set[tuple[str, bool]] = set()
    for record in records:
        kind = record.item.get("type")
        if kind not in MEDIA_TYPES:
            continue
        found = run.input(record)
        if found is None:
            continue
        if kind == "audio":
            _plan_audio(found, run, planned_audio, _loops(record))
            continue
        if kind == "image":
            data = found.path.read_bytes()
            fmt, offset, digest = run.sniff(found, data)
            if fmt is not None:
                ahead.image(found.path, offset, digest, fmt, offset > 0)
            continue
        probe = run.probe(found)
        if probe is None:
            continue
        digest = found.digest
        start = float(record.item.get("startSeconds") or 0.0)
        poster_key = f"{digest}@{start:.6f}"
        if poster_key not in planned_posters:
            planned_posters.add(poster_key)
            frame = found.steps + [poster_step(start)]
            if not run.placed.recorded("poster", found.sha256, frame):
                ahead.poster(found.path, start, digest)
        if digest in planned_videos:
            continue
        planned_videos.add(digest)
        rule = video_decision(probe.container, probe.codec, probe.tag)
        if rule == KEEP:
            continue
        step = remux_step(probe) if rule == REMUX else transcode_step(probe)
        if not run.placed.recorded("video", found.sha256,
                                   found.steps + [step]):
            ahead.video(step, found.path, digest)


def _loops(record: ItemRecord) -> bool:
    """Whether an audio record is a track that loops (its item's
    ``loops``: a kinetic-media request's field, or kinetic-extract's
    music, ambience and video sound)."""
    return record.item.get("loops") is True


def _plan_audio(found: _Input, run: _Pass, planned: set[tuple[str, bool]],
                loops: bool) -> None:
    """Queue an audio source's ``audio_work`` once per input sha256 and
    `loops`, unless an earlier ledger already records its step's
    output."""
    probe = run.audio_probe(found)
    key = (found.digest, loops)
    if probe is None or probe.codec is None or key in planned:
        return
    planned.add(key)
    step = audio_step(probe, loops)
    if step is None or not run.placed.recorded("audio", found.sha256,
                                               found.steps + [step]):
        assert run.ahead is not None
        run.ahead.audio(found.path, probe, step, found.digest, loops)


def _shared_note(record: ItemRecord, shipped: str) -> None:
    record.notes.append(f"shares shipped file {shipped!r} (identical "
                        "output)")


def _ship_image(record: ItemRecord, found: _Input, run: _Pass) -> int:
    placed, share = run.placed, run.image_share
    source = found.path
    data = source.read_bytes()
    fmt, offset, digest = run.sniff(found, data)
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
    if digest in share:
        shipped, decision, steps = share[digest]
        already = True
    else:
        made = run.ahead.take_image(digest, effective) if run.ahead \
            else None
        ext, out_bytes, decision, notes, steps = made or decide_image_cached(
            run.cache, effective, digest, fmt, offset > 0)
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


def _ship_video(record: ItemRecord, found: _Input, run: _Pass) -> int:
    placed, cache, scratch = run.placed, run.cache, run.scratch
    video_share, poster_share = run.video_share, run.poster_share
    source = found.path
    meta: dict[str, Any] = record.asset_meta
    probe = run.probe(found)
    container = probe.container if probe else None
    codec = probe.codec if probe else None
    meta["sniffedFormat"] = container or "unknown"
    meta["codec"] = codec or "unknown"
    if probe is None:
        meta["decision"] = "skipped"
        record.notes.append(
            f"unprobeable video {source.name}: item dropped from manifest")
        record.skipped = True
        return 1
    if found.steps:
        _reprobe_duration(record, source)
    digest = found.digest
    src = _source(record, found.sha256, found.size)

    # The poster first: a video without one ships nothing. An earlier
    # ledger's poster made by this same recipe is reused as it stands.
    start = float(record.item.get("startSeconds") or 0.0)
    poster_key = f"{digest}@{start:.6f}"
    made_poster: Poster | None = None
    cached = poster_share.get(poster_key)
    if cached is None:
        frame = found.steps + [poster_step(start)]
        prior = placed.prior("poster", found.sha256, frame)
        if prior is not None:
            cached = (prior[0], prior[1][len(found.steps):])
            poster_share[poster_key] = cached
        else:
            made_poster = (run.ahead.take_poster(digest, start)
                           if run.ahead else None) \
                or extract_poster(source, start, cache, digest)
            if made_poster.error is not None:
                cached = (None, made_poster.error)
                poster_share[poster_key] = cached
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
        rule = video_decision(container, codec, probe.tag)
        if rule == KEEP:
            shipped, already = placed.copy_file(source, digest, container)
            decision = "copy"
            steps = [{**PRESERVE_STEP, "codec": codec or "unknown"}]
        else:
            step = remux_step(probe) if rule == REMUX \
                else transcode_step(probe)
            prior = placed.prior("video", found.sha256,
                                 found.steps + [step])
            if prior is not None:
                shipped, already = prior[0], False
            else:
                made = scratch / f"{rule}.mp4"
                ran = run.ahead.take_video(digest) if run.ahead else None
                if ran is not None:
                    error, made = ran
                else:
                    error = file_step_cached(cache, step, source, digest,
                                             made)
                if error is not None:
                    made.unlink(missing_ok=True)
                    meta["decision"] = "skipped"
                    record.notes.append(
                        f"{rule} failed for {source.name}: item dropped")
                    record.skipped = True
                    return 1
                shipped, already = placed.move_file(made, "mp4")
            decision = rule
            steps = [step]
            record.notes.append(
                f"remuxed {codec}/{container} to mp4 (stream copy, video "
                "only)" if rule == REMUX else
                f"transcoded {codec}/{container} to h264 mp4 (faststart)")
        video_share[digest] = (shipped, decision, steps)
    placed.record(shipped, "video", src, found.steps + steps)
    if already:
        _shared_note(record, shipped)
    meta["decision"] = decision
    meta["file"] = shipped

    if made_poster is not None:
        poster, _ = placed.put_bytes(made_poster.data, made_poster.ext)
        poster_steps = made_poster.steps or []
        poster_share[poster_key] = (poster, poster_steps)
    else:
        poster, poster_steps = cached
    placed.record(poster, "poster", src, found.steps + poster_steps)
    _set_media(record.item, shipped, poster)
    meta["poster"] = poster
    return 0


@dataclass
class _AudioOutcome:
    """What one audio input became: its ``decision``, the ``shipped`` ref
    (None when nothing shipped), the ledger ``steps`` after any decode
    steps, the decoded ``duration``, a ``note``, and whether the bytes
    were ``already`` placed by another source this run."""

    decision: str
    shipped: str | None = None
    steps: list[dict[str, Any]] | None = None
    duration: float | None = None
    note: str | None = None
    already: bool = False


def _ship_audio(record: ItemRecord, found: _Input, run: _Pass) -> int:
    meta: dict[str, Any] = record.asset_meta
    probe = run.audio_probe(found)
    meta["sniffedFormat"] = probe.container if probe else "unknown"
    if probe is None:
        meta["codec"] = "unknown"
        outcome = _AudioOutcome("skipped", note=(
            f"unprobeable audio {found.path.name}: nothing shipped"))
    elif probe.codec is None:
        outcome = _AudioOutcome(NO_AUDIO, note=(
            f"no audio stream in {found.path.name}: nothing shipped"))
    else:
        meta["codec"] = probe.codec
        key = (found.digest, _loops(record))
        outcome = run.audio_share.get(key)
        if outcome is None:
            outcome = _audio_outcome(found, probe, run, key[1])
            run.audio_share[key] = outcome
        elif outcome.shipped is not None:
            outcome = replace(outcome, already=True)
    meta["decision"] = outcome.decision
    if outcome.note:
        record.notes.append(outcome.note)
    if outcome.decision == "skipped":
        record.skipped = True
        return 1
    if outcome.shipped is None:
        return 0
    run.placed.record(outcome.shipped, "audio",
                      _source(record, found.sha256, found.size),
                      found.steps + (outcome.steps or []))
    run.placed.put_script(outcome.shipped)
    _set_media(record.item, outcome.shipped)
    record.item["durationSeconds"] = outcome.duration
    meta["file"] = outcome.shipped
    if outcome.already:
        _shared_note(record, outcome.shipped)
    return 0


def _audio_outcome(found: _Input, probe: AudioProbe, run: _Pass,
                   loops: bool) -> _AudioOutcome:
    """Make (or take from the workers, or from an earlier ledger) what
    `found`'s audio ships as, looping or not, and place it."""
    placed = run.placed
    step = audio_step(probe, loops)
    ext = audio_ext(probe, step)
    prior, seen = None, set[str]()
    if step is not None:
        steps = found.steps + [step]
        # Placed this run by another source: the same note either way.
        seen = {ref for ref, _ in placed.recorded("audio", found.sha256,
                                                  steps)
                if ref in placed.written}
        prior = placed.prior("audio", found.sha256, steps)
    work = run.ahead.take_audio(found.digest, loops) \
        if run.ahead and prior is None else None
    if work is None:
        reuse = None if prior is None else placed.out_dir / prior[0]
        work = audio_work(found.path, probe, step, found.digest, run.cache,
                          run.scratch / f"audio.{ext}", reuse)
    if work.error is not None:
        return _AudioOutcome("skipped", note=(
            f"{found.path.name}: {work.error}: nothing shipped"))
    loud = (f"max_volume {work.max_volume:.1f} dB"
            if work.max_volume is not None else "")
    if work.silent():
        return _AudioOutcome(SILENT, note=(
            f"{loud} is below the {SILENT_MAX_VOLUME_DB:.1f} dB silence "
            "threshold: nothing shipped"))
    if step is None:
        shipped, already = placed.copy_file(found.path, found.digest, ext)
        return _AudioOutcome(COPY, shipped,
                             [{**PRESERVE_STEP, "codec": probe.codec}],
                             work.duration, already=already)
    if prior is not None:
        shipped, already = prior[0], prior[0] in seen
    else:
        assert work.made is not None
        shipped, already = placed.move_file(work.made, ext)
    note = step["reason"] + (f"; {loud}" if loud else "")
    return _AudioOutcome(step["step"], shipped, [step], work.duration,
                         note, already)


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
