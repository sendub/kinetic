"""Tests for tools/assemble_folder.py's audio scripts (docs/plan.md Phase 47,
items 17 and 19). Run with:

    .venv/bin/pytest tools/test_assemble_folder.py -q

A hand-written folder's tracks name audio files; the player reads each
from the script beside it (docs/content-format.md, Audio). assemble_folder
writes the script of every track file that has none, leaves an existing
one alone, and ships the scripts without the audio files. The app flags
are tested in tools/test_build_apps.py.
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


def test_the_audio_files_are_left_out_their_scripts_ship(
        tmp_path: Path, fake_dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = content(tmp_path, {"rain": "rain.webm", "theme": "media/a.m4a",
                                "theme-2": "media/a.m4a", "door": "door.mp3"})
    # One script already there, as kinetic-extract writes them.
    (folder / "door.mp3.js").write_bytes(
        assemble_folder.audio_format.script_bytes(
            "door.mp3", (folder / "door.mp3").read_bytes()))
    out = tmp_path / "play"
    assemble(folder, out)
    for file in ("rain.webm", "media/a.m4a", "door.mp3"):
        assert not (out / file).exists()
        assert held(out, file) == (folder / file).read_bytes()
    assert "left out 3 audio files" in capsys.readouterr().out
    # The content folder keeps both.
    assert (folder / "rain.webm").exists() and (folder / "door.mp3").exists()
    import validate_content
    assert validate_content.validate_folder(out) == []


def test_voice_clips_ship_as_their_scripts_as_tracks_do(
        tmp_path: Path, fake_dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    """A voice's reference clip (docs/content-format.md, Voices) is read
    from its script like a track file: written when missing, the clip
    left out, a clip shared with a track handled once."""
    folder = content(tmp_path, {"line": "voices/mei.flac"})
    manifest = json.loads((folder / "manifest.json").read_text())
    for file in ("theo.wav", "narrator.m4a"):
        (folder / file).write_bytes(f"sound of {file}".encode())
    manifest["voices"] = {"Mei": {"file": "voices/mei.flac"},
                          "Theo": {"file": "theo.wav"}}
    manifest["narrator"] = {"file": "narrator.m4a"}
    (folder / "manifest.json").write_text(json.dumps(manifest))
    out = tmp_path / "play"
    assemble(folder, out)
    for file in ("voices/mei.flac", "theo.wav", "narrator.m4a"):
        assert not (out / file).exists()
        assert held(out, file) == (folder / file).read_bytes()
    printed = capsys.readouterr().out
    assert "wrote 3 audio scripts" in printed
    assert "left out 3 audio files" in printed
    import validate_content
    assert validate_content.validate_folder(out) == []


def test_an_audio_file_an_item_shows_stays(
        tmp_path: Path, fake_dist: Path) -> None:
    folder = content(tmp_path, {"clip": "clip.webm"})
    manifest = json.loads((folder / "manifest.json").read_text())
    manifest["items"].append({"id": "clip", "type": "video",
                              "file": "clip.webm", "poster": "first.png",
                              "durationSeconds": 1.0})
    (folder / "manifest.json").write_text(json.dumps(manifest))
    out = tmp_path / "play"
    assemble(folder, out)
    assert (out / "clip.webm").read_bytes() == b"sound of clip.webm"
    assert held(out, "clip.webm") == b"sound of clip.webm"


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


def test_a_script_shipped_alone_is_kept(
        tmp_path: Path, fake_dist: Path) -> None:
    folder = content(tmp_path, {"rain": "rain.webm"})
    (folder / "rain.webm.js").write_bytes(
        assemble_folder.audio_format.script_bytes("rain.webm", b"bytes"))
    (folder / "rain.webm").unlink()
    out = tmp_path / "play"
    assemble(folder, out)
    assert held(out, "rain.webm") == b"bytes"
    assert not (out / "rain.webm").exists()


def test_the_schema_copy_is_left_out_the_manifest_kept(
        tmp_path: Path, fake_dist: Path) -> None:
    """kinetic-extract's manifest.schema.json is for an author's editor,
    not for readers (docs/plan.md Phase 51 item 5): the assembled folder
    has none, and manifest.json and manifest.js are copied as written,
    their `$schema` key with them."""
    folder = content(tmp_path, None)
    manifest = {"$schema": "./manifest.schema.json",
                **json.loads((folder / "manifest.json").read_text())}
    text = json.dumps(manifest, indent=2) + "\n"
    (folder / "manifest.json").write_text(text, encoding="utf-8")
    shim = f"window.KINETIC_MANIFEST = {json.dumps(manifest)};\n"
    (folder / "manifest.js").write_text(shim, encoding="utf-8")
    (folder / "manifest.schema.json").write_text('{"title": "copy"}\n')
    # A file of that name below the top is the author's own: it stays.
    (folder / "notes").mkdir()
    (folder / "notes" / "manifest.schema.json").write_text("{}\n")
    out = tmp_path / "play"
    assemble(folder, out)
    assert not (out / "manifest.schema.json").exists()
    assert (out / "notes" / "manifest.schema.json").exists()
    assert (out / "manifest.json").read_text(encoding="utf-8") == text
    assert (out / "manifest.js").read_text(encoding="utf-8") == shim
    assert (folder / "manifest.schema.json").exists()
    import validate_content
    assert validate_content.validate_folder(out) == []


def test_the_language_schema_copy_is_left_out(
        tmp_path: Path, fake_dist: Path) -> None:
    """lang.schema.json, the language files' copy for an author's editor
    (docs/plan.md Phase 54 item 8), is left out as the manifest's is."""
    folder = content(tmp_path, None)
    (folder / "lang.schema.json").write_text('{"title": "copy"}\n')
    out = tmp_path / "play"
    assemble(folder, out)
    assert not (out / "lang.schema.json").exists()
    assert (folder / "lang.schema.json").exists()


def test_the_schema_copy_is_left_out_of_a_generated_shim_folder(
        tmp_path: Path, fake_dist: Path) -> None:
    folder = content(tmp_path, None)
    (folder / "manifest.schema.json").write_text('{"title": "copy"}\n')
    out = tmp_path / "play"
    assemble(folder, out)
    assert sorted(p.name for p in out.iterdir()) == [
        "app.js", "first.png", "index.html", "manifest.js", "manifest.json"]


def test_a_folder_without_sound_gets_no_script(
        tmp_path: Path, fake_dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "play"
    assemble(content(tmp_path, None), out)
    assert sorted(p.name for p in out.rglob("*.js")) == ["app.js",
                                                         "manifest.js"]
    assert "audio script" not in capsys.readouterr().out
