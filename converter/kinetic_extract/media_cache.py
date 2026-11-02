"""Reuse cache for media conversion (docs/plan.md Phase 25, item 25.10).

Encoding is the slow part of a conversion (JPEG XL effort 9 on one
thread, ffmpeg transcodes and posters). The asset pass asks this cache
before each encode, so a re-run, or a later episode shipped into the same
folder, encodes nothing it has made before with the same inputs and
tools.

Layout under the cache root (``.tmp/kinetic-media-cache/`` at the repo
root, or ``$KINETIC_MEDIA_CACHE``; ``KINETIC_MEDIA_CACHE=off`` disables
it):

- ``memo/<k[:2]>/<k>.json``: one decision. ``k`` is the sha256 of a
  canonical JSON key: the cache ``FORMAT``, the operation (``image``,
  ``transcode``, ``poster``), the sha256 of the bytes entering the
  encode (after any decoder hook and carve), the recipe (every step
  dict and parameter the operation can choose from), and the run's whole
  ``mediaTools`` (tool versions and binary hashes). The value is the
  outcome: for an image the chosen ext, decision, notes, ledger steps
  and output sha256, so the candidate comparison ("is the JPEG XL
  smaller?") is skipped too, not just the encode.
- ``objects/<h[:2]>/<h>``: output bytes by their sha256. An output equal
  to its input (a kept original) stores no object.

Every object is hashed when read; a mismatch (corrupt or truncated) is a
miss, the object is deleted and the fresh encode writes it again. A
memo that does not parse is a miss. Every write is a temp file plus
``os.replace``, so concurrent runs never see half a file.

The key is the decoded bytes, not the raw source plus hook identity:
hooks always run (their output is what is encoded), so a changed hook
that changes the bytes misses, and one that gives the same bytes rightly
hits; the ledger's ``decode`` steps always come from the hooks run now.

Bump ``FORMAT`` whenever the code choosing between candidates changes
(new reasons, thresholds, candidate order) without a recipe parameter or
tool version changing: old memos then miss. ``kinetic-media rebuild``
never reads this cache; it re-encodes every step to verify the ledger.
Deleting the cache directory is always safe.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

CACHE_ENV = "KINETIC_MEDIA_CACHE"
OFF = "off"
# 2: the one video rule (docs/plan.md Phase 26) chooses copy or transcode.
FORMAT = 2
_CHUNK = 1 << 20


def cache_root() -> Path | None:
    """Repo ``.tmp/kinetic-media-cache``, ``$KINETIC_MEDIA_CACHE``, or
    None when that variable is ``off``."""
    env = os.environ.get(CACHE_ENV)
    if env == OFF:
        return None
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[2] / ".tmp" / "kinetic-media-cache"


def open_cache(tools: dict[str, Any]) -> MediaCache | None:
    """The run's cache (keyed by its ``mediaTools``), or None when off."""
    root = cache_root()
    return None if root is None else MediaCache(root, tools)


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def _atomic_write(path: Path, write: Any) -> None:
    """Write via a temp file in `path`'s directory, then os.replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as fh:
            write(fh)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


class MediaCache:
    """Memo records and an output object store under `root`."""

    def __init__(self, root: Path, tools: dict[str, Any]) -> None:
        self.root = Path(root)
        self.tools = json.loads(_canonical(tools))

    # --- memos ---------------------------------------------------------

    def key(self, op: str, input_sha256: str, recipe: Any) -> str:
        """The memo key for `op` over input bytes `input_sha256`."""
        return hashlib.sha256(_canonical({
            "format": FORMAT, "op": op, "input": input_sha256,
            "recipe": recipe, "tools": self.tools})).hexdigest()

    def _memo_path(self, key: str) -> Path:
        return self.root / "memo" / key[:2] / f"{key}.json"

    def get(self, key: str) -> dict[str, Any] | None:
        try:
            value = json.loads(self._memo_path(key).read_text("utf-8"))
        except (OSError, ValueError):
            return None
        return value if isinstance(value, dict) else None

    def put(self, key: str, value: dict[str, Any]) -> None:
        data = _canonical(value)
        _atomic_write(self._memo_path(key), lambda fh: fh.write(data))

    # --- objects -------------------------------------------------------

    def _object_path(self, digest: str) -> Path:
        return self.root / "objects" / digest[:2] / digest

    def get_bytes(self, digest: str) -> bytes | None:
        """The object's bytes, or None when missing or corrupt (deleted)."""
        path = self._object_path(digest)
        try:
            data = path.read_bytes()
        except OSError:
            return None
        if hashlib.sha256(data).hexdigest() != digest:
            path.unlink(missing_ok=True)
            return None
        return data

    def copy_to(self, digest: str, dest: Path) -> bool:
        """Copy the object to `dest`, hashing as it streams; False (and
        no `dest`, corrupt object deleted) when missing or corrupt."""
        path = self._object_path(digest)
        sha = hashlib.sha256()
        try:
            with path.open("rb") as src, dest.open("wb") as out:
                for chunk in iter(lambda: src.read(_CHUNK), b""):
                    sha.update(chunk)
                    out.write(chunk)
        except OSError:
            dest.unlink(missing_ok=True)
            return False
        if sha.hexdigest() != digest:
            dest.unlink(missing_ok=True)
            path.unlink(missing_ok=True)
            return False
        return True

    def put_bytes(self, data: bytes, digest: str) -> None:
        _atomic_write(self._object_path(digest), lambda fh: fh.write(data))

    def put_file(self, source: Path, digest: str) -> None:
        def write(fh: Any) -> None:
            with source.open("rb") as src:
                shutil.copyfileobj(src, fh, _CHUNK)
        _atomic_write(self._object_path(digest), write)
