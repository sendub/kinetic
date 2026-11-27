"""The converter lays a shared tail out once (docs/plan.md Phase 60 item
9i). A label that two or more routes of one decision reach before the
decision's join (nested decisions' routes included) is laid out once, as
a `shared` span of the innermost decision enclosing every route reaching
it, after that decision's routes and before its `continueAt`; each route
reaching it gets `then` naming the span, and the span's `result` follows
where the label goes: `"continue"` to the join, `"ending"` at the story's
end, `"return"` back to the menu's lead-in. A route's own `result` is what
an older player, which ignores `then`, acts on. A label whose run holds a
menu of its own (a span holds no decision) stays linear, reported as
before ("rejoins content read at ...").

Each case is a synthetic project extracted end to end; every folder
validates `--strict` with nothing printed (no never-shown item), and one
is walked by `kinetic check --steps all` to the story's end.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

from test_jump_menus import (LEAD, check_folder, detection, extract, ident,
                             menu_reports, ogg, run_kinetic, shape, texts)
from test_route_items import picture, shown


def spans(manifest: dict) -> dict[str, list[tuple[str, str, str, str]]]:
    """Each decision's shared spans by its `after` text: (id, first text,
    last text, result)."""
    text_of = {i["id"]: i.get("text") for i in manifest["items"]}
    return {text_of[b["after"]]: [
        (s["id"], text_of[s["start"]], text_of[s["end"]],
         s.get("result", "ending")) for s in b["shared"]]
        for b in manifest.get("branches", []) if "shared" in b}


def thens(manifest: dict) -> dict[str, str]:
    """Route label -> the span its `then` names."""
    return {r["label"]: r["then"] for b in manifest.get("branches", [])
            for r in b["routes"] if "then" in r}


def by_after(decisions: list[dict]) -> list[dict]:
    return sorted(decisions, key=lambda d: d["after"])


def validates_clean(out: Path) -> None:
    """`kinetic validate --strict` exits 0 with nothing printed: no
    problem and no warning, never-shown items included."""
    proc = run_kinetic("validate", str(out), "--strict")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout == "" and proc.stderr == ""


def other_picture(tmp_path: Path) -> None:
    images = tmp_path / "proj" / "game" / "images"
    images.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 18), (120, 120, 0)).save(images / "other.png")


FAIL_SCRIPT = LEAD + (
    '    menu "What now?":\n'
    '        "Fight":\n'
    '            "You swing."\n'
    '            jump lose\n'
    '        "Run":\n'
    '            "You run."\n'
    '            jump lose\n'
    '        "Talk":\n'
    '            scene other\n'
    '            "You talk."\n'
    '            jump after\n'
    'label lose:\n'
    '    "You lose."\n'
    '    "It hurts."\n'
    '    jump after\n'
    'label after:\n'
    '    "After."\n'
    '    return\n')

FAIL_DE = (f'translate de {ident("lose", '"You lose."')}:\n'
           '    "Du verlierst."\n\n'
           'translate de strings:\n'
           '    old "What now?"\n    new "Was nun?"\n')


def test_two_choices_to_one_failure_label_that_rejoins(tmp_path: Path
                                                       ) -> None:
    other_picture(tmp_path)
    out, manifest, ledger = extract(tmp_path, FAIL_SCRIPT)
    assert texts(manifest) == [
        "Lead.", "You swing.", "You run.", "You talk.", "You lose.",
        "It hurts.", "After."]
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Fight", "You swing.", "You swing.", "continue"),
                   ("Run", "You run.", "You run.", "continue"),
                   ("Talk", "You talk.", "You talk.", "continue")],
        "continuing": "Talk", "continueAt": "After."}]
    (decision,) = manifest["branches"]
    assert [(r["label"], r["result"]) for r in decision["routes"]] == [
        ("Fight", "continue"), ("Run", "continue"), ("Talk", "continue")]
    assert decision["continuingRoute"] == decision["routes"][2]["id"]
    assert spans(manifest) == {"Lead.": [
        ("shared-lose", "You lose.", "It hurts.", "continue")]}
    assert thens(manifest) == {"Fight": "shared-lose", "Run": "shared-lose"}
    assert menu_reports(ledger) == []
    (note,) = detection(ledger)
    assert note["result"] == "detected"
    assert "shared span shared-lose" in note["note"]
    # The span's first line is said over the picture on screen where the
    # first route reached it, not the last route's.
    assert picture(shown(manifest, "You lose.")) == picture(
        shown(manifest, "You swing."))
    assert picture(shown(manifest, "You lose.")) != picture(
        shown(manifest, "You talk."))
    check_folder(tmp_path, out, manifest)


def test_a_shared_tails_lines_are_translated(tmp_path: Path) -> None:
    other_picture(tmp_path)
    out, manifest, _ledger = extract(tmp_path, FAIL_SCRIPT,
                                     tl={"de": FAIL_DE})
    assert thens(manifest) == {"Fight": "shared-lose", "Run": "shared-lose"}
    de = json.loads((out / "lang" / "de.json").read_text("utf-8"))
    lose = next(i for i in manifest["items"] if i.get("text") == "You lose.")
    assert de["items"][lose["id"]]["text"] == "Du verlierst."
    decision = manifest["branches"][0]
    assert de["decisions"][decision["id"]]["prompt"]["text"] == "Was nun?"


def test_audio_in_a_shared_tail_cues_its_first_item(tmp_path: Path) -> None:
    script = FAIL_SCRIPT.replace(
        'label lose:\n', 'label lose:\n    play music "audio/sad.ogg"\n')
    audio = tmp_path / "proj" / "game" / "audio"
    audio.mkdir(parents=True)
    ogg(audio / "sad.ogg", 330)
    other_picture(tmp_path)
    out, manifest, ledger = extract(tmp_path, script)
    assert thens(manifest) == {"Fight": "shared-lose", "Run": "shared-lose"}
    lose = next(i for i in manifest["items"] if i.get("text") == "You lose.")
    assert "music" in json.dumps(lose.get("audio", {}))
    talk = next(i for i in manifest["items"] if i.get("text") == "You talk.")
    assert "audio" not in talk


def nested(first: str) -> str:
    """Climb holds a menu both of whose choices go on to `fall`: its
    join, read by the Climb route; Swim, an outer route, reaches `fall`
    too. ``first`` names the outer route listed (and walked) first."""
    climb = ('        "Climb":\n'
             '            "You climb."\n'
             '            menu:\n'
             '                "Jump":\n'
             '                    "You jump."\n'
             '                    jump fall\n'
             '                "Hold":\n'
             '                    "You hold on."\n'
             '            jump fall\n')
    swim = ('        "Swim":\n'
            '            "You swim."\n'
            '            jump fall\n')
    return LEAD + (
        '    menu:\n' + (climb + swim if first == "Climb" else swim + climb)
        + '        "Wait":\n'
        '            "You wait."\n'
        '            jump home\n'
        'label fall:\n'
        '    "You fall."\n'
        '    jump home\n'
        'label home:\n'
        '    "Home."\n'
        '    return\n')


def test_a_nested_choice_and_an_outer_choice_to_one_label(tmp_path: Path
                                                          ) -> None:
    """The nested decision's choices meet at `fall`, which the outer
    route Swim also reaches: the span is the outer decision's, the Climb
    route holding the nested decision names it, and the nested decision
    joins at the span's first item."""
    out, manifest, ledger = extract(tmp_path, nested("Climb"))
    assert texts(manifest) == [
        "Lead.", "You climb.", "You jump.", "You hold on.", "You swim.",
        "You wait.", "You fall.", "Home."]
    assert by_after(shape(manifest)) == by_after([
        {"after": "Lead.",
         "routes": [("Climb", "You climb.", "You hold on.", "continue"),
                    ("Swim", "You swim.", "You swim.", "continue"),
                    ("Wait", "You wait.", "You wait.", "continue")],
         "continuing": "Wait", "continueAt": "Home."},
        {"after": "You climb.",
         "routes": [("Jump", "You jump.", "You jump.", "continue"),
                    ("Hold", "You hold on.", "You hold on.", "continue")],
         "continuing": "Hold", "continueAt": "You fall."}])
    assert spans(manifest) == {"Lead.": [
        ("shared-fall", "You fall.", "You fall.", "continue")]}
    assert thens(manifest) == {"Climb": "shared-fall", "Swim": "shared-fall"}
    assert menu_reports(ledger) == []
    validates_clean(out)


def test_an_outer_choice_first_then_a_nested_one(tmp_path: Path) -> None:
    """The same with Swim read first: the nested decision's join is
    content already read, and still the span's first item."""
    out, manifest, ledger = extract(tmp_path, nested("Swim"))
    assert texts(manifest) == [
        "Lead.", "You swim.", "You climb.", "You jump.", "You hold on.",
        "You wait.", "You fall.", "Home."]
    assert by_after(shape(manifest))[1] == {
        "after": "You climb.",
        "routes": [("Jump", "You jump.", "You jump.", "continue"),
                   ("Hold", "You hold on.", "You hold on.", "continue")],
        "continuing": "Hold", "continueAt": "You fall."}
    assert spans(manifest) == {"Lead.": [
        ("shared-fall", "You fall.", "You fall.", "continue")]}
    assert thens(manifest) == {"Swim": "shared-fall", "Climb": "shared-fall"}
    assert menu_reports(ledger) == []
    validates_clean(out)


@pytest.mark.parametrize("first", ["Climb", "Swim"])
def test_a_label_a_nested_route_reaches_alone_stays_linear(
        tmp_path: Path, first: str) -> None:
    """Jump, a route of the decision nested in Climb, goes on to `fall`
    where its sibling Hold does not. Naming the outer decision's span,
    Jump would leave both decisions' routes there, and Play all routes
    (each route entered once a pass) would never read Hold: both menus
    stay linear, reported as before."""
    script = nested(first).replace(
        '                    "You hold on."\n'
        '            jump fall\n',
        '                    "You hold on."\n'
        '            "You reach the top."\n'
        '            jump home\n')
    out, manifest, ledger = extract(tmp_path, script)
    assert spans(manifest) == {} and thens(manifest) == {}
    reasons = menu_reports(ledger)
    assert all("rejoins content read at game/script.rpy:" in r
               for r in reasons), reasons
    # With Climb first, Jump reads `fall` first and only Swim rejoins it:
    # the nested decision is one as before, the outer menu linear. With
    # Swim first, Jump rejoins it too: both menus linear.
    expected = {"Climb": ["You climb."], "Swim": []}[first]
    assert [next(i.get("text") for i in manifest["items"]
                 if i["id"] == b["after"])
            for b in manifest.get("branches", [])] == expected
    assert len(reasons) == 2 - len(expected)
    validates_clean(out)


def test_a_shared_label_ending_the_story(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Fight":\n            "You swing."\n            jump lose\n'
        '        "Run":\n            "You run."\n            jump lose\n'
        '        "Talk":\n            "You talk."\n            jump after\n'
        '        "Sing":\n            "You sing."\n            jump after\n'
        '        "Wait":\n            "You wait."\n            jump after\n'
        'label lose:\n    "You lose."\n    "The end."\n    return\n'
        'label after:\n    "After."\n    return\n'))
    assert [t for t in texts(manifest)] == [
        "Lead.", "You swing.", "You run.", "You talk.", "You sing.",
        "You wait.", "You lose.", "The end.", "After."]
    (decision,) = manifest["branches"]
    assert [(r["label"], r["result"]) for r in decision["routes"]] == [
        ("Fight", "ending"), ("Run", "ending"), ("Talk", "continue"),
        ("Sing", "continue"), ("Wait", "continue")]
    assert spans(manifest) == {"Lead.": [
        ("shared-lose", "You lose.", "The end.", "ending")]}
    assert thens(manifest) == {"Fight": "shared-lose", "Run": "shared-lose"}
    assert menu_reports(ledger) == []
    validates_clean(out)


def test_a_shared_label_returning_to_the_menu(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        'label ask:\n'
        '    "Will you come?"\n'
        '    menu:\n'
        '        "Maybe":\n            "Hmm."\n            jump think\n'
        '        "Perhaps":\n            "Well."\n            jump think\n'
        '        "Yes":\n            "Yes!"\n            jump go\n'
        'label think:\n'
        '    "You think it over."\n'
        '    jump ask\n'
        'label go:\n'
        '    "We go."\n'
        '    return\n'))
    assert texts(manifest) == ["Lead.", "Will you come?", "Hmm.", "Well.",
                               "Yes!", "You think it over.", "We go."]
    (decision,) = manifest["branches"]
    assert [(r["label"], r["result"]) for r in decision["routes"]] == [
        ("Maybe", "return"), ("Perhaps", "return"), ("Yes", "continue")]
    assert spans(manifest) == {"Will you come?": [
        ("shared-think", "You think it over.", "You think it over.",
         "return")]}
    assert thens(manifest) == {"Maybe": "shared-think",
                               "Perhaps": "shared-think"}
    assert menu_reports(ledger) == []
    validates_clean(out)


def test_a_shared_label_holding_a_menu_stays_linear(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Fight":\n            "You swing."\n            jump lose\n'
        '        "Run":\n            "You run."\n            jump lose\n'
        '        "Talk":\n            "You talk."\n            jump after\n'
        'label lose:\n'
        '    "You lose."\n'
        '    menu:\n'
        '        "Retry":\n            "Again."\n'
        '        "Give up":\n            "No."\n'
        '    jump after\n'
        'label after:\n    "After."\n    return\n'))
    assert texts(manifest) == ["Lead.", "You swing.", "You lose.", "Again.",
                               "No.", "You run.", "You talk.", "After."]
    assert spans(manifest) == {}
    assert thens(manifest) == {}
    assert all(b["after"] != manifest["items"][0]["id"]
               for b in manifest.get("branches", []))
    reasons = menu_reports(ledger)
    assert any("choice 2 (Run) rejoins content read at game/script.rpy:"
               in r for r in reasons), reasons
    validates_clean(out)
