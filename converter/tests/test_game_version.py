"""Manifest `version`, the game's own release (docs/plan.md Phase 51,
item 3), and the `--game-version` override.

kinetic-extract fills `version` from the Ren'Py project's
`config.version` when that is a string literal (plain or `_()`-wrapped,
escaped quotes undone, trimmed, cut to 40 characters), as it fills
`title` from `config.name`. Anything else (an expression, a variable,
`None`, a blank string, no setting) gives no field; there is no
fallback. `--game-version TEXT` sets it instead.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

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


def version_of(tmp_path: Path, options: str | None, *extra: str) -> object:
    project = make_project(tmp_path / "Folder", options)
    return manifest_of(project, tmp_path / "out", *extra).get(
        "version", "(absent)")


@pytest.mark.parametrize(("options", "expected"), [
    # Ren'Py's default template line.
    ('define config.version = "1.0"\n', "1.0"),
    ('define config.version = _("0.9 beta")\n', "0.9 beta"),
    ("define config.version = 'Episode 3'\n", "Episode 3"),
    ("define config.version = _( 'Episode 3' )\n", "Episode 3"),
    ('define config.version = "Part \\"Two\\""\n', 'Part "Two"'),
    ("define config.version = 'It\\'s 2'\n", "It's 2"),
    ('define config.version = "  1.2  "  # the release\n', "1.2"),
    # The older form, inside an `init python` block.
    ('init python:\n    config.version = "0.3"\n', "0.3"),
])
def test_config_version_literal_is_the_version(
        tmp_path: Path, options: str, expected: str) -> None:
    assert version_of(tmp_path, options) == expected


@pytest.mark.parametrize("options", [
    None,
    'define config.name = "Dawn"\n',
    "define config.version = build_number\n",
    'define config.version = "1." + str(build)\n',
    'define config.version = _("1.") + suffix\n',
    "define config.version = None\n",
    'define config.version = ""\n',
    'define config.version = "   "\n',
])
def test_anything_else_gives_no_version(
        tmp_path: Path, options: str | None) -> None:
    assert version_of(tmp_path, options) == "(absent)"


def test_long_version_is_cut_to_40(tmp_path: Path) -> None:
    text = "1.0 " + "x" * 35 + " z"   # 41 characters
    assert len(text) == 41
    got = version_of(tmp_path, f'define config.version = "{text}"\n')
    assert got == "1.0 " + "x" * 35   # cut to 40, then the space trimmed
    exact = "v" * 40
    assert version_of(tmp_path / "b",
                      f'define config.version = "{exact}"\n') == exact


def test_version_follows_title_in_key_order(tmp_path: Path) -> None:
    project = make_project(tmp_path / "Folder", (
        'define config.name = "Dawn"\n'
        'define config.version = "1.2"\n'))
    keys = list(manifest_of(project, tmp_path / "out"))
    assert keys[:5] == ["schemaVersion", "storyId", "title", "version",
                        "width"]


def test_slice_still_reads_the_version(tmp_path: Path) -> None:
    """`--files` narrows the walk, not the game's release."""
    options = ('define config.save_directory = "Sliced-1"\n'
               'define config.name = "Sliced Tale"\n'
               'define config.version = "2.1"\n')
    assert version_of(tmp_path, options, "--files", "script.rpy") == "2.1"


def test_demo_fixture_has_no_version(tmp_path: Path) -> None:
    assert "version" not in manifest_of(FIXTURE, tmp_path / "out")


def test_summary_prints_the_version(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    version_of(tmp_path, 'define config.version = "1.2"\n')
    assert "game version: 1.2 (from config.version)" in \
        capsys.readouterr().out
    version_of(tmp_path / "b", None)
    assert "game version: (none)" in capsys.readouterr().out


def test_game_version_option_overrides(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    got = version_of(tmp_path, 'define config.version = "1.0"\n',
                     "--game-version", "  Episode 3 <b>final</b>  ")
    assert got == "Episode 3 <b>final</b>"
    assert "game version: Episode 3 <b>final</b> (from --game-version)" in \
        capsys.readouterr().out
    assert version_of(tmp_path / "b", None,
                      f"--game-version={'v' * 40}") == "v" * 40


@pytest.mark.parametrize("bad", ["", "   ", "x" * 41])
def test_bad_game_version_option_is_an_error(
        tmp_path: Path, bad: str, capsys: pytest.CaptureFixture[str]) -> None:
    project = make_project(tmp_path / "Folder", None)
    with pytest.raises(SystemExit) as exc:
        cli_main([str(project), str(tmp_path / "out"),
                  f"--game-version={bad}"])
    assert exc.value.code == 2
    assert "--game-version" in capsys.readouterr().err
    assert not (tmp_path / "out" / "manifest.json").exists()


def test_tool_version_flag_is_unchanged(
        capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        cli_main(["--version"])
    assert exc.value.code == 0
    assert capsys.readouterr().out.startswith("Kinetic ")


def test_several_projects_take_the_first_ones_version(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    ep1 = make_project(tmp_path / "Ep1", 'define config.version = "1.0"\n')
    ep2 = make_project(tmp_path / "Ep2", 'define config.version = "2.0"\n')
    out = tmp_path / "out"
    assert cli_main([str(ep1), str(ep2), str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    assert manifest["version"] == "1.0"
    assert ("game version: 1.0 (from config.version of the first project)"
            in capsys.readouterr().out)
