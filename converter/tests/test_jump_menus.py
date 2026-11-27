"""Menus whose choices jump become decisions (docs/plan.md Phase 60 item
4). A choice block is read as label flow: its lines, its `$` assignments
(kept on the MenuRecord for item 6) and a closing `jump`, `call` or
`return`. The walk lays each choice's path out between menu markers up to
where the choices meet, then that join once, and each route's `result`
says how its path ended: at the join `"continue"` (the last such choice is
the `continuingRoute`, the join's first item the `continueAt`), back at
the menu `"return"`, at the story's end `"ending"`. A choice with no item
of its own gets its choice text as a line; a menu every choice of which is
empty, and one whose path rejoins another choice's content away from the
join, stay linear and reported. In-place menus whose choices fall through
get their join too.

Each case is a synthetic project extracted end to end: the folder
validates `--strict` with nothing printed, `kinetic routes` counts the
decisions and routes the manifest has, and `kinetic check --steps all`
walks the assembled folder to the story's end with exit 0 (Play all
routes is on by default, so every route plays once: an item a single walk
never shows would be exit 3, which no case here expects).
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from kinetic_extract import conditions, routes
from kinetic_extract.cli import main as cli_main
from kinetic_extract.parser import parse_file

REPO_ROOT = Path(__file__).resolve().parents[2]


def run_kinetic(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "kinetic_extract.kinetic_cli", *args],
        capture_output=True, text=True, cwd=REPO_ROOT, timeout=300)


def extract(tmp_path: Path, script: str,
            tl: dict[str, str] | None = None) -> tuple[Path, dict, dict]:
    game = tmp_path / "proj" / "game"
    (game / "images").mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 18), (40, 60, 80)).save(game / "images" / "bg.png")
    (game / "script.rpy").write_text(script, encoding="utf-8")
    for tag, text in (tl or {}).items():
        (game / "tl" / tag).mkdir(parents=True)
        (game / "tl" / tag / "script.rpy").write_text(text, encoding="utf-8")
    out = tmp_path / "out"
    with redirect_stdout(StringIO()):
        assert cli_main([str(game.parent), str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    return out, manifest, ledger


def texts(manifest: dict) -> list[str]:
    return [i.get("text") for i in manifest["items"]]


def shape(manifest: dict) -> list[dict[str, Any]]:
    """The decisions by text: after, each route's (label, first text,
    last text, result), the continuing route's label and continueAt."""
    text_of = {i["id"]: i.get("text") for i in manifest["items"]}
    out = []
    for b in manifest.get("branches", []):
        labels = {r["id"]: r["label"] for r in b["routes"]}
        out.append({
            "after": text_of[b["after"]],
            "routes": [(r["label"], text_of[r["start"]], text_of[r["end"]],
                        r.get("result", "ending")) for r in b["routes"]],
            "continuing": labels.get(b.get("continuingRoute")),
            "continueAt": text_of.get(b.get("continueAt")),
        })
    return out


def check_folder(tmp_path: Path, out: Path, manifest: dict) -> None:
    """Validate --strict silently, count decisions and routes as
    `kinetic routes` does, and walk the assembled folder to the end."""
    proc = run_kinetic("validate", str(out), "--strict")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout == "" and proc.stderr == ""
    branches = manifest.get("branches", [])
    proc = run_kinetic("routes", str(out), "--json")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    counts = json.loads(proc.stdout)["counts"]
    assert counts == routes.build_model(manifest).counts()
    assert counts["decisions"] == len(branches)
    assert counts["routes"] == sum(len(b["routes"]) for b in branches)
    play = tmp_path / "play"
    proc = run_kinetic("assemble", str(out), str(play))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    proc = run_kinetic("check", str(play), "--steps", "all",
                       "--no-media-check")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "story ended" in proc.stdout


def detection(ledger: dict) -> list[dict[str, str]]:
    return ledger["branchDetection"]


def menu_reports(ledger: dict) -> list[str]:
    return [r["reason"] for r in ledger["report"]
            if r["reason"].startswith("menu unsupported")]


LEAD = 'label start:\n    scene bg\n    "Lead."\n'


def test_two_choices_jump_to_labels_that_rejoin(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu "Which way?":\n'
        '        "Left":\n            jump left\n'
        '        "Right":\n            jump right\n'
        'label left:\n    "Left path."\n    jump joined\n'
        'label right:\n    "Right path."\n    jump joined\n'
        'label joined:\n    "Together again."\n    return\n'))
    assert texts(manifest) == ["Lead.", "Left path.", "Right path.",
                               "Together again."]
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Left", "Left path.", "Left path.", "continue"),
                   ("Right", "Right path.", "Right path.", "continue")],
        "continuing": "Right", "continueAt": "Together again."}]
    assert menu_reports(ledger) == []
    note = detection(ledger)[0]
    assert note["result"] == "detected"
    assert "continuingRoute" in note["note"]
    assert "reaches the join" in note["note"]
    check_folder(tmp_path, out, manifest)


def test_three_choices_with_assignments_and_lines(tmp_path: Path) -> None:
    script = LEAD + (
        '    menu:\n'
        '        "Tea":\n'
        '            $ drink = "tea"\n'
        '            "You pour tea."\n'
        '            jump kitchen\n'
        '        "Coffee":\n'
        '            $ drink = "coffee"\n'
        '            $ cups += 1\n'
        '            jump cafe\n'
        '        "Water":\n'
        '            $ cups -= 1\n'
        '            "Just water."\n'
        '    "Water, still."\n'
        '    jump end\n'
        'label kitchen:\n    "Kitchen."\n    jump end\n'
        'label cafe:\n    "Cafe."\n    jump end\n'
        'label end:\n    "The end."\n    return\n')
    parsed = parse_file(script, "game/script.rpy")
    assert parsed.reports == []
    (menu,) = parsed.menus
    assert menu.skip_reason is None
    assert menu.choices == ["Tea", "Coffee", "Water"]
    assert menu.assignments == [
        [("drink", "=", '"tea"')],
        [("drink", "=", '"coffee"'), ("cups", "+=", "1")],
        [("cups", "-=", "1")]]
    out, manifest, ledger = extract(tmp_path, script)
    assert texts(manifest) == ["Lead.", "You pour tea.", "Kitchen.",
                               "Cafe.", "Just water.", "Water, still.",
                               "The end."]
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Tea", "You pour tea.", "Kitchen.", "continue"),
                   ("Coffee", "Cafe.", "Cafe.", "continue"),
                   ("Water", "Just water.", "Water, still.", "continue")],
        "continuing": "Water", "continueAt": "The end."}]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_refusal_choice_jumps_back_to_the_menu(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        'label ask:\n'
        '    menu:\n'
        '        "Will you come?"\n'
        '        "No":\n'
        '            "Then I will ask again."\n'
        '            jump ask\n'
        '        "Yes":\n'
        '            "Let us go."\n'
        '    "We leave together."\n'
        '    return\n'))
    assert texts(manifest) == ["Lead.", "Then I will ask again.",
                               "Let us go.", "We leave together."]
    assert manifest["branches"][0]["prompt"] == "Will you come?"
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("No", "Then I will ask again.",
                    "Then I will ask again.", "return"),
                   ("Yes", "Let us go.", "Let us go.", "continue")],
        "continuing": "Yes", "continueAt": "We leave together."}]
    assert "jumps back to the menu" in detection(ledger)[0]["note"]
    check_folder(tmp_path, out, manifest)


def test_refusal_to_a_named_menu(tmp_path: Path) -> None:
    out, manifest, _ledger = extract(tmp_path, LEAD + (
        '    menu ask:\n'
        '        "Stay a while":\n'
        '            "You linger."\n'
        '            jump ask\n'
        '        "Leave":\n'
        '            jump gone\n'
        'label gone:\n    "Gone."\n    return\n'))
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Stay a while", "You linger.", "You linger.", "return"),
                   ("Leave", "Leave", "Leave", "continue")],
        "continuing": "Leave", "continueAt": "Gone."}]
    check_folder(tmp_path, out, manifest)


def ogg(path: Path, hz: int) -> None:
    """A real one-second Vorbis tone at ``path``."""
    from kinetic_extract import media_tools

    proc = subprocess.run(
        [*media_tools.ffmpeg_cmd(), "-y", "-f", "lavfi", "-i",
         f"sine=frequency={hz}:sample_rate=22050:duration=1",
         "-c:a", "libvorbis", str(path)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stderr


def line_of(script: str, text: str) -> int:
    """The 1-based line of ``script`` holding ``text``."""
    return next(n for n, line in enumerate(script.splitlines(), 1)
                if text in line)


def test_refusal_through_a_lead_in_line_returns(tmp_path: Path) -> None:
    """Item 4b: the refusal jumps back to the label above the question,
    so it re-reads only the decision's lead-in: a "return" route, the
    lead-in not laid out again."""
    script = LEAD + (
        'label ask:\n'
        '    "Will you come with me?"\n'
        '    menu:\n'
        '        "Yes":\n'
        '            jump go\n'
        '        "No":\n'
        '            "I can\'t."\n'
        '            jump ask\n'
        'label go:\n    "We go."\n    return\n')
    out, manifest, ledger = extract(tmp_path, script)
    assert texts(manifest) == ["Lead.", "Will you come with me?", "Yes",
                               "I can't.", "We go."]
    assert shape(manifest) == [{
        "after": "Will you come with me?",
        "routes": [("Yes", "Yes", "Yes", "continue"),
                   ("No", "I can't.", "I can't.", "return")],
        "continuing": "Yes", "continueAt": "We go."}]
    assert menu_reports(ledger) == []
    (note,) = detection(ledger)
    assert note["result"] == "detected"
    at = line_of(script, "Will you come with me?")
    assert ("jumps back to the menu through its lead-in at "
            f"game/script.rpy:{at}") in note["note"]
    check_folder(tmp_path, out, manifest)


def test_refusal_through_a_longer_lead_in_returns(tmp_path: Path) -> None:
    """Several lead-in lines, a `show` and a `play` between the label and
    the menu are still straight-line story: the refusal is "return"."""
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    ogg(game / "theme.ogg", 440)
    script = LEAD + (
        'label ask:\n'
        '    show bg\n'
        '    play music "theme.ogg"\n'
        '    "The night is cold."\n'
        '    "She turns to you."\n'
        '    "Will you come with me?"\n'
        '    menu:\n'
        '        "No":\n'
        '            "I can\'t."\n'
        '            "Not yet."\n'
        '            jump ask\n'
        '        "Yes":\n'
        '            "Then let us go."\n'
        '    "We leave."\n'
        '    return\n')
    out, manifest, ledger = extract(tmp_path, script)
    assert [t for t in texts(manifest) if t is not None] == [
        "Lead.", "The night is cold.", "She turns to you.",
        "Will you come with me?", "I can't.", "Not yet.",
        "Then let us go.", "We leave."]
    assert shape(manifest) == [{
        "after": "Will you come with me?",
        "routes": [("No", "I can't.", "Not yet.", "return"),
                   ("Yes", "Then let us go.", "Then let us go.",
                    "continue")],
        "continuing": "Yes", "continueAt": "We leave."}]
    assert menu_reports(ledger) == []
    (note,) = detection(ledger)
    # The lead-in starts at its first story event, the `show`.
    at = line_of(script, "show bg")
    assert ("jumps back to the menu through its lead-in at "
            f"game/script.rpy:{at}") in note["note"]
    check_folder(tmp_path, out, manifest)


@pytest.mark.parametrize("between", [
    # A fork on the way from the label to the menu.
    '    if tired:\n        jump rest\n',
    # Another jump on the way.
    '    jump ask_menu\nlabel ask_menu:\n',
])
def test_refusal_whose_way_back_branches_stays_a_rejoin(
        tmp_path: Path, between: str) -> None:
    """A jump back to a label whose way to the menu passes a fork or
    another jump is no straight-line lead-in: the menu stays linear,
    reported as a rejoin."""
    out, manifest, ledger = extract(tmp_path, LEAD + (
        'label ask:\n'
        '    "Will you come with me?"\n' + between +
        '    menu:\n'
        '        "Yes":\n'
        '            jump go\n'
        '        "No":\n'
        '            "I can\'t."\n'
        '            jump ask\n'
        'label rest:\n    "You rest first."\n    jump go\n'
        'label go:\n    "We go."\n    return\n'))
    assert manifest.get("branches", []) == []
    (reason,) = menu_reports(ledger)
    assert "choice 2 (No) rejoins content read at game/script.rpy:" \
        in reason
    assert detection(ledger)[0]["result"] == "skipped"


def test_nested_menu_refusal_through_its_lead_in(tmp_path: Path) -> None:
    """A menu inside a route of another menu: its refusal jumps back to
    the route's label, through the lead-in, and is "return" for the inner
    decision alone; the outer route goes on to the join."""
    script = LEAD + (
        '    menu:\n'
        '        "Forest":\n'
        '            jump forest\n'
        '        "River":\n'
        '            "To the river."\n'
        '            jump camp\n'
        'label forest:\n'
        '    "Into the forest."\n'
        '    "The path forks."\n'
        '    menu:\n'
        '        "Climb":\n'
        '            "You climb."\n'
        '            jump camp\n'
        '        "Wait":\n'
        '            "You wait."\n'
        '            jump forest\n'
        'label camp:\n    "At camp."\n    return\n')
    out, manifest, ledger = extract(tmp_path, script)
    assert texts(manifest) == ["Lead.", "Into the forest.", "The path forks.",
                               "You climb.", "You wait.", "To the river.",
                               "At camp."]
    assert sorted(shape(manifest), key=lambda d: d["after"]) == sorted([
        {"after": "Lead.",
         "routes": [("Forest", "Into the forest.", "You wait.", "continue"),
                    ("River", "To the river.", "To the river.",
                     "continue")],
         "continuing": "River", "continueAt": "At camp."},
        {"after": "The path forks.",
         "routes": [("Climb", "You climb.", "You climb.", "continue"),
                    ("Wait", "You wait.", "You wait.", "return")],
         "continuing": "Climb", "continueAt": "At camp."},
    ], key=lambda d: d["after"])
    assert menu_reports(ledger) == []
    assert [n["result"] for n in detection(ledger)] == ["detected"] * 2
    at = line_of(script, "Into the forest.")
    assert any(("jumps back to the menu through its lead-in at "
                f"game/script.rpy:{at}") in n["note"]
               for n in detection(ledger))
    check_folder(tmp_path, out, manifest)


def test_menus_nested_several_deep_inside_routes(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Forest":\n'
        '            "Into the forest."\n'
        '            menu:\n'
        '                "Climb":\n'
        '                    "You climb."\n'
        '                    menu:\n'
        '                        "Look":\n'
        '                            "You look around."\n'
        '                        "Rest":\n'
        '                            "You rest."\n'
        '                    "Down again."\n'
        '                    jump camp\n'
        '                "Dig":\n'
        '                    "You dig."\n'
        '                    jump camp\n'
        '        "River":\n'
        '            "To the river."\n'
        '            jump camp\n'
        'label camp:\n    "At camp."\n    return\n'))
    assert texts(manifest) == [
        "Lead.", "Into the forest.", "You climb.", "You look around.",
        "You rest.", "Down again.", "You dig.", "To the river.", "At camp."]
    assert sorted(shape(manifest), key=lambda d: d["after"]) == sorted([
        {"after": "Lead.",
         "routes": [("Forest", "Into the forest.", "You dig.", "continue"),
                    ("River", "To the river.", "To the river.",
                     "continue")],
         "continuing": "River", "continueAt": "At camp."},
        # Climb and Dig both jump to camp, the outer menu's join: its
        # continueAt, past the end of the Forest route, is theirs.
        {"after": "Into the forest.",
         "routes": [("Climb", "You climb.", "Down again.", "continue"),
                    ("Dig", "You dig.", "You dig.", "continue")],
         "continuing": "Dig", "continueAt": "At camp."},
        {"after": "You climb.",
         "routes": [("Look", "You look around.", "You look around.",
                     "continue"),
                    ("Rest", "You rest.", "You rest.", "continue")],
         "continuing": "Rest", "continueAt": "Down again."},
    ], key=lambda d: d["after"])
    assert menu_reports(ledger) == []
    assert [n["result"] for n in detection(ledger)] == ["detected"] * 3
    check_folder(tmp_path, out, manifest)


def test_every_choice_to_one_label_is_a_stat_choice(tmp_path: Path) -> None:
    """Every choice empty, all meeting at the join: a decision of the
    choice lines (Phase 60 item 9o; it stayed linear before)."""
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Agree":\n            jump same\n'
        '        "Nod":\n            jump same\n'
        'label same:\n    "Same place."\n    return\n'))
    assert texts(manifest) == ["Lead.", "Agree", "Nod", "Same place."]
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Agree", "Agree", "Agree", "continue"),
                   ("Nod", "Nod", "Nod", "continue")],
        "continuing": "Nod", "continueAt": "Same place."}]
    (note,) = detection(ledger)
    assert note["result"] == "detected"
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_a_choice_ending_the_story(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Fight":\n'
        '            "You fight."\n'
        '            jump after\n'
        '        "Flee":\n'
        '            "You flee, and that is the end."\n'
        '            return\n'
        '        "Hide":\n'
        '            "You hide."\n'
        '            jump after\n'
        'label after:\n    "After the danger."\n    return\n'))
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Fight", "You fight.", "You fight.", "continue"),
                   ("Flee", "You flee, and that is the end.",
                    "You flee, and that is the end.", "ending"),
                   ("Hide", "You hide.", "You hide.", "continue")],
        "continuing": "Hide", "continueAt": "After the danger."}]
    assert "story's end" in detection(ledger)[0]["note"]
    check_folder(tmp_path, out, manifest)


def test_a_call_in_a_choice_returns_and_goes_on(tmp_path: Path) -> None:
    out, manifest, _ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Visit":\n'
        '            "Before the visit."\n'
        '            call side\n'
        '            "After the visit."\n'
        '        "Stay":\n'
        '            "You stay."\n'
        '    "Joined."\n'
        '    return\n'
        'label side:\n    "The side scene."\n    return\n'))
    assert texts(manifest) == ["Lead.", "Before the visit.",
                               "The side scene.", "After the visit.",
                               "You stay.", "Joined."]
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Visit", "Before the visit.", "After the visit.",
                    "continue"),
                   ("Stay", "You stay.", "You stay.", "continue")],
        "continuing": "Stay", "continueAt": "Joined."}]
    check_folder(tmp_path, out, manifest)


def ident(label: str, code: str) -> str:
    """Ren'Py's identifier of a say statement (as test_one_choice_menu)."""
    digest = hashlib.md5((code + "\r\n").encode("utf-8")).hexdigest()
    return f"{label}_{digest[:8]}"


TL_DE = (f'translate de {ident("start", '"Lead."')}:\n    "Vorweg."\n\n'
         f'translate de {ident("start", '"You look closer."')}:\n'
         '    "Du schaust hin."\n\n'
         f'translate de {ident("later", '"Later."')}:\n    "Später."\n\n'
         'translate de strings:\n'
         '    old "Empty"\n    new "Leer"\n'
         '    old "What now?"\n    new "Was nun?"\n'
         '    old "Skip it"\n    new "Lass es"\n'
         '    old "Look closer"\n    new "Genauer hinsehen"\n')


def test_an_empty_choice_gets_its_text(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, 'define config.name = "Empty"\n'
        + LEAD + (
        '    menu "What now?":\n'
        '        "Skip it":\n'
        '            jump later\n'
        '        "Look closer":\n'
        '            "You look closer."\n'
        'label later:\n    "Later."\n    return\n'), tl={"de": TL_DE})
    assert texts(manifest) == ["Lead.", "Skip it", "You look closer.",
                               "Later."]
    choice_item = manifest["items"][1]
    assert choice_item["type"] == "text" and "speaker" not in choice_item
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Skip it", "Skip it", "Skip it", "continue"),
                   ("Look closer", "You look closer.", "You look closer.",
                    "continue")],
        "continuing": "Look closer", "continueAt": "Later."}]
    de = json.loads((out / "lang" / "de.json").read_text("utf-8"))
    assert {i["id"]: de["items"][i["id"]]["text"]
            for i in manifest["items"]} == dict(zip(
                [i["id"] for i in manifest["items"]],
                ["Vorweg.", "Lass es", "Du schaust hin.", "Später."]))
    decision = manifest["branches"][0]
    assert de["decisions"][decision["id"]]["prompt"]["text"] == "Was nun?"
    assert {k: v["text"] for k, v in
            de["decisions"][decision["id"]]["routes"].items()} == {
        decision["routes"][0]["id"]: "Lass es",
        decision["routes"][1]["id"]: "Genauer hinsehen"}
    check_folder(tmp_path, out, manifest)


def test_a_rejoin_into_another_choices_content_stays_linear(
        tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Hall":\n'
        '            jump hall\n'
        '        "Stairs":\n'
        '            "Up the stairs."\n'
        '            if lost:\n'
        '                jump hall_end\n'
        '            jump end\n'
        'label hall:\n    "The hall."\n'
        'label hall_end:\n    "The end of the hall."\n    jump end\n'
        'label end:\n    "The end."\n    return\n'))
    assert texts(manifest) == ["Lead.", "The hall.", "The end of the hall.",
                               "Up the stairs.", "The end."]
    assert manifest.get("branches", []) == []
    (reason,) = menu_reports(ledger)
    assert "choice 2 (Stairs) rejoins content read at" in reason
    assert "game/script.rpy:" in reason
    assert detection(ledger)[0]["result"] == "skipped"
    check_folder(tmp_path, out, manifest)


def test_in_place_menu_falling_through_continues(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "One":\n            "First."\n'
        '        "Two":\n            "Second."\n'
        '    "After."\n    return\n'))
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("One", "First.", "First.", "continue"),
                   ("Two", "Second.", "Second.", "continue")],
        "continuing": "Two", "continueAt": "After."}]
    check_folder(tmp_path, out, manifest)


def test_menu_at_the_story_end_stays_a_pure_choice(tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "One":\n            "First."\n'
        '        "Two":\n            "Second."\n'
        '    return\n'))
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("One", "First.", "First.", "ending"),
                   ("Two", "Second.", "Second.", "ending")],
        "continuing": None, "continueAt": None}]
    check_folder(tmp_path, out, manifest)


def test_conditional_choice_is_a_route(tmp_path: Path) -> None:
    """A conditional choice is a route labelled with its condition
    (Phase 60 item 9o): `key` is set nowhere, so not in words."""
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Open it" if key:\n            jump open\n'
        '        "Walk away":\n            "You walk away."\n'
        '    "Done."\n    return\n'
        'label open:\n    "It opens."\n    return\n'))
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Open it (not always offered)", "It opens.",
                    "It opens.", "ending"),
                   ("Walk away", "You walk away.", "Done.", "ending")],
        "continuing": None, "continueAt": None}]
    assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


@pytest.mark.parametrize("gap", ["", '    "Between."\n'])
def test_a_menu_straight_after_a_menu(tmp_path: Path, gap: str) -> None:
    """With a line between two menus each is a decision; with none the
    second gets a line before it, the converter's words, that both hang
    off (Phase 60 item 9o; it stayed linear before)."""
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "A":\n            "Line A."\n'
        '        "B":\n            "Line B."\n' + gap +
        '    menu:\n'
        '        "C":\n            "Line C."\n'
        '        "D":\n            "Line D."\n'
        '    "Last."\n    return\n'))
    got = shape(manifest)
    if gap:
        assert [d["continueAt"] for d in got] == ["Between.", "Last."]
        assert menu_reports(ledger) == []
    else:
        line = conditions.Words("en").say("menu.next")
        assert [d["continueAt"] for d in got] == [line, "Last."]
        assert got[1]["after"] == line
        assert menu_reports(ledger) == []
    check_folder(tmp_path, out, manifest)


def test_a_route_item_the_asset_pass_drops(tmp_path: Path) -> None:
    """The asset pass drops the River route's picture (and the line on
    it): the outer decision is withdrawn, linear flow kept, and the menu
    nested in the Forest route, whose join was the outer one's, keeps its
    routes as a pure choice."""
    game = tmp_path / "proj" / "game"
    (game / "images").mkdir(parents=True)
    (game / "images" / "broken.png").write_bytes(b"\x00" * 64)
    out, manifest, ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Forest":\n'
        '            "Into the forest."\n'
        '            menu:\n'
        '                "Climb":\n'
        '                    "You climb."\n'
        '                    jump camp\n'
        '                "Dig":\n'
        '                    "You dig."\n'
        '                    jump camp\n'
        '        "River":\n'
        '            scene broken\n'
        '            "To the river."\n'
        '            "The water is cold."\n'
        '            jump camp\n'
        'label camp:\n    scene bg\n    "At camp."\n    return\n'))
    assert texts(manifest) == ["Lead.", "Into the forest.", "You climb.",
                               "You dig.", "The water is cold.", "At camp."]
    assert shape(manifest) == [{
        "after": "Into the forest.",
        "routes": [("Climb", "You climb.", "You climb.", "ending"),
                   ("Dig", "You dig.", "You dig.", "ending")],
        "continuing": None, "continueAt": None}]
    assert any("route item dropped by the asset pass" in r
               for r in menu_reports(ledger))
    inner = next(n for n in detection(ledger) if n["result"] == "detected")
    assert "the join of an enclosing decision the asset pass withdrew" \
        in inner["note"]
    check_folder(tmp_path, out, manifest)
