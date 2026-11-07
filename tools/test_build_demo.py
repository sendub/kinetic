"""Tests for fixtures/build_demo.py. Run with:

    .venv/bin/python -m pytest tools/ -q

fixtures/demo is gitignored, and the validator tests reuse it when it is
present, so a builder that no longer runs went unnoticed in existing
checkouts. This test always builds from scratch into a temporary folder.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
BUILD_DEMO = REPO_ROOT / "fixtures" / "build_demo.py"

if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import validate_content  # noqa: E402


def test_fresh_build_exits_zero_and_validates(tmp_path: Path) -> None:
    out = tmp_path / "demo"
    proc = subprocess.run(
        [sys.executable, str(BUILD_DEMO), "--out", str(out)],
        cwd=REPO_ROOT, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert validate_content.validate_folder(out) == []
