"""Media helpers: ffprobe duration, default display resolution, streamed
hashing, and the content-addressed shipped-file path rule.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from collections import Counter
from pathlib import Path

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


def most_common_image_size(paths: list[Path]) -> tuple[int, int] | None:
    """The size shared by most of the given image files, or None."""
    from PIL import Image

    sizes: Counter[tuple[int, int]] = Counter()
    for path in paths:
        try:
            with Image.open(path) as img:
                sizes[img.size] += 1
        except (OSError, ValueError):
            continue
    if not sizes:
        return None
    return sizes.most_common(1)[0][0]
