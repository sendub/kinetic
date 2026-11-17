"""Tests for fixtures/build_demo.py. Run with:

    .venv/bin/python -m pytest tools/ -q

fixtures/demo is gitignored, and the validator tests reuse it when it is
present, so a builder that no longer runs went unnoticed in existing
checkouts. This test always builds from scratch into a temporary folder.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
BUILD_DEMO = REPO_ROOT / "fixtures" / "build_demo.py"

if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import validate_content  # noqa: E402


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("fresh") / "demo"
    proc = subprocess.run(
        [sys.executable, str(BUILD_DEMO), "--out", str(out)],
        cwd=REPO_ROOT, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return out


def test_fresh_build_validates_with_no_warning(built: Path) -> None:
    assert validate_content.validate_folder(built) == []
    check = subprocess.run(
        [sys.executable, str(TOOLS_DIR / "validate_content.py"), str(built)],
        cwd=REPO_ROOT, capture_output=True, text=True)
    assert (check.returncode, check.stdout, check.stderr) == (0, "", "")


def test_the_demo_shows_phase_57s_presentation(built: Path) -> None:
    """A speaker with colours, a line with {i} and {b}, a dissolve and a
    fade (docs/plan.md Phase 57 item 1)."""
    manifest = json.loads((built / "manifest.json").read_text(
        encoding="utf-8"))
    items = {item["id"]: item for item in manifest["items"]}
    assert set(manifest["characters"]["Ines"]) == {"nameColor", "textColor"}
    assert items["look-speaker"]["speaker"] == "Ines"
    assert "{i}" in items["look-tags"]["text"]
    assert "{b}" in items["look-tags"]["text"]
    assert items["look-dissolve"]["transition"]["kind"] == "dissolve"
    assert items["look-fade"]["transition"]["kind"] == "fade"
    ids = [item["id"] for item in manifest["items"]]
    # Between range-b and floor-title, which the scenarios walk by id.
    assert ids[ids.index("range-b") + 1] == "look-dissolve"
    assert ids[ids.index("floor-title") - 1] == "look-fade"
