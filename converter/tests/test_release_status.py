"""`kinetic release-status`: the version, the commit, the checklist's counts
and the CHANGELOG entry, read from a checkout or from an installed wheel's
package data (docs/plan.md Phase 58, item 5). The installed wheel runs it
in tools/test_build_wheel.py."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from kinetic_extract import kinetic_cli, paths, release_status

PROGRESS = """\
# Progress

- [x] First item, done.
      A continuation line - [x] that mentions a box mid-line.
- [ ] Second item, open.
  - [x] An indented box, done.
    - [ ] A deeper box, open.
\t- [X] A tab-indented box, done.
- [x]
Some text with [x] and - [ ] in it.
      - [ ] a box under an item, however deep, counts
* [x] another bullet style, not counted
-[x] no space, not counted
- [y] not a box
"""
# Boxes: checked lines 3, 6, 8, 9; open lines 5, 7, 11.
CHECKED, OPEN = 4, 3

CHANGELOG = """\
# Changelog

Intro text.

## 2.1.0-dev

## 2.0.0 (2026-01-02)

- A feature.
- Another, which
  wraps.

### A sub-heading inside the entry

More text.

## 1.9.0 (2025-12-01)

- Old.
"""
ENTRY_2_0_0 = """\
- A feature.
- Another, which
  wraps.

### A sub-heading inside the entry

More text."""


def test_counts_boxes_at_the_start_of_a_line_only() -> None:
    assert release_status.count_boxes(PROGRESS) == (CHECKED, OPEN)
    assert release_status.count_boxes("") == (0, 0)


def test_changelog_entry() -> None:
    assert release_status.changelog_entry(CHANGELOG, "2.0.0") == ENTRY_2_0_0
    assert release_status.changelog_entry(CHANGELOG, "1.9.0") == "- Old."
    # A heading with nothing under it is an empty entry, not a missing one.
    assert release_status.changelog_entry(CHANGELOG, "2.1.0-dev") == ""
    assert release_status.changelog_entry(CHANGELOG, "2.0") is None
    assert release_status.changelog_entry(CHANGELOG, "3.0.0") is None


def git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(root), "-c", "user.name=t", "-c",
         "user.email=t@example.invalid", "-c", "commit.gpgsign=false",
         *args], check=True, capture_output=True, text=True).stdout.strip()


def make_checkout(root: Path, version: str = "2.0.0") -> Path:
    """A repo that paths.find_checkout takes for a checkout, with the
    synthetic progress.md and CHANGELOG.md."""
    (root / "converter").mkdir(parents=True)
    (root / "converter" / "pyproject.toml").write_text("")
    (root / "player").mkdir()
    (root / "player" / "package.json").write_text("{}")
    (root / "docs").mkdir()
    (root / "docs" / "progress.md").write_text(PROGRESS)
    (root / "CHANGELOG.md").write_text(CHANGELOG)
    (root / "VERSION").write_text(version + "\n")
    assert paths.find_checkout(root / "converter" / "kinetic_extract") == root
    return root


def run_cli(monkeypatch, capsys, argv: list[str], checkout: Path | None,
            data_dir: Path, version: str = "2.0.0") -> tuple[int, str, str]:
    monkeypatch.setattr(paths, "CHECKOUT", checkout)
    monkeypatch.setattr(paths, "DATA_DIR", data_dir)
    monkeypatch.setattr(release_status, "kinetic_version", lambda: version)
    try:
        code = kinetic_cli.main(["release-status", *argv])
    except SystemExit as stopped:
        code = stopped.code
    out = capsys.readouterr()
    return code, out.out, out.err


needs_git = pytest.mark.skipif(shutil.which("git") is None,
                               reason="git is not on PATH")


@needs_git
def test_a_clean_checkout_in_text_and_json(tmp_path, monkeypatch,
                                           capsys) -> None:
    root = make_checkout(tmp_path / "repo")
    git(root, "init", "-q")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "one")
    head = git(root, "rev-parse", "HEAD")
    code, out, err = run_cli(monkeypatch, capsys, ["--json"], root,
                             tmp_path / "no-data")
    assert (code, err) == (0, "")
    assert json.loads(out) == {
        "version": "2.0.0", "commit": head, "clean": True,
        "commitError": None, "source": "checkout",
        "checked": CHECKED, "open": OPEN, "changelog": ENTRY_2_0_0}
    code, out, err = run_cli(monkeypatch, capsys, [], root,
                             tmp_path / "no-data")
    assert (code, err) == (0, "")
    assert out == (
        "Kinetic 2.0.0\n"
        f"commit: {head}\n"
        f"checklist: {CHECKED} checked, {OPEN} open "
        f"({root / 'docs' / 'progress.md'})\n"
        "changelog 2.0.0:\n"
        f"{ENTRY_2_0_0}\n")


@needs_git
def test_a_changed_or_untracked_file_makes_the_commit_dirty(
        tmp_path, monkeypatch, capsys) -> None:
    root = make_checkout(tmp_path / "repo")
    git(root, "init", "-q")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "one")
    head = git(root, "rev-parse", "HEAD")
    (root / "CHANGELOG.md").write_text(CHANGELOG + "\nmore\n")
    code, out, _ = run_cli(monkeypatch, capsys, [], root, tmp_path / "x")
    assert code == 0
    assert f"commit: {head}-dirty\n" in out
    code, out, _ = run_cli(monkeypatch, capsys, ["--json"], root,
                           tmp_path / "x")
    found = json.loads(out)
    assert (found["commit"], found["clean"]) == (head, False)
    git(root, "checkout", "--", "CHANGELOG.md")
    (root / "new-file").write_text("")
    code, out, _ = run_cli(monkeypatch, capsys, ["--json"], root,
                           tmp_path / "x")
    assert json.loads(out)["clean"] is False


def test_a_checkout_without_git_has_no_commit(tmp_path, monkeypatch,
                                              capsys) -> None:
    root = make_checkout(tmp_path / "repo")
    # No .git here and none above that git would find: a GIT_DIR that is
    # not a repository makes every git command fail.
    monkeypatch.setenv("GIT_DIR", str(tmp_path / "not-a-repo"))
    code, out, err = run_cli(monkeypatch, capsys, ["--json"], root,
                             tmp_path / "x")
    assert (code, err) == (0, "")
    found = json.loads(out)
    assert (found["commit"], found["clean"]) == (None, None)
    assert found["commitError"]
    assert (found["checked"], found["open"]) == (CHECKED, OPEN)
    code, out, _ = run_cli(monkeypatch, capsys, [], root, tmp_path / "x")
    assert code == 0
    assert "commit: unknown (" in out


def test_no_git_on_path_has_no_commit(tmp_path, monkeypatch, capsys) -> None:
    root = make_checkout(tmp_path / "repo")
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    code, out, _ = run_cli(monkeypatch, capsys, ["--json"], root,
                           tmp_path / "x")
    assert code == 0
    found = json.loads(out)
    assert found["commit"] is None and "git" in found["commitError"]


@needs_git
def test_a_checkout_inside_another_repo_is_not_that_repos_commit(
        tmp_path, monkeypatch, capsys) -> None:
    outer = tmp_path / "outer"
    outer.mkdir()
    git(outer, "init", "-q")
    (outer / "f").write_text("")
    git(outer, "add", "-A")
    git(outer, "commit", "-q", "-m", "outer")
    root = make_checkout(outer / "repo")
    code, out, _ = run_cli(monkeypatch, capsys, ["--json"], root,
                           tmp_path / "x")
    assert code == 0
    found = json.loads(out)
    assert found["commit"] is None and found["commitError"]


def make_wheel_data(data: Path, commit: str | None, clean: bool | None
                    ) -> Path:
    release = data / "release"
    release.mkdir(parents=True)
    (release / "progress.md").write_text(PROGRESS)
    (release / "CHANGELOG.md").write_text(CHANGELOG)
    (release / "build.json").write_text(json.dumps(
        {"commit": commit, "clean": clean}))
    return data


def test_an_installed_wheel_reads_its_package_data(tmp_path, monkeypatch,
                                                   capsys) -> None:
    data = make_wheel_data(tmp_path / "data", "abc123", False)
    code, out, err = run_cli(monkeypatch, capsys, ["--json"], None, data,
                             version="1.9.0")
    assert (code, err) == (0, "")
    assert json.loads(out) == {
        "version": "1.9.0", "commit": "abc123", "clean": False,
        "commitError": None, "source": "wheel",
        "checked": CHECKED, "open": OPEN, "changelog": "- Old."}
    code, out, _ = run_cli(monkeypatch, capsys, [], None, data,
                           version="1.9.0")
    assert out.splitlines()[:3] == [
        "Kinetic 1.9.0", "commit: abc123-dirty",
        f"checklist: {CHECKED} checked, {OPEN} open "
        f"({data / 'release' / 'progress.md'})"]


def test_a_wheel_built_without_git(tmp_path, monkeypatch, capsys) -> None:
    data = make_wheel_data(tmp_path / "data", None, None)
    code, out, _ = run_cli(monkeypatch, capsys, ["--json"], None, data)
    assert code == 0
    found = json.loads(out)
    assert (found["commit"], found["clean"]) == (None, None)
    assert "built" in found["commitError"]


def test_a_missing_changelog_entry_is_said(tmp_path, monkeypatch,
                                           capsys) -> None:
    data = make_wheel_data(tmp_path / "data", "abc123", True)
    code, out, _ = run_cli(monkeypatch, capsys, [], None, data,
                           version="3.0.0")
    assert code == 0
    assert out.splitlines()[1] == "commit: abc123"
    assert out.splitlines()[-1] == "changelog: no entry for 3.0.0"
    code, out, _ = run_cli(monkeypatch, capsys, ["--json"], None, data,
                           version="3.0.0")
    assert json.loads(out)["changelog"] is None
    code, out, _ = run_cli(monkeypatch, capsys, [], None, data,
                           version="2.1.0-dev")
    assert out.splitlines()[-1] == "changelog 2.1.0-dev: (empty)"


@pytest.mark.parametrize("missing", ["progress.md", "CHANGELOG.md",
                                     "build.json"])
def test_an_older_wheel_without_the_files_exits_1(
        tmp_path, monkeypatch, capsys, missing) -> None:
    data = make_wheel_data(tmp_path / "data", "abc123", True)
    (data / "release" / missing).unlink()
    code, out, err = run_cli(monkeypatch, capsys, [], None, data)
    assert (code, out) == (1, "")
    assert err.startswith("kinetic release-status: ")
    assert "older" in err


def test_bad_arguments_exit_2(tmp_path, monkeypatch, capsys) -> None:
    data = make_wheel_data(tmp_path / "data", "abc123", True)
    code, _, err = run_cli(monkeypatch, capsys, ["--nonsense"], None, data)
    assert code == 2
    assert "unrecognized arguments: --nonsense" in err
    code, _, err = run_cli(monkeypatch, capsys, ["extra"], None, data)
    assert code == 2
    assert "unrecognized arguments: extra" in err


def test_this_checkout(capsys) -> None:
    """In the repo itself: the repo's VERSION and the counts of its own
    progress.md."""
    code = kinetic_cli.main(["release-status", "--json"])
    assert code == 0
    found = json.loads(capsys.readouterr().out)
    root = Path(__file__).resolve().parents[2]
    assert found["version"] == (root / "VERSION").read_text().strip()
    assert found["source"] == "checkout"
    progress = (root / "docs" / "progress.md").read_text(encoding="utf-8")
    assert (found["checked"], found["open"]) == \
        release_status.count_boxes(progress)
    assert found["changelog"] is not None
