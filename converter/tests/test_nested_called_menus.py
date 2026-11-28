"""A nested menu in a called label goes on (docs/plan.md Phase 60 item
9o2k).

A menu in a called label whose choices meet past the `call`, in the
caller (one choice reads on to the label's `return`, another `return`s
or jumps to a label that does), takes the call's continuation as its
join when it opens (item 9l). A menu nested in one of its choices whose
own choices meet at a `return` of that label (the menu is the last
statement of the enclosing choice's block, or of the label, which the
block falls through to) kept its join at that `return`: item 9o2f
follows a join through its `return` only when the walk takes the call's
continuation up next, and here the enclosing menu had already taken it.
The join's path met no item of its own before the enclosing route's end:
a pure choice, its routes `"ending"`, though Ren'Py's `return` goes on
at the line after the `call`, the enclosing decision's `continueAt`.
Such a menu now meets where the enclosing menu does, through the
`return`, and its routes continue there. So does any decision whose
join's path reaches an enclosing menu's join before an item of its own
(past a `call` of a label that shows nothing, then that `return`, or by
a `jump` there, in a called label or not): it was a pure choice too.
Neither applies when the walk lays out more of the enclosing route next
(what follows an `if` it does not convert), which going on would leave
never shown.

Each case is a synthetic project extracted end to end and checked as
test_jump_menus checks its folders: `kinetic validate --strict` prints
nothing (no never-shown item), `kinetic routes` counts what the
manifest holds and `kinetic check --steps all` walks to the story's
end.
"""

from __future__ import annotations

from pathlib import Path

from kinetic_extract import conditions

from test_jump_menus import (LEAD, check_folder, detection, extract, ogg,
                             shape, texts)

NEXT = conditions.Words("en").say("menu.next")
DRINKS = [("Tea", "You drink tea.", "You drink tea.", "continue"),
          ("Coffee", "You drink coffee.", "You drink coffee.", "continue")]
# The menu nested in the "Go" choice's block.
INNER = ('            menu:\n'
         '                "Tea":\n                    "You drink tea."\n'
         '                "Coffee":\n                    "You drink coffee."\n')


def called(menu: str, rest: str = '    return\n') -> str:
    """`start` calls `scene_a`, whose ``menu`` comes first, then ``rest``;
    a line follows the `call`."""
    return (LEAD + '    call scene_a\n    "After."\n    return\n'
            'label scene_a:\n' + menu + rest)


def enclosing(go: str, leave: str = "Leave",
              go_first: str = "You go.") -> dict:
    """The enclosing decision: its "Go" route ends at ``go``, its "Leave"
    route reads ``leave``, and both continue after the `call`."""
    return {"after": "Lead.",
            "routes": [("Go", go_first, go, "continue"),
                       ("Leave", leave, leave, "continue")],
            "continuing": "Leave", "continueAt": "After."}


def go_leave(inner: str = INNER, leave: str = '            return\n') -> str:
    return ('    menu:\n'
            '        "Go":\n            "You go."\n' + inner +
            '        "Leave":\n' + leave)


def note_at(ledger: dict, source: str) -> str:
    return next(n.get("note", "") for n in detection(ledger)
                if n["source"] == source)


def test_the_item_shape_a_last_menu_after_a_nested_one_goes_on(
        tmp_path: Path) -> None:
    """The item's shape: the "Go" route's nested stat choice meets at its
    block's end, which goes on to the label's last menu (item 9o2h), and
    that menu's choices `pass` to the label's `return`. It was a pure
    choice, its routes `"ending"`; they continue after the `call`, where
    Ren'Py's `return` goes."""
    out, manifest, ledger = extract(tmp_path, called(go_leave(
        '            menu:\n'
        '                "Tea":\n                    pass\n'
        '                "Coffee":\n                    pass\n'),
        '    menu:\n'
        '        "Sit":\n            pass\n'
        '        "Stand":\n            pass\n'
        '    return\n'))
    assert texts(manifest) == ["Lead.", "You go.", "Tea", "Coffee", NEXT,
                               "Sit", "Stand", "Leave", "After."]
    assert shape(manifest) == [
        {"after": "You go.",
         "routes": [("Tea", "Tea", "Tea", "continue"),
                    ("Coffee", "Coffee", "Coffee", "continue")],
         "continuing": "Coffee", "continueAt": NEXT},
        {"after": NEXT,
         "routes": [("Sit", "Sit", "Sit", "continue"),
                    ("Stand", "Stand", "Stand", "continue")],
         "continuing": "Stand", "continueAt": "After."},
        enclosing("Stand")]
    assert "'Sit' continue (reaches the join at game/script.rpy:5 " \
        "through a return to its caller)" in note_at(ledger,
                                                     "game/script.rpy:18")
    check_folder(tmp_path, out, manifest)


def test_a_nested_menu_with_lines_at_the_label_end_goes_on(tmp_path: Path
                                                           ) -> None:
    """The nested menu's choices say lines and the "Go" block falls
    through to the label's `return`: the nested routes continue after the
    `call`, as the enclosing ones do."""
    out, manifest, ledger = extract(tmp_path, called(go_leave()))
    assert texts(manifest) == ["Lead.", "You go.", "You drink tea.",
                               "You drink coffee.", "Leave", "After."]
    assert shape(manifest) == [
        {"after": "You go.", "routes": DRINKS, "continuing": "Coffee",
         "continueAt": "After."},
        enclosing("You drink coffee.")]
    assert "'Tea' continue (reaches the join at game/script.rpy:5 " \
        "through a return to its caller)" in note_at(ledger,
                                                     "game/script.rpy:11")
    check_folder(tmp_path, out, manifest)


def test_a_second_level_of_nesting_goes_on(tmp_path: Path) -> None:
    """A menu nested in the nested menu's first choice, at the end of
    both blocks: both nested decisions continue after the `call`."""
    out, manifest, _ledger = extract(tmp_path, called(go_leave(
        '            menu:\n'
        '                "Tea":\n'
        '                    "You drink tea."\n'
        '                    menu:\n'
        '                        "Hot":\n                            pass\n'
        '                        "Cold":\n                            pass\n'
        '                "Coffee":\n'
        '                    "You drink coffee."\n')))
    assert texts(manifest) == ["Lead.", "You go.", "You drink tea.", "Hot",
                               "Cold", "You drink coffee.", "Leave",
                               "After."]
    assert shape(manifest) == [
        {"after": "You drink tea.",
         "routes": [("Hot", "Hot", "Hot", "continue"),
                    ("Cold", "Cold", "Cold", "continue")],
         "continuing": "Cold", "continueAt": "After."},
        {"after": "You go.",
         "routes": [("Tea", "You drink tea.", "Cold", "continue"),
                    ("Coffee", "You drink coffee.", "You drink coffee.",
                     "continue")],
         "continuing": "Coffee", "continueAt": "After."},
        enclosing("You drink coffee.")]
    check_folder(tmp_path, out, manifest)


def test_the_other_choice_jumping_to_a_label_that_returns(tmp_path: Path
                                                          ) -> None:
    """The enclosing menu's other choice jumps to a label that says a
    line and `return`s: the choices still meet after the `call`, and the
    label's last menu, past the nested one, continues there."""
    out, manifest, _ledger = extract(tmp_path, called(
        go_leave(leave='            jump leave_a\n'),
        '    menu:\n'
        '        "Sit":\n            "You sit."\n'
        '        "Stand":\n            "You stand."\n'
        '    return\n'
        'label leave_a:\n    "You leave."\n    return\n'))
    assert texts(manifest) == ["Lead.", "You go.", "You drink tea.",
                               "You drink coffee.", NEXT, "You sit.",
                               "You stand.", "You leave.", "After."]
    assert shape(manifest) == [
        {"after": "You go.", "routes": DRINKS, "continuing": "Coffee",
         "continueAt": NEXT},
        {"after": NEXT,
         "routes": [("Sit", "You sit.", "You sit.", "continue"),
                    ("Stand", "You stand.", "You stand.", "continue")],
         "continuing": "Stand", "continueAt": "After."},
        enclosing("You stand.", leave="You leave.")]
    check_folder(tmp_path, out, manifest)


def test_a_menu_in_a_label_the_choice_calls_goes_on(tmp_path: Path
                                                    ) -> None:
    """The "Go" choice calls a label holding the menu, at the end of the
    choice's block: the menu's choices return through both calls and go
    on where the enclosing menu does."""
    out, manifest, _ledger = extract(tmp_path, called(
        go_leave('            call deeper\n'),
        '    return\n'
        'label deeper:\n'
        '    menu:\n'
        '        "Tea":\n            "You drink tea."\n'
        '        "Coffee":\n            "You drink coffee."\n'
        '    return\n'))
    assert texts(manifest) == ["Lead.", "You go.", "You drink tea.",
                               "You drink coffee.", "Leave", "After."]
    assert shape(manifest) == [
        {"after": "You go.", "routes": DRINKS, "continuing": "Coffee",
         "continueAt": "After."},
        enclosing("You drink coffee.")]
    check_folder(tmp_path, out, manifest)


TEA_MENU = ('    menu:\n'
            '        "Tea":\n            "You drink tea."\n'
            '        "Coffee":\n            "You drink coffee."\n'
            '    return\n')
NOTHING = 'label nothing:\n    return\n'


def test_a_call_that_shows_nothing_before_the_return(tmp_path: Path
                                                     ) -> None:
    """The "Go" choice calls a label holding the menu, then a label that
    shows nothing: the menu's join is that second `call`, whose path
    returns to the enclosing menu's join with no item of its own. It was
    a pure choice; its routes continue where the enclosing menu's do."""
    out, manifest, _ledger = extract(tmp_path, called(
        go_leave('            call deeper\n            call nothing\n'),
        '    return\nlabel deeper:\n' + TEA_MENU + NOTHING))
    assert texts(manifest) == ["Lead.", "You go.", "You drink tea.",
                               "You drink coffee.", "Leave", "After."]
    assert shape(manifest) == [
        {"after": "You go.", "routes": DRINKS, "continuing": "Coffee",
         "continueAt": "After."},
        enclosing("You drink coffee.")]
    check_folder(tmp_path, out, manifest)


def test_chains_that_return_early_around_a_called_menu(tmp_path: Path
                                                       ) -> None:
    """`if` chains converted as decisions, each arm `return`ing early,
    the absent `else` reading on: `scene_a`'s goes on to call `scene_b`
    and a label that shows nothing; `scene_b`'s to a menu at its end.
    Every decision continues after the first `call`: before, the inner
    chain and the menu were pure choices."""
    out, manifest, _ledger = extract(tmp_path, (
        'default x = 1\n' + LEAD + '    call scene_a\n    "After."\n'
        '    return\n'
        'label scene_a:\n    if x == 2:\n        return\n'
        '    call scene_b\n    call nothing\n    return\n'
        'label scene_b:\n    if x == 3:\n        return\n'
        + TEA_MENU + NOTHING))
    two, not_two = "(x exactly 2)", "(x under 2 or x 3 or more)"
    three, not_three = "(x exactly 3)", "(x under 3 or x 4 or more)"
    assert texts(manifest) == ["Lead.", two, not_two, three, not_three,
                               "You drink tea.", "You drink coffee.",
                               "After."]
    assert shape(manifest) == [
        {"after": not_three, "routes": DRINKS, "continuing": "Coffee",
         "continueAt": "After."},
        {"after": not_two,
         "routes": [("x exactly 3", three, three, "continue"),
                    ("x under 3 or x 4 or more", not_three,
                     "You drink coffee.", "continue")],
         "continuing": "x under 3 or x 4 or more", "continueAt": "After."},
        {"after": "Lead.",
         "routes": [("x exactly 2", two, two, "continue"),
                    ("x under 2 or x 3 or more", not_two,
                     "You drink coffee.", "continue")],
         "continuing": "x under 2 or x 3 or more", "continueAt": "After."}]
    check_folder(tmp_path, out, manifest)


def test_a_sound_after_the_nested_menu_plays_on_every_route(
        tmp_path: Path) -> None:
    """A sound between the nested menu and the "Go" block's end is passed
    on the way to the `return`: each nested route goes on and ends with
    it (item 9o2i), the other enclosing route and the join without it."""
    audio = tmp_path / "proj" / "game" / "audio"
    audio.mkdir(parents=True)
    ogg(audio / "door.ogg", 440)
    out, manifest, _ledger = extract(tmp_path, called(go_leave(
        INNER + '            play sound "audio/door.ogg"\n')))
    assert shape(manifest) == [
        {"after": "You go.", "routes": DRINKS, "continuing": "Coffee",
         "continueAt": "After."},
        enclosing("You drink coffee.")]
    door = {"sfx": [{"track": "door", "channel": "sound"}]}
    assert {i.get("text"): i["audio"] for i in manifest["items"]
            if "audio" in i} == {"You drink tea.": door,
                                 "You drink coffee.": door}
    check_folder(tmp_path, out, manifest)


def test_guard_an_enclosing_join_through_its_return(tmp_path: Path
                                                    ) -> None:
    """Guard: the other choice says a line and falls through to the
    label's `return` too, so the enclosing menu's join is that `return`,
    followed to the caller (item 9o2f), and the nested menu meets there:
    unchanged."""
    out, manifest, _ledger = extract(tmp_path, called(go_leave(
        leave='            "You leave."\n')))
    assert shape(manifest) == [
        {"after": "You go.", "routes": DRINKS, "continuing": "Coffee",
         "continueAt": "After."},
        enclosing("You drink coffee.", leave="You leave.")]
    check_folder(tmp_path, out, manifest)


def test_guard_the_same_menus_in_the_main_flow_end(tmp_path: Path) -> None:
    """Guard: the same menus with no call under way: the `return`s end
    the story, so every route is `"ending"`, a pure choice, as before."""
    out, manifest, _ledger = extract(tmp_path, LEAD + go_leave() +
                                     '    return\n')
    assert texts(manifest) == ["Lead.", "You go.", "You drink tea.",
                               "You drink coffee.", "Leave"]
    assert shape(manifest) == [
        {"after": "You go.",
         "routes": [(r[0], r[1], r[2], "ending") for r in DRINKS],
         "continuing": None, "continueAt": None},
        {"after": "Lead.",
         "routes": [("Go", "You go.", "You drink coffee.", "ending"),
                    ("Leave", "Leave", "Leave", "ending")],
         "continuing": None, "continueAt": None}]
    check_folder(tmp_path, out, manifest)


def test_guard_a_nested_menu_before_a_line_in_the_label(tmp_path: Path
                                                        ) -> None:
    """Guard: a line follows the "Go" block in the called label, so the
    nested menu meets there, inside its route (item 9o2h): unchanged."""
    out, manifest, _ledger = extract(tmp_path, called(
        go_leave(), '    "More."\n    return\n'))
    assert shape(manifest) == [
        {"after": "You go.", "routes": DRINKS, "continuing": "Coffee",
         "continueAt": "More."},
        enclosing("More.")]
    check_folder(tmp_path, out, manifest)


def test_guard_a_block_of_an_unconverted_if_laid_out_after(tmp_path: Path
                                                           ) -> None:
    """Guard: the called menu's join path reaches the enclosing chain's
    join, but the walk lays out what follows the `if` it does not
    convert (a line the "x" route reads after the `if`) in the same
    route next. Going on at the enclosing `continueAt` would leave that
    line never shown, so the nested decision stays as before."""
    out, manifest, _ledger = extract(tmp_path, (
        'default x = 1\n' + LEAD + '    call scene_a\n    "After."\n'
        '    return\n'
        'label scene_a:\n    if x == 2:\n        return\n'
        '    if persistent.seen:\n'
        '        call deeper\n        call nothing\n        return\n'
        '    call waiting\n    return\n'
        'label deeper:\n    menu:\n'
        '        "Tea":\n            "You drink tea."\n            return\n'
        '        "Coffee":\n            "You drink coffee."\n'
        '            return\n'
        'label waiting:\n    "You wait."\n    return\n' + NOTHING))
    two, not_two = "(x exactly 2)", "(x under 2 or x 3 or more)"
    assert texts(manifest) == ["Lead.", two, not_two, "You drink tea.",
                               "You drink coffee.", "You wait.", "After."]
    assert shape(manifest) == [
        {"after": not_two,
         "routes": [(r[0], r[1], r[2], "ending") for r in DRINKS],
         "continuing": None, "continueAt": None},
        {"after": "Lead.",
         "routes": [("x exactly 2", two, two, "continue"),
                    ("x under 2 or x 3 or more", not_two, "You wait.",
                     "continue")],
         "continuing": "x under 2 or x 3 or more", "continueAt": "After."}]
    check_folder(tmp_path, out, manifest)


def test_a_chain_whose_join_jumps_to_the_enclosing_join(tmp_path: Path
                                                        ) -> None:
    """No call at all: a chain in the label one choice jumps to meets at
    a `jump` to the label where the menu's choices meet. Its join's path
    reaches that join before any item, so its routes continue where the
    menu's do; before, a pure choice."""
    out, manifest, _ledger = extract(tmp_path, (
        'default x = 1\n' + LEAD + '    menu:\n'
        '        "Stay":\n            jump stay\n'
        '        "Go":\n            jump go\n'
        'label stay:\n    "You stay."\n'
        '    if x == 2:\n        "Two."\n    else:\n        "Other."\n'
        '    jump joined\n'
        'label go:\n    "You go."\n    jump joined\n'
        'label joined:\n    "After."\n    return\n'))
    assert texts(manifest) == ["Lead.", "You stay.", "Two.", "Other.",
                               "You go.", "After."]
    assert shape(manifest) == [
        {"after": "You stay.",
         "routes": [("x exactly 2", "Two.", "Two.", "continue"),
                    ("x under 2 or x 3 or more", "Other.", "Other.",
                     "continue")],
         "continuing": "x under 2 or x 3 or more", "continueAt": "After."},
        {"after": "Lead.",
         "routes": [("Stay", "You stay.", "Other.", "continue"),
                    ("Go", "You go.", "You go.", "continue")],
         "continuing": "Go", "continueAt": "After."}]
    check_folder(tmp_path, out, manifest)
