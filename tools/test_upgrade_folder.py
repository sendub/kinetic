"""Tests for tools/upgrade_folder.py (docs/plan.md Phase 51, item 6). Run
with:

    .venv/bin/pytest tools/test_upgrade_folder.py -q

The upgrade replaces a game folder's player (index.html and app.js) with
the one in player/dist, refreshes a present schema copy, runs the
validator and prints `Kinetic <old> -> <new>`. Every folder here is
synthetic; player/dist is a stand-in (the module's DIST moved to a
temporary directory) except in the one test against the real build,
which skips when that build is missing or not of this Kinetic.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import upgrade_folder  # noqa: E402
from kinetic_extract.schema_copy import COPY_NAME, SCHEMA_FILE  # noqa: E402
from kinetic_extract.version import kinetic_version  # noqa: E402

VERSION = kinetic_version()
SHIM_PREFIX = "window.KINETIC_MANIFEST = "
NEW_INDEX = b"<!doctype html>\n<!-- new player -->\n"
OLD_APP = b"// an old player, no stamp\nconsole.log('old');\n"
OLD_INDEX = b"<!doctype html>\n<!-- old player -->\n"


def stamped(version: str, body: str = "// the new player\n") -> bytes:
    return f"/*! Kinetic {version} */\n{body}".encode()


@pytest.fixture
def dist(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A stand-in player/dist built for this Kinetic, with the files the
    upgrade must never copy beside the bundle."""
    folder = tmp_path / "dist"
    folder.mkdir()
    (folder / "index.html").write_bytes(NEW_INDEX)
    (folder / "app.js").write_bytes(stamped(VERSION))
    (folder / "manifest.js").write_bytes(b"window.KINETIC_MANIFEST = null;\n")
    (folder / "app.js.map").write_bytes(b'{"version":3}\n')
    monkeypatch.setattr(upgrade_folder, "DIST", folder)
    return folder


def game(tmp_path: Path, manifest: dict | None = None) -> Path:
    """An old game folder: an unstamped player, a manifest with its shim,
    one picture and a sound file."""
    folder = tmp_path / "my-novel"
    (folder / "media").mkdir(parents=True)
    (folder / "media" / "first.png").write_bytes(b"png stand-in")
    if manifest is None:
        manifest = {"schemaVersion": 1, "storyId": "upgrade-test",
                    "width": 64, "height": 36,
                    "items": [{"id": "first", "type": "image",
                               "file": "media/first.png"}]}
    text = json.dumps(manifest, indent=2)
    (folder / "manifest.json").write_text(text, encoding="utf-8")
    (folder / "manifest.js").write_text(f"{SHIM_PREFIX}{text};\n",
                                        encoding="utf-8")
    (folder / "index.html").write_bytes(OLD_INDEX)
    (folder / "app.js").write_bytes(OLD_APP)
    return folder


def snapshot(folder: Path, skip: set[str] = frozenset()) -> dict[str, bytes]:
    """Every file under folder, relative path -> bytes, minus `skip`."""
    return {p.relative_to(folder).as_posix(): p.read_bytes()
            for p in sorted(folder.rglob("*"))
            if p.is_file() and p.relative_to(folder).as_posix() not in skip}


def run(*args: str) -> int:
    return upgrade_folder.main(["upgrade_folder.py", *args])


PLAYER = {"index.html", "app.js"}


def test_an_old_folder_is_upgraded_and_its_content_left_alone(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    content = snapshot(folder, PLAYER)
    assert run(str(folder)) == 0
    assert (folder / "index.html").read_bytes() == NEW_INDEX
    assert (folder / "app.js").read_bytes() == stamped(VERSION)
    # manifest.js, manifest.json and media byte for byte.
    assert snapshot(folder, PLAYER) == content
    # Never manifest.js or the source map from dist.
    assert not (folder / "app.js.map").exists()
    out = capsys.readouterr()
    assert out.out.splitlines()[0] == f"Kinetic unknown -> {VERSION}"
    assert out.err == ""


def test_a_folder_already_current_is_copied_and_says_so(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    (folder / "app.js").write_bytes(stamped(VERSION, "// older build\n"))
    assert run(str(folder)) == 0
    assert (folder / "app.js").read_bytes() == stamped(VERSION)
    assert capsys.readouterr().out.splitlines()[0] == (
        f"Kinetic {VERSION} -> {VERSION} (already current)")


def test_a_stamped_older_player_names_its_version(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    (folder / "app.js").write_bytes(stamped("1.7.9"))
    assert run(str(folder)) == 0
    assert capsys.readouterr().out.splitlines()[0] == (
        f"Kinetic 1.7.9 -> {VERSION}")


def test_a_stale_source_map_in_the_folder_is_left(
        tmp_path: Path, dist: Path) -> None:
    folder = game(tmp_path)
    (folder / "app.js.map").write_bytes(b"old map")
    assert run(str(folder)) == 0
    assert (folder / "app.js.map").read_bytes() == b"old map"


def test_no_manifest_json_is_refused(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    (folder / "manifest.json").unlink()
    before = snapshot(folder)
    assert run(str(folder)) == 1
    assert snapshot(folder) == before
    assert "manifest.json" in capsys.readouterr().err


@pytest.mark.parametrize("name", ["index.html", "app.js"])
def test_a_missing_dist_file_is_refused(
        tmp_path: Path, dist: Path, name: str,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    (dist / name).unlink()
    before = snapshot(folder)
    assert run(str(folder)) == 1
    assert snapshot(folder) == before
    err = capsys.readouterr().err
    assert f"player/dist/{name}" in err and "npm run build" in err


@pytest.mark.parametrize("app_js", [stamped("0.0.1"),
                                    b"// built before the stamp\n"])
def test_a_dist_not_of_this_kinetic_is_refused(
        tmp_path: Path, dist: Path, app_js: bytes,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    (dist / "app.js").write_bytes(app_js)
    before = snapshot(folder)
    assert run(str(folder)) == 1
    assert snapshot(folder) == before
    err = capsys.readouterr().err
    assert VERSION in err and "npm run build" in err and "player/" in err


def test_a_path_that_is_not_a_directory_is_exit_2(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    assert run(str(tmp_path / "missing")) == 2
    file = tmp_path / "file.txt"
    file.write_text("x")
    assert run(str(file)) == 2
    assert "not a directory" in capsys.readouterr().err


def test_bad_arguments_are_exit_2(tmp_path: Path, dist: Path) -> None:
    with pytest.raises(SystemExit) as no_folder:
        run()
    assert no_folder.value.code == 2
    with pytest.raises(SystemExit) as unknown:
        run(str(game(tmp_path)), "--force")
    assert unknown.value.code == 2


def test_a_present_schema_copy_is_refreshed(
        tmp_path: Path, dist: Path) -> None:
    folder = game(tmp_path)
    (folder / COPY_NAME).write_text('{"old": "schema"}\n')
    assert run(str(folder)) == 0
    assert (folder / COPY_NAME).read_bytes() == SCHEMA_FILE.read_bytes()


def test_no_schema_copy_is_added(tmp_path: Path, dist: Path) -> None:
    folder = game(tmp_path)
    assert run(str(folder)) == 0
    assert not (folder / COPY_NAME).exists()


def test_validator_problems_give_exit_1_with_the_files_upgraded(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path, {
        "schemaVersion": 1, "width": 64, "height": 36,
        "items": [{"id": "first", "type": "image",
                   "file": "media/missing.png"}]})
    assert run(str(folder)) == 1
    assert (folder / "index.html").read_bytes() == NEW_INDEX
    assert (folder / "app.js").read_bytes() == stamped(VERSION)
    out = capsys.readouterr()
    # The validator's own problem line, on stdout as its CLI prints it.
    assert "manifest.json: items[0].file" in out.out
    assert "media/missing.png" in out.out
    assert "upgraded" in out.err and "problem" in out.err


def test_validator_warnings_alone_still_exit_0(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path, {
        "schemaVersion": 1, "width": 64, "height": 36,
        "items": [{"id": "first", "type": "image",
                   "file": "media/first.png"}],
        "audio": {"tracks": {"unused": {"file": "media/rain.m4a",
                                        "durationSeconds": 1.0}}}})
    from kinetic_extract import audio_format
    sound = b"sound stand-in"
    (folder / "media" / "rain.m4a").write_bytes(sound)
    (folder / "media" / "rain.m4a.js").write_bytes(
        audio_format.script_bytes("media/rain.m4a", sound))
    assert run(str(folder)) == 0
    assert "warning: " in capsys.readouterr().err


def test_apps_in_the_folder_are_untouched(
        tmp_path: Path, dist: Path) -> None:
    folder = game(tmp_path)
    resources = folder / "My Novel.app" / "Contents" / "Resources"
    resources.mkdir(parents=True)
    (resources / "LICENSE").write_text("license text")
    (folder / "My Novel.app" / "Contents" / "Info.plist").write_text("plist")
    (folder / "My Novel.exe").write_bytes(b"MZ stand-in")
    apps = {k: v for k, v in snapshot(folder).items()
            if k.startswith("My Novel.")}
    assert run(str(folder)) == 0
    assert {k: v for k, v in snapshot(folder).items()
            if k.startswith("My Novel.")} == apps


def test_no_temporary_file_is_left_behind(
        tmp_path: Path, dist: Path) -> None:
    folder = game(tmp_path)
    (folder / COPY_NAME).write_text("{}")
    before = sorted(p.name for p in folder.iterdir())
    assert run(str(folder)) == 0
    assert sorted(p.name for p in folder.iterdir()) == before


def test_a_failed_write_leaves_the_old_player_and_no_temporary_file(
        tmp_path: Path, dist: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    before = snapshot(folder)

    def full_disk(*_args: object, **_kwargs: object) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(upgrade_folder.shutil, "copyfileobj", full_disk)
    assert run(str(folder)) == 1
    assert snapshot(folder) == before
    assert "No space left on device" in capsys.readouterr().err


def test_the_upgraded_files_keep_the_old_files_permissions(
        tmp_path: Path, dist: Path) -> None:
    folder = game(tmp_path)
    (folder / "app.js").chmod(0o644)
    (folder / "index.html").chmod(0o640)
    assert run(str(folder)) == 0
    assert (folder / "app.js").stat().st_mode & 0o777 == 0o644
    assert (folder / "index.html").stat().st_mode & 0o777 == 0o640


def test_version_prints_kinetic_version(tmp_path: Path) -> None:
    proc = subprocess.run(
        [sys.executable, str(TOOLS_DIR / "upgrade_folder.py"), "--version"],
        capture_output=True, text=True, cwd=tmp_path, timeout=60,
        env={k: v for k, v in os.environ.items()
             if k != "KINETIC_MEDIA_TOOLS_DIR"})
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == f"Kinetic {VERSION}\n"
    assert list(tmp_path.iterdir()) == []


REAL_DIST = REPO_ROOT / "player" / "dist"


@pytest.mark.skipif(
    upgrade_folder.folder_player_version(REAL_DIST) != VERSION
    or not (REAL_DIST / "index.html").is_file(),
    reason="player/dist is missing or not built for this Kinetic "
           "(npm run build in player/)")
def test_the_real_build_upgrades_a_folder(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    content = snapshot(folder, PLAYER)
    assert run(str(folder)) == 0
    for name in PLAYER:
        assert (folder / name).read_bytes() == (REAL_DIST / name).read_bytes()
    assert snapshot(folder, PLAYER) == content
    assert upgrade_folder.folder_player_version(folder) == VERSION
    assert capsys.readouterr().out.splitlines()[0] == (
        f"Kinetic unknown -> {VERSION}")
