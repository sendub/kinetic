"""Tests for tools/validate_content.py.

The passing case runs against the real fixtures/demo; each fault test copies
that folder to a temporary directory, breaks one thing, and requires the
validator to report exactly that problem. Run with:

    .venv/bin/python -m pytest tools/ -q
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
DEMO_DIR = REPO_ROOT / "fixtures" / "demo"
BUILD_DEMO = REPO_ROOT / "fixtures" / "build_demo.py"
VALIDATOR = TOOLS_DIR / "validate_content.py"
SCHEMA = REPO_ROOT / "docs" / "content-schema.json"

if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import validate_content  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def demo() -> Path:
    """fixtures/demo, built by fixtures/build_demo.py if it is absent."""
    if not (DEMO_DIR / "manifest.json").is_file():
        proc = subprocess.run([sys.executable, str(BUILD_DEMO)],
                              capture_output=True, text=True)
        if proc.returncode != 0:
            pytest.fail(f"build_demo.py failed (exit {proc.returncode}):\n"
                        f"{proc.stdout}{proc.stderr}")
    return DEMO_DIR


@pytest.fixture
def folder(demo: Path, tmp_path: Path) -> Path:
    """A throwaway copy of the demo folder."""
    copy = tmp_path / "novel"
    shutil.copytree(demo, copy)
    return copy


def read_manifest(folder: Path) -> dict[str, Any]:
    return json.loads((folder / "manifest.json").read_text(encoding="utf-8"))


def write_manifest(folder: Path, manifest: dict[str, Any]) -> None:
    """Write manifest.json and its shim the way the fixture builder does."""
    text = json.dumps(manifest, indent=2, ensure_ascii=True)
    (folder / "manifest.json").write_text(text + "\n", encoding="utf-8")
    (folder / "manifest.js").write_text(
        validate_content.SHIM_PREFIX + text + ";\n", encoding="utf-8")


def problems_of(folder: Path) -> list[str]:
    return validate_content.validate_folder(folder, SCHEMA)


def run_cli(folder: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(VALIDATOR), str(folder)],
                          capture_output=True, text=True)


# ---------------------------------------------------------------------------
# Passing case
# ---------------------------------------------------------------------------

def test_demo_folder_passes(demo: Path) -> None:
    assert problems_of(demo) == []


def test_cli_exits_zero_and_prints_nothing_on_demo(demo: Path) -> None:
    proc = run_cli(demo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout == ""


def test_player_bundle_is_optional(folder: Path) -> None:
    """A folder without index.html/app.js is still valid input for tools."""
    assert not (folder / "index.html").exists()
    assert problems_of(folder) == []


# ---------------------------------------------------------------------------
# Fault tests: one deliberate defect each, exactly one problem reported
# ---------------------------------------------------------------------------

def test_corrupted_schema_version(folder: Path) -> None:
    manifest = read_manifest(folder)
    manifest["schemaVersion"] = 2
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: schemaVersion:")
    assert "schemaVersion" in problems[0]


def test_missing_media_file(folder: Path) -> None:
    name = read_manifest(folder)["items"][0]["file"]
    (folder / name).unlink()
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[0].file:")
    assert name in problems[0] and "does not exist" in problems[0]


def test_missing_animation_frame(folder: Path) -> None:
    frames = read_manifest(folder)["items"][4]["frames"]
    (folder / frames[2]).unlink()
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[4].frames[2]:")


def test_duplicate_item_id(folder: Path) -> None:
    manifest = read_manifest(folder)
    first_id = manifest["items"][0]["id"]
    manifest["items"][1]["id"] = first_id
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[1].id:")
    assert "duplicate id" in problems[0] and first_id in problems[0]


def test_manifest_js_differs_from_manifest_json(folder: Path) -> None:
    """Only the shim changes: same shape, different content."""
    manifest = read_manifest(folder)
    manifest["width"] = 640
    (folder / "manifest.js").write_text(
        validate_content.SHIM_PREFIX
        + json.dumps(manifest, indent=2, ensure_ascii=True) + ";\n",
        encoding="utf-8")
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.js:")
    assert "does not equal manifest.json" in problems[0]
    assert "width" in problems[0]


def test_manifest_js_must_be_equal_json_not_bytes(folder: Path) -> None:
    """Invariant 5 compares parsed JSON, so formatting may differ."""
    manifest = read_manifest(folder)
    (folder / "manifest.js").write_text(
        validate_content.SHIM_PREFIX
        + json.dumps(manifest, sort_keys=True, separators=(",", ":")) + ";\n",
        encoding="utf-8")
    assert problems_of(folder) == []


def test_manifest_js_needs_the_shim_assignment(folder: Path) -> None:
    text = (folder / "manifest.js").read_text(encoding="utf-8")
    (folder / "manifest.js").write_text("KINETIC_MANIFEST = "
                                        + text[len(validate_content.SHIM_PREFIX):],
                                        encoding="utf-8")
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.js:")
    assert validate_content.SHIM_PREFIX in problems[0]


def test_manifest_js_must_be_valid_json(folder: Path) -> None:
    (folder / "manifest.js").write_text(
        validate_content.SHIM_PREFIX + "{oops};\n", encoding="utf-8")
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.js:")
    assert "invalid" in problems[0]


def test_absolute_path_in_media_field(folder: Path) -> None:
    manifest = read_manifest(folder)
    name = manifest["items"][0]["file"]
    manifest["items"][0]["file"] = f"/{name}"
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[0].file:")
    assert "relative to the content folder" in problems[0]


def test_parent_segment_in_media_path_is_rejected(folder: Path) -> None:
    manifest = read_manifest(folder)
    name = manifest["items"][3]["file"]
    (folder / name).rename(folder / f"sub-{name}")
    manifest["items"][3]["file"] = f"sub/../sub-{name}"
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[3].file:")
    assert '".." segments' in problems[0]


def test_frames_below_minimum(folder: Path) -> None:
    manifest = read_manifest(folder)
    frames = manifest["items"][4]["frames"]
    manifest["items"][4]["frames"] = frames[:1]
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[4].frames:")
    assert "at least 2 entries" in problems[0]


def test_unknown_item_type(folder: Path) -> None:
    manifest = read_manifest(folder)
    manifest["items"][2]["type"] = "banana"
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[2].type:")
    assert "image, animation, video" in problems[0]


def test_wrong_media_extension(folder: Path) -> None:
    manifest = read_manifest(folder)
    name = read_manifest(folder)["items"][0]["file"]
    (folder / name).rename(folder / "meadow-001.gif")
    manifest["items"][0]["file"] = "meadow-001.gif"
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[0].file:")
    assert "does not match pattern" in problems[0]


def test_missing_manifest_json(folder: Path) -> None:
    (folder / "manifest.json").unlink()
    problems = problems_of(folder)
    assert problems
    assert any(p.startswith("manifest.json:") and "cannot read" in p
               for p in problems)


def test_unreadable_manifest_json_reports_json_error(folder: Path) -> None:
    (folder / "manifest.json").write_text("{not json", encoding="utf-8")
    problems = problems_of(folder)
    assert any(p.startswith("manifest.json:") and "invalid JSON" in p
               for p in problems)


# ---------------------------------------------------------------------------
# Output contract
# ---------------------------------------------------------------------------

def test_cli_prints_one_line_per_problem(folder: Path) -> None:
    name = read_manifest(folder)["items"][0]["file"]
    (folder / name).unlink()
    manifest = read_manifest(folder)
    manifest["items"][1]["id"] = manifest["items"][0]["id"]
    write_manifest(folder, manifest)

    proc = run_cli(folder)
    assert proc.returncode != 0
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    assert len(lines) == 2
    assert any("does not exist" in line for line in lines)
    assert any("duplicate id" in line for line in lines)


def test_cli_exits_nonzero_on_missing_folder(tmp_path: Path) -> None:
    proc = run_cli(tmp_path / "absent")
    assert proc.returncode != 0
    assert "not a directory" in proc.stderr
