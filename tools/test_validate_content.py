"""Tests for tools/validate_content.py.

The passing case runs against the real fixtures/demo; each fault test copies
that folder to a temporary directory, breaks one thing, and requires the
validator to report exactly that problem. Run with:

    .venv/bin/python -m pytest tools/ -q
"""

from __future__ import annotations

import json
import re
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
BRANCH_EXAMPLE = TOOLS_DIR / "data" / "branches-example"
CREATE_MD = REPO_ROOT / "CREATE.md"
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


# Demo items the tests edit, by role; `test_demo_roles_match_ids` keeps these
# indices honest against fixtures/build_demo.py.
IMAGE = 4  # text-bare: a plain image item with a file
ANIM = 5   # anim-orbit
VIDEO = 6  # video-chain: an MP4 with no range, loop or floor fields


def test_demo_roles_match_ids(demo: Path) -> None:
    ids = [item["id"] for item in read_manifest(demo)["items"]]
    assert (ids[IMAGE], ids[ANIM], ids[VIDEO]) == (
        "text-bare", "anim-orbit", "video-chain")


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


def move_to_subpath(folder: Path, rel: str, subpath: str) -> None:
    """Move a media file to `subpath` under the folder root, making dirs."""
    target = folder / subpath
    target.parent.mkdir(parents=True, exist_ok=True)
    (folder / rel).rename(target)


def test_empty_items_list_is_valid(folder: Path) -> None:
    """An empty `items` array is a valid, honestly-empty folder (docs/
    extracting.md BUG 1): a slice in which no visual resolved to a file
    ships zero items — no missing-file placeholders — and the player
    shows its no-content state for it."""
    manifest = read_manifest(folder)
    manifest["items"] = []
    manifest["branches"] = []  # the demo's branches would dangle refs
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
    video = manifest["items"][VIDEO]
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
    video = manifest["items"][VIDEO]
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
    video = manifest["items"][VIDEO]
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
    video = manifest["items"][VIDEO]
    video["durationSeconds"] = 12.345
    video["startSeconds"] = 4.567
    video["endSeconds"] = 12.345
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    stored = read_manifest(folder)["items"][VIDEO]
    assert stored["durationSeconds"] == 12.345
    assert stored["startSeconds"] == 4.567
    assert stored["endSeconds"] == 12.345


def test_video_mkv_with_hold_seconds_passes(folder: Path) -> None:
    """A `.mkv` video file and `holdSeconds` are valid; any playable
    container the browser accepts is allowed."""
    manifest = read_manifest(folder)
    video = manifest["items"][VIDEO]
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


def test_video_min_play_seconds_with_text_passes(folder: Path) -> None:
    """An exact fractional `minPlaySeconds` on a video carrying dialogue
    is valid (plan Phase 15) and stored verbatim."""
    manifest = read_manifest(folder)
    video = manifest["items"][VIDEO]
    assert video["type"] == "video" and "text" in video
    video["minPlaySeconds"] = 4.5
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert read_manifest(folder)["items"][VIDEO]["minPlaySeconds"] == 4.5


def test_video_zero_min_play_seconds_is_rejected(folder: Path) -> None:
    """The schema `exclusiveMinimum` rejects a zero floor; the validator
    adds no rule of its own, since the field stands alone."""
    manifest = read_manifest(folder)
    manifest["items"][VIDEO]["minPlaySeconds"] = 0
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{VIDEO}].minPlaySeconds:")
    assert "must be greater than 0" in problems[0]


def test_video_negative_min_play_seconds_is_rejected(folder: Path) -> None:
    """A negative floor describes no wait; the schema rejects it."""
    manifest = read_manifest(folder)
    manifest["items"][VIDEO]["minPlaySeconds"] = -1.5
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{VIDEO}].minPlaySeconds:")
    assert "must be greater than 0" in problems[0]


def test_video_absent_min_play_seconds_stays_valid(folder: Path) -> None:
    """`minPlaySeconds` is optional; an item without it is unchanged."""
    manifest = read_manifest(folder)
    assert "minPlaySeconds" not in manifest["items"][VIDEO]
    write_manifest(folder, manifest)
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
    frames = read_manifest(folder)["items"][ANIM]["frames"]
    (folder / frames[2]).unlink()
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{ANIM}].frames[2]:")


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
    name = manifest["items"][IMAGE]["file"]
    (folder / name).rename(folder / f"sub-{name}")
    manifest["items"][IMAGE]["file"] = f"sub/../sub-{name}"
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{IMAGE}].file:")
    assert '".." segments' in problems[0]


# ---------------------------------------------------------------------------
# Media paths below the folder root (docs/plan.md Phase 17)
#
# The converter spreads media over bucket subfolders so no single directory
# holds thousands of files, so a manifest path may be a SUBPATH — while its
# last segment keeps the flat file-name rule and the path still resolves
# against the content folder root. Each test moves one demo image into a
# bucket in a throwaway copy; `fixtures/demo` itself stays flat.
# ---------------------------------------------------------------------------

def test_media_file_in_a_subfolder_passes(folder: Path) -> None:
    """`assets/ab/<id>.jpg` is a valid `file`; the folder root is the base."""
    manifest = read_manifest(folder)
    name = manifest["items"][IMAGE]["file"]            # text-bare.jpg
    move_to_subpath(folder, name, f"assets/ab/{name}")
    manifest["items"][IMAGE]["file"] = f"assets/ab/{name}"
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_subpath_basename_need_not_equal_the_item_id(folder: Path) -> None:
    """The last segment keeps the flat file-name SHAPE, not the item id.

    Several items may share one derivative file — the demo's `part-012` and
    `part-013` both play `clip-012.mp4` — so an id mismatch is not a defect
    (docs/content-format.md, "Naming conventions").
    """
    manifest = read_manifest(folder)
    ids = [item["id"] for item in manifest["items"]]
    parts = (ids.index("range-a"), ids.index("range-b"))
    shared = manifest["items"][parts[0]]["file"]    # range-clip.mp4
    assert manifest["items"][parts[1]]["file"] == shared
    move_to_subpath(folder, shared, f"assets/cd/{shared}")
    for index in parts:
        manifest["items"][index]["file"] = f"assets/cd/{shared}"
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


def test_parent_segment_below_the_root_is_rejected(folder: Path) -> None:
    """A subpath may not climb back out: `..` stays forbidden in every segment."""
    manifest = read_manifest(folder)
    name = manifest["items"][IMAGE]["file"]
    manifest["items"][IMAGE]["file"] = f"assets/../{name}"
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{IMAGE}].file:")
    assert '".." segments' in problems[0]


def test_absolute_subpath_is_rejected(folder: Path) -> None:
    """A leading "/" names the filesystem, not the content folder."""
    manifest = read_manifest(folder)
    name = manifest["items"][IMAGE]["file"]
    manifest["items"][IMAGE]["file"] = f"/assets/ab/{name}"
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{IMAGE}].file:")
    assert "relative to the content folder" in problems[0]


def test_missing_file_in_a_subfolder_is_reported(folder: Path) -> None:
    """Existence is checked against the folder root, subpath included."""
    manifest = read_manifest(folder)
    name = manifest["items"][IMAGE]["file"]
    manifest["items"][IMAGE]["file"] = f"assets/ab/{name}"   # never moved
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{IMAGE}].file:")
    assert f"'assets/ab/{name}'" in problems[0]
    assert "does not exist" in problems[0]


def test_subpath_basename_must_be_a_flat_file_name(folder: Path) -> None:
    """Only the DIRECTORIES may be new: the last segment stays a flat name, so
    the `.poster` and `.fNNN` suffixes keep parsing unambiguously."""
    manifest = read_manifest(folder)
    name = manifest["items"][IMAGE]["file"]                  # text-bare.jpg
    manifest["items"][IMAGE]["file"] = f"assets/ab/{name}.jpg"
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{IMAGE}].file:")
    assert "id-shaped name" in problems[0]


def test_subpath_segment_must_start_with_a_letter(folder: Path) -> None:
    """No empty segment and no dot-leading or underscore segment, root or bucket."""
    manifest = read_manifest(folder)
    name = manifest["items"][IMAGE]["file"]
    manifest["items"][IMAGE]["file"] = f"assets/.ab/{name}"
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{IMAGE}].file:")
    assert "non-empty" in problems[0]


def test_animation_frames_in_a_subfolder_pass(folder: Path) -> None:
    """`frames` entries take the same rule as `file` and `poster`."""
    manifest = read_manifest(folder)
    frames = manifest["items"][ANIM]["frames"]
    for frame in frames:
        move_to_subpath(folder, frame, f"assets/ef/{frame}")
    manifest["items"][ANIM]["frames"] = [f"assets/ef/{frame}" for frame in frames]
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


def test_frames_below_minimum(folder: Path) -> None:
    manifest = read_manifest(folder)
    frames = manifest["items"][ANIM]["frames"]
    manifest["items"][ANIM]["frames"] = frames[:1]
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{ANIM}].frames:")
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
    video = manifest["items"][VIDEO]
    assert video["type"] == "video"
    del video["durationSeconds"]
    video["holdSeconds"] = 3.0
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{VIDEO}]:")
    assert "durationSeconds" in problems[0]


def test_video_range_end_not_after_start_is_rejected(folder: Path) -> None:
    """`endSeconds` must exceed `startSeconds`; equal is too (Phase 9c)."""
    manifest = read_manifest(folder)
    video = manifest["items"][VIDEO]
    video["startSeconds"] = 1.5
    video["endSeconds"] = 1.5
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{VIDEO}].endSeconds:")
    assert "startSeconds" in problems[0]


def test_video_negative_start_seconds_is_rejected(folder: Path) -> None:
    """`startSeconds` may not be negative, even fractionally."""
    manifest = read_manifest(folder)
    video = manifest["items"][VIDEO]
    video["startSeconds"] = -0.5
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{VIDEO}].startSeconds:")


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
    video = manifest["items"][VIDEO]
    video["endSeconds"] = video["durationSeconds"] + 10.0
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{VIDEO}].endSeconds:")
    assert "durationSeconds" in problems[0]


def test_video_loop_start_within_range_passes(folder: Path) -> None:
    """`loopStartSeconds` below the range end is valid (Phase 9d), the
    common case of skipping an intro on the loop-back."""
    manifest = read_manifest(folder)
    video = manifest["items"][VIDEO]
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
    video = manifest["items"][VIDEO]
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
    video = manifest["items"][VIDEO]
    video["durationSeconds"] = 4.0
    video["startSeconds"] = 1.0
    video["endSeconds"] = 2.0
    video["loopStartSeconds"] = 2.0
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{VIDEO}].loopStartSeconds:")
    assert "must be less than the effective end 2.0 (found 2.0)" in problems[0]


def test_video_loop_start_past_end_is_rejected(folder: Path) -> None:
    """A `loopStartSeconds` past `endSeconds` describes a pass of
    negative length."""
    manifest = read_manifest(folder)
    video = manifest["items"][VIDEO]
    video["durationSeconds"] = 4.0
    video["startSeconds"] = 1.0
    video["endSeconds"] = 2.0
    video["loopStartSeconds"] = 2.5
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{VIDEO}].loopStartSeconds:")
    assert "must be less than the effective end 2.0 (found 2.5)" in problems[0]


def test_video_loop_start_uses_duration_when_end_absent(folder: Path) -> None:
    """With no `endSeconds` the effective end is `durationSeconds`, so
    that is the bound that rejects."""
    manifest = read_manifest(folder)
    video = manifest["items"][VIDEO]
    video["durationSeconds"] = 2.0
    video["startSeconds"] = 0.5
    video.pop("endSeconds", None)
    video["loopStartSeconds"] = 1.9
    write_manifest(folder, manifest)
    assert problems_of(folder) == []

    manifest = read_manifest(folder)
    manifest["items"][VIDEO]["loopStartSeconds"] = 2.0
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{VIDEO}].loopStartSeconds:")
    assert "must be less than the effective end 2.0 (found 2.0)" in problems[0]


def test_video_loop_start_seconds_are_not_rounded(folder: Path) -> None:
    """Exact fractional `loopStartSeconds` validate and are stored
    verbatim."""
    manifest = read_manifest(folder)
    video = manifest["items"][VIDEO]
    video["durationSeconds"] = 12.345
    video["startSeconds"] = 4.567
    video["endSeconds"] = 12.345
    video["loopStartSeconds"] = 8.901
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    stored = read_manifest(folder)["items"][VIDEO]
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
    manifest["branches"] = []  # the demo's branches would dangle refs
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
    assert "text" not in manifest["items"][IMAGE]
    manifest["items"][IMAGE]["thought"] = True
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{IMAGE}].thought:")
    assert "non-empty" in problems[0] and '"text"' in problems[0]


def test_thought_with_empty_text_is_rejected(folder: Path) -> None:
    """An empty `text` is a bare visual, so a `thought` on it is meaningless."""
    manifest = read_manifest(folder)
    manifest["items"][IMAGE]["text"] = ""
    manifest["items"][IMAGE]["thought"] = True
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{IMAGE}].thought:")


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


# ---------------------------------------------------------------------------
# Branches (docs/content-format.md § Branches)
# ---------------------------------------------------------------------------

@pytest.fixture
def branch_folder(tmp_path: Path) -> Path:
    """A throwaway copy of the tools/data/branches-example folder."""
    copy = tmp_path / "branch-novel"
    shutil.copytree(BRANCH_EXAMPLE, copy)
    return copy


def test_branch_example_folder_passes() -> None:
    """The branch fixture validates cleanly, schema and cross-field rules."""
    assert problems_of(BRANCH_EXAMPLE) == []
    proc = run_cli(BRANCH_EXAMPLE)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_create_md_branch_example_matches_fixture() -> None:
    """The CREATE.md worked example IS the branch fixture: extracting the
    manifest with `branches` from the guide and comparing it to
    tools/data/branches-example keeps prose, example, and validation in
    lockstep (the pattern of the Phase 2 acceptance criterion)."""
    text = CREATE_MD.read_text(encoding="utf-8")
    blocks = re.findall(r"^```json\n(.*?)^```", text, re.DOTALL | re.MULTILINE)
    branch_blocks = [b for b in blocks if '"branches"' in b]
    assert len(branch_blocks) == 1
    assert json.loads(branch_blocks[0]) == read_manifest(BRANCH_EXAMPLE)


def test_empty_branches_array_is_valid(folder: Path) -> None:
    """`branches` is optional and may be empty."""
    manifest = read_manifest(folder)
    manifest["branches"] = []
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_route_result_defaults_to_ending(branch_folder: Path) -> None:
    """Omitting `result` is valid and means "ending": the schema declares
    the default, so no validator rule is needed."""
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    assert schema["$defs"]["route"]["properties"]["result"]["default"] == \
        "ending"
    manifest = read_manifest(branch_folder)
    del manifest["branches"][1]["routes"][0]["result"]
    write_manifest(branch_folder, manifest)
    assert problems_of(branch_folder) == []
    proc = run_cli(branch_folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_decision_without_continuing_route_passes(branch_folder: Path) -> None:
    """A pure-choice decision — no continuingRoute, no continueAt, routes
    that return to the decision — is valid."""
    manifest = read_manifest(branch_folder)
    decision = manifest["branches"][0]
    del decision["continuingRoute"]
    del decision["continueAt"]
    write_manifest(branch_folder, manifest)
    assert problems_of(branch_folder) == []
    proc = run_cli(branch_folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_duplicate_branch_id_rejected(branch_folder: Path) -> None:
    manifest = read_manifest(branch_folder)
    manifest["branches"].append(manifest["branches"][0])
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: branches[2].id:")
    assert "duplicate id" in problems[0] and "cafe-choice" in problems[0]


def test_branch_id_collides_with_item_id(branch_folder: Path) -> None:
    manifest = read_manifest(branch_folder)
    manifest["branches"][0]["id"] = "intro-001"
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: branches[0].id:")
    assert "duplicate id" in problems[0]


def test_duplicate_route_id_rejected(branch_folder: Path) -> None:
    manifest = read_manifest(branch_folder)
    manifest["branches"][0]["routes"][1]["id"] = "stay"
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: branches[0].routes[1].id:")
    assert "duplicate route id" in problems[0]


def test_unresolved_after_ref_rejected(branch_folder: Path) -> None:
    manifest = read_manifest(branch_folder)
    manifest["branches"][0]["after"] = "ghost-099"
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: branches[0].after:")
    assert "no item has id 'ghost-099'" in problems[0]


def test_unresolved_route_start_ref_rejected(branch_folder: Path) -> None:
    manifest = read_manifest(branch_folder)
    manifest["branches"][0]["routes"][0]["start"] = "ghost-099"
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: branches[0].routes[0].start:")
    assert "no item has id 'ghost-099'" in problems[0]


def test_unresolved_continue_at_ref_rejected(branch_folder: Path) -> None:
    manifest = read_manifest(branch_folder)
    manifest["branches"][1]["continueAt"] = "ghost-099"
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: branches[1].continueAt:")
    assert "no item has id 'ghost-099'" in problems[0]


def test_route_start_after_end_rejected(branch_folder: Path) -> None:
    """A route's `start` must not come after its `end` in array order."""
    manifest = read_manifest(branch_folder)
    route = manifest["branches"][0]["routes"][0]
    route["start"], route["end"] = "tea-007", "tea-006"
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: branches[0].routes[0].start:")
    assert "must not come after its end" in problems[0]


def test_overlapping_route_spans_rejected(branch_folder: Path) -> None:
    """Spans of one decision must be pairwise disjoint."""
    manifest = read_manifest(branch_folder)
    manifest["branches"][1]["routes"][1]["start"] = "tea-006"
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: branches[1].routes[1]:")
    assert "overlaps the span" in problems[0]


def test_route_span_contains_after_rejected(branch_folder: Path) -> None:
    """No route span may contain its own decision's `after` item."""
    manifest = read_manifest(branch_folder)
    manifest["branches"][0]["after"] = "tea-006"  # inside the stay span
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: branches[0].routes[0].start:")
    assert "contains the decision's after item" in problems[0]


def test_route_starts_before_after_rejected(branch_folder: Path) -> None:
    """Every route of a decision starts after its `after` item."""
    manifest = read_manifest(branch_folder)
    manifest["branches"][0]["after"] = "cafe-008"
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 2  # one per offending route
    assert all(p.startswith("manifest.json: branches[0].routes[")
               and "must start after the decision's after item" in p
               for p in problems)


def test_continuing_route_without_continue_at_rejected(branch_folder: Path) -> None:
    manifest = read_manifest(branch_folder)
    del manifest["branches"][1]["continueAt"]
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: branches[1].continueAt:")
    assert "required when continuingRoute is present" in problems[0]


def test_continue_at_without_continuing_route_rejected(branch_folder: Path) -> None:
    """`continueAt` is allowed only with `continuingRoute`."""
    manifest = read_manifest(branch_folder)
    del manifest["branches"][1]["continuingRoute"]
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: branches[1].continueAt:")
    assert "allowed only with continuingRoute" in problems[0]


def test_continuing_route_must_name_a_route(branch_folder: Path) -> None:
    manifest = read_manifest(branch_folder)
    manifest["branches"][1]["continuingRoute"] = "nope"
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith(
        "manifest.json: branches[1].continuingRoute:")
    assert "names no route of this decision" in problems[0]


def test_continue_at_before_route_end_rejected(branch_folder: Path) -> None:
    """`continueAt` must resolve to an item after every route end."""
    manifest = read_manifest(branch_folder)
    manifest["branches"][1]["continueAt"] = "home-010"
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: branches[1].continueAt:")
    assert "after every route end" in problems[0]


def test_branch_prompt_too_long_rejected(branch_folder: Path) -> None:
    manifest = read_manifest(branch_folder)
    manifest["branches"][0]["prompt"] = "y" * 200
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith("manifest.json: branches[0].prompt:")
    assert "shorter than 200 characters" in problems[0]


def test_route_label_too_long_rejected(branch_folder: Path) -> None:
    manifest = read_manifest(branch_folder)
    manifest["branches"][0]["routes"][0]["label"] = "x" * 120
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith(
        "manifest.json: branches[0].routes[0].label:")
    assert "shorter than 120 characters" in problems[0]


def test_branch_rules_reported_without_schema() -> None:
    """branches_problems is the validator's own rule set, not just schema
    fallthrough: it reports on a bare manifest dict."""
    manifest = {
        "items": [{"id": "a"}, {"id": "b"}, {"id": "c"}],
        "branches": [{
            "id": "d1", "after": "ghost", "prompt": "P?",
            "routes": [{"id": "r", "label": "R", "start": "b", "end": "a"}],
            "continueAt": "c",
        }],
    }
    problems = validate_content.branches_problems(manifest)
    assert any(p.startswith("manifest.json: branches[0].after:") for p in problems)
    assert any("must not come after its end" in p for p in problems)
    assert any("allowed only with continuingRoute" in p for p in problems)
    assert len(problems) == 3
