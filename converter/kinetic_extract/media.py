"""Media helpers: ffprobe duration, default display resolution, streamed
hashing, and the content-addressed shipped-file path rule.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import threading
from collections import Counter
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from . import media_tools

IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "gif", "jxl"}
VIDEO_EXTS = {"mp4", "webm", "mkv", "mov", "m4v"}
DEFAULT_SIZE = (1280, 720)

MEDIA_DIR = "media"
HASH_CHUNK = 1 << 20


def content_ref(digest: str, ext: str) -> str:
    """Where shipped bytes with this sha256 live, relative to the content
    folder: ``media/<h[:2]>/<h>.<ext>`` (docs/plan.md Phase 25).

    The name is the hash of the bytes actually shipped, so the same bytes
    get the same path on every run and machine, and identical outputs
    (whatever their source) are one file. ``ext`` is the true shipped
    format. The two-hex-digit bucket keeps a big game's output out of one
    huge directory. Every writer and every manifest/ledger media value is
    built here, so the file on disk and the path pointing at it cannot
    drift.
    """
    return f"{MEDIA_DIR}/{digest[:2]}/{digest}.{ext}"


def sha256_file(path: Path, chunk: int = HASH_CHUNK) -> str:
    """The sha256 hex digest of a file, read in chunks (big videos are
    never held whole in memory just to be named)."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def write_whole(target: Path, write: Callable[[Path], Any]) -> None:
    """`write` a temporary file beside `target`, then rename it over
    `target`: readers, and a run that crashes midway, see the old file
    or the whole new one, never part of it."""
    tmp = target.with_name(f".{target.name}.{os.getpid()}-"
                           f"{threading.get_ident()}.tmp")
    try:
        write(tmp)
        os.replace(tmp, target)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


class ExistingFileError(Exception):
    """A content-addressed path already holds bytes whose sha256 is not
    the one its name gives (docs/plan.md Phase 26)."""


def existing_problem(path: Path) -> str | None:
    """What is wrong with an existing ``media/<h[:2]>/<h>.<ext>``: None
    when its sha256 is ``h`` (reuse it untouched: it may be hard-linked
    elsewhere), else a message naming the path."""
    got = sha256_file(path)
    if got == path.stem:
        return None
    return (f"{path}: existing file's sha256 is {got}, not the one its "
            "name gives; not replaced (remove it, or use another output "
            "folder)")


def reuse_existing(path: Path) -> bool:
    """True when content-addressed `path` already exists with the right
    bytes (leave it untouched), False when absent; ExistingFileError,
    naming it, when it exists with other bytes (never overwritten)."""
    if not path.exists():
        return False
    problem = existing_problem(path)
    if problem is not None:
        raise ExistingFileError(problem)
    return True


def probe_duration_seconds(path: Path) -> float | None:
    """The file's duration via the pinned ffprobe, or None when it cannot be
    probed."""
    try:
        proc = subprocess.run(
            [*media_tools.ffprobe_cmd(), "-show_entries", "format=duration",
             "-of", "json", str(path)],
            capture_output=True, text=True, check=False)
    except OSError:
        return None
    if proc.returncode != 0:
        return None
    try:
        duration = json.loads(proc.stdout)["format"]["duration"]
        value = float(duration)
    except (KeyError, ValueError, TypeError, json.JSONDecodeError):
        return None
    return round(value, 6) if value > 0 else None


def image_size(path: Path) -> tuple[int, int] | None:
    """(width, height) of an image file Pillow or libjxl decodes, or None.
    Pillow reads no JPEG XL: a bare ``.jxl`` codestream's size is read
    from its header (``jxl_codestream_size``), anything else (a
    container) is decoded with the pinned libjxl."""
    from PIL import Image

    try:
        with Image.open(path) as img:
            return img.size
    except (OSError, ValueError):
        pass
    try:
        with path.open("rb") as fh:
            head = fh.read(64)
        if head[:2] != b"\xff\x0a" and head[4:12] != b"JXL \r\n\x87\n":
            return None
        size = jxl_codestream_size(head)
        if size is not None:
            return size
        pixels = media_tools.jxl_decode(path.read_bytes())
    except Exception:  # noqa: BLE001 - not a decodable image
        return None
    return int(pixels.shape[1]), int(pixels.shape[0])


# JPEG XL SizeHeader aspect ratios (ISO/IEC 18181-1): ratio 1..7 ->
# width = height * num // den.
_JXL_RATIOS = {1: (1, 1), 2: (12, 10), 3: (4, 3), 4: (3, 2), 5: (16, 9),
               6: (5, 4), 7: (2, 1)}


def jxl_codestream_size(head: bytes) -> tuple[int, int] | None:
    """The displayed (width, height) a bare JPEG XL codestream's header
    gives (SizeHeader, then ImageMetadata's orientation: 5..8 swap the
    axes, as libjxl's decode does), or None when `head` is not a bare
    codestream or too short. Reading 64 bytes is always enough. This
    skips decoding a whole poster just to learn its size; it gives what
    ``jxl_decode`` returns (tests check that against the decoder)."""
    if head[:2] != b"\xff\x0a":
        return None
    bits = int.from_bytes(head[2:], "little")
    at = 0
    avail = (len(head) - 2) * 8

    def read(n: int) -> int:
        nonlocal at
        if at + n > avail:
            raise IndexError
        value = (bits >> at) & ((1 << n) - 1)
        at += n
        return value

    def u32_dim() -> int:
        return 1 + read((9, 13, 18, 30)[read(2)])

    try:
        small = read(1)
        height = (read(5) + 1) * 8 if small else u32_dim()
        ratio = read(3)
        if ratio:
            num, den = _JXL_RATIOS[ratio]
            width = height * num // den
        else:
            width = (read(5) + 1) * 8 if small else u32_dim()
        orientation = 1
        if not read(1) and read(1):  # not all_default, extra_fields
            orientation = 1 + read(3)
    except IndexError:
        return None
    return (height, width) if orientation > 4 else (width, height)


def most_common_image_size(paths: list[Path],
                           extra: Iterable[tuple[int, int]] = (),
                           ) -> tuple[int, int] | None:
    """The size shared by most of the given image files plus the `extra`
    sizes (decoded images), or None."""
    sizes: Counter[tuple[int, int]] = Counter(extra)
    for path in paths:
        size = image_size(path)
        if size is not None:
            sizes[size] += 1
    if not sizes:
        return None
    return sizes.most_common(1)[0][0]
