"""Shared helpers for the extractor tests."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any


def content_ref(data: bytes, ext: str) -> str:
    """The path shipped bytes must be declared by (docs/plan.md Phase 25).

    Recomputed here rather than imported from ``kinetic_extract``: the
    name is the sha256 of the SHIPPED bytes, under a bucket of its first
    two hex digits, so a test comparing against this helper catches a
    changed rule instead of just echoing the production constant back.
    """
    digest = hashlib.sha256(data).hexdigest()
    return f"media/{digest[:2]}/{digest}.{ext}"


def is_content_addressed(out: Path, ref: str) -> bool:
    """True when ``ref`` names ``out/ref`` by the hash of its own bytes."""
    path = out / ref
    ext = ref.rsplit(".", 1)[-1]
    return path.is_file() and ref == content_ref(path.read_bytes(), ext)


def declared_media(manifest: dict[str, Any]) -> list[str]:
    """Every media path the manifest declares: file, poster, and frames."""
    paths: list[str] = []
    for item in manifest["items"]:
        for key in ("file", "poster", "frames"):
            value = item.get(key)
            if isinstance(value, str):
                paths.append(value)
            elif isinstance(value, list):
                paths.extend(value)
    return paths


def open_image(path: Path) -> Any:
    """A shipped image as a loaded Pillow image, ``.jxl`` included
    (Pillow reads no JPEG XL; the pinned libjxl decodes it)."""
    from PIL import Image

    if path.suffix == ".jxl":
        from kinetic_extract import media_tools

        return Image.fromarray(media_tools.jxl_decode(path.read_bytes()))
    with Image.open(path) as img:
        img.load()
        return img.copy()
