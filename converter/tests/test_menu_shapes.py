"""Menus no longer kept linear (docs/plan.md Phase 60 item 9o).

Each shape that kept a menu linear, and lost its choices' lines, becomes
a decision:

- a conditional choice (`"x" if cond:`) is a route labelled with its
  condition in words, as a counter chain's routes are ("Kiss her (love 3
  or more)"), or "not always offered" when the converter cannot word it;
- a line between choices the walk does not need (a caption, `set`,
  `with`, a `$` line, `pass`) is passed over;
- a `label` inside a choice block is read as Ren'Py flows through it;
- a menu straight after a decision's join gets a line before it, its
  caption or the converter's words, which both decisions hang off;
- a menu every choice of which is empty (a stat choice) is a decision
  whose routes are its choice lines, all `"continue"`;
- choices quoted with `'` are read as `"` ones are, and a say menuitem
  (`e "Which one?"`) is the prompt.

A menu that still stays linear keeps every choice's lines in a row,
reported. Each decision case is a synthetic project extracted end to end
and checked as test_jump_menus checks its folders.
"""

from __future__ import annotations

import json
from pathlib import Path

from kinetic_extract import conditions

from test_conditions import check_translated
from test_conditions import extract as extract_with
from test_jump_menus import (LEAD, check_folder, detection, extract,
                             menu_reports, shape, texts)

NEXT = conditions.Words("en").say("menu.next")


def labels(manifest: dict, index: int = 0) -> list[str]:
    return [r["label"] for r in manifest["branches"][index]["routes"]]


def reports(ledger: dict, start: str) -> list[str]:
    return [r["reason"] for r in ledger["report"]
            if r["reason"].startswith(start)]


# --- conditional choices ----------------------------------------------------

def test_a_counter_condition_labels_its_route(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, (
        'default love = 0\n' + LEAD +
        '    $ love += 1\n'
        '    menu:\n'
        '        "Kiss her" if love >= 3:\n            "You kiss."\n'
        '        "Wave":\n            "You wave."\n'
        '    "After."\n    return\n'))
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Kiss her (love 3 or more)", "You kiss.", "You kiss.",
                    "continue"),
                   ("Wave", "You wave.", "You wave.", "continue")],
        "continuing": "Wave", "continueAt": "After."}]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_flag_and_own_menu_conditions(tmp_path: Path) -> None:
    """A flag set elsewhere is worded "met is set"; a variable the menu's
    own choices set (a hub asking each question once) by its test alone,
    not by the choices that set it."""
    out, manifest, ledger = extract(tmp_path, (
        'default met = False\ndefault asked = False\n' + LEAD +
        '    $ met = True\n'
        'label hub:\n'
        '    menu:\n'
        '        "Greet" if met:\n            "Hello."\n'
        '            jump hub\n'
        '        "Ask" if not asked:\n'
        '            $ asked = True\n            "A question."\n'
        '            jump hub\n'
        '        "Leave":\n            "Bye."\n'
        '    "Out."\n    return\n'))
    assert labels(manifest) == ["Greet (met is set)",
                                "Ask (asked is not set)", "Leave"]
    assert [r["result"] for r in manifest["branches"][0]["routes"]] == [
        "return", "return", "continue"]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_a_condition_the_converter_cannot_word(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Gamble" if renpy.random.random() < 0.5:\n'
        '            "You gamble."\n'
        '        "Walk on":\n            "You walk on."\n'
        '    "After."\n    return\n'))
    assert labels(manifest) == ["Gamble (not always offered)", "Walk on"]
    (why,) = reports(ledger, "menu choice condition not worded")
    assert "calls renpy.random.random" in why
    note = detection(ledger)[0]
    assert note["result"] == "detected"
    check_folder(tmp_path, out, manifest)


def test_a_conditional_route_label_in_a_language_file(
        tmp_path: Path) -> None:
    out, manifest, _ledger, _err = extract_with(tmp_path, (
        'default love = 0\n' + LEAD +
        '    $ love += 1\n'
        '    menu:\n'
        '        "Kiss her" if love >= 3:\n            "You kiss."\n'
        '        "Wave":\n            "You wave."\n'
        '    "After."\n    return\n'), tl={"french": (
            'translate french strings:\n'
            '    old "Kiss her"\n    new "L\'embrasser"\n'
            '    old "Wave"\n    new "Saluer"\n')})
    (decision,) = manifest["branches"]
    fr = json.loads((out / "lang" / "fr.json").read_text("utf-8"))
    routes = fr["decisions"][decision["id"]]["routes"]
    words = conditions.Words("fr")
    assert [routes[r["id"]]["text"] for r in decision["routes"]] == [
        words.say("when", choice="L'embrasser",
                  condition=words.say("atLeast", name="love", n="3")),
        "Saluer"]
    check_translated(tmp_path, out, manifest)


def test_a_lone_conditional_choice_keeps_its_lines(tmp_path: Path) -> None:
    """No decision (one choice), but its lines are read in a row where
    they were lost before."""
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Open it" if key:\n            "It opens."\n'
        '    "After."\n    return\n'))
    assert texts(manifest) == ["Lead.", "It opens.", "After."]
    assert manifest.get("branches", []) == []
    (why,) = menu_reports(ledger)
    assert why == ("menu unsupported (fewer than two choices): branch "
                   "skipped, its choices' lines kept in a row")
    check_folder(tmp_path, out, manifest)


# --- lines between choices -------------------------------------------------

def test_lines_the_walk_does_not_need_are_passed_over(
        tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        set seen\n'
        '        with dissolve\n'
        '        "Which way?"\n'
        '        "Left":\n            "Gone left."\n'
        '        "A caption between choices."\n'
        '        $ noted = True\n'
        '        pass\n'
        '        "Right":\n            "Gone right."\n'
        '    "After."\n    return\n'))
    assert manifest["branches"][0]["prompt"] == "Which way?"
    assert labels(manifest) == ["Left", "Right"]
    assert texts(manifest) == ["Lead.", "Gone left.", "Gone right.",
                               "After."]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_an_unsupported_line_keeps_the_choices_in_a_row(
        tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Left":\n            "Gone left."\n'
        '        show bg\n'
        '        "Right":\n            "Gone right."\n'
        '    "After."\n    return\n'))
    assert manifest.get("branches", []) == []
    assert texts(manifest) == ["Lead.", "Gone left.", "Gone right.",
                               "After."]
    (why,) = menu_reports(ledger)
    assert why.startswith("menu unsupported (unsupported line between "
                          "choices: show bg)")
    assert why.endswith("its choices' lines kept in a row")
    (note,) = detection(ledger)
    assert note["result"] == "skipped"
    check_folder(tmp_path, out, manifest)


def test_single_quoted_choices_and_a_say_menuitem(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, (
        'define e = Character("Eve")\n' + LEAD +
        '    menu:\n'
        '        e "Which one?"\n'
        "        'Tea':\n            \"Tea it is.\"\n"
        "        r'Coffee' (badge=1):\n            \"Coffee it is.\"\n"
        '    "After."\n    return\n'))
    (decision,) = manifest["branches"]
    assert decision["prompt"] == "Which one?"
    assert labels(manifest) == ["Tea", "Coffee"]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


# --- a label in a choice block ----------------------------------------------

def test_a_label_inside_a_choice_block(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Stay":\n'
        '            "You stay."\n'
        '            label stay_more:\n'
        '            "Longer."\n'
        '        "Go":\n            "You go."\n'
        '    "After."\n    return\n'))
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Stay", "You stay.", "Longer.", "continue"),
                   ("Go", "You go.", "You go.", "continue")],
        "continuing": "Go", "continueAt": "After."}]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


# --- a menu straight after a menu ------------------------------------------

def test_a_menu_straight_after_a_menu_gets_a_line(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "A":\n            "Line A."\n'
        '        "B":\n            "Line B."\n'
        '    menu:\n'
        '        "C":\n            "Line C."\n'
        '        "D":\n            "Line D."\n'
        '    "Last."\n    return\n'))
    assert texts(manifest) == ["Lead.", "Line A.", "Line B.", NEXT,
                               "Line C.", "Line D.", "Last."]
    assert [d["continueAt"] for d in shape(manifest)] == [NEXT, "Last."]
    assert shape(manifest)[1]["after"] == NEXT
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_a_captioned_menu_after_a_menu_says_its_caption(
        tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "A":\n            "Line A."\n'
        '        "B":\n            "Line B."\n'
        '    menu:\n'
        '        "Now what?"\n'
        '        "C":\n            "Line C."\n'
        '        "D":\n            "Line D."\n'
        '    "Last."\n    return\n'))
    assert texts(manifest) == ["Lead.", "Line A.", "Line B.", "Now what?",
                               "Line C.", "Line D.", "Last."]
    assert manifest["branches"][1]["prompt"] == "Now what?"
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


# --- stat choices ------------------------------------------------------------

def test_a_stat_choice_is_a_decision_of_its_choice_lines(
        tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, (
        'default kind = 0\n' + LEAD +
        '    menu:\n'
        '        "Be kind":\n            $ kind += 1\n'
        '        "Be cruel":\n            $ kind -= 1\n'
        '    "She looks at you."\n    return\n'))
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Be kind", "Be kind", "Be kind", "continue"),
                   ("Be cruel", "Be cruel", "Be cruel", "continue")],
        "continuing": "Be cruel", "continueAt": "She looks at you."}]
    assert menu_reports(ledger) == []
    assert detection(ledger)[0]["result"] == "detected"
    check_folder(tmp_path, out, manifest)


def test_a_stat_choice_then_a_menu(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Smile":\n            $ mood = 1\n'
        '        "Frown":\n            $ mood = 2\n'
        '    menu:\n'
        '        "Stay":\n            "You stay."\n'
        '        "Leave":\n            "You leave."\n'
        '    "Last."\n    return\n'))
    assert texts(manifest) == ["Lead.", "Smile", "Frown", NEXT,
                               "You stay.", "You leave.", "Last."]
    assert [d["continueAt"] for d in shape(manifest)] == [NEXT, "Last."]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_the_line_before_a_menu_in_a_language_file(tmp_path: Path) -> None:
    out, manifest, _ledger, _err = extract_with(tmp_path, LEAD + (
        '    menu:\n'
        '        "A":\n            "Line A."\n'
        '        "B":\n            "Line B."\n'
        '    menu:\n'
        '        "C":\n            "Line C."\n'
        '        "D":\n            "Line D."\n'
        '    "Last."\n    return\n'), tl={"french": (
            'translate french strings:\n'
            '    old "A"\n    new "A fr"\n')})
    line = next(i for i in manifest["items"] if i.get("text") == NEXT)
    fr = json.loads((out / "lang" / "fr.json").read_text("utf-8"))
    assert fr["items"][line["id"]]["text"] == "Un autre choix suit."
    check_translated(tmp_path, out, manifest)
