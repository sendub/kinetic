"""Conditions only on story state (docs/plan.md Phase 60 item 9k;
docs/extracting.md, "Conditions").

An `if` chain on story state the converter reads everywhere it is set
(plain `$ x = literal`, `+=` or `-=` of a literal, `default`, `define`)
converts as before. A chain on a label's parameter that every call gives
a literal is no decision: at each call the walk takes the arm that value
picks. A chain on other run-time state or state set where the converter
cannot read it (a loop variable, a random roll or another call's value,
`_return`, Python code, a screen action, `renpy.input`, a parameter some
call gives a non-literal) is a words decision the reader picks, its
reason in the ledger and `kinetic report`; `persistent`, `config`,
`preferences`, `store.x.y` and `_in_replay` stay unconverted. An arm is
dropped as never taken only when every place that sets the variable is
read.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kinetic_extract.parser import parse_file

from test_conditions import LEAD, condition_kinds, extract
from test_jump_menus import check_folder, line_of, run_kinetic, texts

# A menu whose choices set `x` to a literal: with nothing else setting it,
# a chain on `x` follows the menu.
SETS_X = ('    menu:\n'
          '        "One":\n'
          '            $ x = 1\n'
          '            "You pick one."\n'
          '        "Two":\n'
          '            $ x = 2\n'
          '            "You pick two."\n'
          '    "Later."\n')
CHAIN_X = ('    if x == 1:\n'
           '        "Was one."\n'
           '    else:\n'
           '        "Was not one."\n'
           '    "The end."\n'
           '    return\n')


def chain_of(script: str):
    """The one chain parse_file read as a fork (the file's own
    assignments)."""
    parsed = parse_file(script, "game/script.rpy")
    (cond,) = [r.condition for r in parsed.menus if r.condition is not None]
    return cond


def chain_reason(script: str, head: str) -> str:
    """The `if chain not converted (...)` report on the chain whose head
    holds ``head``."""
    parsed = parse_file(script, "game/script.rpy")
    assert not any(r.condition is not None for r in parsed.menus), \
        "the chain became a decision"
    at = f"game/script.rpy:{line_of(script, head)}"
    (report,) = [r for r in parsed.reports if r.source == at]
    assert report.reason.startswith("if chain not converted ("), \
        report.reason
    return report.reason


@pytest.mark.parametrize(("extra", "why"), [
    # A label parameter, set by every call with arguments.
    ('label scene(x, mood="calm"):\n    "Scene."\n    return\n',
     "x is a parameter of label scene"),
    # A call's keyword argument names it too.
    ('label scene(**kw):\n    return\nlabel other:\n'
     '    call scene(x=3)\n    return\n',
     "x is set by an argument of `call scene`"),
    # A loop: Python's `for`, Ren'Py's `while`.
    ('init python:\n    for x in range(3):\n        pass\n',
     "x is a loop variable"),
    ('label loop:\n    while x < 3:\n        $ x += 1\n    return\n',
     "x is a loop variable"),
    # A random roll and any other call's value.
    ('label roll:\n    $ x = renpy.random.randint(1, 3)\n    return\n',
     "x is set from a call to renpy.random.randint"),
    ('label pick:\n    $ x = pick_one()\n    return\n',
     "x is set from a call to pick_one"),
    ('label ask:\n    $ x = renpy.input("Which?")\n    return\n',
     "x is set from a call to renpy.input"),
    # An expression, another variable, a counter changed by one.
    ('label copy:\n    $ x = y\n    return\n',
     "x is set from another variable"),
    ('label sum:\n    $ x = 1 if y else 2\n    return\n',
     "x is set from an expression"),
    ('label more:\n    $ x += y\n    return\n',
     "x is changed by an expression"),
    ('label more:\n    $ x *= 2\n    return\n',
     "x is changed with another operator"),
    ('label both:\n    $ x, y = 1, 2\n    return\n',
     "x is set by unpacking"),
    # Python blocks and functions.
    ('init python:\n    x = 1\n', "x is set in Python code"),
    ('init python:\n    def reset():\n        global x\n        x = 0\n',
     "x is set in Python code"),
    ('label run:\n    python:\n        x = 2\n    return\n',
     "x is set in Python code"),
    # Screen actions and inputs.
    ('screen s():\n    textbutton "Go" action SetVariable("x", 3)\n',
     "x is set by a screen action"),
    ('screen s():\n    textbutton "Go" action SetField(store, "x", 3)\n',
     "x is set by a screen action"),
    ('screen s():\n    textbutton "Go" action ToggleVariable("x")\n',
     "x is set by a screen action"),
    ('screen s():\n    input value VariableInputValue("x")\n',
     "x is set by a screen action"),
    ('label hook:\n    $ setattr(store, "x", 4)\n    return\n',
     "x is set in Python code"),
    # A default that is not one value (a list the script may change).
    ('default x = []\n', "x starts as a list"),
])
def test_a_chain_on_state_the_converter_cannot_read_the_reader_picks(
        extra: str, why: str) -> None:
    """Each place below sets `x` as well as the menu's literals: the chain
    is still read as a fork (prepare makes it a words decision), with the
    reason why the reader picks, naming the place."""
    script = LEAD + SETS_X + CHAIN_X + extra
    cond = chain_of(script)
    assert cond.variable == "x"
    assert why in cond.unread, cond.unread
    assert " at game/script.rpy:" in cond.unread


def test_return_is_a_choice_the_reader_picks() -> None:
    script = LEAD + SETS_X + (
        '    if _return == 1:\n'
        '        "Yes."\n'
        '    else:\n'
        '        "No."\n'
        '    return\n')
    cond = chain_of(script)
    assert "_return is the value a call or `call screen` returned" \
        in cond.unread


@pytest.mark.parametrize(("test", "why"), [
    ("_in_replay", "_in_replay is whether a replay is playing"),
    ("persistent.x", "persistent data"),
    ("config.developer", "Ren'Py's settings"),
    ("preferences.text_cps", "the reader's preferences"),
    ("store.x.y == 1", "store.x.y"),
])
def test_a_chain_on_ren_py_state_stays(test: str, why: str) -> None:
    script = LEAD + SETS_X + (
        f'    if {test}:\n'
        '        "Yes."\n'
        '    else:\n'
        '        "No."\n'
        '    return\n')
    reason = chain_reason(script, f"if {test}")
    assert why in reason, reason


SCENE = ('label scene(n=1):\n'
         '    "In the scene."\n'
         '    if n == 1:\n'
         '        "One."\n'
         '    elif n == 2:\n'
         '        "Two."\n'
         '    else:\n'
         '        "Many."\n'
         '    "Out of the scene."\n'
         '    return\n')


def test_each_call_of_a_label_takes_its_parameters_arm(
        tmp_path: Path) -> None:
    """`label scene(n=1):` called with 1, then `n=2`: no decision; each
    call reads the arm its value picks, the second only what the first did
    not read (each statement once). `call scene` with no argument takes
    the default, 1: nothing left to read. No call gives 3, so `else` is
    never taken, reported."""
    script = LEAD + (
        '    call scene(1)\n'
        '    "Between."\n'
        '    call scene(n=2)\n'
        '    call scene\n'
        '    "The end."\n'
        '    return\n') + SCENE
    out, manifest, ledger, _err = extract(tmp_path, script)
    assert manifest.get("branches", []) == []
    assert ledger.get("conditions", []) == []
    assert texts(manifest) == [
        "Lead.", "In the scene.", "One.", "Out of the scene.", "Between.",
        "Two.", "The end."]
    at = f"game/script.rpy:{line_of(script, 'if n == 1')}"
    (note,) = [d for d in ledger["branchDetection"] if d["source"] == at]
    assert note["result"] == "skipped"
    assert "each call of label scene takes the arm its n picks" \
        in note["reason"]
    else_at = f"game/script.rpy:{line_of(script, 'else:')}"
    (drop,) = [r for r in ledger["report"] if r["source"] == else_at]
    assert drop["reason"].startswith("if arm never taken: no call of label "
                                     "scene gives n a value it takes")
    check_folder(tmp_path, out, manifest)


def test_a_call_with_a_non_literal_argument_makes_the_reader_pick(
        tmp_path: Path) -> None:
    script = ('default level = 2\n' + LEAD + (
        '    call scene(1)\n'
        '    "Between."\n'
        '    call scene(level)\n'
        '    "The end."\n'
        '    return\n') + SCENE)
    out, manifest, ledger, _err = extract(tmp_path, script)
    (cond,) = ledger["conditions"]
    assert cond["kind"] == "words"
    assert "n is set from another variable (level) at game/script.rpy:" \
        in cond["readerPicks"]
    (branch,) = manifest["branches"]
    assert [r["label"] for r in branch["routes"]] == [
        "n is 1", "n is 2", "Otherwise"]
    assert "Many." in texts(manifest)
    at = f"game/script.rpy:{line_of(script, 'if n == 1')}"
    (note,) = [d for d in ledger["branchDetection"] if d["source"] == at]
    assert "the reader picks" in note["note"]
    check_folder(tmp_path, out, manifest)


def test_a_random_roll_is_a_choice_the_reader_picks(tmp_path: Path) -> None:
    """`$ r = renpy.random.randint(1, 3)`: no value is read, so no arm is
    dropped and the reader picks; the ledger, its note and `kinetic
    report` say why."""
    script = LEAD + (
        '    $ r = renpy.random.randint(1, 3)\n'
        '    if r == 1:\n'
        '        "Lucky."\n'
        '    elif r == 2:\n'
        '        "Fair."\n'
        '    else:\n'
        '        "Unlucky."\n'
        '    "The end."\n'
        '    return\n')
    out, manifest, ledger, _err = extract(tmp_path, script)
    (cond,) = ledger["conditions"]
    assert cond["kind"] == "words"
    why = (f"r is set from a call to renpy.random.randint at "
           f"game/script.rpy:{line_of(script, '$ r =')}")
    assert cond["readerPicks"] == why
    assert {"Lucky.", "Fair.", "Unlucky."} <= set(texts(manifest))
    assert not any("never taken" in r["reason"] for r in ledger["report"])
    (note,) = [d for d in ledger["branchDetection"]
               if d["source"] == cond["source"]]
    assert f"{why}: the reader picks" in note["note"]
    proc = run_kinetic("report", str(out), "--json")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    (made,) = json.loads(proc.stdout)["conditions"]
    assert made["readerPicks"] == why
    proc = run_kinetic("report", str(out))
    assert f"{why}: the reader picks" in proc.stdout
    check_folder(tmp_path, out, manifest)


def test_a_parameter_chain_set_elsewhere_too_keeps_its_lines(
        tmp_path: Path) -> None:
    """`label scene(n):` then `if n == "a":`, and a `$ n = "a"` outside
    the label. Before item 9k the `else` arm was dropped as never taken
    (only that `$` line was seen), the chain read in line and `two` never
    reached. Now each call takes its arm: `two`'s lines are kept."""
    script = LEAD + (
        '    $ n = "a"\n'
        '    call scene("a")\n'
        '    call scene("b")\n'
        '    "The end."\n'
        '    return\n'
        'label scene(n):\n'
        '    if n == "a":\n'
        '        jump one\n'
        '    else:\n'
        '        jump two\n'
        'label one:\n'
        '    "One."\n'
        '    return\n'
        'label two:\n'
        '    "Two."\n'
        '    return\n')
    out, manifest, ledger, _err = extract(tmp_path, script)
    assert texts(manifest) == ["Lead.", "One.", "Two.", "The end."]
    assert not any("never taken" in r["reason"] for r in ledger["report"])
    assert ledger.get("conditions", []) == []
    check_folder(tmp_path, out, manifest)


def test_a_story_variable_set_by_literals_still_converts(
        tmp_path: Path) -> None:
    """`default`, `$ x = literal` and `+=` of a literal are read: the
    chain is a decision, and an arm no read value takes is dropped, the
    report saying every place that sets the variable was read."""
    script = ('default x = 0\n' + LEAD + SETS_X + (
        '    if x == 1:\n'
        '        "Was one."\n'
        '    elif x == 7:\n'
        '        "Never."\n'
        '    else:\n'
        '        "Was not one."\n'
        '    "The end."\n'
        '    return\n'))
    out, manifest, ledger, _err = extract(tmp_path, script)
    assert condition_kinds(ledger) == [("follows", manifest["branches"][0]
                                        ["id"])]
    assert "Never." not in texts(manifest)
    at = f"game/script.rpy:{line_of(script, 'elif x == 7')}"
    (drop,) = [r for r in ledger["report"] if r["source"] == at]
    assert drop["reason"].startswith("if arm never taken: ")
    assert "all 3 places that set x are read" in drop["reason"]
    check_folder(tmp_path, out, manifest)


def test_a_counters_arm_earlier_arms_cover_says_so(tmp_path: Path) -> None:
    script = ('default love = 0\n' + LEAD + (
        '    menu:\n'
        '        "Smile":\n'
        '            $ love += 1\n'
        '            "You smile."\n'
        '        "Frown":\n'
        '            "You frown."\n'
        '    "Later."\n'
        '    if love >= 1:\n'
        '        "Fond."\n'
        '    elif love >= 3:\n'
        '        "Never."\n'
        '    else:\n'
        '        "Cool."\n'
        '    "The end."\n'
        '    return\n'))
    out, manifest, ledger, _err = extract(tmp_path, script)
    assert condition_kinds(ledger) == [("ranges", None)]
    at = f"game/script.rpy:{line_of(script, 'elif love >= 3')}"
    (drop,) = [r for r in ledger["report"] if r["source"] == at]
    assert "the arms before it take every whole number it tests" \
        in drop["reason"]
    check_folder(tmp_path, out, manifest)
