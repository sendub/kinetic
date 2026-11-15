"""Implicit image registration (docs/extracting.md BUG 5).

Ren'Py answers an image name from more than `image` statements: it also
finds the files. The name of a loose asset is its path under ``game/``
without the extension, and the name of an ``.rpa`` member is the member
key without the extension — `scene beach 00001` plays
``images/beach 00001.jpg`` with no definition anywhere, which is how
games A, B and E of docs/extracting.md's corpus survey ship their scenes.
This module builds that name index so the timeline can resolve such
references instead of dropping them.

Index keys (task order, "exact key -> path-with-directory key ->
basename key"):

- every image/video file under ``game/`` recursively, keyed by its path
  without extension (``images/beach 00001``) and separately by its
  basename (``beach 00001``);
- archive members likewise, resolved lazily through
  ``kinetic_extract.rpa.AssetArchives.candidates`` only when no loose
  file matched (the archive indexes of a 6.9 GB game are not touched by
  a project that needs them);
- explicit `image` definitions win over both — the timeline consults
  them first and only reaches here when a name has no definition (or its
  defined file does not exist anywhere).

An ambiguous basename uses the first candidate in sorted order and the
count travels back to the caller, which records the ambiguity in the
build ledger.
"""

from __future__ import annotations

import os
from pathlib import Path

from .media import IMAGE_EXTS, VIDEO_EXTS

_ASSET_EXTS = IMAGE_EXTS | VIDEO_EXTS


class ImplicitImages:
    """Name -> file index over the game directory and (lazily) its .rpa
    archives. ``lookup`` answers the tuple the timeline needs:
    ``(ledger_rel, file_path, source_ref, candidate_count)``."""

    def __init__(self, game_dir: Path, archives=None) -> None:
        self._game_dir = Path(game_dir)
        self._archives = archives  # kinetic_extract.rpa.AssetArchives | None
        # full path-without-ext key -> sorted rel paths (with extensions)
        self._by_key: dict[str, list[str]] | None = None
        # basename-without-ext key -> sorted full keys
        self._by_base: dict[str, list[str]] | None = None

    def _index(self) -> None:
        """One recursive listing of game/ (docs/extracting.md: listings on
        the corpus volume are fine; greps inside files are not)."""
        by_key: dict[str, list[str]] = {}
        by_base: dict[str, list[str]] = {}
        for dirpath, _dirs, files in os.walk(self._game_dir):
            for fname in files:
                ext = os.path.splitext(fname)[1].lstrip(".").lower()
                if ext not in _ASSET_EXTS:
                    continue
                full = os.path.join(dirpath, fname)
                rel = Path(full).relative_to(self._game_dir).as_posix()
                key = str(Path(rel).with_suffix(""))
                by_key.setdefault(key, []).append(rel)
                by_base.setdefault(Path(key).name, []).append(key)
        for rels in by_key.values():
            rels.sort()
        for keys in by_base.values():
            keys.sort()
        self._by_key, self._by_base = by_key, by_base

    @staticmethod
    def _pick(rels: list[str], kind: str) -> str:
        """The kind's own extensions first, then sorted order."""
        want = IMAGE_EXTS if kind == "image" else VIDEO_EXTS
        ranked = sorted(rels, key=lambda r: (
            Path(r).suffix.lower().lstrip(".") not in want, r))
        return ranked[0]

    def lookup(self, name: str, kind: str,
               ) -> tuple[str, Path, dict[str, str], int] | None:
        """Resolve a bare image name (no `image` definition produced a
        file for it). Returns ``(ledger rel ``game/<path>``, on-disk or
        extracted file path, source ref (``{"path": ...}`` or
        ``{"archive": ..., "member": ...}``), candidate count)``, or None
        when no file or archive member answers the name. Candidate count
        > 1 means the name is ambiguous: the first candidate in sorted
        order is used."""
        if self._by_key is None:
            self._index()
        assert self._by_key is not None and self._by_base is not None
        # 1. exact key, 2. path-with-directory key, 3. basename key —
        # an exact hit outranks the scan, the rest is one sorted pick.
        if name in self._by_key:
            keys = [name]
        else:
            keys = self._by_base.get(Path(name).name, [])
        if keys:
            rel = self._pick(self._by_key[keys[0]], kind)
            n = sum(len(self._by_key[k]) for k in keys)
            return (f"game/{rel}", self._game_dir / rel,
                    {"path": f"game/{rel}"}, n)
        if self._archives is not None:
            found = self._archives.candidates(name, kind)
            if found:
                arc, key = found[0]
                ledger, path, ref = self._archives.hit(arc, key)
                return ledger, path, ref, len(found)
        return None
