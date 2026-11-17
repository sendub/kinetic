"""Kinetic's version (docs/plan.md Phase 51, item 2): the repo's VERSION
file is the source of truth, player/package.json and
converter/pyproject.toml agree with it, and each tool's `--version`
prints `Kinetic <VERSION>` and does nothing else. Run with:

    .venv/bin/pytest tools/test_release_version.py -q

The converter's own `--version` and the reader of a folder's app.js stamp
are tested in converter/tests/test_version.py.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent

# A release is X.Y.Z; between releases the version is the next one with
# `-dev` (X.Y.Z-dev).
VERSION_FORMAT = re.compile(r"\d+\.\d+\.\d+(?:-dev)?")


def pep440(version: str) -> str:
    """VERSION in the pyproject's PEP 440 spelling: `X.Y.Z-dev` is
    `X.Y.Z.dev0`; a release `X.Y.Z` is itself."""
    return re.sub(r"-dev$", ".dev0", version)


def version_file() -> str:
    return (REPO_ROOT / "VERSION").read_text(encoding="utf-8")


def test_version_file_is_one_line_in_the_release_or_dev_form() -> None:
    text = version_file()
    assert text.endswith("\n") and text.count("\n") == 1, repr(text)
    assert VERSION_FORMAT.fullmatch(text.strip()), repr(text)


def test_pep440_spelling() -> None:
    assert pep440("1.8.0-dev") == "1.8.0.dev0"
    assert pep440("1.8.0") == "1.8.0"
    assert pep440("2.10.3-dev") == "2.10.3.dev0"


def test_package_json_and_pyproject_agree_with_version() -> None:
    version = version_file().strip()
    package = json.loads((REPO_ROOT / "player" / "package.json")
                         .read_text(encoding="utf-8"))
    lock = json.loads((REPO_ROOT / "player" / "package-lock.json")
                      .read_text(encoding="utf-8"))
    pyproject = tomllib.loads((REPO_ROOT / "converter" / "pyproject.toml")
                              .read_text(encoding="utf-8"))
    assert package["version"] == version
    # The lockfile repeats the package's version.
    assert lock["version"] == lock["packages"][""]["version"] == version
    assert pyproject["project"]["version"] == pep440(version)


def test_the_distribution_is_kinetic() -> None:
    """The wheel is kinetic-<version>-py3-none-any.whl (tools/build_wheel.py),
    and the version module's metadata fallback asks for that name."""
    sys.path.insert(0, str(REPO_ROOT / "converter"))
    from kinetic_extract import version
    pyproject = tomllib.loads((REPO_ROOT / "converter" / "pyproject.toml")
                              .read_text(encoding="utf-8"))
    assert pyproject["project"]["name"] == version.DISTRIBUTION == "kinetic"


@pytest.mark.parametrize("tool", [
    "validate_content.py", "assemble_folder.py", "build_apps.py",
    "setup_media_tools.py", "upgrade_folder.py", "translations.py",
    "build_wheel.py", "publish_demo.py"])
def test_tool_version_prints_kinetic_version_and_does_nothing_else(
        tool, tmp_path) -> None:
    env = {k: v for k, v in os.environ.items()
           if k != "KINETIC_MEDIA_TOOLS_DIR"}
    proc = subprocess.run(
        [sys.executable, str(TOOLS_DIR / tool), "--version"],
        capture_output=True, text=True, cwd=tmp_path, env=env, timeout=60)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == f"Kinetic {version_file().strip()}\n"
    assert proc.stderr == ""
    # Nothing written where it ran.
    assert list(tmp_path.iterdir()) == []
