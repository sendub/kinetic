"""Upgrade a Kinetic game folder to the player this Kinetic carries
(docs/plan.md Phase 51, item 6).

Usage:

    kinetic upgrade <folder>
    python tools/upgrade_folder.py <folder>   (the same, from a checkout)

In a checkout, run it after building the player of the Kinetic you want:

    git pull
    cd player && npm ci --cache ../.tmp/npm-cache && npm run build && cd ..
    .venv/bin/python tools/upgrade_folder.py my-novel

An installed Kinetic (docs/packaging.md, "Installing the tools") carries
its built player, so `kinetic upgrade my-novel` after installing the
release you want is enough; what this says of `player/dist/` holds for
that copy.

Exit status: 0 when the folder is upgraded and the validator passes
(its warnings are printed and do not change that), 1 when the upgrade is
refused, a file cannot be written, or the upgraded folder has validator
problems, 2 when the arguments are unusable or the folder is not a
directory.

A game folder's player is two files, `index.html` and `app.js`; every
other file in it is the author's content. The upgrade:

- refuses a folder with no `manifest.json`, and a `player/dist/` without
  `index.html` or `app.js`, or whose `app.js` is not stamped with this
  Kinetic's version (the repo's VERSION; `--version` prints it): run
  `npm run build` in `player/` first. A refusal changes nothing;
- replaces the folder's `index.html` and `app.js` with the ones in
  `player/dist/`. Each is written whole to a hidden temporary file beside
  it (`.app.js.<random>.upgrading`) and then renamed over the old one,
  so an interrupted upgrade leaves the old file or the new one, never
  half of either, and no temporary file; the replaced file keeps the
  old one's permissions. It never copies `player/dist/manifest.js` (an
  empty placeholder that would overwrite the game's own) or
  `app.js.map` (a debugging aid the folder does not need); an
  `app.js.map` already in the folder, say from copying all of
  `player/dist/` by hand, is left alone: the player names no source map,
  so it is never read;
- replaces `manifest.schema.json`, the schema copy kinetic-extract
  writes for an author's editor, with this Kinetic's schema when the
  folder has one, and with it `lang.schema.json`, the language files'
  schema copy, when the folder has a language file (or that copy alone
  when only it is there); a folder without either gets none;
- leaves everything else as it is: `manifest.json`, `manifest.js`
  (generated from `manifest.json`, not from the player), media, extras,
  and the apps (`<title>.app`, `<title>.exe`), which play whichever
  `index.html` sits beside them and so need no rebuild;
- prints `Kinetic <old> -> <new>`, the player version the folder had
  (its `app.js`'s stamp; `unknown` for a player built before the stamp,
  or none) and the one it has now, with `(already current)` when they
  are the same (the files are copied anyway, so a rebuilt player of the
  same version still lands), then which files it replaced;
- runs tools/validate_content.py on the folder, which prints as it does
  on its own: one line per problem on stdout, warnings on stderr. The
  folder stays upgraded when the validator reports problems: fix them
  against the newer rules and validate again.

Readers keep their progress: the player saves it in each reader's
browser under the manifest's `storyId`, not in the folder.
"""

from __future__ import annotations

import argparse
import os
import shutil
import stat
import sys
import tempfile
from pathlib import Path

from . import paths, validate_content
from .schema_copy import (
    COPY_NAME, LANG_COPY_NAME, write_lang_schema_copy, write_schema_copy)
from .version import (
    add_version_option, folder_player_version, kinetic_version)

# player/dist in a checkout, the installed wheel's copy otherwise.
DIST = paths.PLAYER_BUNDLE_DIR
# How to get a current bundle, said in a refusal.
REBUILD = ("run npm run build in player/" if paths.CHECKOUT is not None
           else "reinstall Kinetic")
VALIDATE = ("tools/validate_content.py" if paths.CHECKOUT is not None
            else "kinetic validate")
BUNDLE_NAMES = ("index.html", "app.js")
MANIFEST_NAME = "manifest.json"
TEMP_SUFFIX = ".upgrading"
# `--help`'s description, true of a checkout and an installed wheel.
DESCRIPTION = ("Upgrade a Kinetic game folder to the player this Kinetic "
               "carries (built in player/dist/ in a checkout), then "
               "validate it.")


def refuse(status: int, message: str) -> int:
    print(f"upgrade_folder: {message}", file=sys.stderr)
    return status


def dist_problem() -> str | None:
    """Why player/dist cannot be used, or None when it can."""
    for name in BUNDLE_NAMES:
        if not (DIST / name).is_file():
            return f"player/dist/{name} missing; {REBUILD}"
    built = folder_player_version(DIST)
    if built != kinetic_version():
        return (f"player/dist/app.js is Kinetic {built or 'unknown'}, not "
                f"this Kinetic's {kinetic_version()}; {REBUILD}")
    return None


def stage(source: Path, target: Path) -> Path:
    """Copy source whole to a hidden temporary file beside target, with
    target's permissions (source's when target is new); its path. Nothing
    is left behind when the copy fails."""
    fd, name = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.",
                                suffix=TEMP_SUFFIX)
    temp = Path(name)
    try:
        with os.fdopen(fd, "wb") as out, open(source, "rb") as src:
            shutil.copyfileobj(src, out)
            out.flush()
            os.fsync(out.fileno())
        mode_of = target if target.exists() else source
        os.chmod(temp, stat.S_IMODE(mode_of.stat().st_mode))
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    return temp


def replace_player(folder: Path) -> None:
    """Replace folder's index.html and app.js with player/dist's: both
    are staged before either is renamed into place."""
    staged: list[tuple[Path, Path]] = []
    try:
        for name in BUNDLE_NAMES:
            staged.append((stage(DIST / name, folder / name), folder / name))
        while staged:
            temp, target = staged[0]
            os.replace(temp, target)
            staged.pop(0)
    finally:
        for temp, _ in staged:
            temp.unlink(missing_ok=True)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog=Path(argv[0]).name,
        description=DESCRIPTION, add_help=True)
    parser.add_argument("folder", help="game folder to upgrade in place")
    add_version_option(parser)
    args = parser.parse_args(argv[1:])

    folder = Path(args.folder)
    if not folder.is_dir():
        return refuse(2, f"{folder} is not a directory")
    if not (folder / MANIFEST_NAME).is_file():
        return refuse(1, f"{folder} has no {MANIFEST_NAME}; it is not a "
                         "game folder")
    problem = dist_problem()
    if problem is not None:
        return refuse(1, problem)

    old = folder_player_version(folder) or "unknown"
    new = kinetic_version()
    try:
        replace_player(folder)
        if (folder / COPY_NAME).is_file():
            write_schema_copy(folder)
        elif (folder / LANG_COPY_NAME).is_file():
            write_lang_schema_copy(folder)
        refreshed = [name for name in (COPY_NAME, LANG_COPY_NAME)
                     if (folder / name).is_file()]
    except OSError as exc:
        return refuse(1, f"cannot write into {folder}: {exc}")

    print(f"Kinetic {old} -> {new}"
          + (" (already current)" if old == new else ""))
    print(f"{folder}: replaced {', '.join(BUNDLE_NAMES)}"
          + "".join(f" and {name}" for name in refreshed), flush=True)

    if validate_content.main([str(folder)]) != 0:
        return refuse(1, f"{folder} is upgraded, but the validator reports "
                         "problems (above); fix them and run "
                         f"{VALIDATE} {folder}")
    return 0

