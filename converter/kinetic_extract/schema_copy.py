"""The schema copies beside a folder's manifest.json (docs/plan.md
Phase 51, item 5; Phase 56, item 8).

kinetic-extract writes `manifest.schema.json`, a byte copy of
docs/content-schema.json, into every content folder and opens the
manifest with `"$schema": "./manifest.schema.json"`, so VS Code and
JetBrains editors check and complete a hand-edited manifest.json offline,
against the schema of the Kinetic that wrote the folder.
tools/assemble_folder.py leaves the copy out of the folder readers get;
the upgrade command refreshes it with `write_schema_copy`.

A folder with language files (`lang/*.json`, docs/content-format.md,
"Translations") gets `lang.schema.json` beside it too, a byte copy of
docs/lang.schema.json: `write_schema_copy` writes it whenever the folder
has a language file, and a language file in such a folder opens with
`"$schema": "../lang.schema.json"` (LANG_SCHEMA_REF, relative to the
language file), as tools/translations.py writes it when the manifest
names its own copy. The assemble and upgrade tools treat it as they
treat the manifest's.

The schemas are read from this clone, as `media_tools` reads
converter/media-tools.json: the converter is installed editable from the
repo (AGENTS.md), and an install made away from it has no docs/.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from . import language_file

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_FILE = REPO_ROOT / "docs" / "content-schema.json"
COPY_NAME = "manifest.schema.json"
SCHEMA_REF = f"./{COPY_NAME}"
LANG_SCHEMA_FILE = REPO_ROOT / "docs" / "lang.schema.json"
LANG_COPY_NAME = "lang.schema.json"
LANG_SCHEMA_REF = f"../{LANG_COPY_NAME}"
COPY_NAMES = (COPY_NAME, LANG_COPY_NAME)


def has_language_files(folder: Path) -> bool:
    """Whether `folder` holds a language file, lang/<anything>.json."""
    lang = Path(folder) / language_file.LANG_DIR
    return lang.is_dir() and any(p.is_file() for p in lang.glob("*.json"))


def write_lang_schema_copy(folder: Path) -> Path:
    """Write (or replace) `folder`'s lang.schema.json with the current
    language file schema, byte for byte; returns its path."""
    target = Path(folder) / LANG_COPY_NAME
    shutil.copyfile(LANG_SCHEMA_FILE, target)
    return target


def write_schema_copy(folder: Path) -> Path:
    """Write (or replace) `folder`'s manifest.schema.json with the
    current schema, byte for byte, and its lang.schema.json too when the
    folder has a language file; returns the manifest copy's path."""
    target = Path(folder) / COPY_NAME
    shutil.copyfile(SCHEMA_FILE, target)
    if has_language_files(folder):
        write_lang_schema_copy(folder)
    return target
