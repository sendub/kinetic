"""Pictures resolved as Ren'Py resolves them (docs/plan.md Phase 60 item
9n; docs/extracting.md, "Finding a script's files").

- `image a = "b c"` is the image named `b c` (a string with no dot is an
  image name to Ren'Py, one starting with `#` a solid colour).
- `image` statements inside `init:` and `init N:` blocks are read.
- `.avif` files ship, decoded by the pinned Pillow and converted as
  other non-browser stills are.
- File names match case-insensitively, as Ren'Py's loader matches them.
- `ConditionSwitch` and other displayables the converter cannot show
  become their first picture that resolves, noted in the ledger.
- `show x:` with an ATL block names `x` (and `behind`, `onlayer`,
  `zorder` and `as` end the name, as `at` and `with` do).
- An ATL image that is not a frame list shows its first picture that
  resolves; with none (a `Solid` flash) the visual stays as it was.
- Images Ren'Py defines from the images folder take part in a say
  statement's attribute choice as `image` statements do.
- A line whose visual resolves nowhere is kept over the picture on
  screen and reported, instead of being dropped.

Item 9n2 (the pictures item 9n still missed):

- A line before any picture shows over black, as Ren'Py's empty scene
  does: one black still at the game's size, made from nothing but its
  ledger entry, which `kinetic media rebuild` makes again.
- Single-quoted ATL frames and parenthesised pauses (`pause (0.5)`)
  are frame lists like any other.
- `show eve happy` of a tag on screen chooses among the images with
  the tag as Ren'Py's attribute choice does (an exact name first).
- Literal `renpy.image("name", "file")` calls define images.
- A `Movie(...)` image is its video: its `play` file, or what `play
  movie` plays on its channel.

Item 9n3:

- A shown solid colour (Ren'Py's built-in `black`, `"#rgb"`, `"#rgba"`,
  `"#rrggbb"`, `"#rrggbbaa"`, `Solid(...)` of a literal colour) is a
  still of that colour at the game's size, one per colour, which
  `kinetic media rebuild` makes again; a file of the image's name still
  shows in its place. A translucent `show` keeps its lines over the
  picture; a translucent `scene` shows over black. A solid colour
  replaced before anything shows it is left out.
- A menu before any picture hangs off a black still.
- A say statement's attributes try the exact image name first, as
  Ren'Py's `apply_attributes` does.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

from contextlib import redirect_stdout
from io import StringIO

from kinetic_extract import media_tools, rpa as rpa_mod
from kinetic_extract.cli import main as cli_main
from kinetic_extract.media_cli import main as media_main
from kinetic_extract.parser import parse_file

from test_jump_menus import check_folder, extract, texts
from test_route_items import H264, PICTURE, ffmpeg
from test_rpa import tiny_png_bytes, write_rpa


def picture(game: Path, rel: str, rgb: tuple[int, int, int]) -> None:
    path = game / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 18), rgb).save(path)


def run(tmp_path: Path, script: str,
        files: dict[str, tuple[int, int, int]] | None = None,
        ) -> tuple[Path, dict, dict]:
    game = tmp_path / "proj" / "game"
    for rel, rgb in (files or {}).items():
        picture(game, rel, rgb)
    return extract(tmp_path, script)


def assets(manifest: dict, ledger: dict) -> list[str | None]:
    """The picture each item shows: its own asset's file name without
    its extension, or for a text item the nearest earlier media item's
    (array order)."""
    out, last = [], None
    for item in manifest["items"]:
        entry = ledger["items"][item["id"]]
        if item["type"] == "animation":
            last = "(animation)"
        elif item["type"] != "text":
            last = (Path(entry["asset"]).stem if entry["asset"] is not None
                    else "(black)")
        out.append(last)
    return out


def reasons(ledger: dict) -> list[str]:
    return [r["reason"] for r in ledger["report"]]


def notes_of(manifest: dict, ledger: dict, text: str) -> list[str]:
    (item,) = [i for i in manifest["items"] if i.get("text") == text]
    return ledger["items"][item["id"]]["notes"]


KEPT = "kept over the last visual"


# --------------------------------------------------------------------------
# `image a = "b c"`: an image name
# --------------------------------------------------------------------------

def test_a_string_with_no_dot_names_an_image(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'image hall = "room dawn"\n'
        'image room dawn = "pics/dawn.png"\n'
        'image porch = "yard night"\n'
        'label start:\n'
        '    scene hall\n    "In the hall."\n'
        '    scene porch\n    "On the porch."\n'
        '    return\n'), {"pics/dawn.png": (200, 100, 0),
                          "images/yard night.png": (0, 100, 200)})
    assert texts(manifest) == ["In the hall.", "On the porch."]
    assert assets(manifest, ledger) == ["dawn", "yard night"]
    assert not any("unresolved" in r.lower() for r in reasons(ledger))


def test_a_string_starting_with_a_hash_is_a_solid_colour(tmp_path: Path
                                                        ) -> None:
    out, manifest, ledger = run(tmp_path, (
        'image flash = "#fff"\n'
        'label start:\n'
        '    scene bg\n    "Before."\n'
        '    scene flash\n    "During."\n'
        '    return\n'))
    assert texts(manifest) == ["Before.", "During."]
    assert shown(out, manifest, ledger) == ["bg", "#ffffff"]
    assert not any("unresolved" in r.lower() for r in reasons(ledger))


def test_a_file_named_as_a_solid_colour_image_shows_in_its_place(
        tmp_path: Path) -> None:
    """A picture of the name (often a black file beside `image black =
    "#000"`) shows in place of the solid colour (item 9n), not a
    generated still (item 9n3)."""
    out, manifest, ledger = run(tmp_path, (
        'image flash = "#fff"\n'
        'image dark = Solid("#000")\n'
        'label start:\n'
        '    scene bg\n    "Before."\n'
        '    scene flash\n    "Flash."\n'
        '    scene dark\n    "Dark."\n'
        '    return\n'), {"images/flash.png": (255, 255, 255),
                          "images/dark.png": (0, 0, 0)})
    assert texts(manifest) == ["Before.", "Flash.", "Dark."]
    assert assets(manifest, ledger) == ["bg", "flash", "dark"]
    assert any("solid colour" in n
               for n in notes_of(manifest, ledger, "Flash."))


# --------------------------------------------------------------------------
# `image` statements in `init:` blocks
# --------------------------------------------------------------------------

INIT = ('init:\n'
        '    $ count = 1\n'
        '    image hall = "pics/corridor.png"\n'
        'init -1:\n'
        '    image porch = "pics/yard.png"\n'
        'init 5:\n'
        '    image door:\n'
        '        "pics/corridor.png"\n'
        '        pause 0.5\n'
        '        "pics/yard.png"\n'
        '        pause 0.5\n'
        '        repeat\n'
        'label start:\n'
        '    scene hall\n    "Hall."\n'
        '    scene porch\n    "Porch."\n'
        '    scene door\n    "Door."\n'
        '    return\n')


def test_image_statements_in_init_blocks_are_read() -> None:
    parsed = parse_file(INIT, "game/script.rpy")
    assert parsed.image_defs["hall"] == ("file", "pics/corridor.png")
    assert parsed.image_defs["porch"] == ("file", "pics/yard.png")
    assert parsed.image_defs["door"][0] == "atl"
    # The block's lines are no story lines.
    assert [e.text for e in parsed.events if e.kind == "dialogue"] == [
        "Hall.", "Porch.", "Door."]


def test_init_block_images_show(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, INIT, {
        "pics/corridor.png": (200, 100, 0), "pics/yard.png": (0, 100, 200)})
    assert texts(manifest) == ["Hall.", "Porch.", "Door."]
    assert [i["type"] for i in manifest["items"]] == ["image", "image",
                                                      "animation"]


# --------------------------------------------------------------------------
# AVIF
# --------------------------------------------------------------------------

def test_avif_pictures_ship(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'image yard = "pics/lawn.avif"\n'
        'label start:\n'
        '    scene garden\n    "Garden."\n'
        '    scene yard\n    "Yard."\n'
        '    return\n'), {"images/garden.avif": (30, 160, 40),
                          "pics/lawn.avif": (90, 200, 60)})
    assert texts(manifest) == ["Garden.", "Yard."]
    assert assets(manifest, ledger) == ["garden", "lawn"]
    for item in manifest["items"]:
        entry = ledger["items"][item["id"]]
        assert entry["decision"] == "decode-convert", entry
        assert Path(item["file"]).suffix in (".png", ".jpg", ".jxl")
    check_folder(tmp_path, out, manifest)


# --------------------------------------------------------------------------
# File names match whatever their case
# --------------------------------------------------------------------------

def test_file_names_match_whatever_their_case(tmp_path: Path,
                                              monkeypatch: pytest.MonkeyPatch
                                              ) -> None:
    monkeypatch.setenv("KINETIC_EXTRACT_CACHE", str(tmp_path / "x-cache"))
    rpa_mod.reset_cache()
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    write_rpa(game / "pictures.rpa",
              {"pics/Lobby.png": tiny_png_bytes((10, 200, 10))})
    out, manifest, ledger = run(tmp_path, (
        'image hall = "Pics/Corridor.PNG"\n'
        'image lobby = "pics/lobby.png"\n'
        'image porch = "/pics//yard.png"\n'
        'label start:\n'
        '    scene hall\n    "Hall."\n'
        '    scene lobby\n    "Lobby."\n'
        '    scene porch\n    "Porch."\n'
        '    return\n'), {"pics/corridor.png": (200, 100, 0),
                          "pics/yard.png": (0, 100, 200)})
    rpa_mod.reset_cache()
    assert texts(manifest) == ["Hall.", "Lobby.", "Porch."]
    assert assets(manifest, ledger) == ["corridor", "Lobby",
                                        "yard"]


# --------------------------------------------------------------------------
# Displayables the converter cannot show
# --------------------------------------------------------------------------

def test_a_condition_switch_shows_its_first_picture_that_resolves(
        tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'image eve = ConditionSwitch(\n'
        '    "mood == 1", "pics/missing.png",\n'
        '    "True", "pics/eve calm.png")\n'
        'image sky = ConditionSwitch("day", Transform("pics/noon.png", '
        'zoom=0.5), "True", "pics/dusk.png")\n'
        'label start:\n'
        '    scene eve\n    "Eve."\n'
        '    scene sky\n    "Sky."\n'
        '    return\n'), {"pics/eve calm.png": (200, 100, 0),
                          "pics/noon.png": (0, 100, 200),
                          "pics/dusk.png": (90, 0, 90)})
    assert texts(manifest) == ["Eve.", "Sky."]
    assert assets(manifest, ledger) == ["eve calm", "noon"]
    notes = notes_of(manifest, ledger, "Eve.")
    assert any("ConditionSwitch" in n and "first picture" in n
               for n in notes), notes


def test_an_atl_image_that_is_not_a_frame_list_shows_its_picture(
        tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'image pan:\n'
        '    "pics/corridor.png"\n'
        '    linear 5.0 xalign 1.0\n'
        'label start:\n'
        '    scene pan\n    "Panning."\n'
        '    return\n'), {"pics/corridor.png": (200, 100, 0)})
    assert texts(manifest) == ["Panning."]
    assert assets(manifest, ledger) == ["corridor"]
    notes = notes_of(manifest, ledger, "Panning.")
    assert any("not a frame list" in n and "first picture" in n
               for n in notes), notes


FLASH = ('image flash:\n'
         '    Solid("#fff")\n'
         '    alpha 0.0\n'
         '    linear 0.1 alpha 1.0\n'
         '    linear 0.1 alpha 0.0\n')


def test_a_solid_flash_leaves_the_visual_as_it_was(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, FLASH + (
        'label start:\n'
        '    scene bg\n    "Before."\n'
        '    show flash\n    "During."\n'
        '    return\n'))
    assert texts(manifest) == ["Before.", "During."]
    assert assets(manifest, ledger) == ["bg", "bg"]
    assert not any("unresolved" in r.lower() for r in reasons(ledger))
    assert not any(KEPT in n for n in notes_of(manifest, ledger, "During."))


def test_a_solid_flash_before_the_first_line_keeps_its_picture(
        tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, FLASH + (
        'label start:\n'
        '    scene bg with dissolve\n'
        '    show flash\n    "During."\n'
        '    return\n'))
    assert [(i["type"], i.get("text")) for i in manifest["items"]] == [
        ("image", "During.")]
    assert manifest["items"][0]["transition"]["kind"] == "dissolve"


# --------------------------------------------------------------------------
# `show x:` and the other clauses of a show
# --------------------------------------------------------------------------

@pytest.mark.parametrize(("statement", "name"), [
    ("show eve calm:", "eve calm"),
    ("show eve calm at left:", "eve calm"),
    ("show eve calm behind bg", "eve calm"),
    ("show eve calm onlayer overlay", "eve calm"),
    ("show eve calm zorder 2", "eve calm"),
    ("show eve calm as second", "eve calm"),
    ("scene bg:", "bg"),
])
def test_the_image_name_of_a_show(statement: str, name: str) -> None:
    block = "        xalign 0.5\n" if statement.endswith(":") else ""
    parsed = parse_file(f'label start:\n    {statement}\n{block}'
                        '    "Shown."\n', "game/script.rpy")
    (visual,) = [e for e in parsed.events if e.kind == "visual"]
    assert visual.name == name


def test_a_show_with_an_atl_block_shows_the_image(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    scene bg\n'
        '    show eve calm:\n'
        '        xalign 0.5\n'
        '        "eve happy"\n'
        '    "Shown."\n'
        '    return\n'), {"images/eve calm.png": (200, 100, 0)})
    # The block's string is a child displayable, not a line.
    assert texts(manifest) == [None, "Shown."]
    assert assets(manifest, ledger) == ["bg", "eve calm"]


def test_show_expression_of_a_file(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    scene expression "pics/corridor.png" with dissolve\n'
        '    "Hall."\n'
        '    return\n'), {"pics/corridor.png": (200, 100, 0)})
    assert texts(manifest) == ["Hall."]
    assert assets(manifest, ledger) == ["corridor"]
    assert manifest["items"][0]["transition"]["kind"] == "dissolve"


# --------------------------------------------------------------------------
# Automatic images take part in the attribute choice
# --------------------------------------------------------------------------

def test_images_from_the_images_folder_take_part_in_attribute_choice(
        tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'define e = Character("Eve", image="eve")\n'
        'label start:\n'
        '    show eve casual calm\n'
        '    e "Calm."\n'
        '    e happy "Happy."\n'
        '    e -casual formal "Formal."\n'
        '    return\n'), {"images/eve casual calm.png": (10, 20, 30),
                          "images/Eve Casual Happy.png": (200, 20, 30),
                          "images/sub/eve formal happy.png": (10, 200, 30)})
    assert texts(manifest) == ["Calm.", "Happy.", "Formal."]
    assert assets(manifest, ledger) == ["eve casual calm", "Eve Casual Happy",
                                        "eve formal happy"]


# --------------------------------------------------------------------------
# A visual that resolves nowhere keeps its lines
# --------------------------------------------------------------------------

def test_lines_under_an_unresolved_visual_are_kept_over_the_last_one(
        tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    scene bg\n    "A."\n'
        '    scene nowhere\n    "B."\n    "C."\n'
        '    scene bg\n    "D."\n'
        '    return\n'))
    assert texts(manifest) == ["A.", "B.", "C.", "D."]
    assert assets(manifest, ledger) == ["bg", "bg", "bg", "bg"]
    for text in ("B.", "C."):
        assert any(KEPT in n and "nowhere" in n
                   for n in notes_of(manifest, ledger, text))
    for text in ("A.", "D."):
        assert not any(KEPT in n for n in notes_of(manifest, ledger, text))
    (report,) = [r for r in ledger["report"] if "nowhere" in r["statement"]]
    assert report["source"] == "game/script.rpy:4"
    assert KEPT in report["reason"]
    assert not any(r.startswith("droppedUnresolved") for r in reasons(ledger))
    check_folder(tmp_path, out, manifest)


def test_a_line_takes_the_picture_waiting_before_the_unresolved_one(
        tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    scene bg\n'
        '    show nowhere\n    "B."\n'
        '    return\n'))
    assert [(i["type"], i.get("text")) for i in manifest["items"]] == [
        ("image", "B.")]
    assert any(KEPT in n for n in notes_of(manifest, ledger, "B."))


def test_forms_together_make_a_folder_that_plays(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'define e = Character("Eve", image="eve")\n'
        'init:\n'
        '    image hall = "Pics/Corridor.PNG"\n'
        '    image eve = ConditionSwitch("x", "pics/nope.png", '
        '"True", "eve calm")\n'
        + FLASH +
        'label start:\n'
        '    scene hall\n    "Hall."\n'
        '    show flash\n    "Flash."\n'
        '    show eve:\n        xalign 0.5\n    e "Eve."\n'
        '    show eve calm behind hall\n    e happy "Happy."\n'
        '    menu:\n'
        '        "Stay":\n'
        '            scene nowhere\n            "Stayed."\n'
        '        "Go":\n'
        '            "Went."\n'
        '    "End."\n'
        '    return\n'), {"pics/corridor.png": (200, 100, 0),
                          "images/eve calm.png": (10, 20, 30),
                          "images/eve happy.png": (200, 20, 30)})
    assert texts(manifest) == ["Hall.", "Flash.", "Eve.", "Happy.",
                               "Stayed.", "Went.", "End."]
    assert assets(manifest, ledger)[:4] == ["corridor", "corridor",
                                            "eve calm", "eve happy"]
    check_folder(tmp_path, out, manifest)


# ==========================================================================
# Item 9n2
# ==========================================================================

# --------------------------------------------------------------------------
# A line before any picture shows over black
# --------------------------------------------------------------------------

def black_file(out: Path, manifest: dict) -> str:
    """The one black still the folder's items show: a PNG at the game's
    size, every pixel black."""
    files = {i["file"] for i in manifest["items"]
             if i["type"] == "image" and "black-" in i["id"]}
    (ref,) = files
    assert ref.endswith(".png")
    with Image.open(out / ref) as img:
        assert img.size == (manifest["width"], manifest["height"])
        assert img.convert("RGB").getextrema() == ((0, 0), (0, 0), (0, 0))
    return ref


def test_a_line_before_any_picture_shows_over_black(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    "Darkness."\n    "Still dark."\n'
        '    scene bg\n    "Light."\n'
        '    return\n'))
    assert [(i["type"], i.get("text")) for i in manifest["items"]] == [
        ("image", "Darkness."), ("text", "Still dark."), ("image", "Light.")]
    assert assets(manifest, ledger) == ["(black)", "(black)", "bg"]
    ref = black_file(out, manifest)
    first = manifest["items"][0]
    entry = ledger["items"][first["id"]]
    assert entry["decision"] == "generated" and entry["file"] == ref
    assert any("black" in n for n in entry["notes"])
    media = ledger["media"][ref]
    assert media["kind"] == "image" and "path" not in media["source"]
    assert media["source"]["generated"] == "black"
    check_folder(tmp_path, out, manifest)


def test_a_line_over_a_solid_scene_before_any_picture_shows_over_black(
        tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    scene black with fade\n    "Darkness."\n'
        '    scene bg\n    "Light."\n'
        '    return\n'))
    assert texts(manifest) == ["Darkness.", "Light."]
    assert assets(manifest, ledger) == ["(black)", "bg"]
    black_file(out, manifest)
    check_folder(tmp_path, out, manifest)


def test_a_line_with_no_picture_before_its_unresolved_one_shows_over_black(
        tmp_path: Path) -> None:
    """Item 9n dropped it (`droppedUnresolved`): it now shows over
    Ren'Py's empty scene, kept as the other lines under the visual are."""
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    scene nowhere\n    "A."\n'
        '    scene bg\n    "B."\n'
        '    return\n'))
    assert texts(manifest) == ["A.", "B."]
    assert assets(manifest, ledger) == ["(black)", "bg"]
    assert any(KEPT in n and "nowhere" in n
               for n in notes_of(manifest, ledger, "A."))
    assert not any(r.startswith("droppedUnresolved") for r in reasons(ledger))
    check_folder(tmp_path, out, manifest)


def test_the_black_still_rebuilds_from_the_ledger(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    "Darkness."\n'
        '    scene bg\n    "Light."\n'
        '    return\n'))
    ref = black_file(out, manifest)
    rebuilt = tmp_path / "rebuilt"
    with redirect_stdout(StringIO()) as said:
        assert media_main(["rebuild", str(tmp_path / "proj"), str(out),
                           "--out", str(rebuilt)]) == 0
    assert f"{len(ledger['media'])} matched, 0 failed" in said.getvalue()
    assert (rebuilt / ref).read_bytes() == (out / ref).read_bytes()
    # A changed black still is a failure, as any other output's is.
    (out / ref).write_bytes(b"not black")
    with redirect_stdout(StringIO()):
        assert media_main(["rebuild", str(tmp_path / "proj"), str(out)]) == 1


def test_every_place_before_a_picture_shares_one_black_still(
        tmp_path: Path) -> None:
    projects = []
    for n in (1, 2):
        game = tmp_path / f"ep{n}" / "game"
        picture(game, "images/bg.png", (40, 60, 80))
        (game / "script.rpy").write_text(
            f'label start:\n    "Episode {n} opens."\n'
            f'    scene bg\n    "Episode {n} goes on."\n    return\n',
            encoding="utf-8")
        projects.append(str(game.parent))
    out = tmp_path / "out"
    with redirect_stdout(StringIO()):
        assert cli_main([*projects, str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    blacks = [i for i in manifest["items"] if i["type"] == "image"
              and "black" in i["id"]]
    assert len(blacks) == 2
    ref = black_file(out, {**manifest, "items": blacks[:1]})
    assert {i["file"] for i in blacks} == {ref}
    assert [k for k, e in ledger["media"].items()
            if e["source"].get("generated")] == [ref]
    check_folder(tmp_path, out, manifest)


# --------------------------------------------------------------------------
# Frame lists in other forms
# --------------------------------------------------------------------------

QUOTED_FRAMES = ("image blink:\n"
                 "    'pics/open.png'\n"
                 "    pause (0.5)\n"
                 "    'pics/shut.png'\n"
                 "    pause(0.25)\n"
                 "    repeat\n"
                 "image wink:\n"
                 '    "pics/open.png", (0.5)\n'
                 "    'pics/shut.png', pause ( 0.5 )\n"
                 "    repeat 2\n")


def test_single_quoted_frames_and_parenthesised_pauses_are_frame_lists(
        ) -> None:
    parsed = parse_file(QUOTED_FRAMES, "game/script.rpy")
    tag, blink = parsed.image_defs["blink"]
    assert tag == "atl"
    assert [(f.ref, f.seconds) for f in blink.frames] == [
        ("pics/open.png", 0.5), ("pics/shut.png", 0.25)]
    tag, wink = parsed.image_defs["wink"]
    assert tag == "atl"
    assert [(f.ref, f.seconds) for f in wink.frames] == [
        ("pics/open.png", 0.5), ("pics/shut.png", 0.5)]
    assert wink.timing() == {"fps": 2.0, "loopCount": 2,
                             "holdLastFrame": True}
    assert not any("image without a file" in r.reason
                   for r in parsed.reports)


def test_frame_lists_in_other_forms_animate(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, QUOTED_FRAMES + (
        'label start:\n'
        '    scene bg\n    "Bg."\n'
        '    show blink\n    "Blinking."\n'
        '    show wink\n    "Winking."\n'
        '    return\n'), {"pics/open.png": (200, 100, 0),
                          "pics/shut.png": (0, 100, 200)})
    assert texts(manifest) == ["Bg.", "Blinking.", "Winking."]
    blink, wink = manifest["items"][1:]
    assert blink["type"] == wink["type"] == "animation"
    assert blink["frameSeconds"] == [0.5, 0.25]
    assert len(set(blink["frames"])) == 2
    check_folder(tmp_path, out, manifest)


# --------------------------------------------------------------------------
# `show eve happy`: Ren'Py's attribute choice
# --------------------------------------------------------------------------

def test_a_show_of_a_shown_tag_chooses_by_attributes(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'image eve formal happy = "pics/formal.png"\n'
        'label start:\n'
        '    scene bg\n'
        '    show eve casual calm\n    "Calm."\n'
        '    show eve happy\n    "Happy."\n'
        '    show eve -casual formal\n    "Formal."\n'
        '    show eve\n    "Same."\n'
        '    return\n'), {"images/eve casual calm.png": (10, 20, 30),
                          "images/Eve Casual Happy.png": (200, 20, 30),
                          "pics/formal.png": (10, 200, 30)})
    assert texts(manifest) == [None, "Calm.", "Happy.", "Formal.", "Same."]
    assert assets(manifest, ledger) == ["bg", "eve casual calm",
                                        "Eve Casual Happy", "formal",
                                        "formal"]
    notes = notes_of(manifest, ledger, "Happy.")
    assert any("eve casual happy" in n and "attributes" in n
               for n in notes), notes
    assert not any("unresolved" in r.lower() for r in reasons(ledger))
    check_folder(tmp_path, out, manifest)


def test_an_image_of_the_exact_name_wins_over_the_attribute_choice(
        tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    scene bg\n'
        '    show eve casual calm\n    "Calm."\n'
        '    show eve happy\n    "Happy."\n'
        '    return\n'), {"images/eve casual calm.png": (10, 20, 30),
                          "images/eve casual happy.png": (200, 20, 30),
                          "images/eve happy.png": (10, 200, 30)})
    assert assets(manifest, ledger) == ["bg", "eve casual calm", "eve happy"]


def test_a_scene_keeps_no_attributes(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    scene room day\n    "Day."\n'
        '    scene room night\n    "Night."\n'
        '    return\n'), {"images/room day.png": (10, 20, 30),
                          "images/room day night.png": (200, 20, 30),
                          "images/room night.png": (10, 200, 30)})
    assert assets(manifest, ledger) == ["room day", "room night"]


# --------------------------------------------------------------------------
# `renpy.image` calls
# --------------------------------------------------------------------------

RENPY_IMAGE = ('init python:\n'
               '    renpy.image("hall", "pics/corridor.png")\n'
               "    renpy.image('porch', 'yard dusk')\n"
               '    renpy.image(("eve", "calm"), "pics/eve.png")\n'
               '    for n in range(3):\n'
               '        renpy.image("loop %d" % n, "pics/x%d.png" % n)\n'
               'init 1 python:\n'
               '    renpy.image("door",\n'
               '                "pics/door.png")\n')


def test_renpy_image_calls_define_images() -> None:
    parsed = parse_file(RENPY_IMAGE + (
        'label start:\n'
        '    $ renpy.image("gate", "pics/gate.png")\n'
        '    "Gate."\n'), "game/script.rpy")
    defs = parsed.image_defs
    assert defs["hall"] == ("file", "pics/corridor.png")
    assert defs["porch"] == ("file", "yard dusk")
    assert defs["eve calm"] == ("file", "pics/eve.png")
    assert defs["door"] == ("file", "pics/door.png")
    assert defs["gate"] == ("file", "pics/gate.png")
    assert not any(name.startswith("loop") for name in defs)


def test_renpy_image_pictures_show(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, RENPY_IMAGE + (
        'label start:\n'
        '    $ renpy.image("gate", "pics/gate.png")\n'
        '    scene hall\n    "Hall."\n'
        '    scene porch\n    "Porch."\n'
        '    scene gate\n    "Gate."\n'
        '    show eve calm\n    "Eve."\n'
        '    scene door\n    "Door."\n'
        '    return\n'), {"pics/corridor.png": (200, 100, 0),
                          "images/yard dusk.png": (0, 100, 200),
                          "pics/gate.png": (90, 0, 90),
                          "pics/eve.png": (9, 9, 90),
                          "pics/door.png": (90, 90, 9)})
    assert texts(manifest) == ["Hall.", "Porch.", "Gate.", "Eve.", "Door."]
    assert assets(manifest, ledger) == ["corridor", "yard dusk", "gate",
                                        "eve", "door"]
    check_folder(tmp_path, out, manifest)


# --------------------------------------------------------------------------
# Movie images
# --------------------------------------------------------------------------

def clip(tmp_path: Path, rel: str = "clip.mp4") -> None:
    ffmpeg(tmp_path / "proj" / "game" / rel, [*PICTURE, *H264])


def test_a_movie_image_with_a_play_file_is_that_video(tmp_path: Path
                                                     ) -> None:
    clip(tmp_path, "movies/intro.mp4")
    out, manifest, ledger = run(tmp_path, (
        "image intro = Movie(play='movies/intro.mp4', loop=False, "
        "size=(64, 36), mask='movies/intro-mask.mp4')\n"
        'label start:\n'
        '    scene bg\n    "Before."\n'
        '    show intro\n    "Playing."\n'
        '    return\n'))
    assert [(i["type"], i.get("text")) for i in manifest["items"]] == [
        ("image", "Before."), ("video", "Playing.")]
    assert assets(manifest, ledger) == ["bg", "intro"]
    notes = notes_of(manifest, ledger, "Playing.")
    for arg in ("size", "mask"):
        assert any(arg in n and "not carried" in n for n in notes), notes
    # It plays once (item 9n4): carried as holdLastFrame, so not noted.
    assert not any("loop=False" in n for n in notes), notes
    check_folder(tmp_path, out, manifest)


def frame_png(video: Path, at: float, out: Path) -> bytes:
    """The pixels of `video`'s frame at `at` seconds, decoded apart from
    the converter."""
    ffmpeg(out, ["-i", str(video), "-ss", f"{at}", "-frames:v", "1"])
    with Image.open(out) as img:
        return img.convert("RGB").tobytes()


def pixels(path: Path) -> bytes:
    """A shipped still's RGB pixels, a lossless JPEG XL one included."""
    if path.suffix == ".jxl":
        return Image.fromarray(media_tools.jxl_decode(path.read_bytes())
                               ).convert("RGB").tobytes()
    with Image.open(path) as img:
        return img.convert("RGB").tobytes()


def test_a_movie_that_plays_once_holds_its_last_frame(tmp_path: Path
                                                     ) -> None:
    """`Movie(..., loop=False)` (item 9n4): the video item holds its last
    frame (`holdLastFrame`) and ships that frame as its `lastFrame`
    still, recorded in the ledger as posters are; a looping Movie is as
    before."""
    clip(tmp_path, "movies/once.mp4")
    clip(tmp_path, "movies/loops.mp4")
    out, manifest, ledger = run(tmp_path, (
        "image once = Movie(play='movies/once.mp4', loop=False)\n"
        "image loops = Movie(play='movies/loops.mp4', loop=True)\n"
        'label start:\n'
        '    scene bg\n    "Before."\n'
        '    show once\n    "Once."\n    "Still once."\n'
        '    show loops\n    "Loops."\n'
        '    return\n'))
    once, loops = [i for i in manifest["items"] if i["type"] == "video"]
    assert once["holdLastFrame"] is True
    assert "holdLastFrame" not in loops and "lastFrame" not in loops
    last = out / once["lastFrame"]
    assert last.is_file() and once["lastFrame"] != once["poster"]
    # The clip is 1 s at 10 fps: its last frame is the one at 0.9 s.
    source = tmp_path / "proj" / "game" / "movies" / "once.mp4"
    assert pixels(last) == frame_png(source, 0.9, tmp_path / "f9.png")
    assert pixels(last) != pixels(out / once["poster"])
    entry = ledger["media"][once["lastFrame"]]
    assert entry["kind"] == "lastFrame"
    assert entry["steps"][0]["step"] == "lastFrame"
    assert ledger["items"][once["id"]]["lastFrame"] == once["lastFrame"]
    check_folder(tmp_path, out, manifest)
    # Posters still check, and the ledger makes the still again.
    with redirect_stdout(StringIO()):
        assert media_main(["posters", str(tmp_path / "proj"),
                           str(out)]) == 0
    rebuilt = tmp_path / "rebuilt"
    with redirect_stdout(StringIO()) as said:
        assert media_main(["rebuild", str(tmp_path / "proj"), str(out),
                           "--out", str(rebuilt)]) == 0
    assert f"{len(ledger['media'])} matched, 0 failed" in said.getvalue()
    assert (rebuilt / once["lastFrame"]).read_bytes() == last.read_bytes()


@pytest.mark.parametrize("order", ["play first", "show first"])
def test_a_movie_image_shows_what_play_movie_plays(tmp_path: Path,
                                                   order: str) -> None:
    clip(tmp_path)
    play, show = '    play movie "clip.mp4"\n', '    show movie\n'
    out, manifest, ledger = run(tmp_path, (
        'image movie = Movie(size=(1280, 720), xalign=0.5)\n'
        'label start:\n'
        '    scene bg\n    "Before."\n'
        + (play + show if order == "play first" else show + play) +
        '    "Playing."\n'
        '    stop movie\n'
        '    hide movie\n'
        '    scene bg\n    "After."\n'
        '    return\n'))
    assert [(i["type"], i.get("text")) for i in manifest["items"]] == [
        ("image", "Before."), ("video", "Playing."), ("image", "After.")]
    assert assets(manifest, ledger) == ["bg", "clip", "bg"]
    assert not any("unresolved" in r.lower() for r in reasons(ledger))
    check_folder(tmp_path, out, manifest)


def test_a_movie_channel_of_its_own(tmp_path: Path) -> None:
    clip(tmp_path)
    out, manifest, ledger = run(tmp_path, (
        'init python:\n'
        '    renpy.music.register_channel("cut", "movie", movie=True)\n'
        'image screen = Movie(channel="cut")\n'
        'label start:\n'
        '    scene bg\n    "Before."\n'
        '    show screen\n'
        '    play cut "clip.mp4"\n'
        '    "Playing."\n'
        '    return\n'))
    assert [(i["type"], i.get("text")) for i in manifest["items"]] == [
        ("image", "Before."), ("video", "Playing.")]


# ==========================================================================
# Item 9n3
# ==========================================================================

# --------------------------------------------------------------------------
# A shown solid colour is a still of that colour
# --------------------------------------------------------------------------

def generated_colour(out: Path, item: dict) -> str:
    """The one colour of a generated still, as `#rrggbb`, checking it is
    a PNG at the game's size."""
    assert item["file"].endswith(".png")
    with Image.open(out / item["file"]) as img:
        rgb = img.convert("RGB")
        extrema = rgb.getextrema()
        assert all(lo == hi for lo, hi in extrema), extrema
        return "#" + "".join(f"{lo:02x}" for lo, _hi in extrema)


def shown(out: Path, manifest: dict, ledger: dict) -> list[str | None]:
    """As ``assets``, a generated still named by its colour."""
    out_list, last = [], None
    for item in manifest["items"]:
        entry = ledger["items"][item["id"]]
        if item["type"] == "text":
            pass
        elif entry.get("decision") == "generated":
            last = generated_colour(out, item)
        elif item["type"] == "animation":
            last = "(animation)"
        else:
            last = Path(entry["asset"]).stem
        out_list.append(last)
    return out_list


def test_scene_black_after_a_picture_shows_a_black_still(tmp_path: Path
                                                         ) -> None:
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    scene bg\n    "A."\n'
        '    scene black\n    "B."\n    "C."\n'
        '    scene bg\n    "D."\n'
        '    return\n'))
    assert [(i["type"], i.get("text")) for i in manifest["items"]] == [
        ("image", "A."), ("image", "B."), ("text", "C."), ("image", "D.")]
    assert shown(out, manifest, ledger) == ["bg", "#000000", "#000000", "bg"]
    ref = manifest["items"][1]["file"]
    assert ledger["media"][ref]["source"] == {"generated": "black"}
    assert not any(r.startswith("solid color screen")
                   for r in reasons(ledger))
    assert not any(KEPT in n for n in notes_of(manifest, ledger, "C."))


@pytest.mark.parametrize(("define", "colour"), [
    ('"#fff"', "#ffffff"),
    ('"#80c0ff"', "#80c0ff"),
    ('"#102030ff"', "#102030"),
    ('"#0f0f"', "#00ff00"),
    ("Solid('#c84')", "#cc8844"),
    ('Solid("#12345678")', "#081828"),
    ('Solid((10, 20, 30))', "#0a141e"),
    ('Solid((10, 20, 30, 255))', "#0a141e"),
    ('Solid(color="#123")', "#112233"),
    ('Solid("#fff", xalign=0.5)', "#ffffff"),
])
def test_each_solid_colour_form_shows_its_colour(tmp_path: Path, define: str,
                                                 colour: str) -> None:
    """A scene of a translucent colour (`#12345678`) shows it over black,
    the empty scene under it."""
    out, manifest, ledger = run(tmp_path, (
        f'image flash = {define}\n'
        'label start:\n'
        '    scene bg\n    "Before."\n'
        '    scene flash\n    "During."\n'
        '    show bg\n    "After."\n'
        '    return\n'))
    assert texts(manifest) == ["Before.", "During.", "After."]
    assert shown(out, manifest, ledger) == ["bg", colour, "bg"]
    item = manifest["items"][1]
    assert item["id"].startswith("flash")
    expected = "black" if colour == "#000000" else colour
    assert ledger["media"][item["file"]]["source"] == {"generated": expected}
    assert any(colour in n for n in notes_of(manifest, ledger, "During."))


def test_a_show_of_a_solid_colour_covers_the_picture(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'image red = "#f00"\n'
        'label start:\n'
        '    scene bg\n    "A."\n'
        '    show red\n    "B."\n'
        '    return\n'))
    assert shown(out, manifest, ledger) == ["bg", "#ff0000"]


def test_scene_white_with_no_definition_is_white(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    scene bg\n    "A."\n'
        '    scene white\n    "B."\n'
        '    return\n'))
    assert shown(out, manifest, ledger) == ["bg", "#ffffff"]


def test_a_file_named_black_shows_in_place_of_the_built_in_black(
        tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    scene bg\n    "A."\n'
        '    scene black\n    "B."\n'
        '    return\n'), {"images/black.png": (1, 2, 3)})
    assert shown(out, manifest, ledger) == ["bg", "black"]
    assert not any(e["source"].get("generated")
                   for e in ledger["media"].values())


def test_a_file_elsewhere_named_black_is_not_the_built_in_black(
        tmp_path: Path) -> None:
    """Ren'Py names `gui/black.png` `gui/black`, not `black`: the
    built-in black is not that file, whose basename only matches."""
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    scene bg\n    "A."\n'
        '    scene black\n    "B."\n'
        '    return\n'), {"gui/black.png": (1, 2, 3)})
    assert shown(out, manifest, ledger) == ["bg", "#000000"]


def test_scene_hash_colour_is_a_bare_scene_over_black(tmp_path: Path) -> None:
    """Ren'Py reads `#` outside a string as a comment: `scene #fff` is a
    bare `scene`, which clears the layer to black."""
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    scene bg\n    "A."\n'
        '    scene #fff\n    "B."\n'
        '    return\n'))
    assert shown(out, manifest, ledger) == ["bg", "#000000"]


def test_a_translucent_show_keeps_its_lines_over_the_picture(tmp_path: Path
                                                            ) -> None:
    out, manifest, ledger = run(tmp_path, (
        'image dim = "#00000080"\n'
        'label start:\n'
        '    scene bg\n    "A."\n'
        '    show dim\n    "B."\n'
        '    scene dim\n    "C."\n'
        '    return\n'))
    assert [(i["type"], i.get("text")) for i in manifest["items"]] == [
        ("image", "A."), ("text", "B."), ("image", "C.")]
    assert shown(out, manifest, ledger) == ["bg", "bg", "#000000"]
    assert any("translucent" in n for n in notes_of(manifest, ledger, "B."))
    assert any("translucent" in r for r in reasons(ledger))


def test_a_translucent_show_before_any_picture_shows_over_black(
        tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'image tint = "#ff000080"\n'
        'label start:\n'
        '    show tint\n    "A."\n'
        '    scene bg\n    "B."\n'
        '    return\n'))
    assert shown(out, manifest, ledger) == ["#800000", "bg"]


def test_a_sized_solid_keeps_its_lines_over_the_picture(tmp_path: Path
                                                       ) -> None:
    out, manifest, ledger = run(tmp_path, (
        'image bar = Solid("#fff", xysize=(100, 20))\n'
        'label start:\n'
        '    scene bg\n    "A."\n'
        '    show bar\n    "B."\n'
        '    return\n'))
    assert shown(out, manifest, ledger) == ["bg", "bg"]
    assert any("bar" in r["statement"] for r in ledger["report"])


def test_a_transition_into_a_solid_colour(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    scene bg\n    "A."\n'
        '    scene white with dissolve\n    "B."\n'
        '    return\n'))
    assert shown(out, manifest, ledger) == ["bg", "#ffffff"]
    assert manifest["items"][1]["transition"]["kind"] == "dissolve"


def test_a_solid_colour_nothing_shows_is_left_out(tmp_path: Path) -> None:
    """`scene black` then `show bg` with nothing between: Ren'Py never
    shows the black, so no bare item does; a transition or a pause shows
    it."""
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    scene bg\n    "A."\n'
        '    scene black\n    show bg\n    "B."\n'
        '    scene black with dissolve\n    show bg\n    "C."\n'
        '    scene white\n    pause 1.0\n    show bg\n    "D."\n'
        '    return\n'))
    assert [(i["type"], i.get("text")) for i in manifest["items"]] == [
        ("image", "A."), ("image", "B."), ("image", None), ("image", "C."),
        ("image", None), ("image", "D.")]
    assert shown(out, manifest, ledger) == [
        "bg", "bg", "#000000", "bg", "#ffffff", "bg"]


def test_one_still_per_colour(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'image flash = "#ffffff"\n'
        'label start:\n'
        '    "Over black."\n'
        '    scene white\n    "A."\n'
        '    scene black\n    "B."\n'
        '    scene flash\n    "C."\n'
        '    return\n'))
    assert shown(out, manifest, ledger) == [
        "#000000", "#ffffff", "#000000", "#ffffff"]
    generated = sorted(e["source"]["generated"]
                       for e in ledger["media"].values()
                       if "generated" in e["source"])
    assert generated == ["#ffffff", "black"]
    assert len({i["file"] for i in manifest["items"]}) == 2


def test_a_coloured_still_rebuilds_from_the_ledger(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'image sky = Solid((40, 120, 200))\n'
        'label start:\n'
        '    scene bg\n    "A."\n'
        '    scene sky\n    "B."\n'
        '    return\n'))
    ref = manifest["items"][1]["file"]
    made = ledger["media"][ref]
    assert made["source"] == {"generated": "#2878c8"}
    assert [s["step"] for s in made["steps"]] == ["solid"]
    assert made["steps"][0]["rgb"] == [40, 120, 200]
    rebuilt = tmp_path / "rebuilt"
    with redirect_stdout(StringIO()) as said:
        assert media_main(["rebuild", str(tmp_path / "proj"), str(out),
                           "--out", str(rebuilt)]) == 0
    assert f"{len(ledger['media'])} matched, 0 failed" in said.getvalue()
    assert (rebuilt / ref).read_bytes() == (out / ref).read_bytes()
    (out / ref).write_bytes(b"not blue")
    with redirect_stdout(StringIO()):
        assert media_main(["rebuild", str(tmp_path / "proj"), str(out)]) == 1


# --------------------------------------------------------------------------
# A menu before any picture
# --------------------------------------------------------------------------

def test_a_menu_before_any_picture_hangs_off_black(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    menu:\n'
        '        "Left":\n'
        '            "Went left."\n'
        '        "Right":\n'
        '            scene bg\n'
        '            "Went right."\n'
        '    "Met again."\n'
        '    return\n'))
    assert texts(manifest) == [None, "Went left.", "Went right.",
                               "Met again."]
    assert shown(out, manifest, ledger)[:2] == ["#000000", "#000000"]
    (branch,) = manifest["branches"]
    assert branch["after"] == manifest["items"][0]["id"]
    assert not any("no item precedes" in r for r in reasons(ledger))
    check_folder(tmp_path, out, manifest)


# --------------------------------------------------------------------------
# A say statement's attributes: the exact image name first
# --------------------------------------------------------------------------

def test_say_attributes_try_the_exact_image_name_first(tmp_path: Path
                                                       ) -> None:
    out, manifest, ledger = run(tmp_path, (
        'define e = Character("Eve", image="eve")\n'
        'label start:\n'
        '    scene bg\n'
        '    show eve casual calm\n    e "Calm."\n'
        '    e happy "Happy."\n'
        '    e casual calm "Calm again."\n'
        '    e sad "Sad."\n'
        '    return\n'), {"images/eve casual calm.png": (10, 20, 30),
                          "images/eve casual happy.png": (200, 20, 30),
                          "images/eve happy.png": (10, 200, 30),
                          "images/eve casual sad.png": (10, 20, 200)})
    assert assets(manifest, ledger)[1:] == [
        "eve casual calm", "eve happy", "eve casual calm", "eve casual sad"]
    assert any("exact" in n for n in notes_of(manifest, ledger, "Happy."))


# --------------------------------------------------------------------------
# Together
# --------------------------------------------------------------------------

def test_item_9n3_forms_together_make_a_folder_that_plays(tmp_path: Path
                                                          ) -> None:
    out, manifest, ledger = run(tmp_path, (
        'define e = Character("Eve", image="eve")\n'
        'image flash = "#fff"\n'
        'image dim = Solid((0, 0, 0, 128))\n'
        'image sky = Solid("#28c")\n'
        'label start:\n'
        '    menu:\n'
        '        "Look up":\n'
        '            scene sky with dissolve\n'
        '            "The sky."\n'
        '        "Look down":\n'
        '            scene black\n'
        '            "The ground."\n'
        '    scene bg\n    show eve casual calm\n    e "Eve."\n'
        '    e happy "Happy."\n'
        '    show dim\n    "Dimmed."\n'
        '    scene flash with dissolve\n    "Flash."\n'
        '    scene #000\n    "Dark."\n'
        '    return\n'), {"images/eve casual calm.png": (10, 20, 30),
                          "images/eve casual happy.png": (200, 20, 30),
                          "images/eve happy.png": (10, 200, 30)})
    assert texts(manifest) == [None, "The sky.", "The ground.", None, "Eve.",
                               "Happy.", "Dimmed.", "Flash.", "Dark."]
    assert shown(out, manifest, ledger) == [
        "#000000", "#2288cc", "#000000", "bg", "eve casual calm",
        "eve happy", "eve happy", "#ffffff", "#000000"]
    assert len(manifest["branches"]) == 1
    check_folder(tmp_path, out, manifest)
