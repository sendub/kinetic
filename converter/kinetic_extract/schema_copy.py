"""The content schema copy beside a folder's manifest.json (docs/plan.md
Phase 51, item 5).

kinetic-extract writes `manifest.schema.json`, a byte copy of
docs/content-schema.json, into every content folder and opens the
manifest with `"$schema": "./manifest.schema.json"`, so VS Code and
JetBrains editors check and complete a hand-edited manifest.json offline,
against the schema of the Kinetic that wrote the folder.
tools/assemble_folder.py leaves the copy out of the folder readers get;
the upgrade command refreshes it with `write_schema_copy`.

The schema is read from this clone, as `media_tools` reads
converter/media-tools.json: the converter is installed editable from the
repo (AGENTS.md), and an install made away from it has no docs/.
"""

from __future__ import annotations

import shutil
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_FILE = REPO_ROOT / "docs" / "content-schema.json"
COPY_NAME = "manifest.schema.json"
SCHEMA_REF = f"./{COPY_NAME}"


def write_schema_copy(folder: Path) -> Path:
    """Write (or replace) `folder`'s manifest.schema.json with the
    current schema, byte for byte; returns its path."""
    target = Path(folder) / COPY_NAME
    shutil.copyfile(SCHEMA_FILE, target)
    return target
