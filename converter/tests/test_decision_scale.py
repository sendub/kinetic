"""Decisions at scale (docs/plan.md Phase 57 item 7b): resolving a
manifest's decisions, its report timing and its routes model stay
near-linear in the number of decisions, and the nesting the resolver
works out matches the old all-pairs comparison on random shapes."""

from __future__ import annotations

import random
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from kinetic_extract import folder_model, report, routes

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT / "tools") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "tools"))

import validate_content  # noqa: E402

# Generous for a heavily loaded machine (each step takes under 1 s on an
# idle one, 2-7 s at a load average past 100): the all-pairs code took
# 33 s to resolve 20,000 decisions and 57 s for the report's timing.
BOUND_S = 10.0


def synthetic_manifest(decisions: int, seed: int = 0,
                       max_depth: int = 3) -> dict[str, Any]:
    """A valid manifest with `decisions` decisions in the shapes games
    have: one after another on the main line, nested up to `max_depth`
    deep inside routes, pure choices and ones with a continuing route,
    and routes that end, return or continue."""
    rng = random.Random(seed)
    items: list[dict[str, Any]] = []
    branches: list[dict[str, Any]] = []
    budget = [decisions]

    def item() -> str:
        iid = f"i{len(items)}"
        items.append({"id": iid, "type": "text",
                      "text": f"Line {len(items)} of the story."})
        return iid

    def plain(count: int) -> None:
        for _ in range(count):
            item()

    def decision(depth: int) -> None:
        budget[0] -= 1
        branch: dict[str, Any] = {"id": f"d{len(branches)}",
                                  "prompt": "What now?",
                                  "after": items[-1]["id"], "routes": []}
        branches.append(branch)
        continuing = rng.random() < 0.6
        for r in range(rng.choice((2, 2, 3, 4))):
            start = item()
            line(depth + 1, rng.choice((0, 0, 1, 2)) if depth < max_depth
                 else 0)
            plain(rng.randint(0, 2))
            results = ("ending", "return", "continue") if continuing \
                else ("ending", "return")
            branch["routes"].append({
                "id": f"r{r}", "label": f"Choice {r}", "start": start,
                "end": items[-1]["id"], "result": rng.choice(results)})
        if continuing:
            branch["continuingRoute"] = "r0"
            branch["continueAt"] = item()

    def line(depth: int, count: int) -> None:
        for _ in range(count):
            if budget[0] <= 0:
                return
            plain(rng.randint(1, 3))
            decision(depth)
        plain(1)  # where a pure choice carries on

    while budget[0] > 0:
        line(0, 1)
    plain(2)
    return {"schemaVersion": 1, "title": "Scale", "items": items,
            "branches": branches}


def reference_parents(decisions: list[folder_model.Decision]) -> list[int]:
    """The old all-pairs nesting: the parent is the decision with the
    narrowest route span holding the child's `after` item, the earliest
    decision on a tie."""
    parents = []
    for child in decisions:
        parent, tightest = -1, None
        for outer in decisions:
            if outer is child:
                continue
            for start, end, _result in outer.routes:
                if start <= child.after <= end \
                        and (tightest is None or end - start < tightest):
                    tightest = end - start
                    parent = outer.index
        parents.append(parent)
    return parents


def random_shape(rng: random.Random) -> dict[str, Any]:
    """A small manifest of any shape, malformed ones included: overlapping
    and nested spans, routes holding their own decision's `after`, joins
    before their routes, equal widths, unresolvable references."""
    count = rng.randint(1, 30)
    items = [{"id": f"i{k}"} for k in range(count)]
    branches = []
    for b in range(rng.randint(0, 12)):
        def ref() -> str:
            return f"i{rng.randrange(count + 1)}"  # sometimes no such item
        routes_ = []
        for r in range(rng.choice((1, 2, 2, 3, 4))):
            start = rng.randrange(count)
            end = min(count - 1, start + rng.choice((0, 0, 1, 2, 5, 30)))
            routes_.append({"id": f"r{r}", "start": f"i{start}",
                            "end": f"i{end}" if rng.random() < 0.95
                            else ref(),
                            "result": rng.choice(("ending", "return"))})
        branch: dict[str, Any] = {"id": f"d{b}", "after": ref(),
                                  "routes": routes_}
        if rng.random() < 0.4:
            branch["continuingRoute"] = "r0"
            branch["continueAt"] = ref()
        branches.append(branch)
    return {"items": items, "branches": branches}


def well_formed_shape(rng: random.Random) -> dict[str, Any]:
    """A small manifest whose decisions each meet the `branches` rules
    (disjoint routes after `after`, a `continueAt` past them) while
    different decisions' spans overlap and nest at random, as the rules
    allow."""
    count = rng.randint(4, 40)
    items = [{"id": f"i{k}", "type": "text", "text": f"i{k}"}
             for k in range(count)]
    branches = []
    for b in range(rng.randint(0, 10)):
        after = rng.randrange(count - 2)
        room = list(range(after + 1, count))
        bounds = sorted(rng.sample(room, min(len(room),
                                             2 * rng.choice((2, 2, 3)))))
        if len(bounds) < 4:
            continue
        spans = list(zip(bounds[::2], bounds[1::2]))
        continue_at = rng.randrange(spans[-1][1] + 1, count) \
            if spans[-1][1] + 1 < count and rng.random() < 0.6 else None
        results = ("ending", "return", "continue") if continue_at \
            else ("ending", "return")
        branch: dict[str, Any] = {"id": f"d{b}", "after": f"i{after}",
                                  "routes": [
            {"id": f"r{r}", "start": f"i{start}", "end": f"i{end}",
             "result": rng.choice(results)}
            for r, (start, end) in enumerate(spans)]}
        if continue_at is not None:
            branch["continuingRoute"] = "r0"
            branch["continueAt"] = f"i{continue_at}"
        branches.append(branch)
    return {"schemaVersion": 1, "items": items, "branches": branches}


def test_nesting_matches_the_all_pairs_comparison() -> None:
    rng = random.Random(57)
    nested = 0
    for _case in range(400):
        manifest = random_shape(rng)
        decisions = folder_model.resolve_decisions(manifest["items"],
                                                   manifest["branches"])
        parents = [d.parent for d in decisions]
        assert parents == reference_parents(decisions), manifest
        nested += sum(1 for p in parents if p >= 0)
    assert nested > 200  # the shapes do nest


def test_nesting_matches_on_realistic_shapes() -> None:
    for seed in range(20):
        manifest = synthetic_manifest(60, seed=seed)
        decisions = folder_model.resolve_decisions(manifest["items"],
                                                   manifest["branches"])
        assert [d.parent for d in decisions] == reference_parents(decisions)


def reference_reach_warnings(manifest: dict[str, Any]) -> list[str]:
    """The validator's old reach warnings, each unshown item compared with
    every decision."""
    items = manifest["items"]
    decisions = folder_model.resolve_decisions(items, manifest["branches"])
    if not decisions:
        return []
    shown = folder_model.shown_by_play_all(items, decisions)
    warnings = []
    for i, item in enumerate(items):
        if i in shown:
            continue
        why = "no reading from the opening reaches it"
        width = None
        for decision in decisions:
            last = decision.continue_at - 1 if decision.continue_at >= 0 \
                else decision.region_end
            in_route = any(start <= i <= end
                           for start, end, _result in decision.routes)
            if decision.after < i <= last and not in_route \
                    and (width is None or last - decision.after < width):
                width = last - decision.after
                bound = (f"before {items[decision.continue_at]['id']!r}"
                         if decision.continue_at >= 0 else
                         f"to its last route end "
                         f"{items[decision.region_end]['id']!r}")
                why = (f"inside decision {decision.id!r} (after "
                       f"{items[decision.after]['id']!r}, {bound}) in none "
                       f"of its routes")
        warnings.append(validate_content.WARNING_PREFIX + validate_content
                        ._line(f"items[{i}]",
                               f"item {item['id']!r} is never shown: {why}"))
    return warnings


def test_reach_warnings_match_the_all_decisions_comparison() -> None:
    rng = random.Random(7)
    inside = 0
    for _case in range(400):
        manifest = well_formed_shape(rng)
        assert validate_content.branches_problems(manifest) == []
        warnings = validate_content.reach_warnings(manifest)
        assert warnings == reference_reach_warnings(manifest), manifest
        inside += sum(1 for w in warnings if "inside decision" in w)
    assert inside > 50  # the shapes leave items between routes


def test_synthetic_folder_is_valid_and_nests() -> None:
    manifest = synthetic_manifest(300)
    assert validate_content.branches_problems(manifest) == []
    decisions = folder_model.resolve_decisions(manifest["items"],
                                               manifest["branches"])
    assert len(decisions) == 300
    assert any(d.parent >= 0 for d in decisions)
    assert any(d.continuing < 0 for d in decisions)
    assert validate_content.reach_warnings(manifest) == []


def timed(work: Any) -> tuple[float, Any]:
    began = time.perf_counter()
    result = work()
    return time.perf_counter() - began, result


def test_twenty_thousand_decisions_stay_fast(
        monkeypatch: pytest.MonkeyPatch) -> None:
    manifest = synthetic_manifest(20_000)
    items, branches = manifest["items"], manifest["branches"]
    # Each item's hold (its text's reading time) costs the same whatever
    # the decisions; worked out once, so the timing below is theirs.
    holds = report.item_holds(manifest)
    monkeypatch.setattr(report, "item_holds", lambda _manifest: holds)

    took, decisions = timed(lambda: folder_model.resolve_decisions(
        items, branches))
    assert len(decisions) == 20_000
    assert sum(1 for d in decisions if d.parent >= 0) > 5_000
    assert took < BOUND_S, f"resolve_decisions took {took:.2f} s"

    took, shown = timed(lambda: folder_model.shown_by_play_all(
        items, decisions))
    assert len(shown) == len(items)
    assert took < BOUND_S, f"shown_by_play_all took {took:.2f} s"

    took, timing = timed(lambda: report.timing_section(manifest))
    assert len(timing["decisions"]) == 20_000
    assert took < BOUND_S, f"report.timing_section took {took:.2f} s"

    took, model = timed(lambda: routes.build_model(manifest))
    assert model.counts()["decisions"] == 20_000
    assert took < BOUND_S, f"routes.build_model took {took:.2f} s"

    took, problems = timed(lambda: (
        validate_content.branches_problems(manifest)
        + validate_content.reach_warnings(manifest)))
    assert problems == []
    assert took < BOUND_S, f"the validator's branch checks took {took:.2f} s"
