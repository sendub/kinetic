"""Conditions become decisions (docs/plan.md Phase 60 item 6;
docs/extracting.md, "Conditions").

An `if`/`elif`/`else` chain whose conditions all read one variable the
game's script sets is a fork whose arms carry their statements, laid out
by the walk as a menu's choices are, and becomes a decision with every
route `"continue"` to where the arms meet:

- a variable only one decision's choices set (literals, with its
  `default`) gives a decision that `follows` that one, each route's
  `when` the choices that take its arm;
- a counter compared with whole numbers gives an ordinary decision
  labelled by ranges ("love 3 or more");
- any other one-variable condition gives an ordinary decision labelled
  "If you chose: A" when only menu choices satisfy the arm, else the
  condition in words ("met_x is set").

The labels and prompt are converter words of the player's catalogue,
written in the game's base language and in each language file's own
words (English where the catalogue lacks the language). Each case is a
synthetic project extracted end to end and checked as test_jump_menus
checks its folders: validate `--strict` silent, `kinetic routes` counts,
`kinetic check --steps all` to the story's end.
"""

from __future__ import annotations

import json
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from kinetic_extract import conditions, paths
from kinetic_extract.cli import main as cli_main
from kinetic_extract.parser import parse_file

from test_jump_menus import (check_folder, detection, ident, line_of, ogg,
                             run_kinetic, texts)

PROMPT = "Which fits your story so far?"
LEAD = 'label start:\n    scene bg\n    "Lead."\n'
WHO = ('    menu "Who?":\n'
       '        "Wake Robin":\n'
       '            $ met = "robin"\n'
       '            "You wake Robin."\n'
       '        "Leave":\n'
       '            $ met = "none"\n'
       '            "You leave."\n'
       '    "Later."\n')


def extract(tmp_path: Path, script: str, *args: str,
            tl: dict[str, str] | None = None,
            ) -> tuple[Path, dict, dict, str]:
    """Extract a one-script project; (folder, manifest, ledger, stderr)."""
    game = tmp_path / "proj" / "game"
    (game / "images").mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 18), (40, 60, 80)).save(game / "images" / "bg.png")
    (game / "script.rpy").write_text(script, encoding="utf-8")
    for name, text in (tl or {}).items():
        (game / "tl" / name).mkdir(parents=True)
        (game / "tl" / name / "script.rpy").write_text(text,
                                                       encoding="utf-8")
    out = tmp_path / "out"
    err = StringIO()
    with redirect_stdout(StringIO()), redirect_stderr(err):
        assert cli_main([str(game.parent), str(out), *args]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    return out, manifest, ledger, err.getvalue()


def decision_shape(manifest: dict, index: int = -1) -> dict[str, Any]:
    """A decision by text: prompt, follows (the followed decision's index),
    each route's (label, first text, last text, result, when as the
    followed routes' labels), continueAt."""
    text_of = {i["id"]: i.get("text") for i in manifest["items"]}
    branches = manifest["branches"]
    b = branches[index]
    followed = None
    labels: dict[str, str] = {}
    if "follows" in b:
        followed = next(k for k, d in enumerate(branches)
                        if d["id"] == b["follows"])
        labels = {r["id"]: r["label"] for r in branches[followed]["routes"]}
    return {
        "prompt": b["prompt"],
        "follows": followed,
        "routes": [(r["label"], text_of[r["start"]], text_of[r["end"]],
                    r.get("result", "ending"),
                    [labels[w] for w in r["when"]] if "when" in r else None)
                   for r in b["routes"]],
        "continueAt": text_of.get(b.get("continueAt")),
    }


def check_translated(tmp_path: Path, out: Path, manifest: dict) -> None:
    """check_folder for a folder whose language files translate only
    some lines: validate finds no problem (its warnings name the lines
    left untranslated), then the walk to the end."""
    proc = run_kinetic("validate", str(out))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout == ""
    assert "no translation" in proc.stderr
    play = tmp_path / "play"
    proc = run_kinetic("assemble", str(out), str(play))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    proc = run_kinetic("check", str(play), "--steps", "all",
                       "--no-media-check")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "story ended" in proc.stdout


def condition_reports(ledger: dict) -> list[str]:
    return [r["reason"] for r in ledger["report"]
            if "if chain" in r["reason"] or "skipped `if`" in r["reason"]
            or r["reason"].startswith("unrecognized statement: if")]


# --- a variable one menu's choices set: `follows` ----------------------------

def test_a_chain_following_a_menus_choice_with_else(tmp_path: Path) -> None:
    script = LEAD + WHO + (
        '    if met == "robin":\n'
        '        "Robin waves."\n'
        '    else:\n'
        '        "Nobody waves."\n'
        '    "The end."\n'
        '    return\n')
    out, manifest, ledger, _err = extract(tmp_path, script)
    assert texts(manifest) == ["Lead.", "You wake Robin.", "You leave.",
                               "Later.", "Robin waves.", "Nobody waves.",
                               "The end."]
    assert decision_shape(manifest) == {
        "prompt": PROMPT, "follows": 0,
        "routes": [
            ("If you chose: Wake Robin", "Robin waves.", "Robin waves.",
             "continue", ["Wake Robin"]),
            ("If you chose: Leave", "Nobody waves.", "Nobody waves.",
             "continue", ["Leave"])],
        "continueAt": "The end."}
    chain = manifest["branches"][-1]
    assert chain["continuingRoute"] == chain["routes"][-1]["id"]
    at = line_of(script, "if met")
    assert chain["id"] == f"if-start-{at}"
    assert condition_reports(ledger) == []
    note = next(n for n in detection(ledger)
                if n["source"] == f"game/script.rpy:{at}")
    assert note["result"] == "detected"
    assert "from a condition on met" in note["note"]
    assert f"follows {manifest['branches'][0]['id']}" in note["note"]
    check_folder(tmp_path, out, manifest)


def test_a_chain_without_else_passes_the_choices_it_leaves(
        tmp_path: Path) -> None:
    out, manifest, ledger, _err = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Red":\n'
        '            $ pick = "r"\n'
        '            "Red it is."\n'
        '        "Green":\n'
        '            $ pick = "g"\n'
        '            "Green it is."\n'
        '        "Blue":\n'
        '            $ pick = "b"\n'
        '            "Blue it is."\n'
        '    "Later."\n'
        '    if pick == "r":\n'
        '        "Red again."\n'
        '    elif pick == "g":\n'
        '        "Green again."\n'
        '    "The end."\n'
        '    return\n'))
    assert texts(manifest) == ["Lead.", "Red it is.", "Green it is.",
                               "Blue it is.", "Later.", "Red again.",
                               "Green again.", "The end."]
    assert decision_shape(manifest) == {
        "prompt": PROMPT, "follows": 0,
        "routes": [
            ("If you chose: Red", "Red again.", "Red again.", "continue",
             ["Red"]),
            ("If you chose: Green", "Green again.", "Green again.",
             "continue", ["Green"])],
        "continueAt": "The end."}
    note = detection(ledger)[-1]["note"]
    assert "the choices there no arm takes pass it" in note
    # Three arms, the absent `else` left out: the note counts the 2
    # routes the decision has (item 9b).
    assert note.startswith(
        f"decision {manifest['branches'][-1]['id']}: 2 routes:")
    assert "start as" not in note
    check_folder(tmp_path, out, manifest)


def test_an_absent_else_is_a_route_when_no_other_arm_goes_on(
        tmp_path: Path) -> None:
    """The choices an absent `else` takes pass a following decision at
    its join; when every other arm ends the story there is no join to
    pass to, so the absent `else` is a route."""
    out, manifest, _ledger, _err = extract(tmp_path, LEAD + THREE + (
        '    if x == "a":\n'
        '        "A ends it."\n'
        '        return\n'
        '    elif x == "b":\n'
        '        "B ends it."\n'
        '        return\n'
        '    "C goes on."\n'
        '    return\n'))
    assert decision_shape(manifest) == {
        "prompt": PROMPT, "follows": 0,
        "routes": [
            ("If you chose: A", "A ends it.", "A ends it.", "ending",
             ["A"]),
            ("If you chose: B", "B ends it.", "B ends it.", "ending",
             ["B"]),
            ("If you chose: C", "(If you chose: C)", "(If you chose: C)",
             "continue", ["C"])],
        "continueAt": "C goes on."}
    check_folder(tmp_path, out, manifest)


def test_one_arm_without_else_keeps_the_rest_as_a_route(
        tmp_path: Path) -> None:
    """A decision needs two routes: the absent `else` of a one-arm chain
    is a route whose one line is its label in parentheses."""
    out, manifest, _ledger, _err = extract(tmp_path, LEAD + WHO + (
        '    if met == "robin":\n'
        '        "Robin waves."\n'
        '    "The end."\n'
        '    return\n'))
    assert texts(manifest)[-3:] == ["Robin waves.", "(If you chose: Leave)",
                                    "The end."]
    assert decision_shape(manifest) == {
        "prompt": PROMPT, "follows": 0,
        "routes": [
            ("If you chose: Wake Robin", "Robin waves.", "Robin waves.",
             "continue", ["Wake Robin"]),
            ("If you chose: Leave", "(If you chose: Leave)",
             "(If you chose: Leave)", "continue", ["Leave"])],
        "continueAt": "The end."}
    check_folder(tmp_path, out, manifest)


THREE = ('    menu:\n'
         '        "A":\n'
         '            $ x = "a"\n'
         '            "Took A."\n'
         '        "B":\n'
         '            $ x = "b"\n'
         '            "Took B."\n'
         '        "C":\n'
         '            $ x = "c"\n'
         '            "Took C."\n'
         '    "Later."\n')


def test_not_equal_and_in(tmp_path: Path) -> None:
    out, manifest, _ledger, _err = extract(tmp_path, LEAD + THREE + (
        '    if x != "a":\n'
        '        "Not A."\n'
        '    else:\n'
        '        "Was A."\n'
        '    "Between."\n'
        '    if x in ("a", "b"):\n'
        '        "A or B."\n'
        '    elif x not in ["a", "b"]:\n'
        '        "Not A or B."\n'
        '    "The end."\n'
        '    return\n'))
    assert decision_shape(manifest, 1) == {
        "prompt": PROMPT, "follows": 0,
        "routes": [
            ("If you chose: B or C", "Not A.", "Not A.", "continue",
             ["B", "C"]),
            ("If you chose: A", "Was A.", "Was A.", "continue", ["A"])],
        "continueAt": "Between."}
    assert decision_shape(manifest, 2) == {
        "prompt": PROMPT, "follows": 0,
        "routes": [
            ("If you chose: A or B", "A or B.", "A or B.", "continue",
             ["A", "B"]),
            ("If you chose: C", "Not A or B.", "Not A or B.", "continue",
             ["C"])],
        "continueAt": "The end."}
    check_folder(tmp_path, out, manifest)


def test_an_arm_no_choice_takes_is_dropped(tmp_path: Path) -> None:
    """Only the menu's choices set x: an arm none of their values takes
    never runs in the game, so its lines are left out, reported."""
    script = LEAD + THREE + (
        '    if x == "a":\n'
        '        "Was A."\n'
        '    elif x == "z":\n'
        '        "Never."\n'
        '    else:\n'
        '        "B or C."\n'
        '    "The end."\n'
        '    return\n')
    out, manifest, ledger, _err = extract(tmp_path, script)
    assert "Never." not in texts(manifest)
    assert [r[0] for r in decision_shape(manifest)["routes"]] == [
        "If you chose: A", "If you chose: B or C"]
    at = line_of(script, 'elif x == "z"')
    assert any(r["source"] == f"game/script.rpy:{at}"
               and "never taken" in r["reason"] for r in ledger["report"])
    check_folder(tmp_path, out, manifest)


def test_arms_that_jump_before_rejoining(tmp_path: Path) -> None:
    out, manifest, _ledger, _err = extract(tmp_path, LEAD + WHO + (
        '    if met == "robin":\n'
        '        jump with_sam\n'
        '    else:\n'
        '        jump alone\n'
        'label with_sam:\n'
        '    "Robin talks."\n'
        '    jump after\n'
        'label alone:\n'
        '    "Silence."\n'
        '    jump after\n'
        'label after:\n'
        '    "After."\n'
        '    return\n'))
    assert decision_shape(manifest) == {
        "prompt": PROMPT, "follows": 0,
        "routes": [
            ("If you chose: Wake Robin", "Robin talks.", "Robin talks.",
             "continue", ["Wake Robin"]),
            ("If you chose: Leave", "Silence.", "Silence.", "continue",
             ["Leave"])],
        "continueAt": "After."}
    check_folder(tmp_path, out, manifest)


def test_audio_in_an_arm_comes_with_it(tmp_path: Path) -> None:
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    ogg(game / "ding.ogg", 660)
    out, manifest, ledger, _err = extract(tmp_path, LEAD + WHO + (
        '    if met == "robin":\n'
        '        play sound "ding.ogg"\n'
        '        "Robin waves."\n'
        '    else:\n'
        '        "Nobody waves."\n'
        '    "The end."\n'
        '    return\n'))
    waves = next(i for i in manifest["items"] if i.get("text") == "Robin waves.")
    assert waves["audio"]["sfx"], waves
    assert not any("skipped" in r for r in condition_reports(ledger))
    check_folder(tmp_path, out, manifest)


def test_a_chain_inside_a_route(tmp_path: Path) -> None:
    out, manifest, _ledger, _err = extract(tmp_path, LEAD + WHO + (
        '    menu "Where?":\n'
        '        "Park":\n'
        '            "At the park."\n'
        '            if met == "robin":\n'
        '                "Robin is at the park."\n'
        '            else:\n'
        '                "The park is empty."\n'
        '            "You walk home."\n'
        '        "Home":\n'
        '            "At home."\n'
        '    "The end."\n'
        '    return\n'))
    text_of = {i["id"]: i.get("text") for i in manifest["items"]}
    # The chain closes before the menu holding it, so comes first.
    chain, where = manifest["branches"][1], manifest["branches"][2]
    assert where["prompt"] == "Where?"
    assert text_of[chain["after"]] == "At the park."
    assert text_of[chain["continueAt"]] == "You walk home."
    park = where["routes"][0]
    assert (text_of[park["start"]], text_of[park["end"]]) == (
        "At the park.", "You walk home.")
    assert decision_shape(manifest, 1)["follows"] == 0
    check_folder(tmp_path, out, manifest)


def test_a_chain_inside_a_choice_of_the_menu_it_reads_is_ordinary(
        tmp_path: Path) -> None:
    """A decision cannot follow one that encloses it: inside the menu
    whose choices set x, the chain is an ordinary decision."""
    out, manifest, _ledger, _err = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Wake Robin":\n'
        '            $ met = "robin"\n'
        '            "You wake Robin."\n'
        '            if met == "robin":\n'
        '                "Robin yawns."\n'
        '            else:\n'
        '                "Odd."\n'
        '            "Robin gets up."\n'
        '        "Leave":\n'
        '            $ met = "none"\n'
        '            "You leave."\n'
        '    "The end."\n'
        '    return\n'))
    # The chain closes before the menu holding it, so comes first.
    chain = manifest["branches"][0]
    assert "follows" not in chain
    assert [r["label"] for r in chain["routes"]] == [
        "If you chose: Wake Robin", "If you chose: Leave"]
    check_folder(tmp_path, out, manifest)


# --- counters: ranges in words -----------------------------------------------

COUNTER = ('default love = 0\n' + LEAD +
           '    menu:\n'
           '        "Smile":\n'
           '            $ love += 2\n'
           '            "You smile."\n'
           '        "Frown":\n'
           '            $ love -= 1\n'
           '            "You frown."\n'
           '    "Then."\n'
           '    menu:\n'
           '        "Hug":\n'
           '            $ love += 1\n'
           '            "You hug."\n'
           '        "Wave":\n'
           '            "You wave."\n'
           '    "Later."\n'
           '    if love >= 3:\n'
           '        "Very close."\n'
           '    elif love >= 1:\n'
           '        "Friends."\n'
           '    else:\n'
           '        "Strangers."\n'
           '    "The end."\n'
           '    return\n')


def test_a_counter_chain_with_three_ranges(tmp_path: Path) -> None:
    out, manifest, ledger, _err = extract(tmp_path, COUNTER)
    assert decision_shape(manifest) == {
        "prompt": PROMPT, "follows": None,
        "routes": [
            ("love 3 or more", "Very close.", "Very close.", "continue",
             None),
            ("love 1 or 2", "Friends.", "Friends.", "continue", None),
            ("love under 1", "Strangers.", "Strangers.", "continue",
             None)],
        "continueAt": "The end."}
    note = detection(ledger)[-1]
    assert "from a condition on love" in note["note"]
    assert "kind ranges" in note["note"]
    check_folder(tmp_path, out, manifest)


@pytest.mark.parametrize(("arms", "labels"), [
    ('    if love == 2:\n        "Two."\n'
     '    elif love > 5:\n        "Many."\n'
     '    elif love <= 5:\n        "Some."\n',
     ["love exactly 2", "love 6 or more",
      "love under 2 or love 3 to 5"]),
    ('    if love != 1:\n        "Not one."\n',
     ["love under 1 or love 2 or more", "love exactly 1"]),
])
def test_range_wordings(tmp_path: Path, arms: str,
                        labels: list[str]) -> None:
    out, manifest, _ledger, _err = extract(tmp_path, (
        'default love = 0\n' + LEAD +
        '    $ love += 1\n'
        '    "Later."\n' + arms +
        '    "The end."\n'
        '    return\n'))
    assert [r["label"] for r in manifest["branches"][-1]["routes"]] == labels
    check_folder(tmp_path, out, manifest)


# --- other conditions: choices or words --------------------------------------

def test_a_flag_set_in_two_menus(tmp_path: Path) -> None:
    out, manifest, _ledger, _err = extract(tmp_path, (
        'default met_x = False\n' + LEAD +
        '    menu:\n'
        '        "Wake Robin":\n'
        '            $ met_x = True\n'
        '            "You wake Robin."\n'
        '        "Sleep":\n'
        '            "You sleep."\n'
        '    "Then."\n'
        '    menu:\n'
        '        "Call Robin":\n'
        '            $ met_x = True\n'
        '            "You call."\n'
        '        "Stay":\n'
        '            "You stay."\n'
        '    "Later."\n'
        '    if met_x:\n'
        '        "Robin is here."\n'
        '    else:\n'
        '        "Alone."\n'
        '    "Between."\n'
        '    if met_x:\n'
        '        "Robin again."\n'
        '    "The end."\n'
        '    return\n'))
    assert decision_shape(manifest, 2) == {
        "prompt": PROMPT, "follows": None,
        "routes": [
            ("If you chose: Wake Robin or Call Robin", "Robin is here.",
             "Robin is here.", "continue", None),
            ("met_x is not set", "Alone.", "Alone.", "continue", None)],
        "continueAt": "Between."}
    assert decision_shape(manifest, 3)["routes"] == [
        ("If you chose: Wake Robin or Call Robin", "Robin again.", "Robin again.",
         "continue", None),
        ("met_x is not set", "(met_x is not set)", "(met_x is not set)",
         "continue", None)]
    check_folder(tmp_path, out, manifest)


def test_a_flag_set_in_label_flow_is_said_in_words(tmp_path: Path) -> None:
    out, manifest, _ledger, _err = extract(tmp_path, (
        'default met_x = False\n' + LEAD +
        '    menu:\n'
        '        "Go":\n'
        '            jump go\n'
        '        "Stay":\n'
        '            "You stay."\n'
        '    jump later\n'
        'label go:\n'
        '    $ met_x = True\n'
        '    "You go."\n'
        'label later:\n'
        '    "Later."\n'
        '    if not met_x:\n'
        '        "No Robin."\n'
        '    else:\n'
        '        "Robin."\n'
        '    "The end."\n'
        '    return\n'))
    assert [r["label"] for r in manifest["branches"][-1]["routes"]] == [
        "met_x is not set", "met_x is set"]
    check_folder(tmp_path, out, manifest)


# --- an initial value set in label flow (item 6c) ----------------------------

# A menu whose choices set `pick` (Shrug sets nothing), and a chain on it:
# the value Shrug leaves is the one `pick` had before the menu.
ASK = ('label ask:\n'
       '    "Ask."\n'
       '    menu:\n'
       '        "Stay":\n'
       '            $ pick = "stay"\n'
       '            jump stay\n'
       '        "Leave":\n'
       '            $ pick = "leave"\n'
       '            jump leave\n'
       '        "Shrug":\n'
       '            jump after\n'
       'label stay:\n'
       '    "You stay."\n'
       '    jump after\n'
       'label leave:\n'
       '    "You leave."\n'
       '    jump after\n'
       'label after:\n'
       '    "Later."\n')
CHAIN = ('    if pick == "stay":\n'
         '        "You stayed."\n'
         '    elif pick == "none":\n'
         '        "You shrugged."\n'
         '    else:\n'
         '        "You left."\n'
         '    "The end."\n'
         '    return\n')
FOLLOWING = [
    ("If you chose: Stay", "You stayed.", "You stayed.", "continue",
     ["Stay"]),
    ("If you chose: Shrug", "You shrugged.", "You shrugged.", "continue",
     ["Shrug"]),
    ("If you chose: Leave", "You left.", "You left.", "continue",
     ["Leave"])]


def condition_kinds(ledger: dict) -> list[tuple[str, str | None]]:
    return [(c["kind"], c["follows"]) for c in ledger.get("conditions", [])]


def test_a_reset_in_label_flow_before_the_menu_is_its_value(
        tmp_path: Path) -> None:
    """`$ pick = "none"` before the menu is the value of the choices that
    set nothing, as a `default` is: the chain follows the menu."""
    script = (LEAD + '    $ pick = "none"\n    jump ask\n' + ASK + CHAIN)
    out, manifest, ledger, _err = extract(tmp_path, script)
    shape = decision_shape(manifest)
    assert shape["follows"] == 0
    assert shape["routes"] == FOLLOWING
    assert shape["continueAt"] == "The end."
    assert condition_kinds(ledger) == [
        ("follows", manifest["branches"][0]["id"])]
    # The note and the record name the reset (item 9b), and the report
    # shows it.
    reset = f"game/script.rpy:{line_of(script, '$ pick = \"none\"')}"
    chain = manifest["branches"][-1]
    note = next(n["note"] for n in detection(ledger)
                if n["note"].startswith(f"decision {chain['id']}:"))
    assert note.startswith(f"decision {chain['id']}: 3 routes:")
    assert ('the choices there that set nothing start as "none" from the '
            f"reset at {reset}") in note
    (record,) = ledger["conditions"]
    assert record["startingValue"] == {"value": "none", "resets": [reset],
                                       "default": None}
    proc = run_kinetic("report", str(out))
    assert proc.returncode == 0, proc.stderr
    assert (f'    the choices that set nothing start as "none" from the '
            f"reset at {reset}") in proc.stdout
    proc = run_kinetic("report", str(out), "--json")
    assert proc.returncode == 0, proc.stderr
    (listed,) = json.loads(proc.stdout)["conditions"]
    assert listed["startingValue"] == record["startingValue"]
    check_folder(tmp_path, out, manifest)


def test_several_resets_before_the_menu_take_the_last(
        tmp_path: Path) -> None:
    """Resets one after another before the menu: the last is the value,
    and the only one the note names."""
    script = (LEAD + '    $ pick = "stay"\n    "Wake."\n'
              '    $ pick = "none"\n    $ pick = "none"\n    jump ask\n'
              + ASK + CHAIN)
    out, manifest, ledger, _err = extract(tmp_path, script)
    shape = decision_shape(manifest)
    assert shape["follows"] == 0
    assert shape["routes"] == FOLLOWING
    last = line_of(script, "jump ask") - 1
    (record,) = ledger["conditions"]
    assert record["startingValue"] == {
        "value": "none", "resets": [f"game/script.rpy:{last}"],
        "default": None}
    assert (f'start as "none" from the reset at game/script.rpy:{last})'
            in detection(ledger)[-1]["note"])
    check_folder(tmp_path, out, manifest)


def test_resets_and_a_default_that_agree_are_all_named(
        tmp_path: Path) -> None:
    """Two ways to the menu: one passes a reset, the other none, and the
    `default` gives the same value: the note names the reset and the
    default."""
    script = ('default pick = "none"\n' + LEAD +
              '    menu:\n'
              '        "Detour":\n'
              '            jump detour\n'
              '        "Straight":\n'
              '            "Straight on."\n'
              '    jump ask\n'
              'label detour:\n'
              '    $ pick = "none"\n'
              '    "A detour."\n'
              '    jump ask\n' + ASK + CHAIN)
    out, manifest, ledger, _err = extract(tmp_path, script)
    assert decision_shape(manifest, -1)["follows"] == 1
    reset = f"game/script.rpy:{line_of(script, '$ pick = \"none\"')}"
    (record,) = ledger["conditions"]
    assert record["startingValue"] == {
        "value": "none", "resets": [reset], "default": "game/script.rpy:1"}
    assert (f'start as "none" from the reset at {reset} and the default at '
            "game/script.rpy:1") in detection(ledger)[-1]["note"]
    check_folder(tmp_path, out, manifest)


def test_a_reset_in_an_earlier_label_reached_by_a_jump(
        tmp_path: Path) -> None:
    """The reset's label comes after the menu in the file, but the walk
    reaches it first: walk order, not file order, counts."""
    script = (LEAD + '    jump prologue\n' + ASK + CHAIN +
              'label prologue:\n'
              '    $ pick = "none"\n'
              '    "Prologue."\n'
              '    jump ask\n')
    out, manifest, ledger, _err = extract(tmp_path, script)
    shape = decision_shape(manifest)
    assert shape["follows"] == 0
    assert shape["routes"] == FOLLOWING
    assert condition_kinds(ledger)[0][0] == "follows"
    check_folder(tmp_path, out, manifest)


def test_a_second_reset_after_the_menu_is_words(tmp_path: Path) -> None:
    script = (LEAD + '    $ pick = "none"\n    jump ask\n' + ASK
              + '    $ pick = "none"\n' + CHAIN)
    out, manifest, ledger, _err = extract(tmp_path, script)
    assert decision_shape(manifest)["follows"] is None
    assert condition_kinds(ledger) == [("words", None)]
    check_folder(tmp_path, out, manifest)


def test_a_reset_in_another_menus_choice_is_words(tmp_path: Path) -> None:
    script = (LEAD + '    $ pick = "none"\n'
              '    menu:\n'
              '        "Forget":\n'
              '            $ pick = "none"\n'
              '            "You forget."\n'
              '        "Remember":\n'
              '            "You remember."\n'
              '    jump ask\n' + ASK + CHAIN)
    out, manifest, ledger, _err = extract(tmp_path, script)
    assert decision_shape(manifest)["follows"] is None
    assert condition_kinds(ledger) == [("words", None)]
    check_folder(tmp_path, out, manifest)


def test_resets_that_differ_on_the_way_to_the_menu_are_words(
        tmp_path: Path) -> None:
    """One way to the menu passes a second reset, the other does not:
    the value before the menu is not one literal."""
    script = (LEAD + '    $ pick = "none"\n'
              '    menu:\n'
              '        "Detour":\n'
              '            jump detour\n'
              '        "Straight":\n'
              '            "Straight on."\n'
              '    jump ask\n'
              'label detour:\n'
              '    $ pick = "stay"\n'
              '    "A detour."\n'
              '    jump ask\n' + ASK + CHAIN)
    out, manifest, ledger, _err = extract(tmp_path, script)
    assert decision_shape(manifest)["follows"] is None
    assert condition_kinds(ledger) == [("words", None)]
    check_folder(tmp_path, out, manifest)


def test_a_reset_in_a_loop_that_runs_again_after_the_menu_is_words(
        tmp_path: Path) -> None:
    script = (LEAD + 'label again:\n'
              '    $ pick = "none"\n'
              '    "Ask."\n'
              '    menu:\n'
              '        "Stay":\n'
              '            $ pick = "stay"\n'
              '            "You stay."\n'
              '        "Leave":\n'
              '            $ pick = "leave"\n'
              '            "You leave."\n'
              '    "Later."\n'
              '    if pick == "stay":\n'
              '        "You stayed."\n'
              '    else:\n'
              '        "You left."\n'
              '    menu:\n'
              '        "Again":\n'
              '            "Once more."\n'
              '            jump again\n'
              '        "Done":\n'
              '            "Done."\n'
              '    "The end."\n'
              '    return\n')
    out, manifest, ledger, _err = extract(tmp_path, script)
    (cond,) = ledger["conditions"]
    assert (cond["kind"], cond["follows"]) == ("words", None)
    check_folder(tmp_path, out, manifest)


@pytest.mark.parametrize(("condition", "why"), [
    ("renpy.random.randint(1, 2) == 1", "renpy"),
    ('met == "robin" and seen', "one variable"),
    ("persistent.ending", "persistent"),
    ("never_set", "not set by the script"),
    ("_seen", "starts with _"),
])
def test_an_unreadable_condition_stays_as_today(tmp_path: Path,
                                                condition: str,
                                                why: str) -> None:
    script = LEAD + WHO + (
        f'    if {condition}:\n'
        '        play sound "ding.ogg"\n'
        '        "Hidden."\n'
        '    else:\n'
        '        "Also hidden."\n'
        '    "The end."\n'
        '    return\n')
    out, manifest, ledger, _err = extract(tmp_path, script)
    assert "Hidden." not in texts(manifest)
    assert "Also hidden." not in texts(manifest)
    assert len(manifest["branches"]) == 1
    reasons = condition_reports(ledger)
    assert "audio inside a skipped `if` block: not converted" in reasons
    at = line_of(script, f"if {condition}")
    (head,) = [r for r in ledger["report"]
               if r["source"] == f"game/script.rpy:{at}"]
    assert head["reason"].startswith("if chain not converted (")
    assert why in head["reason"]
    check_folder(tmp_path, out, manifest)


def test_parse_file_reads_a_chain_on_a_variable_it_sets() -> None:
    parsed = parse_file(
        'default seen = False\n'
        'label start:\n'
        '    "A."\n'
        '    if seen:\n'
        '        "B."\n'
        '    else:\n'
        '        "C."\n'
        '    "D."\n', "game/x.rpy")
    (fork,) = [e for e in parsed.events if e.kind == "fork"]
    assert fork.flow.menu is not None
    record = parsed.menus[fork.flow.menu]
    assert record.condition is not None
    assert record.condition.variable == "seen"
    assert [[e.text for e in body if e.kind == "dialogue"]
            for body in fork.flow.bodies] == [["B."], ["C."]]
    assert not any("unrecognized" in r.reason for r in parsed.reports)


# --- words in every language -------------------------------------------------

FRENCH = {
    "converter.condition.prompt": "Qu'est-ce qui correspond à votre histoire ?",
    "converter.condition.chose": "Si vous avez choisi : {choice}",
    "converter.condition.or": "{first} ou {second}",
    "converter.condition.atLeast": "{name} {n} ou plus",
    "converter.condition.between": "{name} de {low} à {high}",
    "converter.condition.either": "{name} {low} ou {high}",
    "converter.condition.exactly": "{name} exactement {n}",
    "converter.condition.under": "{name} moins de {n}",
    "converter.condition.otherwise": "Sinon",
    "converter.condition.set": "{name} est défini",
    "converter.condition.notSet": "{name} n'est pas défini",
    "converter.condition.is": "{name} est {value}",
    "converter.condition.isNot": "{name} n'est pas {value}",
    "converter.condition.aside": "({label})",
    "converter.condition.when": "{choice} ({condition})",
    "converter.condition.sometimes": "pas toujours proposé",
    "converter.menu.next": "Un autre choix suit.",
    "converter.menu.follows": "Votre choix précédent décide de la suite.",
    "converter.menu.prompt": "Que se passe-t-il ensuite ?",
}


@pytest.fixture
def french_words(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The catalogue's words with French added (item 6b translates the
    real catalogue)."""
    table = json.loads(paths.CONDITION_WORDS_FILE.read_text("utf-8"))
    table["languages"] = {"en": table["languages"]["en"], "fr": FRENCH}
    words = tmp_path / "condition-words.json"
    words.write_text(json.dumps(table), encoding="utf-8")
    monkeypatch.setattr(conditions, "WORDS_FILE", words)
    conditions.load_words.cache_clear()
    yield
    conditions.load_words.cache_clear()


def test_the_catalogue_file_has_every_english_phrase() -> None:
    table = json.loads(paths.CONDITION_WORDS_FILE.read_text("utf-8"))
    assert set(table["languages"]["en"]) == set(FRENCH)
    assert table["languages"]["en"]["converter.condition.prompt"] == PROMPT


TL_STRINGS = {
    "english": ('translate english strings:\n'
                '    old "Réveiller Robin"\n    new "Wake Robin"\n'
                '    old "Partir"\n    new "Leave"\n'),
    "german": ('translate german strings:\n'
               '    old "Réveiller Robin"\n    new "Robin wecken"\n'
               '    old "Partir"\n    new "Gehen"\n'),
}
FR_WHO = WHO.replace("Wake Robin", "Réveiller Robin").replace("Leave", "Partir")


@pytest.mark.usefixtures("french_words")
def test_a_french_game_and_its_language_files(tmp_path: Path) -> None:
    out, manifest, ledger, _err = extract(
        tmp_path, LEAD + FR_WHO + (
            '    if met == "robin":\n'
            '        "Robin salue."\n'
            '    "Fin."\n'
            '    return\n'),
        "--base-language", "fr", tl=TL_STRINGS)
    chain = manifest["branches"][-1]
    assert chain["prompt"] == FRENCH["converter.condition.prompt"]
    assert [r["label"] for r in chain["routes"]] == [
        "Si vous avez choisi : Réveiller Robin",
        "Si vous avez choisi : Partir"]
    assert "(Si vous avez choisi : Partir)" in texts(manifest)
    aside = next(i["id"] for i in manifest["items"]
                 if i.get("text") == "(Si vous avez choisi : Partir)")
    en = json.loads((out / "lang" / "en.json").read_text("utf-8"))
    de = json.loads((out / "lang" / "de.json").read_text("utf-8"))
    for data in (en, de):
        assert data["decisions"][chain["id"]]["prompt"]["text"] == PROMPT
    assert [en["decisions"][chain["id"]]["routes"][r["id"]]["text"]
            for r in chain["routes"]] == ["If you chose: Wake Robin",
                                          "If you chose: Leave"]
    # German is not in this fixture's catalogue (en and fr only):
    # English words, German choices.
    assert [de["decisions"][chain["id"]]["routes"][r["id"]]["text"]
            for r in chain["routes"]] == ["If you chose: Robin wecken",
                                          "If you chose: Gehen"]
    assert en["items"][aside]["text"] == "(If you chose: Leave)"
    assert de["items"][aside]["text"] == "(If you chose: Gehen)"
    (record,) = ledger["conditions"]
    assert record["decision"] == chain["id"]
    assert record["englishFor"] == ["de"]
    check_translated(tmp_path, out, manifest)
    proc = run_kinetic("report", str(out))
    assert proc.returncode == 0, proc.stderr
    assert "Decisions made from conditions: 1" in proc.stdout
    assert f"{chain['id']}" in proc.stdout
    assert "English words for: de" in proc.stdout


def test_a_line_in_an_arm_keeps_its_translation(tmp_path: Path) -> None:
    out, manifest, _ledger, _err = extract(tmp_path, LEAD + WHO + (
        '    if met == "robin":\n'
        '        "Robin waves."\n'
        '    else:\n'
        '        "Nobody waves."\n'
        '    "The end."\n'
        '    return\n'), tl={"german": (
            f'translate german {ident("start", '"Robin waves."')}:\n'
            '    "Robin winkt."\n\n'
            'translate german strings:\n'
            '    old "Wake Robin"\n    new "Robin wecken"\n')})
    de = json.loads((out / "lang" / "de.json").read_text("utf-8"))
    waves = next(i["id"] for i in manifest["items"]
                 if i.get("text") == "Robin waves.")
    assert de["items"][waves]["text"] == "Robin winkt."
    chain = manifest["branches"][-1]
    table = json.loads(paths.CONDITION_WORDS_FILE.read_text("utf-8"))
    chose = table["languages"]["de"]["converter.condition.chose"]
    assert de["decisions"][chain["id"]]["routes"][
        chain["routes"][0]["id"]]["text"] == chose.replace(
            "{choice}", "Robin wecken")
    check_translated(tmp_path, out, manifest)


@pytest.mark.usefixtures("french_words")
def test_per_language_names(tmp_path: Path) -> None:
    names = tmp_path / "names.json"
    names.write_text(json.dumps({
        "love": {"en": "Love", "fr": "Amour"},
        "met_x": "Robin met"}), encoding="utf-8")
    script = COUNTER.replace("label start:", (
        'default met_x = False\nlabel start:')).replace(
        '    "The end."\n', (
            '    $ met_x = True\n'
            '    "Then again."\n'
            '    if met_x:\n'
            '        "Met."\n'
            '    "The end."\n'))
    out, manifest, ledger, err = extract(
        tmp_path, script, "--condition-names", str(names),
        tl={"french": 'translate french strings:\n'
                      '    old "Smile"\n    new "Sourire"\n'})
    assert "--condition-names" not in err
    love, met = manifest["branches"][-2], manifest["branches"][-1]
    assert [r["label"] for r in love["routes"]] == [
        "Love 3 or more", "Love 1 or 2", "Love under 1"]
    assert [r["label"] for r in met["routes"]] == ["Robin met is set",
                                                   "Robin met is not set"]
    fr = json.loads((out / "lang" / "fr.json").read_text("utf-8"))
    assert [fr["decisions"][love["id"]]["routes"][r["id"]]["text"]
            for r in love["routes"]] == [
        "Amour 3 ou plus", "Amour 1 ou 2", "Amour moins de 1"]
    assert [fr["decisions"][met["id"]]["routes"][r["id"]]["text"]
            for r in met["routes"]] == ["Robin met est défini",
                                        "Robin met n'est pas défini"]
    assert all(r["englishFor"] == [] for r in ledger["conditions"])
    check_translated(tmp_path, out, manifest)


def test_a_base_language_the_catalogue_lacks_gets_english(
        tmp_path: Path) -> None:
    out, manifest, ledger, _err = extract(
        tmp_path, COUNTER, "--base-language", "eo")
    chain = manifest["branches"][-1]
    assert chain["prompt"] == PROMPT
    assert chain["routes"][0]["label"] == "love 3 or more"
    (record,) = ledger["conditions"]
    assert record["englishFor"] == ["eo"]
    proc = run_kinetic("report", str(out), "--json")
    assert proc.returncode == 0, proc.stderr
    (listed,) = json.loads(proc.stdout)["conditions"]
    assert listed == {
        "decision": chain["id"], "source": record["source"],
        "condition": ["if love >= 3:", "elif love >= 1:", "else:"],
        "kind": "ranges", "follows": None,
        "labels": ["love 3 or more", "love 1 or 2", "love under 1"],
        "englishFor": ["eo"], "startingValue": None}


def test_condition_names_unknown_key_is_a_warning(tmp_path: Path) -> None:
    names = tmp_path / "names.json"
    names.write_text(json.dumps({"love": "Love", "hate": "Hate"}),
                     encoding="utf-8")
    _out, manifest, _ledger, err = extract(
        tmp_path, COUNTER, "--condition-names", str(names))
    assert manifest["branches"][-1]["routes"][0]["label"] == \
        "Love 3 or more"
    assert "--condition-names" in err and "'hate'" in err
    assert "'love'" not in err


@pytest.mark.parametrize("content", [
    "[1, 2]", '{"love": 3}', '{"love": {"en": 3}}', "{not json"])
def test_a_bad_condition_names_file_is_refused(tmp_path: Path,
                                               content: str) -> None:
    names = tmp_path / "names.json"
    names.write_text(content, encoding="utf-8")
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    (game / "script.rpy").write_text(COUNTER, encoding="utf-8")
    err = StringIO()
    with redirect_stdout(StringIO()), redirect_stderr(err), \
            pytest.raises(SystemExit) as exc:
        cli_main([str(game.parent), str(tmp_path / "out"),
                  "--condition-names", str(names)])
    assert exc.value.code == 2
    assert "--condition-names" in err.getvalue()


# --- the pieces ---------------------------------------------------------------

@pytest.mark.parametrize(("tag", "found"), [
    ("de", "de"), ("de-AT", "de"), ("DE", "de"), ("zh-TW", "zh-Hant"),
    ("zh-CN", "zh-Hans"), ("zh-Hant-HK", "zh-Hant"), ("es-MX", "es-419"),
    ("es-ES", "es"), ("pt", "pt-BR"), ("pt-PT", "pt-PT"), ("eo", None)])
def test_a_game_language_takes_the_catalogue_language_the_player_would(
        tag: str, found: str | None) -> None:
    available = ["en", "de", "zh-Hans", "zh-Hant", "es", "es-419",
                 "pt-BR", "pt-PT"]
    assert conditions.match_tag(tag, available) == found


def test_whole_number_ranges() -> None:
    assert conditions.complement([(0, 0)]) == [(None, -1), (1, None)]
    assert conditions.complement([]) == [(None, None)]
    assert conditions.complement([(None, None)]) == []
    assert conditions.complement([(None, 2), (5, None)]) == [(3, 4)]
    assert conditions.minus([(1, None)], [(3, None)]) == [(1, 2)]
    assert conditions.union([(1, 2)], [(3, 4)]) == [(1, 4)]


@pytest.mark.parametrize(("text", "why"), [
    ("x == y", "not a literal"),
    ("x < 1 < 2", "chained"),
    ("store.x", None),
    ("not not x", None),
    ("3 <= x", None),
    ("x is 3", "`is`"),
    ("config.developer", "Ren'Py's settings"),
    ("x[0]", "not one variable"),
])
def test_read_test(text: str, why: str | None) -> None:
    test, reason = conditions.read_test(text)
    if why is None:
        assert reason is None and test.var == "x"
    else:
        assert test is None and why in reason
