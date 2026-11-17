#!/usr/bin/env python3
"""Build Kinetic's wheel: the `kinetic` command and everything it needs
away from a checkout (docs/plan.md Phase 57, item 9; docs/packaging.md,
"Installing the tools").

Usage:

    .venv/bin/python tools/build_wheel.py [--out DIR] [--work DIR]

It builds the player afresh into a staging folder (`node
scripts/build.mjs`, what `npm run build` runs, so player/dist/ is left
alone) and checks the bundle is stamped with this checkout's VERSION;
bundles check-game with puppeteer-core into one file
(player/scripts/bundle-check.mjs); copies converter/ (pyproject.toml and
the kinetic_extract package) into the staging folder with the package
data an install reads in place of the repo, under kinetic_extract/data/:

    VERSION                         the repo's VERSION
    media-tools.json                converter/media-tools.json
    schemas/content-schema.json     docs/content-schema.json
    schemas/lang.schema.json        docs/lang.schema.json
    selftest/                       converter/tests/data/selftest/
    vendor/unrpyc/, vendor/SOURCES.md   converter/vendor/
    player/index.html, app.js       the fresh player build
    check/check-game.mjs, check-game.json   the bundled check-game

and builds `kinetic-<version>-py3-none-any.whl` into DIR (default
dist/ at the repo root) with `pip wheel --no-deps` and the build backend
converter/pyproject.toml names. The staging folder (default
.tmp/wheel-build/) is emptied first and removed afterwards. Prints the
wheel's path, size and file count.

Needs Node and player/node_modules (`npm ci --cache ../.tmp/npm-cache`
in player/). Exit status: 0 built, 1 a step failed, 2 bad arguments.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT / "converter") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "converter"))
from kinetic_extract.version import (  # noqa: E402
    add_version_option, folder_player_version, kinetic_version)

PLAYER = REPO_ROOT / "player"
CONVERTER = REPO_ROOT / "converter"
DEFAULT_OUT = REPO_ROOT / "dist"
DEFAULT_WORK = REPO_ROOT / ".tmp" / "wheel-build"
PIP_CACHE = REPO_ROOT / ".tmp" / "pip-cache"
BUNDLE_NAMES = ("index.html", "app.js")
# Package data: path under kinetic_extract/data/ -> source in the repo.
DATA_FILES = {
    "VERSION": REPO_ROOT / "VERSION",
    "media-tools.json": CONVERTER / "media-tools.json",
    "schemas/content-schema.json": REPO_ROOT / "docs" / "content-schema.json",
    "schemas/lang.schema.json": REPO_ROOT / "docs" / "lang.schema.json",
    "vendor/SOURCES.md": CONVERTER / "vendor" / "SOURCES.md",
}
DATA_TREES = {
    "selftest": CONVERTER / "tests" / "data" / "selftest",
    "vendor/unrpyc": CONVERTER / "vendor" / "unrpyc",
}
SKIP = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store")


class BuildError(Exception):
    """A step that failed, with what to do."""


def pep440(version: str) -> str:
    """VERSION as the wheel spells it: `X.Y.Z-dev` is `X.Y.Z.dev0`."""
    return re.sub(r"-dev$", ".dev0", version)


def wheel_name(version: str) -> str:
    return f"kinetic-{pep440(version)}-py3-none-any.whl"


def run(cmd: list[str], cwd: Path) -> None:
    """Run `cmd`, its output passed through; BuildError when it fails."""
    print(f"build_wheel: {' '.join(cmd)}", flush=True)
    try:
        proc = subprocess.run(cmd, cwd=cwd, check=False)
    except OSError as exc:
        raise BuildError(f"cannot run {cmd[0]}: {exc}") from None
    if proc.returncode != 0:
        raise BuildError(f"{' '.join(cmd)} failed (exit {proc.returncode})")


def check_player_tools() -> str:
    """The node to build with; BuildError without it or node_modules."""
    node = shutil.which("node")
    if node is None:
        raise BuildError("node is not on PATH; the player build needs it")
    if not (PLAYER / "node_modules" / "esbuild").is_dir():
        raise BuildError("player/node_modules is missing: run npm ci "
                         "--cache ../.tmp/npm-cache in player/ first")
    return node


def build_player(node: str, out: Path) -> None:
    """The player bundle, built fresh into `out`, stamped with VERSION."""
    run([node, "scripts/build.mjs", str(out)], PLAYER)
    built = folder_player_version(out)
    if built != kinetic_version():
        raise BuildError(f"the player build is Kinetic {built or 'unknown'}, "
                         f"not this checkout's {kinetic_version()}")


def stage(work: Path, node: str) -> Path:
    """The staging copy of converter/ with its package data; its path."""
    if work.exists():
        shutil.rmtree(work)
    src = work / "src"
    src.mkdir(parents=True)
    shutil.copyfile(CONVERTER / "pyproject.toml", src / "pyproject.toml")
    # setuptools puts LICENSE in the wheel's metadata.
    shutil.copyfile(REPO_ROOT / "LICENSE", src / "LICENSE")
    package = src / "kinetic_extract"
    shutil.copytree(CONVERTER / "kinetic_extract", package, ignore=SKIP)
    data = package / "data"
    if data.exists():
        raise BuildError(f"{CONVERTER / 'kinetic_extract' / 'data'} exists; "
                         "the package data is made here, remove it")
    for name, source in DATA_FILES.items():
        (data / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, data / name)
    for name, source in DATA_TREES.items():
        shutil.copytree(source, data / name, ignore=SKIP)
    built = work / "player-build"
    build_player(node, built)
    (data / "player").mkdir()
    for name in BUNDLE_NAMES:
        shutil.copyfile(built / name, data / "player" / name)
    run([node, "scripts/bundle-check.mjs", str(data / "check")], PLAYER)
    return src


def build_wheel(src: Path, out: Path) -> Path:
    """`pip wheel` of the staged source into `out`; the wheel's path."""
    out.mkdir(parents=True, exist_ok=True)
    wheel = out / wheel_name(kinetic_version())
    wheel.unlink(missing_ok=True)
    run([sys.executable, "-m", "pip", "wheel", "--no-deps", "--quiet",
         "--cache-dir", str(PIP_CACHE), "--wheel-dir", str(out), str(src)],
        src)
    if not wheel.is_file():
        raise BuildError(f"pip wheel did not write {wheel}")
    return wheel


def main(argv: list[str] | None = None) -> int:
    argp = argparse.ArgumentParser(
        prog="build_wheel.py",
        description="Build Kinetic's wheel (kinetic-<version>-py3-none-"
                    "any.whl) from a fresh player build.")
    argp.add_argument("--out", type=Path, default=DEFAULT_OUT, metavar="DIR",
                      help="where to write the wheel (default: dist/)")
    argp.add_argument("--work", type=Path, default=DEFAULT_WORK,
                      metavar="DIR",
                      help="staging folder, emptied first and removed "
                           "after (default: .tmp/wheel-build/)")
    add_version_option(argp)
    args = argp.parse_args(argv)
    work = args.work.resolve()
    try:
        node = check_player_tools()
        src = stage(work, node)
        wheel = build_wheel(src, args.out.resolve())
    except BuildError as exc:
        print(f"build_wheel: {exc}", file=sys.stderr)
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)
    with zipfile.ZipFile(wheel) as zf:
        count = len(zf.namelist())
    size = wheel.stat().st_size
    print(f"built {wheel}: {count} files, {size} bytes "
          f"({size / (1024 * 1024):.2f} MiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
