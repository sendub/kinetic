"""The schema copy and `$schema` (docs/plan.md Phase 51, item 5).

kinetic-extract writes `manifest.schema.json`, a byte copy of
docs/content-schema.json, beside `manifest.json`, and the manifest's first
key is `"$schema": "./manifest.schema.json"`, so an editor checks a
hand-edited manifest.json offline against the schema of the Kinetic that
wrote the folder.
"""

from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator, validators

from kinetic_extract import schema_copy
from kinetic_extract.cli import main as cli_main

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA = REPO_ROOT / "docs" / "content-schema.json"
SCRIPT = 'label start:\n    "Hello."\n    return\n'
SHIM_PREFIX = "window.KINETIC_MANIFEST = "


def extract(tmp_path: Path) -> Path:
    game = tmp_path / "Folder" / "game"
    game.mkdir(parents=True)
    (game / "script.rpy").write_text(SCRIPT, encoding="utf-8")
    out = tmp_path / "out"
    assert cli_main([str(game.parent), str(out)]) == 0
    return out


def test_the_names_are_the_ones_the_docs_give() -> None:
    assert schema_copy.COPY_NAME == "manifest.schema.json"
    assert schema_copy.SCHEMA_REF == "./manifest.schema.json"
    assert schema_copy.SCHEMA_FILE == SCHEMA


def test_the_manifest_names_the_copy_first(tmp_path: Path) -> None:
    out = extract(tmp_path)
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    assert list(manifest)[:2] == ["$schema", "schemaVersion"]
    assert manifest["$schema"] == "./manifest.schema.json"
    shim = (out / "manifest.js").read_text("utf-8")
    assert json.loads(shim[len(SHIM_PREFIX):-2]) == manifest
    assert list(json.loads(shim[len(SHIM_PREFIX):-2]))[0] == "$schema"


def test_the_copy_is_the_schema_byte_for_byte(tmp_path: Path) -> None:
    out = extract(tmp_path)
    copy = out / "manifest.schema.json"
    assert copy.read_bytes() == SCHEMA.read_bytes()


def test_the_copy_is_a_json_schema_the_manifest_passes(
        tmp_path: Path) -> None:
    out = extract(tmp_path)
    schema = json.loads((out / "manifest.schema.json").read_text("utf-8"))
    # The validator's own choice of class (tools/validate_content.py).
    cls = validators.validator_for(schema, default=Draft202012Validator)
    assert cls is Draft202012Validator
    cls.check_schema(schema)  # raises SchemaError when not a JSON Schema
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    assert list(cls(schema).iter_errors(manifest)) == []


def test_write_schema_copy_replaces_an_old_copy(tmp_path: Path) -> None:
    """The upgrade command (item 6) refreshes a folder's copy with it."""
    (tmp_path / "manifest.schema.json").write_text("{}\n", encoding="utf-8")
    written = schema_copy.write_schema_copy(tmp_path)
    assert written == tmp_path / "manifest.schema.json"
    assert written.read_bytes() == SCHEMA.read_bytes()
