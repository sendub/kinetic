"""What a Kinetic content folder's manifest refers to and how it reads:
the media paths it names, its audio tracks and voices, and its decisions
resolved as the player plays them, with the items a reading from the
opening shows (docs/content-format.md, "Branches", "Audio", "Voices").

tools/validate_content.py checks folders with these, and `kinetic
report` reads them, so the model lives in the package that installs
`kinetic`. Standard library only, like the rest of the converter's
helpers the validator imports. Every function takes a manifest as
parsed JSON and tolerates a malformed one: the schema reports that.
"""

from __future__ import annotations

import heapq
from typing import Any, Iterator


def audio_tracks(manifest: Any) -> dict[str, Any]:
    """The manifest's `audio.tracks` object; {} when absent or malformed
    (the schema reports a malformed one)."""
    audio = manifest.get("audio") if isinstance(manifest, dict) else None
    tracks = audio.get("tracks") if isinstance(audio, dict) else None
    return tracks if isinstance(tracks, dict) else {}


def voice_entries(manifest: Any) -> Iterator[tuple[str, Any]]:
    """(location, value) for each voice: `voices.<speaker>` in the
    manifest's order, then `narrator`. Malformed containers yield
    nothing; the schema reports them."""
    if not isinstance(manifest, dict):
        return
    voices = manifest.get("voices")
    if isinstance(voices, dict):
        for speaker, voice in voices.items():
            yield f"voices.{speaker}", voice
    if "narrator" in manifest:
        yield "narrator", manifest["narrator"]


def iter_media_paths(manifest: Any) -> Iterator[tuple[str, Any]]:
    """(location, value) for every media path the manifest references:
    the items' files, frames and posters, then the audio track files and
    the voices' reference clips."""
    items = manifest.get("items") if isinstance(manifest, dict) else None
    yield from item_media_paths(items if isinstance(items, list) else [])
    yield from scripted_files(manifest)


def scripted_files(manifest: Any) -> Iterator[tuple[str, Any]]:
    """(location, value) for every audio file the player reads from the
    script beside it: each track's `file`, then each voice's `file`
    (docs/content-format.md § Audio, § Voices)."""
    for track_id, track in audio_tracks(manifest).items():
        if isinstance(track, dict) and "file" in track:
            yield f"audio.tracks.{track_id}.file", track["file"]
    for loc, voice in voice_entries(manifest):
        if isinstance(voice, dict) and "file" in voice:
            yield f"{loc}.file", voice["file"]


def item_media_paths(items: list[Any]) -> Iterator[tuple[str, Any]]:
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        base = f"items[{i}]"
        item_type = item.get("type")
        if item_type == "animation":
            frames = item.get("frames")
            if isinstance(frames, list):
                for f, frame in enumerate(frames):
                    yield f"{base}.frames[{f}]", frame
            elif "frames" in item:
                yield f"{base}.frames", frames
            continue
        if item_type == "video":
            for field in ("file", "poster"):
                if field in item:
                    yield f"{base}.{field}", item[field]
            continue
        for field in ("file", "poster"):
            if field in item:
                yield f"{base}.{field}", item[field]


class Decision:
    """A decision resolved to item indices, as machine.ts `ResolvedDecision`."""

    __slots__ = ("index", "id", "after", "routes", "continuing",
                 "continue_at", "parent", "region_end", "branch")

    def __init__(self, index: int, branch_id: Any, after: int,
                 routes: list[tuple[int, int, str]], continuing: int,
                 continue_at: int, branch: int = -1) -> None:
        self.index = index
        self.branch = branch  # its entry's index in `branches`
        self.id = branch_id
        self.after = after
        self.routes = routes  # (start, end, result) per route
        self.continuing = continuing
        self.continue_at = continue_at
        self.parent = -1
        self.region_end = max(end for _start, end, _result in routes)


def resolve_decisions(items: list[Any], branches: list[Any]
                       ) -> list[Decision]:
    """The decisions the player plays, as machine.ts `resolveDecisions`:
    one with an unresolvable reference, an inverted span, fewer than two
    routes, half a continuingRoute/continueAt pair or a `"continue"`
    route without a join is dropped, so its items play as plain ones."""
    by_id: dict[str, int] = {}
    for i, item in enumerate(items):
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            by_id.setdefault(item["id"], i)

    def ref(value: Any) -> int:
        return by_id.get(value, -1) if isinstance(value, str) else -1

    resolved: list[Decision] = []
    for bi, branch in enumerate(branches):
        if not isinstance(branch, dict):
            continue
        routes = branch.get("routes")
        after = ref(branch.get("after"))
        if after < 0 or not isinstance(routes, list) or len(routes) < 2 \
                or not all(isinstance(route, dict) for route in routes):
            continue
        named = branch.get("continuingRoute")
        continuing = next((ri for ri, route in enumerate(routes)
                           if isinstance(named, str)
                           and route.get("id") == named), -1)
        continue_at = ref(branch.get("continueAt")) \
            if "continueAt" in branch else -1
        if (continuing >= 0) != (continue_at >= 0):
            continue
        spans: list[tuple[int, int, str]] = []
        for route in routes:
            start, end = ref(route.get("start")), ref(route.get("end"))
            result = route.get("result", "ending")
            if start < 0 or end < 0 or start > end \
                    or (result == "continue" and continue_at < 0):
                break
            spans.append((start, end, result))
        if len(spans) != len(routes):
            continue
        resolved.append(Decision(len(resolved), branch.get("id"), after,
                                  spans, continuing, continue_at, bi))
    _resolve_nesting(resolved)
    return resolved


def span_problems(decisions: list[Decision]) -> list[str]:
    """The ways the decisions the player plays break the span rules of
    docs/content-format.md "Branches", worded as tools/validate_content.py
    words them: a route that does not start after its decision's `after`
    item, two routes of one decision that overlap, a `continueAt` not
    after every route end. A manifest with any has no well-defined
    reading (a join can lead backwards), so `kinetic report`, `routes`
    and `export` and the validator's reach warnings skip it. Entries the
    player drops (an unresolvable reference and the like) are not among
    them: they play as plain items."""
    problems: list[str] = []
    for decision in decisions:
        base = f"manifest.json: branches[{decision.branch}]"
        after = decision.after
        for ri, (start, end, _result) in enumerate(decision.routes):
            if start > after:
                continue
            where = (f"route span items[{start}]..items[{end}] contains the "
                     f"decision's after item items[{after}]"
                     if after <= end else
                     f"route must start after the decision's after item "
                     f"items[{after}] (found items[{start}])")
            problems.append(f"{base}.routes[{ri}].start: {where}")
        for ri, (a_s, a_e, _result) in enumerate(decision.routes):
            for rj in range(ri):
                b_s, b_e, _result = decision.routes[rj]
                if max(a_s, b_s) <= min(a_e, b_e):
                    problems.append(
                        f"{base}.routes[{ri}]: route span items[{a_s}].."
                        f"items[{a_e}] overlaps the span items[{b_s}].."
                        f"items[{b_e}] of branches[{decision.branch}]"
                        f".routes[{rj}]")
        if 0 <= decision.continue_at <= decision.region_end:
            problems.append(
                f"{base}.continueAt: must resolve to an item after every "
                f"route end items[{decision.region_end}] (found "
                f"items[{decision.continue_at}])")
    return problems


def _resolve_nesting(decisions: list[Decision]) -> None:
    """Set each decision's parent: the other decision with the narrowest
    route span holding its `after` item, the earliest decision on a tie.

    One sweep in item order, near-linear in routes and decisions for any
    shape (overlapping spans of a malformed manifest included): route
    spans join a heap keyed (width, decision) when the sweep reaches
    their start and leave it once past their end, so the heap's top at
    each `after` item is the parent, unless it is the child's own route,
    set aside for that one query."""
    spans = sorted((start, end, decision.index)
                   for decision in decisions
                   for start, end, _result in decision.routes)
    open_spans: list[tuple[int, int, int]] = []  # (width, decision, end)
    next_span = 0
    for child in sorted(decisions, key=lambda d: d.after):
        at = child.after
        while next_span < len(spans) and spans[next_span][0] <= at:
            start, end, owner = spans[next_span]
            heapq.heappush(open_spans, (end - start, owner, end))
            next_span += 1
        own: list[tuple[int, int, int]] = []
        while open_spans:
            top = open_spans[0]
            if top[2] < at:
                heapq.heappop(open_spans)  # past its end for good
            elif top[1] == child.index:
                own.append(heapq.heappop(open_spans))
            else:
                child.parent = top[1]
                break
        for span in own:
            heapq.heappush(open_spans, span)


def shown_by_play_all(items: list[Any], decisions: list[Decision]
                       ) -> set[int]:
    """The item indices a reading from the opening shows under Play all
    routes, given the manifest's non-empty `items` and its decisions.

    A port of the player's forward flow (player/src/machine/machine.ts:
    `moveForward`, `fireDecision`, `nextAutoRoute`, `handleRouteEnd`,
    `endJoins`, `join`, `autoResolve`, `closeIfPureAndComplete`,
    `relevantDecision`, `atRouteEnd`, `nothingFollows`), with each choice
    taken at once as play-all takes it: the shortest route not played
    this pass, the continuing route last. Play-all shows every item any
    reading by choices shows (a reader picks among the same routes and
    joins at the same `continueAt`, and an ending route's end, where a
    manual reading stops, re-offers the choice here), so an item it never
    shows no reading reaches; bookmarks and `u` jump rather than read.
    player/src/machine/reach.test.ts holds this port to the machine.

    The walk ends: entering a route marks it played this pass and that
    record only grows, so there are at most as many entries as routes,
    and between two entries every move of a manifest without span
    problems (`span_problems`) goes forward (a step, a join to a
    `continueAt` past its routes, a close past a menu region). A
    malformed one can join backwards, so the walk also stops where a
    position and its open routes repeat with no route entered since:
    from there the moves would repeat, showing nothing new.
    """
    count = len(items)
    by_after: dict[int, list[Decision]] = {}
    for decision in decisions:
        by_after.setdefault(decision.after, []).append(decision)
    route_ends = {end for decision in decisions
                  for _start, end, _result in decision.routes}

    stack: list[tuple[Decision, int]] = []  # open (decision, route) frames
    played: dict[int, set[int]] = {}  # routes entered this pass
    shown = {0}
    cursor = 0
    # (cursor, open routes) after each move since the last route entered.
    seen: set[tuple[int, tuple[tuple[int, int], ...]]] = set()

    def show(index: int) -> None:
        nonlocal cursor
        cursor = index
        shown.add(index)

    def relevant_decision(index: int) -> Decision | None:
        candidates = by_after.get(index)
        if not candidates:
            return None
        for decision in candidates:
            if not stack:
                if decision.parent < 0:
                    return decision
                continue
            frame_decision, route_idx = stack[-1]
            start, end, _result = frame_decision.routes[route_idx]
            inside = decision.parent == frame_decision.index \
                and start <= index <= end
            if inside or decision is frame_decision:
                return decision
        return None

    def next_auto_route(decision: Decision) -> int:
        done = played.get(decision.index, set())
        best = -1
        for ri, (start, end, _result) in enumerate(decision.routes):
            if ri == decision.continuing or ri in done:
                continue
            if best < 0 or end - start < (decision.routes[best][1]
                                          - decision.routes[best][0]):
                best = ri
        if best >= 0:
            return best
        if decision.continuing >= 0 and decision.continuing not in done:
            return decision.continuing
        return -1

    def close_frames_for(decision: Decision) -> None:
        for depth in range(len(stack) - 1, -1, -1):
            if stack[depth][0] is decision:
                del stack[depth:]
                return

    def enter_route(decision: Decision, route_idx: int) -> None:
        seen.clear()  # a route not played before: no earlier state recurs
        close_frames_for(decision)
        played.setdefault(decision.index, set()).add(route_idx)
        stack.append((decision, route_idx))
        show(decision.routes[route_idx][0])

    def leaves_enclosing(decision: Decision, target: int) -> bool:
        if not stack:
            return False
        frame_decision, route_idx = stack[-1]
        return frame_decision.index == decision.parent \
            and target > frame_decision.routes[route_idx][1]

    def close_if_pure_and_complete(decision: Decision) -> bool:
        if decision.continuing >= 0 or next_auto_route(decision) >= 0:
            return False
        close_frames_for(decision)
        target = decision.region_end + 1
        if leaves_enclosing(decision, target):
            handle_route_end()
        elif target < count:
            show(target)
        return True

    def join(decision: Decision) -> None:
        if leaves_enclosing(decision, decision.continue_at):
            handle_route_end()
        else:
            show(decision.continue_at)

    def auto_resolve(decision: Decision) -> None:
        close_frames_for(decision)
        if decision.continue_at >= 0:
            join(decision)
        else:
            close_if_pure_and_complete(decision)

    def offer(decision: Decision) -> None:
        route_idx = next_auto_route(decision)
        if route_idx >= 0:
            enter_route(decision, route_idx)
        else:
            auto_resolve(decision)

    def handle_route_end() -> None:
        decision, route_idx = stack[-1]
        if close_if_pure_and_complete(decision):
            return
        stack.pop()
        _start, _end, result = decision.routes[route_idx]
        joins = route_idx == decision.continuing or (
            result == "continue" and next_auto_route(decision) < 0)
        if joins:
            join(decision)
        else:
            offer(decision)

    def at_route_end() -> bool:
        return bool(stack) and cursor == stack[-1][0].routes[stack[-1][1]][1]

    def move_forward() -> bool:
        """One forward settle; False where the story ends."""
        before = len(shown), cursor
        decision = relevant_decision(cursor)
        if decision is not None:
            if not close_if_pure_and_complete(decision):
                offer(decision)
        elif at_route_end():
            handle_route_end()
        elif cursor >= count - 1 or cursor in route_ends:
            return False  # `nothingFollows`
        else:
            show(cursor + 1)
        return (len(shown), cursor) != before

    while move_forward():
        state = (cursor, tuple((d.index, r) for d, r in stack))
        if state in seen:
            break  # a backward join: the moves would repeat from here
        seen.add(state)
    return shown
