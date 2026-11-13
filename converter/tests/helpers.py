"""Shared helpers for the extractor tests."""

from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import re
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
    """Every media path the manifest declares: file, poster, and frames,
    then the audio track files."""
    paths: list[str] = []
    for item in manifest["items"]:
        for key in ("file", "poster", "frames"):
            value = item.get(key)
            if isinstance(value, str):
                paths.append(value)
            elif isinstance(value, list):
                paths.extend(value)
    tracks = manifest.get("audio", {}).get("tracks", {})
    paths.extend(track["file"] for track in tracks.values())
    return paths


def audio_scripts(manifest: dict[str, Any]) -> set[str]:
    """The script beside each audio track file, ``<file>.js``
    (docs/content-format.md, "Audio"): in the folder, not in the
    manifest."""
    tracks = manifest.get("audio", {}).get("tracks", {})
    return {f"{track['file']}.js" for track in tracks.values()}


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


# docs/content-format.md, "Audio": the script beside each audio file.
_SCRIPT = re.compile(
    rb'__kineticAudio\("([^"\\]*)","([A-Za-z0-9+/]*={0,2})"\);\n')


def script_holds(out: Path, file: str) -> bytes | None:
    """The bytes ``out/<file>.js`` hands the player when it is the script
    the content format documents for ``file``: one ASCII line naming
    ``file`` and holding standard base64. None when it is absent or in
    any other shape. Parsed here rather than with kinetic_extract's
    reader, so a changed shape fails the tests."""
    path = out / f"{file}.js"
    if not path.is_file():
        return None
    found = _SCRIPT.fullmatch(path.read_bytes())
    if found is None or found.group(1).decode("ascii") != file:
        return None
    try:
        return base64.b64decode(found.group(2), validate=True)
    except binascii.Error:
        return None


def encoded_tracks(manifest: dict[str, Any],
                   ledger: dict[str, Any]) -> set[str]:
    """Ids of the audio tracks whose file an encoder made (a ledger step
    whose ``-c:a`` is not ``copy``), not a stream copy or the source."""
    def encodes(step: dict[str, Any]) -> bool:
        args = step.get("args") or []
        return "-c:a" in args and args[args.index("-c:a") + 1] != "copy"

    tracks = manifest.get("audio", {}).get("tracks", {})
    return {track_id for track_id, track in tracks.items()
            if any(encodes(step)
                   for step in ledger["media"][track["file"]]["steps"])}


def mask_tracks(manifest: dict[str, Any], ids: set[str]) -> dict[str, Any]:
    """The manifest with the `file` and `durationSeconds` of the tracks
    in `ids` replaced by markers. An encoder's bytes, and how ffmpeg trims
    an AAC file's padding when it decodes it, differ between ffmpeg
    versions, and the tests run whatever ffmpeg the system has: compare
    those tracks by format, not by bytes."""
    masked = copy.deepcopy(manifest)
    for track_id in ids:
        track = masked["audio"]["tracks"][track_id]
        track["file"] = "<encoded>." + track["file"].rsplit(".", 1)[1]
        track["durationSeconds"] = "<decoded>"
    return masked
