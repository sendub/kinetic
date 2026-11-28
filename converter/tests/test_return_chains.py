"""Every join into the caller crosses its `return` (docs/plan.md Phase 60
item 9o2j).

A menu in a called label whose choices `return` (`return 1`, `return 2`)
meets past the `call`, in the caller (item 9l). Item 9o2f treated only a
join it lifted through a `return` (choices that fall through to it) as
reached through that `return`, so a chain on `_return` that a choice's
`return` reaches stayed linear ("the menu follows the menu ... with no
line between"), its arms read in a row, where past a lifted join the
same chain is a decision with item 9o2b's line before it. Every join in
the caller is now reached through the `return`: the chain past it is a
decision with that line, which the called menu continues at. A menu or
chain there that stays linear for a reason of its own still gets no line
and holds the decision (item 9o2g), and a `return` with no call under
way still ends the story.

A chain that becomes a decision this way can keep the next chain, met
straight after its join, linear (item 9o). A decision nested in a block
of a menu or chain kept linear, meeting where its blocks do, took the
enclosing `continueAt`, which a linear menu has none of: a pure choice,
its routes `"ending"`. It now goes on as the linear blocks' lines do, at
the next block's first item or past the enclosing join.

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
# A called stat choice whose choices return the value the caller reads.
TALK = ('label talk:\n'
        '    menu:\n'
        '        "Rest":\n            return 1\n'
        '        "Wait":\n            return 2\n')
RESTS = [("Rest", "Rest", "Rest", "continue"),
         ("Wait", "Wait", "Wait", "continue")]
CHAIN = ('    if _return == 1:\n        "One."\n'
         '    else:\n        "Other."\n')
ARMS = ["_return is 1", "_return is not 1"]


def skipped(ledger: dict) -> dict[str, str]:
    return {n["source"]: n["reason"] for n in detection(ledger)
            if n["result"] == "skipped"}


def note_of(ledger: dict, source: str) -> str:
    return next(n.get("note", "") for n in detection(ledger)
                if n["source"] == source)


def test_a_return_chain_past_returning_choices_is_a_decision(
        tmp_path: Path) -> None:
    """The chain on `_return` that the choices' `return`s reach is a
    decision with item 9o2b's line before it: the called menu continues
    at the line, the chain's routes at the line after it."""
    out, manifest, ledger = extract(tmp_path, (
        LEAD + '    call talk\n' + CHAIN + '    "After."\n    return\n'
        + TALK))
    assert texts(manifest) == ["Lead.", "Rest", "Wait", NEXT, "One.",
                               "Other.", "After."]
    assert shape(manifest) == [
        {"after": "Lead.", "routes": RESTS, "continuing": "Wait",
         "continueAt": NEXT},
        {"after": NEXT,
         "routes": [(ARMS[0], "One.", "One.", "continue"),
                    (ARMS[1], "Other.", "Other.", "continue")],
         "continuing": ARMS[1], "continueAt": "After."}]
    assert skipped(ledger) == {}
    assert ("follows another decision's join, past a return"
            in note_of(ledger, "game/script.rpy:5"))
    check_folder(tmp_path, out, manifest)


def test_choices_with_lines_that_return_values(tmp_path: Path) -> None:
    """Each choice says a line before its `return`: the same, the called
    menu's routes its lines."""
    out, manifest, _ledger = extract(tmp_path, (
        LEAD + '    call talk\n' + CHAIN + '    "After."\n    return\n'
        + TALK.replace('            return 1\n',
                       '            "You rest."\n            return 1\n')
        .replace('            return 2\n',
                 '            "You wait."\n            return 2\n')))
    assert texts(manifest) == ["Lead.", "You rest.", "You wait.", NEXT,
                               "One.", "Other.", "After."]
    decisions = shape(manifest)
    assert decisions[0]["continueAt"] == NEXT
    assert [r[-1] for r in decisions[0]["routes"]] == ["continue"] * 2
    assert decisions[1]["after"] == NEXT
    assert [r[-1] for r in decisions[1]["routes"]] == ["continue"] * 2
    assert decisions[1]["continueAt"] == "After."
    check_folder(tmp_path, out, manifest)


def test_a_return_chain_in_an_enclosing_choice(tmp_path: Path) -> None:
    """The `call` and its chain sit in a choice of an enclosing menu: the
    chain is a decision inside that route, which goes on where the
    enclosing decision does."""
    out, manifest, _ledger = extract(tmp_path, (
        LEAD + '    menu:\n'
        '        "Visit":\n            call talk\n'
        + ''.join('        ' + line + '\n' for line in CHAIN.splitlines())
        + '        "Stay":\n            "You stay."\n'
        '    "After."\n    return\n' + TALK))
    assert texts(manifest) == ["Lead.", "Visit", "Rest", "Wait", NEXT,
                               "One.", "Other.", "You stay.", "After."]
    assert shape(manifest) == [
        {"after": "Visit", "routes": RESTS, "continuing": "Wait",
         "continueAt": NEXT},
        {"after": NEXT,
         "routes": [(ARMS[0], "One.", "One.", "continue"),
                    (ARMS[1], "Other.", "Other.", "continue")],
         "continuing": ARMS[1], "continueAt": "After."},
        {"after": "Lead.",
         "routes": [("Visit", "Visit", "Other.", "continue"),
                    ("Stay", "You stay.", "You stay.", "continue")],
         "continuing": "Stay", "continueAt": "After."}]
    check_folder(tmp_path, out, manifest)


def test_a_quiet_chain_past_returning_choices_holds_the_decision(
        tmp_path: Path) -> None:
    """The chain past the `return` shows nothing, so it stays linear for
    a reason of its own: no line, and the called menu waits on past it to
    the next line (item 9o2g), its routes continuing."""
    out, manifest, ledger = extract(tmp_path, (
        'default points = 3\n' + LEAD + '    call talk\n'
        '    if points > 1:\n        $ points = 0\n'
        '    else:\n        $ points = 1\n'
        '    "After."\n    return\n' + TALK))
    assert texts(manifest) == ["Lead.", "Rest", "Wait", "After."]
    assert shape(manifest) == [{"after": "Lead.", "routes": RESTS,
                                "continuing": "Wait",
                                "continueAt": "After."}]
    assert skipped(ledger) == {
        "game/script.rpy:6": "every choice is empty: none reads anything "
                             "before where the choices meet"}
    check_folder(tmp_path, out, manifest)


def test_return_chains_that_call_labels_showing_nothing(tmp_path: Path
                                                        ) -> None:
    """The shape that made item 9o2f's first try of this rule a
    regression: chains on `_return` past the called menu, each arm
    calling a label that shows nothing, so the first stays linear (every
    choice empty). Before item 9o2g held the decision there, it became a
    pure choice, its routes `"ending"`; held, it waits on past the
    chains to the next line, its routes continuing."""
    out, manifest, ledger = extract(tmp_path, (
        'default points = 3\n' + LEAD + '    call talk\n'
        '    if _return == 1:\n        call tally\n'
        '    if _return == 2:\n        call tally\n'
        '    "After."\n    return\n'
        'label tally:\n    $ points += 1\n    return\n' + TALK))
    assert texts(manifest) == ["Lead.", "Rest", "Wait", "After."]
    assert shape(manifest) == [{"after": "Lead.", "routes": RESTS,
                                "continuing": "Wait",
                                "continueAt": "After."}]
    assert "game/script.rpy:6" in skipped(ledger)
    assert "pure choice" not in note_of(ledger, "game/script.rpy:16")
    check_folder(tmp_path, out, manifest)


def test_a_lone_choice_past_returning_choices_holds_the_decision(
        tmp_path: Path) -> None:
    """A menu of one conditional choice past the `return` stays linear:
    no line, the called menu continuing at its line."""
    out, manifest, ledger = extract(tmp_path, (
        'default seen = False\n' + LEAD + '    call talk\n'
        '    menu:\n        "North" if seen:\n            "North."\n'
        '    "After."\n    return\n' + TALK))
    assert texts(manifest) == ["Lead.", "Rest", "Wait", "North.", "After."]
    assert shape(manifest) == [{"after": "Lead.", "routes": RESTS,
                                "continuing": "Wait",
                                "continueAt": "North."}]
    assert skipped(ledger) == {"game/script.rpy:6": "fewer than two choices"}
    check_folder(tmp_path, out, manifest)


def test_returning_choices_at_the_story_end_still_end(tmp_path: Path
                                                      ) -> None:
    """The caller's next statement ends the story: the called menu is a
    pure choice, its routes `"ending"`, as before."""
    out, manifest, _ledger = extract(tmp_path, (
        LEAD + '    call talk\n    return\n' + TALK))
    assert texts(manifest) == ["Lead.", "Rest", "Wait"]
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [(label, first, last, "ending")
                   for label, first, last, _r in RESTS],
        "continuing": None, "continueAt": None}]
    check_folder(tmp_path, out, manifest)


def test_a_return_chain_at_the_story_end(tmp_path: Path) -> None:
    """The chain is the story's last statement: the called menu continues
    at its line, and the chain's routes end with the story."""
    out, manifest, _ledger = extract(tmp_path, (
        LEAD + '    call talk\n' + CHAIN + '    return\n' + TALK))
    assert texts(manifest) == ["Lead.", "Rest", "Wait", NEXT, "One.",
                               "Other."]
    assert shape(manifest) == [
        {"after": "Lead.", "routes": RESTS, "continuing": "Wait",
         "continueAt": NEXT},
        {"after": NEXT,
         "routes": [(ARMS[0], "One.", "One.", "ending"),
                    (ARMS[1], "Other.", "Other.", "ending")],
         "continuing": None, "continueAt": None}]
    check_folder(tmp_path, out, manifest)


# The called menu's choices return three values; the first chain's first
# arm ends the story, and the second chain, straight after the first's
# join, stays linear (item 9o: no line between).
ASK = ('label ask:\n'
       '    menu:\n'
       '        "A":\n            return 1\n'
       '        "B":\n            return 2\n'
       '        "C":\n            return 3\n')
INNER = ('label inner:\n'
         '    if flag:\n        return\n'
         '    "Inner."\n    return\n'
         'label setflag:\n    $ flag = True\n    return\n')


def test_a_decision_in_a_chain_kept_linear_past_the_return(tmp_path: Path
                                                           ) -> None:
    """The first chain on `_return` is now a decision, so the second,
    straight after its join, stays linear, its arms read in a row. The
    chain in the label its first arm calls meets where that linear chain
    does: it goes on as the linear chain's lines do, at the next arm's
    line (before the fix its routes ended, a pure choice, where Ren'Py
    goes on)."""
    out, manifest, ledger = extract(tmp_path, (
        'default flag = False\n' + LEAD + '    call ask\n'
        '    if _return == 1:\n        "One."\n        return\n'
        '    if _return == 2:\n        call inner\n'
        '    "Tail."\n    return\n' + ASK + INNER))
    assert texts(manifest) == [
        "Lead.", "A", "B", "C", NEXT, "One.", "(_return is not 1)",
        "(_return is 2)", "(flag is set)", "Inner.", "(_return is not 2)",
        "Tail."]
    assert shape(manifest) == [
        {"after": "Lead.",
         "routes": [(x, x, x, "continue") for x in "ABC"],
         "continuing": "C", "continueAt": NEXT},
        {"after": NEXT,
         "routes": [(ARMS[0], "One.", "One.", "ending"),
                    (ARMS[1], "(_return is not 1)", "(_return is not 1)",
                     "continue")],
         "continuing": ARMS[1], "continueAt": "(_return is 2)"},
        {"after": "(_return is 2)",
         "routes": [("flag is set", "(flag is set)", "(flag is set)",
                     "continue"),
                    ("flag is not set", "Inner.", "Inner.", "continue")],
         "continuing": "flag is not set",
         "continueAt": "(_return is not 2)"}]
    assert skipped(ledger) == {
        "game/script.rpy:9": "the menu follows the menu at "
                             "game/script.rpy:6 with no line between"}
    check_folder(tmp_path, out, manifest)


def chain_holding(arm: str, other: str) -> str:
    """A chain kept linear straight after a menu's join, its arms ``arm``
    and ``other``, then a line."""
    return ('default points = 3\n' + LEAD + '    menu:\n'
            '        "Tea":\n            "You drink tea."\n'
            '            $ points += 1\n'
            '        "Coffee":\n            "You drink coffee."\n'
            '    if points > 1:\n' + arm + '    else:\n' + other +
            '    "After."\n    return\n')


NESTED = ('        "Strong."\n'
          '        menu:\n'
          '            "North":\n                "North."\n'
          '            "South":\n                "South."\n')


def test_a_menu_in_a_linear_chains_arm_goes_on(tmp_path: Path) -> None:
    """A menu in the first arm of a chain kept linear meets where the
    chain's arms do: it continues at the next arm's line, read in a row
    after it, as the linear chain's lines are (before, a pure choice, its
    routes `"ending"`)."""
    out, manifest, _ledger = extract(tmp_path, chain_holding(
        NESTED, '        "Weak."\n'))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", "Strong.", "North.",
                               "South.", "Weak.", "After."]
    assert shape(manifest)[1] == {
        "after": "Strong.",
        "routes": [("North", "North.", "North.", "continue"),
                   ("South", "South.", "South.", "continue")],
        "continuing": "South", "continueAt": "Weak."}
    check_folder(tmp_path, out, manifest)


def test_a_menu_in_a_linear_chains_last_arm_goes_on(tmp_path: Path
                                                    ) -> None:
    """In the chain's last arm, the menu waits on to the chain's join, the
    line after it."""
    out, manifest, _ledger = extract(tmp_path, chain_holding(
        '        "Weak."\n', NESTED))
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", "Weak.", "Strong.",
                               "North.", "South.", "After."]
    assert shape(manifest)[1] == {
        "after": "Strong.",
        "routes": [("North", "North.", "North.", "continue"),
                   ("South", "South.", "South.", "continue")],
        "continuing": "South", "continueAt": "After."}
    check_folder(tmp_path, out, manifest)
