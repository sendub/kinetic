"""Implicit image registration, definition keys, dropping unresolved
visuals, and the symlinked game dir (docs/extracting.md BUGs 1-5,
docs/plan.md Phase 11 item 4).

Covers the branches added when the five recorded slice bugs were fixed:

- BUG 5: scene/show names resolve against loose files under game/
  (recursively, spaces included) and `.rpa` members — exact key,
  path-with-directory key, basename key — with explicit `image` defs
  winning, and an ambiguous basename taking the first candidate in
  sorted order plus a ledger note;
- BUG 2: `image X = Movie(play="f.webm")` registers under the clean key
  `X` and a scene over it yields a VIDEO item (real duration via
  ffprobe on a synthetic webm);
- BUG 3: `em"..."` (no space) parses as speaker dialogue;
- BUG 4: a game dir reached through a symlink parses (the stale-twin
  ledger path that used to crash);
- BUG 1: an item whose visual resolves nowhere is dropped — with the
  lines under it — never shipped as a placeholder, and the empty folder
  that can leave behind validates.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

from helpers import is_content_addressed
from kinetic_extract.cli import main as cli_main
from kinetic_extract.parser import _split_image_def, parse_file
from kinetic_extract.timeline import def_value_target

REPO_ROOT = Path(__file__).resolve().parents[2]
TOOLS_DIR = REPO_ROOT / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))
import validate_content  # noqa: E402

FIXTURE_RPYC = Path(__file__).parent / "data" / "credits.rpyc"


def png(color: str, size: tuple[int, int] = (32, 18)) -> bytes:
    from io import BytesIO

    buf = BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def make_project(tmp: Path, script: str) -> Path:
    game = tmp / "proj" / "game"
    game.mkdir(parents=True)
    (game / "script.rpy").write_text(script, encoding="utf-8")
    return tmp / "proj"


def ledger_of(out: Path) -> dict:
    return json.loads((out / "build-ledger.json").read_text("utf-8"))


def manifest_of(out: Path) -> dict:
    return json.loads((out / "manifest.json").read_text("utf-8"))


# --- BUG 2: definition key/value splitting ---------------------------------

def test_split_image_def_key_stops_at_the_equals() -> None:
    # The old code cut the name at the first quote, registering the
    # Movie line under "clip 00686 = Movie(play" (extracting.md probe).
    assert _split_image_def('clip 00686 = Movie(play="clip 00686.webm")') \
        == ("clip 00686", ("expr", 'Movie(play="clip 00686.webm")'))
    assert _split_image_def('pose07 ="pose07.webp"') \
        == ("pose07", ("file", "pose07.webp"))
    assert _split_image_def('bg-room "data/bg.png"') \
        == ("bg-room", ("file", "data/bg.png"))
    assert _split_image_def("bg black") == ("bg black", None)


def test_def_value_target_classifies_values() -> None:
    assert def_value_target(("file", "a.png")) == ("image", "a.png")
    # The play file wins even when the Movie line carries a mask.
    assert def_value_target(
        ("expr", 'Movie(play="v.webm", mask=AlphaMask("v.png"))')) \
        == ("video", "v.webm")
    # Other expressions keep the old first-quoted-file behaviour.
    assert def_value_target(
        ("expr", 'LiveComposite((1, 1), (0, 0), "bg.png")')) \
        == ("image", "bg.png")
    assert def_value_target(("expr", "Transform(xalign=0.5)")) \
        == ("image", None)


@pytest.fixture(scope="module")
def sample_webm(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A 1 s synthetic VP8 webm, built once for the video-def tests."""
    out = tmp_path_factory.mktemp("webm") / "m.webm"
    proc = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
         "-i", "testsrc=size=64x36:rate=10:duration=1",
         "-c:v", "libvpx", "-b:v", "80k", str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0 and out.is_file(), proc.stderr
    return out


def test_movie_def_scene_ships_a_video_item(
        tmp_path: Path, sample_webm: Path) -> None:
    proj = make_project(
        tmp_path,
        'image mv = Movie(play="m.webm", pos=(0, 0), anchor=(0.5, 0.5))\n'
        "label start:\n"
        "    scene mv\n"
        '    "Playing."\n')
    shutil.copyfile(sample_webm, proj / "game" / "m.webm")
    out = tmp_path / "out"
    assert cli_main([str(proj), str(out)]) == 0
    manifest = manifest_of(out)
    (item,) = manifest["items"]
    assert item["type"] == "video"
    assert item["id"] == "mv-001"
    assert item["file"].endswith(".webm")
    assert is_content_addressed(out, item["file"])
    assert item["text"] == "Playing."
    # Real duration from ffprobe on the source; no placeholder note.
    assert item["durationSeconds"] > 0.5
    assert item["poster"].rsplit(".", 1)[1] in ("png", "jxl")
    assert is_content_addressed(out, item["poster"])
    entry = ledger_of(out)["items"]["mv-001"]
    assert entry["asset"] == "game/m.webm"
    assert not any("placeholder" in n for n in entry["notes"])


# --- BUG 3: speaker with no space -------------------------------------------

def test_no_space_speaker_parses_as_dialogue() -> None:
    parsed = parse_file('label start:\n    em"Hey, there!"\n'
                        '    bram "spaced still works"\n', "game/s.rpy")
    lines = [(e.kind, e.speaker, e.text) for e in parsed.events]
    assert lines == [("label", None, ""), ("dialogue", "em", "Hey, there!"),
                     ("dialogue", "bram", "spaced still works")]
    assert parsed.reports == []


# --- BUG 5: implicit registration -------------------------------------------

def test_implicit_name_resolves_in_images_dir_with_spaces(
        tmp_path: Path) -> None:
    # The game-a shape: no `image` def, names with spaces,
    # files under game/images/.
    proj = make_project(tmp_path,
                        "label start:\n    scene clip 00001\n"
                        '    "Evening."\n')
    (proj / "game" / "images").mkdir()
    (proj / "game" / "images" / "clip 00001.jpg").write_bytes(
        png("sandybrown"))
    out = tmp_path / "out"
    assert cli_main([str(proj), str(out)]) == 0
    (item,) = manifest_of(out)["items"]
    assert item["type"] == "image" and item["text"] == "Evening."
    entry = ledger_of(out)["items"][item["id"]]
    assert entry["asset"] == "game/images/clip 00001.jpg"
    assert (out / item["file"]).is_file()
    # An unambiguous name carries no ambiguity note.
    assert not any("ambiguous" in n for n in entry["notes"])


def test_ambiguous_basename_uses_first_sorted_and_notes(
        tmp_path: Path) -> None:
    proj = make_project(tmp_path, "label start:\n    scene x\n")
    for d, color in (("b", "red"), ("a", "navy")):
        (proj / "game" / "images" / d).mkdir(parents=True)
        (proj / "game" / "images" / d / "x.png").write_bytes(png(color))
    out = tmp_path / "out"
    assert cli_main([str(proj), str(out)]) == 0
    (item,) = manifest_of(out)["items"]
    entry = ledger_of(out)["items"][item["id"]]
    assert entry["asset"] == "game/images/a/x.png"  # first in sorted order
    assert any("ambiguous" in n for n in entry["notes"])
    assert any("images/a/x.png" in n for n in entry["notes"])


def test_explicit_def_wins_over_implicit_file(tmp_path: Path) -> None:
    proj = make_project(tmp_path,
                        'image x = "data/y.png"\n'
                        "label start:\n    scene x\n")
    (proj / "game" / "data").mkdir()
    (proj / "game" / "data" / "y.png").write_bytes(png("navy"))
    (proj / "game" / "images").mkdir()
    (proj / "game" / "images" / "x.png").write_bytes(png("red"))
    out = tmp_path / "out"
    assert cli_main([str(proj), str(out)]) == 0
    entry = ledger_of(out)["items"]["x-001"]
    assert entry["asset"] == "game/data/y.png"


def test_missing_def_file_falls_back_to_implicit(tmp_path: Path) -> None:
    # The game-f shape: the def names a bare file,
    # the asset actually sits in a subdirectory.
    proj = make_project(tmp_path,
                        'image pose07 = "pose07.webp"\n'
                        "label start:\n    scene pose07\n")
    (proj / "game" / "images").mkdir()
    (proj / "game" / "images" / "pose07.webp").write_bytes(png("teal"))
    out = tmp_path / "out"
    assert cli_main([str(proj), str(out)]) == 0
    entry = ledger_of(out)["items"]["pose07-001"]
    assert entry["asset"] == "game/images/pose07.webp"


def test_implicit_resolves_ambiguous_basename_in_archives(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # The game-e shape: no def at all, the file is an archive
    # member two directories down; multiple copies make the name
    # ambiguous.
    from test_rpa import write_rpa

    monkeypatch.setenv("KINETIC_EXTRACT_CACHE", str(tmp_path / "cache"))
    proj = make_project(tmp_path, "label start:\n    scene streets owen 1\n")
    write_rpa(proj / "game" / "images.rpa", {
        "images/EP2/streets owen 1.jpg": png("gray"),
        "tl/ru/images/EP2/streets owen 1.jpg": png("dimgray"),
    })
    out = tmp_path / "out"
    assert cli_main([str(proj), str(out)]) == 0
    (item,) = manifest_of(out)["items"]
    entry = ledger_of(out)["items"][item["id"]]
    # First in sorted order (shortest key first), provenance recorded.
    assert entry["asset"] == "game/images.rpa!images/EP2/streets owen 1.jpg"
    assert any("ambiguous" in n for n in entry["notes"])
    assert any(".rpa archive" in n for n in entry["notes"])
    assert (out / item["file"]).is_file()


# --- BUG 4: game dir reached through a symlink --------------------------------

def test_symlinked_game_dir_extracts(tmp_path: Path) -> None:
    # The game-c crash (parser.py twin.resolve().relative_to
    # on a game dir that is a symlink): the stale-twin ledger path must
    # not escape the project root.
    real = tmp_path / "real" / "game"
    real.mkdir(parents=True)
    (real / "script.rpy").write_text(
        "label start:\n    scene a\n    \"hi\"\n", encoding="utf-8")
    shutil.copyfile(FIXTURE_RPYC, real / "script.rpyc")  # stale twin
    (real / "images").mkdir()
    (real / "images" / "a.png").write_bytes(png("navy"))
    proj = tmp_path / "proj"
    proj.mkdir()
    os.symlink(real, proj / "game")
    out = tmp_path / "out"
    assert cli_main([str(proj), str(out)]) == 0
    ledger = ledger_of(out)
    assert ledger["inputs"] == ["game/script.rpy"]
    assert ledger["rpycIgnoredTwins"] == [
        {"rpyc": "game/script.rpyc", "kept": "game/script.rpy"}]
    assert manifest_of(out)["items"]  # the implicit asset resolved


# --- BUG 1: unresolved visuals drop ------------------------------------------

def test_unresolved_visual_drops_item_and_its_lines(tmp_path: Path) -> None:
    proj = make_project(tmp_path,
                        "label start:\n"
                        "    scene nowhere\n"
                        '    em"one"\n'
                        '    "two"\n')
    out = tmp_path / "out"
    # A slice run ends cleanly with an empty manifest.
    assert cli_main([str(proj), str(out), "--label", "start"]) == 0
    assert manifest_of(out)["items"] == []
    reasons = [r["reason"] for r in ledger_of(out)["report"]]
    assert sum("droppedUnresolved" in r for r in reasons) == 3  # + 2 lines
    # The empty folder is a VALID content folder, exit 0.
    assert validate_content.validate_folder(out) == []
    proc = subprocess.run(
        [sys.executable, str(TOOLS_DIR / "validate_content.py"), str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stdout


def test_whole_project_with_no_items_is_fatal(tmp_path: Path) -> None:
    # The long-standing guard stays: a full run with nothing to ship is
    # an error, only slice runs may be empty.
    proj = make_project(tmp_path, "label start:\n    scene nowhere\n")
    with pytest.raises(SystemExit):
        cli_main([str(proj), str(tmp_path / "out")])


def test_dropped_visual_does_not_steal_later_items(tmp_path: Path) -> None:
    # A resolvable scene after a dropped one still ships, and dialogue
    # under it is a normal text item.
    proj = make_project(tmp_path,
                        "label start:\n"
                        "    scene nowhere\n"
                        '    em"gone"\n'
                        "    scene a\n"
                        '    em"kept"\n'
                        '    em"chain"\n')
    (proj / "game" / "images").mkdir()
    (proj / "game" / "images" / "a.png").write_bytes(png("navy"))
    out = tmp_path / "out"
    assert cli_main([str(proj), str(out)]) == 0
    items = manifest_of(out)["items"]
    assert [i["type"] for i in items] == ["image", "text"]
    assert items[0]["text"] == "kept" and items[1]["text"] == "chain"
