"""Upgrade a Kinetic game folder to the player this Kinetic carries
(docs/plan.md Phase 51, item 6; `--to` and `--dry-run`, Phase 58 item 3).

Usage:

    kinetic upgrade <folder> [--to NEW] [--dry-run]
    python tools/upgrade_folder.py <folder> ...   (the same, from a checkout)

In a checkout, run it after building the player of the Kinetic you want:

    git pull
    cd player && npm ci --cache ../.tmp/npm-cache && npm run build && cd ..
    .venv/bin/python tools/upgrade_folder.py my-novel

An installed Kinetic (docs/packaging.md, "Installing the tools") carries
its built player, so `kinetic upgrade my-novel` after installing the
release you want is enough; what this says of `player/dist/` holds for
that copy.

Exit status: 0 when the folder (or NEW) is upgraded and the validator
passes (its warnings are printed and do not change that), 1 when the
upgrade is refused, a file cannot be written, or the upgraded folder has
validator problems, 2 when the arguments are unusable: the folder is not
a directory, or NEW cannot be used (below). A dry run exits as the
validator finds the folder as it is, after the same refusals.

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

`--to NEW` upgrades a copy of the folder made at NEW and only reads the
folder: no file in it is written and its folders' times stay as they
were. It is for a folder too big to copy whole and too precious to
upgrade untested:

- it refuses, writing nothing and with exit 2, a NEW that already exists
  (a broken symbolic link included), is the folder, lies inside it or
  holds it, whose parent folder does not exist, or that is on another
  volume than the folder: hard links cannot cross volumes. Then come the
  refusals of a plain upgrade (exit 1), and a `manifest.json` that does
  not read as a JSON object (exit 1, since the copy needs its media
  list), all before anything is copied;
- it builds the copy in a hidden temporary folder beside NEW
  (`.NEW.<random>.upgrading`). Every media file the manifest and its
  listed language files name (pictures, animation frames, videos,
  posters, sound tracks, voice clips and recorded lines with their audio
  scripts) is hard-linked: NEW's copy shares the original's storage and
  costs no space. Every other file is copied with its permissions and
  times: `manifest.json`, `manifest.js`, the language files, the player,
  schema copies, extras, files nothing names, and the apps, whose
  bundles keep their symbolic links and modes so a Mac app's signature
  still verifies. The player, the schema copies, `manifest.json` and
  `manifest.js` are never linked, whatever the manifest names. A
  symbolic link anywhere in the folder is made again as the same link
  (the same target text, so a relative link out of the folder points
  wherever that text leads from NEW). Folders keep their permissions,
  made readable and writable by their owner;
- it upgrades the temporary folder as a plain upgrade does and renames
  it to NEW only then, so a failure (a full disk, a file it cannot read)
  or an interrupt (Ctrl-C) removes it and leaves no NEW; only a process
  killed outright can leave the hidden folder, which is safe to delete;
- it prints `NEW: a copy of <folder>, <n> media files hard-linked and
  <m> other files copied` (symbolic links count as copied), then the
  lines a plain upgrade prints for NEW, and validates NEW, with the same
  exit status.

Because NEW's media share storage with the folder's, editing a media
file in place in NEW (rather than replacing it with a new file) changes
the original too. The upgrade itself never writes a media file.

`--dry-run`, with or without `--to`, refuses as the upgrade would, then
prints `Dry run: nothing is written.`, with `--to` the line `NEW: would
be a copy of ...` with the counts the copy would have, the `Kinetic
<old> -> <new>` line, and `<folder or NEW>: would replace ...` naming
the files the upgrade would replace. It then runs the validator on the
folder as it is (old player, current rules) and writes nothing anywhere.

Readers keep their progress: the player saves it in each reader's
browser under the manifest's `storyId`, not in the folder.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import sys
import tempfile
from pathlib import Path

from . import paths, report, validate_content
from .schema_copy import (
    COPY_NAME, COPY_NAMES, LANG_COPY_NAME, has_language_files,
    write_lang_schema_copy, write_schema_copy)
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
SHIM_NAME = "manifest.js"
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


def refreshed_copies(folder: Path) -> list[str]:
    """The schema copies the upgrade leaves in folder, refreshed: the
    manifest's copy when there is one (with the language files' copy
    when the folder has a language file), or the language copy alone."""
    manifest_copy = (folder / COPY_NAME).is_file()
    lang_copy = (folder / LANG_COPY_NAME).is_file() or (
        manifest_copy and has_language_files(folder))
    return [name for name, present in ((COPY_NAME, manifest_copy),
                                       (LANG_COPY_NAME, lang_copy))
            if present]


def upgrade_files(folder: Path) -> list[str]:
    """Replace folder's player and refresh its schema copies; the schema
    copies refreshed. Raises OSError."""
    refreshed = refreshed_copies(folder)
    replace_player(folder)
    if (folder / COPY_NAME).is_file():
        write_schema_copy(folder)
    elif (folder / LANG_COPY_NAME).is_file():
        write_lang_schema_copy(folder)
    return refreshed


def replaced(refreshed: list[str]) -> str:
    return ", ".join(BUNDLE_NAMES) + "".join(f" and {name}"
                                             for name in refreshed)


def files(count: int, kind: str) -> str:
    return f"{count} {kind}file{'' if count == 1 else 's'}"


# --- --to NEW ---------------------------------------------------------------

def volume(path: Path) -> int:
    """The device path is on (a hard link cannot cross devices)."""
    return os.stat(path).st_dev


def target_problem(folder: Path, new: Path) -> str | None:
    """Why NEW cannot be the folder's copy, or None when it can."""
    absolute = Path(os.path.abspath(new))
    parent = absolute.parent
    if not parent.is_dir():
        return (f"{new.parent} does not exist; make it first or choose "
                "another --to")
    here = folder.resolve()
    there = parent.resolve() / absolute.name
    if there == here:
        return f"{new} is the folder itself; --to names a new folder"
    if here in there.parents:
        return f"{new} is inside {folder}; --to names a folder outside it"
    if there in here.parents:
        return f"{folder} is inside {new}; --to names a new folder"
    if os.path.lexists(new):
        return f"{new} already exists; --to makes a new folder"
    if volume(parent) != volume(folder):
        return (f"{new} would be on another volume than {folder}, and hard "
                "links cannot cross volumes; choose a --to on the same "
                "volume (nothing written)")
    return None


class Copy:
    """What --to puts in NEW, in walk order: (relative path, how), how
    being "dir", "link" (hard link), "copy" or "symlink"."""

    def __init__(self, folder: Path, media: set[str]) -> None:
        self.entries: list[tuple[str, str]] = []
        self._walk(folder, "", media)
        self.linked = sum(how == "link" for _, how in self.entries)
        self.copied = sum(how in ("copy", "symlink")
                          for _, how in self.entries)

    def _walk(self, root: Path, prefix: str, media: set[str]) -> None:
        with os.scandir(root / prefix if prefix else root) as found:
            entries = sorted(found, key=lambda entry: entry.name)
        for entry in entries:
            rel = f"{prefix}{entry.name}"
            if entry.is_symlink():
                self.entries.append((rel, "symlink"))
            elif entry.is_dir(follow_symlinks=False):
                self.entries.append((rel, "dir"))
                self._walk(root, f"{rel}/", media)
            elif entry.is_file(follow_symlinks=False):
                linked = rel in media and rel not in NEVER_LINKED
                self.entries.append((rel, "link" if linked else "copy"))
            else:
                raise OSError(f"{root / rel} is not a file, folder or "
                              "symbolic link; it cannot be copied")

    def make(self, folder: Path, into: Path) -> None:
        """Fill the empty folder into. Raises OSError."""
        for rel, how in self.entries:
            source, target = folder / rel, into / rel
            if how == "dir":
                target.mkdir()
                os.chmod(target, writable_dir_mode(source))
            elif how == "symlink":
                os.symlink(os.readlink(source), target)
            elif how == "link":
                os.link(source, target, follow_symlinks=False)
            else:
                shutil.copy2(source, target, follow_symlinks=False)


# The files a plain upgrade writes, and the manifest and its shim: never
# hard-linked, whatever the manifest names, so writing NEW's never
# writes the folder's.
NEVER_LINKED = frozenset((*BUNDLE_NAMES, *COPY_NAMES, MANIFEST_NAME,
                          SHIM_NAME))


def writable_dir_mode(source: Path) -> int:
    """source's permissions, always readable and writable by the owner,
    so the copy can be filled, upgraded and removed."""
    return stat.S_IMODE(source.stat().st_mode) | stat.S_IRWXU


def remove_tree(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


def read_media(folder: Path) -> set[str]:
    """The media files folder's manifest and language files name. Raises
    ValueError when manifest.json does not read as a JSON object."""
    try:
        manifest = json.loads((folder / MANIFEST_NAME)
                              .read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise ValueError(f"cannot read {folder / MANIFEST_NAME} to find its "
                         f"media: {exc}") from exc
    if not isinstance(manifest, dict):
        raise ValueError(f"cannot read {folder / MANIFEST_NAME} to find its "
                         "media: it is not a JSON object")
    return report.media_files(folder, manifest)


def make_copy(folder: Path, new: Path, plan: Copy) -> list[str]:
    """Build NEW as an upgraded copy of folder in a hidden temporary
    folder beside it, renamed to NEW once complete; the schema copies
    refreshed. On any failure or interrupt the temporary folder is
    removed, leaving no NEW. Raises OSError."""
    absolute = Path(os.path.abspath(new))
    temp = Path(tempfile.mkdtemp(dir=absolute.parent,
                                 prefix=f".{absolute.name}.",
                                 suffix=TEMP_SUFFIX))
    try:
        os.chmod(temp, writable_dir_mode(folder))
        plan.make(folder, temp)
        refreshed = upgrade_files(temp)
        if os.path.lexists(absolute):
            raise FileExistsError(f"{new} appeared while copying")
        os.rename(temp, absolute)
    except BaseException:
        remove_tree(temp)
        raise
    return refreshed


def validate(folder: Path, problem: str) -> int:
    if validate_content.main([str(folder)]) != 0:
        return refuse(1, problem)
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog=Path(argv[0]).name,
        description=DESCRIPTION, add_help=True)
    parser.add_argument("folder", help="game folder to upgrade (in place "
                                       "unless --to is given)")
    parser.add_argument("--to", metavar="NEW", type=Path,
                        help="upgrade a copy made at NEW instead (a new "
                             "folder on the same volume: media files "
                             "hard-linked, the rest copied); the folder "
                             "is only read")
    parser.add_argument("--dry-run", action="store_true",
                        help="say what the upgrade would do and validate "
                             "the folder as it is, writing nothing")
    add_version_option(parser)
    args = parser.parse_args(argv[1:])

    folder = Path(args.folder)
    new: Path | None = args.to
    if not folder.is_dir():
        return refuse(2, f"{folder} is not a directory")
    if new is not None:
        problem = target_problem(folder, new)
        if problem is not None:
            return refuse(2, problem)
    if not (folder / MANIFEST_NAME).is_file():
        return refuse(1, f"{folder} has no {MANIFEST_NAME}; it is not a "
                         "game folder")
    problem = dist_problem()
    if problem is not None:
        return refuse(1, problem)
    plan = None
    if new is not None:
        try:
            plan = Copy(folder, read_media(folder))
        except (OSError, ValueError) as exc:
            return refuse(1, str(exc))

    old = folder_player_version(folder) or "unknown"
    version = (f"Kinetic {old} -> {kinetic_version()}"
               + (" (already current)" if old == kinetic_version() else ""))
    copied = None if plan is None else (
        f"a copy of {folder}, {files(plan.linked, 'media ')} hard-linked "
        f"and {files(plan.copied, 'other ')} copied")
    upgraded = folder if new is None else new

    if args.dry_run:
        print("Dry run: nothing is written.")
        if copied is not None:
            print(f"{new}: would be {copied}")
        print(version)
        print(f"{upgraded}: would replace "
              f"{replaced(refreshed_copies(folder))}", flush=True)
        return validate(folder, f"dry run: {folder} as it is has validator "
                                "problems (above)")

    try:
        if plan is None:
            refreshed = upgrade_files(folder)
        else:
            refreshed = make_copy(folder, new, plan)
    except OSError as exc:
        if new is None:
            return refuse(1, f"cannot write into {folder}: {exc}")
        return refuse(1, f"cannot make {new}: {exc}; nothing written")

    if copied is not None:
        print(f"{new}: {copied}")
    print(version)
    print(f"{upgraded}: replaced {replaced(refreshed)}", flush=True)
    return validate(upgraded, f"{upgraded} is upgraded, but the validator "
                              "reports problems (above); fix them and run "
                              f"{VALIDATE} {upgraded}")
