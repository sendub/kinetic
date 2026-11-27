"""`kinetic routes <folder>`: a game folder's branch structure as text an
agent can read in place of looking at the branch map (docs/plan.md Phase
57 item 6; CREATE.md, "kinetic routes").

Usage:

    kinetic routes <folder> [--dot | --json]

The model is the branch map's (player/src/render/mapmodel.ts,
`layOutStrip`), laid out the same way from the decisions the player
resolves (folder_model.resolve_decisions): the main line runs from the
first item to the last, a stretch of items up to each top-level
decision's `after` item, then the decision, then on from where its line
carries on (`continueAt`, or past the whole menu region for a pure
choice). Each route is a line of its own from its `start` to its `end`,
laid out the same way with the decisions nested in it. So the counts here
(decisions drawn, routes, stretches, endings, joins) are the map's, which
player/src/render/routeshape.test.ts and converter/tests/test_routes.py
both hold to fixtures/route-shapes.json.

What the map cannot draw is listed apart: a decision whose `after` item
lies where no line reaches, the `branches` entries the player drops
(an unresolvable reference and the like: the validator says why), the
items on no line, and the items no reading from the opening reaches (the
validator's reachability, folder_model.shown_by_play_all).

A decision that follows an earlier one (docs/content-format.md,
"Branches") names it, each of its routes the picks there it takes, and
any pick no route takes, which passes the decision on to `continueAt`.

A decision's shared spans (`shared`, the same "Branches") come after its
routes, each once, as the map draws them: where it leads (its `result`)
and the routes reaching it, a route nested in another decision included
(`then`); each route with `then` says which span it goes on to.

Default output: an indented outline. `--dot` prints Graphviz DOT
(stretches as boxes, decisions as diamonds, endings as double circles,
shared spans as bold rounded boxes; each route's edge from its decision
labelled with its number and label, and a `then` edge into its span).
`--json` prints the model as one JSON object.

Exit codes, as `kinetic report`: 0 when it ran, whatever it found; 1,
printing nothing on stdout, when a decision breaks the span rules (a
route not after its `after` item, overlapping routes, a `continueAt` not
after every route end, as the validator reports them; listed on stderr);
2 for bad arguments, or a folder without a readable manifest.json (or
manifest.js).
"""

from __future__ import annotations

import argparse
import json
import sys
from bisect import bisect_left
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from kinetic_extract import text_tags
from kinetic_extract.folder_model import (
    Decision,
    SharedSpan,
    resolve_decisions,
    shown_by_play_all,
)
from kinetic_extract.report import (
    ReportError,
    _item_id,
    _items,
    _plural,
    _str,
    malformed_branches,
    read_manifest,
)
from kinetic_extract.version import kinetic_version

# How a route's span ends, as the map draws it (mapmodel.ts RouteOutcome):
# the continuing route and a "continue" route join at `continueAt`, a
# "return" route returns to its choice, any other ends; a route with `then`
# goes on into a shared span, whose own `result` is one of the first three.
CONTINUES = "continues"
RETURNS = "returns"
ENDS = "ends"
SHARED = "shared"

# How much of a prompt or label a DOT node or edge shows.
DOT_TEXT = 40


# ---------------------------------------------------------------------------
# The model
# ---------------------------------------------------------------------------

@dataclass
class Stretch:
    """Items `start`..`end` (indices, inclusive) on one line, no decision
    between: one stretch of the map."""

    start: int
    end: int


@dataclass
class Route:
    """One route of a drawn decision and its own line."""

    index: int  # in its decision's routes: what a reader's pick numbers
    id: Any
    label: str  # as written, tags and all
    start: int
    end: int
    result: str  # "continuing", "continue", "return" or "ending"
    outcome: str  # CONTINUES, RETURNS, ENDS or SHARED
    line: list[Stretch | DecisionNode] = field(default_factory=list)
    # On a following decision: the followed decision's route ids its
    # `when` names; None for a route without `when` (it takes the rest)
    # and on any other decision.
    when: list[Any] | None = None
    # The shared span its `then` names, as (decision index, place in that
    # decision's resolved `shared`); None without one (outcome SHARED).
    then: tuple[int, int] | None = None


@dataclass
class SpanNode:
    """A shared span of a drawn decision, drawn once after its routes."""

    span: SharedSpan
    outcome: str  # CONTINUES, RETURNS or ENDS, by its `result`
    line: list[Stretch]
    # The routes reaching it: (their decision's node, the route), in the
    # order the map lays them out.
    leads: list[tuple[DecisionNode, Route]] = field(default_factory=list)


@dataclass
class DecisionNode:
    """A decision the map draws."""

    decision: Decision
    prompt: str  # as written
    routes: list[Route]
    # Where its line carries on (`continueAt`, or the region end plus one
    # for a pure choice), an item index; may be past the line's end, or
    # past the last item.
    carries_on: int
    # The id of the decision it follows (docs/content-format.md,
    # "Branches"), None for none; and that decision's route ids no route
    # of this one takes, where a reader's pick passes it on to continueAt.
    follows: Any = None
    passes: list[Any] = field(default_factory=list)
    spans: list[SpanNode] = field(default_factory=list)

    @property
    def pure(self) -> bool:
        return self.decision.continuing < 0


@dataclass
class Model:
    items: list[Any]
    line: list[Stretch | DecisionNode]
    story_end: bool  # the main line ends in a stretch at the last item
    decisions: list[Decision]  # every decision the player resolves
    drawn: list[DecisionNode]  # the ones on a line, in resolved order
    dropped: list[Any]  # ids of `branches` entries the player drops
    unreachable: list[int]  # item indices no reading from the opening shows

    def stretches(self) -> list[Stretch]:
        out: list[Stretch] = []

        def walk(line: list[Stretch | DecisionNode]) -> None:
            for element in line:
                if isinstance(element, Stretch):
                    out.append(element)
                else:
                    for route in element.routes:
                        walk(route.line)
                    for span in element.spans:
                        walk(span.line)

        walk(self.line)
        return out

    def off_line(self) -> list[int]:
        """Item indices in no stretch, in array order."""
        on = {k for s in self.stretches() for k in range(s.start, s.end + 1)}
        return [k for k in range(len(self.items)) if k not in on]

    def counts(self) -> dict[str, int]:
        """What the branch map draws (mapmodel.ts `MapStrip`): decision
        nodes, route pills, stretches, end marks, join dots and shared
        span boxes; and how many decisions the player resolves, drawn or
        not."""
        routes = [r for d in self.drawn for r in d.routes]
        spans = [span for d in self.drawn for span in d.spans]
        joining = (CONTINUES, RETURNS)
        joins = sum(1 for d in self.drawn
                    if any(r.outcome in joining for r in d.routes)
                    or any(span.outcome in joining for span in d.spans)
                    or d.carries_on > d.decision.after)
        return {
            "resolved": len(self.decisions),
            "decisions": len(self.drawn),
            "routes": len(routes),
            "stretches": len(self.stretches()),
            "endings": sum(1 for r in routes if r.outcome == ENDS)
                       + sum(1 for span in spans if span.outcome == ENDS)
                       + (1 if self.story_end else 0),
            "joins": joins,
            "spans": len(spans),
        }


def _outcome(result: str, continuing: bool = False) -> str:
    """How a route's or a shared span's end leads on, by its `result`."""
    return CONTINUES if continuing or result == "continue" \
        else RETURNS if result == "return" else ENDS


def _carries_on(decision: Decision) -> int:
    """Where a decision's line carries on after it (mapmodel.ts
    `continuationOf`): `continueAt`, else past the menu region, its
    shared spans included."""
    return decision.continue_at if decision.continuing >= 0 \
        else decision.menu_end + 1


def _hashable(value: Any) -> bool:
    try:
        hash(value)
    except TypeError:  # a list or object id, which the schema reports
        return False
    return True


def build_model(manifest: dict[str, Any]) -> Model:
    """The branch map's model of the manifest (mapmodel.ts `stripOf`,
    without the geometry)."""
    items = _items(manifest)
    raw = manifest.get("branches")
    branches = raw if isinstance(raw, list) else []
    decisions = resolve_decisions(items, branches) if items else []
    by_id: dict[Any, dict[str, Any]] = {}
    for branch in branches:
        if isinstance(branch, dict) and isinstance(branch.get("id"), str):
            by_id.setdefault(branch["id"], branch)
    children: dict[int, list[Decision]] = {}
    for decision in decisions:
        children.setdefault(decision.parent, []).append(decision)
    for siblings in children.values():
        siblings.sort(key=lambda d: d.after)
    afters = {parent: [d.after for d in siblings]
              for parent, siblings in children.items()}
    placed: dict[int, DecisionNode] = {}

    def branch_of(decision: Decision) -> dict[str, Any]:
        return by_id.get(decision.id, {}) \
            if isinstance(decision.id, str) else {}

    def line(start: int, end: int, parent: int
             ) -> list[Stretch | DecisionNode]:
        elements: list[Stretch | DecisionNode] = []
        idx = start
        siblings = children.get(parent, [])
        # Siblings are in `after` order: start at the first inside the
        # span and stop past it.
        first = bisect_left(afters[parent], start) if siblings else 0
        for k in range(first, len(siblings)):
            decision = siblings[k]
            if decision.after > end:
                break
            if decision.after < idx:
                continue
            if decision.index in placed:
                continue
            elements.append(Stretch(idx, decision.after))
            elements.append(lay_out(decision))
            nxt = _carries_on(decision)
            if nxt <= decision.after or nxt > end:
                idx = end + 1
                break
            idx = nxt
        if idx <= end:
            elements.append(Stretch(idx, end))
        return elements

    def lay_out(decision: Decision) -> DecisionNode:
        branch = branch_of(decision)
        route_defs = branch.get("routes") if isinstance(
            branch.get("routes"), list) else []
        node = DecisionNode(decision, _str(branch.get("prompt")) or "", [],
                            _carries_on(decision))
        followed_ids: list[Any] = []
        if decision.follows >= 0:
            followed = decisions[decision.follows]
            node.follows = followed.id
            followed_ids = [route.get("id") for route
                            in branch_of(followed).get("routes", [])]
            node.passes = [followed_ids[k] for k, taker
                           in enumerate(decision.takes) if taker < 0]
        placed[decision.index] = node
        for ri, (start, end, result) in enumerate(decision.routes):
            route = route_defs[ri] if ri < len(route_defs) else {}
            continuing = ri == decision.continuing
            then = decision.thens[ri]
            outcome = SHARED if then is not None \
                else _outcome(result, continuing)
            when = route.get("when") if followed_ids else None
            node.routes.append(Route(
                ri, route.get("id"), _str(route.get("label")) or "", start,
                end, "continuing" if continuing else str(result), outcome,
                when=list(when) if isinstance(when, list) else None,
                then=then))
        # Each route's line after the route records exist, in route order,
        # as the map lays them out; then the shared spans, each one
        # stretch (a span holds no decision).
        for route in node.routes:
            route.line = line(route.start, route.end, decision.index)
        node.spans = [SpanNode(span, _outcome(span.result),
                               [Stretch(span.start, span.end)])
                      for span in decision.shared]
        return node

    main = line(0, len(items) - 1, -1) if items else []
    story_end = bool(main) and isinstance(main[-1], Stretch)
    # Each route with `then` reaches its span, once both are drawn.
    for node in (placed[d.index] for d in decisions if d.index in placed):
        for route in node.routes:
            if route.then is not None and route.then[0] in placed:
                placed[route.then[0]].spans[route.then[1]].leads.append(
                    (node, route))
    shown = shown_by_play_all(items, decisions) if decisions and items \
        else set(range(len(items)))
    resolved_ids = {d.id for d in decisions if _hashable(d.id)}
    odd_ids = [d.id for d in decisions if not _hashable(d.id)]

    def resolved(branch_id: Any) -> bool:
        return branch_id in resolved_ids if _hashable(branch_id) \
            else branch_id in odd_ids

    dropped = [b.get("id") if isinstance(b, dict) else None
               for b in branches
               if not isinstance(b, dict) or not resolved(b.get("id"))]
    return Model(
        items=items, line=main, story_end=story_end, decisions=decisions,
        drawn=[placed[d.index] for d in decisions if d.index in placed],
        dropped=dropped,
        unreachable=[k for k in range(len(items)) if k not in shown])


# ---------------------------------------------------------------------------
# JSON
# ---------------------------------------------------------------------------

def _ids(model: Model, indices: list[int]) -> list[str]:
    return [_item_id(model.items[k], k) for k in indices]


def model_json(model: Model, folder: Path, manifest: dict[str, Any]
               ) -> dict[str, Any]:
    items = model.items

    def iid(k: int) -> str:
        return _item_id(items[k], k)

    def maybe(k: int) -> str | None:
        return iid(k) if 0 <= k < len(items) else None

    def then_of(route: Route) -> tuple[Any, Any]:
        """The span a route's `then` names and the decision holding it."""
        if route.then is None:
            return None, None
        holder = model.decisions[route.then[0]]
        return holder.shared[route.then[1]].id, holder.id

    def span_json(d: Decision, span: SpanNode) -> dict[str, Any]:
        return {
            "id": span.span.id,
            "result": span.span.result,
            "outcome": span.outcome,
            "items": span.span.end - span.span.start + 1,
            "first": iid(span.span.start),
            "last": iid(span.span.end),
            "joinsAt": (maybe(d.continue_at)
                        if span.outcome == CONTINUES else None),
            "reachedFrom": [route_name(node.decision.id, route.id)
                            for node, route in span.leads],
            "line": line_json(span.line),
        }

    def line_json(line: list[Stretch | DecisionNode]) -> list[Any]:
        out: list[Any] = []
        for element in line:
            if isinstance(element, Stretch):
                out.append({"kind": "items", "first": iid(element.start),
                            "last": iid(element.end),
                            "items": element.end - element.start + 1})
                continue
            d = element.decision
            out.append({
                "kind": "decision",
                "id": d.id,
                "after": iid(d.after),
                "prompt": text_tags.plain_text(element.prompt),
                "pureChoice": element.pure,
                "continueAt": maybe(d.continue_at),
                "carriesOnAt": maybe(element.carries_on),
                "follows": element.follows,
                "passesOn": element.passes,
                "routes": [{
                    "id": route.id,
                    "label": text_tags.plain_text(route.label),
                    "result": route.result,
                    "outcome": route.outcome,
                    "items": route.end - route.start + 1,
                    "first": iid(route.start),
                    "last": iid(route.end),
                    "joinsAt": (maybe(d.continue_at)
                                if route.outcome == CONTINUES else None),
                    "when": route.when,
                    "then": then_of(route)[0],
                    "thenDecision": then_of(route)[1],
                    "line": line_json(route.line),
                } for route in element.routes],
                "shared": [span_json(d, span) for span in element.spans],
            })
        return out

    drawn = {node.decision.index for node in model.drawn}
    main_items = sum(e.end - e.start + 1 for e in model.line
                     if isinstance(e, Stretch))
    return {
        "folder": str(folder),
        "kinetic": kinetic_version(),
        "title": _str(manifest.get("title")),
        "items": len(items),
        "counts": model.counts(),
        "mainLine": {"items": main_items, "line": line_json(model.line)},
        "storyEnd": iid(len(items) - 1) if model.story_end else None,
        "notDrawn": [{"id": d.id, "after": iid(d.after)}
                     for d in model.decisions if d.index not in drawn],
        "dropped": model.dropped,
        "offLine": _ids(model, model.off_line()),
        "unreachable": _ids(model, model.unreachable),
    }


# ---------------------------------------------------------------------------
# The outline
# ---------------------------------------------------------------------------

def _span(first: str, last: str) -> str:
    return first if first == last else f"{first}..{last}"


def route_name(decision_id: Any, route_id: Any) -> str:
    """A route by its decision, as `kinetic export` heads it."""
    return f"{decision_id}/{route_id}"


def _quote(text: str) -> str:
    return '"' + " ".join(text.split()) + '"'


def _list(ids: list[str], limit: int = 10) -> str:
    more = f" and {len(ids) - limit} more" if len(ids) > limit else ""
    return ", ".join(ids[:limit]) + more


def route_then(route: dict[str, Any], decision: Any = None) -> str:
    """Where a route (or a shared span) leads once read, in words; a
    route with `then` names its span, and the decision holding it when
    that is not `decision`, the route's own."""
    if route["outcome"] == SHARED:
        holder = route["thenDecision"]
        of = f" (decision {holder})" if holder != decision else ""
        return f"then {route['then']}{of}"
    if route["outcome"] == CONTINUES:
        return f"joins at {route['joinsAt']}"
    if route["outcome"] == RETURNS:
        return "returns to the choice"
    return "an ending (the choice is offered again)"


def _picks(ids: list[Any]) -> str:
    return " or ".join(map(str, ids))


def route_after(route: dict[str, Any], decision: dict[str, Any]) -> str:
    """On a following decision, the pick at the followed decision a
    route takes, in words; "" on any other decision."""
    if decision["follows"] is None:
        return ""
    if route["when"] is None:
        return f"after any other pick at {decision['follows']}"
    return f"after {_picks(route['when'])} at {decision['follows']}"


def decision_then(decision: dict[str, Any]) -> str:
    if not decision["pureChoice"]:
        return f"carries on at {decision['continueAt']}"
    if decision["carriesOnAt"] is None:
        return "a pure choice: the story ends once every route has played"
    return (f"a pure choice: carries on at {decision['carriesOnAt']} once "
            "every route has played")


def format_outline(data: dict[str, Any]) -> str:
    out: list[str] = []
    add = out.append
    counts = data["counts"]
    add(f"kinetic routes: {data['folder']} (Kinetic {data['kinetic']})")
    spans = f", {_plural(counts['spans'], 'shared span')}" \
        if counts["spans"] else ""
    add(f"{data['title'] or '(no title)'}: {_plural(data['items'], 'item')}, "
        f"{_plural(counts['decisions'], 'decision')}, "
        f"{_plural(counts['routes'], 'route')}, "
        f"{_plural(counts['endings'], 'ending')}{spans}")
    add("")

    def line(elements: list[Any], depth: int) -> None:
        pad = "  " * depth
        for e in elements:
            if e["kind"] == "items":
                add(f"{pad}items {_span(e['first'], e['last'])} "
                    f"({_plural(e['items'], 'item')})")
                continue
            follows = f"follows {e['follows']}, " \
                if e["follows"] is not None else ""
            add(f"{pad}decision {e['id']} after {e['after']}, {follows}"
                f"{decision_then(e)}: {_quote(e['prompt'])}")
            for n, r in enumerate(e["routes"], 1):
                after = route_after(r, e)
                after = f"{after}; " if after else ""
                add(f"{pad}  {n}. route {r['id']} {_quote(r['label'])}: "
                    f"{r['result']}, {_plural(r['items'], 'item')}, "
                    f"{_span(r['first'], r['last'])}; {after}"
                    f"{route_then(r, e['id'])}")
                line(r["line"], depth + 2)
            for span in e["shared"]:
                reached = _list(span["reachedFrom"]) or "none"
                add(f"{pad}  shared span {span['id']}: {span['result']}, "
                    f"{_plural(span['items'], 'item')}, "
                    f"{_span(span['first'], span['last'])}; "
                    f"{route_then(span)}; reached from routes {reached}")
                line(span["line"], depth + 2)
            if e["passesOn"]:
                add(f"{pad}  after {_picks(e['passesOn'])} at "
                    f"{e['follows']}: no route, the decision passes on to "
                    f"{e['continueAt']}")

    main = data["mainLine"]
    add(f"main line: {_plural(main['items'], 'item')}")
    line(main["line"], 1)
    if data["storyEnd"]:
        add(f"  the story ends at {data['storyEnd']}")
    if data["notDrawn"]:
        add("")
        add("decisions on no line (their after item lies where no line "
            "reaches):")
        for d in data["notDrawn"]:
            add(f"  {d['id']} after {d['after']}")
    if data["dropped"]:
        add("")
        add("branches the player drops (kinetic validate says why): "
            + ", ".join(map(str, data["dropped"])))
    if data["offLine"]:
        add("")
        add(f"items on no line: {_plural(len(data['offLine']), 'item')} "
            f"({_list(data['offLine'])})")
    add("")
    if data["unreachable"]:
        add(f"never reached from the opening: "
            f"{_plural(len(data['unreachable']), 'item')} "
            f"({_list(data['unreachable'])})")
    else:
        add("every item is reached from the opening")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------
# DOT
# ---------------------------------------------------------------------------

def _dot_str(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    return '"' + escaped.replace("\n", "\\n") + '"'


def _cut(text: str, limit: int = DOT_TEXT) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 3] + "..."


def format_dot(model: Model, manifest: dict[str, Any]) -> str:
    items = model.items
    out = ["digraph routes {", "  rankdir=LR;",
           '  node [fontname="Helvetica", fontsize=10];',
           '  edge [fontname="Helvetica", fontsize=9];']
    title = _str(manifest.get("title"))
    if title:
        out.append(f"  label={_dot_str(title)};")
    add = out.append
    ends = 0

    def iid(k: int) -> str:
        return _item_id(items[k], k)

    def end_node() -> str:
        nonlocal ends
        ends += 1
        name = f"end{ends}"
        add(f'  {name} [shape=doublecircle, label="end", width=0.3];')
        return name

    def first_node(element: Stretch | DecisionNode) -> str:
        return f"s{element.start}" if isinstance(element, Stretch) \
            else f"d{element.decision.index}"

    # `follow`: what comes after a line's last element, made on demand
    # (an end mark is made only where a line ends in one): a node name
    # and edge attributes, or None where nothing follows.
    Follow = Callable[[], "tuple[str, str] | None"]

    def once(follow: Follow) -> Follow:
        """`follow`, its node made at the first call only: the routes that
        join where a line ends share one target."""
        made: list[tuple[str, str] | None] = []

        def target() -> tuple[str, str] | None:
            if not made:
                made.append(follow())
            return made[0]

        return target

    def edge(src: str, follow: Follow) -> None:
        target = follow()
        if target is not None:
            dst, attrs = target
            add(f"  {src} -> {dst}{attrs};")

    def line(elements: list[Stretch | DecisionNode], follow: Follow) -> None:
        for k, element in enumerate(elements):
            after: Follow
            if k + 1 < len(elements):
                nxt = first_node(elements[k + 1])
                after = (lambda nxt=nxt: (nxt, ""))
            else:
                after = once(follow)
            if isinstance(element, Stretch):
                n = element.end - element.start + 1
                label = (f"{_span(iid(element.start), iid(element.end))}\n"
                         f"{_plural(n, 'item')}")
                add(f"  s{element.start} [shape=box, "
                    f"label={_dot_str(label)}];")
                edge(f"s{element.start}", after)
                continue
            node = element
            name = f"d{node.decision.index}"
            prompt = _cut(text_tags.plain_text(node.prompt))
            label = f"{node.decision.id}\n{prompt}"
            if node.follows is not None:
                label += f"\nfollows {node.follows}"
            add(f"  {name} [shape=diamond, label={_dot_str(label)}];")
            def lead_on(outcome: str, name: str = name,
                        after: Follow = after) -> Follow:
                """Where a route's or a span's end leads, by its outcome."""
                if outcome == CONTINUES:
                    return after
                if outcome == RETURNS:
                    return (lambda: (name, ' [style=dashed, label="back"]'))
                return (lambda: (end_node(), ""))

            for route in node.routes:
                route_follow: Follow
                if route.then is not None:
                    span_name = f"x{route.then[0]}_{route.then[1]}"
                    route_follow = (lambda span_name=span_name: (
                        span_name, ' [label="then"]'))
                else:
                    route_follow = lead_on(route.outcome)
                text = f"{route.index + 1}. " \
                    f"{_cut(text_tags.plain_text(route.label))}"
                if node.follows is not None:
                    text += (f" (after {_picks(route.when)})"
                             if route.when is not None else " (any other)")
                add(f"  {name} -> {first_node(route.line[0])} "
                    f"[label={_dot_str(text)}];")
                line(route.line, route_follow)
            # A shared span is one node, its items.
            for k, span in enumerate(node.spans):
                span_name = f"x{node.decision.index}_{k}"
                first, last = span.span.start, span.span.end
                label = (f"shared span {span.span.id}\n"
                         f"{_span(iid(first), iid(last))}\n"
                         f"{_plural(last - first + 1, 'item')}")
                add(f'  {span_name} [shape=box, style="rounded,bold", '
                    f"label={_dot_str(label)}];")
                edge(span_name, lead_on(span.outcome))
            if node.pure:
                target = after()
                if target is not None:
                    add(f"  {name} -> {target[0]} [style=dotted, "
                        'label="after every route"];')
            elif node.passes:
                target = after()
                if target is not None:
                    passing = _dot_str(f"after {_picks(node.passes)}: "
                                       "passes on")
                    add(f"  {name} -> {target[0]} [style=dotted, "
                        f"label={passing}];")

    line(model.line, (lambda: (end_node(), "")) if model.story_end
         else (lambda: None))
    out.append("}")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------
# The command
# ---------------------------------------------------------------------------

def run(args: argparse.Namespace) -> int:
    folder = Path(args.folder)
    try:
        manifest = read_manifest(folder)
    except ReportError as exc:
        print(f"kinetic routes: {exc}", file=sys.stderr)
        return 2
    if malformed_branches("routes", folder, manifest):
        return 1
    model = build_model(manifest)
    if args.dot:
        sys.stdout.write(format_dot(model, manifest))
        return 0
    data = model_json(model, folder, manifest)
    if args.json:
        sys.stdout.write(json.dumps(data, indent=2, ensure_ascii=False)
                         + "\n")
    else:
        sys.stdout.write(format_outline(data))
    return 0


def register(subcommands: Any) -> None:
    """Add `routes` to the `kinetic` command (kinetic_cli)."""
    argp = subcommands.add_parser(
        "routes", help="the branch structure: decisions, routes, where each "
                       "ends or rejoins",
        description="Print a game folder's branch structure as text an "
                    "agent can read in place of looking at the branch map "
                    "(CREATE.md, \"kinetic routes\").")
    argp.add_argument("folder", help="the game folder (its manifest.json)")
    form = argp.add_mutually_exclusive_group()
    form.add_argument("--dot", action="store_true",
                      help="print Graphviz DOT")
    form.add_argument("--json", action="store_true",
                      help="print the model as one JSON object")
    argp.set_defaults(run=run)
