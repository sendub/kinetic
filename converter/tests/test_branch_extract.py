"""Conservative `menu:` -> `branches` extraction (docs/plan.md Phase 13).

Golden-fixture assertions cover the detected decision (after, route
spans, ends); parse/timeline units cover the reported-skipped shapes
(nested menu, unknown statement or jump inside a block, a menu nothing
precedes); the CLI check covers the ledger notes, the summary line, and
validation of the detected output with tools/validate_content.py.
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
    assert len(branches) == 1
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
        assert route["result"] == "ending"
        assert ids.index(route["start"]) <= ids.index(route["end"])
        assert ids.index(route["start"]) > ids.index(decision["after"])
    # v1 never guesses a join: pure-choice decision, no continuingRoute.
    assert "continuingRoute" not in decision
    assert "continueAt" not in decision
    # The route spans tile the region: block two starts right after the
    # last item of block one, and nothing else was attributed.
    assert ids.index(routes[1]["start"]) == ids.index(routes[0]["end"]) + 1


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
    assert len(detected) == 1 and len(skipped) == 1
    assert "continuingRoute not emitted" in detected[0]["note"]
    assert detected[0]["source"] == "game/script.rpy:47"
    assert skipped[0]["source"] == "game/script.rpy:62"
    assert "jump inside a choice block" in skipped[0]["reason"]
    reasons = [r["reason"] for r in ledger["report"]]
    assert any("menu unsupported (jump inside a choice block" in r
               for r in reasons)


def test_cli_summary_counts_branches(tmp_path: Path, capsys) -> None:
    cli_main([str(FIXTURE), str(tmp_path / "out")])
    out = capsys.readouterr().out
    assert "branches: 1 detected, 1 menus skipped" in out
    assert "jump inside a choice block" in out  # reason list


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


def test_nested_menu_reported_unsupported() -> None:
    text = ("label start:\n"
            '    "lead"\n'
            "    menu:\n"
            '        "one":\n'
            '            "a"\n'
            "            menu:\n"
            '                "deep":\n'
            '                    "b"\n'
            '        "two":\n'
            '            "c"\n')
    parsed = parse_file(text, "game/x.rpy")
    assert all(m.skip_reason for m in parsed.menus)
    assert not any(e.kind == "menu-open" for e in parsed.events)
    reasons = [r.reason for r in parsed.reports]
    assert any("menu unsupported" in r and "nested menu" in r
               for r in reasons)
    # The whole block is skipped, contents and all: only the lead line
    # survives in the stream.
    assert [e.text for e in parsed.events if e.kind == "dialogue"] == ["lead"]


def test_jump_inside_block_and_unknown_stmt_each_reject() -> None:
    jumpy = ('label s:\n    "lead"\n    menu:\n        "one":\n'
             "            jump elsewhere\n        \"two\":\n            \"b\"\n")
    parsed = parse_file(jumpy, "game/x.rpy")
    assert any("menu unsupported" in r.reason and "jump inside" in r.reason
               for r in parsed.reports)
    assert not any(e.kind == "menu-open" for e in parsed.events)

    weird = ('label s:\n    "lead"\n    menu:\n        "one":\n'
             '            "a"\n            imgfl 12345\n        "two":\n'
             '            "b"\n')
    parsed = parse_file(weird, "game/x.rpy")
    assert any("menu unsupported" in r.reason
               and "unrecognized statement in a choice block" in r.reason
               for r in parsed.reports)
    assert not any(e.kind == "menu-open" for e in parsed.events)


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


def test_menu_with_empty_choice_block_is_unsupported(tmp_path: Path) -> None:
    parsed, result = _run(tmp_path,
                          '"lead"\nmenu:\n    "one":\n        with dissolve\n'
                          '    "two":\n        "b"\n')
    assert result.branch_candidates == []
    assert any("menu unsupported (choice 1 produced no item" in r.reason
               for r in parsed.reports)


def test_clean_menu_after_lead_in_becomes_a_candidate(tmp_path: Path) -> None:
    parsed, result = _run(tmp_path, '"lead"\n' + MENU_OK)
    assert len(result.branch_candidates) == 1
    cand = result.branch_candidates[0]
    assert cand["after_idx"] == 0
    assert [label for label, _s, _e in cand["route_spans"]] == ["one", "two"]
    assert parsed.reports == []
    assert parsed.menus[0].skip_reason is None
