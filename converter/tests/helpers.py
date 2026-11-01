"""Shared helpers for the extractor tests."""

from __future__ import annotations

import hashlib
from typing import Any


def bucketed(name: str) -> str:
    """The path a shipped media file name must be declared by (Phase 17).

    Recomputed here rather than imported from ``kinetic_extract``: the
    bucket is the first two hex digits of the sha1 of the BASENAME, so a
    test comparing against this helper catches a changed rule instead of
    just echoing the production constant back.
    """
    return f"assets/{hashlib.sha1(name.encode('utf-8')).hexdigest()[:2]}/{name}"


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
