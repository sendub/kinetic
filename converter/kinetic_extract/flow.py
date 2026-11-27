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
  renpy.jump(var)`) has candidates: the labels named by a string literal
  anywhere in the game's code (parser.name_literals: not dialogue, menu
  choices or f-strings), leaving out labels literal flow reaches (found
  by a first walk without candidates) and Ren'Py's entry labels, shared
  out among the sites (item 4f): each label to the sites tied to it
  (their own expression, or the Python that sets their variable, names
  it: _tied_names), else the nearest site in its file, else the first
  site the walk reaches. A site tries its own expression's labels, then
  its share, then the unowned labels; those not yet walked are walked
  there: for a call each as a call returning to the site, for a jump
  each as a path of its own (a fork with no join), the site's path
  ending after them, as a jump's does. With no candidate it is reported,
  not followed.
- The end of a file returns, as a `return` does. (In Ren'Py falling off
  the end of a file inside a call ends the game; a return keeps the
  content after the call.)
- A menu that becomes a decision (docs/plan.md Phase 60 item 4) is a
  fork whose blocks are its choices: each choice's path is walked in turn
  up to where the choices meet (_menu_join), between `menu-open`,
  `choice-open` and `menu-close` markers, then the join once. The
  `menu-close` marker's ``outcome`` says how each path ended (at the
  join, back at the menu, at the story's end) or why the menu stays
  linear. Back at the menu includes a jump to content already read from
  which straight-line code reaches the menu (item 4b): it re-reads only
  the decision's lead-in, which is not laid out again. The menu stays
  linear (a path rejoining content read elsewhere, every choice empty); a
  choice with nothing of its own gets its text as a line
  (kinetic_extract.timeline makes the decision). A menu nested in a
  choice's path is preceded by that choice's text as a `route-lead`
  marker once it is a decision (item 8c), a line the timeline keeps when
  the route has no item before the menu. A nested menu whose choices meet
  at the end of the enclosing choice's block meets where the enclosing
  menu's choices do.
- An `if` chain the parser reads as a fork (docs/plan.md Phase 60 item 6)
  is laid out as such a menu, its arms the choices: an arm with nothing
  of its own gets its label in parentheses as its line
  (MenuRecord.line_of, the marker's ``arm``), and an arm whose path leads
  back to the chain keeps it linear.

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

import re

from .parser import Event, FileParse, FlowStep, Report, code_literals

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
    scope: str | None = None
    # A menu that becomes a decision: its index in its file's menus, and
    # the op index each alternative's block ends at (its `goto`).
    menu: int | None = None
    alt_ends: list[int] = field(default_factory=list)


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


def _program(parses: list[tuple[str, FileParse]], sets: bool = False
             ) -> tuple[list[_Op], dict[str, int]]:
    """The scripts as one program: each file's events in order then its
    ``end``; fork blocks after all files, each ending in a ``goto`` back
    after its fork. A shown screen with `Jump`/`Call` actions is a fork
    of those, and of going on past it. Labels map to their op (the
    first, in walk order, of a name defined twice). The parser's ``set``
    events are ``set`` ops with ``sets`` (Resets), else left out."""
    ops: list[_Op] = []
    labels: dict[str, int] = {}
    screens: dict[str, tuple[list[FlowStep], list[str]]] = {}
    for _rel, parsed in parses:
        for name, flow in parsed.screens.items():
            screens.setdefault(name, flow)
    pending: list[tuple[int, list[list[FlowStep]] | list[list[Event]]]] = []

    def add(step: FlowStep, f: int, event: Event | None = None) -> None:
        if step.kind == "label":
            labels.setdefault(step.target or "", len(ops))
        alternatives: list[list[FlowStep]] | list[list[Event]] = \
            step.alternatives
        kind = step.kind
        if kind == "screen":
            actions = _screen_actions(screens, step.target or "")
            alternatives = [[a] for a in actions] + [[]]
            kind = "fork" if actions else "goto"
        if kind == "fork" and step.menu is not None:
            alternatives = step.bodies
        if kind == "fork":
            pending.append((len(ops), alternatives))
        ops.append(_Op(kind, f, event, step.source, step.statement,
                       step.target, to=len(ops) + 1,
                       candidates=list(step.candidates), scope=step.scope,
                       menu=step.menu if kind == "fork" else None))

    def add_event(event: Event, f: int) -> None:
        if event.kind == "set":
            if sets:
                ops.append(_Op("set", f, event, event.source))
        elif event.kind == "label":
            labels.setdefault(event.name or "", len(ops))
            ops.append(_Op("label", f, event, event.source))
        elif event.kind in _FLOW_KINDS and event.flow is not None:
            add(event.flow, f)
        else:
            ops.append(_Op("emit", f, event, event.source))

    for f, (_rel, parsed) in enumerate(parses):
        for event in parsed.events:
            add_event(event, f)
        ops.append(_Op("end", f))
    while pending:
        at, alternatives = pending.pop(0)
        fork = ops[at]
        for steps in alternatives:
            fork.alts.append(len(ops))
            for step in steps:
                if isinstance(step, Event):
                    add_event(step, fork.file)
                else:
                    add(step, fork.file)
            fork.alt_ends.append(len(ops))
            ops.append(_Op("goto", fork.file, to=at + 1))
    return ops, labels


# How far a choice's post-dominator chain is read when the choices do not
# all meet (one ends the story): they meet within a scene, not a chapter.
_CHAIN_MAX = 5000
# How many ops a jump back to a menu may pass on its way there (a lead-in
# of story lines, or a run of labels and jumps).
_LEAD_IN_MAX = 5000


def _menu_join(ops: list[_Op], n: int, ipdom: list[int]) -> int:
    """Where the choices of the menu fork ``n`` meet (docs/plan.md Phase
    60 item 4), -1 for nowhere. Each choice's post-dominator chain is
    read from its block's start, the block's own ops left out (a choice
    that falls through meets the others after the menu, not in its own
    lines); a choice whose chain passes the menu itself loops back to
    it and is left out. The join is the first op common to the most
    remaining chains: the fork's immediate post-dominator when every
    choice gets there; otherwise where most of them meet, so a choice
    that ends the story leaves the others their join. A lone remaining
    choice, or one with a chain beside choices that end at once, meets
    the story at the first op past its block."""
    exit_ = len(ops)
    fork = ops[n]
    blocks = list(zip(fork.alts, fork.alt_ends))
    common = ipdom[n]
    if 0 <= common < exit_ and not any(lo <= common <= hi
                                       for lo, hi in blocks):
        return common   # every choice gets there: the usual case
    chains: list[list[int]] = []
    for lo, hi in blocks:
        chain: list[int] = []
        m, looping, steps = lo, False, 0
        while 0 <= m < exit_ and steps <= _CHAIN_MAX:
            if m == n:
                looping = True
                break
            if not lo <= m <= hi:
                chain.append(m)
            m = ipdom[m]
            steps += 1
        if not looping:
            chains.append(chain)
    if len(chains) == 1:
        return chains[0][0] if chains[0] else -1
    count: dict[int, int] = {}
    for chain in chains:
        for m in set(chain):
            count[m] = count.get(m, 0) + 1
    best = max(count.values(), default=0)
    if best < 2:
        reaching = [chain for chain in chains if chain]
        return reaching[0][0] if len(reaching) == 1 else -1
    for chain in chains:
        for m in chain:
            if count[m] == best:
                return m
    return -1


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


def choice_marker(record: Any, k: int) -> Event:
    """The `choice-text` marker of choice ``k`` of a menu (its text, which
    Ren'Py translates in a `strings` block) or of arm ``k`` of a condition
    (its label in parentheses, the converter's words: ``arm``)."""
    text, from_strings = record.line_of(k)
    return Event("choice-text", record.choice_sources[k], text=text,
                 from_strings=from_strings,
                 arm=None if from_strings else k)


def _in_file_order(parsed: FileParse, stream: list[Event],
                   out: list[tuple[FileParse, Event]],
                   choice: tuple[Any, int] | None = None) -> bool:
    """``stream``'s story events in file order onto ``out``, a menu that
    becomes a decision laid out between its markers as the walk lays it
    out, with no join (nothing follows a jump here, so nothing proves
    one): every route ``"ending"``, a pure choice. ``choice`` is the
    ``(record, index)`` of the choice whose block ``stream`` is, which a
    menu nested in it is preceded by, as the walk's route lead. True
    when a story event (or a choice's text) was added."""
    story = False
    for event in stream:
        flow = event.flow
        if event.kind == "fork" and flow is not None \
                and flow.menu is not None:
            record = parsed.menus[flow.menu]
            lead = None
            if choice is not None:
                lead = choice_marker(*choice)
                out.append((parsed, lead))
            out.append((parsed, Event("menu-open", event.source,
                                      name=str(flow.menu))))
            texts: list[Event] = []
            filled = []
            for k, body in enumerate(flow.bodies):
                out.append((parsed, Event(
                    "choice-open", record.choice_sources[k],
                    name=f"{flow.menu}:{k}")))
                filled.append(_in_file_order(parsed, body, out,
                                             (record, k)))
                if not filled[-1]:
                    texts.append(choice_marker(record, k))
                    out.append((parsed, texts[-1]))
            linear = None if any(filled) else (
                "every choice is empty: none reads anything")
            if linear is None:
                for marker in texts:
                    marker.kind = "dialogue"
                if lead is not None:
                    lead.kind = "route-lead"
                story = True
            out.append((parsed, Event(
                "menu-close", event.source, name=str(flow.menu),
                outcome={"linear": linear,
                         "results": ["ending"] * len(flow.bodies),
                         "how": ["read in file order (no label start): no "
                                 "walk proves a join"] * len(flow.bodies),
                         "join": None, "link": None})))
        elif event.kind not in _FLOW_KINDS and event.kind != "set":
            out.append((parsed, event))
            story = story or event.kind in _STORY_KINDS
    return story


def file_order(parses: list[tuple[str, FileParse]]) -> Walk:
    """Every file's story events in file order, a ``flush`` after each
    file: the walk before item 4e, for a project with no `label start`."""
    events: list[tuple[FileParse, Event]] = []
    for _rel, parsed in parses:
        _in_file_order(parsed, parsed.events, events)
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


_STRING_RE = re.compile(r"""\w?(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')""")
_NAME_USE_RE = re.compile(r"([A-Za-z_][\w.]*)(\s*\()?")
# Words of a computed jump's statement and of Python that are not the
# game's own variables or functions.
_NOT_NAMES = frozenset({
    "jump", "call", "expression", "pass", "from", "renpy", "store", "and",
    "or", "not", "in", "is", "if", "else", "elif", "for", "while", "return",
    "lambda", "None", "True", "False", "def", "global", "self", "len",
    "str", "int", "list", "dict", "range", "random", "choice", "min", "max",
    "get", "append", "format"})
_TIE_DEPTH = 4


def _names_used(code: str) -> tuple[list[str], list[str]]:
    """The variables and the functions called in a piece of code, the
    last part of a dotted name (`store.x` is `x`), string literals and
    Python's own words left out."""
    variables: list[str] = []
    functions: list[str] = []
    for m in _NAME_USE_RE.finditer(_STRING_RE.sub(" ", code)):
        name = m.group(1).rsplit(".", 1)[-1]
        if not name or name in _NOT_NAMES or name[0].isdigit():
            continue
        (functions if m.group(2) else variables).append(name)
    return variables, functions


def _tied_names(statement: str, scope: str | None,
                assignments: dict[str, list[tuple[str | None, str]]],
                functions: dict[str, str]) -> list[str]:
    """The label-like literals a computed jump or call is tied to: those
    of the Python that sets the variables its expression reads (an
    assignment in the same label or outside every label: init and python
    blocks, `define`, `default`, screens), of the functions that Python
    or its expression calls, and of the variables those read, a few
    steps deep."""
    expr = re.sub(r"\s+from\s+\w+\s*$", "", statement)
    out: list[str] = []
    seen: set[tuple[str, str]] = set()
    todo: list[tuple[str, str, int]] = []

    def follow(code: str, depth: int) -> None:
        variables, called = _names_used(code)
        todo.extend(("var", v, depth) for v in variables)
        todo.extend(("def", f, depth) for f in called)

    follow(expr, 0)
    while todo:
        kind, name, depth = todo.pop(0)
        if (kind, name) in seen or depth >= _TIE_DEPTH:
            continue
        seen.add((kind, name))
        if kind == "var":
            for where, value in assignments.get(name, []):
                if where is None or where == scope:
                    out += code_literals(value)
                    follow(value, depth + 1)
        elif name in functions:
            out += code_literals(functions[name])
            follow(functions[name], depth + 1)
    return out


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

    def way_to_menu(n: int, menu: int) -> str | None:
        """How the walk from op ``n`` reaches the menu fork ``menu``, None
        when it does not: ``""`` with no story event between (its own
        label, a named menu, or a label that jumps or runs straight to
        it); else through the decision's lead-in (docs/plan.md Phase 60
        item 4b), the source of its first story event. Past a story
        event only straight-line code may follow (story events, labels
        falling through, the end of a block): a jump, call, return or
        fork there makes the way no lead-in."""
        lead: str | None = None
        steps = 0
        while 0 <= n < exit_ and steps < _LEAD_IN_MAX:
            if n == menu:
                return lead or ""
            op = ops[n]
            if op.kind == "label" or op.kind == "emit":
                if lead is None and op.event is not None \
                        and op.event.kind in _STORY_KINDS:
                    lead = op.source
                n += 1
            elif op.kind == "goto":
                n = op.to
            elif op.kind == "jump" and op.target in labels \
                    and lead is None:
                n = labels[op.target or ""]
            else:
                return None
            steps += 1
        return None

    def run(entries: list[tuple[int, frozenset[int], int]],
            cands: dict[int, list[int]], ipdom: list[int],
            visited: bytearray, final: bool) -> dict[str, Any]:
        """Walk from each entry ``(op, stops, site)`` in turn (a site >= 0
        marks a computed jump's or call's candidate), marking
        ``visited``; with ``final``, the events and counts too.

        A menu that becomes a decision is walked as a fork whose join is
        _menu_join's, laid out between markers: `menu-open`, then per
        choice `choice-open` and its path up to the join, then
        `menu-close` (its ``outcome``: how each path ended) and the join
        once. A task carries the menu choices it is inside (``ctx``, each
        ``(fork op, choice, stops at the choice's start)``, outermost
        first) and how many of them a call inside cuts off (``floor``:
        where a callee's path ends says nothing of the choice's)."""
        out: dict[str, Any] = {"events": [], "rejoins": 0,
                               "not_repeated": [], "unfollowed": [],
                               "walked": {}, "sites": []}
        events = out["events"]
        menus: dict[int, dict[str, Any]] = {}
        # Each menu fork walked -> where its choices meet.
        menu_joins: dict[int, int] = {}
        # True from a decision's `menu-close` until its join's path shows
        # a story event, opens a menu or ends (a `path-end` marker).
        awaiting = [False]
        Ctx = tuple[tuple[int, int, frozenset[int]], ...]

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

        def path_end(kind: str, n: int, stops: frozenset[int], ctx: Ctx,
                     floor: int) -> None:
            """A path ended at op ``n``: a ``stop`` (a join or an op
            already walked), an ``exit`` (a return, a file's end) or
            ``unfollowed``. Each menu choice it is inside notes how."""
            if not final:
                return
            if awaiting[0]:
                awaiting[0] = False
                events.append((parsed_of[ops[min(n, exit_ - 1)].file],
                               Event("path-end", "")))
            steps = 0
            while kind == "stop" and n < exit_ and ops[n].kind == "goto" \
                    and n not in stops and steps < _LEAD_IN_MAX:
                # A block's end another path already passed: where it
                # goes is where this path ends (a menu at the end of a
                # choice's block meets the enclosing menu's join).
                n, steps = ops[n].to, steps + 1
            for depth in range(len(ctx) - 1, floor - 1, -1):
                fork, k, frame_stops = ctx[depth]
                info = menus[fork]
                got = kind
                if kind == "stop":
                    if n == info["join"]:
                        got = "join"
                    elif (way := way_to_menu(n, fork)) is not None:
                        got = "menu"
                        if way and info["lead"][k] is None:
                            info["lead"][k] = way
                    elif (n in stops and n not in frame_stops) or any(
                            n == menus[inner]["join"]
                            or way_to_menu(n, inner) is not None
                            for inner, _k, _s in ctx[depth + 1:]):
                        continue   # a fork inside the choice goes on there
                    else:
                        got = "rejoin"
                info["endings"][k].add(got)
                if got in ("rejoin", "unfollowed") \
                        and info["where"][k] is None:
                    info["where"][k] = ops[n].source if n < exit_ else ""

        def finish_choice(fork: int, k: int) -> None:
            """A choice with no story event of its own gets its text as a
            line, enabled at `menu-close` if the menu is a decision."""
            info = menus[fork]
            if info["story"][k]:
                return
            record = parsed_of[ops[fork].file].menus[ops[fork].menu]
            marker = choice_marker(record, k)
            cond = record.condition
            if cond is not None and cond.absent_else \
                    and k == len(record.choices) - 1:
                # Whether another arm reaches the join, which a following
                # decision that leaves this absent else out passes to.
                marker.outcome = {"others_join": any(
                    "join" in ends for ends in info["endings"][:k])}
            info["texts"].append(marker)
            events.append((parsed_of[ops[fork].file], marker))

        def enclosing_join(join: int, ctx: Ctx) -> int:
            """A menu whose choices meet at the end of an enclosing
            choice's block (its `goto`, nothing between) meets where that
            enclosing menu's choices do (Phase 60 item 8c): its routes
            continue there, as a jump there would."""
            m, steps = join, 0
            while 0 <= m < exit_ and ops[m].kind == "goto" \
                    and steps < _LEAD_IN_MAX:
                m, steps = ops[m].to, steps + 1
            if m != join and any(menu_joins.get(f) == m
                                 for f, _k, _s in ctx):
                return m
            return join

        def route_lead(ctx: Ctx) -> Event | None:
            """Before a menu nested in a choice's path, that choice's text
            as a marker (Phase 60 item 8c): a `route-lead` line once the
            menu is a decision, which the timeline keeps when the route
            has no item of its own before the menu, so the nested
            decision hangs inside its route."""
            if not ctx:
                return None
            outer, k, _s = ctx[-1]
            record = parsed_of[ops[outer].file].menus[ops[outer].menu]
            marker = choice_marker(record, k)
            events.append((parsed_of[ops[outer].file], marker))
            return marker

        def close_menu(fork: int, ctx: Ctx) -> None:
            info = menus[fork]
            op = ops[fork]
            record = parsed_of[op.file].menus[op.menu]
            linear = None
            for k, label in enumerate(record.choices):
                where = info["where"][k]
                if "unfollowed" in info["endings"][k]:
                    linear = (f"choice {k + 1} ({label}) leads where the "
                              f"walk does not follow, at {where}")
                    break
                if "rejoin" in info["endings"][k]:
                    linear = (f"choice {k + 1} ({label}) rejoins content "
                              f"read at {where}")
                    break
            if linear is None and not any(info["story"]):
                linear = ("every choice is empty: none reads anything "
                          "before where the choices meet")
            if linear is None and record.condition is not None:
                back = next((k for k, ends in enumerate(info["endings"])
                             if "menu" in ends and "join" not in ends),
                            None)
                if back is not None:
                    head = record.condition.heads[back] or "the absent else"
                    linear = (f"arm {back + 1} ({head}) leads back to the "
                              "condition")
            join = info["join"]
            join_source = ops[join].source if 0 <= join < exit_ else None
            results, how = [], []
            for ends, lead in zip(info["endings"], info["lead"]):
                if "join" in ends:
                    results.append("continue")
                    how.append(f"reaches the join at {join_source}")
                elif "menu" in ends:
                    results.append("return")
                    how.append("jumps back to the menu" + (
                        f" through its lead-in at {lead}" if lead else ""))
                else:
                    results.append("ending")
                    how.append("reaches the story's end"
                               if "exit" in ends else
                               "its paths end in other routes")
            if linear is None:
                for marker in info["texts"]:
                    marker.kind = "dialogue"
                if info["route_lead"] is not None:
                    info["route_lead"].kind = "route-lead"
                for outer, k, _s in ctx:
                    menus[outer]["story"][k] = True
            link = info["link"]
            outcome = {
                "linear": linear, "results": results, "how": how,
                "join": join_source,
                "link": None if link is None else
                (parsed_of[ops[link].file], ops[link].menu)}
            events.append((parsed_of[op.file],
                           Event("menu-close", op.source,
                                 name=str(op.menu), outcome=outcome)))
            if info["walk_join"] and not visited[join]:
                awaiting[0] = True

        for entry in entries:
            tasks: list[tuple[int, frozenset[int], int, Ctx, int,
                              tuple[Any, ...] | None]] = [
                (*entry, (), 0, None)]
            while tasks:
                n, stops, site, ctx, floor, mark = tasks.pop()
                if mark is not None:
                    if final and mark[0] == "open":
                        _kind, fork, k = mark
                        if k > 0:
                            finish_choice(fork, k - 1)
                        record = parsed_of[ops[fork].file].menus[
                            ops[fork].menu]
                        events.append((parsed_of[ops[fork].file], Event(
                            "choice-open", record.choice_sources[k],
                            name=f"{ops[fork].menu}:{k}")))
                    elif final and mark[0] == "close":
                        fork = mark[1]
                        finish_choice(fork, len(ops[fork].alts) - 1)
                        close_menu(fork, ctx)
                    continue
                jumped = False
                if site >= 0 and n != exit_ and n not in stops \
                        and not visited[n]:
                    out["walked"][site] = out["walked"].get(site, 0) + 1
                ended = "exit"
                while n != exit_:
                    if n in stops or visited[n]:
                        # A jump to the place the fork's paths meet, or
                        # to a label already walked: flow rejoins what is
                        # read once.
                        out["rejoins"] += jumped
                        ended = "stop"
                        break
                    visited[n] = 1
                    op = ops[n]
                    jumped = False
                    if op.kind in ("emit", "label"):
                        if op.event is not None and final:
                            events.append((parsed_of[op.file], op.event))
                            if op.event.kind in _STORY_KINDS:
                                awaiting[0] = False
                                for fork, k, _s in ctx:
                                    menus[fork]["story"][k] = True
                        n += 1
                    elif op.kind in ("jump", "call") and op.target is None:
                        # Computed: each candidate in turn, a call
                        # returning here, a jump's path ending after them.
                        out["sites"].append(n)
                        found = cands.get(n, [])
                        if op.kind == "call":
                            if found:
                                tasks.append((n + 1, stops, -1, ctx, floor,
                                              None))
                            tasks += [(c, frozenset(), n, ctx, len(ctx),
                                       None) for c in reversed(found)]
                            if found:
                                ended = ""
                                break
                            n += 1
                        else:
                            tasks += [(c, stops, n, ctx, floor, None)
                                      for c in reversed(found)]
                            ended = "" if found else "unfollowed"
                            break
                    elif op.kind == "call":
                        to = target_of(op)
                        if to is not None and visited[to]:
                            if final:
                                out["not_repeated"].append({
                                    "source": op.source,
                                    "statement": op.statement})
                        elif to is not None:
                            tasks.append((n + 1, stops, -1, ctx, floor,
                                          None))
                            tasks.append((to, frozenset(), -1, ctx,
                                          len(ctx), None))
                            ended = ""
                            break
                        n += 1
                    elif op.kind == "jump":
                        to = target_of(op)
                        if to is None:
                            ended = "unfollowed"
                            break
                        n, jumped = to, True
                    elif op.kind == "goto":
                        n = op.to
                    elif op.kind == "fork" and op.menu is not None:
                        join = enclosing_join(_menu_join(ops, n, ipdom),
                                              ctx)
                        menu_joins[n] = join
                        has_join = 0 <= join < exit_
                        inner = stops | {join} if has_join else stops
                        if final:
                            link = None
                            if has_join and join in stops:
                                link = next((f for f, _k, _s in
                                             reversed(ctx)
                                             if menus[f]["join"] == join),
                                            None)
                            count = len(op.alts)
                            menus[n] = {
                                "join": join if has_join else -1,
                                "walk_join": has_join and join not in stops,
                                "link": link,
                                "endings": [set() for _ in range(count)],
                                "where": [None] * count,
                                "lead": [None] * count,
                                "story": [False] * count, "texts": []}
                            awaiting[0] = False
                            menus[n]["route_lead"] = route_lead(ctx)
                            events.append((parsed_of[op.file], Event(
                                "menu-open", op.source, name=str(op.menu))))
                        if has_join and join not in stops:
                            tasks.append((join, stops, -1, ctx, floor, None))
                        tasks.append((-1, stops, -1, ctx, floor,
                                      ("close", n)))
                        for k in reversed(range(len(op.alts))):
                            frame = (*ctx, (n, k, inner))
                            tasks.append((op.alts[k], inner, -1, frame,
                                          floor, None))
                            tasks.append((-1, inner, -1, frame, floor,
                                          ("open", n, k)))
                        ended = ""
                        break
                    elif op.kind == "fork":
                        join = ipdom[n]
                        inner = stops
                        if 0 <= join < exit_:
                            tasks.append((join, stops, -1, ctx, floor, None))
                            inner = stops | {join}
                        tasks += [(alt, inner, -1, ctx, floor, None)
                                  for alt in reversed(op.alts)]
                        ended = ""
                        break
                    else:
                        break
                if ended:
                    path_end(ended, n, stops, ctx, floor)
        return out

    # 1. Literal flow alone: which labels it reaches.
    first = bytearray(exit_)
    run([(labels[start], frozenset(), -1)], {},
        _post_dominators(_successors(ops, labels, {})), first, False)
    # 2. Each computed jump or call's candidates. The labels named by a
    # string literal anywhere in the game's code that literal flow does
    # not reach and Ren'Py does not run itself are shared out: a label
    # goes to the sites tied to it (their expression, or the Python that
    # sets their variables, names it), else to the nearest site in its
    # own file, else to whichever site the walk reaches first. A site
    # tries the labels its own expression names first, then its share,
    # then the unowned ones, each group in file order.
    eligible = [n for name, n in in_order if name in literals
                and not first[n] and not entry_label(name)]
    assigned: dict[str, list[tuple[str | None, str]]] = {}
    functions: dict[str, str] = {}
    for parsed in parsed_of:
        for var, where, value in parsed.assignments:
            assigned.setdefault(var, []).append((where, value))
        for name, body in parsed.functions.items():
            functions.setdefault(name, body)
    own_of: dict[int, list[int]] = {}
    tied: dict[int, set[int]] = {}
    for d in dynamic_ops:
        own_of[d] = [labels[x] for x in dict.fromkeys(ops[d].candidates)
                     if x in labels]
        tied[d] = {labels[x] for x in _tied_names(
            ops[d].statement, ops[d].scope, assigned, functions)
            if x in labels}
    owners: dict[int, list[int]] = {}   # label op -> its sites; [] all
    for n in eligible:
        sites = [d for d in dynamic_ops if n in tied[d] or n in own_of[d]]
        if not sites:
            rel, line = _line(ops[n].source)
            near = [(abs(_line(ops[d].source)[1] - line), d)
                    for d in dynamic_ops if _line(ops[d].source)[0] == rel]
            sites = [min(near)[1]] if near else []
        owners[n] = sites

    def candidates() -> tuple[dict[int, list[int]], dict[int, int]]:
        cands: dict[int, list[int]] = {}
        share: dict[int, int] = {}
        unowned = [n for n in eligible if not owners[n]]
        for d in dynamic_ops:
            own = own_of[d]
            mine = [n for n in eligible if d in owners[n] and n not in own]
            first_part = own + mine
            share[d] = len(first_part)
            cands[d] = first_part + [n for n in unowned
                                     if n not in first_part]
        return cands, share

    entries = [(labels[start], frozenset(), -1)] + [
        (labels[name], frozenset(), -1) for name in also_labels or []]
    # A label whose sites the walk never reaches goes to whichever site
    # it reaches first, until that settles.
    for _round in range(len(dynamic_ops) + 1):
        cands, share = candidates()
        ipdom = _post_dominators(_successors(ops, labels, cands))
        trial = bytearray(exit_)
        reached = set(run(entries, cands, ipdom, trial, False)["sites"])
        moved = False
        for n, sites in owners.items():
            if sites and not trial[n] and not reached.intersection(sites):
                owners[n] = []
                moved = True
        if not moved:
            break
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
                            "own": share.get(site, 0), "walked": got})

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


class Resets:
    """Where the story walk meets each `$ x = ...` line of label flow
    (the parser's ``set`` events), for an `if` chain whose variable label
    flow sets before the menu whose choices set it (docs/plan.md Phase 60
    item 6c; kinetic_extract.conditions._followed). It runs before the
    walk, as conditions.prepare does, on the walk's program with those
    lines in it: a graph of where each statement may go next, a `jump`
    to its label, a `call` into its label and past it (the callee
    returns), a computed one to the labels its own expression names and
    every label a string literal of the game names (more than the walk
    tries), a fork to each block, a `return` or a file's end nowhere,
    except after the menu (below). Graph paths, not one walk's visiting
    order: a line the walk reaches first may still run again after the
    menu (a loop), and two ways to the menu may set different values."""

    def __init__(self, parses: list[tuple[str, FileParse]],
                 start_label: str | None = None) -> None:
        ops, labels = _program(parses, sets=True)
        self.ops = ops
        self.start = labels.get(start_label or "start")
        literals: set[str] = set().union(*(p.literals for _r, p in parses))
        named = [n for name, n in labels.items() if name in literals]
        self.succ: list[list[int]] = []
        # Each call op's callees.
        self.callees: dict[int, list[int]] = {}
        self.set_at: dict[str, int] = {}
        self.menu_at: dict[int, int] = {}
        for n, op in enumerate(ops):
            if op.kind in ("emit", "label", "set"):
                nexts = [n + 1]
            elif op.kind in ("jump", "call"):
                if op.target is None:
                    to = [labels[x] for x in op.candidates
                          if x in labels] + named
                else:
                    to = [labels[op.target]] if op.target in labels else []
                nexts = list(dict.fromkeys(to))
                if op.kind == "call":
                    self.callees[n] = list(nexts)
                    nexts.append(n + 1)
            elif op.kind == "goto":
                nexts = [op.to]
            elif op.kind == "fork":
                nexts = list(op.alts)
            else:
                nexts = []   # a return, a file's end
            self.succ.append([m for m in nexts if 0 <= m < len(ops)])
            if op.kind == "set":
                self.set_at[op.source] = n
            if op.kind == "fork" and op.menu is not None:
                record = parses[op.file][1].menus[op.menu]
                self.menu_at[id(record)] = n
        self.preds: list[list[int]] = [[] for _ in ops]
        for n, nexts in enumerate(self.succ):
            for m in nexts:
                self.preds[m].append(n)
        self.from_start = self._closure(
            [] if self.start is None else [self.start], self.succ)

    @staticmethod
    def _closure(roots: list[int], edges: list[list[int]]) -> bytearray:
        seen = bytearray(len(edges))
        todo = list(roots)
        for n in todo:
            seen[n] = 1
        while todo:
            n = todo.pop()
            for m in edges[n]:
                if not seen[m]:
                    seen[m] = 1
                    todo.append(m)
        return seen

    def values_before(self, record: Any, resets: dict[str, Any],
                      initial: Any) -> list[Any] | None:
        """The values the variable may have as the walk reaches the menu
        ``record`` when label flow sets it only at ``resets`` (source ->
        literal) and it starts as ``initial`` (its `default`): the last
        reset on each way from the story's start to the menu, ``initial``
        on a way that passes none. None when that is not proven: no
        `label start`, the menu or a reset not on the way from it, or a
        reset that may run again after the menu (later in the story, or
        in a loop back to before the menu), or one the walk has no place
        for (in a choice block or an `if` arm, or skipped)."""
        menu = self.menu_at.get(id(record))
        if menu is None or self.start is None or not self.from_start[menu]:
            return None
        to_menu = self._closure([menu], self.preds)
        at: dict[int, Any] = {}
        for source, value in resets.items():
            n = self.set_at.get(source)
            if n is None or not self.from_start[n] or not to_menu[n]:
                return None
            at[n] = value
        # After the menu, a return or a file's end goes back past each
        # call whose callee leads to the menu (one that may be under way
        # there): more than Ren'Py may, never less.
        back = [c + 1 for c, callees in self.callees.items()
                if any(to_menu[t] for t in callees) and c + 1 < len(self.ops)]
        after_edges = [nexts if nexts or self.ops[n].kind == "jump"
                       else back for n, nexts in enumerate(self.succ)]
        after = self._closure(self.succ[menu], after_edges)
        if any(after[n] for n in at):
            return None
        # The values reaching the menu, along the ways that lead to it.
        values: dict[int, list[Any]] = {self.start: [initial]}
        todo = [self.start]
        while todo:
            n = todo.pop()
            out = [at[n]] if n in at else values[n]
            for m in self.succ[n]:
                if not to_menu[m]:
                    continue
                have = values.setdefault(m, [])
                fresh = [v for v in out if not _among(v, have)]
                if fresh:
                    have += fresh
                    todo.append(m)
        return values.get(menu)


def _among(value: Any, values: list[Any]) -> bool:
    """Whether ``value`` is one of ``values``, by type and value (`1` is
    not `True`)."""
    return any(type(v) is type(value) and v == value for v in values)
