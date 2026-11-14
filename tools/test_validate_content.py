"""Tests for tools/validate_content.py.

The passing case runs against the real fixtures/demo; each fault test copies
that folder to a temporary directory, breaks one thing, and requires the
validator to report exactly that problem. Run with:

    .venv/bin/python -m pytest tools/ -q
"""

from __future__ import annotations

import fcntl
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
if str(REPO_ROOT / "converter") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "converter"))

import validate_content  # noqa: E402
from kinetic_extract import audio_format  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def demo() -> Path:
    """fixtures/demo, built by fixtures/build_demo.py if it is absent.

    Under a lock: pytest-xdist workers (``-n``) each run this fixture, and
    two building the folder at once would delete each other's files."""
    lock = REPO_ROOT / ".tmp" / "build-demo.lock"
    lock.parent.mkdir(exist_ok=True)
    with lock.open("w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        if not (DEMO_DIR / "manifest.json").is_file():
            proc = subprocess.run([sys.executable, str(BUILD_DEMO)],
                                  capture_output=True, text=True)
            if proc.returncode != 0:
                pytest.fail(f"build_demo.py failed (exit {proc.returncode}):"
                            f"\n{proc.stdout}{proc.stderr}")
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


def run_cli(folder: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(VALIDATOR), str(folder), *args],
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


@pytest.mark.parametrize("ext", ["3gp", "mkv", "mov", "m4v", "ogv", "avi"])
def test_any_video_extension_passes(folder: Path, ext: str) -> None:
    """The schema keeps no video extension list of its own: whatever the
    converter's measured rule ships (docs/plan.md Phase 26, `.3gp`
    included) is a valid video file."""
    manifest = read_manifest(folder)
    video = manifest["items"][VIDEO]
    new = video["file"].rsplit(".", 1)[0] + "." + ext
    (folder / video["file"]).rename(folder / new)
    video["file"] = new
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


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
    """`media/ab/<id>.jpg` is a valid `file`; the folder root is the base."""
    manifest = read_manifest(folder)
    name = manifest["items"][IMAGE]["file"]            # text-bare.jpg
    move_to_subpath(folder, name, f"media/ab/{name}")
    manifest["items"][IMAGE]["file"] = f"media/ab/{name}"
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_content_addressed_path_passes(folder: Path) -> None:
    """The converter's layout (docs/plan.md Phase 25): a 64-hex sha256 stem
    under `media/<h[:2]>/` fits the file-name rule."""
    import hashlib

    manifest = read_manifest(folder)
    name = manifest["items"][IMAGE]["file"]            # text-bare.jpg
    digest = hashlib.sha256((folder / name).read_bytes()).hexdigest()
    ref = f"media/{digest[:2]}/{digest}.jpg"
    move_to_subpath(folder, name, ref)
    manifest["items"][IMAGE]["file"] = ref
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


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
    move_to_subpath(folder, shared, f"media/cd/{shared}")
    for index in parts:
        manifest["items"][index]["file"] = f"media/cd/{shared}"
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


def test_parent_segment_below_the_root_is_rejected(folder: Path) -> None:
    """A subpath may not climb back out: `..` stays forbidden in every segment."""
    manifest = read_manifest(folder)
    name = manifest["items"][IMAGE]["file"]
    manifest["items"][IMAGE]["file"] = f"media/../{name}"
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{IMAGE}].file:")
    assert '".." segments' in problems[0]


def test_absolute_subpath_is_rejected(folder: Path) -> None:
    """A leading "/" names the filesystem, not the content folder."""
    manifest = read_manifest(folder)
    name = manifest["items"][IMAGE]["file"]
    manifest["items"][IMAGE]["file"] = f"/media/ab/{name}"
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{IMAGE}].file:")
    assert "relative to the content folder" in problems[0]


def test_missing_file_in_a_subfolder_is_reported(folder: Path) -> None:
    """Existence is checked against the folder root, subpath included."""
    manifest = read_manifest(folder)
    name = manifest["items"][IMAGE]["file"]
    manifest["items"][IMAGE]["file"] = f"media/ab/{name}"   # never moved
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{IMAGE}].file:")
    assert f"'media/ab/{name}'" in problems[0]
    assert "does not exist" in problems[0]


def test_subpath_basename_must_be_a_flat_file_name(folder: Path) -> None:
    """Only the DIRECTORIES may be new: the last segment stays a flat name, so
    the `.poster` and `.fNNN` suffixes keep parsing unambiguously."""
    manifest = read_manifest(folder)
    name = manifest["items"][IMAGE]["file"]                  # text-bare.jpg
    manifest["items"][IMAGE]["file"] = f"media/ab/{name}.jpg"
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{IMAGE}].file:")
    assert "id-shaped name" in problems[0]


def test_subpath_segment_must_start_with_a_letter(folder: Path) -> None:
    """No empty segment and no dot-leading or underscore segment, root or bucket."""
    manifest = read_manifest(folder)
    name = manifest["items"][IMAGE]["file"]
    manifest["items"][IMAGE]["file"] = f"media/.ab/{name}"
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
        move_to_subpath(folder, frame, f"media/ef/{frame}")
    manifest["items"][ANIM]["frames"] = [f"media/ef/{frame}" for frame in frames]
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


def test_nested_continuing_routes_sharing_an_ending_pass(
        branch_folder: Path) -> None:
    """Nested decisions whose continuing routes end on the same item and
    join at the same `continueAt` (docs/plan.md Phase 13, shared endings)
    are valid: the inner `continueAt` lies past the enclosing route."""
    manifest = read_manifest(branch_folder)
    ids = [item["id"] for item in manifest["items"][:6]]
    manifest["branches"] = [
        {
            "id": "outer", "after": ids[0], "prompt": "Outer?",
            "routes": [
                {"id": "o-alt", "label": "Outer alt", "start": ids[1],
                 "end": ids[1], "result": "return"},
                {"id": "o-cont", "label": "Outer cont", "start": ids[2],
                 "end": ids[4]},
            ],
            "continuingRoute": "o-cont", "continueAt": ids[5],
        },
        {
            "id": "inner", "after": ids[2], "prompt": "Inner?",
            "routes": [
                {"id": "n-alt", "label": "Inner alt", "start": ids[3],
                 "end": ids[3], "result": "return"},
                {"id": "n-cont", "label": "Inner cont", "start": ids[4],
                 "end": ids[4]},
            ],
            "continuingRoute": "n-cont", "continueAt": ids[5],
        },
    ]
    write_manifest(branch_folder, manifest)
    assert problems_of(branch_folder) == []


def test_continue_routes_into_the_join_pass(branch_folder: Path) -> None:
    """`result: "continue"` on a decision with continuingRoute/continueAt is
    valid (docs/plan.md Phase 38), on the continuing route itself too,
    where it is moot like the other results."""
    manifest = read_manifest(branch_folder)
    decision = manifest["branches"][0]
    decision["routes"][1]["result"] = "continue"  # leave, on cafe-choice
    decision["routes"][0]["result"] = "continue"  # stay, its continuingRoute
    write_manifest(branch_folder, manifest)
    assert problems_of(branch_folder) == []
    proc = run_cli(branch_folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_continue_route_without_a_join_rejected(branch_folder: Path) -> None:
    """A pure choice has no join: a "continue" route there is a problem,
    one line per such route, at its `result`."""
    manifest = read_manifest(branch_folder)
    decision = manifest["branches"][0]
    del decision["continuingRoute"]
    del decision["continueAt"]
    decision["routes"][1]["result"] = "continue"
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith(
        "manifest.json: branches[0].routes[1].result:")
    assert '"continue" needs the decision\'s continuingRoute and continueAt' \
        in problems[0]


def test_continue_route_with_half_a_join_rejected(branch_folder: Path) -> None:
    """With continueAt but no continuingRoute there is still no join: the
    pairing problem and the "continue" route are both reported."""
    manifest = read_manifest(branch_folder)
    decision = manifest["branches"][0]
    del decision["continuingRoute"]
    decision["routes"][1]["result"] = "continue"
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 2
    assert any(p.startswith("manifest.json: branches[0].continueAt:")
               and "allowed only with continuingRoute" in p
               for p in problems)
    assert any(p.startswith("manifest.json: branches[0].routes[1].result:")
               and "no join to continue to" in p
               for p in problems)


def test_unknown_route_result_rejected(branch_folder: Path) -> None:
    """The schema's enum is "return", "ending" and "continue" only."""
    manifest = read_manifest(branch_folder)
    manifest["branches"][0]["routes"][1]["result"] = "join"
    write_manifest(branch_folder, manifest)
    problems = problems_of(branch_folder)
    assert len(problems) == 1
    assert problems[0].startswith(
        "manifest.json: branches[0].routes[1].result:")


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


# ---------------------------------------------------------------------------
# storyId (docs/plan.md Phase 21): optional, a lowercase slug when present
# ---------------------------------------------------------------------------

def test_demo_carries_a_story_id(demo: Path) -> None:
    assert read_manifest(demo)["storyId"] == "kinetic-demo"


def test_absent_story_id_stays_valid(folder: Path) -> None:
    """Manifests written before Phase 21 have none; the player then keys
    progress by the folder URL."""
    manifest = read_manifest(folder)
    del manifest["storyId"]
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


@pytest.mark.parametrize("story", [
    "gamename-1234567890", "renpy_demo", "a", "0" * 64])
def test_story_id_slugs_pass(folder: Path, story: str) -> None:
    manifest = read_manifest(folder)
    manifest["storyId"] = story
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


@pytest.mark.parametrize("story", [
    "GameName", "two words", "-lead", "_lead", "", "a" * 65, "café", 7])
def test_bad_story_id_is_rejected(folder: Path, story: object) -> None:
    manifest = read_manifest(folder)
    manifest["storyId"] = story
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1, problems
    assert problems[0].startswith("manifest.json: storyId:"), problems


# ---------------------------------------------------------------------------
# title (docs/plan.md Phase 21, Game name on the Esc screen): optional, a
# non-blank string of at most 200 characters when present
# ---------------------------------------------------------------------------

def test_demo_carries_a_title(demo: Path) -> None:
    assert read_manifest(demo)["title"] == "Kinetic demo"


def test_absent_title_stays_valid(folder: Path) -> None:
    """No title, no heading: the player shows the help without one."""
    manifest = read_manifest(folder)
    manifest.pop("title", None)
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


@pytest.mark.parametrize("title", [
    "The Lantern at Low Tide", "game-d College: Part 'Two'!", "夏の終わり",
    "<b>not html</b>", "x", "x" * 200])
def test_titles_pass(folder: Path, title: str) -> None:
    manifest = read_manifest(folder)
    manifest["title"] = title
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


@pytest.mark.parametrize("title", ["", "   ", "x" * 201, 7, None])
def test_bad_title_is_rejected(folder: Path, title: object) -> None:
    manifest = read_manifest(folder)
    manifest["title"] = title
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1, problems
    assert problems[0].startswith("manifest.json: title:"), problems


# ---------------------------------------------------------------------------
# Poster warnings (--ledger; docs/plan.md Phase 44 item 2): a video item's
# poster whose ledger records do not show it made at the item's start, from
# the item's video source. Warnings go to stderr and never change the exit.
# ---------------------------------------------------------------------------

RANGE_B = 15  # range-b: startSeconds 1.0; VIDEO (video-chain) has none


def test_demo_poster_roles_match_ids(demo: Path) -> None:
    items = read_manifest(demo)["items"]
    assert (items[VIDEO]["id"], items[RANGE_B]["id"]) == (
        "video-chain", "range-b")
    assert "startSeconds" not in items[VIDEO]
    assert items[RANGE_B]["startSeconds"] == 1.0


def matching_ledger(manifest: dict[str, Any]) -> dict[str, Any]:
    """A media ledger in which every video item's poster was made at the
    item's start from the source that made the item's video file."""
    media: dict[str, Any] = {}
    for item in manifest["items"]:
        if item.get("type") != "video":
            continue
        source = {"path": f"game/movies/{item['file']}", "bytes": 1000,
                  "sha256": f"sha-{item['file']}"}
        media[item["file"]] = {
            "kind": "video", "source": source,
            "steps": [{"step": "preserve", "codec": "h264"}]}
        media[item["poster"]] = {
            "kind": "poster", "source": dict(source),
            "steps": [{"step": "poster",
                       "startSeconds": item.get("startSeconds", 0.0),
                       "args": [], "frameFormat": "png", "mode": "RGB",
                       "png": {"optimize": True}},
                      {"step": "preserve"}]}
    return {"mediaTools": {}, "media": media}


def poster_entry(ledger: dict[str, Any], manifest: dict[str, Any],
                 index: int) -> dict[str, Any]:
    return ledger["media"][manifest["items"][index]["poster"]]


def write_ledger(folder: Path, ledger: Any) -> Path:
    path = folder / "media-ledger.json"
    path.write_text(json.dumps(ledger), encoding="utf-8")
    return path


def warning_lines(proc: subprocess.CompletedProcess[str]) -> list[str]:
    return [line for line in proc.stderr.splitlines()
            if line.startswith("warning: ")]


def run_with_ledger(folder: Path, ledger: dict[str, Any]
                    ) -> subprocess.CompletedProcess[str]:
    return run_cli(folder, "--ledger", str(write_ledger(folder, ledger)))


def test_matching_posters_give_no_warning(folder: Path) -> None:
    proc = run_with_ledger(folder, matching_ledger(read_manifest(folder)))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout == ""
    assert proc.stderr == f"{folder}: 0 poster warnings\n"


def test_later_start_poster_made_at_zero_warns(folder: Path) -> None:
    manifest = read_manifest(folder)
    ledger = matching_ledger(manifest)
    poster_entry(ledger, manifest, RANGE_B)["steps"][0]["startSeconds"] = 0.0
    proc = run_with_ledger(folder, ledger)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout == ""
    assert warning_lines(proc) == [
        "warning: manifest.json: items[15].poster: startSeconds 1.0, "
        "poster startSeconds 0.0 (poster made at another start)"]
    assert proc.stderr.endswith(f"{folder}: 1 poster warning\n")


def test_start_zero_poster_made_later_warns(folder: Path) -> None:
    """The converting agent's case: start-0 items whose posters were made
    3 s in."""
    manifest = read_manifest(folder)
    ledger = matching_ledger(manifest)
    poster_entry(ledger, manifest, VIDEO)["steps"][0]["startSeconds"] = 3.0
    proc = run_with_ledger(folder, ledger)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert warning_lines(proc) == [
        "warning: manifest.json: items[6].poster: startSeconds 0, "
        "poster startSeconds 3.0 (poster made at another start)"]


def test_later_start_poster_not_in_ledger_warns(folder: Path) -> None:
    manifest = read_manifest(folder)
    ledger = matching_ledger(manifest)
    del ledger["media"][manifest["items"][RANGE_B]["poster"]]
    proc = run_with_ledger(folder, ledger)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert warning_lines(proc) == [
        "warning: manifest.json: items[15].poster: startSeconds 1.0, "
        "poster startSeconds none (poster not in the ledger)"]


def test_start_zero_poster_not_in_ledger_is_fine(folder: Path) -> None:
    """A hand-made poster on an item that starts at 0 is the first frame."""
    manifest = read_manifest(folder)
    ledger = matching_ledger(manifest)
    del ledger["media"][manifest["items"][VIDEO]["poster"]]
    proc = run_with_ledger(folder, ledger)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert warning_lines(proc) == []


def test_poster_step_without_start_warns_on_a_later_start(
        folder: Path) -> None:
    manifest = read_manifest(folder)
    ledger = matching_ledger(manifest)
    for index in (VIDEO, RANGE_B):
        del poster_entry(ledger, manifest, index)["steps"][0]["startSeconds"]
    proc = run_with_ledger(folder, ledger)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert warning_lines(proc) == [
        "warning: manifest.json: items[15].poster: startSeconds 1.0, "
        "poster startSeconds none (the ledger records no poster "
        "startSeconds)"]


@pytest.mark.parametrize("index, start", [(VIDEO, "0"), (RANGE_B, "1.0")])
def test_matching_start_from_another_source_warns(
        folder: Path, index: int, start: str) -> None:
    manifest = read_manifest(folder)
    ledger = matching_ledger(manifest)
    poster_entry(ledger, manifest, index)["source"]["sha256"] = "sha-other"
    proc = run_with_ledger(folder, ledger)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    recorded = "0.0" if index == VIDEO else "1.0"
    assert warning_lines(proc) == [
        f"warning: manifest.json: items[{index}].poster: startSeconds "
        f"{start}, poster startSeconds {recorded} (poster made from "
        "another source)"]


def test_an_also_from_record_can_pass_the_poster() -> None:
    """The entry and its alsoFrom records all count, for the poster and
    for the video's sources."""
    manifest = {"items": [{"id": "v", "type": "video", "file": "v.mp4",
                           "poster": "v.poster.png", "startSeconds": 2.5}]}
    poster_at = [{"step": "poster", "startSeconds": 0.0}]
    media = {
        "v.mp4": {"source": {"sha256": "a"},
                  "alsoFrom": [{"source": {"sha256": "b"}, "steps": []}]},
        "v.poster.png": {
            "source": {"sha256": "a"}, "steps": poster_at,
            "alsoFrom": [{"source": {"sha256": "b"},
                          "steps": [{"step": "poster",
                                     "startSeconds": 2.5}]}]},
    }
    assert validate_content.poster_warnings(manifest, media) == []
    del media["v.poster.png"]["alsoFrom"]
    assert validate_content.poster_warnings(manifest, media) == [
        "warning: manifest.json: items[0].poster: startSeconds 2.5, "
        "poster startSeconds 0.0 (poster made at another start)"]


@pytest.mark.parametrize("item_start, warns", [
    (2.0000004, False), (2, False), (2.00001, True)])
def test_starts_are_compared_at_six_decimals(item_start: float,
                                             warns: bool) -> None:
    """As kinetic-media posters and the poster recipe use them."""
    manifest = {"items": [{"id": "v", "type": "video", "file": "v.mp4",
                           "poster": "v.poster.png",
                           "startSeconds": item_start}]}
    media = {"v.mp4": {"source": {"sha256": "a"}},
             "v.poster.png": {"source": {"sha256": "a"},
                              "steps": [{"step": "poster",
                                         "startSeconds": 2.0}]}}
    found = validate_content.poster_warnings(manifest, media)
    assert bool(found) is warns, found


def test_video_not_in_ledger_warns_only_on_a_later_start(
        folder: Path) -> None:
    """With no record of the video, the ledger cannot say which source the
    poster should come from: as with a poster not in the ledger, only a
    later start warns."""
    manifest = read_manifest(folder)
    ledger = matching_ledger(manifest)
    for index in (VIDEO, RANGE_B):
        ledger["media"].pop(manifest["items"][index]["file"], None)
    proc = run_with_ledger(folder, ledger)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert warning_lines(proc) == [
        "warning: manifest.json: items[15].poster: startSeconds 1.0, "
        "poster startSeconds 1.0 (video not in the ledger)"]


def test_without_ledger_output_is_unchanged(folder: Path) -> None:
    """No --ledger: no warnings, and ledgers in the folder are not read."""
    manifest = read_manifest(folder)
    ledger = matching_ledger(manifest)
    poster_entry(ledger, manifest, RANGE_B)["steps"][0]["startSeconds"] = 0.0
    write_ledger(folder, ledger)
    (folder / "build-ledger.json").write_text(json.dumps(ledger),
                                              encoding="utf-8")
    proc = run_cli(folder)
    assert (proc.returncode, proc.stdout, proc.stderr) == (0, "", "")

    (folder / manifest["items"][0]["file"]).unlink()
    problems = problems_of(folder)
    assert len(problems) == 1
    proc = run_cli(folder)
    assert proc.returncode == 1
    assert proc.stdout == problems[0] + "\n"
    assert proc.stderr == f"{folder}: 1 problem\n"


@pytest.mark.parametrize("content", [
    None, "{not json", "[]", '{"sources": []}', '{"media": []}'])
def test_bad_ledger_exits_2(folder: Path, content: str | None) -> None:
    path = folder / "media-ledger.json"
    if content is not None:
        path.write_text(content, encoding="utf-8")
    proc = run_cli(folder, "--ledger", str(path))
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert proc.stdout == ""
    assert len(proc.stderr.splitlines()) == 1, proc.stderr
    assert proc.stderr.startswith(f"{path}: ")


def test_warnings_leave_problem_lines_and_exit_one_alone(
        folder: Path) -> None:
    manifest = read_manifest(folder)
    ledger = matching_ledger(manifest)
    poster_entry(ledger, manifest, RANGE_B)["steps"][0]["startSeconds"] = 0.0
    (folder / manifest["items"][0]["file"]).unlink()
    without = run_cli(folder)
    proc = run_with_ledger(folder, ledger)
    assert (proc.returncode, without.returncode) == (1, 1)
    assert proc.stdout == without.stdout
    assert "warning" not in proc.stdout
    assert len(warning_lines(proc)) == 1
    assert proc.stderr == (without.stderr + warning_lines(proc)[0] + "\n"
                           + f"{folder}: 1 poster warning\n")


# ---------------------------------------------------------------------------
# Audio (docs/content-format.md § Audio; docs/plan.md Phase 47 item 1): the
# top-level `audio.tracks` and per-item `audio`. The validator checks that
# track files exist and pass the path rule, that each has its script (item
# 17), and decodes nothing, so the test tracks are small dummy files.
# ---------------------------------------------------------------------------

RANGE_A = 14  # range-a: a video item playing seconds 0 to 1 of a 2 s file

AUDIO_FILES = {
    "theme": "media/au/theme.m4a", "rain": "rain.webm", "wind": "wind.flac",
    "sting": "sting.wav", "door": "door.mp3", "line": "line.mp3",
    "clip": "clip.webm",
}


def test_demo_audio_roles_match_ids(demo: Path) -> None:
    items = read_manifest(demo)["items"]
    assert (items[RANGE_A]["id"], items[RANGE_A]["endSeconds"],
            items[RANGE_A]["durationSeconds"]) == ("range-a", 1.0, 2.0)
    assert (items[VIDEO]["durationSeconds"], items[2]["type"],
            items[9]["type"], items[12]["type"]) == (2.0, "text", "image",
                                                     "video")
    assert not any("audio" in item for item in items)


DUMMY = b"not decoded by the validator"


def put_track(folder: Path, path: str, data: bytes = DUMMY) -> None:
    """An audio file and its script (docs/content-format.md § Audio)."""
    (folder / path).parent.mkdir(parents=True, exist_ok=True)
    (folder / path).write_bytes(data)
    audio_format.write_script(folder, path)


def with_audio(folder: Path) -> dict[str, Any]:
    """The demo manifest with every audio field in use, its track files
    written as dummies with their scripts. Every track is used, and no
    looping track is MP3, so nothing warns."""
    for path in AUDIO_FILES.values():
        put_track(folder, path)
    manifest = read_manifest(folder)
    manifest["audio"] = {"tracks": {
        "theme": {"file": AUDIO_FILES["theme"], "durationSeconds": 120.0,
                  "startSeconds": 2.5, "loopStartSeconds": 10.0,
                  "loop": True, "volume": 0.8},
        "rain": {"file": AUDIO_FILES["rain"], "durationSeconds": 30.0},
        "wind": {"file": AUDIO_FILES["wind"], "durationSeconds": 20.0,
                 "volume": 0},
        "sting": {"file": AUDIO_FILES["sting"], "durationSeconds": 3.0,
                  "loop": False},
        "door": {"file": AUDIO_FILES["door"], "durationSeconds": 1.5},
        "door-late": {"file": AUDIO_FILES["door"], "durationSeconds": 1.5,
                      "startSeconds": 0.5},
        "line": {"file": AUDIO_FILES["line"], "durationSeconds": 2.0},
        "clip": {"file": AUDIO_FILES["clip"], "durationSeconds": 2.0},
    }}
    items = manifest["items"]
    items[0]["audio"] = {"music": "theme", "ambience": ["rain", "wind"],
                         "fadeMs": 1500}
    items[1]["audio"] = {"sfx": [
        {"track": "door", "delayMs": 250, "channel": "door"},
        {"track": "door-late"}]}
    items[2]["audio"] = {"voice": "line"}
    items[ANIM]["audio"] = {"ambience": ["wind"], "fadeMs": 0}
    items[VIDEO]["audio"] = {"videoSound": {"track": "clip", "duck": 0.5}}
    items[9]["audio"] = {"music": None, "ambience": []}
    items[12]["audio"] = {"music": "sting"}
    return manifest


def only_problem(folder: Path, manifest: dict[str, Any]) -> str:
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1, problems
    return problems[0]


def test_manifest_using_every_audio_field_passes(folder: Path) -> None:
    write_manifest(folder, with_audio(folder))
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert (proc.returncode, proc.stdout, proc.stderr) == (0, "", "")


def test_missing_track_file_is_reported(folder: Path) -> None:
    # Neither the file nor its script (docs/plan.md Phase 47 item 19).
    manifest = with_audio(folder)
    (folder / AUDIO_FILES["rain"]).unlink()
    (folder / f"{AUDIO_FILES['rain']}.js").unlink()
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: audio.tracks.rain.file:")
    assert "does not exist" in problem
    assert "nor its script 'rain.webm.js'" in problem


def test_track_file_breaking_the_path_rule_is_reported(folder: Path) -> None:
    manifest = with_audio(folder)
    manifest["audio"]["tracks"]["rain"]["file"] = "../rain.webm"
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: audio.tracks.rain.file:")
    assert '".."' in problem


def test_track_file_with_another_extension_is_rejected(folder: Path) -> None:
    manifest = with_audio(folder)
    (folder / "rain.aiff").write_bytes(b"x")
    manifest["audio"]["tracks"]["rain"]["file"] = "rain.aiff"
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: audio.tracks.rain.file:")


def test_track_id_must_be_id_shaped(folder: Path) -> None:
    manifest = with_audio(folder)
    tracks = manifest["audio"]["tracks"]
    tracks["rain.ogg"] = tracks.pop("rain")
    for item in manifest["items"]:
        audio = item.get("audio", {})
        if "ambience" in audio:
            audio["ambience"] = [t for t in audio["ambience"] if t != "rain"]
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: audio.tracks:")
    assert "'rain.ogg'" in problem


@pytest.mark.parametrize("where, value", [
    ("music", "nope"), ("ambience", "nope"), ("sfx", "nope"),
    ("voice", "nope"), ("videoSound", "nope")])
def test_unknown_track_id_is_reported(folder: Path, where: str,
                                      value: str) -> None:
    manifest = with_audio(folder)
    items = manifest["items"]
    index, loc = {
        "music": (0, "music"), "ambience": (0, "ambience[1]"),
        "sfx": (1, "sfx[1].track"), "voice": (2, "voice"),
        "videoSound": (VIDEO, "videoSound.track")}[where]
    audio = items[index]["audio"]
    if where == "ambience":
        audio["ambience"][1] = value
    elif where == "sfx":
        audio["sfx"][1]["track"] = value
    elif where == "videoSound":
        audio["videoSound"]["track"] = value
    else:
        audio[where] = value
    problem = only_problem(folder, manifest)
    assert problem.startswith(f"manifest.json: items[{index}].audio.{loc}:")
    assert "'nope'" in problem


def test_unknown_id_left_unused_track_warns(folder: Path) -> None:
    """The renamed reference fails, and the track it no longer names
    warns as unused."""
    manifest = with_audio(folder)
    manifest["items"][2]["audio"]["voice"] = "nope"
    write_manifest(folder, manifest)
    proc = run_cli(folder)
    assert proc.returncode == 1
    assert warning_lines(proc) == [
        "warning: manifest.json: audio.tracks.line: no item uses this "
        "track"]


def test_video_sound_on_an_image_item_is_rejected(folder: Path) -> None:
    manifest = with_audio(folder)
    manifest["items"][IMAGE]["audio"] = {"videoSound": {"track": "clip"}}
    problem = only_problem(folder, manifest)
    assert problem.startswith(f"manifest.json: items[{IMAGE}].audio:")
    assert "videoSound" in problem


@pytest.mark.parametrize("index", [ANIM, 2])
def test_video_sound_only_on_video_items(folder: Path, index: int) -> None:
    manifest = with_audio(folder)
    manifest["items"][index]["audio"] = {"videoSound": {"track": "clip"}}
    problem = only_problem(folder, manifest)
    assert problem.startswith(f"manifest.json: items[{index}].audio:")
    assert "videoSound" in problem


def test_video_sound_track_shorter_than_the_video_is_rejected(
        folder: Path) -> None:
    manifest = with_audio(folder)
    manifest["audio"]["tracks"]["clip"]["durationSeconds"] = 1.9
    problem = only_problem(folder, manifest)
    assert problem.startswith(
        f"manifest.json: items[{VIDEO}].audio.videoSound.track:")
    assert "1.9" in problem and "2.0" in problem


def test_video_sound_track_within_the_slack_passes(folder: Path) -> None:
    manifest = with_audio(folder)
    manifest["audio"]["tracks"]["clip"]["durationSeconds"] = 1.96
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


def test_video_sound_track_is_measured_against_the_range_end(
        folder: Path) -> None:
    """range-a ends at 1.0 s of a 2.0 s file: a 1.0 s track is long
    enough, a 0.9 s one is not."""
    manifest = with_audio(folder)
    manifest["items"][RANGE_A]["audio"] = {"videoSound": {"track": "clip"}}
    manifest["audio"]["tracks"]["clip"]["durationSeconds"] = 1.0
    del manifest["items"][VIDEO]["audio"]
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    manifest["audio"]["tracks"]["clip"]["durationSeconds"] = 0.9
    problem = only_problem(folder, manifest)
    assert problem.startswith(
        f"manifest.json: items[{RANGE_A}].audio.videoSound.track:")


def test_duplicate_ambience_id_is_rejected(folder: Path) -> None:
    manifest = with_audio(folder)
    manifest["items"][0]["audio"]["ambience"] = ["rain", "wind", "rain"]
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: items[0].audio.ambience[2]:")
    assert "duplicate" in problem and "'rain'" in problem


@pytest.mark.parametrize("path, value, loc", [
    (("audio", "tracks", "theme", "volume"), 1.5,
     "audio.tracks.theme.volume"),
    (("audio", "tracks", "theme", "volume"), -0.1,
     "audio.tracks.theme.volume"),
    (("audio", "tracks", "theme", "durationSeconds"), 0,
     "audio.tracks.theme.durationSeconds"),
    (("audio", "tracks", "theme", "startSeconds"), -1,
     "audio.tracks.theme.startSeconds"),
    (("audio", "tracks", "theme", "loop"), "yes",
     "audio.tracks.theme.loop"),
    (("items", VIDEO, "audio", "videoSound", "duck"), 1.5,
     f"items[{VIDEO}].audio.videoSound.duck"),
    (("items", 0, "audio", "fadeMs"), -1, "items[0].audio.fadeMs"),
    (("items", 1, "audio", "sfx", 0, "delayMs"), -1,
     "items[1].audio.sfx[0].delayMs"),
])
def test_audio_numbers_out_of_range_are_rejected(
        folder: Path, path: tuple[Any, ...], value: object, loc: str) -> None:
    manifest = with_audio(folder)
    target: Any = manifest
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    problem = only_problem(folder, manifest)
    assert problem.startswith(f"manifest.json: {loc}:")


def test_volume_above_one_names_the_limit(folder: Path) -> None:
    manifest = with_audio(folder)
    manifest["audio"]["tracks"]["theme"]["volume"] = 1.5
    assert only_problem(folder, manifest) == (
        "manifest.json: audio.tracks.theme.volume: must be at most 1 "
        "(found 1.5)")


@pytest.mark.parametrize("field", ["startSeconds", "loopStartSeconds"])
def test_track_start_must_lie_inside_its_duration(folder: Path,
                                                  field: str) -> None:
    manifest = with_audio(folder)
    manifest["audio"]["tracks"]["theme"][field] = 120.0
    problem = only_problem(folder, manifest)
    assert problem == (
        f"manifest.json: audio.tracks.theme.{field}: must be less than "
        "durationSeconds 120.0 (found 120.0)")


def test_item_audio_without_tracks_is_rejected(folder: Path) -> None:
    manifest = read_manifest(folder)
    manifest["items"][0]["audio"] = {"fadeMs": 500}
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: items[0].audio:")
    assert "audio.tracks" in problem


def test_item_audio_with_empty_tracks_is_rejected_once(folder: Path) -> None:
    """With no tracks at all the item says so once, not once per id."""
    manifest = read_manifest(folder)
    manifest["audio"] = {"tracks": {}}
    manifest["items"][0]["audio"] = {"music": "theme", "voice": "line"}
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: items[0].audio:")


@pytest.mark.parametrize("ext", [".ogg", ".oga", ".opus"])
def test_ogg_track_warns_and_leaves_the_exit_alone(folder: Path,
                                                   ext: str) -> None:
    manifest = with_audio(folder)
    put_track(folder, f"rain{ext}")
    manifest["audio"]["tracks"]["rain"]["file"] = f"rain{ext}"
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout == ""
    [warning] = warning_lines(proc)
    # What is true now that every track decodes with decodeAudioData
    # (docs/content-format.md § Tracks, measured in docs/plan.md Phase 47
    # item 16), and what kinetic-media does with Ogg (assets.py).
    assert warning == (
        f"warning: manifest.json: audio.tracks.rain.file: Ogg audio "
        f"'rain{ext}': Safari plays Ogg only from 18.4 (macOS 15.4) and "
        "WebKit's decode of Vorbis in Ogg loses its first 128 samples; "
        "kinetic-media copies Ogg into WebM, or re-encodes a looping Opus "
        "to AAC")
    assert proc.stderr == f"{warning}\n{folder}: 1 audio warning\n"


def test_ogg_warning_leaves_problem_lines_and_exit_one_alone(
        folder: Path) -> None:
    manifest = with_audio(folder)
    (folder / manifest["items"][0]["file"]).unlink()
    write_manifest(folder, manifest)
    without = run_cli(folder)
    put_track(folder, "rain.ogg")
    manifest["audio"]["tracks"]["rain"]["file"] = "rain.ogg"
    write_manifest(folder, manifest)
    proc = run_cli(folder)
    assert (proc.returncode, without.returncode) == (1, 1)
    assert proc.stdout == without.stdout
    assert len(warning_lines(proc)) == 1
    assert proc.stderr == (without.stderr + warning_lines(proc)[0] + "\n"
                           + f"{folder}: 1 audio warning\n")


def test_unused_track_warns(folder: Path) -> None:
    manifest = with_audio(folder)
    manifest["audio"]["tracks"]["spare"] = {"file": AUDIO_FILES["door"],
                                            "durationSeconds": 1.5}
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout == ""
    assert proc.stderr == (
        "warning: manifest.json: audio.tracks.spare: no item uses this "
        f"track\n{folder}: 1 audio warning\n")


def test_audio_warnings_come_before_poster_warnings(folder: Path) -> None:
    manifest = with_audio(folder)
    manifest["audio"]["tracks"]["spare"] = {"file": AUDIO_FILES["door"],
                                            "durationSeconds": 1.5}
    write_manifest(folder, manifest)
    proc = run_with_ledger(folder, matching_ledger(manifest))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stderr.splitlines()[1:] == [
        f"{folder}: 1 audio warning", f"{folder}: 0 poster warnings"]


@pytest.mark.parametrize("path", [DEMO_DIR, BRANCH_EXAMPLE])
def test_output_without_audio_is_unchanged(demo: Path, path: Path) -> None:
    """Captured before audio existed: both folders printed nothing and
    exited 0."""
    proc = run_cli(path)
    assert (proc.returncode, proc.stdout, proc.stderr) == (0, "", "")
    assert validate_content.audio_warnings(read_manifest(path), path) == []


def test_audio_rules_reported_without_schema() -> None:
    """The cross-field audio rules hold without the schema, and malformed
    values the schema reports do not crash them."""
    manifest = {"audio": {"tracks": {
        "a": {"file": "a.mp3", "durationSeconds": 1.0, "startSeconds": 2},
        "b": "not a track"}},
        "items": [
            {"id": "v", "type": "video", "durationSeconds": 3.0,
             "audio": {"videoSound": {"track": "a"},
                       "ambience": ["a", "a", 7], "sfx": [None, {}],
                       "music": 3}},
            {"id": "i", "type": "image", "audio": "not an object"},
            "not an item"]}
    assert validate_content.audio_problems(manifest) == [
        "manifest.json: audio.tracks.a.startSeconds: must be less than "
        "durationSeconds 1.0 (found 2)",
        "manifest.json: items[0].audio.ambience[1]: duplicate ambience id "
        "'a' (first at ambience[0])",
        "manifest.json: items[0].audio.videoSound.track: track 'a' "
        "durationSeconds 1.0 is shorter than the item's range end 3.0 by "
        "more than 0.05 s",
    ]
    assert validate_content.audio_warnings(manifest, Path("absent")) == [
        "warning: manifest.json: audio.tracks.a.file: " + LOOP_MP3_WARNING,
        "warning: manifest.json: audio.tracks.b: no item uses this track"]


# ---------------------------------------------------------------------------
# Audio scripts and loop-safe formats (docs/content-format.md § Audio;
# docs/plan.md Phase 47 item 17)
# ---------------------------------------------------------------------------

LOOP_FIX = ("so it may click at each loop; ship it as AAC (M4A), Vorbis in "
            "WebM, WAV or FLAC (kinetic-media does so for an audio request "
            'with "loops": true)')
LOOP_MP3_WARNING = ("a looping track in MP3: WebKit decodes it 576 samples "
                    "late, " + LOOP_FIX)
# The heads a file's codec is told by: a WebM's CodecID, an Ogg stream's
# first packet.
OPUS_WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 40 + b"\x86\x86A_OPUS" + DUMMY
VORBIS_WEBM = (b"\x1a\x45\xdf\xa3" + b"\x00" * 40 + b"\x86\x88A_VORBIS"
               + DUMMY)
VORBIS_OGG = b"OggS" + b"\x00" * 24 + b"\x01vorbis" + DUMMY
OPUS_OGG = b"OggS" + b"\x00" * 24 + b"OpusHead" + DUMMY


def test_missing_script_is_reported(folder: Path) -> None:
    manifest = with_audio(folder)
    (folder / "rain.webm.js").unlink()
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: audio.tracks.rain.file:")
    assert "'rain.webm.js'" in problem
    assert "tools/assemble_folder.py" in problem


def test_missing_script_of_a_shared_file_is_reported_once(
        folder: Path) -> None:
    manifest = with_audio(folder)
    (folder / "door.mp3.js").unlink()
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: audio.tracks.door.file:")


def test_script_in_a_subfolder_sits_beside_its_file(folder: Path) -> None:
    manifest = with_audio(folder)
    (folder / "media" / "au" / "theme.m4a.js").rename(
        folder / "theme.m4a.js")
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: audio.tracks.theme.file:")
    assert "'media/au/theme.m4a.js'" in problem


@pytest.mark.parametrize(("script", "says"), [
    (audio_format.script_bytes("rain.webm", b"other bytes"),
     "holds 11 bytes that are not the file's 28"),
    (audio_format.script_bytes("wind.flac", DUMMY), "names 'wind.flac'"),
    (b"window.rain = 1;\n", "not one __kineticAudio"),
])
def test_script_that_does_not_match_its_file_is_reported(
        folder: Path, script: bytes, says: str) -> None:
    manifest = with_audio(folder)
    (folder / "rain.webm.js").write_bytes(script)
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: audio.tracks.rain.file:")
    assert "script 'rain.webm.js' does not match it" in problem
    assert says in problem


# An assembled folder ships each track's script alone (docs/plan.md Phase
# 47 item 19): the player reads only the script, so the validator checks
# the script and reads the file's bytes from it.

def test_tracks_shipped_as_their_scripts_alone_pass(folder: Path) -> None:
    manifest = with_audio(folder)
    for path in AUDIO_FILES.values():
        (folder / path).unlink()
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert (proc.returncode, proc.stdout, proc.stderr) == (0, "", "")


def test_a_script_alone_in_a_subfolder_passes(folder: Path) -> None:
    manifest = with_audio(folder)
    (folder / AUDIO_FILES["theme"]).unlink()
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


@pytest.mark.parametrize(("script", "says"), [
    (audio_format.script_bytes("wind.flac", DUMMY), "names 'wind.flac'"),
    (b"window.rain = 1;\n", "not one __kineticAudio"),
    (b'__kineticAudio("rain.webm","not base64!");\n',
     "not one __kineticAudio"),
])
def test_a_script_alone_that_is_not_its_files_is_reported(
        folder: Path, script: bytes, says: str) -> None:
    manifest = with_audio(folder)
    (folder / "rain.webm").unlink()
    (folder / "rain.webm.js").write_bytes(script)
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: audio.tracks.rain.file:")
    assert "script 'rain.webm.js'" in problem
    assert says in problem


def test_a_script_alone_that_resolves_outside_the_folder_is_reported(
        folder: Path, tmp_path: Path) -> None:
    manifest = with_audio(folder)
    outside = tmp_path / "outside.js"
    outside.write_bytes(audio_format.script_bytes("rain.webm", DUMMY))
    (folder / "rain.webm").unlink()
    (folder / "rain.webm.js").unlink()
    (folder / "rain.webm.js").symlink_to(outside)
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: audio.tracks.rain.file:")
    assert "outside the content folder" in problem


@pytest.mark.parametrize(("track", "file", "data", "says"), [
    ("theme", "theme.mp3", DUMMY, LOOP_MP3_WARNING),
    ("rain", "rain.webm", OPUS_WEBM,
     "a looping track in Opus in WebM: Chrome's decode loses its first 24 "
     "samples, " + LOOP_FIX),
    ("clip", "clip.mp3", DUMMY, LOOP_MP3_WARNING),
])
def test_looping_track_in_an_unsafe_format_warns(
        folder: Path, track: str, file: str, data: bytes, says: str) -> None:
    manifest = with_audio(folder)
    put_track(folder, file, data)
    manifest["audio"]["tracks"][track]["file"] = file
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert (proc.returncode, proc.stdout) == (0, ""), proc.stderr
    assert warning_lines(proc) == [
        f"warning: manifest.json: audio.tracks.{track}.file: {says}"]


@pytest.mark.parametrize(("file", "data", "says"), [
    ("rain.webm", OPUS_WEBM,
     "a looping track in Opus in WebM: Chrome's decode loses its first 24 "
     "samples, " + LOOP_FIX),
    ("rain.ogg", VORBIS_OGG,
     "a looping track in Vorbis in Ogg: WebKit's decode loses its first "
     "128 samples, " + LOOP_FIX),
])
def test_a_loops_format_is_read_from_its_script_alone(
        folder: Path, file: str, data: bytes, says: str) -> None:
    manifest = with_audio(folder)
    put_track(folder, file, data)
    (folder / file).unlink()
    manifest["audio"]["tracks"]["rain"]["file"] = file
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    lines = warning_lines(run_cli(folder))
    assert lines[-1] == f"warning: manifest.json: audio.tracks.rain.file: {says}"


def test_looping_ogg_vorbis_warns_twice(folder: Path) -> None:
    manifest = with_audio(folder)
    put_track(folder, "rain.ogg", VORBIS_OGG)
    manifest["audio"]["tracks"]["rain"]["file"] = "rain.ogg"
    write_manifest(folder, manifest)
    lines = warning_lines(run_cli(folder))
    assert len(lines) == 2
    assert "Ogg audio" in lines[0]
    assert lines[1] == (
        "warning: manifest.json: audio.tracks.rain.file: a looping track in "
        "Vorbis in Ogg: WebKit's decode loses its first 128 samples, "
        + LOOP_FIX)


@pytest.mark.parametrize(("track", "file", "data", "fields"), [
    ("theme", "theme.mp3", DUMMY, {"loop": False}),
    ("rain", "rain.webm", VORBIS_WEBM, {}),
    ("door", "door.mp3", DUMMY, {}),
    ("line", "line.webm", OPUS_WEBM, {}),
    ("rain", "rain.flac", DUMMY, {}),
])
def test_one_shots_voice_and_safe_loops_do_not_warn(
        folder: Path, track: str, file: str, data: bytes,
        fields: dict[str, Any]) -> None:
    manifest = with_audio(folder)
    put_track(folder, file, data)
    manifest["audio"]["tracks"][track].update(file=file, **fields)
    write_manifest(folder, manifest)
    proc = run_cli(folder)
    assert (proc.returncode, proc.stdout, proc.stderr) == (0, "", "")


def test_looping_ogg_opus_gets_only_the_ogg_warning(folder: Path) -> None:
    manifest = with_audio(folder)
    put_track(folder, "rain.opus", OPUS_OGG)
    manifest["audio"]["tracks"]["rain"]["file"] = "rain.opus"
    write_manifest(folder, manifest)
    [line] = warning_lines(run_cli(folder))
    assert "Ogg audio" in line
