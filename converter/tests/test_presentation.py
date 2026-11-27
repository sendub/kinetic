"""Ren'Py's presentation in a conversion (docs/plan.md Phase 57 item 4;
docs/extracting.md, "Colours and transitions").

Speaker colours come from a Character define's literal `color`,
`who_color` and `what_color` (inherited through a literal `kind=`) into
the manifest's `characters`; `with` clauses and statements give the
visual item they land on a `transition` for Ren'Py's `dissolve`, `fade`,
`Dissolve(t)`, `Fade(out, hold, in)` and names defined as those, and
every other transition is a cut, counted by name in the run summary and
the ledger. Text tags stay in the text as written.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from kinetic_extract.cli import main as cli_main
from kinetic_extract.parser import with_clause
from kinetic_extract.presentation import normalize_color, resolve_transition

REPO_ROOT = Path(__file__).resolve().parents[2]
TOOLS_DIR = REPO_ROOT / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))
import validate_content  # noqa: E402

IMAGES = ('image bg one = "one.png"\n'
          'image bg two = "two.png"\n'
          'image bg three = "three.png"\n')
COLOURS = {"one.png": "red", "two.png": "green", "three.png": "blue"}


def make_project(tmp: Path, script: str) -> Path:
    game = tmp / "proj" / "game"
    game.mkdir(parents=True)
    for name, colour in COLOURS.items():
        buf = BytesIO()
        Image.new("RGB", (32, 18), colour).save(buf, "PNG")
        (game / name).write_bytes(buf.getvalue())
    (game / "script.rpy").write_text(IMAGES + script, encoding="utf-8")
    return tmp / "proj"


def convert(tmp: Path, script: str,
            capsys: pytest.CaptureFixture[str] | None = None,
            setup: Callable[[Path], None] | None = None,
            ) -> tuple[dict, dict, str]:
    """(manifest, ledger, run summary) of the script, after checking
    that the folder validates; ``setup`` gets the game folder first."""
    out = tmp / "out"
    project = make_project(tmp, script)
    if setup is not None:
        setup(project / "game")
    assert cli_main([str(project), str(out)]) == 0
    printed = capsys.readouterr().out if capsys is not None else ""
    assert validate_content.validate_folder(out) == []
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    return manifest, ledger, printed


def reasons(ledger: dict) -> list[str]:
    return [r["reason"] for r in ledger["report"]]


def transitions(manifest: dict) -> list[dict | None]:
    """Each image item's transition (None for a cut), in order."""
    return [item.get("transition") for item in manifest["items"]
            if item["type"] == "image"]


# --- speaker colours -------------------------------------------------------

@pytest.mark.parametrize("written, expected", [
    ("#abc", "#aabbcc"),
    ("#ABCDEF", "#abcdef"),
    ("#11223344", "#112233"),
    ("#abcd", "#aabbcc"),
    ("abcdef", "#abcdef"),
    ("#ab", None),
    ("red", None),
    ("#abcdeg", None),
])
def test_color_forms_normalise(written: str, expected: str | None) -> None:
    assert normalize_color(written) == expected


def test_character_colours_reach_the_manifest(tmp_path: Path) -> None:
    script = (
        'define a = Character("Ana", color="#C8F")\n'
        'define b = Character("Bo", who_color="#11223344", '
        'what_color=\'#ABCDEF\')\n'
        'define c = Character("Cy", color="#ff0000", who_color="#00ff00")\n'
        'define d = Character("Di")\n'
        'define u = Character("Unused", color="#123456")\n'
        'label start:\n'
        '    scene bg one\n'
        '    a "One."\n'
        '    b "Two."\n'
        '    c "Three."\n'
        '    d "Four."\n'
        '    "Narration."\n')
    manifest, _ledger, _out = convert(tmp_path, script)
    assert manifest["characters"] == {
        "Ana": {"nameColor": "#cc88ff"},
        "Bo": {"nameColor": "#112233", "textColor": "#abcdef"},
        # who_color wins over color.
        "Cy": {"nameColor": "#00ff00"},
    }


def test_character_call_over_several_lines(tmp_path: Path) -> None:
    script = (
        'define a = Character(\n'
        '    "Ana",\n'
        '    what_color="#eeeeee",\n'
        '    color="#222",\n'
        ')\n'
        'label start:\n'
        '    scene bg one\n'
        '    a "One."\n')
    manifest, _ledger, _out = convert(tmp_path, script)
    assert manifest["characters"] == {
        "Ana": {"nameColor": "#222222", "textColor": "#eeeeee"}}


def test_kind_inherits_colours_under_its_own(tmp_path: Path) -> None:
    script = (
        'define base = Character("Base", color="#111111", '
        'what_color="#eeeeee")\n'
        'define kid = Character("Kid", kind=base, what_color="#dddddd")\n'
        'define nv = Character("Nv", kind=nvl)\n'
        'define nv2 = Character("Nv2", kind=nvl, color="#333333")\n'
        'label start:\n'
        '    scene bg one\n'
        '    kid "One."\n'
        '    nv "Two."\n'
        '    nv2 "Three."\n')
    manifest, _ledger, _out = convert(tmp_path, script)
    assert manifest["characters"] == {
        "Kid": {"nameColor": "#111111", "textColor": "#dddddd"},
        "Nv2": {"nameColor": "#333333"},
    }


def test_expression_colour_is_ignored_and_reported(tmp_path: Path) -> None:
    script = (
        'define a = Character("Ana", color=gui.accent_color, '
        'what_color="#eeeeee")\n'
        'define b = Character("Bo", color="#" + hexpart)\n'
        'label start:\n'
        '    scene bg one\n'
        '    a "One."\n'
        '    b "Two."\n')
    manifest, ledger, _out = convert(tmp_path, script)
    assert manifest["characters"] == {"Ana": {"textColor": "#eeeeee"}}
    assert sum("is not a literal colour" in r for r in reasons(ledger)) == 2


def test_same_name_other_colours_first_wins(tmp_path: Path) -> None:
    script = (
        'define a1 = Character("Ana", color="#111111")\n'
        'define a2 = Character("Ana", color="#222222")\n'
        'label start:\n'
        '    scene bg one\n'
        '    a2 "One."\n'
        '    a1 "Two."\n')
    manifest, ledger, _out = convert(tmp_path, script)
    assert manifest["characters"] == {"Ana": {"nameColor": "#111111"}}
    assert any("speaker 'Ana' has other colours" in r
               for r in reasons(ledger))


def test_no_colours_no_characters_table(tmp_path: Path) -> None:
    script = ('define a = Character("Ana")\n'
              'label start:\n    scene bg one\n    a "One."\n')
    manifest, _ledger, _out = convert(tmp_path, script)
    assert "characters" not in manifest


def test_text_tags_stay_as_written(tmp_path: Path) -> None:
    script = ('label start:\n'
              '    scene bg one\n'
              '    "I {i}really{/i} {b}mean{/b} it {{not a tag}.{w} Go."\n')
    manifest, _ledger, _out = convert(tmp_path, script)
    assert manifest["items"][0]["text"] == \
        "I {i}really{/i} {b}mean{/b} it {{not a tag}.{w} Go."


# --- transitions -----------------------------------------------------------

def test_clause_and_bare_with_give_the_next_item(tmp_path: Path) -> None:
    script = ('label start:\n'
              '    scene bg one with dissolve\n'
              '    "One."\n'
              '    scene bg two\n'
              '    with fade\n'
              '    "Two."\n'
              '    show bg three with dissolve\n'
              '    "Three."\n')
    manifest, _ledger, _out = convert(tmp_path, script)
    assert transitions(manifest) == [
        {"kind": "dissolve", "seconds": 0.5},
        {"kind": "fade", "out": 0.5, "hold": 0.0, "in": 0.5},
        {"kind": "dissolve", "seconds": 0.5},
    ]


def test_calls_and_aliases(tmp_path: Path) -> None:
    script = ('define slow = Dissolve(2.0)\n'
              'define flash = Fade(.1, 0.0, .5, color="#000")\n'
              'define again = slow\n'
              'label start:\n'
              '    scene bg one with Dissolve(1.5, alpha=True)\n'
              '    "One."\n'
              '    scene bg two with Fade(0.25, 1, 0.75)\n'
              '    "Two."\n'
              '    scene bg three\n'
              '    with slow\n'
              '    "Three."\n'
              '    scene bg one with flash\n'
              '    "Four."\n'
              '    scene bg two with again\n'
              '    "Five."\n')
    manifest, _ledger, _out = convert(tmp_path, script)
    assert transitions(manifest) == [
        {"kind": "dissolve", "seconds": 1.5},
        {"kind": "fade", "out": 0.25, "hold": 1.0, "in": 0.75},
        {"kind": "dissolve", "seconds": 2.0},
        {"kind": "fade", "out": 0.1, "hold": 0.0, "in": 0.5},
        {"kind": "dissolve", "seconds": 2.0},
    ]


def test_a_define_overrides_the_builtin(tmp_path: Path) -> None:
    script = ('define dissolve = Dissolve(1.0)\n'
              'label start:\n'
              '    scene bg one with dissolve\n'
              '    "One."\n')
    manifest, _ledger, _out = convert(tmp_path, script)
    assert transitions(manifest) == [{"kind": "dissolve", "seconds": 1.0}]


def test_out_of_range_times_are_clamped_and_reported(tmp_path: Path) -> None:
    script = ('label start:\n'
              '    scene bg one with Dissolve(8)\n'
              '    "One."\n'
              '    scene bg two with Fade(6, 0, 1)\n'
              '    "Two."\n'
              '    scene bg three with Dissolve(8)\n'
              '    "Three."\n')
    manifest, ledger, _out = convert(tmp_path, script)
    assert transitions(manifest) == [
        {"kind": "dissolve", "seconds": 5.0},
        {"kind": "fade", "out": 5.0, "hold": 0.0, "in": 1.0},
        {"kind": "dissolve", "seconds": 5.0},
    ]
    clamped = [r for r in ledger["report"] if "clamped" in r["reason"]]
    assert [(r["statement"], r["reason"]) for r in clamped] == [
        ("with Dissolve(8)", "transition: Dissolve time 8 s clamped to 5 s "
                             "(2 uses; this is the first)"),
        ("with Fade(6, 0, 1)", "transition: Fade out 6 s clamped to 5 s "
                               "(1 use; this is the first)"),
    ]


def test_non_black_fade_kept_and_reported(tmp_path: Path) -> None:
    script = ('define flash = Fade(0.1, 0.0, 0.5, color="#fff")\n'
              'label start:\n'
              '    scene bg one with flash\n'
              '    "One."\n')
    manifest, ledger, _out = convert(tmp_path, script)
    assert transitions(manifest) == [
        {"kind": "fade", "out": 0.1, "hold": 0.0, "in": 0.5}]
    assert any("colour #ffffff drawn as black" in r for r in reasons(ledger))


def test_none_and_unsupported_are_cuts_counted_by_name(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    script = ('define shake = ImageDissolve("wipe.png", 1.0)\n'
              'label start:\n'
              '    scene bg one with pixellate\n'
              '    "One."\n'
              '    with hpunch\n'
              '    scene bg two\n'
              '    with None\n'
              '    "Two."\n'
              '    scene bg three with shake\n'
              '    "Three."\n'
              '    with hpunch\n'
              '    scene bg one with Pixellate(1.0, 5)\n'
              '    "Four."\n')
    manifest, ledger, printed = convert(tmp_path, script, capsys)
    assert transitions(manifest) == [None, None, None, None]
    assert ledger["transitions"] == {
        "kept": {}, "noPictureChange": 0,
        "cut": {"None": 1, "Pixellate": 1, "hpunch": 2, "pixellate": 1,
                "shake": 1}}
    assert ("transitions: kept none; with no picture change 0; cut: "
            "hpunch x2, None x1, Pixellate x1, pixellate x1, shake x1"
            in printed)


def test_with_after_no_picture_change_gives_nothing(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    script = ('label start:\n'
              '    scene bg one\n'
              '    "One."\n'
              '    play sound "nothing.ogg"\n'
              '    with dissolve\n'
              '    "Two."\n'
              '    hide bg with fade\n'
              '    "Three."\n'
              '    scene bg two with dissolve\n'
              '    with fade\n'
              '    "Four."\n'
              '    scene bg three\n'
              '    pause\n'
              '    with dissolve\n'
              '    "Five."\n')
    manifest, ledger, printed = convert(tmp_path, script, capsys)
    assert transitions(manifest) == [
        None, {"kind": "dissolve", "seconds": 0.5}, None]
    assert ledger["transitions"]["kept"] == {"dissolve": 1}
    assert ledger["transitions"]["noPictureChange"] == 4
    assert "transitions: kept dissolve 1; with no picture change 4" in printed


def test_several_scenes_the_last_takes_the_with(tmp_path: Path) -> None:
    script = ('label start:\n'
              '    scene bg one\n'
              '    show bg two\n'
              '    with dissolve\n'
              '    "One."\n')
    manifest, _ledger, _out = convert(tmp_path, script)
    # bg one is emitted bare, as the walk always has; the with lands on
    # the visual it settles, bg two.
    assert transitions(manifest) == [
        None, {"kind": "dissolve", "seconds": 0.5}]


def test_with_inside_a_menu_choice(tmp_path: Path) -> None:
    script = ('label start:\n'
              '    scene bg one\n'
              '    "Pick."\n'
              '    menu:\n'
              '        "Left":\n'
              '            scene bg two with dissolve\n'
              '            "Left."\n'
              '        "Right":\n'
              '            scene bg three\n'
              '            with fade\n'
              '            "Right."\n'
              '    "After."\n')
    manifest, _ledger, _out = convert(tmp_path, script)
    assert manifest.get("branches")
    assert transitions(manifest) == [
        None, {"kind": "dissolve", "seconds": 0.5},
        {"kind": "fade", "out": 0.5, "hold": 0.0, "in": 0.5}]


@pytest.mark.parametrize("expr, kind, cut", [
    ("dissolve", "dissolve", None),
    ("Dissolve(time=0.3)", "dissolve", None),
    ("Fade(out_time=1, hold_time=0, in_time=1)", "fade", None),
    ("Dissolve(0)", None, "Dissolve(0)"),
    ("Dissolve(t)", None, "Dissolve"),
    ("Fade(0, 1, 0)", None, "Fade(0, 1, 0)"),
    ("Fade(0.5, 0.5)", None, "Fade"),
    ("Dissolve(0.5) + x", None, "Dissolve"),
    ("{'master': dissolve}", None, "{'master': dissolve}"),
    ("None", None, "None"),
])
def test_resolve_transition_forms(expr: str, kind: str | None,
                                  cut: str | None) -> None:
    got = resolve_transition(expr, {})
    assert (got.transition or {}).get("kind") == kind
    assert got.cut == cut


@pytest.mark.parametrize("rest, expr", [
    ("bg one with dissolve", "dissolve"),
    ('text "with you" with dissolve', "dissolve"),
    ('x at left with Fade(1, 0, 1, color="#fff")',
     'Fade(1, 0, 1, color="#fff")'),
    ("eileen happy with dissolve:", "dissolve"),
    ("bg one", None),
    ("withered tree", None),
])
def test_with_clause(rest: str, expr: str | None) -> None:
    assert with_clause(rest) == expr


def test_defines_with_an_init_priority(tmp_path: Path) -> None:
    script = ('define -2 short = Dissolve(0.4)\n'
              'define 1 a = Character("Ana", color="#fff")\n'
              'label start:\n'
              '    scene bg one with short\n'
              '    a "One."\n')
    manifest, _ledger, _out = convert(tmp_path, script)
    assert transitions(manifest) == [{"kind": "dissolve", "seconds": 0.4}]
    assert manifest["characters"] == {"Ana": {"nameColor": "#ffffff"}}


# --- old-style characters (Phase 57 item 4c) --------------------------------

def test_characters_from_init_blocks_and_dollar_lines(tmp_path: Path) -> None:
    script = ('init:\n'
              '    $ a = Character("Ana", color="#aa0000")\n'
              'init python:\n'
              '    b = Character(\n'
              '        "Bo",\n'
              '        what_color="#00bb00")\n'
              '    c = NVLCharacter("Cy")\n'
              'label start:\n'
              '    $ d = Character("Di", who_color="#0000dd")\n'
              '    scene bg one\n'
              '    a "One."\n'
              '    b "Two."\n'
              '    c "Three."\n'
              '    d "Four."\n')
    manifest, ledger, _out = convert(tmp_path, script)
    assert [item["speaker"] for item in manifest["items"]] == [
        "Ana", "Bo", "Cy", "Di"]
    assert manifest["characters"] == {
        "Ana": {"nameColor": "#aa0000"},
        "Bo": {"textColor": "#00bb00"},
        "Di": {"nameColor": "#0000dd"},
    }
    # The Character call over several lines made no statements.
    assert not any("unrecognized" in r for r in reasons(ledger))


def test_a_nameless_character_takes_its_kinds_name(tmp_path: Path) -> None:
    script = ('define a = Character("Ana", color="#aa0000")\n'
              'define a_shout = Character(kind=a, what_color="#ffffff")\n'
              'define a_again = Character(kind=a_shout)\n'
              'define z = Character(kind=nvl)\n'
              'label start:\n'
              '    scene bg one\n'
              '    a_shout "One."\n'
              '    a_again "Two."\n'
              '    z "Three."\n')
    manifest, _ledger, _out = convert(tmp_path, script)
    # Ren'Py's `nvl` kind has no name, so z's line is narration
    # (docs/plan.md Phase 60 item 9m2).
    assert [item.get("speaker") for item in manifest["items"]] == [
        "Ana", "Ana", None]
    # Both nameless characters show "Ana"; the first defined with a
    # colour (a_shout, inheriting a's name colour) wins.
    assert manifest["characters"] == {
        "Ana": {"nameColor": "#aa0000", "textColor": "#ffffff"}}


# --- file names under images/ (Phase 57 item 4d) ----------------------------

def test_defined_file_is_found_under_images(tmp_path: Path) -> None:
    """Ren'Py looks a file name up under game/ and then game/images/
    (`config.search_prefixes`), so a define naming `day1/x.png` plays
    `game/images/day1/x.png`, even when the image name differs from the
    file's."""
    script = ('image first = "day1/%_first shot (v2).png"\n'
              'label start:\n'
              '    scene first with dissolve\n'
              '    "One."\n')
    def setup(game: Path) -> None:
        shot = game / "images" / "day1" / "%_first shot (v2).png"
        shot.parent.mkdir(parents=True)
        shot.write_bytes((game / "one.png").read_bytes())

    manifest, ledger, _out = convert(tmp_path, script, setup=setup)
    assert [item["type"] for item in manifest["items"]] == ["image"]
    assert transitions(manifest) == [{"kind": "dissolve", "seconds": 0.5}]
    entry = ledger["items"][manifest["items"][0]["id"]]
    assert entry["asset"] == "game/images/day1/%_first shot (v2).png"
    assert not any(r.startswith("droppedUnresolved") for r in reasons(ledger))


def test_renpy_automatic_names_for_the_images_folder(tmp_path: Path) -> None:
    """A file under images/ is named by its lowercased file name, its
    directories dropped, as Ren'Py's images directory rule names it."""
    script = ('label start:\n'
              '    scene intro_shot_3\n'
              '    "One."\n'
              '    show screen hud\n'
              '    scene bg big sky\n'
              '    "Two."\n')

    def setup(game: Path) -> None:
        (game / "images" / "Intro").mkdir(parents=True)
        (game / "images" / "Intro" / "Intro_Shot_3.png").write_bytes(
            (game / "one.png").read_bytes())
        (game / "images" / "BG Big  Sky.png").write_bytes(
            (game / "two.png").read_bytes())

    manifest, ledger, _out = convert(tmp_path, script, setup=setup)
    assets = [ledger["items"][item["id"]]["asset"]
              for item in manifest["items"]]
    assert assets == ["game/images/Intro/Intro_Shot_3.png",
                      "game/images/BG Big  Sky.png"]
    assert not any(r.startswith("droppedUnresolved") for r in reasons(ledger))
    assert any(r.startswith("show screen") for r in reasons(ledger))
