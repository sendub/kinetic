"""Manifest `title` derivation and the `--title` / `--story-id` overrides
(docs/plan.md Phase 21, Game name on the Esc screen).

The title comes from `--title`, else the Ren'Py project's `config.name`
string, else the project folder name made readable (`.app` dropped, a
`game/` input's parent, `_`/`-` runs as spaces). `--story-id` replaces the
derived story id and must already be a slug.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kinetic_extract.cli import folder_title
from kinetic_extract.cli import main as cli_main

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


def manifest_of(project: Path, out: Path, *extra: str) -> dict:
    assert cli_main([str(project), str(out), *extra]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    shim = (out / "manifest.js").read_text("utf-8")
    assert json.loads(shim[len("window.KINETIC_MANIFEST = "):-2]) == manifest
    return manifest


def test_config_name_is_the_title(tmp_path: Path) -> None:
    project = make_project(tmp_path / "Some_Folder", (
        'define config.name = _("The Lantern at Low Tide")\n'
        'define config.save_directory = "LanternTide-1712345678"\n'))
    manifest = manifest_of(project, tmp_path / "out")
    assert manifest["title"] == "The Lantern at Low Tide"
    # The save directory still names the story; the title is the name.
    assert manifest["storyId"] == "lanterntide-1712345678"


def test_title_keeps_punctuation_and_unescapes_quotes(tmp_path: Path) -> None:
    project = make_project(tmp_path / "Folder", (
        "define config.name = _('game-d College: Part \\'Two\\'!')\n"))
    assert manifest_of(project, tmp_path / "out")["title"] == \
        "game-d College: Part 'Two'!"


def test_title_follows_story_id_in_key_order(tmp_path: Path) -> None:
    project = make_project(tmp_path / "Folder",
                           'define config.name = "Dawn"\n')
    keys = list(manifest_of(project, tmp_path / "out"))
    assert keys[:4] == ["schemaVersion", "storyId", "title", "width"]


def test_folder_name_when_no_config_name(tmp_path: Path) -> None:
    project = make_project(tmp_path / "My_Game-1.0-pc",
                           "define config.name = None\n")
    assert manifest_of(project, tmp_path / "out")["title"] == \
        "My Game 1.0 pc"


def test_folder_title_of_game_dir_input_and_app_bundle(
        tmp_path: Path) -> None:
    project = make_project(tmp_path / "Dawn Song", None)
    assert manifest_of(project / "game", tmp_path / "o1")["title"] == \
        "Dawn Song"
    bundle = tmp_path / "Dusk.app"
    make_project(bundle / "Contents" / "Resources" / "autorun", None)
    assert manifest_of(bundle, tmp_path / "o2")["title"] == "Dusk"


def test_slice_still_reads_the_name(tmp_path: Path) -> None:
    project = make_project(tmp_path / "Folder",
                           'define config.name = "Sliced Tale"\n')
    assert manifest_of(project, tmp_path / "out",
                       "--files", "script.rpy")["title"] == "Sliced Tale"


def test_demo_fixture_title_is_its_folder(tmp_path: Path) -> None:
    assert manifest_of(FIXTURE, tmp_path / "out")["title"] == "renpy demo"


def test_title_option_overrides(tmp_path: Path,
                                capsys: pytest.CaptureFixture[str]) -> None:
    project = make_project(tmp_path / "Folder",
                           'define config.name = "Old Name"\n')
    manifest = manifest_of(project, tmp_path / "out",
                           "--title", "  Rainy Day <b>1</b>  ")
    assert manifest["title"] == "Rainy Day <b>1</b>"
    assert manifest["storyId"] == "old-name"  # the id is not the title's
    out = capsys.readouterr().out
    assert "title: Rainy Day <b>1</b> (from --title)" in out


def test_summary_prints_derived_title(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    project = make_project(tmp_path / "Folder",
                           'define config.name = "Dawn"\n')
    manifest_of(project, tmp_path / "out")
    assert "title: Dawn (from config.name)" in capsys.readouterr().out


@pytest.mark.parametrize("bad", ["", "   ", "x" * 201])
def test_bad_title_option_is_an_error(
        tmp_path: Path, bad: str, capsys: pytest.CaptureFixture[str]) -> None:
    project = make_project(tmp_path / "Folder", None)
    with pytest.raises(SystemExit) as exc:
        cli_main([str(project), str(tmp_path / "out"), f"--title={bad}"])
    assert exc.value.code == 2
    assert "--title" in capsys.readouterr().err
    assert not (tmp_path / "out" / "manifest.json").exists()


def test_story_id_option_overrides(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    project = make_project(tmp_path / "Folder", (
        'define config.save_directory = "Derived-1"\n'))
    manifest = manifest_of(project, tmp_path / "out",
                           "--story-id", "rainy-day-1")
    assert manifest["storyId"] == "rainy-day-1"
    assert "story id: rainy-day-1 (from --story-id)" in capsys.readouterr().out


@pytest.mark.parametrize("bad", ["Rainy", "two words", "-lead", "", "a" * 65])
def test_bad_story_id_option_is_an_error(
        tmp_path: Path, bad: str, capsys: pytest.CaptureFixture[str]) -> None:
    project = make_project(tmp_path / "Folder", None)
    with pytest.raises(SystemExit) as exc:
        cli_main([str(project), str(tmp_path / "out"), f"--story-id={bad}"])
    assert exc.value.code == 2
    err = capsys.readouterr().err
    assert "--story-id" in err and "[a-z0-9][a-z0-9_-]{0,63}" in err
    assert not (tmp_path / "out" / "manifest.json").exists()


@pytest.mark.parametrize(("raw", "expected"), [
    ("renpy_demo", "renpy demo"),
    ("My_Game-1.0-pc", "My Game 1.0 pc"),
    ("  Spaced  Out  ", "Spaced Out"),
    ("__", ""),
])
def test_folder_title_rule(raw: str, expected: str) -> None:
    assert folder_title(raw) == expected
