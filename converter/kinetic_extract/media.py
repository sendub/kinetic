"""Media helpers: ffprobe duration, default display resolution, and the
shipped-file path rule.
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

MEDIA_ROOT = "assets"


def media_dir(name: str) -> str:
    """The bucket directory a shipped file lives in: ``assets/ab``.

    The bucket is the first two hex digits of the sha1 of the file's
    BASENAME - the name, never the bytes - so the same name lands in the
    same bucket in every run (docs/plan.md Phase 17). Up to 256 shallow
    buckets keep a big game's output out of the one huge directory macOS
    Finder stalls on. A bucket holds many files: uniqueness comes from the
    id-based names, not from the bucket.
    """
    return f"{MEDIA_ROOT}/{hashlib.sha1(name.encode('utf-8')).hexdigest()[:2]}"


def media_ref(name: str, shard: bool = True) -> str:
    """Where a shipped media file lives, relative to the content folder.

    Every writer and every manifest/ledger media value is built here from
    the same shipped name, so the file on disk and the path that points at
    it cannot drift. Posters and animation frames bucket by their OWN
    basenames, so one video's file and its poster may sit in different
    buckets. ``shard=False`` (the CLI's ``--flat``) keeps the folder flat.
    """
    return name if not shard else f"{media_dir(name)}/{name}"


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


def media_ext(source: str | None, kind: str) -> str:
    """The manifest extension for an item's media reference.

    Derived from the source file's extension when it is one the content
    format allows; otherwise the fallback for the item kind (the asset pass
    will ship that true format).
    """
    fallback = "mp4" if kind == "video" else "png"
    if not source or "." not in Path(source).name:
        return fallback
    ext = Path(source).suffix.lower().lstrip(".")
    allowed = VIDEO_EXTS if kind == "video" else IMAGE_EXTS
    return ext if ext in allowed else fallback
