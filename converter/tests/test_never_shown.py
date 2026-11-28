"""A decision never hangs off another decision's last route (docs/plan.md
Phase 60 item 9o2b).

A menu or `if` chain that opens with no item since another decision
closed would hang off that decision's last item, inside its last route,
with its own routes past that route's end: the player then never offers
it from the other routes, and a reading from the opening stops there,
leaving the rest of the story never shown. It gets a line before it, its
caption or the converter's words (a chain's always), which it hangs off:

- when the earlier decision's join's path reaches it past a `return` or
  an `if` that shows nothing, the line is that decision's `continueAt`,
  as Ren'Py's flow goes on into the menu;
- when the earlier decision is a pure choice (its join's path ended
  before an item, and the walk went on elsewhere), the line follows its
  last route, which a reading reaches once every route is played.

Each case is a synthetic project extracted end to end; every folder
validates `--strict` with nothing printed (no never-shown item) and is
walked by `kinetic check --steps all` to the story's end.
"""

from __future__ import annotations

from pathlib import Path

from kinetic_extract import conditions

from test_jump_menus import (LEAD, check_folder, detection, extract,
                             menu_reports, shape, texts)

NEXT = conditions.Words("en").say("menu.next")

FIRST = ('    menu:\n'
         '        "Tea":\n            "You drink tea."\n'
         '        "Coffee":\n            "You drink coffee."\n')
SECOND = ('    menu:\n'
          '        "North":\n            "North."\n'
          '        "South":\n            "South."\n')
CHAIN = ('    if points > 1:\n'
         '        "Strong."\n'
         '    else:\n'
         '        "Weak."\n')
DRINKS = [("Tea", "You drink tea.", "You drink tea.", "continue"),
          ("Coffee", "You drink coffee.", "You drink coffee.", "continue")]


def note_of(ledger: dict, source: str) -> str:
    return next(n["note"] for n in detection(ledger)
                if n["source"] == source)


def line_notes(ledger: dict, manifest: dict, text: str) -> list[str]:
    line = next(i for i in manifest["items"] if i.get("text") == text)
    return ledger["items"][line["id"]]["notes"]


def called(second: str) -> str:
    """The first menu ends a called label, whose `return` is its join;
    the caller's next statement is ``second``."""
    return ('default points = 0\n' + LEAD + '    call scene_a\n' + second +
            '    "After."\n    return\n'
            'label scene_a:\n' + FIRST + '    return\n')


def test_a_menu_after_a_join_through_a_return(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, called(SECOND))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", NEXT, "North.", "South.",
                               "After."]
    assert shape(manifest) == [
        {"after": "Lead.", "routes": DRINKS, "continuing": "Coffee",
         "continueAt": NEXT},
        {"after": NEXT,
         "routes": [("North", "North.", "North.", "continue"),
                    ("South", "South.", "South.", "continue")],
         "continuing": "South", "continueAt": "After."}]
    assert "pure choice" not in note_of(ledger, "game/script.rpy:14")
    assert ("follows another decision's join, past a return or an if that "
            "shows nothing, with no line between: a line before it, the "
            "converter's words" in note_of(ledger, "game/script.rpy:6"))
    assert ("the converter's words before a decision that follows a "
            "decision's join, past a return or an if that shows nothing, "
            "with no line between" in line_notes(ledger, manifest, NEXT))
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_a_menu_caption_after_a_join_through_a_return(tmp_path: Path
                                                      ) -> None:
    out, manifest, _ledger = extract(tmp_path, called(
        SECOND.replace("menu:", 'menu "Where now?":')))
    assert texts(manifest)[3:5] == ["Where now?", "North."]
    assert shape(manifest)[0]["continueAt"] == "Where now?"
    assert shape(manifest)[1]["after"] == "Where now?"
    check_folder(tmp_path, out, manifest)


def test_a_chain_after_a_join_through_a_return(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, called(CHAIN))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", NEXT, "Strong.", "Weak.",
                               "After."]
    decisions = shape(manifest)
    assert decisions[0]["continueAt"] == NEXT
    assert decisions[1]["after"] == NEXT
    assert [r[1] for r in decisions[1]["routes"]] == ["Strong.", "Weak."]
    assert decisions[1]["continueAt"] == "After."
    check_folder(tmp_path, out, manifest)


def test_a_menu_after_a_join_past_an_if_that_shows_nothing(
        tmp_path: Path) -> None:
    """The `if` stays linear (it shows nothing) and holds the first
    decision, which waits on to the second menu's line (item 9l)."""
    out, manifest, ledger = extract(tmp_path, 'default calm = 0\n' + LEAD +
                                    FIRST + '    if calm:\n'
                                    '        $ calm = 2\n' + SECOND +
                                    '    "After."\n    return\n')
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", NEXT, "North.", "South.",
                               "After."]
    decisions = shape(manifest)
    assert decisions[0] == {"after": "Lead.", "routes": DRINKS,
                            "continuing": "Coffee", "continueAt": NEXT}
    assert decisions[-1]["after"] == NEXT
    check_folder(tmp_path, out, manifest)


def candidates(second: str) -> str:
    """A computed jump's candidates, each a path of its own: scene A's
    menu ends the story (a pure choice), and scene B opens with
    ``second``, which the walk lays out next."""
    return ('default points = 0\n'
            'default where = "scene_a"\n' + LEAD +
            '    jump expression where\n'
            'label scene_a:\n' + FIRST + '    return\n'
            'label scene_b:\n' + second + '    "After."\n    return\n'
            'init python:\n'
            '    targets = ["scene_a", "scene_b"]\n')


def test_a_menu_after_a_pure_choice_hangs_off_a_line(tmp_path: Path
                                                     ) -> None:
    out, manifest, ledger = extract(tmp_path, candidates(SECOND))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", NEXT, "North.", "South.",
                               "After."]
    decisions = shape(manifest)
    assert decisions[0] == {
        "after": "Lead.",
        "routes": [(label, first, last, "ending")
                   for label, first, last, _r in DRINKS],
        "continuing": None, "continueAt": None}
    assert decisions[1]["after"] == NEXT
    assert ("opens right after another decision's last item, which no "
            "decision hangs off: a line before it, the converter's words"
            in note_of(ledger, "game/script.rpy:15"))
    assert ("the converter's words before a decision that would otherwise "
            "hang off another decision's last route"
            in line_notes(ledger, manifest, NEXT))
    check_folder(tmp_path, out, manifest)


def test_a_chain_after_a_pure_choice_hangs_off_a_line(tmp_path: Path
                                                      ) -> None:
    out, manifest, _ledger = extract(tmp_path, candidates(CHAIN))
    assert texts(manifest)[3:6] == [NEXT, "Strong.", "Weak."]
    decisions = shape(manifest)
    assert decisions[0]["continueAt"] is None
    assert decisions[1]["after"] == NEXT
    check_folder(tmp_path, out, manifest)


def arm_calls_talk(other: str) -> str:
    """An `if` arm calls a label whose menu's choices meet only through
    its `return`: a `pass`, a `return`, a `pass` (item 9o2d); ``other``
    is the chain's other arm."""
    return ('default hour = "day"\n'
            'init python:\n'
            '    def tick():\n'
            '        global hour\n'
            '        hour = "night"\n'
            'label start:\n    scene bg\n    "Lead."\n'
            '    $ tick()\n'
            '    if hour == "day":\n'
            '        call talk\n' + other +
            '    "After."\n    return\n'
            'label talk:\n'
            '    menu:\n'
            '        "Rest":\n            pass\n'
            '        "Kiss":\n            return 1\n'
            '        "Wait":\n            pass\n'
            '    return\n')


def test_a_chain_arm_line_before_a_nested_stat_choice_is_said_once(
        tmp_path: Path) -> None:
    """An `if` arm calls a label whose menu's choices meet only through
    its `return` (item 9o2d): the walk judges the menu on how its choices
    ended at its close, where a later `pass` stops at the `return` an
    earlier choice read (a shared tail with nothing in it, known only
    when the outermost menu closes), so the arm had no story of its own
    and got its line again after the nested decision, in no route. The
    enclosing routes' story follows the menu's final judgement: the
    arm's line is said once, before the nested decision."""
    out, manifest, ledger = extract(tmp_path, arm_calls_talk(
        '    else:\n        "Evening."\n'))
    arm = "(hour is day)"
    assert texts(manifest) == ["Lead.", arm, "Rest", "Kiss", "Wait",
                               "Evening.", "After."]
    decisions = shape(manifest)
    assert decisions[0] == {
        "after": arm,
        "routes": [(label, label, label, "continue")
                   for label in ("Rest", "Kiss", "Wait")],
        "continuing": "Wait", "continueAt": "After."}
    assert decisions[1] == {
        "after": "Lead.",
        "routes": [("hour is day", arm, "Wait", "continue"),
                   ("hour is not day", "Evening.", "Evening.", "continue")],
        "continuing": "hour is not day", "continueAt": "After."}
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_a_nested_stat_choice_makes_its_chain_a_decision(tmp_path: Path
                                                        ) -> None:
    """The same menu under an `if` with no `else`: the menu is a decision
    once the walk has read every choice, so the arm holding it has a
    story and the chain is a decision too, both going on to the line
    after the chain. Before, the chain was judged on the menu as its
    close found it (no story, so linear) and the menu's routes were
    endings, the line after them a pure choice's."""
    out, manifest, ledger = extract(tmp_path, arm_calls_talk(""))
    arm, absent = "(hour is day)", "(hour is not day)"
    assert texts(manifest) == ["Lead.", arm, "Rest", "Kiss", "Wait",
                               absent, "After."]
    decisions = shape(manifest)
    assert decisions[0] == {
        "after": arm,
        "routes": [(label, label, label, "continue")
                   for label in ("Rest", "Kiss", "Wait")],
        "continuing": "Wait", "continueAt": "After."}
    assert decisions[1] == {
        "after": "Lead.",
        "routes": [("hour is day", arm, "Wait", "continue"),
                   ("hour is not day", absent, absent, "continue")],
        "continuing": "hour is not day", "continueAt": "After."}
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)
