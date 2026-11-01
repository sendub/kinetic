"""Asset pass: ship every referenced asset at its TRUE format (docs/plan.md
Phase 10, Phase 9b policy).

Formats are sniffed from content (Pillow, magic bytes, ffprobe), never from
file extensions - corpus extensions lie. Policies:

- Images in a browser-compatible format (png/jpeg/webp/gif) ship
  byte-identical under ``<id>.<ext>`` (true ext), unless a verified
  lossless JPEG XL encode (``cjxl -d 0 -e 9``, round-tripped through
  ``djxl`` and pixel-compared) is strictly smaller, in which case ``.jxl``
  ships. Animated images are never re-encoded.
- Other image formats (bmp, tiff, ...) are decoded with Pillow; the smallest
  of (PNG, JPEG q92, JXL-if-available) ships, lossless-first when the image
  has alpha (PNG or JXL only).
- Wrapped/obfuscated images (a PNG/JPEG signature inside the first 64
  bytes, none at offset 0) are carved from the signature and follow the
  same preserve-or-JXL rule, recorded as ``carved``. Anything else is
  ``skipped``: the item is dropped from the manifest and reported.
- Videos: ffprobe container + codec decide. Browser-native combinations
  (mp4/mov + h264/hevc, webm/m4v + vp8/vp9/av1, mkv/webm + vp9/av1) copy
  byte-identical keeping the container extension; everything else
  transcodes to bitexact H.264 faststart MP4. MKV is Chromium-class; the
  copy decision is recorded for a Safari-targeting rebuild (docs
  content-format).
- Posters are the frame AT ``startSeconds`` (``-ss`` after ``-i``, exact
  output seek) rendered to bitexact PNG, then JPEG, as ``<id>.poster.jpg``.
- Identical source bytes (sha256) referenced by several items ship ONE
  file named after the first item; later items reference it. Posters dedup
  by (source bytes, startSeconds).
- A shipped file is written to ``media_ref(name)``: the ``assets/<xx>/``
  bucket of its own basename by default, or the output folder itself when
  ``shard`` is false (``--flat``). Manifest and ledger paths are that same
  ref, so no path drift is possible (docs/plan.md Phase 17).

Every decision, size, and sniffed format lands in the build ledger.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
from io import BytesIO
from pathlib import Path
from typing import Any

from .media import media_ref
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


def _run(cmd: list[str]) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(cmd, capture_output=True, text=True,
                              check=False)
    except OSError:
        return None


def cjxl_available() -> bool:
    """Whether cjxl and djxl are both on PATH (probed once per process)."""
    global _CJXL_OK
    if _CJXL_OK is None:
        probe = _run(["cjxl", "--version"])
        probe2 = _run(["djxl", "--version"])
        _CJXL_OK = bool(probe and probe.returncode == 0
                        and probe2 and probe2.returncode == 0)
    return _CJXL_OK


_CJXL_OK: bool | None = None


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
    (wrapped image): the returned offset is where the real image starts.
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
        if at > 0:
            return fmt, at
    return None, 0


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
    proc = _run(["ffprobe", "-v", "error",
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


def _encode_jxl_lossless(data: bytes, src_ext: str, tmp: Path) -> bytes | None:
    """Verified lossless JXL bytes for `data`, or None (fail/mismatch/bigger).

    cjxl needs an input file whose extension it can read, and its output
    must decode pixel-identically to the source (djxl round-trip check).
    """
    from PIL import Image

    src = tmp / f"src.{src_ext}"
    src.write_bytes(data)
    out = tmp / "out.jxl"
    # -d 0 is mathematically lossless everywhere; -q 100 names it on
    # builds without -d, which then rejects the combination.
    proc = _run(["cjxl", "-d", "0", "-e", "9", str(src), str(out)])
    if proc is None or proc.returncode != 0 or not out.exists():
        return None
    check = tmp / "check.png"
    proc = _run(["djxl", str(out), str(check)])
    if proc is None or proc.returncode != 0 or not check.exists():
        return None
    try:
        with Image.open(BytesIO(data)) as orig, Image.open(check) as back:
            orig.load()
            back.load()
            if orig.size != back.size:
                return None
            # Compare what the browser would render: a palette PNG decodes
            # to RGB through a different mode but must show identical
            # pixels for the encode to count as lossless.
            if orig.convert("RGBA").tobytes() != back.convert("RGBA").tobytes():
                return None
    except (OSError, ValueError):
        return None
    return out.read_bytes()


def _encode_png(img: Any) -> bytes:
    buf = BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _encode_jpeg(img: Any) -> bytes:
    buf = BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


def _has_alpha(img: Any) -> bool:
    if img.mode in ("RGBA", "LA"):
        lo, _ = img.getchannel("A").getextrema()
        return lo < 255  # fully-opaque RGBA has no real transparency
    return img.mode == "P" and "transparency" in img.info


def convert_incompatible(data: bytes, tmp: Path,
                         ) -> tuple[str, bytes, list[str]]:
    """Decode a non-browser image and pick the smallest ship candidate.

    Lossless-first for transparency: alpha images consider PNG and JXL
    only; opaque images consider PNG, JPEG q92, and JXL.
    Returns (ext, bytes, notes).
    """
    from PIL import Image

    notes: list[str] = []
    with Image.open(BytesIO(data)) as img:
        img.load()
        alpha = _has_alpha(img)
        png_bytes = _encode_png(img)
        candidates: list[tuple[int, str, bytes]] = [(len(png_bytes), "png",
                                                     png_bytes)]
        if not alpha:
            jpeg_bytes = _encode_jpeg(img)
            candidates.append((len(jpeg_bytes), "jpg", jpeg_bytes))
        if cjxl_available():
            lossless_src = _encode_png(img)
            jxl = _encode_jxl_lossless(lossless_src, "png", tmp)
            if jxl is not None:
                candidates.append((len(jxl), "jxl", jxl))
            else:
                notes.append("jxl unavailable for converted image")
        candidates.sort(key=lambda c: c[0])
        _, ext, out = candidates[0]
        notes.append("converted to " + ext +
                     (" (alpha kept lossless)" if alpha else ""))
        return ext, out, notes


def decide_image_ship(data: bytes, fmt: str, wrapped: bool, tmp: Path,
                      ) -> tuple[str, bytes, str, list[str]]:
    """(ext, bytes, decision, notes) for effective image `data`."""
    notes: list[str] = []
    if fmt in COMPATIBLE_EXTS:
        ext = "jpg" if fmt == "jpeg" else fmt
        if is_animated(data, fmt):
            notes.append("animated: always preserved byte-identical")
            return ext, data, ("carved" if wrapped else "preserve"), notes
        jxl = _encode_jxl_lossless(data, fmt, tmp)
        if jxl is None:
            if cjxl_available():
                notes.append("jxl round-trip failed: kept original")
        elif len(jxl) < len(data):
            notes.append(f"jxl {len(jxl)} < original {len(data)}")
            return "jxl", jxl, ("carved" if wrapped else "jxl"), notes
        else:
            notes.append(f"jxl {len(jxl)} >= original {len(data)}: kept")
        return ext, data, ("carved" if wrapped else "preserve"), notes
    ext, out, conv_notes = convert_incompatible(data, tmp)
    notes += conv_notes
    return ext, out, ("carved" if wrapped else "decode-convert"), notes


def transcode_video(source: Path, out: Path) -> bool:
    """Bitexact H.264 faststart MP4 transcode; True on success."""
    proc = _run(["ffmpeg", "-y", "-v", "error", "-i", str(source),
                 "-c:v", "libx264", "-preset", "veryfast",
                 "-pix_fmt", "yuv420p", "-c:a", "aac",
                 "-fflags", "+bitexact", "-flags", "+bitexact",
                 "-map_metadata", "-1", "-threads", "1",
                 "-movflags", "+faststart", str(out)])
    return proc is not None and proc.returncode == 0 and out.exists()


def extract_poster(source: Path, out_jpg: Path, start_seconds: float) -> bool:
    """Write the frame at start_seconds (exact output seek) as poster JPEG."""
    with tempfile.TemporaryDirectory() as td:
        png = Path(td) / "frame.png"
        proc = _run(["ffmpeg", "-v", "error", "-i", str(source),
                     "-ss", f"{start_seconds:.6f}", "-frames:v", "1",
                     "-fflags", "+bitexact", "-flags:v", "+bitexact",
                     "-map_metadata", "-1", "-an", str(png)])
        if proc is None or proc.returncode != 0 or not png.exists():
            return False
        from PIL import Image

        try:
            with Image.open(png) as img:
                img.load()
                img.convert("RGB").save(out_jpg, "JPEG",
                                        quality=POSTER_JPEG_QUALITY)
        except (OSError, ValueError):
            return False
    return True


def _media_path(out_dir: Path, ref: str) -> Path:
    """Destination for a shipped ref, with its bucket directory created."""
    path = out_dir / ref
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def run_asset_pass(records: list[ItemRecord], out_dir: Path,
                   shard: bool = True) -> int:
    """Ship every referenced asset at its TRUE format (docs/plan.md Phase 10).

    Mutates each record: item file/poster fields point at shipped files,
    ``record.asset_meta`` carries the decision (and ``record.skipped``
    marks items dropped from the manifest). ``shard`` places shipped files
    in ``assets/<xx>/`` buckets (docs/plan.md Phase 17); false keeps the
    output folder flat. Returns the skipped count.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    skipped = 0
    # sha256 -> shipped ref, so identical sources share one file.
    image_share: dict[str, str] = {}
    video_share: dict[str, tuple[str, str]] = {}
    poster_share: dict[str, str] = {}
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        for record in records:
            item = record.item
            kind = item.get("type")
            if kind not in ("image", "video"):
                continue
            source = record.asset_abs
            if source is None or not source.is_file():
                record.asset_meta["decision"] = "missing-source"
                continue
            if kind == "image":
                skipped += _ship_image(record, source, out_dir, tmp,
                                       image_share, shard)
            else:
                skipped += _ship_video(record, source, out_dir, tmp,
                                       video_share, poster_share, shard)
    return skipped


def _ship_image(record: ItemRecord, source: Path, out_dir: Path, tmp: Path,
                share: dict[str, tuple[str, str]], shard: bool) -> int:
    item_id = record.item["id"]
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
    if offset:
        meta["wrapped"] = offset
    digest = hashlib.sha256(effective).hexdigest()
    if digest in share:
        shipped, decision = share[digest]
        record.item["file"] = shipped
        meta["decision"] = decision
        meta["shippedFile"] = shipped
        meta["dedupOf"] = shipped
        meta["sourceBytes"] = len(data)
        meta["shippedBytes"] = (out_dir / shipped).stat().st_size
        record.notes.append(f"shares shipped file {shipped!r} (identical "
                            "source)")
        return 0
    ext, out_bytes, decision, notes = decide_image_ship(effective, fmt,
                                                        offset > 0, tmp)
    shipped = media_ref(f"{item_id}.{ext}", shard)
    _media_path(out_dir, shipped).write_bytes(out_bytes)
    share[digest] = (shipped, decision)
    record.item["file"] = shipped
    meta["decision"] = decision
    meta["shippedFile"] = shipped
    meta["sourceBytes"] = len(data)
    meta["shippedBytes"] = len(out_bytes)
    record.notes.extend(notes)
    return 0


def _ship_video(record: ItemRecord, source: Path, out_dir: Path, tmp: Path,
                video_share: dict[str, tuple[str, str]],
                poster_share: dict[str, str], shard: bool) -> int:
    item_id = record.item["id"]
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
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    meta["sourceBytes"] = len(source.read_bytes())
    if digest in video_share:
        shipped, decision = video_share[digest]
        meta["dedupOf"] = shipped
        record.notes.append(f"shares shipped file {shipped!r} (identical "
                            "source)")
    else:
        native, ext, _ = video_is_native(source)
        shipped = media_ref(f"{item_id}.{ext}", shard)
        shipped_file = _media_path(out_dir, shipped)
        if native:
            shutil.copyfile(source, shipped_file)
            decision = "copy"
            if ext == "mkv":
                record.notes.append("mkv kept native: Chromium-class; "
                                    "convert to mp4 for Safari")
        else:
            if not transcode_video(source, shipped_file):
                meta["decision"] = "skipped"
                record.notes.append(
                    f"transcode failed for {source.name}: item dropped")
                record.skipped = True
                return 1
            decision = "transcode"
            record.notes.append(
                f"transcoded {codec}/{container} to h264 mp4 (faststart)")
        video_share[digest] = (shipped, decision)
    record.item["file"] = shipped
    meta["decision"] = decision
    meta["shippedFile"] = shipped
    meta["shippedBytes"] = (out_dir / shipped).stat().st_size

    start = float(record.item.get("startSeconds") or 0.0)
    poster_key = f"{digest}@{start:.6f}"
    if poster_key in poster_share:
        poster = poster_share[poster_key]
    else:
        poster = media_ref(f"{item_id}.poster.jpg", shard)
        if not extract_poster(source, _media_path(out_dir, poster), start):
            record.notes.append(
                "poster extraction failed; falling back to source ext")
            poster = shipped  # last resort: first-frame still = the file
        poster_share[poster_key] = poster
    record.item["poster"] = poster
    meta["shippedPoster"] = poster
    return 0
