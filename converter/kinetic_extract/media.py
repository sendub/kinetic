"""Media helpers: ffprobe duration and default display resolution.

Only used to fill manifest metadata; the actual asset copy/derive pass is
the next Phase 10 task.
"""

from __future__ import annotations

import json
import subprocess
from collections import Counter
from pathlib import Path

IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "gif", "jxl"}
VIDEO_EXTS = {"mp4", "webm", "mkv", "mov", "m4v"}
DEFAULT_SIZE = (1280, 720)


def probe_duration_seconds(path: Path) -> float | None:
    """The file's duration via ffprobe, or None when it cannot be probed."""
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
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
