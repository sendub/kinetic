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


def test_empty_items_list_is_valid(folder: Path) -> None:
    """An empty `items` array is a valid, honestly-empty folder (docs/
    extracting.md BUG 1): a slice in which no visual resolved to a file
    ships zero items — no missing-file placeholders — and the player
    shows its no-content state for it."""
    manifest = read_manifest(folder)
    manifest["items"] = []
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


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


def test_video_webm_with_loop_count_passes(folder: Path) -> None:
    """A `.webm` video file and `loopCount` are valid (plan Phase 9b)."""
    manifest = read_manifest(folder)
    video = manifest["items"][5]
    assert video["type"] == "video"
    new = video["file"].rsplit(".", 1)[0] + ".webm"
    (folder / video["file"]).rename(folder / new)
    video["file"] = new
    video["loopCount"] = 2
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_video_playback_range_passes(folder: Path) -> None:
    """startSeconds/endSeconds within durationSeconds are valid (Phase 9c)."""
    manifest = read_manifest(folder)
    video = manifest["items"][5]
    assert video["type"] == "video"
    video["durationSeconds"] = 4.0  # the validator trusts this, never probes
    video["startSeconds"] = 1.5
    video["endSeconds"] = 2.5
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_same_video_file_at_two_ranges_passes(folder: Path) -> None:
    """Several items may share one file at different ranges; no dedup,
    no sharing ban."""
    manifest = read_manifest(folder)
    video = manifest["items"][5]
    duration = video["durationSeconds"]
    video["startSeconds"] = 0.0
    video["endSeconds"] = duration / 2
    second = dict(video, id="intro-006b",
                  startSeconds=duration / 2, endSeconds=duration)
    manifest["items"].insert(6, second)
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_fractional_seconds_are_not_rounded(folder: Path) -> None:
    """Exact fractional seconds validate, and validation leaves the
    stored values verbatim."""
    manifest = read_manifest(folder)
    video = manifest["items"][5]
    video["durationSeconds"] = 12.345
    video["startSeconds"] = 4.567
    video["endSeconds"] = 12.345
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    stored = read_manifest(folder)["items"][5]
    assert stored["durationSeconds"] == 12.345
    assert stored["startSeconds"] == 4.567
    assert stored["endSeconds"] == 12.345


def test_video_mkv_with_hold_seconds_passes(folder: Path) -> None:
    """A `.mkv` video file and `holdSeconds` are valid; any playable
    container the browser accepts is allowed."""
    manifest = read_manifest(folder)
    video = manifest["items"][5]
    new = video["file"].rsplit(".", 1)[0] + ".mkv"
    (folder / video["file"]).rename(folder / new)
    video["file"] = new
    video["holdSeconds"] = 4.5
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_image_jxl_passes(folder: Path) -> None:
    """A `.jxl` image file is valid; browsers decode JXL since Chrome/Edge
    117, Safari 17, and Firefox 133."""
    manifest = read_manifest(folder)
    old = manifest["items"][0]["file"]
    new = old.rsplit(".", 1)[0] + ".jxl"
    (folder / old).rename(folder / new)
    manifest["items"][0]["file"] = new
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


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
    """`.gif` images are allowed now; `.bmp` still breaks the pattern."""
    manifest = read_manifest(folder)
    name = read_manifest(folder)["items"][0]["file"]
    (folder / name).rename(folder / "meadow-001.bmp")
    manifest["items"][0]["file"] = "meadow-001.bmp"
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[0].file:")
    assert "does not match pattern" in problems[0]


def test_video_missing_duration_seconds_is_rejected(folder: Path) -> None:
    """`durationSeconds` stays required even when `holdSeconds` is set."""
    manifest = read_manifest(folder)
    video = manifest["items"][5]
    assert video["type"] == "video"
    del video["durationSeconds"]
    video["holdSeconds"] = 3.0
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[5]:")
    assert "durationSeconds" in problems[0]


def test_video_range_end_not_after_start_is_rejected(folder: Path) -> None:
    """`endSeconds` must exceed `startSeconds`; equal is too (Phase 9c)."""
    manifest = read_manifest(folder)
    video = manifest["items"][5]
    video["startSeconds"] = 1.5
    video["endSeconds"] = 1.5
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[5].endSeconds:")
    assert "startSeconds" in problems[0]


def test_video_negative_start_seconds_is_rejected(folder: Path) -> None:
    """`startSeconds` may not be negative, even fractionally."""
    manifest = read_manifest(folder)
    video = manifest["items"][5]
    video["startSeconds"] = -0.5
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[5].startSeconds:")


def test_video_negative_start_seconds_reported_without_schema() -> None:
    """The validator's own rule, not just the schema `minimum`."""
    manifest = {"items": [{"id": "v", "type": "video",
                           "durationSeconds": 2.0, "startSeconds": -0.5}]}
    problems = validate_content.video_range_problems(manifest)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[0].startSeconds:")
    assert "negative" in problems[0]


def test_video_range_beyond_duration_is_rejected(folder: Path) -> None:
    """`endSeconds` may not exceed the file's `durationSeconds`."""
    manifest = read_manifest(folder)
    video = manifest["items"][5]
    video["endSeconds"] = video["durationSeconds"] + 10.0
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[5].endSeconds:")
    assert "durationSeconds" in problems[0]


def test_video_loop_start_within_range_passes(folder: Path) -> None:
    """`loopStartSeconds` below the range end is valid (Phase 9d), the
    common case of skipping an intro on the loop-back."""
    manifest = read_manifest(folder)
    video = manifest["items"][5]
    video["durationSeconds"] = 4.0
    video["startSeconds"] = 1.0
    video["endSeconds"] = 2.0
    video["loopStartSeconds"] = 1.5
    video["loopCount"] = 2
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_video_loop_start_before_start_seconds_passes(folder: Path) -> None:
    """`loopStartSeconds` may sit before `startSeconds`: a loop may
    include pre-roll the first pass skipped."""
    manifest = read_manifest(folder)
    video = manifest["items"][5]
    video["durationSeconds"] = 4.0
    video["startSeconds"] = 1.0
    video["endSeconds"] = 2.0
    video["loopStartSeconds"] = 0.5
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


def test_video_loop_start_at_effective_end_is_rejected(folder: Path) -> None:
    """A loop pass must have length, so a `loopStartSeconds` equal to
    `endSeconds` leaves it none."""
    manifest = read_manifest(folder)
    video = manifest["items"][5]
    video["durationSeconds"] = 4.0
    video["startSeconds"] = 1.0
    video["endSeconds"] = 2.0
    video["loopStartSeconds"] = 2.0
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[5].loopStartSeconds:")
    assert "must be less than the effective end 2.0 (found 2.0)" in problems[0]


def test_video_loop_start_past_end_is_rejected(folder: Path) -> None:
    """A `loopStartSeconds` past `endSeconds` describes a pass of
    negative length."""
    manifest = read_manifest(folder)
    video = manifest["items"][5]
    video["durationSeconds"] = 4.0
    video["startSeconds"] = 1.0
    video["endSeconds"] = 2.0
    video["loopStartSeconds"] = 2.5
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[5].loopStartSeconds:")
    assert "must be less than the effective end 2.0 (found 2.5)" in problems[0]


def test_video_loop_start_uses_duration_when_end_absent(folder: Path) -> None:
    """With no `endSeconds` the effective end is `durationSeconds`, so
    that is the bound that rejects."""
    manifest = read_manifest(folder)
    video = manifest["items"][5]
    video["durationSeconds"] = 2.0
    video["startSeconds"] = 0.5
    video.pop("endSeconds", None)
    video["loopStartSeconds"] = 1.9
    write_manifest(folder, manifest)
    assert problems_of(folder) == []

    manifest = read_manifest(folder)
    manifest["items"][5]["loopStartSeconds"] = 2.0
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[5].loopStartSeconds:")
    assert "must be less than the effective end 2.0 (found 2.0)" in problems[0]


def test_video_loop_start_seconds_are_not_rounded(folder: Path) -> None:
    """Exact fractional `loopStartSeconds` validate and are stored
    verbatim."""
    manifest = read_manifest(folder)
    video = manifest["items"][5]
    video["durationSeconds"] = 12.345
    video["startSeconds"] = 4.567
    video["endSeconds"] = 12.345
    video["loopStartSeconds"] = 8.901
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    stored = read_manifest(folder)["items"][5]
    assert stored["loopStartSeconds"] == 8.901
    assert stored["startSeconds"] == 4.567


def test_video_loop_start_reported_without_schema() -> None:
    """The validator's own rule, not just the schema `minimum`."""
    manifest = {"items": [{"id": "v", "type": "video",
                           "durationSeconds": 2.0, "endSeconds": 2.0,
                           "loopStartSeconds": 2.0}]}
    problems = validate_content.video_range_problems(manifest)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[0].loopStartSeconds:")
    assert "effective end" in problems[0]


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


def test_leading_text_item_is_rejected(folder: Path) -> None:
    """The first item may not be `text`: it would have no visual to show."""
    manifest = read_manifest(folder)
    manifest["items"].insert(0, {
        "id": "cold-open-000", "type": "text",
        "text": "It began before the lights came up.",
    })
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[0]:")
    assert "first item" in problems[0] and '"text"' in problems[0]


def test_text_only_manifest_is_rejected(folder: Path) -> None:
    """A manifest of only `text` items has no media-bearing item anywhere."""
    manifest = read_manifest(folder)
    manifest["items"] = [
        {"id": "line-a", "type": "text", "speaker": "Mei",
         "text": "One line over nothing."},
        {"id": "line-b", "type": "text", "text": "Another, still no visual."},
    ]
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 2
    assert problems[0].startswith("manifest.json: items[0]:")
    assert "first item" in problems[0]
    assert problems[1].startswith("manifest.json: items[1]:")
    assert "no media-bearing item" in problems[1]


def test_text_item_after_media_passes(folder: Path) -> None:
    """A `text` item following media items is valid; the video loops under it."""
    manifest = read_manifest(folder)
    manifest["items"].append({
        "id": "line-after-video", "type": "text", "speaker": "Mei",
        "text": "The street glowed under the awning.",
    })
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_thought_without_text_is_rejected(folder: Path) -> None:
    """`thought: true` with no `text` marks nothing; the validator rejects it."""
    manifest = read_manifest(folder)
    assert "text" not in manifest["items"][2]
    manifest["items"][2]["thought"] = True
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[2].thought:")
    assert "non-empty" in problems[0] and '"text"' in problems[0]


def test_thought_with_empty_text_is_rejected(folder: Path) -> None:
    """An empty `text` is a bare visual, so a `thought` on it is meaningless."""
    manifest = read_manifest(folder)
    manifest["items"][2]["text"] = ""
    manifest["items"][2]["thought"] = True
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: items[2].thought:")


def test_text_item_thought_with_text_passes(folder: Path) -> None:
    """A `text` item with `thought: true` and text is a valid thought line."""
    manifest = read_manifest(folder)
    manifest["items"].append({
        "id": "thought-after-video", "type": "text", "speaker": "Mei",
        "thought": True,
        "text": "I should have said something then.",
    })
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_thought_false_is_accepted(folder: Path) -> None:
    """`thought: false` is the default and never a problem."""
    manifest = read_manifest(folder)
    manifest["items"][2]["thought"] = False
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


def test_extra_unreferenced_file_is_tolerated(folder: Path) -> None:
    """A folder may carry extra files (e.g. the converter build ledger)."""
    (folder / "build-ledger.json").write_text('{"sources": []}\n',
                                              encoding="utf-8")
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


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
