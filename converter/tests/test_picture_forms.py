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
"""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from kinetic_extract import rpa as rpa_mod
from kinetic_extract.parser import parse_file

from test_jump_menus import check_folder, extract, texts
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
        if item["type"] != "text":
            last = Path(entry["asset"]).stem
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
    assert assets(manifest, ledger) == ["bg", "bg"]
    assert any(r.startswith("solid color screen") for r in reasons(ledger))
    assert not any("unresolved" in r.lower() for r in reasons(ledger))


def test_a_file_named_as_a_solid_colour_image_shows_in_its_place(
        tmp_path: Path) -> None:
    """The converter ships no solid colour: a picture of the name (often
    a black file beside `image black = "#000"`) is the closer stand-in
    than the last picture."""
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


def test_a_line_with_no_picture_before_it_is_still_dropped(tmp_path: Path
                                                         ) -> None:
    out, manifest, ledger = run(tmp_path, (
        'label start:\n'
        '    scene nowhere\n    "A."\n'
        '    scene bg\n    "B."\n'
        '    return\n'))
    assert texts(manifest) == ["B."]
    assert any(r.startswith("droppedUnresolved") for r in reasons(ledger))


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
