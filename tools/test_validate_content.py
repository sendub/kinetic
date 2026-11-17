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
LANG_SCHEMA = REPO_ROOT / "docs" / "lang.schema.json"

if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))
if str(REPO_ROOT / "converter") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "converter"))

import validate_content  # noqa: E402
from kinetic_extract import audio_format  # noqa: E402
from kinetic_extract import language_file  # noqa: E402


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
TEXT = 7   # video-chain-2: a text item over video-chain


def test_demo_roles_match_ids(demo: Path) -> None:
    ids = [item["id"] for item in read_manifest(demo)["items"]]
    assert (ids[IMAGE], ids[ANIM], ids[VIDEO], ids[TEXT]) == (
        "text-bare", "anim-orbit", "video-chain", "video-chain-2")


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


# ---------------------------------------------------------------------------
# Video segments (docs/content-format.md § Video segments)
# ---------------------------------------------------------------------------

def segment(start: float, end: float,
            loop_start: float | None = None) -> dict[str, float]:
    out = {"startSeconds": start, "endSeconds": end}
    if loop_start is not None:
        out["loopStartSeconds"] = loop_start
    return out


def segment_problems(folder: Path, segments: Any, duration: float = 30.0,
                     **fields: Any) -> list[str]:
    """Problems of the demo with the video item's `segments` (and any other
    video fields) set; the validator trusts `durationSeconds`."""
    manifest = read_manifest(folder)
    video = manifest["items"][VIDEO]
    video["durationSeconds"] = duration
    video["segments"] = segments
    video.update(fields)
    write_manifest(folder, manifest)
    return problems_of(folder)


SEG = f"manifest.json: items[{VIDEO}].segments"


def test_video_segments_in_order_pass(folder: Path) -> None:
    """Segments in order with gaps between them, the last ending at
    `durationSeconds`, are valid; the CLI agrees."""
    assert segment_problems(folder, [segment(0, 5), segment(6, 10, 7),
                                     segment(12, 30)]) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_video_segments_touching_pass(folder: Path) -> None:
    """A segment may start exactly where the one before ends."""
    assert segment_problems(folder, [segment(0, 5), segment(5, 10)]) == []


def test_video_segments_overlap_is_rejected(folder: Path) -> None:
    problems = segment_problems(folder, [segment(0, 5), segment(4.5, 10)])
    assert problems == [
        f"{SEG}[1].startSeconds: must not be before segments[0].endSeconds "
        f"5 (found 4.5)"]


def test_video_segments_out_of_order_are_rejected(folder: Path) -> None:
    problems = segment_problems(folder, [segment(10, 20), segment(0, 5)])
    assert problems == [
        f"{SEG}[1].startSeconds: must not be before segments[0].endSeconds "
        f"20 (found 0)"]


def test_video_segment_negative_start_is_rejected(folder: Path) -> None:
    """Said once: the schema's `minimum` and the validator's own rule
    name the same location."""
    problems = segment_problems(folder, [segment(-0.5, 5)])
    assert len(problems) == 1
    assert problems[0].startswith(f"{SEG}[0].startSeconds:")
    assert "-0.5" in problems[0]


def test_video_segment_end_not_after_start_is_rejected(folder: Path) -> None:
    problems = segment_problems(folder, [segment(5, 5)])
    assert problems == [
        f"{SEG}[0].endSeconds: must be greater than startSeconds 5 "
        f"(found 5)"]


def test_video_segment_end_beyond_duration_is_rejected(folder: Path) -> None:
    problems = segment_problems(folder, [segment(0, 5), segment(5, 30.5)])
    assert problems == [
        f"{SEG}[1].endSeconds: must not exceed durationSeconds 30.0 "
        f"(found 30.5)"]


def test_video_segment_loop_start_at_end_is_rejected(folder: Path) -> None:
    problems = segment_problems(folder, [segment(0, 5, 5)])
    assert problems == [
        f"{SEG}[0].loopStartSeconds: must be less than endSeconds 5 "
        f"(found 5)"]


def test_video_segment_loop_start_past_end_is_rejected(folder: Path) -> None:
    problems = segment_problems(folder, [segment(0, 5, 6)])
    assert problems == [
        f"{SEG}[0].loopStartSeconds: must be less than endSeconds 5 "
        f"(found 6)"]


def test_video_segment_loop_start_below_start_passes(folder: Path) -> None:
    """As for an item's own `loopStartSeconds`, a loop may restart before
    the segment's start, even inside the segment before."""
    assert segment_problems(folder, [segment(0, 5), segment(6, 10, 1)]) == []


def test_video_segment_negative_loop_start_is_rejected(folder: Path) -> None:
    problems = segment_problems(folder, [segment(2, 5, -1)])
    assert len(problems) == 1
    assert problems[0].startswith(f"{SEG}[0].loopStartSeconds:")
    assert "-1" in problems[0]


def test_video_segment_unknown_key_is_rejected(folder: Path) -> None:
    problems = segment_problems(folder, [dict(segment(0, 5), label="near")])
    assert len(problems) == 1
    assert problems[0].startswith(f"{SEG}[0]:")
    assert "label" in problems[0]


def test_video_segment_missing_end_is_rejected(folder: Path) -> None:
    problems = segment_problems(folder, [{"startSeconds": 0}])
    assert len(problems) == 1
    assert problems[0].startswith(f"{SEG}[0]:")
    assert "endSeconds" in problems[0]


@pytest.mark.parametrize("index", [IMAGE, ANIM, TEXT])
def test_segments_on_a_non_video_item_are_rejected(folder: Path,
                                                   index: int) -> None:
    manifest = read_manifest(folder)
    manifest["items"][index]["segments"] = [segment(0, 1)]
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1
    assert problems[0].startswith(f"manifest.json: items[{index}]:")
    assert "segments" in problems[0]


def test_video_segments_empty_list_is_rejected(folder: Path) -> None:
    problems = segment_problems(folder, [])
    assert len(problems) == 1
    assert problems[0].startswith(f"{SEG}:")
    assert "at least 1 entries" in problems[0]


@pytest.mark.parametrize("value", ["0-5", 3, None, segment(0, 5)])
def test_video_segments_not_a_list_is_rejected(folder: Path,
                                               value: Any) -> None:
    problems = segment_problems(folder, value)
    assert len(problems) == 1
    assert problems[0].startswith(f"{SEG}:")
    assert "type array" in problems[0]


@pytest.mark.parametrize("value", [5, "0-5", [0, 5], None])
def test_video_segment_not_an_object_is_rejected(folder: Path,
                                                 value: Any) -> None:
    """A malformed entry is one schema problem; the validator's own
    rules pass over it, and over its neighbours' order against it."""
    problems = segment_problems(folder, [value, segment(0, 5)])
    assert len(problems) == 1
    assert problems[0].startswith(f"{SEG}[0]:")
    assert "type object" in problems[0]


@pytest.mark.parametrize("field", ["startSeconds", "endSeconds",
                                   "loopStartSeconds"])
@pytest.mark.parametrize("value", ["1", True, None, [1]])
def test_video_segment_non_number_is_rejected(folder: Path, field: str,
                                              value: Any) -> None:
    entry: dict[str, Any] = segment(1, 5)
    entry[field] = value
    problems = segment_problems(folder, [segment(0, 1), entry,
                                         segment(5, 6)])
    assert len(problems) == 1
    assert problems[0].startswith(f"{SEG}[1].{field}:")
    assert "type number" in problems[0]


def test_video_segments_compare_floats_exactly(folder: Path) -> None:
    """No rounding: times copied from timing files, float noise and all,
    touch exactly; values are stored verbatim."""
    segments = [segment(0, 17.04), segment(17.04, 81.03999999999999),
                segment(81.03999999999999, 120.0, 81.03999999999999)]
    assert segment_problems(folder, segments, duration=120.0) == []
    stored = read_manifest(folder)["items"][VIDEO]["segments"]
    assert stored[1]["endSeconds"] == 81.03999999999999
    assert stored[2]["startSeconds"] == 81.03999999999999


def test_video_segments_hair_overlap_is_rejected(folder: Path) -> None:
    """Exact comparison cuts both ways: no tolerance hides an overlap
    of one float step."""
    problems = segment_problems(
        folder, [segment(0, 81.04), segment(81.03999999999999, 120.0)],
        duration=120.0)
    assert problems == [
        f"{SEG}[1].startSeconds: must not be before segments[0].endSeconds "
        f"81.04 (found 81.03999999999999)"]


def test_video_segments_end_at_duration_with_float_noise_pass(
        folder: Path) -> None:
    problems = segment_problems(folder, [segment(10, 81.03999999999999)],
                                duration=81.03999999999999)
    assert problems == []


def test_video_segments_outside_the_item_range_pass(folder: Path) -> None:
    """Segments are file times, free of the item's own range."""
    assert segment_problems(folder, [segment(0, 5), segment(20, 30, 0)],
                            startSeconds=10.0, endSeconds=15.0,
                            loopStartSeconds=12.0) == []


def test_video_segment_rules_reported_without_schema() -> None:
    """The validator's own rules, for the cross-field ones the schema
    cannot express and the negatives it can."""
    manifest = {"items": [{"id": "v", "type": "video", "durationSeconds": 10,
                           "segments": [segment(-1, 4, -2), segment(3, 3),
                                        segment(5, 11, 11)]}]}
    assert validate_content.video_segment_problems(manifest) == [
        "manifest.json: items[0].segments[0].startSeconds: must not be "
        "negative (found -1)",
        "manifest.json: items[0].segments[0].loopStartSeconds: must not be "
        "negative (found -2)",
        "manifest.json: items[0].segments[1].startSeconds: must not be "
        "before segments[0].endSeconds 4 (found 3)",
        "manifest.json: items[0].segments[1].endSeconds: must be greater "
        "than startSeconds 3 (found 3)",
        "manifest.json: items[0].segments[2].endSeconds: must not exceed "
        "durationSeconds 10 (found 11)",
        "manifest.json: items[0].segments[2].loopStartSeconds: must be "
        "less than endSeconds 11 (found 11)",
    ]


@pytest.mark.parametrize("manifest", [
    None, [], {"items": "x"}, {"items": [None, 3, "v"]},
    {"items": [{"type": "video", "segments": "x"}]},
    {"items": [{"type": "video", "segments": [None, 1, "s", [], {}]}]},
    {"items": [{"type": "video", "durationSeconds": "10",
                "segments": [{"startSeconds": "0", "endSeconds": None,
                              "loopStartSeconds": True}]}]},
    {"items": [{"type": "image", "segments": [segment(-1, -2)]}]},
])
def test_video_segment_rules_skip_malformed_input(manifest: Any) -> None:
    """Shapes the schema reports leave the validator's own rules silent,
    never raising."""
    assert validate_content.video_segment_problems(manifest) == []


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
    "The Lantern at Low Tide", "PAPER Lanes: Part 'Two'!", "夏の終わり",
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
# version (docs/plan.md Phase 51 item 3): the game's own release, optional,
# a non-blank string of at most 40 characters when present. The validator
# checks it through docs/content-schema.json, so these cases are the
# schema's too.
# ---------------------------------------------------------------------------

def test_demo_carries_no_version(demo: Path) -> None:
    assert "version" not in read_manifest(demo)


def test_absent_version_stays_valid(folder: Path) -> None:
    manifest = read_manifest(folder)
    manifest.pop("version", None)
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


@pytest.mark.parametrize("version", [
    "1.2", "0.9 beta", "Episode 3", "<b>not html</b>", "第三話", "x",
    " 1.0 ", "x" * 40])
def test_versions_pass(folder: Path, version: str) -> None:
    manifest = read_manifest(folder)
    manifest["version"] = version
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


@pytest.mark.parametrize("version", ["", "   ", "x" * 41, 1.2, 3, None])
def test_bad_version_is_rejected(folder: Path, version: object) -> None:
    manifest = read_manifest(folder)
    manifest["version"] = version
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1, problems
    assert problems[0].startswith("manifest.json: version:"), problems


# ---------------------------------------------------------------------------
# $schema (docs/plan.md Phase 51 item 5): an optional string naming the JSON
# Schema an editor checks manifest.json against; kinetic-extract writes
# "./manifest.schema.json". Its value is never read: any string passes.
# Every other unknown top-level key is still rejected.
# ---------------------------------------------------------------------------

def test_schema_declares_dollar_schema_as_any_string() -> None:
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    assert schema["properties"]["$schema"]["type"] == "string"
    assert set(schema["properties"]["$schema"]) <= {"type", "description"}
    assert "$schema" not in schema["required"]
    assert schema["additionalProperties"] is False


@pytest.mark.parametrize("value", [
    "./manifest.schema.json", "https://example.invalid/schema.json",
    "not a path at all", ""])
def test_dollar_schema_strings_pass(folder: Path, value: str) -> None:
    manifest = {"$schema": value, **read_manifest(folder)}
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr


@pytest.mark.parametrize("value", [1, None, True, {}, ["./x.json"]])
def test_non_string_dollar_schema_is_rejected(folder: Path,
                                              value: object) -> None:
    manifest = read_manifest(folder)
    manifest["$schema"] = value
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1, problems
    assert problems[0].startswith("manifest.json: $schema:"), problems


@pytest.mark.parametrize("key", ["$id", "schema", "manifestSchema"])
def test_other_unknown_top_level_keys_are_still_rejected(
        folder: Path, key: str) -> None:
    manifest = read_manifest(folder)
    manifest["$schema"] = "./manifest.schema.json"
    manifest[key] = "./manifest.schema.json"
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1, problems
    assert problems[0].startswith("manifest.json:"), problems
    assert repr(key) in problems[0], problems


def test_a_schema_copy_in_the_folder_is_not_a_problem(folder: Path) -> None:
    """kinetic-extract's manifest.schema.json beside manifest.json is an
    unreferenced extra like the build ledger."""
    shutil.copyfile(SCHEMA, folder / "manifest.schema.json")
    manifest = {"$schema": "./manifest.schema.json", **read_manifest(folder)}
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout + proc.stderr == ""


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
    assert proc.stderr == ""


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
    assert proc.stderr.splitlines()[1:] == [f"{folder}: 1 audio warning"]
    ledger = matching_ledger(manifest)
    poster_entry(ledger, manifest, RANGE_B)["steps"][0]["startSeconds"] = 0.0
    lines = run_with_ledger(folder, ledger).stderr.splitlines()
    assert lines[1] == f"{folder}: 1 audio warning"
    assert lines[2].startswith("warning: manifest.json: items[15].poster: ")
    assert lines[3:] == [f"{folder}: 1 poster warning"]


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


# ---------------------------------------------------------------------------
# Voices (docs/content-format.md § Voices; docs/plan.md Phase 52 item 1):
# the top-level `voices` (speaker name -> reference clip) and `narrator`.
# A voice's `file` follows a track file's rules: an audio extension, a
# media path in the folder, and its script beside it or alone.
# ---------------------------------------------------------------------------

VOICE_FILES = {"Mei": "voices/mei.flac", "Theo": "theo.wav",
               "narrator": "media/vo/narrator.m4a"}


def with_voices(folder: Path) -> dict[str, Any]:
    """The demo manifest with voices for its two speakers (Mei and Theo)
    and a narrator, each clip a dummy with its script. Every voice is
    used, so nothing warns."""
    for path in VOICE_FILES.values():
        put_track(folder, path)
    manifest = read_manifest(folder)
    manifest["voices"] = {
        "Mei": {"file": VOICE_FILES["Mei"],
                "text": "The tide is coming in early tonight.",
                "description": "A bright, quick young woman."},
        "Theo": {"file": VOICE_FILES["Theo"]},
    }
    manifest["narrator"] = {"file": VOICE_FILES["narrator"],
                            "text": "Evening settled over the harbour."}
    return manifest


def test_voices_and_narrator_pass(folder: Path) -> None:
    write_manifest(folder, with_voices(folder))
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert (proc.returncode, proc.stdout, proc.stderr) == (0, "", "")


def test_a_speaker_without_a_voice_is_fine(folder: Path) -> None:
    manifest = with_voices(folder)
    del manifest["voices"]["Theo"]
    del manifest["narrator"]
    write_manifest(folder, manifest)
    proc = run_cli(folder)
    assert (proc.returncode, proc.stdout, proc.stderr) == (0, "", "")


@pytest.mark.parametrize(("name", "loc"), [
    ("Mei", "voices.Mei.file"), ("narrator", "narrator.file")])
def test_missing_voice_file_and_script_is_reported(
        folder: Path, name: str, loc: str) -> None:
    manifest = with_voices(folder)
    (folder / VOICE_FILES[name]).unlink()
    (folder / f"{VOICE_FILES[name]}.js").unlink()
    problem = only_problem(folder, manifest)
    assert problem.startswith(f"manifest.json: {loc}:")
    assert "does not exist" in problem
    assert f"nor its script '{VOICE_FILES[name]}.js'" in problem


@pytest.mark.parametrize(("name", "loc"), [
    ("Theo", "voices.Theo.file"), ("narrator", "narrator.file")])
def test_missing_voice_script_is_reported(folder: Path, name: str,
                                          loc: str) -> None:
    manifest = with_voices(folder)
    (folder / f"{VOICE_FILES[name]}.js").unlink()
    problem = only_problem(folder, manifest)
    assert problem.startswith(f"manifest.json: {loc}:")
    assert f"no script '{VOICE_FILES[name]}.js' beside it" in problem


def test_voice_script_that_does_not_match_its_file_is_reported(
        folder: Path) -> None:
    manifest = with_voices(folder)
    (folder / "theo.wav.js").write_bytes(
        audio_format.script_bytes("theo.wav", b"other bytes"))
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: voices.Theo.file:")
    assert "script 'theo.wav.js' does not match it" in problem


def test_voices_shipped_as_their_scripts_alone_pass(folder: Path) -> None:
    manifest = with_voices(folder)
    for path in VOICE_FILES.values():
        (folder / path).unlink()
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert (proc.returncode, proc.stdout, proc.stderr) == (0, "", "")


def test_a_voice_script_alone_that_is_not_its_files_is_reported(
        folder: Path) -> None:
    manifest = with_voices(folder)
    (folder / "theo.wav").unlink()
    (folder / "theo.wav.js").write_bytes(
        audio_format.script_bytes("other.wav", DUMMY))
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: voices.Theo.file:")
    assert "shipped without the file" in problem


def test_a_file_both_a_track_and_a_voice_is_checked_once(
        folder: Path) -> None:
    manifest = with_voices(folder)
    manifest["audio"] = {"tracks": {"mei-ref": {
        "file": VOICE_FILES["Mei"], "durationSeconds": 11.0}}}
    manifest["items"][1]["audio"] = {"voice": "mei-ref"}
    (folder / f"{VOICE_FILES['Mei']}.js").unlink()
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: audio.tracks.mei-ref.file:")


@pytest.mark.parametrize("file", ["voices/mei.txt", "voices/mei.mp4",
                                  "../mei.flac", "/voices/mei.flac"])
def test_voice_file_breaking_the_audio_path_rules_is_reported(
        folder: Path, file: str) -> None:
    manifest = with_voices(folder)
    if not file.startswith(("/", "..")):
        put_track(folder, file)  # present, so only the extension is wrong
    manifest["voices"]["Mei"]["file"] = file
    problem = only_problem(folder, manifest)
    assert problem.startswith("manifest.json: voices.Mei.file:")


@pytest.mark.parametrize("ext", ["mp3", "m4a", "wav", "flac", "webm",
                                 "ogg", "oga", "opus"])
def test_every_track_extension_is_a_voice_extension(
        folder: Path, ext: str) -> None:
    manifest = with_voices(folder)
    put_track(folder, f"mei.{ext}")
    manifest["voices"]["Mei"]["file"] = f"mei.{ext}"
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert (proc.returncode, proc.stdout, proc.stderr) == (0, "", "")


@pytest.mark.parametrize(("change", "loc"), [
    (lambda m: m["voices"]["Mei"].update(pitch=1.2), "voices.Mei"),
    (lambda m: m["narrator"].update(speaker="Narrator"), "narrator"),
    (lambda m: m["voices"]["Mei"].update(text=""), "voices.Mei.text"),
    (lambda m: m["voices"]["Mei"].update(description=""),
     "voices.Mei.description"),
    (lambda m: m["narrator"].update(text=7), "narrator.text"),
    (lambda m: m["voices"]["Theo"].pop("file"), "voices.Theo"),
    (lambda m: m["voices"].update(Theo="theo.wav"), "voices.Theo"),
    (lambda m: m.update(narrator=[VOICE_FILES["narrator"]]), "narrator"),
    (lambda m: m.update(voices=["Mei"]), "voices"),
    (lambda m: m["voices"].update({"": {"file": "theo.wav"}}), "voices"),
])
def test_a_badly_shaped_voice_is_rejected(folder: Path, change: Any,
                                          loc: str) -> None:
    manifest = with_voices(folder)
    change(manifest)
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert problems, "expected a problem"
    assert all(p.startswith(f"manifest.json: {loc}:") for p in problems), \
        problems


def test_an_unused_voice_warns_only(folder: Path) -> None:
    manifest = with_voices(folder)
    manifest["voices"]["Nadia"] = {"file": VOICE_FILES["Theo"]}
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert (proc.returncode, proc.stdout) == (0, ""), proc.stderr
    assert warning_lines(proc) == [
        "warning: manifest.json: voices.Nadia: no item's speaker is 'Nadia'"]
    assert proc.stderr.endswith(f"{folder}: 1 voice warning\n")


def test_a_narrator_with_no_line_to_speak_warns_only(folder: Path) -> None:
    manifest = with_voices(folder)
    for item in manifest["items"]:
        if item.get("text") and not item.get("speaker"):
            item["speaker"] = "Theo"
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert (proc.returncode, proc.stdout) == (0, ""), proc.stderr
    assert warning_lines(proc) == [
        "warning: manifest.json: narrator: no item has text without a "
        "speaker"]


def test_voice_warnings_read_speakers_and_text_as_the_overlay_does() -> None:
    """A voice counts as used by an item that names its speaker; the
    narrator by an item with non-blank text and no speaker (absent or
    empty). Malformed values the schema reports do not crash it."""
    voice = {"file": "a.wav"}
    assert validate_content.voice_warnings({
        "voices": {"A": voice, "B": voice, "C": voice},
        "narrator": voice,
        "items": [{"speaker": "A"}, {"speaker": "B", "text": "Hi."},
                  {"speaker": "", "text": "Rain."}, "not an item"]}) == [
        "warning: manifest.json: voices.C: no item's speaker is 'C'"]
    assert validate_content.voice_warnings({
        "narrator": voice, "items": [{"text": "  "}, {"speaker": "A",
                                                      "text": "Hi."}]}) == [
        "warning: manifest.json: narrator: no item has text without a "
        "speaker"]
    assert validate_content.voice_warnings(None) == []
    assert validate_content.voice_warnings({"voices": "x", "items": "x"}) \
        == []


def test_demo_folders_have_no_voices(demo: Path) -> None:
    manifest = read_manifest(demo)
    assert "voices" not in manifest and "narrator" not in manifest
    assert validate_content.voice_warnings(manifest) == []


# ---------------------------------------------------------------------------
# Unreachable items (docs/plan.md Phase 48 item 6; docs/content-format.md,
# "Rules and validator invariants"): an item no reading from the opening
# shows, Play all routes included, warns on stderr; stdout and the exit
# status stay as they were. player/src/machine/reach.test.ts checks on
# generated manifests that the warned items are exactly the ones the
# machine's play-all walk never shows.
# ---------------------------------------------------------------------------

AUDIO_DEMO_DIR = REPO_ROOT / "fixtures" / "audio-demo"
BUILD_AUDIO_DEMO = REPO_ROOT / "fixtures" / "build_audio_demo.py"


@pytest.fixture(scope="session")
def audio_demo() -> Path:
    """fixtures/audio-demo, built by fixtures/build_audio_demo.py (PATH
    ffmpeg) if it is absent, under a lock as `demo` is."""
    lock = REPO_ROOT / ".tmp" / "build-audio-demo.lock"
    lock.parent.mkdir(exist_ok=True)
    with lock.open("w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        if not (AUDIO_DEMO_DIR / "manifest.json").is_file():
            proc = subprocess.run([sys.executable, str(BUILD_AUDIO_DEMO)],
                                  capture_output=True, text=True)
            if proc.returncode != 0:
                pytest.fail(f"build_audio_demo.py failed (exit "
                            f"{proc.returncode}):\n{proc.stdout}{proc.stderr}")
    return AUDIO_DEMO_DIR


def insert_gap(folder: Path, before: str, file: str = "meet-003.jpg"
               ) -> dict[str, Any]:
    """Insert an image item `gap` before the item `before` of the branch
    example copy, reusing one of its pictures, and write the manifest."""
    manifest = read_manifest(folder)
    ids = [item["id"] for item in manifest["items"]]
    manifest["items"].insert(ids.index(before),
                             {"id": "gap", "type": "image", "file": file})
    write_manifest(folder, manifest)
    return manifest


def reach_lines(proc: subprocess.CompletedProcess[str]) -> list[str]:
    return [line for line in warning_lines(proc) if "never shown" in line]


GAP_CASES = {
    # After the last route end, before continueAt (the converting agent's
    # case): home-010 is afternoon's last route end, epilogue-011 its join.
    "after-last-route": (
        "epilogue-011", 10,
        "inside decision 'afternoon' (after 'meet-003', before "
        "'epilogue-011') in none of its routes"),
    # Between `after` and the first route start.
    "before-first-route": (
        "cafe-004", 3,
        "inside decision 'afternoon' (after 'meet-003', before "
        "'epilogue-011') in none of its routes"),
    # Between two route spans.
    "between-routes": (
        "home-009", 8,
        "inside decision 'afternoon' (after 'meet-003', before "
        "'epilogue-011') in none of its routes"),
    # A nested decision's gap, inside the enclosing route `cafe`.
    "nested": (
        "cafe-008", 7,
        "inside decision 'cafe-choice' (after 'cafe-005', before "
        "'cafe-008') in none of its routes"),
}


@pytest.mark.parametrize("case", list(GAP_CASES))
def test_gap_item_warns_once(branch_folder: Path, case: str) -> None:
    before, index, why = GAP_CASES[case]
    insert_gap(branch_folder, before)
    proc = run_cli(branch_folder)
    assert (proc.returncode, proc.stdout) == (0, ""), proc.stderr
    expected = (f"warning: manifest.json: items[{index}]: item 'gap' is "
                f"never shown: {why}")
    assert reach_lines(proc) == [expected]
    assert proc.stderr == (f"{expected}\n{branch_folder}: 1 unreachable "
                           f"item warning\n")


def test_pure_choice_gap_between_routes_warns(branch_folder: Path) -> None:
    """A pure choice's region runs to its last route end: an item between
    its routes is never shown, while what follows the region is (the
    all-played close falls through to it)."""
    manifest = insert_gap(branch_folder, "home-009")
    decision = manifest["branches"][1]
    del decision["continuingRoute"]
    del decision["continueAt"]
    write_manifest(branch_folder, manifest)
    assert validate_content.reach_warnings(manifest) == [
        "warning: manifest.json: items[8]: item 'gap' is never shown: "
        "inside decision 'afternoon' (after 'meet-003', to its last route "
        "end 'home-010') in none of its routes"]


def test_items_of_a_decision_no_reading_reaches_warn() -> None:
    """Past a route end with no decision open the story ends there
    (machine.ts `nothingFollows`): a join landing inside another
    decision's route stops at that route's end, so what lies after it is
    never shown, and the decision whose `after` is skipped never fires."""
    items = [{"id": f"i{n}", "type": "image", "file": f"i{n}.jpg"}
             for n in range(10)]
    manifest = {"items": items, "branches": [
        {"id": "a", "after": "i0", "prompt": "?", "routes": [
            {"id": "a1", "label": "1", "start": "i1", "end": "i1",
             "result": "return"},
            {"id": "a2", "label": "2", "start": "i2", "end": "i2"}],
         "continuingRoute": "a2", "continueAt": "i5"},
        {"id": "b", "after": "i3", "prompt": "?", "routes": [
            {"id": "b1", "label": "1", "start": "i4", "end": "i5"},
            {"id": "b2", "label": "2", "start": "i6", "end": "i7"}]},
    ]}
    lines = validate_content.reach_warnings(manifest)
    assert [re.match(r"warning: manifest\.json: items\[(\d+)\]", line)[1]
            for line in lines] == ["3", "4", "6", "7", "8", "9"]
    assert lines[-1] == ("warning: manifest.json: items[9]: item 'i9' is "
                         "never shown: no reading from the opening reaches "
                         "it")


def test_stdout_and_exit_unchanged_by_the_warning(branch_folder: Path
                                                  ) -> None:
    """With a problem present, adding a gap item changes stderr only."""
    manifest = read_manifest(branch_folder)
    manifest["items"][0]["file"] = "missing.jpg"
    write_manifest(branch_folder, manifest)
    without = run_cli(branch_folder)
    insert_gap(branch_folder, "epilogue-011")
    with_gap = run_cli(branch_folder)
    assert without.returncode == with_gap.returncode == 1
    assert with_gap.stdout == without.stdout != ""
    assert reach_lines(without) == []
    assert len(reach_lines(with_gap)) == 1


@pytest.mark.parametrize("which", ["demo", "branches", "audio"])
def test_fixtures_warn_nothing_unreachable(
        demo: Path, audio_demo: Path, which: str) -> None:
    path = {"demo": demo, "branches": BRANCH_EXAMPLE,
            "audio": audio_demo}[which]
    assert validate_content.reach_warnings(read_manifest(path)) == []
    proc = run_cli(path)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "never shown" not in proc.stderr
    assert "unreachable" not in proc.stderr


def test_reach_warnings_survive_malformed_manifests() -> None:
    """Values the schema reports do not crash the walk, and a linear
    manifest is all reachable."""
    assert validate_content.reach_warnings(None) == []
    assert validate_content.reach_warnings({"items": "x"}) == []
    assert validate_content.reach_warnings({"items": [
        {"id": "a"}, "not an item", {"id": 3}], "branches": [
        "x", {"id": "d", "after": "a", "routes": "x"},
        {"id": "e", "after": "a", "routes": [None, {"start": 1}]}]}) == []


# ---------------------------------------------------------------------------
# Translations (docs/content-format.md § Translations; docs/plan.md Phase
# 54 item 1): the manifest's `language` and `languages`, and a language
# file lang/<tag>.json with its script lang/<tag>.js per listed tag.
# ---------------------------------------------------------------------------

def full_language(manifest: dict[str, Any], tag: str) -> dict[str, Any]:
    """A language file translating every string of `manifest`, each the
    base reversed (so no length warning) with its base hash."""
    def tr(base: str) -> dict[str, str]:
        # Reversed without braces, so a base's text tags leave none
        # broken behind.
        text = base.replace("{", "").replace("}", "")[::-1]
        return {"text": text, "from": language_file.base_hash(base)}

    items = [item for item in manifest["items"] if item.get("text")]
    data: dict[str, Any] = {
        "language": tag,
        "speakers": {item["speaker"]: item["speaker"].upper()
                     for item in items if item.get("speaker")},
        "items": {item["id"]: tr(item["text"]) for item in items},
        "decisions": {branch["id"]: {
            "prompt": tr(branch["prompt"]),
            "routes": {route["id"]: tr(route["label"])
                       for route in branch["routes"]}}
            for branch in manifest.get("branches", [])},
    }
    for key in ("title", "version"):
        if key in manifest:
            data[key] = tr(manifest[key])
    return data


def add_languages(folder: Path, *tags: str,
                  **fields: Any) -> tuple[dict[str, Any], dict[str, dict]]:
    """List `tags` in the folder's manifest (plus top-level `fields`) and
    write a full language file for each; (manifest, tag -> file data)."""
    manifest = read_manifest(folder)
    manifest["languages"] = list(tags)
    manifest.update(fields)
    write_manifest(folder, manifest)
    files = {}
    for tag in tags:
        files[tag] = full_language(manifest, tag)
        language_file.write_language_file(folder, files[tag])
    return manifest, files


def write_language(folder: Path, data: dict[str, Any],
                   tag: str | None = None) -> None:
    """Write a language file and its script as lang/<tag>.json."""
    tag = tag or data["language"]
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    (folder / "lang").mkdir(exist_ok=True)
    (folder / "lang" / f"{tag}.json").write_text(text, encoding="utf-8")
    (folder / "lang" / f"{tag}.js").write_text(
        language_file.script_text(tag, text), encoding="utf-8")


def lang_warnings(folder: Path) -> list[str]:
    return validate_content.language_warnings(read_manifest(folder), folder)


def coverage_of(folder: Path) -> list[str]:
    """Each language's coverage as tools/translations.py prints it."""
    _unlisted, reports = validate_content.language_reports(
        read_manifest(folder), folder)
    return [report.coverage() for report in reports]


def test_schema_tag_patterns_match_the_helper() -> None:
    """The manifest schema, the language file schema, the helper and the
    player all spell the canonical tag the same way."""
    content = json.loads(SCHEMA.read_text(encoding="utf-8"))
    lang = json.loads(LANG_SCHEMA.read_text(encoding="utf-8"))
    assert content["$defs"]["languageTag"]["pattern"] == \
        language_file.TAG_PATTERN
    assert lang["$defs"]["languageTag"]["pattern"] == \
        language_file.TAG_PATTERN
    player = (REPO_ROOT / "player" / "src" / "render" / "manifest.ts"
              ).read_text(encoding="utf-8")
    assert f"/{language_file.TAG_PATTERN}/" in player


def test_a_full_translation_passes_with_full_coverage(folder: Path) -> None:
    manifest, _files = add_languages(folder, "de", "ja", version="Episode 1")
    assert problems_of(folder) == []
    assert lang_warnings(folder) == []
    # title, version, 3 speakers, 33 item texts, 2 prompts and 4 labels
    assert coverage_of(folder) == [
        "de: 44 of 44 strings (100%), 0 stale, 0 unchecked",
        "ja: 44 of 44 strings (100%), 0 stale, 0 unchecked"]
    assert validate_content.language_coverage(read_manifest(folder),
                                              folder) == {
        tag: {"strings": 44, "translated": 44, "missing": 0, "stale": 0,
              "unchecked": 0, "long": 0, "percent": 100.0}
        for tag in ("de", "ja")}


def test_language_fields_absent_print_nothing(demo: Path) -> None:
    assert validate_content.language_warnings(read_manifest(demo), demo) \
        == []
    assert validate_content.language_coverage(read_manifest(demo), demo) \
        == {}


def test_an_explicit_base_language_passes(folder: Path) -> None:
    add_languages(folder, "en", "pt-BR", language="ja")
    assert problems_of(folder) == []


def test_empty_languages_passes(folder: Path) -> None:
    manifest = read_manifest(folder)
    manifest["languages"] = []
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


def test_a_minimal_language_file_passes_with_warnings(folder: Path) -> None:
    """Only `language` is required; every string is then missing."""
    add_languages(folder, "de")
    write_language(folder, {"language": "de"})
    assert problems_of(folder) == []
    assert coverage_of(folder) == [
        "de: 0 of 43 strings (0.0%), 0 stale, 0 unchecked"]


@pytest.mark.parametrize("tag, why", [
    ("DE", "'DE' must be written 'de' (canonical casing)"),
    ("pt-br", "'pt-br' must be written 'pt-BR' (canonical casing)"),
    ("zh-hans", "'zh-hans' must be written 'zh-Hans' (canonical casing)"),
    ("pt_BR", "'pt_BR' is not a BCP 47 tag"),
    ("english", "'english' is not a BCP 47 tag"),
    ("", "'' is not a BCP 47 tag"),
])
def test_a_bad_tag_in_languages_is_reported(folder: Path, tag: str,
                                            why: str) -> None:
    manifest = read_manifest(folder)
    manifest["languages"] = [tag]
    write_manifest(folder, manifest)
    problems = problems_of(folder)
    assert len(problems) == 1, problems
    assert problems[0].startswith(f"manifest.json: languages[0]: {why}")


def test_a_bad_base_language_is_reported(folder: Path) -> None:
    manifest = read_manifest(folder)
    manifest["language"] = "EN"
    write_manifest(folder, manifest)
    assert problems_of(folder) == [
        "manifest.json: language: 'EN' must be written 'en' (canonical "
        "casing)"]


@pytest.mark.parametrize("fields, index", [
    ({}, 1),                     # the default base, en
    ({"language": "de"}, 0),
])
def test_the_base_language_in_languages_is_reported(
        folder: Path, fields: dict[str, str], index: int) -> None:
    base = fields.get("language", "en")
    add_languages(folder, "de" if base == "en" else "fr", **fields)
    manifest = read_manifest(folder)
    manifest["languages"].insert(index, base)
    write_manifest(folder, manifest)
    assert problems_of(folder) == [
        f"manifest.json: languages[{index}]: {base!r} is the manifest's own "
        "language, which has no language file"]


def test_a_repeated_tag_is_reported(folder: Path) -> None:
    add_languages(folder, "de")
    manifest = read_manifest(folder)
    manifest["languages"] = ["de", "ja", "de"]
    write_manifest(folder, manifest)
    write_language(folder, full_language(manifest, "ja"))
    assert problems_of(folder) == [
        "manifest.json: languages: must not repeat an entry (found 'de' "
        "twice)"]


def test_a_missing_language_file_is_reported(folder: Path) -> None:
    add_languages(folder, "de")
    (folder / "lang" / "de.json").unlink()
    assert problems_of(folder) == [
        "manifest.json: languages[0]: language file 'lang/de.json' does "
        "not exist in the folder"]


def test_a_missing_language_script_is_reported(folder: Path) -> None:
    add_languages(folder, "de")
    (folder / "lang" / "de.js").unlink()
    assert problems_of(folder) == [
        "manifest.json: languages[0]: language script 'lang/de.js' does "
        "not exist in the folder"]


def test_a_language_file_named_in_other_casing_is_missing(
        folder: Path) -> None:
    """The name must equal the tag exactly, even on a file system that
    ignores case."""
    _manifest, files = add_languages(folder, "de")
    shutil.rmtree(folder / "lang")
    write_language(folder, files["de"], tag="DE")
    problems = problems_of(folder)
    assert "manifest.json: languages[0]: language file 'lang/de.json' does " \
           "not exist in the folder" in problems


def test_a_script_that_differs_from_its_file_is_reported(
        folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    changed = dict(files["de"], name="Deutsch")
    (folder / "lang" / "de.js").write_text(
        language_file.script_text("de", json.dumps(changed)),
        encoding="utf-8")
    assert problems_of(folder) == [
        "lang/de.js: embedded JSON does not equal lang/de.json (first "
        "difference at name)"]


def test_a_script_must_be_equal_json_not_bytes(folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    (folder / "lang" / "de.js").write_text(
        language_file.script_text("de", json.dumps(files["de"])),
        encoding="utf-8")
    assert problems_of(folder) == []


@pytest.mark.parametrize("script, problem", [
    ('window.KINETIC_MANIFEST = {"language": "de"};\n',
     "lang/de.js: must start with 'window.KINETIC_LANGUAGES[\"de\"] = '"),
    ('window.KINETIC_LANGUAGES["fr"] = {"language": "de"};\n',
     "lang/de.js: must start with 'window.KINETIC_LANGUAGES[\"de\"] = '"),
    ('window.KINETIC_LANGUAGES["de"] = {"language": "de"}\n',
     'lang/de.js: must be window.KINETIC_LANGUAGES["de"] = <language file '
     'JSON>; with nothing after the semicolon'),
    ('window.KINETIC_LANGUAGES["de"] = {"language": };\n',
     "lang/de.js: embedded JSON is invalid at line 1 column 14: Expecting "
     "value"),
])
def test_a_malformed_script_is_reported(folder: Path, script: str,
                                        problem: str) -> None:
    add_languages(folder, "de")
    write_language(folder, {"language": "de"})
    (folder / "lang" / "de.js").write_text(script, encoding="utf-8")
    assert problems_of(folder) == [problem]


def test_language_not_its_file_name_is_reported(folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    write_language(folder, dict(files["de"], language="fr"), tag="de")
    assert problems_of(folder) == [
        "lang/de.json: language: must be 'de', the file's name (found 'fr')"]


def test_invalid_language_file_json_is_reported(folder: Path) -> None:
    add_languages(folder, "de")
    (folder / "lang" / "de.json").write_text("{", encoding="utf-8")
    problems = problems_of(folder)
    assert problems[0].startswith("lang/de.json: invalid JSON at line 1")
    assert len(problems) == 1, problems


@pytest.mark.parametrize("change, location", [
    (lambda d: d.update(font="Serif"), "<root>"),
    (lambda d: d.pop("language"), "<root>"),
    (lambda d: d.update(language="Deutsch"), "language"),
    (lambda d: d.update(name=""), "name"),
    (lambda d: d["items"]["text-thought"].update(thought=True),
     "items.text-thought"),
    (lambda d: d["items"]["text-speech"].update({"from": "ABCDEF12"}),
     "items.text-speech.from"),
    (lambda d: d["items"]["text-speech"].update({"from": "abc"}),
     "items.text-speech.from"),
    (lambda d: d["items"].update({"text-speech": "Gesprochen"}),
     "items.text-speech"),
    (lambda d: d["items"].update({"bad id!": {"text": "x"}}), "items"),
    (lambda d: d["speakers"].update(Mei=""), "speakers.Mei"),
    (lambda d: d.update(keepOriginalVoice="yes"), "keepOriginalVoice"),
    (lambda d: d.update(title={"text": "x" * 201}), "title.text"),
    (lambda d: d.update(version={"text": "x" * 41}), "version.text"),
    (lambda d: d["decisions"]["outer"].update(label={"text": "x"}),
     "decisions.outer"),
])
def test_a_language_file_breaking_its_schema_is_reported(
        folder: Path, change: Any, location: str) -> None:
    _manifest, files = add_languages(folder, "de")
    data = files["de"]
    change(data)
    write_language(folder, data, tag="de")
    problems = problems_of(folder)
    assert problems, data
    assert all(p.startswith("lang/de.json: ") for p in problems), problems
    assert problems[0].startswith(f"lang/de.json: {location}: "), problems


@pytest.mark.parametrize("text", ["", "   "])
def test_an_empty_text_is_reported(folder: Path, text: str) -> None:
    _manifest, files = add_languages(folder, "de")
    files["de"]["items"]["text-speech"]["text"] = text
    write_language(folder, files["de"])
    assert problems_of(folder) == [
        "lang/de.json: items.text-speech.text: must hold at least one "
        f"non-space character (found {text!r})"]


def test_an_unknown_item_is_reported(folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    files["de"]["items"]["no-such-item"] = {"text": "Hallo"}
    write_language(folder, files["de"])
    assert problems_of(folder) == [
        "lang/de.json: items.no-such-item: no item has id 'no-such-item'"]


def test_an_item_without_base_text_is_reported(folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    files["de"]["items"]["text-bare"] = {"text": "Ein Bild"}
    write_language(folder, files["de"])
    assert problems_of(folder) == [
        "lang/de.json: items.text-bare: item 'text-bare' has no text to "
        "translate"]


def test_an_unknown_speaker_is_reported(folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    files["de"]["speakers"]["mei"] = "Mei"  # speakers match exactly
    write_language(folder, files["de"])
    assert problems_of(folder) == [
        "lang/de.json: speakers.mei: no item with text has speaker 'mei'"]


def test_an_unknown_decision_is_reported(folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    files["de"]["decisions"]["route1"] = {"prompt": {"text": "Wohin?"}}
    write_language(folder, files["de"])
    assert problems_of(folder) == [
        "lang/de.json: decisions.route1: no decision has id 'route1'"]


def test_a_route_of_another_decision_is_reported(folder: Path) -> None:
    """Route ids are unique only within their decision."""
    _manifest, files = add_languages(folder, "de")
    files["de"]["decisions"]["nested"]["routes"]["route1"] = {"text": "x"}
    write_language(folder, files["de"])
    assert problems_of(folder) == [
        "lang/de.json: decisions.nested.routes.route1: decision 'nested' has "
        "no route 'route1'"]


@pytest.mark.parametrize("length, ok", [(199, True), (200, False)])
def test_a_translated_prompt_keeps_the_branch_limit(
        folder: Path, length: int, ok: bool) -> None:
    _manifest, files = add_languages(folder, "de")
    files["de"]["decisions"]["outer"]["prompt"] = {"text": "ü" * length}
    write_language(folder, files["de"])
    assert problems_of(folder) == ([] if ok else [
        "lang/de.json: decisions.outer.prompt.text: must be shorter than "
        "200 characters (found 200)"])


@pytest.mark.parametrize("length, ok", [(119, True), (120, False)])
def test_a_translated_label_keeps_the_branch_limit(
        folder: Path, length: int, ok: bool) -> None:
    _manifest, files = add_languages(folder, "de")
    files["de"]["decisions"]["outer"]["routes"]["route2"] = {
        "text": "語" * length}
    write_language(folder, files["de"])
    assert problems_of(folder) == ([] if ok else [
        "lang/de.json: decisions.outer.routes.route2.text: must be shorter "
        "than 120 characters (found 120)"])


def test_an_unlisted_language_file_warns(folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    write_language(folder, dict(files["de"], language="fr"), tag="fr")
    assert problems_of(folder) == []
    assert lang_warnings(folder) == [
        "warning: lang/fr.json: <root>: not listed in manifest.json "
        "languages, so the player never loads it"]


def test_an_unlisted_language_file_warns_without_languages(
        folder: Path) -> None:
    write_language(folder, {"language": "fr"})
    assert problems_of(folder) == []
    assert len(lang_warnings(folder)) == 1


def test_each_missing_string_warns(folder: Path) -> None:
    _manifest, files = add_languages(folder, "de", version="Episode 1")
    data = files["de"]
    del data["title"], data["version"]
    del data["speakers"]["Theo"]
    del data["items"]["floor-2"]
    del data["decisions"]["nested"]["prompt"]
    del data["decisions"]["outer"]["routes"]["route2"]
    write_language(folder, data)
    assert problems_of(folder) == []
    assert lang_warnings(folder) == [
        "warning: lang/de.json: title: no translation (base: 'Kinetic "
        "demo')",
        "warning: lang/de.json: version: no translation (base: 'Episode 1')",
        "warning: lang/de.json: speakers.Theo: no translation of speaker "
        "'Theo'",
        "warning: lang/de.json: items.floor-2: no translation (base: 'Short "
        "line two.')",
        "warning: lang/de.json: decisions.nested.prompt: no translation "
        "(base: 'Nested decision inside Route 1:')",
        "warning: lang/de.json: decisions.outer.routes.route2: no "
        "translation (base: 'Route 2: an ending')",
    ]
    assert coverage_of(folder) == [
        "de: 38 of 44 strings (86.3%), 0 stale, 0 unchecked"]


def test_missing_strings_are_listed_up_to_the_cap(folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    files["de"]["items"] = {}
    write_language(folder, files["de"])
    warnings = lang_warnings(folder)
    assert len(warnings) == validate_content.LIST_MAX + 1
    assert warnings[-1] == ("warning: lang/de.json: <root>: and 13 more "
                            "strings without a translation")
    assert coverage_of(folder) == [
        "de: 10 of 43 strings (23.2%), 0 stale, 0 unchecked"]


def test_a_stale_translation_warns(folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    old = language_file.base_hash("An earlier wording.")
    files["de"]["items"]["floor-3"]["from"] = old
    write_language(folder, files["de"])
    assert problems_of(folder) == []
    now = language_file.base_hash("Line three waits.")
    assert lang_warnings(folder) == [
        f"warning: lang/de.json: items.floor-3.from: stale: translated from a "
        f"text hashing to {old!r}, the base now hashes to {now!r} (base: "
        "'Line three waits.')"]
    assert coverage_of(folder) == [
        "de: 43 of 43 strings (100%), 1 stale, 0 unchecked"]


def test_a_stale_label_warns(folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    files["de"]["decisions"]["outer"]["routes"]["route1"]["from"] = "00000000"
    write_language(folder, files["de"])
    warnings = lang_warnings(folder)
    assert len(warnings) == 1
    assert warnings[0].startswith(
        "warning: lang/de.json: decisions.outer.routes.route1.from: stale: ")


def test_the_hash_is_of_the_exact_base_bytes() -> None:
    """No normalisation: a trailing space or another case is another
    base text."""
    assert language_file.base_hash("Hello") == \
        __import__("hashlib").sha256(b"Hello").hexdigest()[:8]
    assert language_file.base_hash("Hello ") != language_file.base_hash(
        "Hello")
    assert language_file.base_hash("café") == \
        __import__("hashlib").sha256("café".encode()).hexdigest()[:8]


def test_a_translation_without_from_is_unchecked_not_warned(
        folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    del files["de"]["items"]["floor-3"]["from"]
    del files["de"]["decisions"]["outer"]["prompt"]["from"]
    write_language(folder, files["de"])
    assert problems_of(folder) == []
    assert lang_warnings(folder) == []
    assert coverage_of(folder) == [
        "de: 43 of 43 strings (100%), 0 stale, 2 unchecked"]


def test_a_text_over_one_and_a_half_times_its_base_warns(
        folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    base = "Line three waits."           # 17 code points
    files["de"]["items"]["floor-3"]["text"] = "ü" * 25   # within 1.5x
    write_language(folder, files["de"])
    assert lang_warnings(folder) == []
    files["de"]["items"]["floor-3"]["text"] = "ü" * 26   # over 25.5
    write_language(folder, files["de"])
    assert len(base) == 17
    assert lang_warnings(folder) == [
        "warning: lang/de.json: items.floor-3.text: 26 characters, over 1.5 "
        "times its base text's 17"]


def test_a_text_longer_than_the_longest_base_text_warns(
        folder: Path) -> None:
    manifest, files = add_languages(folder, "de")
    longest = max(len(item.get("text") or "") for item in manifest["items"])
    assert longest == 181
    files["de"]["items"]["after-end"]["text"] = "x" * 182
    write_language(folder, files["de"])
    assert lang_warnings(folder) == [
        "warning: lang/de.json: items.after-end.text: 182 characters, longer "
        "than the game's longest base text (181)"]
    files["de"]["items"]["floor-3"]["text"] = "x" * 182
    write_language(folder, files["de"])
    assert lang_warnings(folder)[0] == (
        "warning: lang/de.json: items.floor-3.text: 182 characters, over 1.5 "
        "times its base text's 17 and longer than the game's longest base "
        "text (181)")


def test_translation_warnings_print_with_a_count(folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    del files["de"]["items"]["floor-2"]
    write_language(folder, files["de"])
    proc = run_cli(folder)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout == ""
    assert proc.stderr.splitlines() == [
        "warning: lang/de.json: items.floor-2: no translation (base: 'Short "
        "line two.')",
        f"{folder}: 1 translation warning",
    ]


# The validator as a gate (docs/plan.md Phase 57 item 11b): silent when
# clean, `--strict` fails on warnings, `--json` for a program to read.

def add_one_warning(folder: Path) -> None:
    """A full German translation but for one missing line: a
    translation warning and no problem."""
    _manifest, files = add_languages(folder, "de")
    del files["de"]["items"]["floor-2"]
    write_language(folder, files["de"])


def add_one_problem(folder: Path) -> None:
    """The one-warning folder, plus a problem: an item's fps of 0."""
    add_one_warning(folder)
    manifest = read_manifest(folder)
    animation = next(item for item in manifest["items"]
                     if item["type"] == "animation")
    animation["fps"] = 0
    write_manifest(folder, manifest)


def run_json(folder: Path, *args: str
             ) -> tuple[subprocess.CompletedProcess[str], dict[str, Any]]:
    proc = run_cli(folder, "--json", *args)
    assert proc.stderr == ""
    return proc, json.loads(proc.stdout)


def test_a_clean_language_folder_prints_nothing(folder: Path) -> None:
    """Complete coverage in two languages: no coverage line, nothing on
    either stream, plain or strict, through both entry points."""
    add_languages(folder, "de", "ja", version="Episode 1")
    for args in ((), ("--strict",)):
        proc = run_cli(folder, *args)
        assert (proc.returncode, proc.stdout, proc.stderr) == (0, "", "")
    proc = subprocess.run(
        [sys.executable, "-m", "kinetic_extract.kinetic_cli", "validate",
         str(folder), "--strict"], capture_output=True, text=True)
    assert (proc.returncode, proc.stdout, proc.stderr) == (0, "", "")


def test_a_matching_ledger_prints_nothing(folder: Path) -> None:
    proc = run_with_ledger(folder, matching_ledger(read_manifest(folder)))
    assert (proc.returncode, proc.stdout, proc.stderr) == (0, "", "")


def test_warnings_alone_exit_0_plain_and_3_strict(folder: Path) -> None:
    add_one_warning(folder)
    plain = run_cli(folder)
    assert (plain.returncode, plain.stdout) == (0, "")
    assert plain.stderr.splitlines()[-1] == f"{folder}: 1 translation warning"
    strict = run_cli(folder, "--strict")
    assert (strict.returncode, strict.stdout, strict.stderr) == (
        3, "", plain.stderr)


def strict_codes(folder: Path, *args: str) -> tuple[int, int]:
    """(plain, --strict) exit status; asserts no problem."""
    _proc, report = run_json(folder, *args)
    assert report["problems"] == [], report["problems"]
    return (run_cli(folder, *args).returncode,
            run_cli(folder, "--strict", *args).returncode)


def test_strict_fails_on_an_unreachable_item(branch_folder: Path) -> None:
    insert_gap(branch_folder, "home-009")
    assert strict_codes(branch_folder) == (0, 3)


def test_strict_fails_on_an_audio_warning(folder: Path) -> None:
    manifest = with_audio(folder)
    manifest["audio"]["tracks"]["spare"] = {"file": AUDIO_FILES["door"],
                                            "durationSeconds": 1.5}
    write_manifest(folder, manifest)
    assert strict_codes(folder) == (0, 3)


def test_strict_fails_on_a_poster_warning(folder: Path) -> None:
    manifest = read_manifest(folder)
    ledger = matching_ledger(manifest)
    poster_entry(ledger, manifest, RANGE_B)["steps"][0]["startSeconds"] = 0.0
    assert strict_codes(folder, "--ledger",
                        str(write_ledger(folder, ledger))) == (0, 3)


def test_problems_exit_1_with_or_without_strict(folder: Path) -> None:
    add_one_problem(folder)
    for args in ((), ("--strict",)):
        proc = run_cli(folder, *args)
        assert proc.returncode == 1
        assert "items[" in proc.stdout and ".fps" in proc.stdout
        assert "1 translation warning" in proc.stderr


def test_json_shape(folder: Path) -> None:
    add_one_warning(folder)
    proc, report = run_json(folder)
    assert proc.returncode == 0
    assert list(report) == ["problems", "warnings", "coverage", "exitStatus"]
    assert list(report["warnings"]) == list(validate_content.WARNING_KINDS)
    assert list(report["warnings"]) == [
        "unreachable", "audio", "voice", "character", "textTag",
        "translation", "poster"]
    assert report["problems"] == []
    assert report["warnings"]["translation"] == [
        "warning: lang/de.json: items.floor-2: no translation (base: 'Short "
        "line two.')"]
    assert all(lines == [] for kind, lines in report["warnings"].items()
               if kind != "translation")
    assert report["coverage"] == {"de": {
        "strings": 43, "translated": 42, "missing": 1, "stale": 0,
        "unchecked": 0, "long": 0, "percent": 97.6}}
    assert report["exitStatus"] == 0


def test_json_exit_status_follows_strict_and_problems(folder: Path) -> None:
    add_one_warning(folder)
    proc, report = run_json(folder, "--strict")
    assert proc.returncode == report["exitStatus"] == 3
    add_one_problem(folder)
    for args in ((), ("--strict",)):
        proc, report = run_json(folder, *args)
        assert proc.returncode == report["exitStatus"] == 1
        assert len(report["problems"]) == 1
        assert ".fps" in report["problems"][0]
        assert len(report["warnings"]["translation"]) == 1


def test_json_on_a_clean_folder(demo: Path) -> None:
    proc, report = run_json(demo, "--strict")
    assert proc.returncode == 0
    assert report == {"problems": [],
                      "warnings": {kind: [] for kind
                                   in validate_content.WARNING_KINDS},
                      "coverage": {}, "exitStatus": 0}


def test_json_carries_poster_warnings(folder: Path) -> None:
    manifest = read_manifest(folder)
    ledger = matching_ledger(manifest)
    poster_entry(ledger, manifest, RANGE_B)["steps"][0]["startSeconds"] = 0.0
    proc, report = run_json(folder, "--ledger",
                            str(write_ledger(folder, ledger)))
    assert proc.returncode == 0
    assert report["warnings"]["poster"] == [
        "warning: manifest.json: items[15].poster: startSeconds 1.0, "
        "poster startSeconds 0.0 (poster made at another start)"]


def test_json_counts_long_translations(folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    files["de"]["items"]["floor-3"]["text"] = "x" * 200
    write_language(folder, files["de"])
    _proc, report = run_json(folder)
    assert report["coverage"]["de"]["long"] == 1
    assert len(report["warnings"]["translation"]) == 1


def test_json_bad_arguments_exit_2_with_nothing_on_stdout(
        tmp_path: Path) -> None:
    proc = run_cli(tmp_path / "missing", "--json")
    assert (proc.returncode, proc.stdout) == (2, "")
    assert "not a directory" in proc.stderr


def test_coverage_rounds_down_so_only_complete_reads_100() -> None:
    assert validate_content.percent_text(999, 1000) == "99.9%"
    assert validate_content.percent_text(9999, 10000) == "99.9%"
    assert validate_content.percent_text(1000, 1000) == "100%"
    assert validate_content.percent_text(0, 0) == "100%"


def test_language_checks_survive_malformed_manifests(tmp_path: Path) -> None:
    for manifest in (None, [], {"languages": "de"}, {"languages": [3, None]},
                     {"language": 7, "languages": ["de"]},
                     {"languages": ["de"], "items": "x", "branches": 3}):
        assert isinstance(validate_content.language_problems(
            tmp_path, manifest), list)
        assert isinstance(validate_content.language_warnings(
            manifest, tmp_path), list)
        assert isinstance(validate_content.language_coverage(
            manifest, tmp_path), dict)


# A language file's own recorded lines, `voice` (docs/plan.md Phase 56
# item 6): tracks under a manifest track's rules, and items naming them.

def add_voice(folder: Path, data: dict[str, Any], lines: dict[str, str],
              tag: str = "de", ext: str = "webm") -> dict[str, Any]:
    """Give the language file `data` a recorded line per item id of
    `lines` (item id -> track id), each file under lang/<tag>/lines/ with
    its script; write it and return it."""
    tracks = {}
    for item_id, track_id in lines.items():
        file = f"lang/{tag}/lines/{track_id}.{ext}"
        (folder / file).parent.mkdir(parents=True, exist_ok=True)
        (folder / file).write_bytes(DUMMY)
        audio_format.write_script(folder, file)
        tracks[track_id] = {"file": file, "durationSeconds": 1.5}
    data["voice"] = {"tracks": tracks, "items": dict(lines)}
    write_language(folder, data)
    return data


def test_lang_voice_lines_pass(folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    add_voice(folder, files["de"], {"text-speech": "de-1",
                                    "text-narration": "de-2"})
    assert problems_of(folder) == []
    assert lang_warnings(folder) == []


def test_lang_voice_track_ids_are_their_own(folder: Path) -> None:
    """A language file's track id may equal a manifest track's."""
    manifest = read_manifest(folder)
    manifest["audio"] = {"tracks": {"de-1": {"file": "theo.wav",
                                             "durationSeconds": 1}}}
    (folder / "theo.wav").write_bytes(DUMMY)
    audio_format.write_script(folder, "theo.wav")
    manifest["items"][1]["audio"] = {"voice": "de-1"}
    write_manifest(folder, manifest)
    _manifest, files = add_languages(folder, "de")
    add_voice(folder, files["de"], {"text-speech": "de-1"})
    assert problems_of(folder) == []


def test_lang_voice_track_file_and_script_problems(folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    data = add_voice(folder, files["de"], {"text-speech": "de-1",
                                           "text-narration": "de-2",
                                           "text-thought": "de-3"})
    (folder / "lang/de/lines/de-1.webm").unlink()
    (folder / "lang/de/lines/de-1.webm.js").unlink()
    (folder / "lang/de/lines/de-2.webm.js").unlink()
    (folder / "lang/de/lines/de-3.webm.js").write_bytes(
        audio_format.script_bytes("lang/de/lines/de-3.webm", b"other"))
    data["voice"]["tracks"]["de-2"]["startSeconds"] = 2
    write_language(folder, data)
    problems = problems_of(folder)
    assert "lang/de.json: voice.tracks.de-1.file: media file " \
        "'lang/de/lines/de-1.webm' does not exist in the folder, nor its " \
        "script 'lang/de/lines/de-1.webm.js'" in problems
    assert any(p.startswith("lang/de.json: voice.tracks.de-2.file: no script "
                            "'lang/de/lines/de-2.webm.js' beside it")
               for p in problems), problems
    assert any(p.startswith("lang/de.json: voice.tracks.de-3.file: script "
                            "'lang/de/lines/de-3.webm.js' does not match it")
               for p in problems), problems
    assert "lang/de.json: voice.tracks.de-2.startSeconds: must be less than " \
        "durationSeconds 1.5 (found 2)" in problems
    assert len(problems) == 4, problems


@pytest.mark.parametrize(("change", "where"), [
    (lambda v: v["tracks"]["de-1"].update(file="../outside.webm"),
     "voice.tracks.de-1.file"),
    (lambda v: v["tracks"]["de-1"].update(file="lang/de/lines/x.aiff"),
     "voice.tracks.de-1.file"),
    (lambda v: v["tracks"]["de-1"].pop("durationSeconds"),
     "voice.tracks.de-1"),
    (lambda v: v["tracks"]["de-1"].update(durationSeconds=0),
     "voice.tracks.de-1.durationSeconds"),
    (lambda v: v["tracks"]["de-1"].update(gain=2), "voice.tracks.de-1"),
    (lambda v: v.update(extra=1), "voice"),
    (lambda v: v["items"].update({"text-speech": 3}),
     "voice.items.text-speech"),
    (lambda v: v.update(tracks=[]), "voice.tracks"),
])
def test_lang_voice_schema_problems(folder: Path, change: Any,
                                    where: str) -> None:
    _manifest, files = add_languages(folder, "de")
    data = add_voice(folder, files["de"], {"text-speech": "de-1"})
    change(data["voice"])
    write_language(folder, data)
    problems = problems_of(folder)
    assert problems, "expected a problem"
    assert all(p.startswith(f"lang/de.json: {where}") for p in problems), \
        problems


def test_lang_voice_items_name_an_item_with_text_and_a_track(
        folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    data = add_voice(folder, files["de"], {"text-speech": "de-1"})
    data["voice"]["items"].update({"nowhere": "de-1", "text-bare": "de-1",
                                   "text-thought": "missing"})
    write_language(folder, data)
    assert problems_of(folder) == [
        "lang/de.json: voice.items.nowhere: no item has id 'nowhere'",
        "lang/de.json: voice.items.text-bare: item 'text-bare' has no text "
        "to speak",
        "lang/de.json: voice.items.text-thought: no track in voice.tracks "
        "has id 'missing'",
    ]


def test_lang_voice_for_an_untranslated_item_is_a_warning(
        folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    data = add_voice(folder, files["de"], {"text-speech": "de-1"})
    del data["items"]["text-speech"]
    write_language(folder, data)
    assert problems_of(folder) == []
    warnings = lang_warnings(folder)
    assert "warning: lang/de.json: voice.items.text-speech: this file has no " \
        "text for the item, so its voice line never plays (the item shows " \
        "the base text)" in warnings
    assert "warning: lang/de.json: items.text-speech: no translation " \
        "(base: \"Spoken dialogue: the speaker's name sits above the line.\")" \
        in warnings or any("items.text-speech: no translation" in w
                           for w in warnings)


def test_lang_voice_track_warnings(folder: Path) -> None:
    """An Ogg file and a track no item names warn, as in a manifest."""
    _manifest, files = add_languages(folder, "de")
    data = add_voice(folder, files["de"], {"text-speech": "de-1"},
                     ext="ogg")
    file = "lang/de/lines/spare.webm"
    (folder / file).write_bytes(DUMMY)
    audio_format.write_script(folder, file)
    data["voice"]["tracks"]["spare"] = {"file": file, "durationSeconds": 1}
    write_language(folder, data)
    assert problems_of(folder) == []
    warnings = lang_warnings(folder)
    assert any(w.startswith("warning: lang/de.json: voice.tracks.de-1.file: "
                            "Ogg audio 'lang/de/lines/de-1.ogg'")
               for w in warnings), warnings
    assert "warning: lang/de.json: voice.tracks.spare: no item uses this " \
        "track" in warnings


def test_lang_schema_track_matches_the_manifest_s() -> None:
    """lang.schema.json copies the manifest schema's track and path
    rules; they must stay the same."""
    content = json.loads(SCHEMA.read_text(encoding="utf-8"))["$defs"]
    lang = json.loads(LANG_SCHEMA.read_text(encoding="utf-8"))["$defs"]
    for name in ("track", "path", "audioPath"):
        assert lang[name] == content[name], name


# ---------------------------------------------------------------------------
# Presentation (docs/content-format.md, Characters, Transitions and Text
# tags; docs/plan.md Phase 57 item 1)
# ---------------------------------------------------------------------------

def test_demo_has_characters_transitions_and_tags_and_warns_nothing(
        demo: Path) -> None:
    manifest = read_manifest(demo)
    assert manifest["characters"]
    assert any("transition" in item for item in manifest["items"])
    assert validate_content.character_warnings(manifest) == []
    assert validate_content.text_tag_warnings(manifest, demo) == []


def test_contrast_ratio_is_wcag_s() -> None:
    assert validate_content.contrast_ratio("#000000", "#FFFFFF") == 21
    assert validate_content.contrast_ratio("#777777", "#777777") == 1
    # WCAG's own example pair: #777 on white is just under 4.5:1.
    assert round(validate_content.contrast_ratio("#777777", "#ffffff"),
                 2) == 4.48


def test_band_background_is_the_players_band_over_white() -> None:
    """The reference colour is the band's black at its opacity over a
    white picture; the opacity is the one player/index.html draws."""
    html = (REPO_ROOT / "player" / "index.html").read_text(encoding="utf-8")
    band = re.search(r"\.overlay \{.*?rgba\(0, 0, 0, ([0-9.]+)\) 35%", html,
                     re.S)
    assert band is not None
    level = round(255 * (1 - float(band.group(1))))
    assert validate_content.BAND_BACKGROUND == "#" + f"{level:02x}" * 3


def test_characters_in_either_case_pass(folder: Path) -> None:
    manifest = read_manifest(folder)
    manifest["characters"] = {"Mei": {"nameColor": "#E6B566",
                                      "textColor": "#f4efe6"},
                              "Theo": {}}
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    assert validate_content.character_warnings(manifest) == []


@pytest.mark.parametrize(("change", "loc", "reason"), [
    ({"Mei": {"nameColor": "red"}}, "characters.Mei.nameColor",
     "must be a colour written #rrggbb (found 'red')"),
    ({"Mei": {"textColor": "#fff"}}, "characters.Mei.textColor",
     "must be a colour written #rrggbb (found '#fff')"),
    ({"Mei": {"textColor": "#ffffffaa"}}, "characters.Mei.textColor",
     "must be a colour written #rrggbb (found '#ffffffaa')"),
    ({"Mei": {"color": "#ffffff"}}, "characters.Mei",
     "Additional properties are not allowed ('color' was unexpected)"),
    ({"Mei": "#ffffff"}, "characters.Mei", "must be of type object"),
    ({"": {}}, "characters", "'' should be non-empty"),
])
def test_a_badly_shaped_character_is_a_problem(folder: Path, change: Any,
                                               loc: str, reason: str) -> None:
    manifest = read_manifest(folder)
    manifest["characters"] = change
    assert only_problem(folder, manifest) == f"manifest.json: {loc}: {reason}"


def test_an_unused_character_and_a_dim_colour_warn_only(folder: Path
                                                        ) -> None:
    manifest = read_manifest(folder)
    manifest["characters"] = {"Mei": {"nameColor": "#000080",
                                      "textColor": "#f4efe6"},
                              "Ines": {"nameColor": "#7fd6c2"},
                              "Nobody": {"textColor": "#3a3a3a"}}
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert (proc.returncode, proc.stdout) == (0, ""), proc.stderr
    assert warning_lines(proc) == [
        "warning: manifest.json: characters.Mei.nameColor: '#000080' has a "
        "contrast ratio of 1.10:1 with the text band (#292929), below 4.5:1, "
        "so it may be hard to read",
        "warning: manifest.json: characters.Nobody: no item's speaker is "
        "'Nobody'",
        "warning: manifest.json: characters.Nobody.textColor: '#3a3a3a' has "
        "a contrast ratio of 1.27:1 with the text band (#292929), below "
        "4.5:1, so it may be hard to read",
    ]
    assert proc.stderr.endswith(f"{folder}: 3 character warnings\n")


def test_character_warnings_survive_malformed_manifests() -> None:
    assert validate_content.character_warnings(None) == []
    assert validate_content.character_warnings({"characters": "x"}) == []
    assert validate_content.character_warnings({
        "characters": {"A": "x", "B": {"nameColor": 7}},
        "items": "x"}) == [
        "warning: manifest.json: characters.A: no item's speaker is 'A'",
        "warning: manifest.json: characters.B: no item's speaker is 'B'"]


def test_a_contrast_just_at_the_line_does_not_warn() -> None:
    """The limit is 4.5:1 itself: the palest grey at or above it passes
    and the next darker one warns."""
    def warns(color: str) -> bool:
        return bool(validate_content.character_warnings({
            "characters": {"A": {"textColor": color}},
            "items": [{"speaker": "A"}]}))
    greys = [f"#{v:02x}{v:02x}{v:02x}" for v in range(256)]
    first = next(g for g in greys
                 if validate_content.contrast_ratio(
                     g, validate_content.BAND_BACKGROUND) >= 4.5
                 and int(g[1:3], 16) > 0x29)
    previous = greys[greys.index(first) - 1]
    assert not warns(first) and warns(previous)


TRANSITIONS = {
    "dissolve": {"kind": "dissolve", "seconds": 1},
    "longest dissolve": {"kind": "dissolve", "seconds": 5},
    "fade": {"kind": "fade", "out": 0.5, "hold": 0.25, "in": 0.5},
    "fade in only": {"kind": "fade", "out": 0, "hold": 0, "in": 5},
    "fade out only": {"kind": "fade", "out": 0.1, "hold": 5, "in": 0},
}


@pytest.mark.parametrize("index", [IMAGE, ANIM, VIDEO])
@pytest.mark.parametrize("name", list(TRANSITIONS))
def test_a_transition_on_a_visual_item_passes(folder: Path, index: int,
                                              name: str) -> None:
    manifest = read_manifest(folder)
    manifest["items"][index]["transition"] = TRANSITIONS[name]
    write_manifest(folder, manifest)
    assert problems_of(folder) == []


@pytest.mark.parametrize(("transition", "loc", "reason"), [
    ({"kind": "dissolve", "seconds": 0}, "transition.seconds",
     "must be greater than 0 (found 0)"),
    ({"kind": "dissolve", "seconds": 5.5}, "transition.seconds",
     "must be at most 5 (found 5.5)"),
    ({"kind": "dissolve"}, "transition", "'seconds' is a required property"),
    ({"kind": "dissolve", "seconds": 1, "in": 1}, "transition",
     "Additional properties are not allowed ('in' was unexpected)"),
    ({"kind": "fade", "out": -1, "hold": 0, "in": 1}, "transition.out",
     "must be at least 0 (found -1)"),
    ({"kind": "fade", "out": 1, "hold": 6, "in": 1}, "transition.hold",
     "must be at most 5 (found 6)"),
    ({"kind": "fade", "out": 1, "hold": 0}, "transition",
     "'in' is a required property"),
    ({"kind": "fade", "out": 0, "hold": 2, "in": 0}, "transition",
     'a fade needs "out" or "in" above 0'),
    ({"kind": "wipe", "seconds": 1}, "transition.kind",
     "must be one of ['dissolve', 'fade'] (found 'wipe')"),
    ({"seconds": 1}, "transition", "'kind' is a required property"),
    ("dissolve", "transition", "must be of type object"),
])
def test_a_bad_transition_is_a_problem(folder: Path, transition: Any,
                                       loc: str, reason: str) -> None:
    manifest = read_manifest(folder)
    manifest["items"][IMAGE]["transition"] = transition
    assert only_problem(folder, manifest) == \
        f"manifest.json: items[{IMAGE}].{loc}: {reason}"


def test_a_transition_on_a_text_item_is_a_problem(folder: Path) -> None:
    manifest = read_manifest(folder)
    manifest["items"][TEXT]["transition"] = TRANSITIONS["dissolve"]
    assert only_problem(folder, manifest) == (
        f"manifest.json: items[{TEXT}]: Additional properties are not "
        "allowed ('transition' was unexpected)")


def test_transition_problems_survive_malformed_manifests() -> None:
    assert validate_content.transition_problems(None) == []
    assert validate_content.transition_problems({"items": [
        "x", {"transition": "x"}, {"transition": {"kind": "fade"}},
        {"transition": {"kind": "fade", "out": "0", "in": 0}}]}) == []


def tag_warnings(folder: Path) -> list[str]:
    return validate_content.text_tag_warnings(read_manifest(folder), folder)


def test_tags_in_texts_prompts_and_labels_warn_only(folder: Path) -> None:
    manifest = read_manifest(folder)
    manifest["items"][IMAGE]["text"] = "A {shake}word{/shake}."
    manifest["items"][TEXT]["text"] = "{i}Leaning {b}and bold{/i}{/b}"
    branch = manifest["branches"][1]
    branch["prompt"] = "Which {u}route?"
    branch["routes"][0]["label"] = "Route 1{/s} {oops"
    write_manifest(folder, manifest)
    assert problems_of(folder) == []
    proc = run_cli(folder)
    assert (proc.returncode, proc.stdout) == (0, ""), proc.stderr
    assert warning_lines(proc) == [
        f"warning: manifest.json: items[{IMAGE}].text: unknown text tag "
        "'{shake}': the player leaves out the tag and shows its text",
        f"warning: manifest.json: items[{IMAGE}].text: unknown text tag "
        "'{/shake}': the player leaves out the tag and shows its text",
        f"warning: manifest.json: items[{TEXT}].text: '{{/i}}' closes "
        "'{i}' while '{b}', opened after it, is still open",
        "warning: manifest.json: branches[1].prompt: '{u}' is never closed",
        "warning: manifest.json: branches[1].routes[0].label: '{/s}' closes "
        "a tag that is not open: the player leaves it out",
        "warning: manifest.json: branches[1].routes[0].label: '{oops' "
        "starts a text tag that never ends: the player shows it as text",
    ]
    assert proc.stderr.endswith(f"{folder}: 6 text tag warnings\n")


def test_well_formed_tags_do_not_warn(folder: Path) -> None:
    manifest = read_manifest(folder)
    manifest["items"][IMAGE]["text"] = (
        "{i}a{/i} {b}b{/b} {u}u{/u} {s}s{/s}{w} {w=1}{nw}{fast}{p}"
        "{cps=10}c{/cps} {size=+2}big{/size} {{literal} }} {#note}")
    write_manifest(folder, manifest)
    assert tag_warnings(folder) == []


def test_tags_in_language_files_warn_only(folder: Path) -> None:
    _manifest, files = add_languages(folder, "de")
    data = files["de"]
    data["items"]["text-speech"]["text"] = "Gesprochen, {i}kursiv."
    data["decisions"]["outer"]["prompt"]["text"] = "Welche {foo}Route?"
    data["decisions"]["outer"]["routes"]["route2"]["text"] = "Ende{/b}"
    write_language(folder, data)
    assert problems_of(folder) == []
    assert tag_warnings(folder) == [
        "warning: lang/de.json: items.text-speech.text: '{i}' is never "
        "closed",
        "warning: lang/de.json: decisions.outer.prompt.text: unknown text "
        "tag '{foo}': the player leaves out the tag and shows its text",
        "warning: lang/de.json: decisions.outer.routes.route2.text: '{/b}' "
        "closes a tag that is not open: the player leaves it out",
    ]


def test_tag_warnings_are_listed_up_to_the_cap(folder: Path) -> None:
    manifest = read_manifest(folder)
    texts = [item for item in manifest["items"] if item.get("text")]
    for item in texts:
        item["text"] += " {glow}"
    write_manifest(folder, manifest)
    warnings = tag_warnings(folder)
    assert len(warnings) == validate_content.LIST_MAX + 1
    assert warnings[-1] == (
        f"warning: manifest.json: <root>: and "
        f"{len(texts) - validate_content.LIST_MAX} more text tag warnings")


def test_tag_warnings_survive_malformed_input(tmp_path: Path) -> None:
    assert validate_content.text_tag_warnings(None, tmp_path) == []
    assert validate_content.text_tag_warnings({
        "items": [None, {"text": 7}], "branches": [
            None, {"prompt": 3, "routes": [None, {"label": None}]}]},
        tmp_path) == []
