"""Malformed branches never hang a tool (docs/plan.md Phase 57 item 7c):
the validator, `kinetic report`, `routes` and `export` each finish on a
folder whose decisions break the span rules, saying so, and the
library's reading walks end on them too. Each tool runs as a child
process under a time limit, so a hang fails the test rather than the
run."""

from __future__ import annotations

import json
import random
import signal
import subprocess
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from kinetic_extract import folder_model, report, routes

REPO_ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = REPO_ROOT / "tools" / "validate_content.py"
BOUND_S = 30  # each run takes about a second; past this it hangs


def text(item_id: str) -> dict[str, Any]:
    return {"id": item_id, "type": "text", "text": f"Line {item_id}."}


def route(route_id: str, start: str, end: str) -> dict[str, Any]:
    return {"id": route_id, "label": route_id.upper(), "start": start,
            "end": end, "result": "ending"}


ITEMS = [text(i) for i in "abcdefgh"]

# Decisions breaking the span rules: the readings are not well defined.
BROKEN: dict[str, list[Any]] = {
    # The join lies before the routes: the reading would loop for ever.
    "backward continueAt": [
        {"id": "q", "prompt": "?", "after": "b", "continuingRoute": "x",
         "continueAt": "a",
         "routes": [route("x", "c", "c"), route("y", "d", "d")]}],
    # A route holding its own decision's `after` item.
    "route around its after": [
        {"id": "q", "prompt": "?", "after": "c",
         "routes": [route("x", "b", "d"), route("y", "e", "e")]}],
    # Two routes of one decision overlapping, the join inside the second.
    "overlapping routes": [
        {"id": "q", "prompt": "?", "after": "a", "continuingRoute": "x",
         "continueAt": "d",
         "routes": [route("x", "b", "e"), route("y", "c", "f")]}],
    # Each decision's `after` inside the other's route.
    "mutual nesting": [
        {"id": "p", "prompt": "?", "after": "b", "continuingRoute": "x",
         "continueAt": "a",
         "routes": [route("x", "c", "e"), route("y", "f", "f")]},
        {"id": "q", "prompt": "?", "after": "d", "continuingRoute": "x",
         "continueAt": "c",
         "routes": [route("x", "a", "b"), route("y", "g", "g")]}],
}
# Spans in order, but what the schema rejects: a list for an id, and an
# entry that is not an object (which the player drops).
ODD = [
    {"id": ["q"], "prompt": "?", "after": "a", "continuingRoute": "x",
     "continueAt": "e",
     "routes": [route("x", "b", "c"), route("y", "d", "d")]},
    "not a decision"]


def write(tmp_path: Path, branches: list[Any]) -> Path:
    folder = tmp_path / "game"
    folder.mkdir()
    (folder / "manifest.json").write_text(json.dumps(
        {"schemaVersion": 1, "title": "Malformed", "items": ITEMS,
         "branches": branches}), encoding="utf-8")
    return folder


def problems_of(branches: list[Any]) -> list[str]:
    return folder_model.span_problems(
        folder_model.resolve_decisions(ITEMS, branches))


def run(*argv: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, *argv], capture_output=True,
                          text=True, timeout=BOUND_S, cwd=REPO_ROOT)


def kinetic(*args: str) -> subprocess.CompletedProcess[str]:
    return run("-m", "kinetic_extract.kinetic_cli", *args)


@contextmanager
def deadline(seconds: int = BOUND_S) -> Iterator[None]:
    """Fail, rather than hang, when the block runs past `seconds`."""
    def expire(_signum: int, _frame: Any) -> None:
        raise TimeoutError(f"still running after {seconds} s")
    previous = signal.signal(signal.SIGALRM, expire)
    signal.alarm(seconds)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def test_each_broken_shape_breaks_the_span_rules() -> None:
    for name, branches in BROKEN.items():
        assert problems_of(branches), name
    assert problems_of(ODD) == []


@pytest.mark.parametrize("name", list(BROKEN))
def test_validator_lists_the_problems_and_stops(tmp_path: Path,
                                                name: str) -> None:
    proc = run(str(VALIDATOR), str(write(tmp_path, BROKEN[name])))
    assert proc.returncode == 1, proc.stdout + proc.stderr
    # The span problems are the validator's own lines, word for word.
    assert set(problems_of(BROKEN[name])) <= set(proc.stdout.splitlines())
    assert "never shown" not in proc.stderr


def test_validator_on_odd_ids_and_entries(tmp_path: Path) -> None:
    proc = run(str(VALIDATOR), str(write(tmp_path, ODD)))
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert "branches[1]" in proc.stdout  # the stray entry, from the schema


@pytest.mark.parametrize("name", list(BROKEN))
def test_report_runs_without_the_timing(tmp_path: Path, name: str) -> None:
    folder = write(tmp_path, BROKEN[name])
    expected = problems_of(BROKEN[name])
    proc = kinetic("report", str(folder))
    assert proc.returncode == 1, proc.stderr
    assert "not worked out: the branches are malformed" in proc.stdout
    for problem in expected:
        assert f"    {problem}" in proc.stdout.splitlines()
    assert "Speakers:" in proc.stdout  # the rest of the report is there
    assert "the reading times are not worked out" in proc.stderr
    data = kinetic("report", str(folder), "--json")
    assert data.returncode == 1
    timing = json.loads(data.stdout)["timing"]
    assert timing["branchProblems"] == expected
    assert (timing["everything"], timing["shortestMs"],
            timing["decisions"]) == (None, None, [])


@pytest.mark.parametrize("name", list(BROKEN))
@pytest.mark.parametrize("form", [[], ["--dot"], ["--json"]])
def test_routes_stops_with_the_problems(tmp_path: Path, name: str,
                                        form: list[str]) -> None:
    proc = kinetic("routes", str(write(tmp_path, BROKEN[name])), *form)
    assert (proc.returncode, proc.stdout) == (1, ""), proc.stderr
    assert "the branches are malformed" in proc.stderr
    for problem in problems_of(BROKEN[name]):
        assert f"  {problem}" in proc.stderr.splitlines()


@pytest.mark.parametrize("name", list(BROKEN))
def test_export_stops_with_the_problems(tmp_path: Path, name: str) -> None:
    folder = write(tmp_path, BROKEN[name])
    out = tmp_path / "out"
    for extra in ([], ["--out", str(out)]):
        proc = kinetic("export", str(folder), *extra)
        assert (proc.returncode, proc.stdout) == (1, ""), proc.stderr
        assert "the branches are malformed" in proc.stderr
    assert not out.exists()


def test_tools_take_odd_ids_and_entries(tmp_path: Path) -> None:
    folder = write(tmp_path, ODD)
    proc = kinetic("report", str(folder))
    assert proc.returncode == 0, proc.stderr
    assert "decision ['q']" in proc.stdout
    for form in ([], ["--dot"], ["--json"]):
        proc = kinetic("routes", str(folder), *form)
        assert proc.returncode == 0, proc.stderr
    assert "branches the player drops (kinetic validate says why): None" \
        in kinetic("routes", str(folder)).stdout
    proc = kinetic("export", str(folder), "--out", str(tmp_path / "out"))
    assert proc.returncode == 0, proc.stderr


@pytest.mark.parametrize("name", [*BROKEN, "odd"])
def test_library_walks_end(name: str) -> None:
    """Called directly, past the tools' checks, the walks still end."""
    branches = BROKEN.get(name, ODD)
    manifest = {"items": ITEMS, "branches": branches}
    with deadline():
        decisions = folder_model.resolve_decisions(ITEMS, branches)
        shown = folder_model.shown_by_play_all(ITEMS, decisions)
        assert 0 in shown
        holds = report.item_holds(manifest)
        assert report._shortest_ms(holds, decisions) >= 0
        routes.build_model(manifest).counts()
        report.timing_section(manifest)


def test_backward_join_shows_what_the_loop_shows() -> None:
    """The walk stops where it would start repeating, with every item the
    endless loop shows: the opening, `after`, both routes."""
    decisions = folder_model.resolve_decisions(
        ITEMS, BROKEN["backward continueAt"])
    with deadline():
        assert folder_model.shown_by_play_all(ITEMS, decisions) \
            == {0, 1, 2, 3}


def test_library_walks_end_on_random_shapes() -> None:
    """Seeded shapes of every kind, malformed ones included (overlaps,
    joins before their routes, routes around their own `after`)."""
    from test_decision_scale import random_shape

    rng = random.Random(77)
    broken = 0
    with deadline():
        for _case in range(400):
            shape = random_shape(rng)
            items = [{**item, "type": "text", "text": item["id"]}
                     for item in shape["items"]]
            manifest = {"items": items, "branches": shape["branches"]}
            decisions = folder_model.resolve_decisions(items,
                                                       shape["branches"])
            broken += bool(folder_model.span_problems(decisions))
            if decisions:
                folder_model.shown_by_play_all(items, decisions)
            report._shortest_ms(report.item_holds(manifest), decisions)
            routes.build_model(manifest).counts()
    assert broken > 100
