"""Joins through calls and returns (docs/plan.md Phase 60 item 9l).

The walk keeps the call stack: a `return` (or a file's end) inside a
called label goes back to the statement after its `call`, so only a
`return` with nothing on the stack, in the main flow, ends the story. A
menu's choices meet where they meet through those returns: a choice whose
`return` leaves a called label continues in the caller, and the join may
lie past the `call` in the caller. A join whose path opens with a `call`
of a label that shows nothing, or with an `if` that shows nothing, is
still the join: its `continueAt` is the first item the join's path
reaches. A menu whose choices `call` scenes that `return` is a decision
whose routes are the scenes, joining after the menu.

Each case is a synthetic project extracted end to end and checked as
test_jump_menus checks its folders.
"""

from __future__ import annotations

import json
from pathlib import Path

from test_jump_menus import (LEAD, check_folder, detection, extract, ident,
                             menu_reports, ogg, run_kinetic, shape, texts)
from test_shared_tails import spans, thens


def validates_clean(out: Path) -> None:
    proc = run_kinetic("validate", str(out), "--strict")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout == "" and proc.stderr == ""


CALL_MENU = (
    '    menu:\n'
    '        "Visit the lake":\n'
    '            call lake from _call_lake\n'
    '        "Visit the hill":\n'
    '            call hill from _call_hill\n')
SCENES = ('label lake:\n    "At the lake."\n    "The water is cold."\n'
          '    return\n'
          'label hill:\n    "On the hill."\n    return\n')


def test_a_menu_of_calls_joins_after_the_menu(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + CALL_MENU + (
        '    "Home again."\n    return\n') + SCENES)
    assert texts(manifest) == ["Lead.", "At the lake.", "The water is cold.",
                               "On the hill.", "Home again."]
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Visit the lake", "At the lake.", "The water is cold.",
                    "continue"),
                   ("Visit the hill", "On the hill.", "On the hill.",
                    "continue")],
        "continuing": "Visit the hill", "continueAt": "Home again."}]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


CHAPTER = ('label start:\n    scene bg\n    "Lead."\n    call chapter\n'
           '    "Back in the story."\n    return\n')


def test_a_menu_of_calls_in_a_called_label_joins_in_the_caller(
        tmp_path: Path) -> None:
    """The choices meet at the chapter's `return`, which shows nothing:
    the join's first item is the caller's line after the `call`."""
    out, manifest, ledger = extract(tmp_path, CHAPTER + (
        'label chapter:\n    "The chapter opens."\n') + CALL_MENU + (
        '    return\n') + SCENES)
    assert texts(manifest) == ["Lead.", "The chapter opens.", "At the lake.",
                               "The water is cold.", "On the hill.",
                               "Back in the story."]
    assert shape(manifest) == [{
        "after": "The chapter opens.",
        "routes": [("Visit the lake", "At the lake.", "The water is cold.",
                    "continue"),
                   ("Visit the hill", "On the hill.", "On the hill.",
                    "continue")],
        "continuing": "Visit the hill",
        "continueAt": "Back in the story."}]
    (note,) = detection(ledger)
    assert "pure choice" not in note["note"]
    check_folder(tmp_path, out, manifest)


def test_a_hub_of_calls_the_choices_loop_back_to(tmp_path: Path) -> None:
    """A hub label whose choices call a scene and jump back to it: the
    scenes are `"return"` routes, the way on the continuing one."""
    out, manifest, ledger = extract(tmp_path, LEAD + (
        'label hub:\n'
        '    menu:\n'
        '        "Visit the lake":\n'
        '            call lake\n            jump hub\n'
        '        "Visit the hill":\n'
        '            call hill\n            jump hub\n'
        '        "Go home":\n'
        '            "You head home."\n'
        '    "Home again."\n    return\n') + SCENES)
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Visit the lake", "At the lake.", "The water is cold.",
                    "return"),
                   ("Visit the hill", "On the hill.", "On the hill.",
                    "return"),
                   ("Go home", "You head home.", "You head home.",
                    "continue")],
        "continuing": "Go home", "continueAt": "Home again."}]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


TWO = ('    menu:\n'
       '        "Tea":\n            "You drink tea."\n'
       '        "Coffee":\n            "You drink coffee."\n')


def test_a_join_that_opens_with_a_call_of_a_silent_label(
        tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + TWO + (
        '    call setup\n    "After the drink."\n    return\n'
        'label setup:\n    $ cups = 1\n    return\n'))
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Tea", "You drink tea.", "You drink tea.", "continue"),
                   ("Coffee", "You drink coffee.", "You drink coffee.",
                    "continue")],
        "continuing": "Coffee", "continueAt": "After the drink."}]
    assert "pure choice" not in detection(ledger)[0]["note"]
    check_folder(tmp_path, out, manifest)


def test_a_join_that_opens_with_an_if_not_converted(tmp_path: Path) -> None:
    """An `if` on a random roll is no decision: its block's `call` is
    followed and shows nothing, and the join goes on after it."""
    out, manifest, _ledger = extract(tmp_path, LEAD + TWO + (
        '    if renpy.random.random() > 0.5:\n'
        '        call setup\n'
        '    "After the drink."\n    return\n'
        'label setup:\n    $ cups = 1\n    return\n'))
    assert shape(manifest)[0]["continueAt"] == "After the drink."
    assert [r[3] for r in shape(manifest)[0]["routes"]] == ["continue"] * 2
    validates_clean(out)


def test_a_join_that_opens_with_an_if_with_no_line(tmp_path: Path) -> None:
    """A chain whose arms show nothing stays linear and the join goes on
    to the first line after it."""
    out, manifest, _ledger = extract(tmp_path, 'default y = 0\n' + LEAD + (
        '    $ y = 1\n') + TWO + (
        '    if y == 1:\n'
        '        $ cups = 2\n'
        '    "After the drink."\n    return\n'))
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Tea", "You drink tea.", "You drink tea.", "continue"),
                   ("Coffee", "You drink coffee.", "You drink coffee.",
                    "continue")],
        "continuing": "Coffee", "continueAt": "After the drink."}]
    check_folder(tmp_path, out, manifest)


RETURNING = CHAPTER + (
    'label chapter:\n'
    '    "The chapter opens."\n'
    '    menu:\n'
    '        "Leave early":\n'
    '            "You leave early."\n'
    '            return\n'
    '        "Stay":\n'
    '            "You stay."\n'
    '    "The chapter closes."\n'
    '    return\n')


def test_a_choices_return_in_a_called_label_continues_in_the_caller(
        tmp_path: Path) -> None:
    """The choice that returns early skips the chapter's last line: both
    meet back in the caller, the other route reading that line."""
    out, manifest, ledger = extract(tmp_path, RETURNING)
    assert texts(manifest) == ["Lead.", "The chapter opens.",
                               "You leave early.", "You stay.",
                               "The chapter closes.", "Back in the story."]
    assert shape(manifest) == [{
        "after": "The chapter opens.",
        "routes": [("Leave early", "You leave early.", "You leave early.",
                    "continue"),
                   ("Stay", "You stay.", "The chapter closes.", "continue")],
        "continuing": "Stay", "continueAt": "Back in the story."}]
    (note,) = detection(ledger)
    assert "story's end" not in note["note"]
    assert "through a return to its caller" in note["note"]
    check_folder(tmp_path, out, manifest)


def test_a_called_labels_return_ends_nothing_two_calls_deep(
        tmp_path: Path) -> None:
    """A menu in a label called from a called label: the early return
    goes back one call, then the caller's own return another."""
    out, manifest, _ledger = extract(tmp_path, (
        'label start:\n    scene bg\n    "Lead."\n    call part\n'
        '    "Back in the story."\n    return\n'
        'label part:\n    call chapter\n    return\n') + RETURNING[
            len(CHAPTER):])
    assert shape(manifest) == [{
        "after": "The chapter opens.",
        "routes": [("Leave early", "You leave early.", "You leave early.",
                    "continue"),
                   ("Stay", "You stay.", "The chapter closes.", "continue")],
        "continuing": "Stay", "continueAt": "Back in the story."}]
    check_folder(tmp_path, out, manifest)


def test_a_top_level_return_still_ends_the_story(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Leave":\n            "You leave."\n            return\n'
        '        "Stay":\n            "You stay."\n'
        '    "Later."\n    return\n'))
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Leave", "You leave.", "You leave.", "ending"),
                   ("Stay", "You stay.", "You stay.", "continue")],
        "continuing": "Stay", "continueAt": "Later."}]
    assert "story's end" in detection(ledger)[0]["note"]
    check_folder(tmp_path, out, manifest)


def test_a_called_label_inside_a_choice_returns_into_its_route(
        tmp_path: Path) -> None:
    """A choice calls a scene whose own menu has a choice returning
    early: the scene's decision joins in the outer route, after the
    call, and the outer decision at its own join."""
    out, manifest, _ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Go out":\n'
        '            call outing\n'
        '            "Home from the outing."\n'
        '        "Stay in":\n'
        '            "You stay in."\n'
        '    "Night falls."\n    return\n'
        'label outing:\n'
        '    "Out and about."\n'
        '    menu:\n'
        '        "Turn back":\n            "You turn back."\n'
        '            return\n'
        '        "Walk on":\n            "You walk on."\n'
        '    "The walk ends."\n    return\n'))
    decisions = {d["after"]: d for d in shape(manifest)}
    assert decisions["Lead."] == {
        "after": "Lead.",
        "routes": [("Go out", "Out and about.", "Home from the outing.",
                    "continue"),
                   ("Stay in", "You stay in.", "You stay in.", "continue")],
        "continuing": "Stay in", "continueAt": "Night falls."}
    assert decisions["Out and about."] == {
        "after": "Out and about.",
        "routes": [("Turn back", "You turn back.", "You turn back.",
                    "continue"),
                   ("Walk on", "You walk on.", "The walk ends.",
                    "continue")],
        "continuing": "Walk on", "continueAt": "Home from the outing."}
    check_folder(tmp_path, out, manifest)


def test_a_computed_call_candidates_decision_joins_after_the_call(
        tmp_path: Path) -> None:
    out, manifest, _ledger = extract(tmp_path, LEAD + (
        '    $ where = "lake"\n'
        '    call expression where\n'
        '    "Home again."\n    return\n'
        'label lake:\n'
        '    "At the lake."\n') + TWO + '    return\n')
    assert shape(manifest) == [{
        "after": "At the lake.",
        "routes": [("Tea", "You drink tea.", "You drink tea.", "continue"),
                   ("Coffee", "You drink coffee.", "You drink coffee.",
                    "continue")],
        "continuing": "Coffee", "continueAt": "Home again."}]
    validates_clean(out)


def test_a_shared_tail_in_a_called_label_returns_to_the_join(
        tmp_path: Path) -> None:
    out, manifest, _ledger = extract(tmp_path, CHAPTER + (
        'label chapter:\n'
        '    "The chapter opens."\n'
        '    menu:\n'
        '        "Fight":\n            "You swing."\n            jump lose\n'
        '        "Run":\n            "You run."\n            jump lose\n'
        '        "Talk":\n            "You talk."\n'
        '    "Talking helps."\n    return\n'
        'label lose:\n    "You lose."\n    return\n'))
    assert shape(manifest) == [{
        "after": "The chapter opens.",
        "routes": [("Fight", "You swing.", "You swing.", "continue"),
                   ("Run", "You run.", "You run.", "continue"),
                   ("Talk", "You talk.", "Talking helps.", "continue")],
        "continuing": "Talk", "continueAt": "Back in the story."}]
    assert spans(manifest) == {"The chapter opens.": [
        ("shared-lose", "You lose.", "You lose.", "continue")]}
    assert thens(manifest) == {"Fight": "shared-lose", "Run": "shared-lose"}
    check_folder(tmp_path, out, manifest)


def test_lines_and_sound_through_a_return_keep_their_ids_and_cues(
        tmp_path: Path) -> None:
    """The caller's line the join reaches through a return keeps its
    translation, and a sound started in the returning route cues its
    line."""
    script = RETURNING.replace(
        '            "You leave early."\n',
        '            play sound "audio/door.ogg"\n'
        '            "You leave early."\n')
    audio = tmp_path / "proj" / "game" / "audio"
    audio.mkdir(parents=True)
    ogg(audio / "door.ogg", 440)
    tl = (f'translate de {ident("start", '"Back in the story."')}:\n'
          '    "Zurück in der Geschichte."\n\n'
          f'translate de {ident("chapter", '"You leave early."')}:\n'
          '    "Du gehst früh."\n')
    out, manifest, _ledger = extract(tmp_path, script, tl={"de": tl})
    by_text = {i.get("text"): i for i in manifest["items"]}
    de = json.loads((out / "lang" / "de.json").read_text("utf-8"))
    assert de["items"][by_text["Back in the story."]["id"]]["text"] == \
        "Zurück in der Geschichte."
    assert de["items"][by_text["You leave early."]["id"]]["text"] == \
        "Du gehst früh."
    assert "sound" in json.dumps(by_text["You leave early."].get("audio"))
    assert manifest["branches"][0]["continueAt"] == \
        by_text["Back in the story."]["id"]
    # A partial translation: warnings, no problem.
    proc = run_kinetic("validate", str(out))
    assert proc.returncode == 0 and proc.stdout == "", proc.stdout


def test_a_menu_the_walk_never_reaches_says_why(tmp_path: Path) -> None:
    """A menu after a jump in a label the walk reaches is never read: its
    note says so instead of the old "region not completed"."""
    _out, _manifest, ledger = extract(tmp_path, LEAD + (
        '    jump later\n'
        '    menu:\n'
        '        "A":\n            "Never read A."\n'
        '        "B":\n            "Never read B."\n'
        'label later:\n    "Later."\n    return\n'))
    (note,) = detection(ledger)
    assert note["result"] == "skipped"
    assert "region not completed" not in note["reason"]
    assert "no path of the walk reaches it" in note["reason"]


def test_a_return_in_one_of_several_computed_candidates(
        tmp_path: Path) -> None:
    """Of two candidates a `call expression` walks in turn, the first
    holds a menu one choice of which returns early, the other reaching
    the label's own `return`: both meet there, and the decision goes on
    into the next candidate, as the walk lays them out."""
    out, manifest, _ledger = extract(tmp_path, LEAD + (
        '    $ where = renpy.random.choice(["lake", "hill"])\n'
        '    call expression where\n'
        '    "Home again."\n    return\n'
        'label lake:\n'
        '    "At the lake."\n'
        '    menu:\n'
        '        "Tea":\n            "You drink tea."\n            return\n'
        '        "Coffee":\n            "You drink coffee."\n'
        '    return\n'
        'label hill:\n    "On the hill."\n    return\n'))
    assert shape(manifest) == [{
        "after": "At the lake.",
        "routes": [("Tea", "You drink tea.", "You drink tea.", "continue"),
                   ("Coffee", "You drink coffee.", "You drink coffee.",
                    "continue")],
        "continuing": "Coffee", "continueAt": "On the hill."}]
    assert texts(manifest)[-2:] == ["On the hill.", "Home again."]
    validates_clean(out)
