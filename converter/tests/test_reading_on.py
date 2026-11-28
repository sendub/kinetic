"""A new decision with no join item reads on (docs/plan.md Phase 60 item
9o2m).

Items 9o2j and 9o2k made decisions of menus and chains the converter
kept linear: a chain on `_return` past a called menu whose choices
`return` a value (item 9o2j: every join in the caller crosses its
`return`, so the chain gets item 9o2b's line), and a menu a choice of
which met the others only through a `return` an enclosing menu's join
took past (item 9o2k), where before it rejoined content read there.
Where such a decision's own join has no item (its path stops at content
read elsewhere: the `jump` back to a hub label a free-roam loop calls
from), its routes ended the story, a pure choice, while the walk lays
out more after it, which the reader of the linear lines read on into.
Such a menu or chain stays linear, as before those items: the chain with
no line before it, holding the called menu, which goes on into its lines
(item 9o2g); the menu with its lines in a row, the decision nested in it
going on as they do (item 9o2j). A pure choice at the story's end stays
one, and so does a chain past a `return` the old rule crossed (a join
item 9o2f follows to the caller); a chain whose join has an item stays a
decision. A decision nested in the last block of a menu or chain kept
linear, whose lines meet where an enclosing decision's choices do with
nothing laid out next, goes on at that decision's `continueAt`, as the
lines do. A decision held so says in its ledger note where it continues,
not only the join its routes reach.

Each case is a synthetic project extracted end to end and checked as
test_jump_menus checks its folders: `kinetic validate --strict` prints
nothing (no never-shown item), `kinetic routes` counts what the manifest
holds and `kinetic check --steps all` walks to the story's end.
"""

from __future__ import annotations

from pathlib import Path

from kinetic_extract import conditions

from test_jump_menus import (LEAD, check_folder, detection, extract,
                             shape, texts)

NEXT = conditions.Words("en").say("menu.next")
# A free-roam loop: the "Roam" choice jumps to a hub that calls a
# computed scene and jumps back to itself; "Rest" is laid out after it.
ROAM = (LEAD + '    menu:\n'
        '        "Roam":\n            jump hub\n'
        '        "Rest":\n            "You rest."\n'
        '    "After."\n    return\n')
HUB = ('label hub:\n    "Hub."\n'
       '    $ where = renpy.random.choice(["walk", "trip"])\n'
       '    call expression where\n    jump hub\n')
WALK = 'label walk:\n    "You walk."\n    return\n'
# The candidate that calls a menu returning a value, then a chain on it.
TRIP = ('label trip:\n    call ask\n'
        '    if _return:\n        "Yes."\n    else:\n        "No."\n'
        '    return\n')
ASK = ('label ask:\n    menu:\n'
       '        "Go":\n            "You go."\n            return True\n'
       '        "Stay":\n            "You stay."\n            return False\n')
ASKED = [("Go", "You go.", "You go.", "continue"),
         ("Stay", "You stay.", "You stay.", "continue")]
ARMS = ["_return is set", "_return is not set"]


def skipped(ledger: dict) -> dict[str, str]:
    return {n["source"]: n["reason"] for n in detection(ledger)
            if n["result"] == "skipped"}


def note_of(ledger: dict, source: str) -> str:
    return next(n.get("note", "") for n in detection(ledger)
                if n["source"] == source)


def id_of(manifest: dict, text: str) -> str:
    return next(i["id"] for i in manifest["items"] if i.get("text") == text)


def test_a_return_chain_under_a_computed_call_reads_on(tmp_path: Path
                                                       ) -> None:
    """The last candidate's chain meets at the hub's `jump`, content read
    before: no item of its own, while the "Rest" route is laid out after.
    The chain stays linear with no line before it, the called menu goes on
    into its arms, read in a row, and on to "You rest." (at edee726 a
    decision with item 9o2b's line whose routes ended the story)."""
    out, manifest, ledger = extract(tmp_path, ROAM + HUB + WALK + TRIP
                                    + ASK)
    assert texts(manifest) == ["Lead.", "Hub.", "You walk.", "You go.",
                               "You stay.", "Yes.", "No.", "You rest.",
                               "After."]
    assert shape(manifest) == [{"after": "You walk.", "routes": ASKED,
                                "continuing": "Stay", "continueAt": "Yes."}]
    assert skipped(ledger)["game/script.rpy:21"] == (
        "the menu follows the menu at game/script.rpy:27 with no line "
        "between, past a return, and its own join has no item of its own")
    check_folder(tmp_path, out, manifest)


def test_a_held_decision_says_where_it_continues(tmp_path: Path) -> None:
    """The called menu's routes reach the join at the chain's `if`; its
    note also names its `continueAt`, the chain's first line, and that the
    chain kept linear holds it there."""
    _out, manifest, ledger = extract(tmp_path, ROAM + HUB + WALK + TRIP
                                     + ASK)
    note = note_of(ledger, "game/script.rpy:27")
    yes = id_of(manifest, "Yes.")
    assert "'Go' continue (reaches the join at game/script.rpy:21 " \
        "through a return to its caller)" in note
    assert (f"continueAt {yes}; its join leads into the if chain at "
            f"game/script.rpy:21, which stays linear, so it continues at "
            f"{yes} (game/script.rpy:22) as that if chain's lines read in "
            "a row") in note


# A menu in a called label: "Go" says a line and opens a nested menu at
# the end of its block, "Wander" calls a label that returns, "Leave"
# returns. The nested menu's join takes the `return` past (item 9o2k), so
# "Wander", stopping at that `return`, meets the others there.
SCENE = ('label scene_a:\n    menu:\n'
         '        "Go":\n            "You go."\n'
         '            menu:\n'
         '                "Tea":\n                    "You drink tea."\n'
         '                "Coffee":\n'
         '                    "You drink coffee."\n'
         '        "Wander":\n            call other\n'
         '        "Leave":\n            return\n'
         '    return\n'
         'label other:\n    "You wander."\n    return\n')


def test_a_lifted_menu_inside_a_continuing_route_reads_on(tmp_path: Path
                                                          ) -> None:
    """Item 9o2k's shape in a route that goes on: the hub's "Explore"
    route calls the scene and jumps back to the hub, inside the start
    menu's "Visit" route, which continues. The scene's menu meets at the
    hub's `jump`, read before, so it was a pure choice whose routes ended
    the story inside that route. It stays linear for its rejoin, as before
    item 9o2k, its lines read on in a row, no "Leave" line of its own; the
    nested menu goes on as those lines do, at "You wander."."""
    out, manifest, ledger = extract(tmp_path, (
        LEAD + '    menu:\n'
        '        "Visit":\n            jump hub\n'
        '        "Skip":\n            "You skip."\n'
        'label after_all:\n    "End."\n    return\n'
        'label hub:\n    "Hub."\n    menu:\n'
        '        "Explore":\n            "You explore."\n'
        '            call scene_a\n            jump hub\n'
        '        "Sleep":\n            "You sleep."\n'
        '            jump after_all\n' + SCENE))
    assert texts(manifest) == ["Lead.", "Hub.", "You explore.", "You go.",
                               "You drink tea.", "You drink coffee.",
                               "You wander.", "You sleep.", "You skip.",
                               "End."]
    decisions = shape(manifest)
    assert decisions[0] == {
        "after": "You go.",
        "routes": [("Tea", "You drink tea.", "You drink tea.", "continue"),
                   ("Coffee", "You drink coffee.", "You drink coffee.",
                    "continue")],
        "continuing": "Coffee", "continueAt": "You wander."}
    assert decisions[1]["routes"][0][-1] == "return"
    assert decisions[2]["routes"][0][-1] == "continue"
    assert skipped(ledger)["game/script.rpy:23"] == (
        "choice 2 (Wander) rejoins content read at game/script.rpy:35, and "
        "the choices' join has no item of its own")
    wander = id_of(manifest, "You wander.")
    assert (f"its choices meet where those of the menu at "
            f"game/script.rpy:23 do, which stays linear, so it continues at "
            f"{wander} (game/script.rpy:37) as that menu's lines read in a "
            "row") in note_of(ledger, "game/script.rpy:26")
    check_folder(tmp_path, out, manifest)


def test_guard_a_new_pure_choice_at_the_story_end_stays_one(tmp_path: Path
                                                            ) -> None:
    """Guard: the loop alone, nothing laid out after the chain: it stays a
    decision with the line before it, its routes ending with the story."""
    out, manifest, _ledger = extract(tmp_path, (
        LEAD + '    jump hub\n' + HUB + WALK + TRIP + ASK))
    assert texts(manifest) == ["Lead.", "Hub.", "You walk.", "You go.",
                               "You stay.", NEXT, "Yes.", "No."]
    assert shape(manifest) == [
        {"after": "You walk.", "routes": ASKED, "continuing": "Stay",
         "continueAt": NEXT},
        {"after": NEXT,
         "routes": [(ARMS[0], "Yes.", "Yes.", "ending"),
                    (ARMS[1], "No.", "No.", "ending")],
         "continuing": None, "continueAt": None}]
    check_folder(tmp_path, out, manifest)


def test_guard_a_chain_whose_join_has_an_item_stays_a_decision(
        tmp_path: Path) -> None:
    """Guard: the chain's candidate comes first, so its `return` goes on
    into the next candidate's line: a decision, continuing there."""
    out, manifest, _ledger = extract(tmp_path, ROAM + HUB + TRIP + WALK
                                     + ASK)
    assert shape(manifest) == [
        {"after": "Hub.", "routes": ASKED, "continuing": "Stay",
         "continueAt": NEXT},
        {"after": NEXT,
         "routes": [(ARMS[0], "Yes.", "Yes.", "continue"),
                    (ARMS[1], "No.", "No.", "continue")],
         "continuing": ARMS[1], "continueAt": "You walk."}]
    check_folder(tmp_path, out, manifest)


def test_guard_a_chain_past_a_lifted_return_stays_a_pure_choice(
        tmp_path: Path) -> None:
    """Guard: the called menu's choices fall through to its `return`, a
    join item 9o2f follows to the caller, which crossed its `return`
    before item 9o2j: the chain was a decision there already, a pure
    choice, and stays one."""
    out, manifest, _ledger = extract(tmp_path, (
        'default go = False\n' + ROAM + HUB + WALK +
        'label trip:\n    call ask\n'
        '    if go:\n        "Yes."\n    else:\n        "No."\n'
        '    return\n'
        'label ask:\n    menu:\n'
        '        "Go":\n            "You go."\n            $ go = True\n'
        '        "Stay":\n            "You stay."\n'
        '            $ go = False\n'
        '    return\n'))
    # The chain follows the called menu's decision: the line before it
    # says so (Phase 60 item 9o3).
    assert texts(manifest) == ["Lead.", "Hub.", "You walk.", "You go.",
                               "You stay.",
                               conditions.Words("en").say("menu.follows"),
                               "Yes.", "No.", "You rest.", "After."]
    assert [r[-1] for r in shape(manifest)[1]["routes"]] == ["ending"] * 2
    assert manifest["branches"][1]["follows"] == manifest["branches"][0]["id"]
    check_folder(tmp_path, out, manifest)


def test_a_menu_in_a_linear_chains_last_arm_takes_the_enclosing_join(
        tmp_path: Path) -> None:
    """A chain kept linear (an arm jumps back to the label) in the "Go"
    route of a called menu, the nested menu in its last arm: the chain's
    lines meet where the called menu's choices do, past the `call`, and
    nothing of the route is laid out after them. The nested menu goes on
    there, at the called menu's `continueAt` (at edee726 a pure choice,
    held with nowhere to go)."""
    out, manifest, ledger = extract(tmp_path, (
        'default x = 1\n' + LEAD + '    call visit\n    "After."\n'
        '    return\n'
        'label visit:\n    menu:\n'
        '        "Go":\n            "You go."\n'
        '            if x == 1:\n                jump visit\n'
        '            else:\n                menu:\n'
        '                    "Tea":\n'
        '                        "You drink tea."\n'
        '                    "Coffee":\n'
        '                        "You drink coffee."\n'
        '        "Stay":\n            return\n    return\n'))
    other = "(x under 1 or x 2 or more)"
    assert texts(manifest) == ["Lead.", "You go.", other, "You drink tea.",
                               "You drink coffee.", "Stay", "After."]
    assert shape(manifest) == [
        {"after": other,
         "routes": [("Tea", "You drink tea.", "You drink tea.", "continue"),
                    ("Coffee", "You drink coffee.", "You drink coffee.",
                     "continue")],
         "continuing": "Coffee", "continueAt": "After."},
        {"after": "Lead.",
         "routes": [("Go", "You go.", "You drink coffee.", "continue"),
                    ("Stay", "Stay", "Stay", "continue")],
         "continuing": "Stay", "continueAt": "After."}]
    assert skipped(ledger)["game/script.rpy:12"] == (
        "choice 1 (x exactly 1) rejoins content read at game/script.rpy:8")
    assert "its choices meet where those of the if chain at " \
        "game/script.rpy:12 do, which stays linear, so it continues at " \
        f"{id_of(manifest, 'After.')} (game/script.rpy:6)" in note_of(
            ledger, "game/script.rpy:15")
    check_folder(tmp_path, out, manifest)
