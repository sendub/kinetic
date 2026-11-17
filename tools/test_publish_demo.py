"""Tests for tools/publish_demo.py (docs/plan.md Phase 57 item 11d). Run
with:

    .venv/bin/pytest tools/test_publish_demo.py -q

The site build runs for real (the player build, the demo, the assembly)
into a temporary folder; the commit and the push go to throwaway
repositories made here. Nothing reaches the network or this checkout's
branches.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import publish_demo  # noqa: E402
from kinetic_extract.version import (  # noqa: E402
    folder_player_version, kinetic_version)


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True,
                          capture_output=True, text=True).stdout.strip()


def new_repo(path: Path, bare: bool = False) -> Path:
    path.mkdir(parents=True)
    git(path, "init", "-q", *(["--bare"] if bare else []))
    if not bare:
        git(path, "config", "user.name", "Test")
        git(path, "config", "user.email", "test@example.invalid")
    return path


@pytest.fixture(scope="module")
def site(tmp_path_factory: pytest.TempPathFactory) -> Path:
    if not (REPO_ROOT / "player" / "node_modules").is_dir():
        pytest.skip("player/node_modules missing (npm ci in player/)")
    root = tmp_path_factory.mktemp("publish")
    out = root / "site"
    report = publish_demo.build_site(out, work=root / "work")
    assert report.startswith(f"assembled {out}: ")
    return out


def test_the_site_is_the_assembled_demo_with_the_current_player(
        site: Path) -> None:
    for name in ("index.html", "app.js", "manifest.js", "manifest.json",
                 ".nojekyll"):
        assert (site / name).is_file(), name
    assert (site / ".nojekyll").read_bytes() == b""
    assert folder_player_version(site) == kinetic_version()
    # Every file the demo's manifest names is there.
    manifest = (site / "manifest.json").read_text(encoding="utf-8")
    items = json.loads(manifest)["items"]
    named = {f for it in items
             for f in [it.get("file"), it.get("poster"),
                       *(it.get("frames") or [])] if isinstance(f, str)}
    assert named, "the demo names media files"
    assert sorted(f for f in named if not (site / f).is_file()) == []
    assert any(f.endswith(".mp4") for f in named)
    assert any(f.endswith(".webm") for f in named)


def test_the_site_holds_no_app_and_nothing_else_from_the_checkout(
        site: Path) -> None:
    names = [p.name for p in site.rglob("*")]
    assert not [n for n in names if n.endswith((".app", ".exe"))]
    assert "manifest.schema.json" not in names
    assert not (site / ".git").exists()


def test_an_existing_folder_that_is_not_a_site_is_refused(
        tmp_path: Path) -> None:
    other = tmp_path / "other"
    other.mkdir()
    (other / "keep.txt").write_text("mine")
    with pytest.raises(publish_demo.PublishError, match="not an earlier site"):
        publish_demo.prepare_out(other)
    assert (other / "keep.txt").read_text() == "mine"
    publish_demo.prepare_out(tmp_path / "missing")
    (tmp_path / "empty").mkdir()
    publish_demo.prepare_out(tmp_path / "empty")
    earlier = tmp_path / "earlier"
    earlier.mkdir()
    (earlier / ".nojekyll").write_bytes(b"")
    (earlier / "app.js").write_text("old")
    publish_demo.prepare_out(earlier)


def test_source_changes_lists_changed_and_untracked_sources_only(
        tmp_path: Path) -> None:
    repo = new_repo(tmp_path / "repo")
    for path in ("VERSION", "player/src/a.ts", "fixtures/build_demo.py",
                 "player/scripts/testing/kinetic.mjs", "docs/plan.md"):
        (repo / path).parent.mkdir(parents=True, exist_ok=True)
        (repo / path).write_text("x")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "start")
    assert publish_demo.source_changes(repo) == []
    (repo / "docs/plan.md").write_text("y")
    (repo / "player/scripts/testing/kinetic.mjs").write_text("y")
    (repo / "player/scripts/scenarios").mkdir(parents=True)
    (repo / "player/scripts/scenarios/new.scenario.mjs").write_text("y")
    assert publish_demo.source_changes(repo) == []
    (repo / "player/src/a.ts").write_text("y")
    (repo / "fixtures/new.py").write_text("y")
    (repo / "VERSION").write_text("y")
    git(repo, "add", "VERSION")
    assert publish_demo.source_changes(repo) == [
        "M  VERSION", " M player/src/a.ts", "?? fixtures/new.py"]


def test_the_commit_holds_just_the_site_with_no_parent_and_the_push_replaces_the_branch(
        tmp_path: Path) -> None:
    repo = new_repo(tmp_path / "repo")
    (repo / ".gitignore").write_text("*.mp4\n")
    (repo / "README").write_text("the checkout")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "develop")
    head = git(repo, "rev-parse", "HEAD")
    remote = new_repo(tmp_path / "remote.git", bare=True)
    git(repo, "remote", "add", "origin", str(remote))
    site = tmp_path / "site"
    site.mkdir()
    for name, text in ((".nojekyll", ""), ("index.html", "<!doctype html>"),
                       ("clip.mp4", "video")):
        (site / name).write_text(text)

    message = publish_demo.commit_message("9.9.9", head)
    index = tmp_path / "work" / "index"
    first = publish_demo.site_commit(repo, site, message, index)
    assert not index.exists()
    assert git(repo, "rev-list", "--parents", "-n1", first) == first
    assert git(repo, "ls-tree", "--name-only", first).split("\n") == [
        ".nojekyll", "clip.mp4", "index.html"]
    assert git(repo, "log", "-1", "--format=%B", first) == message.strip()
    assert message.startswith("demo: Kinetic 9.9.9\n\n")
    assert head in message
    # The checkout is untouched: its branch, index and files.
    assert git(repo, "rev-parse", "HEAD") == head
    assert git(repo, "status", "--porcelain") == ""

    publish_demo.push(repo, first, "origin")
    assert git(remote, "rev-parse", "refs/heads/gh-pages") == first
    (site / "index.html").write_text("<!doctype html><p>new")
    second = publish_demo.site_commit(repo, site, message, index)
    publish_demo.push(repo, second, "origin")
    assert git(remote, "rev-parse", "refs/heads/gh-pages") == second
    assert git(remote, "rev-list", "--count", "gh-pages") == "1"


def test_dry_run_builds_the_site_and_pushes_nothing(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture) -> None:
    built: list[Path] = []
    monkeypatch.setattr(publish_demo, "build_site",
                        lambda out: built.append(out) or f"assembled {out}")
    monkeypatch.setattr(publish_demo, "push", lambda *a: pytest.fail("push"))
    monkeypatch.setattr(publish_demo, "site_commit",
                        lambda *a: pytest.fail("commit"))
    out = tmp_path / "site"
    assert publish_demo.main(["--dry-run", "--out", str(out)]) == 0
    assert built == [out]
    said = capsys.readouterr().out
    assert f"dry run: would replace origin gh-pages with {out}" in said


def test_a_publish_from_changed_sources_is_refused_before_building(
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture) -> None:
    monkeypatch.setattr(publish_demo, "source_changes",
                        lambda repo: [" M player/src/main.ts"])
    monkeypatch.setattr(publish_demo, "build_site",
                        lambda out: pytest.fail("built"))
    assert publish_demo.main([]) == 1
    err = capsys.readouterr().err
    assert "the site's sources differ from HEAD" in err
    assert "player/src/main.ts" in err
