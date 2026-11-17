"""The `kinetic` command's subcommands (docs/plan.md Phase 57, item 9):
each is reachable, answers `--help`, and a wrapped tool gets its
arguments unparsed and gives its exit code. The installed wheel runs the
same in tools/test_build_wheel.py."""

from __future__ import annotations

from pathlib import Path

import pytest

from kinetic_extract import (assemble_folder, kinetic_cli, setup_media_tools,
                             upgrade_folder, validate_content)

REPO_ROOT = Path(__file__).resolve().parents[2]
VERSION = (REPO_ROOT / "VERSION").read_text(encoding="utf-8").strip()
# In `kinetic --help` order, each with its --help's usage line start.
SUBCOMMANDS = {
    "setup": "usage: kinetic setup",
    "extract": "usage: kinetic-extract",
    "media": "usage: kinetic media",
    "validate": "usage: kinetic validate",
    "assemble": "usage: kinetic assemble",
    "upgrade": "usage: kinetic upgrade",
    "check": "usage: kinetic check",
    "report": "usage: kinetic report",
    "routes": "usage: kinetic routes",
    "export": "usage: kinetic export",
}


def help_of(argv: list[str], capsys) -> tuple[int, str]:
    """Exit code and stdout of `kinetic ARGV` (argparse's help exits)."""
    try:
        code = kinetic_cli.main(argv)
    except SystemExit as stopped:
        code = stopped.code
    return code, capsys.readouterr().out


def test_kinetic_help_lists_every_subcommand_in_order(capsys) -> None:
    code, out = help_of(["--help"], capsys)
    assert code == 0
    listed = [line.split()[0] for line in out.splitlines()
              if line.startswith("    ") and not line.startswith("     ")]
    assert listed == list(SUBCOMMANDS)


@pytest.mark.parametrize(("name", "usage"), SUBCOMMANDS.items())
def test_each_subcommand_answers_help(name, usage, capsys) -> None:
    code, out = help_of([name, "--help"], capsys)
    assert code == 0
    assert out.startswith(usage), out[:200]


def test_version(capsys) -> None:
    assert help_of(["--version"], capsys) == (0, f"Kinetic {VERSION}\n")


@pytest.mark.parametrize("name", ["setup", "validate", "assemble",
                                  "upgrade", "check"])
def test_a_wrapped_tools_version_is_kinetics(name, capsys) -> None:
    assert help_of([name, "--version"], capsys) == (0, f"Kinetic {VERSION}\n")


def test_an_unknown_subcommand_is_a_usage_error(capsys) -> None:
    with pytest.raises(SystemExit) as stopped:
        kinetic_cli.main(["frobnicate"])
    assert stopped.value.code == 2
    with pytest.raises(SystemExit) as stopped:
        kinetic_cli.main([])
    assert stopped.value.code == 2


def test_validate_gets_its_arguments_unparsed(monkeypatch) -> None:
    seen = []

    def fake(argv, prog=None):
        seen.append((argv, prog))
        return 7

    monkeypatch.setattr(validate_content, "main", fake)
    assert kinetic_cli.main(["validate", "game", "--ledger", "x.json",
                             "--help-me"]) == 7
    assert seen == [(["game", "--ledger", "x.json", "--help-me"],
                     "kinetic validate")]


def test_setup_gets_its_arguments_and_name(monkeypatch) -> None:
    seen = []
    monkeypatch.setattr(setup_media_tools, "main",
                        lambda argv, prog: seen.append((argv, prog)) or 1)
    assert kinetic_cli.main(["setup", "--force"]) == 1
    assert seen == [(["--force"], "kinetic setup")]


def test_assemble_and_upgrade_get_their_name_as_argv0(monkeypatch) -> None:
    seen = []
    monkeypatch.setattr(assemble_folder, "main", seen.append)
    monkeypatch.setattr(upgrade_folder, "main",
                        lambda argv: seen.append(argv) or 3)
    # assemble's main returns nothing on success: exit 0.
    assert kinetic_cli.main(["assemble", "in", "out", "--force"]) == 0
    assert kinetic_cli.main(["upgrade", "game"]) == 3
    assert seen == [["kinetic assemble", "in", "out", "--force"],
                    ["kinetic upgrade", "game"]]


def test_real_exit_codes_pass_through(tmp_path, capsys) -> None:
    missing = str(tmp_path / "missing")
    assert kinetic_cli.main(["validate", missing]) == 2
    assert kinetic_cli.main(["upgrade", missing]) == 2
    with pytest.raises(SystemExit) as stopped:
        kinetic_cli.main(["assemble", missing, str(tmp_path / "out")])
    assert stopped.value.code == 2
    # A bad option is the tool's own usage error, naming the subcommand.
    with pytest.raises(SystemExit) as stopped:
        kinetic_cli.main(["media", "--nonsense"])
    assert stopped.value.code == 2
    assert "usage: kinetic media" in capsys.readouterr().err
