"""Joins at a block's end go on where Ren'Py does (docs/plan.md Phase 60
item 9o2h).

Two shapes left a decision a pure choice, its routes `"ending"`, where
Ren'Py goes on:

- A menu nested at the end of a choice's block whose choices meet at
  that block's end (a `goto` of the walk's program, with no source line
  of its own), when the enclosing menu's choices meet elsewhere (past a
  `return`, in the caller): the join had an empty place, so the timeline
  read it as no join, and the ledger note said "reaches the join at ,".
  The join is named by the statement the block's end goes on to, as
  item 9o2f names a join it follows to the caller (a join at a file's
  end, by its file), and the join's path goes on past the block as past
  an `if` that shows nothing, so a chain met there stays a decision.
- A menu in a label called from an `if` the converter does not convert,
  with no `else`: the join the menu follows to the caller is the `if`
  block's end, whose path stopped at the `if`'s join, which the walk
  lays out next, after the `if`'s missing `else`. The join's path now
  goes on there, as it does past an `if` met after the menu.

Each case is a synthetic project extracted end to end and checked as
test_jump_menus checks its folders: `kinetic validate --strict` prints
nothing (no never-shown item), `kinetic routes` counts what the
manifest holds and `kinetic check --steps all` walks to the story's
end. No ledger note names an empty place.
"""

from __future__ import annotations

import re
from pathlib import Path

from kinetic_extract import conditions

from test_jump_menus import (LEAD, check_folder, detection, extract,
                             shape, texts)

NEXT = conditions.Words("en").say("menu.next")
DRINKS = [("Tea", "You drink tea.", "You drink tea.", "continue"),
          ("Coffee", "You drink coffee.", "You drink coffee.", "continue")]
MENU = ('    menu:\n'
        '        "Tea":\n            "You drink tea."\n'
        '        "Coffee":\n            "You drink coffee."\n')
TALK = 'label talk:\n' + MENU + '    return\n'
# The same menu nested in a choice's block.
INNER = ''.join('        ' + line + '\n' for line in MENU.splitlines())


def notes(ledger: dict) -> list[str]:
    return [n.get("note", "") for n in detection(ledger)]


def no_empty_place(ledger: dict) -> None:
    """No note says a join is at an empty place."""
    for note in notes(ledger):
        assert not re.search(r"join at (?:[,;)]|$| through)", note), note


def note_at(ledger: dict, source: str) -> str:
    return next(n.get("note", "") for n in detection(ledger)
                if n["source"] == source)


def nested(after_inner: str) -> str:
    """A called label's menu whose first choice ends in a nested menu and
    whose second returns: the outer menu's choices meet past the `call`,
    in the caller; the nested one's at the end of the first choice's
    block, which goes on to ``after_inner``."""
    return (LEAD + '    call scene_a\n    "After."\n    return\n'
            'label scene_a:\n'
            '    menu:\n'
            '        "Go":\n'
            '            "You go."\n'
            + INNER +
            '        "Leave":\n            return\n' + after_inner)


def test_a_nested_menu_at_a_block_end_goes_on(tmp_path: Path) -> None:
    """The nested menu's choices meet at the end of the "Go" block, which
    goes on to "More.": the routes continue there, inside the "Go"
    route, and the note names that line."""
    out, manifest, ledger = extract(tmp_path, nested(
        '    "More."\n    return\n'))
    assert texts(manifest) == ["Lead.", "You go.", "You drink tea.",
                               "You drink coffee.", "More.", "Leave",
                               "After."]
    assert shape(manifest) == [
        {"after": "You go.", "routes": DRINKS, "continuing": "Coffee",
         "continueAt": "More."},
        {"after": "Lead.",
         "routes": [("Go", "You go.", "More.", "continue"),
                    ("Leave", "Leave", "Leave", "continue")],
         "continuing": "Leave", "continueAt": "After."}]
    assert "'Tea' continue (reaches the join at game/script.rpy:18)" \
        in note_at(ledger, "game/script.rpy:11")
    no_empty_place(ledger)
    check_folder(tmp_path, out, manifest)


def test_a_nested_menu_at_a_block_end_before_a_menu(tmp_path: Path
                                                    ) -> None:
    """The "Go" block's end goes on to another menu: the nested decision
    goes on into it, the menu getting its line straight after the join,
    as a menu after any join does (item 9o)."""
    out, manifest, ledger = extract(tmp_path, nested(
        '    menu:\n'
        '        "Sit":\n            "You sit."\n'
        '        "Stand":\n            "You stand."\n'
        '    "More."\n    return\n'))
    decisions = shape(manifest)
    assert decisions[0] == {"after": "You go.", "routes": DRINKS,
                            "continuing": "Coffee", "continueAt": NEXT}
    assert decisions[1]["after"] == NEXT
    assert [r[-1] for r in decisions[1]["routes"]] == ["continue"] * 2
    no_empty_place(ledger)
    check_folder(tmp_path, out, manifest)


def test_a_nested_menu_at_a_block_end_before_a_chain(tmp_path: Path
                                                     ) -> None:
    """The "Go" block's end goes on to an `if` chain: past the block's
    end, as past an `if` that shows nothing, the chain stays a decision
    with the converter's line before it (item 9o2b), which the nested
    decision continues at. Read as straight after the join, the chain
    would stay linear (item 9o), a decision lost."""
    script = 'default points = 3\n' + nested(
        '    if points > 1:\n        "High."\n'
        '    else:\n        "Low."\n'
        '    "More."\n    return\n')
    out, manifest, ledger = extract(tmp_path, script)
    assert texts(manifest) == ["Lead.", "You go.", "You drink tea.",
                               "You drink coffee.", NEXT, "High.", "Low.",
                               "More.", "Leave", "After."]
    decisions = shape(manifest)
    assert decisions[0] == {"after": "You go.", "routes": DRINKS,
                            "continuing": "Coffee", "continueAt": NEXT}
    assert decisions[1] == {
        "after": NEXT,
        "routes": [("points 2 or more", "High.", "High.", "continue"),
                   ("points under 2", "Low.", "Low.", "continue")],
        "continuing": "points under 2", "continueAt": "More."}
    assert "past a return or an if that shows nothing" in note_at(
        ledger, "game/script.rpy:19")
    no_empty_place(ledger)
    check_folder(tmp_path, out, manifest)


def test_a_nested_menu_meeting_the_enclosing_join_is_unchanged(
        tmp_path: Path) -> None:
    """Guard: the enclosing menu's choices meet right after it, where the
    "Go" block's end goes: the nested decision takes the enclosing
    `continueAt` (item 8c), as before."""
    out, manifest, ledger = extract(tmp_path, (
        LEAD + '    menu:\n'
        '        "Go":\n'
        '            "You go."\n'
        + INNER +
        '        "Leave":\n            "You leave."\n'
        '    "After."\n    return\n'))
    assert shape(manifest) == [
        {"after": "You go.", "routes": DRINKS, "continuing": "Coffee",
         "continueAt": "After."},
        {"after": "Lead.",
         "routes": [("Go", "You go.", "You drink coffee.", "continue"),
                    ("Leave", "You leave.", "You leave.", "continue")],
         "continuing": "Leave", "continueAt": "After."}]
    no_empty_place(ledger)
    check_folder(tmp_path, out, manifest)


def unconverted(block: str, rest: str = '    "After."\n    return\n',
                other: str = TALK) -> str:
    """`start` calls `talk` from an `if` the converter does not convert
    (a test on persistent data), then ``rest``."""
    return LEAD + '    if persistent.seen:\n' + block + rest + other


def test_a_called_menu_in_an_if_with_no_else_goes_on(tmp_path: Path
                                                     ) -> None:
    """The join the menu follows to the caller is the `if` block's end,
    which goes on to the line after the `if`: the routes continue
    there."""
    out, manifest, ledger = extract(tmp_path, unconverted(
        '        call talk\n'))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", "After."]
    assert shape(manifest) == [{"after": "Lead.", "routes": DRINKS,
                                "continuing": "Coffee",
                                "continueAt": "After."}]
    assert "'Tea' continue (reaches the join at game/script.rpy:6 " \
        "through a return to its caller)" in note_at(ledger,
                                                     "game/script.rpy:9")
    no_empty_place(ledger)
    check_folder(tmp_path, out, manifest)


def test_a_called_menu_in_an_if_whose_else_shows_nothing(tmp_path: Path
                                                         ) -> None:
    """An `else` the walk reads nothing in (its line is not laid out, as
    in any block of an `if` it does not convert) is as no `else`: the
    routes continue at the line after the `if`."""
    out, manifest, ledger = extract(tmp_path, unconverted(
        '        call talk\n    else:\n        "Evening."\n'))
    assert shape(manifest) == [{"after": "Lead.", "routes": DRINKS,
                                "continuing": "Coffee",
                                "continueAt": "After."}]
    no_empty_place(ledger)
    check_folder(tmp_path, out, manifest)


def test_a_called_menu_in_an_if_before_a_menu(tmp_path: Path) -> None:
    """A menu follows the `if`: the called decision goes on into it, the
    menu getting the line item 9o2b gives one past a `return`."""
    out, manifest, ledger = extract(tmp_path, unconverted(
        '        call talk\n',
        '    menu:\n'
        '        "Sit":\n            "You sit."\n'
        '        "Stand":\n            "You stand."\n'
        '    "After."\n    return\n'))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", NEXT, "You sit.",
                               "You stand.", "After."]
    decisions = shape(manifest)
    assert decisions[0] == {"after": "Lead.", "routes": DRINKS,
                            "continuing": "Coffee", "continueAt": NEXT}
    assert decisions[1] == {
        "after": NEXT,
        "routes": [("Sit", "You sit.", "You sit.", "continue"),
                   ("Stand", "You stand.", "You stand.", "continue")],
        "continuing": "Stand", "continueAt": "After."}
    no_empty_place(ledger)
    check_folder(tmp_path, out, manifest)


def test_a_called_menu_in_an_if_inside_a_route_goes_on(tmp_path: Path
                                                       ) -> None:
    """The same `if` inside a menu choice: the called decision goes on to
    the line after the `if`, inside its route."""
    out, manifest, ledger = extract(tmp_path, (
        LEAD + '    menu:\n'
        '        "Visit":\n'
        '            if persistent.seen:\n                call talk\n'
        '            "Back."\n'
        '        "Stay":\n            "You stay."\n'
        '    "After."\n    return\n' + TALK))
    assert shape(manifest) == [
        {"after": "Visit", "routes": DRINKS, "continuing": "Coffee",
         "continueAt": "Back."},
        {"after": "Lead.",
         "routes": [("Visit", "Visit", "Back.", "continue"),
                    ("Stay", "You stay.", "You stay.", "continue")],
         "continuing": "Stay", "continueAt": "After."}]
    no_empty_place(ledger)
    check_folder(tmp_path, out, manifest)


def test_a_called_menu_in_an_if_at_the_story_end_ends(tmp_path: Path
                                                      ) -> None:
    """Guard: the `if` is followed by the story's `return`: the routes
    end with the story, and the note names that `return`."""
    out, manifest, ledger = extract(tmp_path, unconverted(
        '        call talk\n', '    return\n'))
    assert [r[-1] for r in shape(manifest)[0]["routes"]] == ["ending"] * 2
    assert "reaches the join at game/script.rpy:6 through a return" \
        in note_at(ledger, "game/script.rpy:8")
    no_empty_place(ledger)
    check_folder(tmp_path, out, manifest)


def test_a_called_menu_in_an_if_whose_else_calls_keeps_its_join(
        tmp_path: Path) -> None:
    """Guard: the `else` calls another label, which the walk lays out
    after the menu: the menu's join stays at its `return` (item 9o2f),
    so the other label's line is not taken into the decision's routes,
    and the folder validates with every item shown."""
    out, manifest, ledger = extract(tmp_path, unconverted(
        '        call talk\n    else:\n        call other\n',
        other=TALK + 'label other:\n    "Other."\n    return\n'))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", "Other.", "After."]
    no_empty_place(ledger)
    check_folder(tmp_path, out, manifest)


def test_a_join_at_a_shown_screen_keeps_its_place(tmp_path: Path) -> None:
    """Guard: a `show screen` with no `Jump` or `Call` action is passed
    over like a block's end, but it is a statement of its own: a join
    there is still named by it, and a chain after it stays linear as
    one straight after a join does (item 9o), as before."""
    out, manifest, ledger = extract(tmp_path, (
        'default points = 3\n' + LEAD + MENU +
        '    show screen hud\n'
        '    if points > 1:\n        "High."\n'
        '    else:\n        "Low."\n'
        '    "After."\n    return\n'
        'screen hud():\n    text "Hud"\n'))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", "High.", "Low.",
                               "After."]
    assert shape(manifest) == [{"after": "Lead.", "routes": DRINKS,
                                "continuing": "Coffee",
                                "continueAt": "High."}]
    assert "'Tea' continue (reaches the join at game/script.rpy:10)" \
        in note_at(ledger, "game/script.rpy:5")
    no_empty_place(ledger)
    check_folder(tmp_path, out, manifest)


def test_a_join_at_a_files_end_is_named_by_its_file(tmp_path: Path
                                                    ) -> None:
    """A menu whose choices meet at the end of its file, the label reached
    by a `jump`: Ren'Py ends the story there, so the routes end, and the
    note names the file's end, not an empty place."""
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    (game / "zz_scene.rpy").write_text('label scene_a:\n' + MENU,
                                       encoding="utf-8")
    out, manifest, ledger = extract(tmp_path, LEAD + '    jump scene_a\n')
    assert [r[-1] for r in shape(manifest)[0]["routes"]] == ["ending"] * 2
    assert "reaches the join at the end of game/zz_scene.rpy" in note_at(
        ledger, "game/zz_scene.rpy:2")
    no_empty_place(ledger)
    check_folder(tmp_path, out, manifest)
