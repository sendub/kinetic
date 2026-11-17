"""Kinetic's version (docs/plan.md Phase 51, item 2), for `--version` on
the converter and tools/, and the player version a game folder's app.js
is stamped with.

Kinetic's version is the repo's VERSION file, one line: `X.Y.Z` for a
release, `X.Y.Z-dev` between releases. The converter is installed
editable from this clone, so reading the file directly stays right after
VERSION changes, with no reinstall; an installed wheel carries a copy as
package data (`paths`), and the package metadata (converter/pyproject.toml,
PEP 440 `X.Y.Z.dev0`) answers when neither is there. The media ledger's `kinetic-extract`
entry is the package's own `__version__`, not this, so a new Kinetic
release neither empties the media cache nor stops `kinetic-media rebuild`
matching an existing ledger.

A built player's app.js opens with the stamp line `/*! Kinetic <version>
*/` (player/scripts/version.mjs writes it; its readStamp reads it the
same way): exactly that, as the file's first line, the version made of
letters, digits and `.+-`. An app.js without it, from a player built
before the stamp, reads as unknown (None).
"""

from __future__ import annotations

import argparse
import re
from importlib import metadata
from pathlib import Path

from . import paths

VERSION_FILE = paths.resource("VERSION", "VERSION")
DISTRIBUTION = "kinetic"
STAMP = re.compile(r"/\*! Kinetic ([0-9A-Za-z.+-]+) \*/\n")
# The stamp is the first line; this much of app.js always holds it.
STAMP_BYTES = 256


def kinetic_version() -> str:
    """Kinetic's version: the repo's VERSION, else the package metadata
    with `X.Y.Z.devN` written as `X.Y.Z-dev`."""
    try:
        return VERSION_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return re.sub(r"\.dev\d+$", "-dev", metadata.version(DISTRIBUTION))


def version_line() -> str:
    """What `--version` prints: `Kinetic <version>`."""
    return f"Kinetic {kinetic_version()}"


def add_version_option(parser: argparse.ArgumentParser) -> None:
    """`--version`: print version_line() and exit 0 before anything else
    runs (argparse acts on it as it parses)."""
    parser.add_argument("--version", action="version", version=version_line(),
                        help="print Kinetic's version and exit")


def stamped_version(app_js: str) -> str | None:
    """The player version app.js's stamp line names, else None."""
    found = STAMP.match(app_js)
    return None if found is None else found.group(1)


def folder_player_version(folder: Path) -> str | None:
    """The player version of the game folder `folder` (its app.js's
    stamp), else None: no app.js, or one without the stamp."""
    try:
        with open(Path(folder) / "app.js", "rb") as fh:
            # The stamp is ASCII; a character cut at the end does not matter.
            head = fh.read(STAMP_BYTES).decode("utf-8", errors="replace")
    except OSError:
        return None
    return stamped_version(head)
