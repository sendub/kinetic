"""`kinetic check`: check-game, the quick check of a built game folder
(CREATE.md, "Testing your game"), run by the system Node (docs/plan.md
Phase 57, item 9).

In a checkout it runs player/scripts/testing/check-game.mjs, which needs
`npm ci` in player/ first. From an installed wheel it runs the copy
tools/build_wheel.py bundled with esbuild into one file, puppeteer-core
inside, so it needs no npm; browser profiles and crash dumps go to the
per-user cache (`KINETIC_SCRATCH_DIR`, paths.cache_dir("check")). Either
way Node must be on PATH at the version puppeteer-core needs, and the
arguments, output and exit codes are check-game's. `--help` and
`--version` answer here, without Node.

Chrome is found as check-game finds it (`KINETIC_CHROME`, else the usual
place). WebKit on macOS needs the driver: a checkout builds it from
apps/macos/driver with Swift; the bundled check-game uses a prebuilt
driver beside it (`check/kinetic-webkit-driver` in the package data)
when the wheel carries one, and otherwise tests on Chrome, saying so.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from . import paths
from .version import version_line

PROG = "kinetic check"
# check-game's scratch folder (player/scripts/testing/kinetic.mjs).
SCRATCH_ENV = "KINETIC_SCRATCH_DIR"
# Beside the bundled check-game: {"node": "<minimum version>"}.
REQUIREMENTS_NAME = "check-game.json"

USAGE = f"""\
usage: {PROG} <game-folder> [--engine webkit|chrome|auto] [--steps N|all]
           [--start-at ID] [--until ID] [--no-media-check] [--trace FILE]
           [--lang TAG]
       {PROG} --version"""

HELP = f"""{USAGE}

Play a built game folder with no window, pressing Space (taking each
choice's highlighted route) and printing what each step shows, then a
summary: items visited, media files checked, console or page errors
(check-game; CREATE.md, "Testing your game", says each option).

options:
  --engine E      webkit, chrome or auto (default: WebKit on macOS when
                  its driver is there, else Chrome)
  --steps N|all   press at most N times (default 10); all walks to the end
  --start-at ID   open the game at that item
  --until ID      walk until that item shows (exit 1 if it never does)
  --no-media-check  skip the media check after the walk
  --trace FILE    write the player's item trace to FILE (JSON lines)
  --lang TAG      walk with that game language shown
  --version       print Kinetic's version and exit

Needs Node.js {{node}} or later on PATH and Chrome (KINETIC_CHROME names
another browser). Exit codes: 0 passed; 1 errors, a stuck player or a
check that could not run; 2 bad arguments; 3 items never shown."""


class CheckError(Exception):
    """Why check-game cannot run here, said plainly."""


def parse_version(text: str) -> tuple[int, ...] | None:
    """`v22.12.0`, `>=22.12.0` or `22.12` as (22, 12, 0), else None."""
    found = re.search(r"(\d+)(?:\.(\d+))?(?:\.(\d+))?", text)
    if found is None:
        return None
    return tuple(int(part or 0) for part in found.groups())


def show(version: tuple[int, ...]) -> str:
    return ".".join(str(part) for part in version)


def required_node(script: Path = paths.CHECK_GAME,
                  checkout: Path | None = paths.CHECKOUT) -> tuple[int, ...]:
    """The oldest Node check-game runs on: puppeteer-core's `engines`
    (the checkout's node_modules, or the file the bundle carries)."""
    if checkout is not None:
        source = (checkout / "player" / "node_modules" / "puppeteer-core"
                  / "package.json")
        key = ("engines", "node")
    else:
        source = script.parent / REQUIREMENTS_NAME
        key = ("node",)
    try:
        value = json.loads(source.read_text("utf-8"))
        for name in key:
            value = value[name]
    except (OSError, ValueError, KeyError, TypeError):
        raise CheckError(f"cannot read the Node version check-game needs "
                         f"from {source}") from None
    version = parse_version(str(value))
    if version is None:
        raise CheckError(f"{source} names no Node version: {value!r}")
    return version


def node_version(node: str) -> tuple[int, ...] | None:
    """What `node --version` reports, else None."""
    try:
        proc = subprocess.run([node, "--version"], capture_output=True,
                              text=True, timeout=30, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_version(proc.stdout) if proc.returncode == 0 else None


def find_node(need: tuple[int, ...], which=None, version_of=None) -> str:
    """The `node` on PATH, when it is at least `need` (`which` and
    `version_of` stand in for shutil.which and node_version in tests)."""
    node = (which or shutil.which)("node")
    wanted = f"Node.js {show(need)} or later"
    if node is None:
        raise CheckError(f"{PROG} needs {wanted} on PATH, and there is no "
                         "node: install it from https://nodejs.org")
    have = (version_of or node_version)(node)
    if have is None or have < need:
        raise CheckError(
            f"{PROG} needs {wanted}; {node} is "
            f"{'of unknown version' if have is None else show(have)}: "
            "install a newer one from https://nodejs.org")
    return node


def command(argv: list[str], node: str, script: Path = paths.CHECK_GAME,
            checkout: Path | None = paths.CHECKOUT,
            env: dict[str, str] | None = None
            ) -> tuple[list[str], dict[str, str]]:
    """check-game's command line and environment."""
    env = dict(os.environ if env is None else env)
    if checkout is None:
        env.setdefault(SCRATCH_ENV, str(paths.cache_dir("check", None)))
    return [node, str(script), *argv], env


def preflight(script: Path = paths.CHECK_GAME,
              checkout: Path | None = paths.CHECKOUT) -> None:
    """Refuse (CheckError) when check-game or what it imports is missing."""
    if not script.is_file():
        raise CheckError(
            f"check-game is missing ({script})"
            + ("" if checkout is not None else "; reinstall Kinetic"))
    if checkout is not None and not (
            checkout / "player" / "node_modules" / "puppeteer-core").is_dir():
        raise CheckError("player/node_modules is missing: run npm ci "
                         "--cache ../.tmp/npm-cache in player/ first")


def main(argv: list[str]) -> int:
    if "--version" in argv:
        print(version_line())
        return 0
    try:
        need = required_node()
        if argv in (["--help"], ["-h"]):
            print(HELP.replace("{node}", show(need)))
            return 0
        preflight()
        node = find_node(need)
    except CheckError as exc:
        if argv in (["--help"], ["-h"]):
            print(HELP.replace("Node.js {node} or later", "Node.js"))
        print(f"{PROG}: {exc}", file=sys.stderr)
        return 1
    cmd, env = command(argv, node)
    try:
        return subprocess.run(cmd, env=env, check=False).returncode
    except KeyboardInterrupt:
        return 130
