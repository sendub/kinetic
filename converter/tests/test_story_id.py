"""Manifest `storyId` derivation (docs/plan.md Phase 21, Story ID).

The id comes from the Ren'Py project: `config.save_directory` first (the
game's own per-game save id), else `config.name`, else the project folder
name, slugified to lowercase ASCII letters, digits, `-` and `_`.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kinetic_extract.cli import main as cli_main
from kinetic_extract.cli import story_slug

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "fixtures" / "renpy_demo"
SCRIPT = 'label start:\n    "Hello."\n    return\n'


def make_project(root: Path, options: str | None) -> Path:
    game = root / "game"
    game.mkdir(parents=True)
    (game / "script.rpy").write_text(SCRIPT, encoding="utf-8")
    if options is not None:
        (game / "options.rpy").write_text(options, encoding="utf-8")
    return root


def story_id_of(project: Path, out: Path, *extra: str) -> str:
    assert cli_main([str(project), str(out), *extra]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    shim = (out / "manifest.js").read_text("utf-8")
    assert json.loads(shim[len("window.KINETIC_MANIFEST = "):-2]) == manifest
    return manifest["storyId"]


def test_save_directory_wins_over_name_and_folder(tmp_path: Path) -> None:
    project = make_project(tmp_path / "Some Folder", (
        'define config.name = _("The Lantern at Low Tide")\n'
        'define config.save_directory = "LanternTide-1712345678"\n'))
    assert story_id_of(project, tmp_path / "out") == \
        "lanterntide-1712345678"


def test_old_style_python_save_directory_is_read(tmp_path: Path) -> None:
    """Older Ren'Py templates set it inside an `init python` block."""
    project = make_project(tmp_path / "Folder", (
        "init -1 python hide:\n"
        "    config.save_directory = \"OldGame-1300000000\"\n"))
    assert story_id_of(project, tmp_path / "out") == "oldgame-1300000000"


def test_name_when_no_save_directory(tmp_path: Path) -> None:
    project = make_project(tmp_path / "Folder", (
        'define config.name = _("PAPER Lanes: Part Two!")\n'
        "define config.save_directory = None\n"))
    assert story_id_of(project, tmp_path / "out") == "paper-lanes-part-two"


def test_folder_name_when_no_config(tmp_path: Path) -> None:
    project = make_project(tmp_path / "My Game-1.0-pc", None)
    assert story_id_of(project, tmp_path / "out") == "my-game-1-0-pc"


def test_folder_name_of_a_game_dir_input_and_app_bundle(
        tmp_path: Path) -> None:
    project = make_project(tmp_path / "Dawn", None)
    assert story_id_of(project / "game", tmp_path / "out1") == "dawn"
    bundle = tmp_path / "Dusk.app"
    make_project(bundle / "Contents" / "Resources" / "autorun", None)
    assert story_id_of(bundle, tmp_path / "out2") == "dusk"


def test_slice_still_reads_options(tmp_path: Path) -> None:
    """`--files` narrows the walk, not the story's identity."""
    project = make_project(tmp_path / "Folder",
                           'define config.save_directory = "Sliced-1"\n')
    assert story_id_of(project, tmp_path / "out",
                       "--files", "script.rpy") == "sliced-1"


def test_demo_fixture_falls_back_to_its_folder(tmp_path: Path) -> None:
    assert story_id_of(FIXTURE, tmp_path / "out") == "renpy_demo"


@pytest.mark.parametrize(("raw", "expected"), [
    ("GameName-1234567890", "gamename-1234567890"),
    ("The Lantern at Low Tide", "the-lantern-at-low-tide"),
    ("  --Café_Ending__  ", "cafe_ending"),
    ("a" * 80, "a" * 64),
])
def test_slug_rule(raw: str, expected: str) -> None:
    assert story_slug(raw) == expected


def test_slug_of_non_latin_text_is_a_stable_hash() -> None:
    first = story_slug("夏の終わり")
    assert first == story_slug("夏の終わり")
    assert first != story_slug("冬の始まり")
    assert first.startswith("story-") and len(first) == len("story-") + 12
    assert story_slug("") == ""
