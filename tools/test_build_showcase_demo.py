"""Tests for fixtures/build_showcase_demo.py, the story the README's
screenshots come from (player/scripts/screenshots.mjs). Run with:

    .venv/bin/python -m pytest tools/test_build_showcase_demo.py -q

The output is gitignored, so this builds from scratch into a temporary
folder, as tools/test_build_demo.py does for the demo.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
BUILD = REPO_ROOT / "fixtures" / "build_showcase_demo.py"

if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import validate_content  # noqa: E402


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("fresh") / "showcase-demo"
    proc = subprocess.run(
        [sys.executable, str(BUILD), "--out", str(out)],
        cwd=REPO_ROOT, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return out


def test_fresh_build_validates_with_no_warning(built: Path) -> None:
    assert validate_content.validate_folder(built) == []
    check = subprocess.run(
        [sys.executable, str(TOOLS_DIR / "validate_content.py"), str(built)],
        cwd=REPO_ROOT, capture_output=True, text=True)
    assert (check.returncode, check.stdout, check.stderr) == (0, "", "")


def test_the_shape_the_screenshots_read(built: Path) -> None:
    """The screenshot script walks these ids with Play all routes on, which
    plays the shorter route of a decision first: "town" before "cliff" at
    the fork, and "leave" (an ending, where it stops) at the festival."""
    manifest = json.loads((built / "manifest.json").read_text(
        encoding="utf-8"))
    ids = [item["id"] for item in manifest["items"]]
    length = {}
    for branch in manifest["branches"]:
        for route in branch["routes"]:
            length[route["id"]] = (ids.index(route["end"])
                                   - ids.index(route["start"]) + 1)
    assert [b["id"] for b in manifest["branches"]] == [
        "fork", "festival", "confession"]
    assert length["by-town"] < length["by-cliff"]
    assert length["take-boat"] < length["stay-on"]
    items = {item["id"]: item for item in manifest["items"]}
    assert items["open-2"]["speaker"] in manifest["characters"]
    assert "{i}" in items["open-2"]["text"]
    assert "{b}" in items["open-2"]["text"]
