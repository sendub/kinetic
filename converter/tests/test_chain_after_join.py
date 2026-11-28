"""A menu or chain kept linear after a decision's join holds that decision
(docs/plan.md Phase 60 item 9o2g).

A decision whose join's path meets an `if` chain straight after the menu
(no item between) keeps the chain linear and goes on into it: its
`continueAt` is the chain's first line (items 9o and 9l). Past a
`return` or an `if` that shows nothing, a menu or chain that becomes a
decision gets item 9o2b's line before it, which the earlier decision
continues at; one that stays linear for a reason of its own (a lone
conditional choice, an arm leading back to its condition) got no line,
and the earlier decision gave up there: a pure choice, its routes
`"ending"`, though Ren'Py goes on into the linear menu. It now holds the
decision as a chain straight after the join does: the decision
continues at its first item, or waits on past it when it shows nothing.

Each case is a synthetic project extracted end to end and checked as
test_jump_menus checks its folders: `kinetic validate --strict` prints
nothing (no never-shown item), `kinetic routes` counts what the
manifest holds and `kinetic check --steps all` walks to the story's
end.
"""

from __future__ import annotations

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
# A menu of one conditional choice: it stays linear (`fewer than two
# choices`), its block's line kept in a row.
LONE = ('    menu:\n'
        '        "North" if seen:\n            "North."\n')
CALLED = 'label scene_a:\n' + MENU + '    return\n'
# A chain that shows nothing: it stays linear (`every choice is empty`).
QUIET = ('    if points > 1:\n        $ points = 0\n'
         '    else:\n        $ points = 1\n')


def called(second: str, end: str = '    "After."\n    return\n') -> str:
    """The first menu ends a called label, so its join is reached through
    the `return`; the caller's next statement is ``second``."""
    return ('default seen = False\ndefault points = 3\n' + LEAD +
            '    call scene_a\n' + second + end + CALLED)


def note_of(ledger: dict, source: str) -> str:
    return next(n.get("note", "") for n in detection(ledger)
                if n["source"] == source)


def skipped(ledger: dict) -> dict[str, str]:
    return {n["source"]: n["reason"] for n in detection(ledger)
            if n["result"] == "skipped"}


def holds(manifest: dict, first: str) -> None:
    """The called menu is the only decision, its routes going on at the
    linear menu's or chain's ``first`` line."""
    assert shape(manifest) == [{"after": "Lead.", "routes": DRINKS,
                                "continuing": "Coffee",
                                "continueAt": first}]


def test_a_linear_menu_past_a_return_holds_the_decision(tmp_path: Path
                                                        ) -> None:
    out, manifest, ledger = extract(tmp_path, called(LONE))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", "North.", "After."]
    holds(manifest, "North.")
    assert skipped(ledger) == {"game/script.rpy:7": "fewer than two choices"}
    assert "pure choice" not in note_of(ledger, "game/script.rpy:13")
    assert ("reaches the join at game/script.rpy:7 through a return to its "
            "caller" in note_of(ledger, "game/script.rpy:13"))
    check_folder(tmp_path, out, manifest)


def test_a_linear_chain_past_a_return_holds_the_decision(tmp_path: Path
                                                         ) -> None:
    """The caller's next statement is a chain an arm of which jumps back
    to it, so it stays linear: the routes go on at its first line."""
    out, manifest, ledger = extract(tmp_path, called(
        'label check:\n'
        '    if points > 1:\n'
        '        "Strong."\n'
        '        $ points -= 1\n'
        '        jump check\n'
        '    else:\n'
        '        "Weak."\n'))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", "Strong.", "Weak.",
                               "After."]
    holds(manifest, "Strong.")
    assert skipped(ledger) == {
        "game/script.rpy:8": "arm 1 (if points > 1:) leads back to the "
                             "condition"}
    check_folder(tmp_path, out, manifest)


def test_a_linear_menu_past_an_if_that_shows_nothing(tmp_path: Path
                                                     ) -> None:
    """The decision's join is a chain that shows nothing, kept linear
    straight after the menu (it holds the decision), and past it a menu
    that stays linear: the decision goes on into that menu's line."""
    out, manifest, _ledger = extract(tmp_path, (
        'default calm = 0\ndefault seen = False\n' + LEAD + MENU +
        '    if calm:\n        $ calm = 2\n' + LONE +
        '    "After."\n    return\n'))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", "North.", "After."]
    holds(manifest, "North.")
    check_folder(tmp_path, out, manifest)


def test_a_linear_menu_where_a_lifted_join_goes_on(tmp_path: Path) -> None:
    """The menu ends a label called from a called label (item 9o2f): its
    join goes on past the `return` to the caller's next statement, a menu
    that stays linear, which the routes go on into."""
    out, manifest, _ledger = extract(tmp_path, (
        'default seen = False\n' + LEAD + '    call scene_b\n'
        '    "After."\n    return\n'
        'label scene_b:\n    call scene_a\n' + LONE + '    return\n' +
        CALLED))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", "North.", "After."]
    holds(manifest, "North.")
    check_folder(tmp_path, out, manifest)


def test_a_linear_chain_showing_nothing_waits_on(tmp_path: Path) -> None:
    """The linear chain past the `return` shows nothing: the decision it
    holds waits on to the first item past it."""
    out, manifest, _ledger = extract(tmp_path, called(
        QUIET))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", "After."]
    holds(manifest, "After.")
    check_folder(tmp_path, out, manifest)


def test_the_story_end_past_a_linear_chain_still_ends(tmp_path: Path
                                                      ) -> None:
    """Past the linear chain, which shows nothing, the story ends: the
    called menu stays a pure choice, its routes `"ending"`."""
    out, manifest, _ledger = extract(tmp_path, called(
        QUIET,
        end='    return\n'))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee."]
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [(label, first, last, "ending")
                   for label, first, last, _r in DRINKS],
        "continuing": None, "continueAt": None}]
    check_folder(tmp_path, out, manifest)


def test_a_chain_straight_after_a_join_still_holds_it(tmp_path: Path
                                                      ) -> None:
    """A chain on `_return` straight after the menu, no `return` between:
    it stays linear, as before, and the routes go on at its first
    line."""
    out, manifest, ledger = extract(tmp_path, (
        LEAD + MENU + '    if _return == 1:\n        "One."\n'
        '    else:\n        "Other."\n'
        '    "After."\n    return\n'))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", "One.", "Other.",
                               "After."]
    holds(manifest, "One.")
    assert skipped(ledger) == {
        "game/script.rpy:9": "the menu follows the menu at "
                             "game/script.rpy:4 with no line between"}
    check_folder(tmp_path, out, manifest)


def test_a_menu_past_a_return_keeps_its_line(tmp_path: Path) -> None:
    """A menu that becomes a decision past the `return` keeps item 9o2b's
    line, which the called menu continues at."""
    out, manifest, _ledger = extract(tmp_path, called(
        '    menu:\n'
        '        "North":\n            "North."\n'
        '        "South":\n            "South."\n'))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", NEXT, "North.", "South.",
                               "After."]
    decisions = shape(manifest)
    assert decisions[0]["continueAt"] == NEXT
    assert decisions[1] == {
        "after": NEXT,
        "routes": [("North", "North.", "North.", "continue"),
                   ("South", "South.", "South.", "continue")],
        "continuing": "South", "continueAt": "After."}
    check_folder(tmp_path, out, manifest)


def test_a_return_chain_past_a_called_stat_choice(tmp_path: Path) -> None:
    """A chain on `_return` past the called menu's `return` becomes a
    decision with item 9o2b's line before it, as before: the called menu
    continues at that line, the chain at the line after it."""
    out, manifest, _ledger = extract(tmp_path, called(
        '    if _return == 1:\n        "One."\n'
        '    else:\n        "Other."\n').replace(
        '"You drink tea."', 'pass').replace('"You drink coffee."', 'pass'))
    assert texts(manifest) == ["Lead.", "Tea", "Coffee", NEXT, "One.",
                               "Other.", "After."]
    decisions = shape(manifest)
    assert decisions[0] == {
        "after": "Lead.",
        "routes": [("Tea", "Tea", "Tea", "continue"),
                   ("Coffee", "Coffee", "Coffee", "continue")],
        "continuing": "Coffee", "continueAt": NEXT}
    assert decisions[1]["after"] == NEXT
    assert [r[-1] for r in decisions[1]["routes"]] == ["continue"] * 2
    assert decisions[1]["continueAt"] == "After."
    check_folder(tmp_path, out, manifest)
