"""`kinetic routes <folder>` (docs/plan.md Phase 57 item 6): the outline,
DOT and JSON on the demo and on a synthetic folder with nested decisions
and rejoins, its exit codes, and the branch map's counts on the shared
shapes (fixtures/route-shapes.json, which
player/src/render/routeshape.test.ts holds the map to)."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path

import pytest

from kinetic_extract import kinetic_cli, routes

REPO_ROOT = Path(__file__).resolve().parents[2]
DEMO = REPO_ROOT / "fixtures" / "demo"
SHAPES = json.loads((REPO_ROOT / "fixtures" / "route-shapes.json")
                    .read_text(encoding="utf-8"))["cases"]
NESTED = next(c for c in SHAPES if c["name"] == "nested decisions and rejoins")
FOLLOWS = next(c for c in SHAPES
               if c["name"] == "a decision that follows another")
SPANS = next(c for c in SHAPES if c["name"] == "shared spans")

needs_demo = pytest.mark.skipif(
    not (DEMO / "manifest.json").is_file(),
    reason="fixtures/demo not built (.venv/bin/python fixtures/build_demo.py)")


def shape_manifest(case: dict) -> dict:
    if "folder" in case:
        return json.loads((REPO_ROOT / case["folder"] / "manifest.json")
                          .read_text(encoding="utf-8"))
    return {"schemaVersion": 1, "title": case["name"],
            "items": [{"id": i, "type": "text", "text": i}
                      for i in case["items"]],
            "branches": case["branches"]}


def write_folder(tmp_path: Path, manifest: dict) -> Path:
    folder = tmp_path / "game"
    folder.mkdir()
    (folder / "manifest.json").write_text(json.dumps(manifest),
                                          encoding="utf-8")
    return folder


def run_cli(argv: list[str], capsys: pytest.CaptureFixture[str]
            ) -> tuple[int, str, str]:
    code = kinetic_cli.main(argv)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


@pytest.mark.parametrize("case", SHAPES, ids=[c["name"] for c in SHAPES])
def test_counts_equal_the_branch_maps(case: dict) -> None:
    if "folder" in case and not (REPO_ROOT / case["folder"]
                                 / "manifest.json").is_file():
        pytest.skip(f"{case['folder']} not built")
    assert routes.build_model(shape_manifest(case)).counts() == case["expect"]


def test_outline_of_nested_decisions_and_rejoins(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    folder = write_folder(tmp_path, shape_manifest(NESTED))
    code, out, err = run_cli(["routes", str(folder)], capsys)
    assert code == 0 and err == ""
    body = out.split("\n", 1)[1]
    assert body == """\
nested decisions and rejoins: 22 items, 3 decisions, 8 routes, 4 endings

main line: 6 items
  items s0..s1 (2 items)
  decision outer after s1, carries on at t0: "Which way?"
    1. route r1 "The long way": continuing, 7 items, p0..p2; joins at t0
      items p0..p1 (2 items)
      decision inner after p1, carries on at p2: "And then?"
        1. route q1 "Wait": continuing, 1 item, q1a; joins at p2
          items q1a (1 item)
        2. route q2 "Talk": continue, 2 items, q2a..q2b; joins at p2
          items q2a..q2b (2 items)
        3. route q3 "Leave": ending, 1 item, q3a; an ending (the choice is offered again)
          items q3a (1 item)
      items p2 (1 item)
    2. route r2 "The short cut": continue, 2 items, m0..m1; joins at t0
      items m0..m1 (2 items)
    3. route r3 "Give up": ending, 1 item, e0; an ending (the choice is offered again)
      items e0 (1 item)
  items t0..t1 (2 items)
  decision pure after t1, a pure choice: carries on at z0 once every route has played: "Look at what?"
    1. route u1 "The sea": ending, 1 item, u1a; an ending (the choice is offered again)
      items u1a (1 item)
    2. route u2 "The sky": return, 2 items, u2a..u2b; returns to the choice
      items u2a..u2b (2 items)
  items z0..z1 (2 items)
  the story ends at z1

decisions on no line (their after item lies where no line reaches):
  stray after gap0

branches the player drops (kinetic validate says why): broken

items on no line: 3 items (gap0, w0, w1)

never reached from the opening: 3 items (gap0, w0, w1)
"""


def test_outline_of_a_decision_that_follows_another(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """What `second` follows, the pick each route takes, and the pick no
    route takes, which passes the decision on (docs/content-format.md,
    "Branches")."""
    folder = write_folder(tmp_path, shape_manifest(FOLLOWS))
    code, out, err = run_cli(["routes", str(folder)], capsys)
    assert code == 0 and err == ""
    body = out.split("\n", 1)[1]
    assert body == """\
a decision that follows another: 10 items, 2 decisions, 5 routes, 1 ending

main line: 4 items
  items s0 (1 item)
  decision first after s0, carries on at m0: "Which door?"
    1. route a "Door A": continue, 1 item, a0; joins at m0
      items a0 (1 item)
    2. route b "Door B": continue, 1 item, b0; joins at m0
      items b0 (1 item)
    3. route c "Door C": continuing, 1 item, c0; joins at m0
      items c0 (1 item)
  items m0 (1 item)
  decision second after m0, follows first, carries on at j0: "So far?"
    1. route x "After A": continue, 1 item, x0; after a at first; joins at j0
      items x0 (1 item)
    2. route y "After C": continuing, 2 items, y0..y1; after c at first; joins at j0
      items y0..y1 (2 items)
    after b at first: no route, the decision passes on to j0
  items j0..e0 (2 items)
  the story ends at e0

every item is reached from the opening
"""


def test_a_route_without_when_takes_every_other_pick(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    manifest = copy.deepcopy(shape_manifest(FOLLOWS))
    del manifest["branches"][1]["routes"][1]["when"]
    code, out, _err = run_cli(["routes", str(write_folder(tmp_path,
                                                          manifest))], capsys)
    assert code == 0
    assert ('    2. route y "After C": continuing, 2 items, y0..y1; after '
            'any other pick at first; joins at j0') in out
    assert "no route, the decision passes on" not in out


def test_json_and_dot_of_a_decision_that_follows_another(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    folder = write_folder(tmp_path, shape_manifest(FOLLOWS))
    code, out, _err = run_cli(["routes", str(folder), "--json"], capsys)
    assert code == 0
    first, second = (e for e in json.loads(out)["mainLine"]["line"]
                     if e["kind"] == "decision")
    assert (first["follows"], first["passesOn"]) == (None, [])
    assert [r["when"] for r in first["routes"]] == [None, None, None]
    assert (second["follows"], second["passesOn"]) == ("first", ["b"])
    assert [r["when"] for r in second["routes"]] == [["a"], ["c"]]
    code, out, _err = run_cli(["routes", str(folder), "--dot"], capsys)
    assert code == 0
    lines = out.splitlines()
    for line in [
        'd1 [shape=diamond, label="second\\nSo far?\\nfollows first"];',
        'd1 -> s5 [label="1. After A (after a)"];',
        'd1 -> s6 [label="2. After C (after c)"];',
        'd1 -> s8 [style=dotted, label="after b: passes on"];',
    ]:
        assert f"  {line}" in lines, (line, out)


def test_a_follows_the_player_ignores_is_not_printed(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """A `follows` naming no decision leaves an ordinary decision, as the
    player plays it (the validator reports it)."""
    manifest = copy.deepcopy(shape_manifest(FOLLOWS))
    manifest["branches"][1]["follows"] = "ghost"
    code, out, _err = run_cli(["routes", str(write_folder(tmp_path,
                                                          manifest))], capsys)
    assert code == 0
    assert ", follows" not in out and "after a at first" not in out


def test_outline_of_shared_spans(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """Each decision's shared spans after its routes, with where each
    leads and the routes reaching it, nested ones included; each route
    with `then` names its span (docs/content-format.md, "Branches"). A
    pure choice's line carries on past its spans too."""
    folder = write_folder(tmp_path, shape_manifest(SPANS))
    code, out, err = run_cli(["routes", str(folder)], capsys)
    assert code == 0 and err == ""
    body = out.split("\n", 1)[1]
    assert body == """\
shared spans: 17 items, 3 decisions, 8 routes, 3 endings, 3 shared spans

main line: 3 items
  items s0 (1 item)
  decision fight after s0, carries on at j0: "What now?"
    1. route a "Attack": ending, 2 items, a0..a1; then fail
      items a0..a1 (2 items)
    2. route b "Sneak": continue, 6 items, b0..b2; joins at j0
      items b0 (1 item)
      decision sneak after b0, carries on at b2: "Where?"
        1. route x "Run": ending, 1 item, x0; then fail (decision fight)
          items x0 (1 item)
        2. route y "Wait": continuing, 1 item, y0; joins at b2
          items y0 (1 item)
        3. route w "Peek": continue, 1 item, w0; then caught
          items w0 (1 item)
        shared span caught: continue, 1 item, k0; joins at b2; reached from routes sneak/w
          items k0 (1 item)
      items b2 (1 item)
    3. route c "Talk": continuing, 1 item, c0; joins at j0
      items c0 (1 item)
    shared span fail: ending, 2 items, f0..f1; an ending (the choice is offered again); reached from routes fight/a, sneak/x
      items f0..f1 (2 items)
  items j0 (1 item)
  decision look after j0, a pure choice: carries on at e0 once every route has played: "Look at?"
    1. route u1 "The sea": ending, 1 item, u1a; then tail
      items u1a (1 item)
    2. route u2 "The sky": return, 1 item, u2a; returns to the choice
      items u2a (1 item)
    shared span tail: ending, 1 item, t0; an ending (the choice is offered again); reached from routes look/u1
      items t0 (1 item)
  items e0 (1 item)
  the story ends at e0

never reached from the opening: 4 items (y0, w0, k0, b2)
"""


def test_json_and_dot_of_shared_spans(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    folder = write_folder(tmp_path, shape_manifest(SPANS))
    code, out, _err = run_cli(["routes", str(folder), "--json"], capsys)
    assert code == 0
    data = json.loads(out)
    assert data["counts"] == SPANS["expect"]
    fight = data["mainLine"]["line"][1]
    a, b, c = fight["routes"]
    assert (a["outcome"], a["then"], a["thenDecision"], a["joinsAt"]) == \
        ("shared", "fail", "fight", None)
    assert (c["outcome"], c["then"], c["thenDecision"]) == \
        ("continues", None, None)
    sneak = b["line"][1]
    x = sneak["routes"][0]
    assert (x["then"], x["thenDecision"]) == ("fail", "fight")
    assert fight["shared"] == [{
        "id": "fail", "result": "ending", "outcome": "ends", "items": 2,
        "first": "f0", "last": "f1", "joinsAt": None,
        "reachedFrom": ["fight/a", "sneak/x"],
        "line": [{"kind": "items", "first": "f0", "last": "f1",
                  "items": 2}]}]
    caught = sneak["shared"][0]
    assert (caught["outcome"], caught["joinsAt"], caught["reachedFrom"]) == \
        ("continues", "b2", ["sneak/w"])
    assert data["offLine"] == []
    code, out, _err = run_cli(["routes", str(folder), "--dot"], capsys)
    assert code == 0
    lines = out.splitlines()
    # fight is decision 0, sneak 1, look 2; a span is one node, its items.
    for line in [
        'x0_0 [shape=box, style="rounded,bold", '
        'label="shared span fail\\nf0..f1\\n2 items"];',
        's1 -> x0_0 [label="then"];',  # a's line into the span
        's4 -> x0_0 [label="then"];',  # sneak/x, nested, out to fight's
        's6 -> x1_0 [label="then"];',  # sneak/w into its own decision's
        'x1_0 -> s8;',  # caught continues: joins at b2
        'x2_0 [shape=box, style="rounded,bold", '
        'label="shared span tail\\nt0\\n1 item"];',
        'd2 -> s16 [style=dotted, label="after every route"];',
    ]:
        assert f"  {line}" in lines, (line, out)
    assert sum("shape=doublecircle" in line for line in lines) == \
        SPANS["expect"]["endings"]
    assert re.search(r"\bs10\b", out) is None  # fail's items: its node


def test_a_pure_choice_running_to_the_end(tmp_path: Path) -> None:
    case = next(c for c in SHAPES if c["name"] == "pure choice to the end")
    data = routes.model_json(routes.build_model(shape_manifest(case)),
                             tmp_path, shape_manifest(case))
    decision = data["mainLine"]["line"][1]
    assert decision["pureChoice"] is True
    assert decision["carriesOnAt"] is None and data["storyEnd"] is None
    assert routes.decision_then(decision) == \
        "a pure choice: the story ends once every route has played"


def test_json_is_the_model(tmp_path: Path,
                           capsys: pytest.CaptureFixture[str]) -> None:
    folder = write_folder(tmp_path, shape_manifest(NESTED))
    code, out, _err = run_cli(["routes", str(folder), "--json"], capsys)
    assert code == 0
    data = json.loads(out)
    assert data["counts"] == NESTED["expect"]
    assert data["mainLine"]["items"] == 6
    outer = data["mainLine"]["line"][1]
    assert outer["id"] == "outer" and outer["continueAt"] == "t0"
    r1, r2, r3 = outer["routes"]
    assert (r1["result"], r1["outcome"], r1["joinsAt"]) == \
        ("continuing", "continues", "t0")
    assert (r2["result"], r2["outcome"], r2["joinsAt"]) == \
        ("continue", "continues", "t0")
    assert (r3["result"], r3["outcome"], r3["joinsAt"]) == \
        ("ending", "ends", None)
    inner = r1["line"][1]
    assert inner["kind"] == "decision" and inner["id"] == "inner"
    assert [r["id"] for r in inner["routes"]] == ["q1", "q2", "q3"]
    assert r1["line"][2] == {"kind": "items", "first": "p2", "last": "p2",
                             "items": 1}
    assert data["notDrawn"] == [{"id": "stray", "after": "gap0"}]
    assert data["dropped"] == ["broken"]
    assert data["offLine"] == data["unreachable"] == ["gap0", "w0", "w1"]
    assert data["storyEnd"] == "z1"


def test_dot(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    folder = write_folder(tmp_path, shape_manifest(NESTED))
    code, out, _err = run_cli(["routes", str(folder), "--dot"], capsys)
    assert code == 0
    lines = out.splitlines()
    assert lines[0] == "digraph routes {" and lines[-1] == "}"
    # outer is decision 0, inner 1, stray 2, pure 3 (resolved order).
    for line in [
        's0 [shape=box, label="s0..s1\\n2 items"];',
        's0 -> d0;',
        'd0 [shape=diamond, label="outer\\nWhich way?"];',
        'd0 -> s2 [label="1. The long way"];',
        'd0 -> s9 [label="2. The short cut"];',
        'd0 -> s11 [label="3. Give up"];',
        # Inside r1: the nested decision and its rejoins at p2.
        's2 -> d1;',
        's4 -> s8;',  # q1 joins at p2
        's5 -> s8;',  # q2 ("continue") joins at p2
        's8 -> s15;',  # r1's end joins at t0
        's9 -> s15;',  # r2 ("continue") joins at t0
        # The pure choice: a return route goes back, and the decision
        # carries on past its region once every route has played.
        's18 -> d3 [style=dashed, label="back"];',
        'd3 -> s20 [style=dotted, label="after every route"];',
    ]:
        assert f"  {line}" in lines, line
    assert sum('shape=doublecircle' in line for line in lines) == \
        NESTED["expect"]["endings"]
    assert re.search(r"\bd2\b", out) is None  # stray, on no line


def test_dot_routes_joining_past_their_line_share_its_end(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """deep's routes join at x0, past the end of r1 that holds them, so
    they lead where r1 does: one end mark, as the map draws."""
    case = next(c for c in SHAPES
                if c["name"] == "a nested join past its route's end")
    folder = write_folder(tmp_path, shape_manifest(case))
    code, out, _err = run_cli(["routes", str(folder), "--dot"], capsys)
    assert code == 0
    lines = out.splitlines()
    assert sum("shape=doublecircle" in line for line in lines) == 2
    assert "  s3 -> end1;" in lines and "  s4 -> end1;" in lines


def test_dot_escapes_quotes(tmp_path: Path,
                            capsys: pytest.CaptureFixture[str]) -> None:
    manifest = shape_manifest(NESTED)
    manifest["branches"][0]["prompt"] = 'Say "{i}hi{/i}"'
    code, out, _err = run_cli(
        ["routes", str(write_folder(tmp_path, manifest)), "--dot"], capsys)
    assert code == 0
    assert 'label="outer\\nSay \\"hi\\""' in out


@needs_demo
def test_the_demo(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = run_cli(["routes", str(DEMO)], capsys)
    assert code == 0 and err == ""
    assert "2 decisions, 4 routes, 2 endings" in out
    assert ('decision outer after branch-decide, carries on at after-start: '
            '"Demo decision: which route?"') in out
    assert ('        2. route nest-b "1b: comes back to this decision": '
            'return, 1 item, nest-return; returns to the choice') in out
    assert "every item is reached from the opening" in out
    code, out, _err = run_cli(["routes", str(DEMO), "--dot"], capsys)
    assert code == 0 and out.startswith("digraph routes {")
    code, out, _err = run_cli(["routes", str(DEMO), "--json"], capsys)
    assert code == 0 and json.loads(out)["counts"]["routes"] == 4


def test_exit_2_for_an_unreadable_folder(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = run_cli(["routes", str(tmp_path / "missing")], capsys)
    assert code == 2 and out == ""
    assert err.startswith("kinetic routes: ")
    (tmp_path / "manifest.json").write_text("[1, 2]", encoding="utf-8")
    code, _out, err = run_cli(["routes", str(tmp_path)], capsys)
    assert code == 2 and "not a JSON object" in err


@pytest.mark.parametrize("argv", [["routes"],
                                  ["routes", "x", "--dot", "--json"]])
def test_exit_2_for_bad_arguments(argv: list[str]) -> None:
    with pytest.raises(SystemExit) as stop:
        kinetic_cli.main(argv)
    assert stop.value.code == 2


def test_no_items_and_no_branches(tmp_path: Path,
                                  capsys: pytest.CaptureFixture[str]) -> None:
    folder = write_folder(tmp_path, {"schemaVersion": 1, "items": []})
    code, out, _err = run_cli(["routes", str(folder)], capsys)
    assert code == 0
    assert "(no title): 0 items, 0 decisions, 0 routes, 0 endings" in out
