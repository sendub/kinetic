"""Tests for tools/assemble_folder.py's audio scripts (docs/plan.md Phase 47,
item 17). Run with:

    .venv/bin/pytest tools/test_assemble_folder.py -q

A hand-written folder's tracks name audio files; the player reads each
from the script beside it (docs/content-format.md, Audio). assemble_folder
writes the script of every track file that has none and leaves an
existing one alone. The app flags are tested in tools/test_build_apps.py.
"""

from __future__ import annotations

import base64
import json
import re
import sys
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import assemble_folder  # noqa: E402

SCRIPT = re.compile(rb'__kineticAudio\("([^"\\]*)","([A-Za-z0-9+/]*={0,2})"'
                    rb'\);\n')


@pytest.fixture
def fake_dist(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A repo root whose player/dist holds a stand-in bundle."""
    root = tmp_path / "repo"
    dist = root / "player" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html>\n")
    (dist / "app.js").write_text("// bundle\n")
    monkeypatch.setattr(assemble_folder, "REPO_ROOT", root)
    return root


def content(tmp_path: Path, tracks: dict[str, str] | None) -> Path:
    """A content folder; `tracks` maps track id -> file, each file holding
    bytes of its own (two ids may share one file)."""
    folder = tmp_path / "content"
    folder.mkdir()
    (folder / "first.png").write_bytes(b"png stand-in")
    manifest: dict = {"schemaVersion": 1, "width": 64, "height": 36,
                      "items": [{"id": "first", "type": "image",
                                 "file": "first.png"}]}
    if tracks is not None:
        for file in tracks.values():
            (folder / file).parent.mkdir(parents=True, exist_ok=True)
            (folder / file).write_bytes(f"sound of {file}".encode())
        manifest["audio"] = {"tracks": {
            track_id: {"file": file, "durationSeconds": 1.0}
            for track_id, file in tracks.items()}}
    (folder / "manifest.json").write_text(json.dumps(manifest),
                                          encoding="utf-8")
    return folder


def held(folder: Path, file: str) -> bytes:
    found = SCRIPT.fullmatch((folder / f"{file}.js").read_bytes())
    assert found is not None and found.group(1).decode() == file
    return base64.b64decode(found.group(2), validate=True)


def assemble(folder: Path, out: Path) -> None:
    assemble_folder.main(["assemble_folder.py", str(folder), str(out)])


def test_a_script_is_written_for_each_track_file(
        tmp_path: Path, fake_dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = content(tmp_path, {"rain": "rain.webm", "theme": "media/a.m4a",
                                "theme-2": "media/a.m4a"})
    out = tmp_path / "play"
    assemble(folder, out)
    for file in ("rain.webm", "media/a.m4a"):
        assert held(out, file) == (folder / file).read_bytes()
    assert sorted(p.name for p in out.rglob("*.js")) == [
        "a.m4a.js", "app.js", "manifest.js", "rain.webm.js"]
    assert "wrote 2 audio scripts" in capsys.readouterr().out
    assert not (folder / "rain.webm.js").exists()


def test_an_existing_script_is_left_as_it_is(
        tmp_path: Path, fake_dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = content(tmp_path, {"rain": "rain.webm", "door": "door.mp3"})
    (folder / "rain.webm.js").write_bytes(b"kept as it is\n")
    out = tmp_path / "play"
    assemble(folder, out)
    assert (out / "rain.webm.js").read_bytes() == b"kept as it is\n"
    assert held(out, "door.mp3") == b"sound of door.mp3"
    assert "wrote 1 audio script" in capsys.readouterr().out


def test_a_missing_track_file_gets_no_script(
        tmp_path: Path, fake_dist: Path) -> None:
    folder = content(tmp_path, {"rain": "rain.webm"})
    (folder / "rain.webm").unlink()
    out = tmp_path / "play"
    assemble(folder, out)
    assert not (out / "rain.webm.js").exists()


def test_a_folder_without_sound_gets_no_script(
        tmp_path: Path, fake_dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "play"
    assemble(content(tmp_path, None), out)
    assert sorted(p.name for p in out.rglob("*.js")) == ["app.js",
                                                         "manifest.js"]
    assert "audio script" not in capsys.readouterr().out
