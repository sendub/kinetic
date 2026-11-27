"""The walk follows labels (docs/plan.md Phase 57 item 4e).

Ren'Py runs a game from `label start` through `jump`, `call` (back after
the call at `return`) and the fall-through into the next statement after a
label's block; the converter reads the story the same way instead of
joining the scripts in file-name order. Synthetic projects: a story order
unlike the file order, a call and return, a call used twice, fall-through,
an unreached developer label and script, a `jump expression`, nested menus
with jumps, an `if` with jumps; then the CLI's ledger and summary.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from kinetic_extract import rpa as rpa_mod
from kinetic_extract.cli import main as cli_main
from kinetic_extract.parser import parse_file, parse_project
from kinetic_extract.timeline import build_timeline

REPO_ROOT = Path(__file__).resolve().parents[2]
DEMO_IMAGE = REPO_ROOT / "fixtures" / "renpy_demo" / "game" / "data" \
    / "bg-room.png"


def project(tmp_path: Path, files: dict[str, str]) -> Path:
    rpa_mod.reset_cache()
    game = tmp_path / "game"
    for name, text in files.items():
        path = game / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return game


def walk(game: Path, label: str | None = None, **options):
    parses, defs, chars, _sources = parse_project(game)
    return build_timeline(parses, defs, chars, game, start_label=label,
                          **options), parses


def texts(result) -> list[str]:
    return [r.item.get("text") for r in result.items]


def reasons(parses) -> list[str]:
    return [r.reason for _rel, p in parses for r in p.reports]


def test_story_order_unlike_file_order(tmp_path: Path) -> None:
    """script.rpy jumps into b02.rpy, which jumps into a01.rpy: file-name
    order would read a01, b02, script."""
    game = project(tmp_path, {
        "a01.rpy": 'label third:\n    "Third."\n    return\n',
        "b02.rpy": 'label second:\n    "Second."\n    jump third\n',
        "script.rpy": 'label start:\n    "First."\n    jump second\n',
    })
    result, _parses = walk(game)
    assert texts(result) == ["First.", "Second.", "Third."]
    assert result.walk["start"] == "label start"
    assert result.walk["labelsReached"] == 3
    assert result.walk["labelsUnreached"] == []


def test_call_returns_after_the_call(tmp_path: Path) -> None:
    game = project(tmp_path, {"script.rpy": (
        'label start:\n    "One."\n    call sub\n    "Three."\n    return\n'
        'label sub:\n    "Two."\n    return\n')})
    result, _parses = walk(game)
    assert texts(result) == ["One.", "Two.", "Three."]


def test_call_with_arguments_and_from_clause(tmp_path: Path) -> None:
    game = project(tmp_path, {"script.rpy": (
        'label start:\n    "One."\n    call sub(2) from _call_sub_1\n'
        '    "Three."\n    return\n'
        'label sub(n=1):\n    "Two."\n    return\n')})
    result, _parses = walk(game)
    assert texts(result) == ["One.", "Two.", "Three."]


def test_call_used_twice_is_walked_once(tmp_path: Path) -> None:
    """A called label reached again is not repeated (each statement is one
    item); the walk goes on after the second call, and counts it."""
    game = project(tmp_path, {"script.rpy": (
        'label start:\n    "One."\n    call sub\n    "Three."\n'
        '    call sub\n    "Four."\n    return\n'
        'label sub:\n    "Two."\n    return\n')})
    result, _parses = walk(game)
    assert texts(result) == ["One.", "Two.", "Three.", "Four."]
    assert result.walk["callsNotRepeated"] == [
        {"source": "game/script.rpy:5", "statement": "call sub"}]


def test_fall_through_between_labels(tmp_path: Path) -> None:
    """A label's block runs on into the next label of the same file."""
    game = project(tmp_path, {
        "script.rpy": ('label start:\n    "One."\n'
                       'label next:\n    "Two."\n    jump other\n'),
        "other.rpy": 'label other:\n    "Three."\n'
                     'label after_other:\n    "Four."\n',
    })
    result, _parses = walk(game)
    assert texts(result) == ["One.", "Two.", "Three.", "Four."]
    assert result.walk["labelsReached"] == 4


def test_unreached_developer_label_and_script(tmp_path: Path) -> None:
    """A developer script's label and a label after the story's return are
    never reached: their lines are not items, the walk lists them, and
    their statements' reports are left out; the developer script's
    Character define still names its speaker."""
    game = project(tmp_path, {
        "dev.rpy": ('define d = Character("Dev")\n'
                    'label dev_room:\n    "Debug line."\n'
                    '    imgfl 1\n    "Another debug line."\n'),
        "script.rpy": ('label start:\n    d "Story line."\n    return\n'
                       'label unused:\n    "Never shown."\n'),
    })
    result, parses = walk(game)
    assert texts(result) == ["Story line."]
    assert result.items[0].item["speaker"] == "Dev"
    assert result.walk["labelsUnreached"] == [
        {"label": "dev_room", "source": "game/dev.rpy:2", "lines": 2},
        {"label": "unused", "source": "game/script.rpy:4", "lines": 1}]
    assert result.walk["scriptsUnreached"] == ["game/dev.rpy"]
    assert result.walk["linesUnreached"] == 3
    assert result.walk["reportsUnreached"] == 1
    assert not any("imgfl" in r for r in reasons(parses))
    assert any("dev_room" in line and "unused" in line
               for line in result.walk_summary)


def test_jump_expression_is_reported_not_followed(tmp_path: Path) -> None:
    game = project(tmp_path, {"script.rpy": (
        'label start:\n    "One."\n    jump expression "x" + str(n)\n'
        'label x1:\n    "Not reached."\n')})
    result, parses = walk(game)
    assert texts(result) == ["One."]
    reason = ("jump expression: the target is computed when the game "
              "runs; not followed")
    assert reason in reasons(parses)
    assert result.walk["notFollowed"] == [{
        "source": "game/script.rpy:3",
        "statement": 'jump expression "x" + str(n)', "reason": reason}]
    assert [u["label"] for u in result.walk["labelsUnreached"]] == ["x1"]


def test_call_expression_walks_labels_named_in_code(tmp_path: Path) -> None:
    """A computed call walks, as calls returning to it, the labels named by
    string literals in the game's code, in file order, leaving out those
    literal flow reaches anyway and Ren'Py's entry labels; dialogue text
    names nothing."""
    game = project(tmp_path, {
        "events.rpy": ('define pool = ["scene_b", "scene_a", "later",'
                       ' "splashscreen"]\n'
                       'label scene_a:\n    "A."\n    return\n'
                       'label scene_b:\n    "B."\n    return\n'
                       'label splashscreen:\n    "Logo."\n    return\n'
                       'label quiet:\n    "Never named."\n    return\n'),
        "script.rpy": ('label start:\n    "One."\n'
                       '    $ pick = renpy.random.choice(pool)\n'
                       '    call expression pick\n    "Two."\n'
                       '    "quiet"\n    jump later\n'
                       'label later:\n    "Three."\n    return\n'),
    })
    result, parses = walk(game)
    assert texts(result) == ["One.", "A.", "B.", "Two.", "quiet", "Three."]
    assert result.walk["dynamic"] == [{
        "source": "game/script.rpy:4", "statement": "call expression pick",
        "candidates": 2, "own": 2, "walked": 2}]
    assert ("call expression: the target is computed when the game runs; "
            "walked 2 of 2 candidate labels named in the game's code"
            ) in reasons(parses)
    assert [u["label"] for u in result.walk["labelsUnreached"]] == [
        "splashscreen", "quiet"]
    assert result.walk["entryLabelsUnreached"] == ["splashscreen"]
    assert any("entry labels not walked: splashscreen" in line
               for line in result.walk_summary)


def test_each_site_reads_the_labels_tied_to_it(tmp_path: Path) -> None:
    """Two computed calls, each with its own labels: one picks a scene
    through a helper function whose body names the scenes, the other from
    a literal list defined elsewhere. The first site the walk reaches no
    longer takes them all; a label tied to no site goes to the nearest
    site in its file, and one in a file with no site to the first site
    reached."""
    game = project(tmp_path, {
        "functions.rpy": (
            'init python:\n'
            '    def pick_night(level):\n'
            '        scenes = ["night_1", "night_2"]\n'
            '        return scenes[level]\n'
            'define gallery_list = [\n    {"id": 1,\n'
            '     "label": "gallery_1"},\n]\n'
            'define spare = "loose_scene"\n'),
        "scenes.rpy": (
            'label gallery_1:\n    "Gallery one."\n    return\n'
            'label night_1:\n    "Night one."\n    return\n'
            'label night_2:\n    "Night two."\n    return\n'
            'label loose_scene:\n    "Loose."\n    return\n'),
        "script.rpy": (
            'label start:\n    "Day."\n    call gallery\n'
            '    call night\n    "End."\n    return\n'
            'label gallery:\n'
            '    $ replay = renpy.random.choice(gallery_list)\n'
            '    call expression replay\n    return\n'
            'label night:\n    $ scene = pick_night(0)\n'
            '    call expression scene from _call_night\n    return\n'),
    })
    result, _parses = walk(game)
    assert texts(result) == ["Day.", "Gallery one.", "Loose.", "Night one.",
                             "Night two.", "End."]
    assert [(d["statement"], d["own"], d["candidates"], d["walked"])
            for d in result.walk["dynamic"]] == [
        ("call expression replay", 1, 2, 2),
        ("call expression scene from _call_night", 2, 3, 2)]


def test_untied_label_goes_to_nearest_site_in_its_file(
        tmp_path: Path) -> None:
    game = project(tmp_path, {
        "a.rpy": ('define names = ["a_scene", "b_scene"]\n'
                  'label first_site:\n    call expression x\n    return\n'
                  'label a_scene:\n    "A."\n    return\n'),
        "b.rpy": ('label second_site:\n    call expression y\n'
                  '    return\n'
                  'label b_scene:\n    "B."\n    return\n'),
        "script.rpy": ('label start:\n    call first_site\n'
                       '    "Middle."\n    call second_site\n'
                       '    return\n'),
    })
    result, _parses = walk(game)
    assert texts(result) == ["A.", "Middle.", "B."]


def test_label_of_an_unreached_site_goes_to_the_first(
        tmp_path: Path) -> None:
    """A label tied only to a site the walk never reaches is read at the
    first site it does reach."""
    game = project(tmp_path, {"script.rpy": (
        'define names = ["lost", "found"]\n'
        'label start:\n    $ t = "found"\n    call expression t\n'
        '    "End."\n    return\n'
        'label never:\n    $ u = "lost"\n    call expression u\n'
        '    return\n'
        'label found:\n    "Found."\n    return\n'
        'label lost:\n    "Lost."\n    return\n')})
    result, _parses = walk(game)
    assert texts(result) == ["Found.", "Lost.", "End."]


def test_own_literal_list_comes_first_and_jump_ends(tmp_path: Path) -> None:
    """An expression's own literals are its first candidates; a computed
    jump reads its candidates one after another and its path ends there."""
    game = project(tmp_path, {"script.rpy": (
        'define other = "c_label"\n'
        'label start:\n    "One."\n'
        '    jump expression renpy.random.choice(["b_label", "a_label"])\n'
        '    "Dead code."\n'
        'label a_label:\n    "A."\n    jump end\n'
        'label b_label:\n    "B."\n    jump end\n'
        'label c_label:\n    "C."\n    jump end\n'
        'label end:\n    "End."\n')})
    result, _parses = walk(game)
    assert texts(result) == ["One.", "B.", "End.", "A.", "C."]
    assert result.walk["dynamic"][0]["walked"] == 3


def test_also_label_and_include_unreached(tmp_path: Path) -> None:
    game = project(tmp_path, {
        "dev.rpy": ('label dev_b:\n    "Dev B."\n    return\n'
                    'label empty:\n    $ x = 1\n    return\n'
                    'label dev_a:\n    "Dev A."\n    jump dev_b\n'),
        "script.rpy": ('label splashscreen:\n    "Logo."\n    return\n'
                       'label start:\n    "Story."\n    return\n'),
    })
    result, _parses = walk(game, also_labels=["splashscreen"],
                           include_unreached=True)
    assert texts(result) == ["Story.", "Logo.", "Dev B.", "Dev A."]
    assert result.walk["alsoLabels"] == ["splashscreen"]
    assert result.walk["appendedUnreached"] == [
        {"label": "dev_b", "source": "game/dev.rpy:1", "lines": 1},
        {"label": "dev_a", "source": "game/dev.rpy:7", "lines": 1}]
    assert [u["label"] for u in result.walk["labelsUnreached"]] == ["empty"]
    with pytest.raises(SystemExit):
        walk(game, also_labels=["nowhere"])


def test_unknown_target_and_call_screen(tmp_path: Path) -> None:
    game = project(tmp_path, {"script.rpy": (
        'label start:\n    "One."\n    call screen map\n    call nowhere\n'
        '    "Two."\n')})
    result, parses = walk(game)
    assert texts(result) == ["One.", "Two."]
    found = reasons(parses)
    assert ("call screen: a screen, not converted; the walk goes on after "
            "it") in found
    assert ("call target 'nowhere' is not a label of the walked scripts; "
            "not followed") in found


def test_nested_menus_with_jumps_rejoin(tmp_path: Path) -> None:
    """The walk reads each choice's path in turn up to the scene they all
    reach, then that scene once; menus whose choices jump are decisions
    (Phase 60 item 4), the nested one inside the outer one's route, and
    so is the plain menu after them. The Right route opens with the
    nested menu, so its choice text is its first line, which the nested
    decision hangs off (item 8c)."""
    game = project(tmp_path, {
        "a.rpy": ('label down:\n    "Down path."\n    jump joined\n'
                  'label joined:\n    "Together again."\n'
                  '    menu:\n        "Stay":\n            "Stayed."\n'
                  '        "Go":\n            "Went."\n'
                  '    "The end."\n'),
        "script.rpy": ('label start:\n    "Lead."\n'
                       '    menu:\n        "Left":\n            jump left\n'
                       '        "Right":\n            menu:\n'
                       '                "Up":\n                    jump up\n'
                       '                "Down":\n'
                       '                    jump down\n'
                       'label left:\n    "Left path."\n    jump joined\n'
                       'label up:\n    "Up path."\n    jump joined\n'),
    })
    result, parses = walk(game)
    assert texts(result) == [
        "Lead.", "Left path.", "Right", "Up path.", "Down path.",
        "Together again.", "Stayed.", "Went.", "The end."]
    assert not any("menu unsupported" in r for r in reasons(parses))
    assert [c["record"].choices for c in result.branch_candidates] == [
        ["Up", "Down"], ["Left", "Right"], ["Stay", "Go"]]
    inner, outer, _plain = result.branch_candidates
    assert inner["after_idx"] == 2
    assert outer["route_spans"][1] == ("Right", 2, 4)
    # Left, up and down each jump to where the paths meet.
    assert result.walk["rejoins"] == 3


def test_if_chain_jumps_are_followed(tmp_path: Path) -> None:
    """An `if` chain's blocks stay skipped, but their jumps are followed,
    each in turn, then the label both reach; an `if` with no `else` also
    goes on past it."""
    game = project(tmp_path, {"script.rpy": (
        'label start:\n    "One."\n'
        '    if flag:\n        "Skipped as before."\n        jump yes\n'
        '    elif other:\n        call side\n'
        '    else:\n        jump no\n'
        '    "After the if."\n    jump done\n'
        'label yes:\n    "Yes."\n    jump done\n'
        'label no:\n    "No."\n    jump done\n'
        'label side:\n    "Side."\n    return\n'
        'label done:\n    "Done."\n'
        '    if extra:\n        jump bonus\n'
        '    "Last."\n    return\n'
        'label bonus:\n    "Bonus."\n    return\n')})
    result, _parses = walk(game)
    assert texts(result) == ["One.", "Yes.", "Side.", "After the if.", "No.",
                             "Done.", "Bonus.", "Last."]
    assert result.walk["labelsUnreached"] == []


def test_local_labels_and_python_jump(tmp_path: Path) -> None:
    game = project(tmp_path, {"script.rpy": (
        'label start:\n    "One."\n    jump .inner\n'
        '    "Dead code."\n'
        'label .inner:\n    "Two."\n    $ renpy.jump("later")\n'
        'label later:\n    "Three."\n    $ renpy.call(\'sub\')\n'
        '    "Five."\n    return\n'
        'label sub:\n    "Four."\n    return\n')})
    result, _parses = walk(game)
    assert texts(result) == ["One.", "Two.", "Three.", "Four.", "Five."]


def test_loop_back_ends_the_path(tmp_path: Path) -> None:
    game = project(tmp_path, {"script.rpy": (
        'label start:\n    "One."\nlabel again:\n    "Two."\n'
        '    menu:\n        "Again":\n            jump again\n'
        '        "Stop":\n            jump stop\n'
        'label stop:\n    "Three."\n')})
    result, _parses = walk(game)
    assert texts(result) == ["One.", "Two.", "Three."]
    # The jump back to a label walked, and Stop's jump to where the
    # choices meet (past Stop's own block, Phase 60 item 4).
    assert result.walk["rejoins"] == 2


def test_label_inside_a_menu_block_and_named_menu(tmp_path: Path) -> None:
    """A jump can land on a label inside a menu's choice block (the rest
    of that block's jumps run from there) or on a named menu."""
    game = project(tmp_path, {"script.rpy": (
        'label start:\n    "One."\n'
        '    if quick:\n        jump inner\n'
        '    menu:\n        "Stay":\n            label inner:\n'
        '                $ x = 1\n            "Skipped as before."\n'
        '            jump two\n'
        '        "Go":\n            jump two\n'
        'label two:\n    "Two."\n    jump ask\n'
        'label side:\n    "Side."\n    return\n'
        'label tail:\n    "Three."\n    menu ask:\n'
        '        "Again":\n            call side\n'
        '        "Done":\n            "Done."\n'
        '    "End."\n')})
    result, parses = walk(game)
    # The named menu is a decision (Phase 60 item 4): Done's line is its
    # route. The first menu's choice block is read as Ren'Py flows
    # through its label (item 9o): the `if`'s jump reads it first, so the
    # menu, whose Stay choice rejoins it, stays linear.
    assert texts(result) == ["One.", "Skipped as before.", "Two.", "Side.",
                             "Done.", "End."]
    assert not any("not a label" in r for r in reasons(parses))
    assert [u["label"] for u in result.walk["labelsUnreached"]] == ["tail"]


def test_screen_jump_actions_are_followed(tmp_path: Path) -> None:
    """A hub shown with `show screen` (or `call screen`) whose buttons
    `Jump` reads each place they lead, in the screen's order, the
    screens it `use`s too, then goes on past it."""
    game = project(tmp_path, {
        "screens.rpy": ('screen hub():\n'
                        '    textbutton "A" action Jump("room_a")\n'
                        '    imagebutton auto "b_%s" action [SetVariable('
                        '"v", 1), Jump(\'room_b\')]\n'
                        '    use extra_buttons\n'
                        'screen extra_buttons():\n'
                        '    textbutton "C" action Call("room_c")\n'),
        "script.rpy": ('label start:\n    "One."\n    show screen hub\n'
                       '    $ renpy.pause(hard=True)\n'
                       'label room_a:\n    "Room A."\n    jump after\n'
                       'label room_b:\n    "Room B."\n    jump after\n'
                       'label room_c:\n    "Room C."\n    return\n'
                       'label after:\n    "After."\n'),
    })
    result, _parses = walk(game)
    assert texts(result) == ["One.", "Room A.", "Room B.", "Room C.",
                             "After."]
    assert result.walk["labelsUnreached"] == []


def test_image_atl_block_is_not_dialogue(tmp_path: Path) -> None:
    parsed = parse_file('label start:\n    image blink:\n        "eye_a"\n'
                        '        0.5\n        "eye_b"\n        repeat\n'
                        '    "A real line."\n', "game/x.rpy")
    assert [e.text for e in parsed.events if e.kind == "dialogue"] == [
        "A real line."]


def test_label_option_starts_the_walk_there(tmp_path: Path) -> None:
    game = project(tmp_path, {
        "a.rpy": 'label middle:\n    "Two."\n    jump last\n',
        "b.rpy": 'label last:\n    "Three."\n',
        "script.rpy": 'label start:\n    "One."\n    jump middle\n',
    })
    result, _parses = walk(game, "middle")
    assert texts(result) == ["Two.", "Three."]
    assert result.walk["start"] == "--label middle"
    assert [u["label"] for u in result.walk["labelsUnreached"]] == ["start"]
    with pytest.raises(SystemExit):
        walk(game, "no_such_label")


def test_no_label_start_reads_file_order(tmp_path: Path) -> None:
    """A project with no `label start` (a patch, a fragment) is read in
    file-name order, as before the walk followed labels."""
    game = project(tmp_path, {
        "a.rpy": 'label one:\n    "A."\n    return\n',
        "b.rpy": 'label two:\n    "B."\n    jump one\n',
    })
    result, _parses = walk(game)
    assert texts(result) == ["A.", "B."]
    assert result.walk == {"order": "file names (no label start)"}


def test_parser_flow_events() -> None:
    parsed = parse_file(
        'label start:\n    jump .a\nlabel .a:\n    call b from _c\n'
        '    return\n'
        '    if x:\n        jump c\n'
        '    menu:\n        "p":\n            jump d\n'
        '        "q":\n            "Q."\n', "game/x.rpy")
    flow = [(e.kind, e.flow.target if e.flow else e.name)
            for e in parsed.events if e.kind != "dialogue"]
    assert flow == [("label", "start"), ("jump", "start.a"),
                    ("label", "start.a"), ("call", "b"), ("return", None),
                    ("fork", None), ("fork", None)]
    if_fork, menu_fork = [e.flow for e in parsed.events if e.kind == "fork"]
    assert [[s.target for s in alt] for alt in if_fork.alternatives] == [
        ["c"], []]
    # A menu that becomes a decision carries each choice block's events.
    assert menu_fork.menu == 0 and menu_fork.alternatives == []
    assert [[(e.kind, e.flow.target if e.flow else e.text) for e in body]
            for body in menu_fork.bodies] == [[("jump", "d")],
                                              [("dialogue", "Q.")]]


# --- the CLI: ledger, summary, a valid folder ------------------------------

def test_cli_ledger_and_summary(tmp_path: Path,
                                capsys: pytest.CaptureFixture[str]) -> None:
    game = project(tmp_path / "proj", {
        "dev_tools.rpy": 'label dev_menu:\n    "Debug."\n',
        "chapters/a01.rpy": ('label ending:\n    scene room\n'
                             '    "The end."\n    return\n'),
        "chapters/b02.rpy": ('label middle:\n    "Middle."\n'
                             '    jump ending\n'),
        "script.rpy": ('image room = "room.png"\n'
                       'label start:\n    scene room\n    "Opening."\n'
                       '    jump middle\n'),
    })
    shutil.copy(DEMO_IMAGE, game / "room.png")
    out = tmp_path / "out"
    assert cli_main([str(game.parent), str(out)]) == 0
    printed = capsys.readouterr().out
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    assert [i.get("text") for i in manifest["items"]] == [
        "Opening.", "Middle.", "The end."]
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    walked = ledger["walk"]
    assert walked["start"] == "label start"
    assert walked["labelsReached"] == 3
    assert walked["labelsUnreached"] == [
        {"label": "dev_menu", "source": "game/dev_tools.rpy:1", "lines": 1}]
    assert walked["scriptsUnreached"] == ["game/dev_tools.rpy"]
    assert ("walk: from label start; labels reached 3, unreached 1 "
            "(dev_menu); lines unreached 1") in printed
    assert "walk: scripts unreached 1 (game/dev_tools.rpy)" in printed
    check = subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "validate_content.py"),
         str(out)], capture_output=True, text=True)
    assert check.returncode == 0, check.stdout + check.stderr
    more = tmp_path / "more"
    assert cli_main([str(game.parent), str(more),
                     "--include-unreached"]) == 0
    manifest = json.loads((more / "manifest.json").read_text("utf-8"))
    assert [i.get("text") for i in manifest["items"]][-1] == "Debug."
    ledger = json.loads((more / "build-ledger.json").read_text("utf-8"))
    assert ledger["slice"]["includeUnreached"] is True
    assert "walk: --include-unreached appended 1 labels (1 lines) after " \
        "the story" in capsys.readouterr().out
