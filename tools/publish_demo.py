#!/usr/bin/env python3
"""Publish the demo tour to GitHub Pages (docs/plan.md Phase 57 item 11d;
CREATE.md, "Serving from a web host").

Usage (from the repo root):

    .venv/bin/python tools/publish_demo.py [--dry-run] [--out DIR]

It builds the player afresh into a staging folder (`node
scripts/build.mjs`, what `npm run build` runs, so player/dist/ is left
alone) and checks the bundle is stamped with this checkout's VERSION;
builds the demo tour (fixtures/build_demo.py, which needs ffmpeg on PATH)
into the staging folder; assembles the two into the site folder DIR
(default .tmp/publish-demo/site/) as `kinetic assemble` does, with no
Mac or Windows app; and adds an empty `.nojekyll`, so Pages serves the
files as they are. An existing DIR is replaced only when it is empty or
an earlier site (it holds `.nojekyll`).

Then it replaces the `gh-pages` branch on `origin` with one new commit
that holds just the site, with no parent: no history is kept. The commit
is made with a temporary index (the checkout's own index, working tree
and branches are untouched), its message `demo: Kinetic <version>` with
the source commit in the body, and pushed with `git push --force origin
<commit>:refs/heads/gh-pages`, as this checkout pushes. Pages serves
that branch's root at https://sendub.github.io/kinetic/ once it is
enabled on the repo (done once, by hand).

Before building it refuses a checkout whose site sources differ from
HEAD (changed, staged or untracked files under VERSION, LICENSE, player/
or fixtures/, leaving out player/scripts/testing/ and
player/scripts/scenarios/, which no site file comes from), so the
published demo is the commit the body names. `--dry-run` builds the site
and stops, saying what it would push; it builds from a changed checkout
too, saying so.

Needs Node and player/node_modules (`npm ci --cache ../.tmp/npm-cache` in
player/), and ffmpeg and ffprobe on PATH. Exit status: 0 published (or
built, with --dry-run), 1 a step failed or the checkout has changes, 2
bad arguments.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT / "converter") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "converter"))
from kinetic_extract import assemble_folder  # noqa: E402
from kinetic_extract.version import (  # noqa: E402
    add_version_option, folder_player_version, kinetic_version)

PLAYER = REPO_ROOT / "player"
BUILD_DEMO = REPO_ROOT / "fixtures" / "build_demo.py"
WORK = REPO_ROOT / ".tmp" / "publish-demo"
DEFAULT_OUT = WORK / "site"
BRANCH = "gh-pages"
REMOTE = "origin"
SITE_MARK = ".nojekyll"
# What the site is built from, as git pathspecs (see the docstring).
SOURCES = ("VERSION", "LICENSE", "player", "fixtures",
           ":(exclude)player/scripts/testing",
           ":(exclude)player/scripts/scenarios")


class PublishError(Exception):
    """A step failed; the message says which."""


def git(repo: Path, *args: str, env: dict | None = None) -> str:
    """git's stdout for `args` run in `repo`, stripped; PublishError when
    it fails."""
    proc = subprocess.run(["git", *args], cwd=repo, capture_output=True,
                          text=True, env=env)
    if proc.returncode != 0:
        raise PublishError(f"git {' '.join(args)} failed: "
                           f"{proc.stderr.strip() or proc.stdout.strip()}")
    return proc.stdout.strip()


def source_changes(repo: Path) -> list[str]:
    """The site sources (SOURCES) changed, staged or untracked in `repo`,
    as `git status --porcelain` lines."""
    out = git(repo, "status", "--porcelain", "--untracked-files=all", "--",
              *SOURCES)
    return [line for line in out.splitlines() if line]


def run(cmd: list[str], cwd: Path) -> None:
    """Run a build step, its output passed through; PublishError when it
    fails."""
    if subprocess.run(cmd, cwd=cwd).returncode != 0:
        raise PublishError(f"{' '.join(cmd)} failed (in {cwd})")


def build_player(out: Path) -> None:
    """The player bundle, built fresh into `out`, stamped with VERSION."""
    node = shutil.which("node")
    if node is None:
        raise PublishError("node is not on PATH; the player build needs it")
    if not (PLAYER / "node_modules").is_dir():
        raise PublishError("player/node_modules is missing; run `npm ci "
                           "--cache ../.tmp/npm-cache` in player/")
    run([node, "scripts/build.mjs", str(out)], PLAYER)
    built = folder_player_version(out)
    if built != kinetic_version():
        raise PublishError(f"the fresh player build is stamped Kinetic "
                           f"{built}, not {kinetic_version()}")


def prepare_out(out: Path) -> None:
    """Refuse an `out` this tool did not make: it must be missing, empty,
    or an earlier site (holding SITE_MARK)."""
    if out.exists() and (not out.is_dir() or (
            any(out.iterdir()) and not (out / SITE_MARK).is_file())):
        raise PublishError(f"{out} exists and is not an earlier site (no "
                           f"{SITE_MARK}); give another --out or remove it")


def build_site(out: Path, work: Path = WORK) -> str:
    """Build the site into `out` (replacing it), staging in `work`; return
    the assemble report line."""
    prepare_out(out)
    player = work / "player"
    demo = work / "demo"
    for folder in (player, demo):
        if folder.exists():
            shutil.rmtree(folder)
    player.mkdir(parents=True)
    build_player(player)
    run([sys.executable, str(BUILD_DEMO), "--out", str(demo)], REPO_ROOT)
    report = assemble_folder.assemble(demo, out, player)
    (out / SITE_MARK).write_bytes(b"")
    return report


def site_commit(repo: Path, site: Path, message: str,
                index: Path) -> str:
    """A new commit in `repo` with no parent whose tree is `site`'s files,
    made with the temporary index file `index` (removed after), and
    `message`; returns its id. Nothing else in `repo` changes."""
    env = {**os.environ, "GIT_INDEX_FILE": str(index.resolve()),
           "GIT_DIR": git(repo, "rev-parse", "--absolute-git-dir"),
           "GIT_WORK_TREE": str(site.resolve())}
    index.parent.mkdir(parents=True, exist_ok=True)
    index.unlink(missing_ok=True)
    try:
        # --force: the repo's ignore files must not leave a site file out.
        git(site, "add", "--all", "--force", ".", env=env)
        tree = git(site, "write-tree", env=env)
    finally:
        index.unlink(missing_ok=True)
    return git(repo, "commit-tree", tree, "-m", message)


def commit_message(version: str, source: str) -> str:
    return (f"demo: Kinetic {version}\n\n"
            f"The demo tour (fixtures/build_demo.py) assembled with the "
            f"player built\nfrom {source}, by tools/publish_demo.py.\n")


def push(repo: Path, commit: str, remote: str = REMOTE) -> None:
    """Make `commit` the remote's BRANCH, replacing whatever it held."""
    git(repo, "push", "--force", remote, f"{commit}:refs/heads/{BRANCH}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="publish_demo.py",
        description="Publish the demo tour to GitHub Pages (gh-pages).")
    parser.add_argument("--dry-run", action="store_true",
                        help="build the site folder and stop; push nothing")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT,
                        help=f"the site folder (default: {DEFAULT_OUT})")
    add_version_option(parser)
    args = parser.parse_args(argv)
    out = args.out.resolve()
    try:
        changes = source_changes(REPO_ROOT)
        if changes and not args.dry_run:
            print("publish_demo: the site's sources differ from HEAD; "
                  "commit or stash them first:\n  " + "\n  ".join(changes),
                  file=sys.stderr)
            return 1
        source = git(REPO_ROOT, "rev-parse", "HEAD")
        print(build_site(out))
        version = kinetic_version()
        if args.dry_run:
            note = (f" (from a checkout with {len(changes)} changed "
                    f"source file{'s' if len(changes) != 1 else ''})"
                    if changes else "")
            print(f"dry run: would replace {REMOTE} {BRANCH} with {out} as "
                  f"\"demo: Kinetic {version}\", built from {source}{note}")
            return 0
        commit = site_commit(REPO_ROOT, out, commit_message(version, source),
                             WORK / "index")
        push(REPO_ROOT, commit)
        print(f"published {commit} to {REMOTE} {BRANCH}: demo: Kinetic "
              f"{version}, built from {source}")
    except PublishError as exc:
        print(f"publish_demo: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
