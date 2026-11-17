"""The story walk follows labels (docs/plan.md Phase 57 item 4e;
docs/extracting.md, "The walk follows labels").

Ren'Py runs a game from `label start`: on through the statements of the
label's file, past the end of a label's block into whatever follows it in
the same file, to a `jump`'s label, into a `call`'s label and back to the
statement after the call at its `return` (or at the end of a file). This
module reads the parsed scripts the same way and gives the timeline the
story events in that order, each statement once:

- A `jump` or `call` to a label goes there; a target that is no label of
  the walked scripts is reported and not followed.
- A computed target (`jump expression`, `call expression`, `$
  renpy.jump(var)`) has candidates: the labels its own expression names
  as string literals, then the labels named by a string literal anywhere
  in the game's code (parser.name_literals: not dialogue, menu choices or
  f-strings), in file order, leaving out labels literal flow reaches
  (found by a first walk without candidates) and Ren'Py's entry labels.
  The candidates not yet walked are walked there, in that order: for a
  call each as a call returning to the site, for a jump each as a path
  of its own (a fork with no join), the site's path ending after them,
  as a jump's does. With no candidate it is reported, not followed.
- A label reached a second time is not walked again. A jump to it ends
  the path there, as the converter's routes rejoin the line they left
  (a loop back, or a scene shared by two paths, is read once); a call to
  it goes on after the call. The ledger counts both (`rejoins`, also
  counting the jumps to where a fork's paths meet, and
  `callsNotRepeated`).
- A fork (the blocks of an `if` chain or a `while`, or the choices of a
  menu the converter does not make a decision of, which jump or call)
  walks each block's own jumps and calls in turn, up to the statement all
  of them reach (the fork's immediate post-dominator), then goes on from
  there: so alternatives that rejoin read one after the other, then the
  shared rest once, as the file-order join read them. The blocks' other
  statements stay skipped, as before; a label inside such a block is a
  place a jump lands, running the block's jumps and calls from there.
- `show screen x` and `call screen x` are a fork of the screen's literal
  `Jump("label")` and `Call("label")` actions (and those of the screens
  it `use`s), in the screen's order, and of going on past it: a hub
  whose buttons jump reads each place they lead.

- The end of a file returns, as a `return` does. (In Ren'Py falling off
  the end of a file inside a call ends the game; a return keeps the
  content after the call.)

After the story the walk can go on from more labels: each `--also-label`
(a Ren'Py entry label such as `splashscreen` the walk never runs, say),
then with `--include-unreached` every label still unreached that holds
dialogue, in file order.

With no `label start` (and no `--label`) the scripts are read in file
order, as before this walk. Labels and scripts the walk never reaches are
listed in the ledger's `walk` and the summary; the reports their
statements made, and their menus' decisions, are left out.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .parser import Event, FileParse, FlowStep, Report

_FLOW_KINDS = frozenset({"jump", "call", "return", "fork", "screen"})
# Story events whose file counts as reached or not.
_STORY_KINDS = frozenset({"dialogue", "visual", "video"})
NOT_REACHED = "not reached from label {start}"


@dataclass
class _Op:
    """One step of the walk's program: a story event (``emit``), a
    ``label``, ``call``/``jump`` (``target`` a label name, None when
    computed), ``goto`` (``to`` an op index), ``return``, the ``end`` of a
    file, or a ``fork`` (``alts`` the op index each block starts at)."""

    kind: str
    file: int
    event: Event | None = None
    source: str = ""
    statement: str = ""
    target: str | None = None
    to: int = -1
    alts: list[int] = field(default_factory=list)
    candidates: list[str] = field(default_factory=list)


@dataclass
class Walk:
    """The story events in walk order, for kinetic_extract.timeline: each
    ``(parse, event)``; a ``flush`` event marks a file's end in a
    file-order walk. ``record`` is the ledger's `walk`, ``summary`` its
    summary lines."""

    events: list[tuple[FileParse, Event]]
    record: dict[str, Any]
    summary: list[str]


def _screen_actions(screens: dict[str, tuple[list[FlowStep], list[str]]],
                    name: str) -> list[FlowStep]:
    """The `Jump`/`Call` actions of a screen and the screens it `use`s,
    in order, each screen once."""
    out: list[FlowStep] = []
    seen: set[str] = set()
    todo = [name]
    while todo:
        screen = todo.pop(0)
        if screen in seen or screen not in screens:
            continue
        seen.add(screen)
        actions, uses = screens[screen]
        out += actions
        todo += uses
    return out


def _program(parses: list[tuple[str, FileParse]]
             ) -> tuple[list[_Op], dict[str, int]]:
    """The scripts as one program: each file's events in order then its
    ``end``; fork blocks after all files, each ending in a ``goto`` back
    after its fork. A shown screen with `Jump`/`Call` actions is a fork
    of those, and of going on past it. Labels map to their op (the
    first, in walk order, of a name defined twice)."""
    ops: list[_Op] = []
    labels: dict[str, int] = {}
    screens: dict[str, tuple[list[FlowStep], list[str]]] = {}
    for _rel, parsed in parses:
        for name, flow in parsed.screens.items():
            screens.setdefault(name, flow)
    pending: list[tuple[int, list[list[FlowStep]]]] = []

    def add(step: FlowStep, f: int, event: Event | None = None) -> None:
        if step.kind == "label":
            labels.setdefault(step.target or "", len(ops))
        alternatives = step.alternatives
        kind = step.kind
        if kind == "screen":
            actions = _screen_actions(screens, step.target or "")
            alternatives = [[a] for a in actions] + [[]]
            kind = "fork" if actions else "goto"
        if kind == "fork":
            pending.append((len(ops), alternatives))
        ops.append(_Op(kind, f, event, step.source, step.statement,
                       step.target, to=len(ops) + 1,
                       candidates=list(step.candidates)))

    for f, (_rel, parsed) in enumerate(parses):
        for event in parsed.events:
            if event.kind == "label":
                labels.setdefault(event.name or "", len(ops))
                ops.append(_Op("label", f, event, event.source))
            elif event.kind in _FLOW_KINDS and event.flow is not None:
                add(event.flow, f)
            else:
                ops.append(_Op("emit", f, event, event.source))
        ops.append(_Op("end", f))
    while pending:
        at, alternatives = pending.pop(0)
        fork = ops[at]
        for steps in alternatives:
            fork.alts.append(len(ops))
            for step in steps:
                add(step, fork.file)
            ops.append(_Op("goto", fork.file, to=at + 1))
    return ops, labels


def _successors(ops: list[_Op], labels: dict[str, int],
                cands: dict[int, list[int]]) -> list[list[int]]:
    """Each op's next ops; ``len(ops)`` is the exit (a return, a file's
    end, or a jump the walk cannot follow). A call goes on to the next op:
    the callee returns to it. A computed jump goes to its candidates
    (``cands``, by op)."""
    exit_ = len(ops)
    out: list[list[int]] = []
    for n, op in enumerate(ops):
        if op.kind in ("emit", "label", "call"):
            out.append([n + 1])
        elif op.kind == "jump" and op.target is None:
            out.append(cands.get(n) or [exit_])
        elif op.kind == "jump":
            out.append([labels.get(op.target or "", exit_)])
        elif op.kind == "goto":
            out.append([op.to])
        elif op.kind == "fork":
            out.append(list(op.alts))
        else:
            out.append([exit_])
    return out


def _post_dominators(succ: list[list[int]]) -> list[int]:
    """Each node's immediate post-dominator (Cooper, Harvey and Kennedy's
    iterative algorithm on the reversed graph, rooted at the exit node
    ``len(succ)``); -1 for a node that never reaches the exit."""
    exit_ = len(succ)
    preds: list[list[int]] = [[] for _ in range(exit_ + 1)]
    for n, nexts in enumerate(succ):
        for m in nexts:
            preds[m].append(n)
    # Postorder of the reversed graph from the exit.
    order: list[int] = []
    seen = bytearray(exit_ + 1)
    seen[exit_] = 1
    stack: list[tuple[int, int]] = [(exit_, 0)]
    while stack:
        node, k = stack[-1]
        if k < len(preds[node]):
            stack[-1] = (node, k + 1)
            nxt = preds[node][k]
            if not seen[nxt]:
                seen[nxt] = 1
                stack.append((nxt, 0))
        else:
            stack.pop()
            order.append(node)
    number = [-1] * (exit_ + 1)
    for k, node in enumerate(order):
        number[node] = k
    idom = [-1] * (exit_ + 1)
    idom[exit_] = exit_
    rpo = order[::-1][1:]   # the exit first, then left out
    changed = True
    while changed:
        changed = False
        for node in rpo:
            new = -1
            for m in (succ[node] if node < exit_ else ()):
                if idom[m] == -1:
                    continue
                if new == -1:
                    new = m
                    continue
                a, b = m, new
                while a != b:
                    while number[a] < number[b]:
                        a = idom[a]
                    while number[b] < number[a]:
                        b = idom[b]
                new = a
            if new != idom[node]:
                idom[node] = new
                changed = True
    return idom[:exit_]


def _line(source: str) -> tuple[str, int]:
    rel, _sep, line = source.rpartition(":")
    return rel, int(line) if line.isdigit() else 0


def file_order(parses: list[tuple[str, FileParse]]) -> Walk:
    """Every file's story events in file order, a ``flush`` after each
    file: the walk before item 4e, for a project with no `label start`."""
    events: list[tuple[FileParse, Event]] = []
    for _rel, parsed in parses:
        events += [(parsed, e) for e in parsed.events
                   if e.kind not in _FLOW_KINDS]
        events.append((parsed, Event("flush", "")))
    return Walk(events, {"order": "file names (no label start)"},
                ["walk: no label start, scripts read in file-name order"])


# Labels Ren'Py itself runs (at launch, the main menu, a load, quitting),
# never the story's flow: not candidates of a computed jump, and listed
# apart so --also-label can add one.
ENTRY_LABELS = frozenset({
    "start", "splashscreen", "before_main_menu", "main_menu", "after_load",
    "after_warp", "quit", "hide_windows"})


def entry_label(name: str) -> bool:
    return name in ENTRY_LABELS or name.startswith("_")


def follow_labels(parses: list[tuple[str, FileParse]],
                  start_label: str | None = None,
                  also_labels: list[str] | None = None,
                  include_unreached: bool = False) -> Walk:
    """The story events from ``start_label`` (default `start`) as Ren'Py
    runs them (module doc), then each of ``also_labels`` and, with
    ``include_unreached``, every label still unreached that holds
    dialogue. With no `start` and no ``start_label``, file order. An
    unknown ``start_label`` or ``also_labels`` name is fatal (SystemExit),
    as before."""
    ops, labels = _program(parses)
    start = start_label or "start"
    if start not in labels:
        if start_label is not None:
            raise SystemExit(f"kinetic-extract: label {start_label!r} not "
                             "found in the parsed script")
        return file_order(parses)
    for name in also_labels or []:
        if name not in labels:
            raise SystemExit(f"kinetic-extract: --also-label {name!r} not "
                             "found in the parsed script")
    exit_ = len(ops)
    parsed_of = [parsed for _rel, parsed in parses]
    in_order = sorted(labels.items(), key=lambda kv: kv[1])
    literals: set[str] = set().union(*(p.literals for p in parsed_of))
    dynamic_ops = [n for n, op in enumerate(ops)
                   if op.kind in ("jump", "call") and op.target is None]

    def run(entries: list[tuple[int, frozenset[int], int]],
            cands: dict[int, list[int]], ipdom: list[int],
            visited: bytearray, final: bool) -> dict[str, Any]:
        """Walk from each entry ``(op, stops, site)`` in turn (a site >= 0
        marks a computed jump's or call's candidate), marking
        ``visited``; with ``final``, the events and counts too."""
        out: dict[str, Any] = {"events": [], "rejoins": 0,
                               "not_repeated": [], "unfollowed": [],
                               "walked": {}, "sites": []}
        events = out["events"]

        def report(op: _Op, reason: str) -> None:
            if final:
                parsed_of[op.file].reports.append(
                    Report(op.source, op.statement, reason))
                out["unfollowed"].append({
                    "source": op.source, "statement": op.statement,
                    "reason": reason})

        def target_of(op: _Op) -> int | None:
            if op.target not in labels:
                report(op, f"{op.kind} target {op.target!r} is not a label "
                           "of the walked scripts; not followed")
                return None
            return labels[op.target]

        for entry in entries:
            tasks = [entry]
            while tasks:
                n, stops, site = tasks.pop()
                jumped = False
                if site >= 0 and n != exit_ and n not in stops \
                        and not visited[n]:
                    out["walked"][site] = out["walked"].get(site, 0) + 1
                while n != exit_:
                    if n in stops or visited[n]:
                        # A jump to the place the fork's paths meet, or
                        # to a label already walked: flow rejoins what is
                        # read once.
                        out["rejoins"] += jumped
                        break
                    visited[n] = 1
                    op = ops[n]
                    jumped = False
                    if op.kind in ("emit", "label"):
                        if op.event is not None and final:
                            events.append((parsed_of[op.file], op.event))
                        n += 1
                    elif op.kind in ("jump", "call") and op.target is None:
                        # Computed: each candidate in turn, a call
                        # returning here, a jump's path ending after them.
                        out["sites"].append(n)
                        found = cands.get(n, [])
                        if op.kind == "call":
                            if found:
                                tasks.append((n + 1, stops, -1))
                            tasks += [(c, frozenset(), n)
                                      for c in reversed(found)]
                            if found:
                                break
                            n += 1
                        else:
                            tasks += [(c, stops, n) for c in reversed(found)]
                            break
                    elif op.kind == "call":
                        to = target_of(op)
                        if to is not None and visited[to]:
                            if final:
                                out["not_repeated"].append({
                                    "source": op.source,
                                    "statement": op.statement})
                        elif to is not None:
                            tasks.append((n + 1, stops, -1))
                            tasks.append((to, frozenset(), -1))
                            break
                        n += 1
                    elif op.kind == "jump":
                        to = target_of(op)
                        if to is None:
                            break
                        n, jumped = to, True
                    elif op.kind == "goto":
                        n = op.to
                    elif op.kind == "fork":
                        join = ipdom[n]
                        inner = stops
                        if 0 <= join < exit_:
                            tasks.append((join, stops, -1))
                            inner = stops | {join}
                        tasks += [(alt, inner, -1)
                                  for alt in reversed(op.alts)]
                        break
                    else:
                        break
        return out

    # 1. Literal flow alone: which labels it reaches.
    first = bytearray(exit_)
    run([(labels[start], frozenset(), -1)], {},
        _post_dominators(_successors(ops, labels, {})), first, False)
    # 2. Each computed jump or call's candidates: the labels its own
    # expression names, then the labels named by a string literal
    # anywhere in the game's code, in file order, that literal flow does
    # not reach and Ren'Py does not run itself.
    pool = [n for name, n in in_order if name in literals
            and not first[n] and not entry_label(name)]
    cands: dict[int, list[int]] = {}
    for d in dynamic_ops:
        own = [labels[x] for x in dict.fromkeys(ops[d].candidates)
               if x in labels]
        cands[d] = own + [n for n in pool if n not in own]
    ipdom = _post_dominators(_successors(ops, labels, cands))
    visited = bytearray(exit_)
    main = run([(labels[start], frozenset(), -1)], cands, ipdom, visited,
               True)
    also = run([(labels[name], frozenset(), -1)
                for name in also_labels or []], cands, ipdom, visited, True)
    # Each label's dialogue lines, up to the next label of its file.
    label_lines: dict[int, int] = {}
    current = None
    for n, op in enumerate(ops):
        if op.kind == "end":
            current = None
        elif op.kind == "label" and op.event is not None:
            current = n if labels.get(op.event.name or "") == n else None
            if current is not None:
                label_lines[current] = 0
        elif (op.kind == "emit" and op.event is not None
              and op.event.kind == "dialogue" and current is not None):
            label_lines[current] += 1
    appended: list[dict[str, Any]] = []
    extra: list[dict[str, Any]] = []
    if include_unreached:
        for name, n in in_order:
            if n in label_lines and label_lines[n] and not visited[n]:
                appended.append({"label": name, "source": ops[n].source,
                                 "lines": label_lines[n]})
                extra.append(run([(n, frozenset(), -1)], cands, ipdom,
                                 visited, True))
    walks = [main, also, *extra]
    events = [e for w in walks for e in w["events"]]
    rejoins = sum(w["rejoins"] for w in walks)
    not_repeated = [e for w in walks for e in w["not_repeated"]]
    unfollowed = [e for w in walks for e in w["unfollowed"]]
    dynamic: list[dict[str, Any]] = []
    for w in walks:
        for site in w["sites"]:
            op = ops[site]
            got = w["walked"].get(site, 0)
            if cands.get(site):
                reason = (f"{op.kind} expression: the target is computed "
                          f"when the game runs; walked {got} of "
                          f"{len(cands[site])} candidate labels named in "
                          "the game's code")
            else:
                reason = (f"{op.kind} expression: the target is computed "
                          "when the game runs; not followed")
                unfollowed.append({"source": op.source,
                                   "statement": op.statement,
                                   "reason": reason})
            parsed_of[op.file].reports.append(
                Report(op.source, op.statement, reason))
            dynamic.append({"source": op.source, "statement": op.statement,
                            "candidates": len(cands.get(site, [])),
                            "walked": got})

    start_desc = f"label {start}" if start_label is None \
        else f"--label {start}"
    reached: list[str] = []
    unreached: list[dict[str, Any]] = []
    entries_unreached: list[str] = []
    # Per file: (label line, reached) in line order, for the spans below.
    spans: dict[str, list[tuple[int, bool]]] = {}
    file_story = [False] * len(parses)
    file_reached = [False] * len(parses)
    lines_unreached = 0
    current: dict[str, Any] | None = None
    for n, op in enumerate(ops):
        if op.kind == "end":
            current = None
            continue
        if visited[n]:
            file_reached[op.file] = True
        if op.kind == "label" and op.event is not None:
            name = op.event.name or ""
            rel, line = _line(op.source)
            spans.setdefault(parses[op.file][0], []).append(
                (line, bool(visited[n])))
            file_story[op.file] = True
            if labels.get(name) != n:
                current = None
                continue
            if visited[n]:
                reached.append(name)
                current = None
            else:
                current = {"label": name, "source": op.source, "lines": 0}
                unreached.append(current)
                if entry_label(name) and not name.startswith("_"):
                    entries_unreached.append(name)
        elif op.kind == "emit" and op.event is not None:
            if op.event.kind in _STORY_KINDS:
                file_story[op.file] = True
            if op.event.kind == "dialogue" and not visited[n]:
                lines_unreached += 1
                if current is not None:
                    current["lines"] += 1
    files_unreached = [parses[f][0] for f in range(len(parses))
                       if file_story[f] and not file_reached[f]]

    def in_unreached_label(source: str) -> bool:
        rel, line = _line(source)
        last = None
        for label_line, was_reached in spans.get(rel, []):
            if label_line > line:
                break
            last = was_reached
        return last is False

    reports_dropped = 0
    reason = NOT_REACHED.format(start=start)
    for _rel, parsed in parses:
        keep = parsed.reports[:parsed.story_reports_from]
        for rep in parsed.reports[parsed.story_reports_from:]:
            if in_unreached_label(rep.source):
                reports_dropped += 1
            else:
                keep.append(rep)
        parsed.reports[:] = keep
        for menu in parsed.menus:
            if in_unreached_label(menu.source):
                menu.skip_reason = reason

    record: dict[str, Any] = {
        "start": start_desc,
        "labelsReached": len(reached),
        "labelsUnreached": unreached,
        "scriptsUnreached": files_unreached,
        "linesUnreached": lines_unreached,
        "reportsUnreached": reports_dropped,
        "rejoins": rejoins,
        "callsNotRepeated": not_repeated,
        "notFollowed": unfollowed,
        "dynamic": dynamic,
        "entryLabelsUnreached": entries_unreached,
        "alsoLabels": list(also_labels or []),
        "appendedUnreached": appended,
    }
    names = [u["label"] for u in unreached]
    shown = ", ".join(names[:20]) + (f" and {len(names) - 20} more"
                                     if len(names) > 20 else "")
    summary = [
        f"walk: from {start_desc}; labels reached {len(reached)}, "
        f"unreached {len(unreached)}" + (f" ({shown})" if names else "")
        + f"; lines unreached {lines_unreached}",
        f"walk: scripts unreached {len(files_unreached)}"
        + (f" ({', '.join(files_unreached)})" if files_unreached else "")
        + f"; rejoins {rejoins}; calls not repeated {len(not_repeated)}; "
        f"jumps and calls not followed {len(unfollowed)}",
    ]
    if dynamic:
        summary.append(
            f"walk: computed jumps and calls {len(dynamic)}, candidate "
            f"labels walked {sum(d['walked'] for d in dynamic)}")
    if also_labels:
        summary.append(f"walk: --also-label walked {', '.join(also_labels)}"
                       " after the story")
    if include_unreached:
        summary.append(
            f"walk: --include-unreached appended {len(appended)} labels "
            f"({sum(a['lines'] for a in appended)} lines) after the story")
    if entries_unreached:
        summary.append(
            "walk: Ren'Py entry labels not walked: "
            + ", ".join(entries_unreached)
            + " (--also-label NAME walks one after the story)")
    return Walk(events, record, summary)
