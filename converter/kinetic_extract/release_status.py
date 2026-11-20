"""`kinetic release-status`: which Kinetic this is and whether its
release's checklist is done, with no network (docs/plan.md Phase 58,
item 5; CREATE.md, "Upgrading to a newer Kinetic").

Usage:

    kinetic release-status [--json]

It prints Kinetic's version; the commit it was made from, with `-dirty`
appended when the tree had changes git sees (changed, staged or
untracked files); the number of checked (`- [x]`) and open (`- [ ]`)
boxes in the release's docs/progress.md, a box counting only at the
start of a line, after any indentation; and the CHANGELOG.md entry for
the version, the text under its `## <version>` heading up to the next
`## ` heading, or that it has none.

Where it reads them:

- **A checkout**: the repo's docs/progress.md and CHANGELOG.md, and git
  for HEAD and whether the tree is clean. A checkout git cannot read (no
  git, no `.git`, or a folder inside some other repo) has no commit, and
  says why.
- **An installed wheel**: tools/build_wheel.py copies both files into
  the package data under `release/` with `build.json`, the commit it was
  built from and whether that tree was clean (null for both when git
  could not say). A wheel built before Kinetic 1.13.0 has none of them:
  exit 1, saying so.

`--json` prints one object: version, commit (the bare hash, or null),
clean (true, false or null), commitError (why commit is null, else
null), source ("checkout" or "wheel"), checked, open and changelog (the
entry's text, "" for an empty entry, null for none).

Exit codes: 0 when it ran, whatever the counts; 1 for a wheel without
the files or a file it cannot read; 2 for bad arguments.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from kinetic_extract import paths
from kinetic_extract.version import kinetic_version

PROG = "kinetic release-status"
# The package data tools/build_wheel.py writes, under DATA_DIR.
RELEASE_DIR = "release"
PROGRESS_NAME = "progress.md"
CHANGELOG_NAME = "CHANGELOG.md"
BUILD_NAME = "build.json"
# A checklist box: at the start of a line after any indentation, `- [x]`
# (or `[X]`) or `- [ ]`, then a space or the line's end.
BOX = re.compile(r"^[ \t]*- \[([ xX])\](?=\s|$)", re.MULTILINE)
HEADING = re.compile(r"^## ", re.MULTILINE)


class StatusError(Exception):
    """Why there is nothing to report; exit 1."""


def count_boxes(text: str) -> tuple[int, int]:
    """(checked, open): the checklist boxes in a progress.md's text."""
    marks = [found.group(1) for found in BOX.finditer(text)]
    open_ = marks.count(" ")
    return len(marks) - open_, open_


def changelog_entry(text: str, version: str) -> str | None:
    """The CHANGELOG's entry for `version`: the text under its `## VERSION`
    heading (a date or more may follow on that line) up to the next `## `
    heading, without the blank lines around it; None with no heading."""
    heading = re.compile(rf"^## {re.escape(version)}(?:[ \t].*)?$",
                         re.MULTILINE)
    found = heading.search(text)
    if found is None:
        return None
    following = HEADING.search(text, found.end())
    end = len(text) if following is None else following.start()
    return text[found.end():end].strip("\n").rstrip()


def git_state(root: Path) -> tuple[str | None, bool | None, str | None]:
    """(commit, clean, error) of the git work tree at `root`: HEAD, and
    whether `git status --porcelain` lists nothing (untracked files make
    it dirty, ignored ones do not); (None, None, why) when git cannot say,
    including for a `root` that is not the top of its own work tree."""
    def git(*args: str) -> str:
        proc = subprocess.run(["git", "-C", str(root), *args],
                              capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            said = proc.stderr.strip().splitlines()
            raise StatusError(said[-1] if said else f"git {args[0]} failed")
        return proc.stdout

    try:
        top, head = git("rev-parse", "--show-toplevel", "HEAD").splitlines()
        if os.path.realpath(top) != os.path.realpath(root):
            return None, None, (f"{root} is not a git work tree of its own "
                                f"(git found {top})")
        return head, git("status", "--porcelain") == "", None
    except OSError as exc:
        return None, None, f"cannot run git: {exc}"
    except (StatusError, ValueError) as exc:
        return None, None, f"git cannot read {root}: {exc}"


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        raise StatusError(f"cannot read {path}: {exc.strerror}") from None


def gather(checkout: Path | None, data_dir: Path,
           version: str) -> tuple[dict[str, Any], Path]:
    """The status object (the `--json` keys) and the progress.md it
    counted, from the checkout when there is one, else the wheel's
    package data under `data_dir`; StatusError when that has no files."""
    if checkout is not None:
        progress = checkout / "docs" / PROGRESS_NAME
        changelog = checkout / CHANGELOG_NAME
        commit, clean, error = git_state(checkout)
        source = "checkout"
    else:
        release = data_dir / RELEASE_DIR
        progress = release / PROGRESS_NAME
        changelog = release / CHANGELOG_NAME
        build = release / BUILD_NAME
        missing = [p.name for p in (progress, changelog, build)
                   if not p.is_file()]
        if missing:
            raise StatusError(
                f"this installed Kinetic {version} carries no release "
                f"checklist ({', '.join(missing)} missing from {release}); "
                "wheels built before Kinetic 1.13.0 do not, so read the "
                "release's docs/progress.md at its tag instead")
        try:
            record = json.loads(_read(build))
            commit, clean = record["commit"], record["clean"]
        except (ValueError, TypeError, KeyError) as exc:
            raise StatusError(f"{build} is not a build record: {exc}") \
                from None
        error = None if commit else "the wheel was built where git " \
                                    "could not name the commit"
        commit = commit or None
        clean = clean if commit else None
        source = "wheel"
    checked, open_ = count_boxes(_read(progress))
    return {
        "version": version, "commit": commit, "clean": clean,
        "commitError": error, "source": source,
        "checked": checked, "open": open_,
        "changelog": changelog_entry(_read(changelog), version),
    }, progress


def commit_label(status: dict[str, Any]) -> str:
    """The commit as the text output shows it: `HASH`, `HASH-dirty`, or
    `unknown (why)`."""
    if status["commit"] is None:
        return f"unknown ({status['commitError']})"
    return status["commit"] + ("" if status["clean"] else "-dirty")


def format_text(status: dict[str, Any], progress: Path) -> str:
    lines = [f"Kinetic {status['version']}",
             f"commit: {commit_label(status)}",
             f"checklist: {status['checked']} checked, {status['open']} "
             f"open ({progress})"]
    entry = status["changelog"]
    if entry is None:
        lines.append(f"changelog: no entry for {status['version']}")
    elif entry == "":
        lines.append(f"changelog {status['version']}: (empty)")
    else:
        lines += [f"changelog {status['version']}:", entry]
    return "\n".join(lines) + "\n"


def run(args: argparse.Namespace) -> int:
    try:
        status, progress = gather(paths.CHECKOUT, paths.DATA_DIR,
                                  kinetic_version())
    except StatusError as exc:
        print(f"{PROG}: {exc}", file=sys.stderr)
        return 1
    if args.json:
        sys.stdout.write(json.dumps(status, indent=2, ensure_ascii=False)
                         + "\n")
    else:
        sys.stdout.write(format_text(status, progress))
    return 0


def register(subcommands: Any) -> None:
    """Add `release-status` to the `kinetic` command (kinetic_cli)."""
    argp = subcommands.add_parser(
        "release-status",
        help="this Kinetic's version, commit, checklist counts and "
             "CHANGELOG entry",
        description="Print this Kinetic's version, the commit it was made "
                    "from, how many items of its release's checklist "
                    "(docs/progress.md) are checked and open, and its "
                    "CHANGELOG entry, with no network (CREATE.md, "
                    "\"Upgrading to a newer Kinetic\").")
    argp.add_argument("--json", action="store_true",
                      help="print the same as one JSON object")
    argp.set_defaults(run=run)
