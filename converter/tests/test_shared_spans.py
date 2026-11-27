"""Shared spans in the folder model and the tools (docs/content-format.md,
"Branches"; docs/plan.md Phase 60 item 9e): `resolve_decisions` carries
a decision's `shared` spans and each route's `then`, `span_problems`
words a span's breaks as the validator does, and `kinetic report`,
`routes` and `export` run on a manifest that has them."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from kinetic_extract import folder_model

REPO_ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = REPO_ROOT / "tools" / "validate_content.py"
BOUND_S = 30


def text(item_id: str) -> dict[str, Any]:
    return {"id": item_id, "type": "text", "text": f"Line {item_id}."}


ITEMS = [text(i) for i in "abcdefghijk"]


def route(route_id: str, start: str, end: str, **extra: Any
          ) -> dict[str, Any]:
    return {"id": route_id, "label": route_id.upper(), "start": start,
            "end": end, **extra}


# `outer` off a: o1 at b..f holding `inner`, o2 at g (continuing, joining
# at j), the span `fall` at h..i ("continue"); `inner` off c: i1 at d,
# then `fall`, the enclosing decision's span, and i2 at e (continuing,
# joining at f).
NESTED: list[Any] = [
    {"id": "outer", "prompt": "?", "after": "a", "continuingRoute": "o2",
     "continueAt": "j",
     "routes": [route("o1", "b", "f"), route("o2", "g", "g")],
     "shared": [{"id": "fall", "start": "h", "end": "i",
                 "result": "continue"}]},
    {"id": "inner", "prompt": "?", "after": "c", "continuingRoute": "i2",
     "continueAt": "f",
     "routes": [route("i1", "d", "d", then="fall"), route("i2", "e", "e")]},
]


def decisions_of(branches: list[Any]) -> list[folder_model.Decision]:
    return folder_model.resolve_decisions(ITEMS, branches)


def test_decisions_carry_their_spans_and_thens() -> None:
    outer, inner = decisions_of(NESTED)
    assert [(s.start, s.end, s.result, s.id) for s in outer.shared] == [
        (7, 8, "continue", "fall")]
    assert inner.shared == []
    assert outer.thens == [None, None]
    assert inner.thens == [(outer.index, 0), None]
    # The routes keep their shape for the tools that read them.
    assert outer.routes == [(1, 5, "ending"), (6, 6, "ending")]


def test_a_then_resolves_to_its_own_decision_first() -> None:
    branches = json.loads(json.dumps(NESTED))
    branches[1]["shared"] = [{"id": "fall", "start": "f", "end": "f"}]
    branches[1]["continueAt"] = "g"  # past the inner span
    branches[0]["routes"][0]["end"] = "f"
    outer, inner = decisions_of(branches)
    assert inner.thens == [(inner.index, 0), None]
    assert [(s.start, s.end, s.result) for s in inner.shared] == [
        (5, 5, "ending")]


def test_an_unresolved_then_reads_as_absent() -> None:
    branches = json.loads(json.dumps(NESTED))
    branches[1]["routes"][0]["then"] = "ghost"
    _outer, inner = decisions_of(branches)
    assert inner.thens == [None, None]


def overlapping() -> list[Any]:
    branches = json.loads(json.dumps(NESTED))
    branches[0]["shared"][0]["start"] = "g"  # onto the route o2
    return branches


def test_span_problems_name_a_span_overlapping_a_route() -> None:
    assert folder_model.span_problems(decisions_of(overlapping())) == [
        "manifest.json: branches[0].shared[0]: shared span items[6]..items[8]"
        " overlaps the span items[6]..items[6] of branches[0].routes[1]"]


def write(tmp_path: Path, branches: list[Any]) -> Path:
    folder = tmp_path / "game"
    folder.mkdir()
    (folder / "manifest.json").write_text(json.dumps(
        {"schemaVersion": 1, "title": "Shared", "items": ITEMS,
         "branches": branches}), encoding="utf-8")
    return folder


def run(*argv: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, *argv], capture_output=True,
                          text=True, timeout=BOUND_S, cwd=REPO_ROOT)


def kinetic(*args: str) -> subprocess.CompletedProcess[str]:
    return run("-m", "kinetic_extract.kinetic_cli", *args)


def test_span_problems_are_the_validators_lines(tmp_path: Path) -> None:
    proc = run(str(VALIDATOR), str(write(tmp_path, overlapping())))
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert set(folder_model.span_problems(decisions_of(overlapping()))) \
        <= set(proc.stdout.splitlines())


@pytest.mark.parametrize("args", [
    ["report"], ["report", "--json"], ["routes"], ["routes", "--dot"],
    ["routes", "--json"], ["export"]])
def test_the_tools_run_on_shared_spans(tmp_path: Path,
                                       args: list[str]) -> None:
    folder = write(tmp_path, NESTED)
    proc = kinetic(args[0], str(folder), *args[1:])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "Traceback" not in proc.stderr


def test_the_reach_walk_follows_a_then_into_its_span() -> None:
    """Play-all from the opening (`shown_by_play_all`): o1 first, its
    nested i1 reads `fall`, the enclosing decision's span, which leaves
    o1 there (e, i2, and f, its join, unread), and the span's "continue"
    re-offers `outer` while o2 is unplayed; o2 then joins at j."""
    shown = folder_model.shown_by_play_all(ITEMS, decisions_of(NESTED))
    assert sorted(shown) == [0, 1, 2, 3, 6, 7, 8, 9, 10]


def test_the_reach_walk_closes_a_pure_choice_past_its_span() -> None:
    """A pure choice whose routes both read a span laid after them: each
    route's end goes into the span, its end re-offers the choice, and
    with every route played the close continues past the span."""
    branches = [{"id": "p", "prompt": "?", "after": "a",
                 "routes": [route("p1", "b", "b", then="tail"),
                            route("p2", "c", "c", then="tail")],
                 "shared": [{"id": "tail", "start": "e", "end": "f"}]}]
    shown = folder_model.shown_by_play_all(ITEMS, decisions_of(branches))
    assert sorted(shown) == [0, 1, 2, 4, 5] + list(range(6, 11))
