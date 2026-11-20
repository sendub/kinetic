"""`kinetic check` (kinetic_extract/check.py; docs/plan.md Phase 57, item
9): the Node it needs, said plainly when missing or old, and how it runs
check-game in a checkout and from an installed wheel, and the testing
library's path `--library` prints (Phase 58, item 4). A real walk from
the installed wheel, and a script importing its library, are in
tools/test_build_wheel.py."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kinetic_extract import check, paths

REPO_ROOT = Path(__file__).resolve().parents[2]
VERSION = (REPO_ROOT / "VERSION").read_text(encoding="utf-8").strip()


@pytest.mark.parametrize(("text", "version"), [
    ("v22.12.0\n", (22, 12, 0)), (">=22.12.0", (22, 12, 0)),
    ("^20.3", (20, 3, 0)), ("24", (24, 0, 0)), ("none", None)])
def test_parse_version(text, version) -> None:
    assert check.parse_version(text) == version


def test_required_node_from_the_bundle_beside_it(tmp_path) -> None:
    script = tmp_path / "check-game.mjs"
    (tmp_path / check.REQUIREMENTS_NAME).write_text(
        json.dumps({"node": "22.12.0"}))
    assert check.required_node(script, checkout=None) == (22, 12, 0)


def test_required_node_from_a_checkouts_puppeteer(tmp_path) -> None:
    pkg = tmp_path / "player" / "node_modules" / "puppeteer-core"
    pkg.mkdir(parents=True)
    (pkg / "package.json").write_text(
        json.dumps({"engines": {"node": ">=18.1.0"}}))
    assert check.required_node(checkout=tmp_path) == (18, 1, 0)


def test_required_node_unreadable_is_said(tmp_path) -> None:
    with pytest.raises(check.CheckError, match="cannot read"):
        check.required_node(tmp_path / "check-game.mjs", checkout=None)


def test_no_node_names_the_version_needed() -> None:
    with pytest.raises(check.CheckError) as raised:
        check.find_node((22, 12, 0), which=lambda name: None)
    assert "Node.js 22.12.0 or later" in str(raised.value)
    assert "no node" in str(raised.value)


def test_an_old_node_names_both_versions() -> None:
    with pytest.raises(check.CheckError) as raised:
        check.find_node((22, 12, 0), which=lambda name: "/bin/node",
                        version_of=lambda node: (20, 1, 0))
    assert "Node.js 22.12.0 or later" in str(raised.value)
    assert "/bin/node is 20.1.0" in str(raised.value)
    assert check.find_node((22, 12, 0), which=lambda name: "/bin/node",
                           version_of=lambda node: (22, 12, 0)) == "/bin/node"


def test_installed_check_keeps_its_scratch_in_the_cache(monkeypatch,
                                                        tmp_path) -> None:
    monkeypatch.setenv(paths.HOME_ENV, str(tmp_path))
    script = Path("/site/kinetic_extract/data/check/check-game.mjs")
    cmd, env = check.command(["game", "--steps", "5"], "/bin/node", script,
                             checkout=None, env={"PATH": "/bin"})
    assert cmd == ["/bin/node", str(script), "game", "--steps", "5"]
    assert env == {"PATH": "/bin",
                   check.SCRATCH_ENV: str(tmp_path / "cache" / "check")}


def test_checkout_check_runs_the_source_as_today() -> None:
    cmd, env = check.command(["game"], "/bin/node", checkout=REPO_ROOT,
                             env={"PATH": "/bin"})
    assert cmd == ["/bin/node", str(paths.CHECK_GAME), "game"]
    assert env == {"PATH": "/bin"}


def test_version_and_help_need_no_node(monkeypatch, capsys) -> None:
    monkeypatch.setattr(check.shutil, "which", lambda name: None)
    assert check.main(["--version"]) == 0
    assert capsys.readouterr().out == f"Kinetic {VERSION}\n"
    assert check.main(["--help"]) == 0
    assert capsys.readouterr().out.startswith("usage: kinetic check")


def test_without_node_check_fails_saying_so(monkeypatch, capsys,
                                            tmp_path) -> None:
    monkeypatch.setattr(check.shutil, "which", lambda name: None)
    monkeypatch.setattr(check, "required_node", lambda: (22, 12, 0))
    monkeypatch.setattr(check, "preflight", lambda: None)
    assert check.main([str(tmp_path)]) == 1
    err = capsys.readouterr().err
    assert err.startswith("kinetic check: ")
    assert "Node.js 22.12.0 or later" in err


def test_missing_check_game_or_node_modules_is_said(tmp_path) -> None:
    with pytest.raises(check.CheckError, match="reinstall Kinetic"):
        check.preflight(tmp_path / "check-game.mjs", checkout=None)
    script = tmp_path / "check-game.mjs"
    script.write_text("")
    with pytest.raises(check.CheckError, match="npm ci"):
        check.preflight(script, checkout=tmp_path)


def test_library_prints_the_checkouts_testing_library(monkeypatch,
                                                      capsys) -> None:
    # No Node needed: the path is printed from here.
    monkeypatch.setattr(check.shutil, "which", lambda name: None)
    assert check.main(["--library"]) == 0
    out = capsys.readouterr().out
    assert out == f"{REPO_ROOT / 'player' / 'scripts' / 'testing' / 'kinetic.mjs'}\n"
    assert Path(out.strip()).is_absolute()


def test_installed_library_is_the_bundle_in_the_package_data(capsys,
                                                             tmp_path) -> None:
    bundle = tmp_path / "data" / "check" / "kinetic.mjs"
    bundle.parent.mkdir(parents=True)
    bundle.write_text("export {};\n")
    assert check.library(bundle, checkout=None) == 0
    captured = capsys.readouterr()
    assert (captured.out, captured.err) == (f"{bundle}\n", "")


def test_a_missing_library_is_said(capsys, tmp_path) -> None:
    assert check.library(tmp_path / "kinetic.mjs", checkout=None) == 1
    assert "reinstall Kinetic" in capsys.readouterr().err


def test_a_checkout_without_node_modules_gets_a_note(capsys,
                                                     tmp_path) -> None:
    script = tmp_path / "kinetic.mjs"
    script.write_text("")
    assert check.library(script, checkout=tmp_path) == 0
    captured = capsys.readouterr()
    assert captured.out == f"{script}\n"
    assert "npm ci" in captured.err


def test_library_takes_no_other_arguments(capsys) -> None:
    assert check.main(["--library", "game"]) == 2
    assert "--library takes no other arguments" in capsys.readouterr().err

