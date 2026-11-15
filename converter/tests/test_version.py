"""Kinetic's version in the converter (docs/plan.md Phase 51, item 2):
`kinetic-extract --version` and `kinetic-media --version` print `Kinetic
<VERSION>` from the repo's VERSION file and do nothing else, and the
reader of the player version a folder's app.js is stamped with
(kinetic_extract.version), which tools/ use too.

The stamp is app.js's first line, `/*! Kinetic <version> */` (written by
player/scripts/bundle.mjs from player/scripts/version.mjs); an app.js
without it, from a player built before the stamp, reads as unknown
(None).
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from kinetic_extract import cli, media_cli, version
from kinetic_extract.media_tools import MediaToolsError

REPO_ROOT = Path(__file__).resolve().parents[2]
VERSION = (REPO_ROOT / "VERSION").read_text(encoding="utf-8").strip()
LICENSE = (REPO_ROOT / "LICENSE").read_text(encoding="utf-8")
IIFE = '"use strict";\n(() => {\n})();\n'


def test_kinetic_version_is_the_version_file() -> None:
    assert version.VERSION_FILE == REPO_ROOT / "VERSION"
    assert version.kinetic_version() == VERSION
    assert version.version_line() == f"Kinetic {VERSION}"


def test_kinetic_version_follows_an_edit_without_reinstalling(
        tmp_path, monkeypatch) -> None:
    edited = tmp_path / "VERSION"
    edited.write_text("2.0.0\n", encoding="utf-8")
    monkeypatch.setattr(version, "VERSION_FILE", edited)
    assert version.kinetic_version() == "2.0.0"


def test_without_the_version_file_the_package_metadata_answers(
        tmp_path, monkeypatch) -> None:
    # An install made away from the repo: the metadata's PEP 440 spelling
    # (X.Y.Z.devN) is written back as X.Y.Z-dev.
    monkeypatch.setattr(version, "VERSION_FILE", tmp_path / "VERSION")
    assert version.kinetic_version() == VERSION
    monkeypatch.setattr(version.metadata, "version", lambda name: "3.1.0.dev0")
    assert version.kinetic_version() == "3.1.0-dev"


@pytest.mark.parametrize("app_js, expected", [
    (f"/*! Kinetic 1.8.0-dev */\n/*!\n{LICENSE}*/\n{IIFE}", "1.8.0-dev"),
    (f"/*! Kinetic 1.8.0 */\n{IIFE}", "1.8.0"),
    (f"/*! Kinetic 2.0.0-rc.1+build.5 */\n{IIFE}", "2.0.0-rc.1+build.5"),
    # Older players: the license banner alone, or no banner at all.
    (f"/*!\n{LICENSE}*/\n{IIFE}", None),
    (IIFE, None),
    ("", None),
    # Only the first line counts, and only in exactly this form.
    (f"{IIFE}/*! Kinetic 1.8.0 */\n", None),
    ("\n/*! Kinetic 1.8.0 */\n", None),
    ("/* Kinetic 1.8.0 */\n", None),
    ("/*! Kinetic  */\n", None),
    ("/*! Kinetic 1.8.0 */", None),
])
def test_stamped_version(app_js, expected) -> None:
    assert version.stamped_version(app_js) == expected


def test_folder_player_version(tmp_path) -> None:
    stamped = tmp_path / "stamped"
    stamped.mkdir()
    (stamped / "app.js").write_text(
        f"/*! Kinetic 1.8.0-dev */\n/*!\n{LICENSE}*/\n{IIFE}", encoding="utf-8")
    assert version.folder_player_version(stamped) == "1.8.0-dev"
    older = tmp_path / "older"
    older.mkdir()
    (older / "app.js").write_text(f"/*!\n{LICENSE}*/\n{IIFE}", encoding="utf-8")
    assert version.folder_player_version(older) is None
    binary = tmp_path / "binary"
    binary.mkdir()
    (binary / "app.js").write_bytes(b"\xff\xfe\x00")
    assert version.folder_player_version(binary) is None
    assert version.folder_player_version(tmp_path / "missing") is None


def refuse_media_tools() -> None:
    raise MediaToolsError("media tools not set up")


@pytest.mark.parametrize("main, module", [
    (cli.main, cli), (media_cli.main, media_cli)])
def test_cli_version_prints_kinetic_version_and_stops(
        main, module, capsys, monkeypatch) -> None:
    # It answers before the media tools are checked.
    monkeypatch.setattr(module, "ensure_ready", refuse_media_tools)
    with pytest.raises(SystemExit) as stopped:
        main(["--version"])
    assert stopped.value.code == 0
    out, err = capsys.readouterr()
    assert out == f"Kinetic {VERSION}\n"
    assert err == ""


@pytest.mark.parametrize("command", ["kinetic-extract", "kinetic-media"])
def test_installed_commands_print_the_version(command, tmp_path) -> None:
    script = Path(sys.executable).with_name(command)
    if not script.is_file():
        pytest.skip(f"{command} is not installed in this venv")
    proc = subprocess.run([str(script), "--version"], capture_output=True,
                          text=True, cwd=tmp_path, timeout=60)
    assert (proc.returncode, proc.stdout, proc.stderr) == (
        0, f"Kinetic {VERSION}\n", "")
    assert list(tmp_path.iterdir()) == []
