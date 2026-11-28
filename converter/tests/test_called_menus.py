"""A menu in a called label goes on in its caller (docs/plan.md Phase 60
item 9o2f).

A menu whose choices meet at its label's `return`, nothing shown between
(every choice a `pass` or a line, then `return`), meets where that
`return` goes on: the statement after the `call`, through as many calls
as return at once. Before, the join was the `return` itself, and where
the caller's next statement was the end of an enclosing route (an `if`
arm or a menu choice holding the `call`), the join's path ended with no
item of its own: a pure choice, its routes `"ending"`, though Ren'Py
goes on. Such a join is reached through the `return`, so a chain it
opens straight into keeps the line before it that item 9o2b gives one
past a `return`, which the decision continues at. The join stays at the
`return` when the walk still has another way of the called label to
read that returns there too (a block of an `if` it does not convert),
so the caller's next statement keeps Ren'Py's order.

Each case is a synthetic project extracted end to end and checked as
test_jump_menus checks its folders: `kinetic validate --strict` prints
nothing and `kinetic check --steps all` walks to the story's end.
"""

from __future__ import annotations

import json
from pathlib import Path

from kinetic_extract import conditions

from test_jump_menus import (LEAD, check_folder, extract, menu_reports, ogg,
                             shape, texts)

NEXT = conditions.Words("en").say("menu.next")
PASSES = ('label talk:\n'
          '    menu:\n'
          '        "Rest":\n            pass\n'
          '        "Wait":\n            pass\n'
          '    return\n')
TALK = [("Rest", "Rest", "Rest", "continue"),
        ("Wait", "Wait", "Wait", "continue")]


def chain_calls(callee: str) -> str:
    """Item 9o2d's shape: an `if` arm calls ``callee``'s label `talk`, the
    `else` says a line, and a line follows the chain."""
    return ('default hour = "day"\n'
            'init python:\n'
            '    def tick():\n'
            '        global hour\n'
            '        hour = "night"\n'
            'label start:\n    scene bg\n    "Lead."\n'
            '    $ tick()\n'
            '    if hour == "day":\n'
            '        call talk\n'
            '    else:\n'
            '        "Evening."\n'
            '    "After."\n    return\n' + callee)


def choice_calls(call: str, callee: str) -> str:
    """A menu choice ``call``s, the other says a line, and a line follows
    the menu."""
    return (LEAD + '    menu:\n'
            '        "Visit":\n            call ' + call + '\n'
            '        "Stay":\n            "You stay."\n'
            '    "After."\n    return\n' + callee)


def outer(routes: list[tuple[str, str, str, str]], after: str = "Lead."
          ) -> dict:
    return {"after": after, "routes": routes,
            "continuing": routes[-1][0], "continueAt": "After."}


def test_a_called_stat_choice_under_an_if_arm_goes_on(tmp_path: Path
                                                       ) -> None:
    """Item 9o2d's shape with every choice a `pass`: the choices meet at
    `talk`'s `return`, past which the caller's arm ends, so the join's
    path ended with no item and the routes were `"ending"`. They go on
    to the line after the chain, as Ren'Py does."""
    out, manifest, ledger = extract(tmp_path, chain_calls(PASSES))
    arm = "(hour is day)"
    assert texts(manifest) == ["Lead.", arm, "Rest", "Wait", "Evening.",
                               "After."]
    assert shape(manifest) == [
        {"after": arm, "routes": TALK, "continuing": "Wait",
         "continueAt": "After."},
        outer([("hour is day", arm, "Wait", "continue"),
               ("hour is not day", "Evening.", "Evening.", "continue")])]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_a_called_menu_with_lines_under_an_if_arm_goes_on(tmp_path: Path
                                                         ) -> None:
    """The called menu's choices say lines and meet at its `return`: its
    routes go on to the line after the chain."""
    out, manifest, ledger = extract(tmp_path, chain_calls(
        'label talk:\n'
        '    menu:\n'
        '        "Rest":\n            "You rest."\n'
        '        "Wait":\n            "You wait."\n'
        '    return\n'))
    arm = "(hour is day)"
    assert texts(manifest) == ["Lead.", arm, "You rest.", "You wait.",
                               "Evening.", "After."]
    assert shape(manifest) == [
        {"after": arm,
         "routes": [("Rest", "You rest.", "You rest.", "continue"),
                    ("Wait", "You wait.", "You wait.", "continue")],
         "continuing": "Wait", "continueAt": "After."},
        outer([("hour is day", arm, "You wait.", "continue"),
               ("hour is not day", "Evening.", "Evening.", "continue")])]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def door(tmp_path: Path) -> str:
    """A sound file for the project, and `talk` with a sound started
    between its menu and its `return`."""
    audio = tmp_path / "proj" / "game" / "audio"
    audio.mkdir(parents=True)
    ogg(audio / "door.ogg", 440)
    return PASSES.replace('    return\n',
                          '    play sound "audio/door.ogg"\n    return\n')


def sounds(manifest: dict) -> list[str | None]:
    return [i.get("text") for i in manifest["items"]
            if "door" in json.dumps(i.get("audio"))]


def test_a_sound_before_the_return_is_kept(tmp_path: Path) -> None:
    """A sound between the menu and the `return` it meets at does not
    stop the join going on in the caller, and its cue is kept: on the
    caller's line after the `call`, the join's first item, as before."""
    out, manifest, ledger = extract(tmp_path, (
        LEAD + '    call talk\n    "After."\n    return\n' + door(tmp_path)))
    assert shape(manifest) == [{"after": "Lead.", "routes": TALK,
                                "continuing": "Wait",
                                "continueAt": "After."}]
    assert sounds(manifest) == ["After."]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_a_sound_before_the_return_under_an_if_arm(tmp_path: Path) -> None:
    """The same under item 9o2d's `if` arm: the routes go on to the line
    after the chain, and the sound ends each of them, which every reader
    of the arm passes (item 9o2i: before, only the last route's)."""
    out, manifest, ledger = extract(tmp_path, chain_calls(door(tmp_path)))
    arm = "(hour is day)"
    assert shape(manifest)[0] == {"after": arm, "routes": TALK,
                                  "continuing": "Wait",
                                  "continueAt": "After."}
    assert sounds(manifest) == ["Rest", "Wait"]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_a_call_in_a_choice_of_a_stat_choice_label_goes_on(tmp_path: Path
                                                           ) -> None:
    """A menu choice calls the label: the nested decision's routes go on
    to the line after the enclosing menu."""
    out, manifest, ledger = extract(tmp_path, choice_calls("talk", PASSES))
    assert texts(manifest) == ["Lead.", "Visit", "Rest", "Wait",
                               "You stay.", "After."]
    assert shape(manifest) == [
        {"after": "Visit", "routes": TALK, "continuing": "Wait",
         "continueAt": "After."},
        outer([("Visit", "Visit", "Wait", "continue"),
               ("Stay", "You stay.", "You stay.", "continue")])]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_nested_calls_return_at_once_to_the_route(tmp_path: Path) -> None:
    """The choice calls a label that calls `talk` and returns at once:
    the join goes up both calls."""
    out, manifest, ledger = extract(tmp_path, choice_calls(
        "scene_a", 'label scene_a:\n    call talk\n    return\n' + PASSES))
    assert shape(manifest) == [
        {"after": "Visit", "routes": TALK, "continuing": "Wait",
         "continueAt": "After."},
        outer([("Visit", "Visit", "Wait", "continue"),
               ("Stay", "You stay.", "You stay.", "continue")])]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_a_line_after_the_call_is_the_join(tmp_path: Path) -> None:
    """A line after the `call`, in the route: the nested decision goes on
    there, inside its route, as it did before."""
    out, manifest, ledger = extract(tmp_path, (
        LEAD + '    menu:\n'
        '        "Visit":\n            call talk\n'
        '            "Back."\n'
        '        "Stay":\n            "You stay."\n'
        '    "After."\n    return\n' + PASSES))
    assert shape(manifest) == [
        {"after": "Visit", "routes": TALK, "continuing": "Wait",
         "continueAt": "Back."},
        outer([("Visit", "Visit", "Back.", "continue"),
               ("Stay", "You stay.", "You stay.", "continue")])]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_a_chain_on_the_value_a_called_menu_returns(tmp_path: Path) -> None:
    """The called menu's choices `return` values the caller's chain reads:
    they meet at the chain past the `call`, as item 9l found, reached
    through the `return` (item 9o2j: before, the chain stayed linear, its
    arms read in a row, its first line the `continueAt`): the chain is a
    decision with item 9o2b's line before it, which the routes go on
    at."""
    out, manifest, _ledger = extract(tmp_path, (
        LEAD + '    call talk\n'
        '    if _return == 1:\n        "One."\n'
        '    else:\n        "Other."\n'
        '    "After."\n    return\n'
        'label talk:\n'
        '    menu:\n'
        '        "Rest":\n            return 1\n'
        '        "Wait":\n            return 2\n'))
    assert texts(manifest) == ["Lead.", "Rest", "Wait", NEXT, "One.",
                               "Other.", "After."]
    decisions = shape(manifest)
    assert decisions[0] == {"after": "Lead.", "routes": TALK,
                            "continuing": "Wait", "continueAt": NEXT}
    assert decisions[1]["after"] == NEXT
    assert [r[-1] for r in decisions[1]["routes"]] == ["continue"] * 2
    check_folder(tmp_path, out, manifest)


def test_a_chain_after_a_called_stat_choice_keeps_its_line(tmp_path: Path
                                                           ) -> None:
    """The choices set a flag and meet at the `return`; the caller's chain
    on the flag follows the `call`: the join is the chain, still reached
    through the `return`, so it keeps the line item 9o2b gives it."""
    out, manifest, ledger = extract(tmp_path, (
        'default flag = False\n' + LEAD + '    call talk\n'
        '    if flag:\n        "One."\n'
        '    else:\n        "Other."\n'
        '    "After."\n    return\n'
        'label talk:\n'
        '    menu:\n'
        '        "Rest":\n            $ flag = True\n'
        '        "Wait":\n            $ flag = False\n'
        '    return\n'))
    assert texts(manifest) == ["Lead.", "Rest", "Wait", NEXT, "One.",
                               "Other.", "After."]
    decisions = shape(manifest)
    assert decisions[0] == {"after": "Lead.", "routes": TALK,
                            "continuing": "Wait", "continueAt": NEXT}
    assert decisions[1]["after"] == NEXT
    assert [r[-1] for r in decisions[1]["routes"]] == ["continue"] * 2
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_a_call_at_the_story_end_still_ends(tmp_path: Path) -> None:
    """A `return` with nothing on the call stack still ends the story:
    the enclosing menu is the last thing in `start`, so every route of
    both decisions is an ending."""
    out, manifest, _ledger = extract(tmp_path, (
        LEAD + '    menu:\n'
        '        "Visit":\n            call talk\n'
        '        "Stay":\n            "You stay."\n'
        '    return\n' + PASSES))
    assert [[r[-1] for r in d["routes"]] for d in shape(manifest)] == [
        ["ending", "ending"], ["ending", "ending"]]
    check_folder(tmp_path, out, manifest)


def test_a_called_menu_inside_a_called_menus_choice(tmp_path: Path
                                                    ) -> None:
    """A choice of the called menu calls a label with a menu of its own:
    the inner menu's `return` leads to the outer called menu's, which
    goes on in the caller, so both go on where the enclosing decision
    does."""
    out, manifest, ledger = extract(tmp_path, choice_calls("talk", (
        'label talk:\n'
        '    menu:\n'
        '        "Rest":\n            pass\n'
        '        "Look":\n            "You look."\n'
        '            call deeper\n'
        '    return\n'
        'label deeper:\n'
        '    menu:\n'
        '        "Stare":\n            pass\n'
        '        "Leave":\n            pass\n'
        '    return\n')))
    assert shape(manifest) == [
        {"after": "You look.",
         "routes": [("Stare", "Stare", "Stare", "continue"),
                    ("Leave", "Leave", "Leave", "continue")],
         "continuing": "Leave", "continueAt": "After."},
        {"after": "Visit",
         "routes": [("Rest", "Rest", "Rest", "continue"),
                    ("Look", "You look.", "Leave", "continue")],
         "continuing": "Look", "continueAt": "After."},
        outer([("Visit", "Visit", "Leave", "continue"),
               ("Stay", "You stay.", "You stay.", "continue")])]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_a_return_other_paths_still_reach_keeps_its_join(tmp_path: Path
                                                         ) -> None:
    """The called menu sits in a block of an `if` the converter does not
    convert, whose other way also returns: the walk reads that way after
    the menu, so the menu's join stays at its `return`, as before, and
    the caller's next statement comes after both ways, in Ren'Py's
    order."""
    out, manifest, ledger = extract(tmp_path, (
        'default flag = False\ndefault other = False\n' + LEAD +
        '    menu:\n'
        '        "Visit":\n            call talk\n            call pose\n'
        '        "Stay":\n            "You stay."\n'
        '    "After."\n    return\n'
        'label talk:\n'
        '    if flag and other:\n        call deeper\n        return\n'
        '    "Plain."\n    return\n'
        'label deeper:\n'
        '    menu:\n'
        '        "Stare":\n            pass\n'
        '        "Leave":\n            pass\n'
        '    return\n'
        'label pose:\n    "Pose."\n    return\n'))
    assert texts(manifest) == ["Lead.", "Visit", "Stare", "Leave", "Plain.",
                               "Pose.", "You stay.", "After."]
    assert shape(manifest)[1] == outer(
        [("Visit", "Visit", "Pose.", "continue"),
         ("Stay", "You stay.", "You stay.", "continue")])
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_a_join_at_the_end_of_a_block_is_still_a_join(tmp_path: Path
                                                      ) -> None:
    """The `call` ends the last block of an `if` the converter does not
    convert, whose first block ends the story: the join the menu follows
    to the caller is that block's end, which has no line of its own, and
    goes on to the line after the `if`. It is still a join: the routes
    continue there, and the note names that line."""
    out, manifest, ledger = extract(tmp_path, (
        'default a = False\ndefault b = False\n' + LEAD +
        '    if a and b:\n        return\n    else:\n        call talk\n'
        '    "After."\n    return\n' + PASSES))
    assert shape(manifest) == [{"after": "Lead.", "routes": TALK,
                                "continuing": "Wait",
                                "continueAt": "After."}]
    note = next(n["note"] for n in ledger["branchDetection"]
                if n["result"] == "detected")
    assert "reaches the join at game/script.rpy:10 through a return" in note
    check_folder(tmp_path, out, manifest)


def test_a_block_end_before_another_block_keeps_its_join(tmp_path: Path
                                                         ) -> None:
    """The `call` ends a block of an `if` the converter does not convert,
    inside a route, and the `if`'s other block calls another label: the
    walk lays that block out next, in the same route, so the menu's join
    does not go past it to where the enclosing decision continues, which
    would leave the other block's lines in no route."""
    out, manifest, ledger = extract(tmp_path, (
        'default a = False\ndefault b = False\n' + LEAD +
        '    menu:\n'
        '        "Visit":\n'
        '            if a and b:\n                call talk\n'
        '            else:\n                call other\n'
        '        "Stay":\n            "You stay."\n'
        '    "After."\n    return\n' + PASSES +
        'label other:\n    "Other."\n    return\n'))
    assert texts(manifest) == ["Lead.", "Visit", "Rest", "Wait", "Other.",
                               "You stay.", "After."]
    assert shape(manifest)[1] == outer(
        [("Visit", "Visit", "Other.", "continue"),
         ("Stay", "You stay.", "You stay.", "continue")])
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)
