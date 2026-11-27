"""A route that opens with a nested menu (docs/plan.md Phase 60 item 8c).

A choice whose block starts with a menu (`"B": menu "Inner?": ...`), or
whose path reaches a menu before any item of its own (a jump to a label
that opens with one), would hang the nested decision off the item before
the route: the lead-in's last item for route 1, a sibling route's last
item for a later route. The decision would lie outside its enclosing
route and the join's line would never be shown. Such a route gets its
choice text as its first item, a narration line translated from the
language's `strings` block as an empty choice's is (item 4), and the
nested decision hangs off that line. A later route's line is said over
the visual on screen at the menu (item 8b's repeat).

Each case is a synthetic project extracted end to end and checked as
test_jump_menus checks its folders: `--strict` validation with nothing
printed, `kinetic routes` counts, and `kinetic check --steps all` walking
to the story's end.
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

from test_jump_menus import (LEAD, check_folder, detection, extract, ident,
                             menu_reports, shape, texts)
from test_route_items import by_text, picture, shown


def other_picture(tmp_path: Path) -> None:
    """A second picture beside test_jump_menus' bg.png."""
    images = tmp_path / "proj" / "game" / "images"
    images.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 18), (120, 120, 0)).save(images / "other.png")


INNER = ('            menu "Inner?":\n'
         '                "X":\n                    "X1."\n'
         '                "Y":\n                    "Y1."\n')


def by_after(decisions: list[dict]) -> list[dict]:
    return sorted(decisions, key=lambda d: d["after"])


def test_route_one_opens_with_a_menu(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "A":\n' + INNER +
        '        "B":\n            "B1."\n'
        '    "Join."\n    return\n'))
    assert texts(manifest) == ["Lead.", "A", "X1.", "Y1.", "B1.", "Join."]
    line = by_text(manifest, "A")
    assert line["type"] == "text" and "speaker" not in line
    assert by_after(shape(manifest)) == by_after([
        {"after": "Lead.",
         "routes": [("A", "A", "Y1.", "continue"),
                    ("B", "B1.", "B1.", "continue")],
         "continuing": "B", "continueAt": "Join."},
        {"after": "A",
         "routes": [("X", "X1.", "X1.", "continue"),
                    ("Y", "Y1.", "Y1.", "continue")],
         "continuing": "Y", "continueAt": "Join."}])
    assert menu_reports(ledger) == []
    assert [n["result"] for n in detection(ledger)] == ["detected"] * 2
    check_folder(tmp_path, out, manifest)


def test_a_later_route_opens_with_a_menu(tmp_path: Path) -> None:
    """Route A changed the visual: route B's line is said over the menu's
    picture, a repeat of bg, not over A's."""
    other_picture(tmp_path)
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "A":\n            scene other\n            "A1."\n'
        '        "B":\n' + INNER +
        '    "Join."\n    return\n'))
    assert texts(manifest) == ["Lead.", "A1.", "B", "X1.", "Y1.", "Join."]
    assert by_after(shape(manifest)) == by_after([
        {"after": "Lead.",
         "routes": [("A", "A1.", "A1.", "continue"),
                    ("B", "B", "Y1.", "continue")],
         "continuing": "B", "continueAt": "Join."},
        {"after": "B",
         "routes": [("X", "X1.", "X1.", "continue"),
                    ("Y", "Y1.", "Y1.", "continue")],
         "continuing": "Y", "continueAt": "Join."}])
    line = by_text(manifest, "B")
    assert line["type"] == "image" and "speaker" not in line
    lead = picture(by_text(manifest, "Lead."))
    assert picture(line) == lead
    assert picture(shown(manifest, "X1.")) == lead
    assert picture(shown(manifest, "Y1.")) == lead
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_nested_two_deep(tmp_path: Path) -> None:
    """A route opening with a menu whose route opens with a menu: each
    nested decision hangs off its own route's choice text."""
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "A":\n'
        '            menu "Middle?":\n'
        '                "M":\n'
        '                    menu "Deep?":\n'
        '                        "P":\n'
        '                            "P1."\n'
        '                        "Q":\n'
        '                            "Q1."\n'
        '                "N":\n'
        '                    "N1."\n'
        '        "B":\n            "B1."\n'
        '    "Join."\n    return\n'))
    assert texts(manifest) == ["Lead.", "A", "M", "P1.", "Q1.", "N1.", "B1.",
                               "Join."]
    assert by_after(shape(manifest)) == by_after([
        {"after": "Lead.",
         "routes": [("A", "A", "N1.", "continue"),
                    ("B", "B1.", "B1.", "continue")],
         "continuing": "B", "continueAt": "Join."},
        {"after": "A",
         "routes": [("M", "M", "Q1.", "continue"),
                    ("N", "N1.", "N1.", "continue")],
         "continuing": "N", "continueAt": "Join."},
        {"after": "M",
         "routes": [("P", "P1.", "P1.", "continue"),
                    ("Q", "Q1.", "Q1.", "continue")],
         "continuing": "Q", "continueAt": "Join."}])
    assert menu_reports(ledger) == []
    assert [n["result"] for n in detection(ledger)] == ["detected"] * 3
    check_folder(tmp_path, out, manifest)


def test_a_jump_to_a_label_that_opens_with_a_menu(tmp_path: Path) -> None:
    """The route's path reaches the nested menu through a jump, with no
    item of its own before it: the same line, from the choice."""
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "A":\n            "A1."\n            jump join\n'
        '        "B":\n            jump inner\n'
        'label inner:\n'
        '    menu "Inner?":\n'
        '        "X":\n            "X1."\n            jump join\n'
        '        "Y":\n            "Y1."\n            jump join\n'
        'label join:\n    "Join."\n    return\n'))
    assert texts(manifest) == ["Lead.", "A1.", "B", "X1.", "Y1.", "Join."]
    assert by_after(shape(manifest)) == by_after([
        {"after": "Lead.",
         "routes": [("A", "A1.", "A1.", "continue"),
                    ("B", "B", "Y1.", "continue")],
         "continuing": "B", "continueAt": "Join."},
        {"after": "B",
         "routes": [("X", "X1.", "X1.", "continue"),
                    ("Y", "Y1.", "Y1.", "continue")],
         "continuing": "Y", "continueAt": "Join."}])
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_a_route_with_a_line_before_its_menu_gets_no_text(
        tmp_path: Path) -> None:
    """A route with an item of its own before the nested menu needs no
    line: the nested decision hangs off that item, as before."""
    out, manifest, _ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "A":\n            "A0."\n' + INNER +
        '        "B":\n            "B1."\n'
        '    "Join."\n    return\n'))
    assert texts(manifest) == ["Lead.", "A0.", "X1.", "Y1.", "B1.", "Join."]
    assert by_after(shape(manifest)) == by_after([
        {"after": "Lead.",
         "routes": [("A", "A0.", "Y1.", "continue"),
                    ("B", "B1.", "B1.", "continue")],
         "continuing": "B", "continueAt": "Join."},
        # Its choices fall through to the end of route A: they meet where
        # the outer menu's do, a join, not a pure choice.
        {"after": "A0.",
         "routes": [("X", "X1.", "X1.", "continue"),
                    ("Y", "Y1.", "Y1.", "continue")],
         "continuing": "Y", "continueAt": "Join."}])
    check_folder(tmp_path, out, manifest)


def test_a_route_whose_visual_is_unresolved_keeps_its_line_and_menu(
        tmp_path: Path) -> None:
    """Route B's visual is unresolved, so its line is kept over the last
    visual (Phase 60 item 9n; it used to drop with it, keeping the
    nested menu linear): the line is B's first item, and the nested
    menu hangs off it as a decision of its own."""
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "A":\n            "A1."\n'
        '        "B":\n'
        '            scene missing\n'
        '            "Kept."\n'
        '            menu "Inner?":\n'
        '                "X":\n'
        '                    scene bg\n                    "X1."\n'
        '                "Y":\n'
        '                    scene bg\n                    "Y1."\n'
        '    "Join."\n    return\n'))
    assert texts(manifest) == ["Lead.", "A1.", "Kept.", "X1.", "Y1.",
                               "Join."]
    assert shape(manifest) == [
        {"after": "Kept.",
         "routes": [("X", "X1.", "X1.", "continue"),
                    ("Y", "Y1.", "Y1.", "continue")],
         "continuing": "Y", "continueAt": "Join."},
        {"after": "Lead.",
         "routes": [("A", "A1.", "A1.", "continue"),
                    ("B", "Kept.", "Y1.", "continue")],
         "continuing": "B", "continueAt": "Join."}]
    assert not menu_reports(ledger)
    check_folder(tmp_path, out, manifest)


def tl(code: str, text: str) -> str:
    return f'translate de {ident("start", code)}:\n    "{text}"\n\n'


TL_DE = (tl('"The road splits ahead."', "Der Weg teilt sich.")
         + tl('"You take the left fork."', "Du gehst nach links.")
         + tl('"You take the right fork."', "Du gehst nach rechts.")
         + tl('"You stay where you are."', "Du bleibst hier.")
         + tl('"The paths meet again."', "Die Wege treffen sich.")
         + 'translate de strings:\n'
         '    old "Nested"\n    new "Verschachtelt"\n'
         '    old "Which way?"\n    new "Welcher Weg?"\n'
         '    old "Go deeper"\n    new "Tiefer gehen"\n'
         '    old "Stay"\n    new "Bleib"\n'
         '    old "Left or right?"\n    new "Links oder rechts?"\n'
         '    old "Left"\n    new "Links"\n'
         '    old "Right"\n    new "Rechts"\n')


def test_the_choice_text_is_translated_from_strings(tmp_path: Path) -> None:
    """The route's line is the choice's text, which Ren'Py translates in
    the language's `strings` block: its `lang/de.json` text is that
    block's, as the route label's is."""
    out, manifest, _ledger = extract(
        tmp_path, 'define config.name = "Nested"\n' + (
            'label start:\n    scene bg\n    "The road splits ahead."\n'
            '    menu "Which way?":\n'
            '        "Go deeper":\n'
            '            menu "Left or right?":\n'
            '                "Left":\n'
            '                    "You take the left fork."\n'
            '                "Right":\n'
            '                    "You take the right fork."\n'
            '        "Stay":\n            "You stay where you are."\n'
            '    "The paths meet again."\n    return\n'), tl={"de": TL_DE})
    assert texts(manifest) == [
        "The road splits ahead.", "Go deeper", "You take the left fork.",
        "You take the right fork.", "You stay where you are.",
        "The paths meet again."]
    de = json.loads((out / "lang" / "de.json").read_text("utf-8"))
    assert [de["items"][i["id"]]["text"] for i in manifest["items"]] == [
        "Der Weg teilt sich.", "Tiefer gehen", "Du gehst nach links.",
        "Du gehst nach rechts.", "Du bleibst hier.",
        "Die Wege treffen sich."]
    outer, inner = sorted(manifest["branches"],
                          key=lambda b: b["prompt"] != "Which way?")
    assert inner["after"] == manifest["items"][1]["id"]
    words = {b["id"]: (d["prompt"]["text"],
                       [r["text"] for r in d["routes"].values()])
             for b in (outer, inner)
             for d in [de["decisions"][b["id"]]]}
    assert words == {outer["id"]: ("Welcher Weg?", ["Tiefer gehen", "Bleib"]),
                     inner["id"]: ("Links oder rechts?", ["Links", "Rechts"])}
    check_folder(tmp_path, out, manifest)


def test_no_label_start_file_order(tmp_path: Path) -> None:
    """Read in file order (no `label start`), a route that opens with a
    menu gets its choice text too; every route ends there (no walk
    proves a join), so these are pure choices."""
    out, manifest, ledger = extract(tmp_path, (
        'label opening:\n    scene bg\n    "Lead."\n'
        '    menu:\n'
        '        "A":\n' + INNER +
        '        "B":\n            "B1."\n'))
    assert texts(manifest) == ["Lead.", "A", "X1.", "Y1.", "B1."]
    assert by_after(shape(manifest)) == by_after([
        {"after": "Lead.",
         "routes": [("A", "A", "Y1.", "ending"),
                    ("B", "B1.", "B1.", "ending")],
         "continuing": None, "continueAt": None},
        {"after": "A",
         "routes": [("X", "X1.", "X1.", "ending"),
                    ("Y", "Y1.", "Y1.", "ending")],
         "continuing": None, "continueAt": None}])
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)
