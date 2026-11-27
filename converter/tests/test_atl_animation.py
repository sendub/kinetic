"""ATL frame lists become animations (docs/plan.md Phase 60 item 8).

An `image name:` ATL block made only of frames (quoted files, or image
names resolved as `show` resolves them), `pause N` (or a bare number) and
an optional last `repeat` / `repeat N` is an animation the walk's `show`
finds: even pauses give `fps` alone, mixed pauses `frameSeconds` with
`fps` their average; a bare `repeat` loops, `repeat N` plays N loops and
holds, no `repeat` plays once and holds. A per-frame `with` is a cut and
a `function` is dropped, each reported; any other ATL keeps the block
`image without a file`, the statement named (a show of it shows its
first picture, Phase 60 item 9n). A one-frame block is that
frame as a still, its properties reported as not applied.

Item 9n5: a frame that is a solid colour (`"#000"`, an image name of
one) is a still of that colour at the game's size, which `kinetic media
rebuild` makes again; a translucent one is laid over black, and a
`show` of the animation over a picture keeps its lines over it.
"""

from __future__ import annotations

import json
import subprocess
import sys
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from PIL import Image

from helpers import is_content_addressed
from kinetic_extract.cli import main as cli_main
from kinetic_extract.media_cli import main as media_main
from kinetic_extract.parser import parse_file

REPO_ROOT = Path(__file__).resolve().parents[2]


def atl(text: str):
    """The parse of ``text`` and its one ATL image definition (or None)."""
    parsed = parse_file(text, "game/x.rpy")
    defs = [v for v in parsed.image_defs.values() if v[0] == "atl"]
    return parsed, (defs[0][1] if defs else None)


def frames(image) -> list[tuple[str, float]]:
    return [(f.ref, f.seconds) for f in image.frames]


def reasons(parsed) -> list[str]:
    return [r.reason for r in parsed.reports]


# --- parser ------------------------------------------------------------------

def test_even_pauses_give_fps_alone_and_a_bare_repeat_loops() -> None:
    parsed, image = atl('image spin:\n'
                        '    "frame1.jpg"\n'
                        '    pause 0.15\n'
                        '    "frame2.jpg"\n'
                        '    pause 0.15\n'
                        '    repeat\n')
    assert "spin" in parsed.image_defs
    assert frames(image) == [("frame1.jpg", 0.15), ("frame2.jpg", 0.15)]
    assert not image.still
    assert image.timing() == {"fps": 1 / 0.15, "loopCount": 1}
    assert not any("image without a file" in r for r in reasons(parsed))


def test_mixed_pauses_give_frame_seconds_and_their_average_fps() -> None:
    _parsed, image = atl('image blink:\n'
                         '    "open.png"\n'
                         '    pause 2.0\n'
                         '    "shut.png"\n'
                         '    0.2\n'          # a bare number is a pause
                         '    repeat\n')
    assert frames(image) == [("open.png", 2.0), ("shut.png", 0.2)]
    assert image.timing() == {"fps": 2 / 2.2, "frameSeconds": [2.0, 0.2],
                              "loopCount": 1}


def test_repeat_n_plays_n_loops_and_holds() -> None:
    _parsed, image = atl('image wave:\n'
                         '    "a.png"\n    pause 0.5\n'
                         '    "b.png"\n    pause 0.5\n'
                         '    repeat 3\n')
    assert image.timing() == {"fps": 2.0, "loopCount": 3,
                              "holdLastFrame": True}


def test_no_repeat_plays_once_and_holds_its_last_frame() -> None:
    # The last frame has no pause: Ren'Py shows it from then on, so it is
    # the held frame (its time the block's shortest pause).
    _parsed, image = atl('image door:\n'
                         '    "d1.png"\n    pause 0.25\n'
                         '    "d2.png"\n    pause 0.25\n'
                         '    "d3.png"\n')
    assert frames(image) == [("d1.png", 0.25), ("d2.png", 0.25),
                             ("d3.png", 0.25)]
    assert image.timing() == {"fps": 4.0, "loopCount": 1,
                              "holdLastFrame": True}


def test_a_frame_with_no_time_is_left_out() -> None:
    parsed, image = atl('image flick:\n'
                        '    "a.png"\n    pause 0.5\n'
                        '    "gone.png"\n'
                        '    "b.png"\n    pause 0.5\n'
                        '    repeat\n')
    assert frames(image) == [("a.png", 0.5), ("b.png", 0.5)]
    assert any("gone.png" in r.statement and "no time" in r.reason
               for r in parsed.reports)


def test_several_pauses_after_a_frame_add_up() -> None:
    _parsed, image = atl('image slow:\n'
                         '    "a.png"\n    pause 0.5\n    pause 0.25\n'
                         '    "b.png"\n    pause 0.75\n    repeat\n')
    assert frames(image) == [("a.png", 0.75), ("b.png", 0.75)]


def test_a_frame_with_a_transition_is_a_cut_and_reported() -> None:
    parsed, image = atl('image fade:\n'
                        '    "a.png" with dissolve\n    pause 1\n'
                        '    "b.png" with Dissolve(0.5)\n    pause 1\n'
                        '    repeat\n')
    assert frames(image) == [("a.png", 1.0), ("b.png", 1.0)]
    cuts = [r for r in parsed.reports if "a cut" in r.reason]
    assert [r.source for r in cuts] == ["game/x.rpy:2", "game/x.rpy:4"]
    assert "with dissolve" in cuts[0].reason


def test_a_function_is_dropped_and_reported() -> None:
    parsed, image = atl('image shake:\n'
                        '    "a.png"\n    pause 0.1\n'
                        '    function shake_it\n'
                        '    "b.png"\n    pause 0.1\n    repeat\n')
    assert frames(image) == [("a.png", 0.1), ("b.png", 0.1)]
    (dropped,) = [r for r in parsed.reports if "dropped" in r.reason]
    assert dropped.source == "game/x.rpy:4"
    assert "function shake_it" in dropped.reason


def test_comma_joined_statements_read_as_their_own_lines() -> None:
    _parsed, image = atl('image quick:\n'
                         '    "a.png", pause 0.1\n'
                         '    "b.png", pause 0.1, repeat\n')
    assert frames(image) == [("a.png", 0.1), ("b.png", 0.1)]
    assert image.timing() == {"fps": 10.0, "loopCount": 1}


def test_other_atl_stays_an_image_without_a_file_naming_it() -> None:
    cases = {
        '    linear 1.0 xalign 1.0\n': "linear 1.0 xalign 1.0",
        '    ease 0.5 zoom 1.2\n': "ease 0.5 zoom 1.2",
        '    parallel:\n        "c.png"\n': "parallel:",
        '    block:\n        "c.png"\n        pause 1\n': "block:",
        '    choice:\n        "c.png"\n': "choice:",
        '    on show:\n        alpha 0.0\n': "on show:",
        '    contains:\n        "c.png"\n': "contains:",
        '    zoom 1.5\n': "zoom 1.5",
        '    xalign 0.5 yalign 1.0\n': "xalign 0.5 yalign 1.0",
        '    pause renpy.random.random()\n': "pause renpy.random.random()",
        '    time 2.0\n': "time 2.0",
        '    Image("c.png")\n': 'Image("c.png")',
    }
    for extra, named in cases.items():
        text = ('image busy:\n'
                '    "a.png"\n    pause 0.5\n'
                '    "b.png"\n    pause 0.5\n' + extra)
        parsed, image = atl(text)
        assert image is None, extra
        # Not a frame list: a show of it shows its first picture (item 9n).
        assert parsed.image_defs["busy"][0] == "atl-other", extra
        (reason,) = [r for r in reasons(parsed)
                     if r.startswith("image without a file")]
        assert f"`{named}`" in reason, (extra, reason)


def test_a_statement_after_repeat_is_not_converted() -> None:
    parsed, image = atl('image odd:\n'
                        '    "a.png"\n    pause 0.5\n'
                        '    "b.png"\n    pause 0.5\n'
                        '    repeat\n    "c.png"\n')
    assert image is None
    assert any(r.startswith("image without a file") and "`\"c.png\"`" in r
               for r in reasons(parsed))


def test_a_one_frame_block_is_a_still_its_properties_reported() -> None:
    parsed, image = atl('image big:\n'
                        '    "room.png"\n'
                        '    zoom 1.5\n'
                        '    xalign 0.5\n')
    assert image.still
    assert frames(image)[0][0] == "room.png"
    (note,) = [r for r in parsed.reports if "not applied" in r.reason]
    assert "zoom 1.5" in note.reason and "xalign 0.5" in note.reason
    assert not any("image without a file" in r for r in reasons(parsed))


def test_a_one_frame_block_with_motion_is_not_converted() -> None:
    parsed, image = atl('image pan:\n'
                        '    "room.png"\n'
                        '    linear 5.0 xalign 1.0\n')
    assert image is None
    # Reported at the image statement, the statement and its line named.
    (report,) = [r for r in parsed.reports
                 if r.reason.startswith("image without a file")]
    assert (report.source, report.statement) == ("game/x.rpy:1",
                                                 "image pan:")
    assert "`linear 5.0 xalign 1.0` (game/x.rpy:3)" in report.reason


def test_frames_by_image_name_and_a_name_with_attributes() -> None:
    parsed, image = atl('image frame1 = "frame1.jpg"\n'
                        'image ani 2:\n'
                        '    "frame1"\n    pause 0.15\n'
                        '    "eileen happy"\n    pause 0.15\n'
                        '    repeat\n')
    assert "ani 2" in parsed.image_defs
    assert [(f.ref, f.is_file) for f in image.frames] == [
        ("frame1", False), ("eileen happy", False)]


def test_the_block_s_frames_are_not_lines() -> None:
    parsed, _image = atl('image spin:\n'
                         '    "a.png"\n    pause 0.15\n'
                         '    "b.png"\n    pause 0.15\n    repeat\n'
                         'label start:\n    "Hello."\n')
    assert [e.text for e in parsed.events if e.kind == "dialogue"] == [
        "Hello."]


# --- extract -----------------------------------------------------------------

COLOURS = {"f1.png": (200, 30, 30), "f2.png": (30, 200, 30),
           "f3.png": (30, 30, 200), "bg.png": (40, 60, 80)}

SCRIPT = ('image glow:\n'                        # 1: even, bare repeat
          '    "f1.png"\n    pause 0.25\n'
          '    "images/f2.png"\n    pause 0.25\n'
          '    repeat\n'
          'image f3 = "f3.png"\n'                # 7
          'image door 2:\n'                      # 8: mixed, repeat 2
          '    "f1.png"\n    pause 0.5\n'
          '    "f3"\n    0.25\n'
          '    repeat 2\n'
          'image once:\n'                        # 14: by implicit name
          '    "f2"\n    pause 0.25\n'
          '    "f3" with dissolve\n'
          'image big:\n'                         # 18: one frame
          '    "bg.png"\n    zoom 1.5\n'
          'image same:\n'                        # 21: one picture twice
          '    "f1.png"\n    pause 0.25\n'
          '    "f1.png"\n    pause 0.25\n    repeat\n'
          'label start:\n'
          '    scene big\n'
          '    "A still room."\n'
          '    show glow\n'
          '    "It glows."\n'
          '    "It keeps glowing."\n'
          '    show door 2\n'
          '    "The door swings."\n'
          '    show once\n'
          '    "Once, then held."\n'
          '    show same\n'
          '    "Still the same."\n'
          '    show glow\n'
          '    "Glowing again."\n'
          '    return\n')


def make_project(tmp_path: Path) -> Path:
    game = tmp_path / "proj" / "game"
    (game / "images").mkdir(parents=True)
    for name, colour in COLOURS.items():
        Image.new("RGB", (32, 18), colour).save(game / "images" / name)
    (game / "script.rpy").write_text(SCRIPT, encoding="utf-8")
    return game.parent


def run_kinetic(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "kinetic_extract.kinetic_cli", *args],
        capture_output=True, text=True, cwd=REPO_ROOT, timeout=300)


def test_extract_ships_animations_and_keeps_their_lines(
        tmp_path: Path) -> None:
    proj = make_project(tmp_path)
    out = tmp_path / "out"
    with redirect_stdout(StringIO()):
        assert cli_main([str(proj), str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    items = manifest["items"]
    assert [(i["type"], i.get("text")) for i in items] == [
        ("image", "A still room."),
        ("animation", "It glows."), ("text", "It keeps glowing."),
        ("animation", "The door swings."),
        ("animation", "Once, then held."),
        ("image", "Still the same."),
        ("animation", "Glowing again.")]
    by_id = {i["id"]: i for i in items}
    glow, door, once = (by_id["glow-002"], by_id["door-2-004"],
                        by_id["once-005"])
    assert {k: glow[k] for k in glow if k not in ("frames", "id", "type",
                                                  "text")} == {
        "fps": 4.0, "loopCount": 1}
    assert {k: door[k] for k in door if k not in ("frames", "id", "type",
                                                  "text")} == {
        "fps": 2 / 0.75, "frameSeconds": [0.5, 0.25], "loopCount": 2,
        "holdLastFrame": True}
    assert once["fps"] == 4.0 and once["loopCount"] == 1
    assert once["holdLastFrame"] is True and "frameSeconds" not in once
    # Frames are content-addressed shipped images; a frame several
    # animations share ships once.
    for item in (glow, door, once):
        assert len(item["frames"]) == 2
        assert all(is_content_addressed(out, f) for f in item["frames"])
    f1, f2 = glow["frames"]
    assert door["frames"][0] == f1 and once["frames"][0] == f2
    assert door["frames"][1] == once["frames"][1]
    assert by_id["glow-007"]["frames"] == glow["frames"]
    assert by_id["same-006"]["file"] == f1
    assert by_id["big-001"]["file"] != f1
    reports = [(r["source"], r["reason"]) for r in ledger["report"]]
    assert not any("droppedUnresolved" in reason for _s, reason in reports)
    assert not any(reason.startswith("image without a file")
                   for _s, reason in reports)
    assert any(s == "game/script.rpy:17" and "a cut" in reason
               for s, reason in reports)
    assert any(s == "game/script.rpy:18" and "zoom 1.5" in reason
               for s, reason in reports)
    entry = ledger["items"]["glow-002"]
    assert [f["file"] for f in entry["frames"]] == glow["frames"]
    assert entry["frames"][1]["asset"] == "game/images/f2.png"
    assert any("one picture" in n for n in ledger["items"]["same-006"]
               ["notes"])
    # The folder validates silently and plays to its end.
    proc = run_kinetic("validate", str(out), "--strict")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout == "" and proc.stderr == ""
    play = tmp_path / "play"
    proc = run_kinetic("assemble", str(out), str(play))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    proc = run_kinetic("check", str(play), "--steps", "all",
                       "--no-media-check")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "story ended" in proc.stdout
    # The frames rebuild from the ledger and the game's files.
    out_dir = tmp_path / "rebuilt"
    with redirect_stdout(StringIO()) as said:
        assert media_main(["rebuild", str(proj), str(out),
                           "--out", str(out_dir)]) == 0
    assert f"{len(ledger['media'])} matched, 0 failed" in said.getvalue()
    for ref in glow["frames"] + door["frames"]:
        assert (out_dir / ref).read_bytes() == (out / ref).read_bytes()


def test_an_unresolved_frame_leaves_the_visual_naming_it(
        tmp_path: Path) -> None:
    """The animation is not shown; its line is kept over the picture
    before it (Phase 60 item 9n), the report naming the frame."""
    game = tmp_path / "proj" / "game"
    (game / "images").mkdir(parents=True)
    Image.new("RGB", (32, 18), (1, 2, 3)).save(game / "images" / "bg.png")
    (game / "script.rpy").write_text(
        'image ani:\n'
        '    "bg.png"\n    pause 0.5\n'
        '    "nowhere.png"\n    pause 0.5\n    repeat\n'
        'label start:\n'
        '    scene bg\n    "Before."\n'
        '    show ani\n    "Lost."\n'
        '    scene bg\n    "After."\n', encoding="utf-8")
    out = tmp_path / "out"
    with redirect_stdout(StringIO()):
        assert cli_main([str(game.parent), str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    assert [(i["type"], i.get("text")) for i in manifest["items"]] == [
        ("image", "Before."), ("text", "Lost."), ("image", "After.")]
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    (reason,) = [r["reason"] for r in ledger["report"]
                 if r["statement"] == "ani"]
    assert reason.startswith("unresolvedVisual") and "nowhere.png" in reason


# --- solid-colour frames (docs/plan.md Phase 60 item 9n5) --------------------

def extract_script(tmp_path: Path, script: str) -> tuple[Path, Path, dict,
                                                          dict]:
    """Extract ``script`` beside a 32x18 `bg.png` and `red.png`: the
    project, the folder, its manifest and its ledger."""
    game = tmp_path / "proj" / "game"
    (game / "images").mkdir(parents=True)
    Image.new("RGB", (32, 18), (40, 60, 80)).save(game / "images" / "bg.png")
    Image.new("RGB", (32, 18), (200, 0, 0)).save(game / "images" / "red.png")
    (game / "script.rpy").write_text(script, encoding="utf-8")
    out = tmp_path / "out"
    with redirect_stdout(StringIO()):
        assert cli_main([str(game.parent), str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    return game.parent, out, manifest, ledger


def one_colour(path: Path) -> str:
    """The one colour of a PNG at the game's size (32x18), `#rrggbb`."""
    with Image.open(path) as img:
        assert img.format == "PNG" and img.size == (32, 18)
        extrema = img.convert("RGB").getextrema()
    assert all(lo == hi for lo, hi in extrema), extrema
    return "#" + "".join(f"{lo:02x}" for lo, _hi in extrema)


def test_solid_colour_frames_animate_with_generated_frames(
        tmp_path: Path) -> None:
    """`"#fff"` then `pause`, an image name of a colour (`black`) and a
    `Solid` image are frames, each a still of its colour at the game's
    size, the one file each colour has."""
    _proj, out, manifest, ledger = extract_script(tmp_path, (
        'image sky = Solid((40, 120, 200))\n'
        'image flash:\n'
        '    "#fff"\n    pause 0.1\n'
        '    "black"\n    pause 0.1\n'
        '    "sky"\n    pause 0.2\n'
        '    repeat\n'
        'label start:\n'
        '    scene bg\n    "Before."\n'
        '    scene flash\n    "Flashing."\n'
        '    scene black\n    "Dark."\n'
        '    return\n'))
    items = manifest["items"]
    assert [(i["type"], i.get("text")) for i in items] == [
        ("image", "Before."), ("animation", "Flashing."), ("image", "Dark.")]
    flash = items[1]
    assert flash["frameSeconds"] == [0.1, 0.1, 0.2]
    assert flash["loopCount"] == 1 and "holdLastFrame" not in flash
    assert [one_colour(out / f) for f in flash["frames"]] == [
        "#ffffff", "#000000", "#2878c8"]
    assert all(is_content_addressed(out, f) for f in flash["frames"])
    # The black frame is the black still `scene black` shows.
    assert flash["frames"][1] == items[2]["file"]
    assert [ledger["media"][f]["source"] for f in flash["frames"]] == [
        {"generated": "#ffffff"}, {"generated": "black"},
        {"generated": "#2878c8"}]
    entry = ledger["items"][flash["id"]]
    assert entry["decision"] == "frames"
    assert [f["file"] for f in entry["frames"]] == flash["frames"]
    assert all(f["decision"] == "generated" for f in entry["frames"])


def test_picture_and_colour_frames_mix(tmp_path: Path) -> None:
    _proj, out, manifest, ledger = extract_script(tmp_path, (
        'image blink:\n'
        '    "bg.png"\n    pause 1.0\n'
        '    "#000"\n    pause 0.25\n'
        '    "red"\n    pause 1.0\n'
        'label start:\n'
        '    scene blink\n    "Blinking."\n'
        '    return\n'))
    (item,) = manifest["items"]
    assert item["type"] == "animation" and item["holdLastFrame"] is True
    assert item["frameSeconds"] == [1.0, 0.25, 1.0]
    assert [ledger["media"][f]["source"].get("path",
                                             ledger["media"][f]["source"])
            for f in item["frames"]] == [
        "game/images/bg.png", {"generated": "black"}, "game/images/red.png"]
    assert one_colour(out / item["frames"][1]) == "#000000"


def test_frames_all_one_colour_are_a_still(tmp_path: Path) -> None:
    _proj, out, manifest, ledger = extract_script(tmp_path, (
        'image dark:\n'
        '    "#000"\n    pause 0.5\n'
        '    "black"\n    pause 0.5\n'
        '    repeat\n'
        'label start:\n'
        '    scene bg\n    "A."\n'
        '    scene dark\n    "Dark."\n'
        '    return\n'))
    item = manifest["items"][1]
    assert item["type"] == "image" and one_colour(out / item["file"]) == \
        "#000000"
    assert ledger["media"][item["file"]]["source"] == {"generated": "black"}


def test_a_translucent_colour_frame(tmp_path: Path) -> None:
    """Item 9n3's rule: on a `scene`, or with no picture before it, a
    translucent frame is laid over black; a `show` of the animation over
    a picture keeps its lines over the picture, reported."""
    _proj, out, manifest, ledger = extract_script(tmp_path, (
        'image pulse:\n'
        '    "#ff000080"\n    pause 0.5\n'
        '    "#fff"\n    pause 0.5\n'
        '    repeat\n'
        'label start:\n'
        '    scene pulse\n    "Pulsing."\n'
        '    scene bg\n    "Room."\n'
        '    show pulse\n    "Over the room."\n'
        '    return\n'))
    items = manifest["items"]
    assert [(i["type"], i.get("text")) for i in items] == [
        ("animation", "Pulsing."), ("image", "Room."),
        ("text", "Over the room.")]
    assert [one_colour(out / f) for f in items[0]["frames"]] == [
        "#800000", "#ffffff"]
    notes = ledger["items"][items[2]["id"]]["notes"]
    assert any("kept over the last visual" in n and "translucent" in n
               for n in notes)
    assert any(r["statement"] == "pulse" and "translucent" in r["reason"]
               for r in ledger["report"])


def test_colour_frames_rebuild_from_the_ledger(tmp_path: Path) -> None:
    proj, out, manifest, ledger = extract_script(tmp_path, (
        'image flash:\n'
        '    "#fff"\n    pause 0.1\n'
        '    "bg.png"\n    pause 0.1\n'
        '    "#28c"\n    pause 0.1\n'
        '    repeat\n'
        'label start:\n'
        '    scene flash\n    "Flashing."\n'
        '    return\n'))
    (item,) = manifest["items"]
    rebuilt = tmp_path / "rebuilt"
    with redirect_stdout(StringIO()) as said:
        assert media_main(["rebuild", str(proj), str(out),
                           "--out", str(rebuilt)]) == 0
    assert f"{len(ledger['media'])} matched, 0 failed" in said.getvalue()
    for ref in item["frames"]:
        assert (rebuilt / ref).read_bytes() == (out / ref).read_bytes()
    # A changed colour frame is a failure, as any other output's is.
    (out / item["frames"][2]).write_bytes(b"not blue")
    with redirect_stdout(StringIO()):
        assert media_main(["rebuild", str(proj), str(out)]) == 1
