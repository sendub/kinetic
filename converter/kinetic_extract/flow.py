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
- The walk keeps the call stack (docs/plan.md Phase 60 item 9l): a
  `return` inside a called label goes on after the `call` (_Cont), only
  one with no call under way ending the story. A computed call's
  candidates return each into the next, as they are laid out, the last
  after the call. A menu's choices meet through returns (_menu_join's
  ``ups``): a choice leaving a called label meets the others in the
  caller, and a join past the call is walked as the caller's next task,
  reached through the `return` (item 9o2j: a menu or chain it meets
  before any item gets item 9o2b's line, as past any other `return`).
  A join that only returns, nothing shown before the `return`, is where
  the `return` goes on (item 9o2f), so a called label's menu at the end
  of an enclosing route continues where that route's decision does. A
  join at a block's end is named by the statement it goes on to, and
  its path goes on past the block as past an `if` that shows nothing,
  into the join of an `if` the walk lays out next (item 9o2h).
- A menu that becomes a decision (docs/plan.md Phase 60 item 4) is a
  fork whose blocks are its choices: each choice's path is walked in turn
  up to where the choices meet (_menu_join), between `menu-open`,
  `choice-open` and `menu-close` markers, then the join once. The
  `menu-close` marker's ``outcome`` says how each path ended (at the
  join, back at the menu, at the story's end) or why the menu stays
  linear. Back at the menu includes a jump to content already read from
  which straight-line code reaches the menu (item 4b): it re-reads only
  the decision's lead-in, which is not laid out again. A label two or
  more of a decision's routes go on to before the join is a shared tail
  (docs/plan.md Phase 60 item 9i): its run, read in the first route
  reaching it, is moved after the decision's last route behind a
  `shared-open` marker (lay_out_spans), leaving a `shared-mark`, and the
  `menu-close` outcomes say which routes go on to it (``then``) and
  where it leads (``shared``), filled in once the outermost menu open
  closes (resolve_region), when every route reaching it is known. The
  menu stays linear (a path rejoining content read elsewhere that is no
  shared tail, every choice empty but not all meeting at the join); a
  choice with nothing of its own gets its text as a line
  (kinetic_extract.timeline makes the decision), so a menu every choice
  of which meets the join with nothing of its own (a stat choice, item
  9o) is a decision of its choice lines. Before each menu it opens the
  walk puts a `menu-lead` marker, which the timeline makes the menu's
  line when it follows another decision's join with no item between
  (item 9o), or would hang off another decision's last item (items 9o2
  and 9o2b). A menu nested in a
  choice's path is preceded by that choice's text as a `route-lead`
  marker once it is a decision (item 8c), a line the timeline keeps when
  the route has no item before the menu. A nested menu whose choices meet
  at the end of the enclosing choice's block, past statements that show
  nothing (a sound, a bare `with`; item 9o2i), meets where the enclosing
  menu's choices do, those statements laid out after its `menu-close`.
- An `if` chain the parser reads as a fork (docs/plan.md Phase 60 item 6)
  is laid out as such a menu, its arms the choices: an arm with nothing
  of its own gets its label in parentheses as its line
  (MenuRecord.line_of, the marker's ``arm``), and an arm whose path leads
  back to the chain keeps it linear.
- A chain on its label's parameter that every call gives a literal
  (docs/plan.md Phase 60 item 9k; parser.FlowStep.pick) is no menu: each
  task carries the values of the call it is in, and the walk goes into
  the arm they pick (outside a call, the parameters' defaults). A later
  call of a label already walked reads, of each such chain the walk
  passed, the arm its values pick that no earlier call read, then
  returns, as the callee's path would.

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

import itertools
import re

from . import conditions
from .parser import (Event, FileParse, FlowStep, Report, call_arguments,
                     code_literals)

_FLOW_KINDS = frozenset({"jump", "call", "return", "fork", "screen"})
# Story events whose file counts as reached or not.
_STORY_KINDS = frozenset({"dialogue", "visual", "video"})
NOT_REACHED = "not reached from label {start}"
NOT_WALKED = ("not reached: no path of the walk reaches it (what comes "
              "before it in its label jumps, calls or returns elsewhere)")
NOT_LAID_OUT = ("inside a block the walk does not read (an if chain not "
                "converted, a loop or another statement's block): its "
                "lines are not laid out")
# Markers a shared tail's run may not hold (docs/plan.md Phase 60 item
# 9i): a span holds no decision.
_MARKER_KINDS = frozenset({"menu-open", "choice-open", "menu-close",
                           "choice-text", "route-lead", "menu-lead",
                           "path-end",
                           "shared-mark", "shared-open"})
# How a shared tail's path ends -> the span's `result`.
_SPAN_RESULT = {"join": "continue", "exit": "ending", "menu": "return"}
# Keys of shared tails, unique in a run of the converter: a route's
# `then` and its span meet by key (kinetic_extract.cli gives the ids).
_SPAN_KEYS = itertools.count(1)


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
    # A chain whose arm each call of its label picks (docs/plan.md Phase
    # 60 item 9k; parser.FlowStep.pick): its ChainCondition.
    pick: Any = None


class _Cont:
    """Where the walk goes on after a `call` (docs/plan.md Phase 60 item
    9l): ``task``, the walk's task for the statement after the call (or
    the next computed candidate, or the next arm a later call reads),
    whose mark names this object; ``done`` once a path took the callee's
    `return` there or a menu's join was walked in its place, so the task
    is not walked again. ``call``: the statement after the call, where
    Ren'Py's `return` goes; not the next label a computed call walks,
    which only the walk's layout puts next."""

    __slots__ = ("task", "done", "call")

    def __init__(self, call: bool = True) -> None:
        self.task: tuple[Any, ...] = ()
        self.done = False
        self.call = call


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
        if kind == "fork" and (step.menu is not None
                               or step.pick is not None):
            alternatives = step.bodies
        if kind == "fork":
            pending.append((len(ops), alternatives))
        ops.append(_Op(kind, f, event, step.source, step.statement,
                       step.target, to=len(ops) + 1,
                       candidates=list(step.candidates), scope=step.scope,
                       menu=step.menu if kind == "fork" else None,
                       pick=step.pick if kind == "fork" else None))

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
# How many calls out a menu's join is looked for (item 9l).
_UP_MAX = 64


def _menu_join(ops: list[_Op], n: int, ipdom: list[int],
               ups: list[int] | tuple[int, ...] = ()) -> tuple[int, int]:
    """Where the choices of the menu fork ``n`` meet (docs/plan.md Phase
    60 item 4): ``(op, level)``, ``(-1, 0)`` for nowhere. Each choice's
    post-dominator chain is read from its block's start, the block's own
    ops left out (a choice that falls through meets the others after the
    menu, not in its own lines); a choice whose chain passes the menu
    itself loops back to it and is left out. The join is the first op
    common to the most remaining chains: the fork's immediate
    post-dominator when every choice gets there; otherwise where most of
    them meet, so a choice that ends the story leaves the others their
    join. A lone remaining choice, or one with a chain beside choices
    that end at once, meets the story at the first op past its block.

    The graph's exit is a `return` (or a file's end) as much as the
    story's end. Inside a call (item 9l) ``ups`` are the ops the walk
    returns to, innermost first: a chain reaching the exit goes on at
    the next of them, a level up, so choices meet past the `call` when
    they leave the called label. ``level`` is how many calls the join
    lies outside the menu's own."""
    exit_ = len(ops)
    fork = ops[n]
    blocks = list(zip(fork.alts, fork.alt_ends))
    common = ipdom[n]
    if 0 <= common < exit_ and not any(lo <= common <= hi
                                       for lo, hi in blocks):
        return common, 0   # every choice gets there: the usual case
    chains: list[list[tuple[int, int]]] = []
    for lo, hi in blocks:
        chain: list[tuple[int, int]] = []
        m, level, looping, steps = lo, 0, False, 0
        while steps <= _CHAIN_MAX:
            if m == exit_ and level < len(ups):
                # A return: on in the caller, after its call.
                m, level = ups[level], level + 1
                chain.append((m, level))
                m, steps = ipdom[m], steps + 1
                continue
            if not 0 <= m < exit_:
                break
            if m == n and level == 0:
                looping = True
                break
            if level or not lo <= m <= hi:
                chain.append((m, level))
            m = ipdom[m]
            steps += 1
        if not looping:
            chains.append(chain)
    if len(chains) == 1:
        return chains[0][0] if chains[0] else (-1, 0)
    count: dict[tuple[int, int], int] = {}
    for chain in chains:
        for m in set(chain):
            count[m] = count.get(m, 0) + 1
    best = max(count.values(), default=0)
    if best < 2:
        reaching = [chain for chain in chains if chain]
        return reaching[0][0] if len(reaching) == 1 else (-1, 0)
    for chain in chains:
        for m in chain:
            if count[m] == best:
                return m
    return -1, 0


def lay_out_spans(events: list[tuple[FileParse, Event]],
                  moves: list[dict[str, Any]]) -> None:
    """Lay each shared tail out once (docs/plan.md Phase 60 item 9i): its
    run, ``events[e0:e1]``, is cut from where the walk first read it,
    leaving its ``marks`` (a `shared-mark`, after the route's choice text
    when the run was all that route read), and laid out again before the
    `menu-close` of the decision it belongs to (``at``), behind its
    `shared-open` marker, after the decision's last route. Runs never
    overlap and hold no menu marker, so no cut holds another's place."""
    cuts = {move["e0"]: move for move in moves}
    inserts: dict[int, list[dict[str, Any]]] = {}
    for move in sorted(moves, key=lambda m: m["e0"]):
        inserts.setdefault(move["at"], []).append(move)
    out: list[tuple[FileParse, Event]] = []
    i = 0
    while i < len(events):
        for move in inserts.pop(i, ()):
            out.append(move["open"])
            out.extend(events[move["e0"]:move["e1"]])
        move = cuts.get(i)
        if move is not None:
            out.extend(move["marks"])
            i = move["e1"]
            continue
        out.append(events[i])
        i += 1
    events[:] = out


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
            linear = record.parse_reason or (None if any(filled) else (
                "every choice is empty: none reads anything"))
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
    # The ops a path can stop at as already walked (a label, where a
    # block's end goes): where the walk first read them is kept for
    # shared tails (Phase 60 item 9i).
    targetable = bytearray(exit_)
    for n, op in enumerate(ops):
        if op.kind == "label":
            targetable[n] = 1
        elif op.kind == "goto" and 0 <= op.to < exit_:
            targetable[op.to] = 1

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

    # Item 9k: each label's parameters, and the forks whose arm each call
    # of their label picks (FlowStep.pick), by label. A task carries the
    # values of the call it is in (``bind``: the label and its
    # parameters' values, conditions.call_values), None outside one.
    params_of: dict[str, list[Any]] = {}
    for parsed in parsed_of:
        for name, params in parsed.label_params.items():
            params_of.setdefault(name, params)
    picks_in: dict[str, list[int]] = {}
    for n, op in enumerate(ops):
        if op.kind == "fork" and op.pick is not None:
            picks_in.setdefault(op.pick.label or "", []).append(n)
    Bind = tuple[str, dict[str, Any]] | None

    def call_bind(op: _Op) -> Bind:
        params = params_of.get(op.target or "")
        if params is None:
            return None
        return (op.target or "", conditions.call_values(
            call_arguments(op.statement), params))

    def pick_arm(cond: Any, bind: Bind) -> int | None:
        """The arm of a pick fork the values ``bind`` holds take (its
        label's defaults outside a call of it), None when unknown."""
        if bind is None or bind[0] != cond.label:
            bind = (cond.label, conditions.call_values(
                None, params_of.get(cond.label or "", [])))
        value = bind[1].get(cond.variable, conditions.UNKNOWN)
        return None if value is conditions.UNKNOWN else cond.arm_of(value)

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
        first), how many of them a call inside cuts off (``floor``:
        where a callee's path ends says nothing of the choice's) and the
        calls it is inside (``rets``, each a _Cont, innermost last; item
        9l): a `return` goes on after the call, as the callee's own task
        when the caller's next task is that, and as the choice's path in
        a choice of a menu opened in the callee, so only a `return` with
        no call under way ends the story."""
        out: dict[str, Any] = {"events": [], "rejoins": 0,
                               "not_repeated": [], "unfollowed": [],
                               "walked": {}, "sites": []}
        events = out["events"]
        menus: dict[int, dict[str, Any]] = {}
        # Each menu fork walked -> where its choices meet.
        menu_joins: dict[int, int] = {}
        # Each op a menu's join passed on its way out of a call (item
        # 9o2f) -> the join in the caller, the caller's ``floor`` and the
        # call the op is in.
        via: dict[int, tuple[int, int, _Cont]] = {}
        # Each op that shows nothing a menu's join passed on its way to
        # an enclosing menu's join (item 9o2i) -> that join.
        skip_to: dict[int, int] = {}
        # From a decision's `menu-close` until its join's path shows a
        # story event, opens a menu or ends (a `path-end` marker): the
        # joins of the `if` forks met on the join's path since, else None.
        # A block of such an `if` stopping at its join, walked next, does
        # not end the join's path (item 9l).
        awaiting: list[set[int] | None] = [None]
        # Whether the join's path went on through a `return`, or past a
        # block of an `if` on it (item 9l): a menu it then meets before
        # any item gets a line before it, which the decision continues at
        # (a `path-end` marker named ``crossed``; item 9o2b).
        crossed = [False]
        Ctx = tuple[tuple[int, int, frozenset[int]], ...]
        # Shared tails (docs/plan.md Phase 60 item 9i), final walk only:
        # every path end (``n``, ``kind``, ``ctx``, ``floor`` and ``got``,
        # depth -> how the choice there ended); each op that can be a
        # rejoin's target -> (events, ends, tasks, pops, ctx, awaiting)
        # when first walked; each task popped -> (events, ends, tasks
        # left); the menus closed since the outermost one open opened,
        # resolved at its close; the runs laid out again as spans.
        ends_log: list[dict[str, Any]] = []
        visit_at: dict[int, tuple[Any, ...]] = {}
        pops: list[tuple[int, int, int]] = []
        region: list[int] = []
        moves: list[dict[str, Any]] = []

        def report(op: _Op, reason: str) -> None:
            if final:
                parsed_of[op.file].reports.append(
                    Report(op.source, op.statement, reason))
                out["unfollowed"].append({
                    "source": op.source, "statement": op.statement,
                    "reason": reason})

        def unread_arms(label: str, callee: Bind) -> list[int]:
            """At a call of ``label`` already walked: the first op of each
            arm its values pick, of a pick fork walked before, that no
            earlier call read (item 9k)."""
            found: list[int] = []
            for p in picks_in.get(label, ()):
                if not visited[p]:
                    continue
                k = pick_arm(ops[p].pick, callee)
                if k is not None and not visited[ops[p].alts[k]]:
                    found.append(ops[p].alts[k])
            return found

        def target_of(op: _Op) -> int | None:
            if op.target not in labels:
                report(op, f"{op.kind} target {op.target!r} is not a label "
                           "of the walked scripts; not followed")
                return None
            return labels[op.target]

        def path_end(kind: str, n: int, stops: frozenset[int], ctx: Ctx,
                     floor: int, returned: bool = False,
                     rets: tuple[_Cont, ...] = ()) -> None:
            """A path ended at op ``n``: a ``stop`` (a join or an op
            already walked), an ``exit`` (a return, a file's end) or
            ``unfollowed``. Each menu choice it is inside notes how
            (``returned``: the path left a called label by its `return`
            on the way; ``rets``, the calls it is inside). A return
            inside a call from a choice of a menu whose join returns at
            once, nothing shown between, reaches the join (item 9l: a
            computed call's candidate, which goes on into the next). A
            stop at a `return` a menu's join passed in the caller's
            direction (item 9o2f) is a stop at that join, and so is one
            at a statement showing nothing that a menu's join passed on
            to an enclosing menu's join (item 9o2i)."""
            if not final:
                return
            pending = awaiting[0]
            if pending is not None and kind == "stop" and not visited[n] \
                    and (n in pending or walked_next(n)):
                # The join of an `if` the join's path is inside, past
                # its block's end (item 9o2h), as one met on the way.
                crossed[0] = True
            elif pending is not None:
                awaiting[0] = None
                events.append((parsed_of[ops[min(n, exit_ - 1)].file],
                               Event("path-end", "")))
            if kind == "stop" and n in via \
                    and any(c is via[n][2] for c in rets):
                # A `return` a menu's join follows (item 9o2f), in the
                # same call: the path goes on there, in the caller, as
                # through the return.
                n, floor, _cont = via[n]
                returned = True
            steps = 0
            while kind == "stop" and n < exit_ and steps < _LEAD_IN_MAX:
                if ops[n].kind == "goto" and n not in stops:
                    # A block's end another path already passed: where it
                    # goes is where this path ends (a menu at the end of
                    # a choice's block meets the enclosing menu's join).
                    n = ops[n].to
                elif n in skip_to:
                    # A statement showing nothing that a menu's join
                    # passed on to an enclosing menu's join (item 9o2i).
                    n = skip_to[n]
                else:
                    break
                steps += 1
            record: dict[str, Any] = {"n": n, "kind": kind, "ctx": ctx,
                                      "floor": floor, "got": {}}
            ends_log.append(record)
            for depth in range(len(ctx) - 1, floor - 1, -1):
                fork, k, frame_stops = ctx[depth]
                info = menus[fork]
                got = kind
                if kind == "exit" and rets and info["join_returns"]:
                    got = "join"
                elif kind == "stop":
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
                record["got"][depth] = got
                if got == "join" and returned:
                    info["returned"][k] = True
                info["ends"][k].append(len(ends_log) - 1)
                info["endings"][k].add(got)
                if got in ("rejoin", "unfollowed") \
                        and info["where"][k] is None:
                    info["where"][k] = ops[n].source if n < exit_ else ""

        def finish_choice(fork: int, k: int) -> None:
            """A choice with no story event of its own gets its text as a
            line, enabled at `menu-close` if the menu is a decision and no
            menu nested in the choice is one (judge_region)."""
            info = menus[fork]
            if info["story_n"][k]:
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
            info["texts"].append((k, marker))
            events.append((parsed_of[ops[fork].file], marker))

        def enclosing_join(join: int, ctx: Ctx) -> tuple[int, list[int]]:
            """A menu whose choices meet at the end of an enclosing
            choice's block (its `goto`, nothing between) meets where that
            enclosing menu's choices do (Phase 60 item 8c): its routes
            continue there, as a jump there would. So does one whose
            choices meet at statements that show nothing (a sound, a bare
            `with` or `pause`) before that end (item 9o2i): with that
            join, the ops passed on the way, laid out after the
            `menu-close` as item 9o2f lays out those before a `return`."""
            joins = {menu_joins.get(f) for f, _k, _s in ctx}
            m, steps, way = join, 0, []
            while 0 <= m < exit_ and steps < _LEAD_IN_MAX:
                op = ops[m]
                if op.kind == "goto":
                    m = op.to
                elif m in skip_to:
                    # Passed already, by the join of a menu enclosing
                    # this one: on to where that join goes.
                    m = skip_to[m]
                    break
                elif op.kind == "emit" and op.event is not None \
                        and op.event.kind not in _STORY_KINDS \
                        and not visited[m] and m not in joins:
                    # Not past an enclosing menu's join itself.
                    way.append(m)
                    m += 1
                else:
                    break
                steps += 1
            if m != join and any(menu_joins.get(f) == m
                                 for f, _k, _s in ctx):
                return m, way
            return join, []

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

        def menu_reason(fork: int, bad: set[int],
                        endings: list[set[str]]) -> str | None:
            """Why the menu stays linear, or None: in choice order, a
            choice leading where the walk does not follow or one in
            ``bad`` (rejoining content read elsewhere that no shared span
            lays out); then every choice empty; then an arm whose
            ``endings`` (its effective ones) lead back to its condition."""
            info = menus[fork]
            record = parsed_of[ops[fork].file].menus[ops[fork].menu]
            for k, label in enumerate(record.choices):
                where = info["where"][k]
                if "unfollowed" in info["endings"][k]:
                    return (f"choice {k + 1} ({label}) leads where the "
                            f"walk does not follow, at {where}")
                if k in bad:
                    return (f"choice {k + 1} ({label}) rejoins content "
                            f"read at {where}")
            if not any(info["story"]) and not (
                    record.condition is None and endings
                    and all(ends == {"join"} for ends in endings)):
                # A menu every choice of which meets the others at the
                # join is a stat choice (docs/plan.md Phase 60 item 9o):
                # its routes are its choice lines.
                return ("every choice is empty: none reads anything "
                        "before where the choices meet")
            if record.condition is not None:
                back = next((k for k, ends in enumerate(endings)
                             if "menu" in ends and "join" not in ends),
                            None)
                if back is not None:
                    head = record.condition.heads[back] or "the absent else"
                    return (f"arm {back + 1} ({head}) leads back to the "
                            "condition")
            return None

        def close_menu(fork: int, ctx: Ctx) -> None:
            """Every choice of the menu is walked: its `menu-close` marker
            goes out now, its outcome filled in when the outermost menu
            open closes (resolve_region), once every route reaching a
            label two of them share is known (Phase 60 item 9i)."""
            info = menus[fork]
            op = ops[fork]
            info["close_at"] = len(events)
            info["outcome"] = {}
            # The `menu-lead` marker reads it too: the timeline gives no
            # line to a menu that stays linear (item 9o2).
            info["lead_event"].outcome = info["outcome"]
            # A nested decision is content of its enclosing routes: so
            # far as its choices' endings show now, settled when the
            # outermost menu open closes (judge_region; item 9o2d).
            decided = menu_reason(fork, set(), info["endings"]) is None
            for outer, k, _s in ctx:
                menus[outer]["inner"][k].append(fork)
                if decided:
                    menus[outer]["story"][k] = True
            events.append((parsed_of[op.file],
                           Event("menu-close", op.source,
                                 name=str(op.menu), outcome=info["outcome"])))
            # The events of what the join passed on its way out of the
            # call (item 9o2f), as the walk past the `return` read them.
            events.extend((parsed_of[p.file], p.event) for p in info["passed"])
            # Whether the join's path is walked next (a decision held by
            # this one waits on it: kinetic_extract.timeline).
            info["outcome"]["awaits"] = bool(
                info["walk_join"] and not visited[info["join"]])
            if info["outcome"]["awaits"]:
                awaiting[0] = set()
                # A join in the caller (items 9l, 9o2f) is reached
                # through the `return` its choices cross (item 9o2j); one
                # at a block's end (item 9o2h) goes on past that block, as
                # past an `if` that shows nothing.
                crossed[0] = info["into_caller"] \
                    or block_end(info["join"])
            region.append(fork)
            if not ctx:
                resolve_region()

        def classify(n: int, kind: str, fork: int) -> str:
            """How a path ending at op ``n`` ends a choice of menu
            ``fork``, as path_end judges it; ``other`` for none of the
            join, the menu and the story's end."""
            if kind != "stop":
                return kind
            if n == menus[fork]["join"]:
                return "join"
            if way_to_menu(n, fork) is not None:
                return "menu"
            return "other"

        def plan_span(x: int, rs: list[int], deepest: dict[int, int],
                      menus_in: list[int]) -> dict[str, Any] | None:
            """The run from op ``x`` (up to where its path ends: a join,
            the story's end, a way back to a menu) that the rejoins ``rs``
            reach, as a shared tail of the innermost decision enclosing
            every route reaching it (docs/plan.md Phase 60 item 9i), or
            None where the shape does not fit: the run holds a menu, ends
            in more than one way or elsewhere, a route reaching it also
            ends elsewhere, or a call cuts the decision off a route
            reaching it. A route of a decision nested in that one leaves
            its decision and the routes holding it at the span; Play all
            routes offers that decision again at the span's end (item
            9i2). A nested decision whose choices meet at the label (its
            join) joins at the span instead: the route holding it is the
            one reaching the label."""
            v = visit_at.get(x)
            if v is None:
                return None
            e0, r0, left, p0, c0, waiting = v
            if not c0 or e0 < menus[menus_in[-1]]["open_at"]:
                return None
            joining = [f for f in menus_in if menus[f]["join"] == x]
            if waiting and not joining:
                return None
            run_end = None
            for p in range(p0, len(pops)):
                if pops[p][2] < left:
                    run_end = pops[p]
                    break
            if run_end is None:
                return None
            e1, r1, _left = run_end
            chains = [c0] + [ends_log[r]["ctx"][:deepest[r] + 1]
                             for r in rs]
            depth = 0
            while all(len(c) > depth for c in chains) \
                    and len({c[depth][0] for c in chains}) == 1:
                depth += 1
            if depth == 0:
                return None
            d_o = depth - 1
            owner = c0[d_o][0]
            if any(ends_log[r]["floor"] > d_o for r in rs):
                return None   # a call cuts the decision off a route
            story = 0
            for _parsed, event in events[e0:e1]:
                if event.kind in _MARKER_KINDS:
                    return None
                story += event.kind in _STORY_KINDS
            gots: set[str] = set()
            end: tuple[int, str] | None = None
            for r in range(r0, r1):
                rec = ends_log[r]
                got = rec["got"].get(d_o)
                if got is None or rec["ctx"][d_o][0] != owner:
                    continue
                gots.add(got)
                end = (rec["n"], rec["kind"])
            if len(gots) != 1 or not gots <= {"join", "exit", "menu"} \
                    or end is None:
                return None
            got = gots.pop()
            first = (c0[-1][0], c0[-1][1])
            routes = {first: ""}
            for r in rs:
                f, k, _s = ends_log[r]["ctx"][deepest[r]]
                routes[(f, k)] = ""
            allowed = set(range(r0, r1)) | set(rs)
            for f, k in routes:
                if any(r not in allowed for r in menus[f]["ends"][k]):
                    return None
                cls = classify(end[0], end[1], f)
                record = parsed_of[ops[f].file].menus[ops[f].menu]
                if record.condition is not None and cls == "menu":
                    return None
                routes[(f, k)] = cls
            involved = {f for c in chains for f, _k, _s in c[d_o:]}
            return {"x": x, "e0": e0, "e1": e1, "owner": owner,
                    "got": got, "end": end, "routes": routes,
                    "first": first, "involved": involved, "story": story,
                    "joining": joining}

        def effective_endings(fork: int, plans: dict[int, dict[str, Any]],
                              classes: dict[tuple[int, int], str]
                              ) -> list[set[str]]:
            """Each choice's endings with its rejoins into planned shared
            tails taken out and, for a route reaching one, how that tail
            ends for it."""
            info = menus[fork]
            d = info["depth"]
            out = []
            for k, endings in enumerate(info["endings"]):
                got = set(endings)
                rejoins = [r for r in info["ends"][k]
                           if ends_log[r]["got"].get(d) == "rejoin"]
                if rejoins and all(ends_log[r]["n"] in plans
                                   for r in rejoins):
                    got.discard("rejoin")
                if (fork, k) in classes:
                    got.add(classes[(fork, k)])
                out.append(got)
            return out

        def resolve_region() -> None:
            """The outermost menu open closed: every rejoin of the menus
            closed since it opened is known. A label reached by two or
            more routes before their decision's join becomes a shared
            tail where its shape fits (plan_span); a menu with a rejoin
            no tail takes, or holding a route of a tail one of whose
            menus stays linear, stays linear (to a fixed point). Then
            each menu's outcome is filled in and the tails' runs are
            set to move (lay_out_spans)."""
            menus_in = list(region)
            region.clear()
            deepest: dict[int, int] = {}
            for f in menus_in:
                d = menus[f]["depth"]
                for ends in menus[f]["ends"]:
                    for r in ends:
                        got = ends_log[r]["got"]
                        if got.get(d) == "rejoin" and r not in deepest:
                            deepest[r] = max(dd for dd, g in got.items()
                                             if g == "rejoin")
            groups: dict[int, list[int]] = {}
            for r in sorted(deepest):
                groups.setdefault(ends_log[r]["n"], []).append(r)
            plans: dict[int, dict[str, Any]] = {}
            for x, rs in groups.items():
                plan = plan_span(x, rs, deepest, menus_in)
                if plan is not None:
                    plans[x] = plan
            last = -1
            for x in sorted(plans, key=lambda x: plans[x]["e0"]):
                if not plans[x]["story"]:
                    continue
                if plans[x]["e0"] < last:
                    del plans[x]   # inside another tail's run
                else:
                    last = plans[x]["e1"]
            while True:
                bad: dict[int, set[int]] = {f: set() for f in menus_in}
                for x, rs in groups.items():
                    if x in plans:
                        continue
                    for r in rs:
                        rec = ends_log[r]
                        for dep, got in rec["got"].items():
                            if got == "rejoin" and rec["ctx"][dep][0] in bad:
                                bad[rec["ctx"][dep][0]].add(rec["ctx"][dep][1])
                classes = {fk: cls for plan in plans.values()
                           for fk, cls in plan["routes"].items()}
                eff = {f: effective_endings(f, plans, classes)
                       for f in menus_in}
                reasons = judge_region(menus_in, bad, eff)
                linear = {f for f in menus_in if reasons[f]}
                gone = [x for x, plan in plans.items()
                        if plan["involved"] & linear]
                if not gone:
                    break
                for x in gone:
                    del plans[x]
            then_of: dict[tuple[int, int], tuple[str, str]] = {}
            owned: dict[int, list[dict[str, Any]]] = {}
            # A nested decision whose choices meet at a shared tail joins
            # at its span's first item.
            join_span: dict[int, str] = {}
            for plan in sorted(plans.values(), key=lambda p: p["e0"]):
                if not plan["story"]:
                    continue
                plan["key"] = f"shared{next(_SPAN_KEYS)}"
                for fk in plan["routes"]:
                    then_of[fk] = (plan["key"], ops[plan["x"]].source)
                owned.setdefault(plan["owner"], []).append(plan)
                for f in plan["joining"]:
                    join_span[f] = plan["key"]
            for f in menus_in:
                finish_menu(f, reasons[f], eff[f],
                            then_of, owned.get(f, []))
                if f in join_span:
                    menus[f]["outcome"]["join_span"] = join_span[f]
            for plan in sorted(plans.values(), key=lambda p: p["e0"]):
                if plan["story"]:
                    move_span(plan)

        def judge_region(menus_in: list[int], bad: dict[int, set[int]],
                         eff: dict[int, list[set[str]]]
                         ) -> dict[int, str | None]:
            """Why each menu closed since the outermost one open opened
            stays linear, or None (menu_reason), in the order they closed,
            so a nested menu is judged before the menus holding it. A
            choice's story is its own story events and the menus nested
            in it judged decisions here: at its close a nested menu was
            judged on the endings known then, and a rejoin a shared tail
            takes later can make it a decision after all (item 9o2d), or
            one judged a decision then can stay linear."""
            reasons: dict[int, str | None] = {}
            for f in menus_in:
                info = menus[f]
                info["story"] = [
                    bool(own) or any(g in reasons and reasons[g] is None
                                     for g in inner)
                    for own, inner in zip(info["story_n"], info["inner"])]
                reasons[f] = menu_reason(f, bad[f], eff[f])
            return reasons

        def block_end(m: int) -> bool:
            """Whether op ``m`` is a block's end, a `goto` with no line
            of its own (not a `show screen` the walk passes)."""
            return 0 <= m < exit_ and ops[m].kind == "goto" \
                and not ops[m].source

        def join_text(join: int) -> str | None:
            """Where a join that follows its `return` to the caller (item
            9o2f), or has no line of its own (item 9o2h: a block's end,
            say a nested menu's at the end of its choice, or a file's
            end), is, for its outcome and notes: a block's end by the
            statement it goes on to, a file's end by its file; None for
            no join."""
            m = past_blocks(join)
            if not 0 <= m < exit_:
                return None
            return ops[m].source or f"the end of {parses[ops[m].file][0]}"

        def finish_menu(fork: int, linear: str | None,
                        endings: list[set[str]],
                        then_of: dict[tuple[int, int], tuple[str, str]],
                        spans: list[dict[str, Any]]) -> None:
            """Fill in the menu's `menu-close` outcome: how each path
            ended (its effective ``endings``), each route's shared tail
            (``then``), the tails it lays out (``shared``) or why it stays
            linear."""
            info = menus[fork]
            join = info["join"]
            if not 0 <= join < exit_:
                join_source = None
            elif info["past_return"] or block_end(join) \
                    or ops[join].kind == "end":
                join_source = join_text(join)
            else:
                join_source = ops[join].source
            results, how = [], []
            for k, (ends, lead) in enumerate(zip(endings, info["lead"])):
                if "join" in ends:
                    results.append("continue")
                    how.append(f"reaches the join at {join_source}" + (
                        " through a return to its caller"
                        if info["returned"][k] else ""))
                elif "menu" in ends:
                    results.append("return")
                    how.append("jumps back to the menu" + (
                        f" through its lead-in at {lead}" if lead else ""))
                else:
                    results.append("ending")
                    how.append("reaches the story's end"
                               if "exit" in ends else
                               "its paths end in other routes")
                if linear is None and (fork, k) in then_of:
                    how[-1] = (f"goes on to the shared span at "
                               f"{then_of[(fork, k)][1]}, which for this "
                               f"decision {how[-1]}")
            shared = []
            if linear is None and not any(info["story"]):
                parsed_of[ops[fork].file].menus[ops[fork].menu] \
                    .stat_choice = True
            if linear is None:
                for k, marker in info["texts"]:
                    if k is None or not info["story"][k]:
                        marker.kind = "dialogue"
                if info["route_lead"] is not None:
                    info["route_lead"].kind = "route-lead"
                for plan in spans:
                    x = plan["x"]
                    if plan["got"] == "join":
                        said = f"reaches the join at {join_source}"
                    elif plan["got"] == "menu":
                        way = way_to_menu(plan["end"][0], fork)
                        said = "jumps back to the menu" + (
                            f" through its lead-in at {way}" if way else "")
                    else:
                        said = "reaches the story's end"
                    shared.append({
                        "key": plan["key"],
                        "result": _SPAN_RESULT[plan["got"]],
                        "how": said, "source": ops[x].source,
                        "label": (ops[x].event.name if ops[x].kind == "label"
                                  and ops[x].event is not None else None)})
            link = info["link"]
            info["outcome"].update({
                "linear": linear, "results": results, "how": how,
                "join": join_source,
                "link": None if link is None else
                (parsed_of[ops[link].file], ops[link].menu),
                "shared": shared,
                "then": {} if linear is not None else {
                    k: key for (f, k), (key, _src) in then_of.items()
                    if f == fork},
            })

        def move_span(plan: dict[str, Any]) -> None:
            """Cut the tail's run from where the walk first read it,
            leaving a `shared-mark` (and the route's choice text when the
            run was all it read), to lay it out at its decision's
            `menu-close` behind a `shared-open` marker."""
            x = plan["x"]
            parsed = parsed_of[ops[x].file]
            marks = []
            f0, k0 = plan["first"]
            if menus[f0]["story_n"][k0] <= plan["story"]:
                record = parsed_of[ops[f0].file].menus[ops[f0].menu]
                marker = choice_marker(record, k0)
                marker.kind = "dialogue"
                menus[f0]["texts"].append((None, marker))
                marks.append((parsed_of[ops[f0].file], marker))
            marks.append((parsed, Event("shared-mark", ops[x].source,
                                        name=plan["key"])))
            moves.append({
                "e0": plan["e0"], "e1": plan["e1"], "marks": marks,
                "at": menus[plan["owner"]]["close_at"],
                "open": (parsed, Event("shared-open", ops[x].source,
                                       name=plan["key"]))})

        def up_conts(rets: tuple[_Cont, ...]) -> list[_Cont]:
            """The calls a path is inside, innermost first, each to the
            place its `return` goes on (item 9l); up to the first that is
            a computed call's next label."""
            ups: list[_Cont] = []
            while rets and len(ups) < _UP_MAX and rets[-1].call:
                ups.append(rets[-1])
                rets = rets[-1].task[7]
            return ups

        def push_calls(after: tuple[Any, ...],
                       starts: list[tuple[int, int, Bind]],
                       ctx: Ctx, rets: tuple[_Cont, ...]) -> None:
            """A call's tasks: ``after`` (the statement after it, without
            its mark) and each label it walks in turn (``starts``: the
            op, the site, the values bound), the first on top. Each
            callee returns to the next, the last to ``after``, so a
            callee's `return` goes on where the walk goes next (a menu's
            choices only to ``after``, where Ren'Py's `return` goes)."""
            nxt = _Cont()
            nxt.task = (*after[:5], ("ret", nxt), *after[6:])
            tasks.append(nxt.task)
            for k in reversed(range(len(starts))):
                m, site_k, bind_k = starts[k]
                task = (m, frozenset(), site_k, ctx, len(ctx), None, bind_k,
                        (*rets, nxt))
                if k:
                    nxt = _Cont(call=False)
                    nxt.task = (*task[:5], ("ret", nxt), *task[6:])
                    task = nxt.task
                tasks.append(task)

        def bare_return(m: int) -> list[int] | None:
            """The ops the walk from op ``m`` passes to the `return` (or
            file's end) it reaches with no story event, flow or fork
            between, that one included; None when it reaches none."""
            way: list[int] = []
            while 0 <= m < exit_ and len(way) < _LEAD_IN_MAX:
                way.append(m)
                op = ops[m]
                if op.kind in ("return", "end"):
                    return way
                if op.kind == "goto":
                    m = op.to
                elif op.kind == "label" or (
                        op.kind == "emit" and op.event is not None
                        and op.event.kind not in _STORY_KINDS):
                    m += 1
                else:
                    return None
            return None

        def taken_next() -> list[_Cont]:
            """The call continuations the walk takes up next, one after
            another, before any other task (those already taken passed
            over)."""
            found: list[_Cont] = []
            for task in reversed(tasks):
                mark = task[5]
                if mark is None or mark[0] != "ret":
                    break
                if not mark[1].done:
                    found.append(mark[1])
            return found

        def past_blocks(m: int) -> int:
            """Where op ``m`` goes on past the ends of blocks."""
            steps = 0
            while 0 <= m < exit_ and ops[m].kind == "goto" \
                    and steps < _LEAD_IN_MAX:
                m, steps = ops[m].to, steps + 1
            return m

        def pending_below(cont: _Cont) -> bool:
            """Whether the walk reads another way of the caller before
            where the call's statement after goes on to: the task under
            ``cont``'s is a block of an `if` it does not convert, laid
            out in a row with the one the call is in (item 9o2f), not a
            menu's choice or the statement a block's end reaches."""
            at = next((i for i in range(len(tasks) - 1, -1, -1)
                       if tasks[i] is cont.task), None)
            if not at:
                return False
            below = tasks[at - 1]
            return below[5] is None \
                and past_blocks(below[0]) != past_blocks(cont.task[0])

        def walked_next(n: int) -> bool:
            """Whether the walk's next task, past the call continuations
            already taken, reads on from op ``n`` with no mark, or from
            a block's end that goes there (an `if`'s missing `else`):
            the join of an `if` it does not convert whose other blocks
            it has read (item 9o2h)."""
            for task in reversed(tasks):
                mark = task[5]
                if mark is not None and mark[0] == "ret" and mark[1].done:
                    continue
                return mark is None and past_blocks(task[0]) == n
            return False

        def next_cont() -> _Cont | None:
            """The call continuation the walk takes up next, past those
            already taken, or None when its next task is another."""
            for task in reversed(tasks):
                mark = task[5]
                if mark is None or mark[0] != "ret":
                    return None
                if not mark[1].done:
                    return mark[1]
            return None

        for entry in entries:
            tasks: list[tuple[Any, ...]] = [(*entry, (), 0, None, None, ())]
            while tasks:
                n, stops, site, ctx, floor, mark, bind, rets = tasks.pop()
                if final:
                    pops.append((len(events), len(ends_log), len(tasks)))
                if mark is not None and mark[0] == "ret":
                    # Where a call goes on, unless a path went on there.
                    if mark[1].done:
                        continue
                    mark[1].done = True
                elif mark is not None:
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
                jumped = returned = False
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
                    if final and targetable[n]:
                        visit_at[n] = (len(events), len(ends_log),
                                       len(tasks), len(pops), ctx,
                                       awaiting[0] is not None)
                    op = ops[n]
                    jumped = False
                    if op.kind in ("emit", "label"):
                        if op.event is not None and final:
                            events.append((parsed_of[op.file], op.event))
                            if op.event.kind in _STORY_KINDS:
                                awaiting[0] = None
                                for fork, k, _s in ctx:
                                    menus[fork]["story"][k] = True
                                    menus[fork]["story_n"][k] += 1
                        n += 1
                    elif op.kind in ("jump", "call") and op.target is None:
                        # Computed: each candidate in turn, a call
                        # returning here, a jump's path ending after them.
                        out["sites"].append(n)
                        found = cands.get(n, [])
                        if op.kind == "call":
                            if found:
                                push_calls(
                                    (n + 1, stops, -1, ctx, floor, None,
                                     bind, rets),
                                    [(c, n, None) for c in found], ctx, rets)
                                ended = ""
                                break
                            n += 1
                        else:
                            tasks += [(c, stops, n, ctx, floor, None, None,
                                       rets) for c in reversed(found)]
                            ended = "" if found else "unfollowed"
                            break
                    elif op.kind == "call":
                        to = target_of(op)
                        callee = call_bind(op)
                        if to is not None and visited[to]:
                            if final:
                                out["not_repeated"].append({
                                    "source": op.source,
                                    "statement": op.statement})
                            # Item 9k: the arms this call's arguments pick
                            # that no earlier call read.
                            arms = unread_arms(op.target or "", callee)
                            if arms:
                                push_calls(
                                    (n + 1, stops, -1, ctx, floor, None,
                                     bind, rets),
                                    [(a, -1, callee) for a in arms], ctx,
                                    rets)
                                ended = ""
                                break
                        elif to is not None:
                            push_calls((n + 1, stops, -1, ctx, floor, None,
                                        bind, rets), [(to, -1, callee)],
                                       ctx, rets)
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
                        ups = up_conts(rets)
                        join, level = _menu_join(
                            ops, n, ipdom, [c.task[0] for c in ups])
                        # A join that only returns (item 9o2f): the
                        # choices meet where the `return` goes on, in the
                        # caller, as Ren'Py's flow does, when the walk
                        # takes that up next (no other path of the called
                        # label is still to walk, which would return
                        # there too). The ops passed on the way are read,
                        # their events (a sound, a transition) laid out
                        # after the `menu-close`, and a path stopping at
                        # one meets the others at the join (path_end).
                        # A `return` an enclosing menu's join passed on
                        # its way out (``via``) leads to that join.
                        passed: list[tuple[int, _Cont]] = []
                        ready = taken_next()
                        found_at = level
                        while 0 <= join < exit_ and level < len(ups) and (
                                way := bare_return(join)) is not None:
                            hit = next((k for k, m in enumerate(way)
                                        if m in via and any(
                                            c is via[m][2]
                                            for c in ups[level:])), None)
                            if hit is not None:
                                passed += [(m, ups[level])
                                           for m in way[:hit]]
                                join, _floor, cont = via[way[hit]]
                                level = next(k for k, c in enumerate(ups)
                                             if c is cont) + 1
                                break
                            if not any(c is ups[level] for c in ready) \
                                    or pending_below(ups[level]):
                                break
                            passed += [(m, ups[level]) for m in way]
                            join, level = ups[level].task[0], level + 1
                        join, skipped = enclosing_join(join, ctx)
                        laid = [ops[m] for m, _c in passed
                                if not visited[m] and ops[m].event is not None]
                        laid += [ops[m] for m in skipped]
                        for m, cont in passed:
                            visited[m] = 1
                            via[m] = (join, ups[level - 1].task[4], cont)
                        for m in skipped:
                            # A path stopping at one meets the others at
                            # the join (path_end).
                            visited[m] = 1
                            skip_to[m] = join
                        # A join past the call the menu is in (item 9l):
                        # walked as the caller's next task would be.
                        up = ups[level - 1] if level else None
                        jstops = stops if up is None else stops | up.task[1]
                        if any(join in c.task[1] for c in ups[:level]) \
                                and any(menu_joins.get(f) == join
                                        for f, _k, _s in ctx):
                            # A stop of a call frame the join is past that
                            # an enclosing menu's choices meet at: that
                            # menu's join (item 9o2f).
                            jstops = jstops | {join}
                        menu_joins[n] = join
                        has_join = 0 <= join < exit_
                        inner = stops | {join} if has_join else stops
                        walk_join = has_join and join not in jstops
                        if walk_join and up is not None:
                            jtask = (join, up.task[1], up.task[2], ctx,
                                     up.task[4], None, up.task[6],
                                     up.task[7])
                        elif walk_join:
                            jtask = (join, stops, -1, ctx, floor, None,
                                     bind, rets)
                        if has_join and up is not None:
                            for c in ups[:level]:
                                c.done = True
                        if final:
                            link = None
                            if has_join and join in jstops:
                                link = next((f for f, _k, _s in
                                             reversed(ctx)
                                             if menus[f]["join"] == join),
                                            None)
                            count = len(op.alts)
                            menus[n] = {
                                "join": join if has_join else -1,
                                "walk_join": walk_join,
                                "join_returns": has_join and level == 0
                                and bare_return(join) is not None,
                                "link": link,
                                "endings": [set() for _ in range(count)],
                                "where": [None] * count,
                                "lead": [None] * count,
                                "returned": [False] * count,
                                "story": [False] * count, "texts": [],
                                "story_n": [0] * count,
                                "inner": [[] for _ in range(count)],
                                "ends": [[] for _ in range(count)],
                                "open_at": len(events), "depth": len(ctx),
                                "ctx": ctx,
                                "past_return": level > found_at,
                                "into_caller": level > 0,
                                "passed": laid}
                            if awaiting[0] is not None and crossed[0]:
                                events.append((parsed_of[op.file],
                                               Event("path-end", "",
                                                     name="crossed")))
                            awaiting[0] = None
                            # The line a menu straight after another
                            # decision's join gets (docs/plan.md Phase 60
                            # item 9o): the timeline keeps it when no item
                            # came since that decision closed.
                            lead = Event("menu-lead", op.source,
                                         name=str(op.menu))
                            events.append((parsed_of[op.file], lead))
                            menus[n]["lead_event"] = lead
                            menus[n]["route_lead"] = route_lead(ctx)
                            events.append((parsed_of[op.file], Event(
                                "menu-open", op.source, name=str(op.menu))))
                        if walk_join:
                            tasks.append(jtask)
                        tasks.append((-1, stops, -1, ctx, floor,
                                      ("close", n), bind, rets))
                        for k in reversed(range(len(op.alts))):
                            frame = (*ctx, (n, k, inner))
                            tasks.append((op.alts[k], inner, -1, frame,
                                          floor, None, bind, rets))
                            tasks.append((-1, inner, -1, frame, floor,
                                          ("open", n, k), bind, rets))
                        ended = ""
                        break
                    elif op.kind == "fork" and op.pick is not None \
                            and (k := pick_arm(op.pick, bind)) is not None:
                        # Item 9k: the arm this call's value picks.
                        n = op.alts[k]
                    elif op.kind == "fork":
                        join = ipdom[n]
                        inner = stops
                        if 0 <= join < exit_:
                            tasks.append((join, stops, -1, ctx, floor, None,
                                          bind, rets))
                            inner = stops | {join}
                            if awaiting[0] is not None:
                                awaiting[0].add(join)
                        tasks += [(alt, inner, -1, ctx, floor, None, bind,
                                   rets) for alt in reversed(op.alts)]
                        ended = ""
                        break
                    elif rets and len(ctx) > floor and rets[-1].call:
                        # A return (or a file's end) in a choice of a menu
                        # opened in this call (item 9l): the choice's
                        # path goes on after the call, in the caller.
                        cont = rets[-1]
                        cont.done = returned = True
                        (m, c_stops, c_site, _ctx, floor, _mark, bind,
                         rets) = cont.task
                        stops = stops | c_stops
                        if c_site >= 0 and m not in stops and not visited[m]:
                            out["walked"][c_site] = \
                                out["walked"].get(c_site, 0) + 1
                        n = m
                    else:
                        # A return, a file's end. The caller's next task
                        # walks on after the call: this path goes on there
                        # (item 9l), so a join reached through the return
                        # is not cut short.
                        if rets and not rets[-1].done \
                                and next_cont() is rets[-1]:
                            ended = ""
                            crossed[0] = True
                        break
                if ended:
                    path_end(ended, n, stops, ctx, floor, returned, rets)
        if region:
            resolve_region()
        if moves:
            lay_out_spans(events, moves)
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
    # A menu in a label the walk reaches that it never lays out says why
    # (docs/plan.md Phase 60 item 9l), not "region not completed".
    forks: set[int] = set()
    for n, op in enumerate(ops):
        if op.kind == "fork" and op.menu is not None:
            menu = parsed_of[op.file].menus[op.menu]
            forks.add(id(menu))
            if not visited[n] and menu.skip_reason is None:
                menu.skip_reason = NOT_WALKED
    for parsed in parsed_of:
        for menu in parsed.menus:
            if id(menu) not in forks and menu.skip_reason is None:
                menu.skip_reason = NOT_LAID_OUT

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
                      initial: Any) -> list[tuple[Any, str | None]] | None:
        """The values the variable may have as the walk reaches the menu
        ``record`` when label flow sets it only at ``resets`` (source ->
        literal) and it starts as ``initial`` (its `default`), each with
        where it comes from: the last reset on each way from the story's
        start to the menu (its source), ``initial`` on a way that passes
        none (None); resets in program order, ``initial`` first. None
        when that is not proven: no
        `label start`, the menu or a reset not on the way from it, or a
        reset that may run again after the menu (later in the story, or
        in a loop back to before the menu), or one the walk has no place
        for (in a choice block or an `if` arm, or skipped)."""
        menu = self.menu_at.get(id(record))
        if menu is None or self.start is None or not self.from_start[menu]:
            return None
        to_menu = self._closure([menu], self.preds)
        at: dict[int, tuple[Any, str | None]] = {}
        for source, value in resets.items():
            n = self.set_at.get(source)
            if n is None or not self.from_start[n] or not to_menu[n]:
                return None
            at[n] = (value, source)
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
        values: dict[int, list[tuple[Any, str | None]]] = {
            self.start: [(initial, None)]}
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
        got = values.get(menu)
        return None if got is None else sorted(
            got, key=lambda v: -1 if v[1] is None else self.set_at[v[1]])


def _among(start: tuple[Any, str | None],
           starts: list[tuple[Any, str | None]]) -> bool:
    """Whether ``start`` (a value and its source) is one of ``starts``,
    the value by type and value (`1` is not `True`)."""
    value, source = start
    return any(type(v) is type(value) and v == value and s == source
               for v, s in starts)
