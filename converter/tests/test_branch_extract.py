"""`menu:` -> `branches` extraction (docs/plan.md Phase 13; Phase 60
item 4 for choices that jump and the joins the walk proves).

Golden-fixture assertions cover the detected decisions (after, route
spans, results, the continuing route and `continueAt`); parse/timeline
units cover the shapes (a nested menu, a jump or an unknown statement in a
block, a conditional choice, an empty choice, a menu nothing precedes);
the CLI check covers the ledger notes, the summary line, and validation
of the detected output with tools/validate_content.py. Synthetic projects
for each kind of jump menu are in test_jump_menus.py.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from helpers import encoded_tracks, mask_tracks
from kinetic_extract.cli import main as cli_main
from kinetic_extract.parser import parse_file
from kinetic_extract.timeline import build_timeline

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "fixtures" / "renpy_demo"
GOLDEN = Path(__file__).parent / "data" / "renpy_demo.manifest.json"


def extract(tmp_path: Path) -> dict:
    rc = cli_main([str(FIXTURE), str(tmp_path)])
    assert rc == 0
    return json.loads((tmp_path / "manifest.json").read_text("utf-8"))


def load_ledger(tmp_path: Path) -> dict:
    return json.loads((tmp_path / "build-ledger.json").read_text("utf-8"))


# --- golden fixture: the detected decision ---------------------------------

def test_golden_manifest_carries_the_decision(tmp_path: Path) -> None:
    manifest = extract(tmp_path)
    encoded = encoded_tracks(manifest, load_ledger(tmp_path))
    assert mask_tracks(manifest, encoded) == mask_tracks(
        json.loads(GOLDEN.read_text("utf-8")), encoded)
    branches = manifest["branches"]
    assert len(branches) == 5
    decision = branches[0]
    ids = [i["id"] for i in manifest["items"]]
    assert decision["id"] == "menu-start-47"
    assert decision["id"] not in ids
    assert decision["prompt"] == "The evening is yours to spend."
    assert decision["after"] == "line-007"
    routes = decision["routes"]
    assert [(r["label"], r["start"], r["end"]) for r in routes] == [
        ("Warm the room again", "bg-room-008", "line-009"),
        ("Walk the garden path", "bg-yard-010", "line-011"),
    ]
    for route in routes:
        assert route["result"] == "continue"
        assert ids.index(route["start"]) <= ids.index(route["end"])
        assert ids.index(route["start"]) > ids.index(decision["after"])
    # Both choices fall through to the line after the menu: the walk's
    # join, so the last is the continuing route (Phase 60 item 4).
    assert decision["continuingRoute"] == "Walk-the-garden-path-2"
    assert decision["continueAt"] == "line-012"
    # The route spans tile the region: block two starts right after the
    # last item of block one, and nothing else was attributed.
    assert ids.index(routes[1]["start"]) == ids.index(routes[0]["end"]) + 1
    # The second menu's first choice jumps straight to label inside, where
    # the second choice's path goes too: its route is its choice text.
    second = branches[1]
    assert (second["id"], second["after"]) == ("menu-start-63", "line-012")
    assert [(r["label"], r["start"], r["end"], r["result"])
            for r in second["routes"]] == [
        ("Go back inside", "line-013", "line-013", "continue"),
        ("Stay under the stars", "line-014", "line-014", "continue")]
    assert manifest["items"][12]["text"] == "Go back inside"
    assert second["continuingRoute"] == "Stay-under-the-stars-2"
    assert second["continueAt"] == "bg-room-015"
    # The nightcap (Phase 60 item 9): a menu whose choices jump to a
    # shared label, the empty first choice its text, the refusal a
    # "return" through the lead-in; an `if` chain on its choice that
    # follows it; a counter chain labelled by ranges.
    drink, chain, counter = branches[2:]
    assert (drink["id"], drink["after"]) == ("menu-ask_drink-98",
                                             "bg-room-023")
    assert [(r["label"], r["start"], r["end"], r["result"])
            for r in drink["routes"]] == [
        ("Tea, please", "line-024", "line-024", "continue"),
        ("Cocoa", "line-025", "line-025", "continue"),
        ("Not yet", "line-026", "line-026", "return")]
    assert (drink["continuingRoute"], drink["continueAt"]) == (
        "Cocoa-2", "line-027")
    assert (chain["follows"], chain["after"]) == ("menu-ask_drink-98",
                                                  "line-027")
    assert [(r["label"], r["when"]) for r in chain["routes"]] == [
        ("If you chose: Tea, please", ["Tea-please-1"]),
        ("If you chose: Cocoa", ["Cocoa-2"])]
    assert chain["continueAt"] == "line-030"
    assert "follows" not in counter
    assert [r["label"] for r in counter["routes"]] == [
        "warmth 2 or more", "warmth exactly 1", "warmth under 1"]
    assert counter["continueAt"] == "candle-034"


def test_detected_choice_flow_stays_in_the_item_array() -> None:
    """A detected menu's items are ordinary items in flow order."""
    manifest = json.loads(GOLDEN.read_text("utf-8"))
    texts = [i.get("text") for i in manifest["items"]]
    assert "The fire crackles as the room warms." in texts
    assert "Somewhere past the hedge, water runs." in texts
    # Flow after the menu continues as ordinary items.
    assert "The night settles over the house." in texts


def test_ledger_notes_every_menu(tmp_path: Path) -> None:
    extract(tmp_path)
    ledger = load_ledger(tmp_path)
    notes = ledger["branchDetection"]
    detected = [n for n in notes if n["result"] == "detected"]
    skipped = [n for n in notes if n["result"] == "skipped"]
    assert len(detected) == 5 and skipped == []
    assert [n["source"] for n in detected] == [
        "game/script.rpy:47", "game/script.rpy:63", "game/script.rpy:98",
        "game/script.rpy:113", "game/script.rpy:118"]
    assert detected[0]["note"] == (
        "decision menu-start-47: 2 routes: 'Warm the room again' continue "
        "(reaches the join at game/script.rpy:59); 'Walk the garden path' "
        "continue (reaches the join at game/script.rpy:59); "
        "continuingRoute Walk-the-garden-path-2, continueAt line-012")
    assert "reaches the join at game/script.rpy:73" in detected[1]["note"]
    assert ("'Not yet' return (jumps back to the menu through its lead-in "
            "at game/script.rpy:97)") in detected[2]["note"]
    # The nightcap's chain (Phase 60 item 9b): its absent `else` is left
    # out, so 2 routes, and "Not yet", which sets nothing, keeps the value
    # the reset in label flow gives.
    assert detected[3]["note"].startswith(
        "decision if-nightcap-113: 2 routes: 'If you chose: Tea, please'")
    assert "kind follows" in detected[3]["note"]
    assert ('the choices there that set nothing start as "" from the '
            "reset at game/script.rpy:94") in detected[3]["note"]
    assert detected[4]["note"].startswith(
        "decision if-nightcap-118: 3 routes:")
    assert "start as" not in detected[4]["note"]
    assert "kind ranges" in detected[4]["note"]
    reasons = [r["reason"] for r in ledger["report"]]
    assert not any("menu unsupported" in r for r in reasons)


def test_cli_summary_counts_branches(tmp_path: Path, capsys) -> None:
    cli_main([str(FIXTURE), str(tmp_path / "out")])
    out = capsys.readouterr().out
    assert "branches: 5 detected, 0 menus skipped" in out


def test_detected_output_validates(tmp_path: Path) -> None:
    """The fixture now carries branches; the real validator must accept."""
    out = tmp_path / "out"
    proc = subprocess.run(
        [sys.executable, "-m", "kinetic_extract", str(FIXTURE), str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stderr
    proc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "validate_content.py"),
         str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stdout + proc.stderr


# --- reported-skipped shapes: parser units ---------------------------------

MENU_OK = ('menu "P?":\n    "one":\n        "a"\n    "two":\n        "b"\n')


def _bodies(parsed) -> list[list[tuple]]:
    (fork,) = [e.flow for e in parsed.events if e.kind == "fork"]
    return [[(e.kind, e.flow.target if e.flow and e.kind != "fork"
              else e.text) for e in body] for body in fork.bodies]


def test_nested_menu_is_a_fork_in_its_choice() -> None:
    """A menu in a choice block is read with the block (Phase 60 item 4):
    the outer menu's fork carries it, as a fork of its own, in the
    choice's events."""
    text = ("label start:\n"
            '    "lead"\n'
            "    menu:\n"
            '        "one":\n'
            '            "a"\n'
            "            menu:\n"
            '                "deep":\n'
            '                    "b"\n'
            '                "deeper":\n'
            '                    "c"\n'
            '        "two":\n'
            '            "d"\n')
    parsed = parse_file(text, "game/x.rpy")
    assert parsed.reports == []
    assert [m.choices for m in parsed.menus] == [["one", "two"],
                                                 ["deep", "deeper"]]
    assert all(m.skip_reason is None for m in parsed.menus)
    assert _bodies(parsed) == [[("dialogue", "a"), ("fork", "menu:")],
                               [("dialogue", "d")]]


def test_jump_and_unknown_statement_read_as_label_flow() -> None:
    """A choice block is label flow: a jump ends its path, an unknown
    statement is reported as in a label and the menu stays a decision."""
    jumpy = ('label s:\n    "lead"\n    menu:\n        "one":\n'
             "            jump elsewhere\n        \"two\":\n            \"b\"\n")
    parsed = parse_file(jumpy, "game/x.rpy")
    assert parsed.reports == []
    assert _bodies(parsed) == [[("jump", "elsewhere")], [("dialogue", "b")]]

    weird = ('label s:\n    "lead"\n    menu:\n        "one":\n'
             '            "a"\n            imgfl 12345\n        "two":\n'
             '            "b"\n')
    parsed = parse_file(weird, "game/x.rpy")
    assert [r.reason for r in parsed.reports] == [
        "unrecognized statement: imgfl 12345"]
    assert _bodies(parsed) == [[("dialogue", "a")], [("dialogue", "b")]]


def test_conditional_choice_and_label_in_a_block_reject() -> None:
    for text, why in (
            ('menu:\n    "one" if x:\n        "a"\n    "two":\n'
             '        "b"\n', "conditional choice: \"one\" if x:"),
            ('menu:\n    "one":\n        label inner:\n        "a"\n'
             '    "two":\n        "b"\n', "label inside a choice block")):
        parsed = parse_file(text, "game/x.rpy")
        assert [r.reason for r in parsed.reports] == [
            f"menu unsupported ({why}): branch skipped, linear flow kept"]
        assert parsed.menus[0].skip_reason == why
        # No decision fork: the blocks are skipped, their flow followed.
        assert not any(e.flow.menu is not None for e in parsed.events
                       if e.kind == "fork")


def test_single_choice_and_dedented_tail_reject() -> None:
    # A lone conditional choice is rejected; a lone plain one is a line
    # (Phase 60 item 3, test_one_choice_menu.py).
    parsed = parse_file('menu:\n    "only" if x:\n        "a"\n',
                        "game/x.rpy")
    assert any("fewer than two choices" in r.reason for r in parsed.reports)
    # After a rejected menu the walker resumes at the dedented lines.
    parsed = parse_file('menu\n    "one":\n        "a"\nlabel after:\n'
                        '    "tail"\n', "game/x.rpy")
    kinds = [e.kind for e in parsed.events]
    assert "menu-open" not in kinds
    assert any(e.kind == "label" and e.name == "after" for e in parsed.events)


# --- reported-skipped shapes: timeline units -------------------------------

def _run(tmp_path: Path, text: str):
    parsed = parse_file(text, "game/x.rpy")
    result = build_timeline([("game/x.rpy", parsed)], {}, {}, tmp_path)
    return parsed, result


def test_menu_with_no_items_before_is_unsupported(tmp_path: Path) -> None:
    parsed, result = _run(tmp_path, MENU_OK)
    assert result.branch_candidates == []
    assert any("menu unsupported (no item precedes the menu" in r.reason
               for r in parsed.reports)
    assert parsed.menus[0].skip_reason == (
        "no item precedes the menu in the walked flow")
    # The block's lines still play: linear flow kept.
    assert [r.item.get("text") for r in result.items] == ["a", "b"]


def test_empty_choice_block_gets_its_text(tmp_path: Path) -> None:
    parsed, result = _run(tmp_path,
                          '"lead"\nmenu:\n    "one":\n        with dissolve\n'
                          '    "two":\n        "b"\n')
    assert [r.item.get("text") for r in result.items] == ["lead", "one", "b"]
    (cand,) = result.branch_candidates
    assert cand["route_spans"] == [("one", 1, 1), ("two", 2, 2)]
    assert result.items[1].string_sources == {"game/x.rpy:3"}
    assert parsed.reports == []


def test_menu_every_choice_of_which_is_empty_is_unsupported(
        tmp_path: Path) -> None:
    parsed, result = _run(tmp_path,
                          '"lead"\nmenu:\n    "one":\n        pass\n'
                          '    "two":\n        with dissolve\n"after"\n')
    assert result.branch_candidates == []
    assert [r.item.get("text") for r in result.items] == ["lead", "after"]
    assert any("menu unsupported (every choice is empty" in r.reason
               for r in parsed.reports)


def test_clean_menu_after_lead_in_becomes_a_candidate(tmp_path: Path) -> None:
    parsed, result = _run(tmp_path, '"lead"\n' + MENU_OK)
    assert len(result.branch_candidates) == 1
    cand = result.branch_candidates[0]
    assert cand["after_idx"] == 0
    assert [label for label, _s, _e in cand["route_spans"]] == ["one", "two"]
    assert parsed.reports == []
    assert parsed.menus[0].skip_reason is None
