"""The disk cache of generated lines and the store of reference clips."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

FORMATS = ("wav", "flac", "mp3")


def line_key(identity: dict, voice_id: str, text: str, lang: str) -> str:
    """sha256 of everything that decides a generated line's audio."""
    blob = json.dumps({"engine": identity, "voice": voice_id, "text": text,
                       "lang": lang}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


class LineCache:
    """``cache/lines/<k[:2]>/<k>.json``: the WAV's length beside it."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder

    def _path(self, key: str, suffix: str) -> Path:
        return self.folder / key[:2] / (key + suffix)

    def get(self, key: str) -> tuple[bytes, float] | None:
        try:
            wav = self._path(key, ".wav").read_bytes()
            meta = json.loads(self._path(key, ".json").read_text())
        except (OSError, ValueError):
            return None
        return wav, meta["seconds"]

    def put(self, key: str, wav: bytes, seconds: float) -> None:
        write_atomic(self._path(key, ".wav"), wav)
        write_atomic(self._path(key, ".json"),
                     json.dumps({"seconds": seconds}).encode())


class VoiceStore:
    """``cache/voices/<sha256>.<format>``: each reference clip once, so a
    voice registered in an earlier run still speaks after a restart."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder

    def add(self, data: bytes, fmt: str) -> tuple[str, Path]:
        voice_id = hashlib.sha256(data).hexdigest()
        path = self.folder / f"{voice_id}.{fmt}"
        if not path.exists():
            write_atomic(path, data)
        return voice_id, path

    def find(self, voice_id: str) -> Path | None:
        if len(voice_id) != 64 or not all(c in "0123456789abcdef"
                                          for c in voice_id):
            return None
        for fmt in FORMATS:
            path = self.folder / f"{voice_id}.{fmt}"
            if path.exists():
                return path
        return None
