"""Build the synthetic ``credits.rpyc`` fixture beside this file.

Run from the repo root (writes ``converter/tests/data/credits.rpyc``;
the same bytes on every run and every machine):

    .venv/bin/python converter/tests/data/build_credits_rpyc.py

The file is a compiled Ren'Py 8 script in the RPyC v2 layout: the
``RENPY RPC2`` header, a slot table (slot 1 and slot 2, then a zero
terminator), each slot a zlib (level 3) compressed protocol-2 pickle of
``(data, stmts)``, and a 16-byte MD5 tail, as Ren'Py writes it. Every
name, line and link in it is invented: the closing credits roll of
"The Lantern at Low Tide" by the made-up Tidewick & Pell studio, with
links only under example.com and example.org. Nothing comes from a real
game.

unrpyc only decompiles (it cannot compile), so this script fabricates
the pickle instead: stand-in classes named like Ren'Py's own
(``renpy.ast.Label``, ``Say``, ``Scene``, ``With``, ``If``,
``UserStatement``, ``Return``, ``PyExpr`` and
``renpy.revertable.RevertableDict``) pickle with the same opcodes and
the same slot-state shape (``(None, {attr: value})``) a real compile
gives, carrying the attributes Ren'Py 8 stores for each node. The vendored
unrpyc reads it through its safe unpickler like any compiled script. The
source it decompiles to is ``SOURCE`` below; the builder checks the
statement tree against it line by line.

What the tests rely on:

- converter/tests/test_rpyc.py: it decompiles to text the parser accepts
  with a ``label credits``; the decompile cache keys on file name; a
  stale ``script.rpyc`` copy never overrides its ``.rpy`` twin; a
  compiled-only project (and the CLI) parses it, and with one loose
  ``images/credits_1.png`` the scene ``credits_1`` resolves, so the
  dialogue under it becomes manifest items whose ledger source starts
  ``game/credits.rpyc:``. Keep the file under 200 KiB.
- converter/tests/test_implicit.py: a stale ``script.rpyc`` twin in a
  symlinked game folder is ignored for its ``.rpy``.
- converter/tests/test_rpa.py: stored as ``scripts/z.rpyc`` inside a test
  ``.rpa``, it goes through the decompile path and yields events.

Beyond those, it covers what a real credits script holds: ``play music``,
``show screen`` / ``hide screen`` user statements with a transition,
``scene ... with`` pairs (a ``With`` node on each side of the
``Scene``), a ``Say`` with its own ``with_``, ``if`` / ``else`` blocks
(the else condition is the plain string ``"True"``), nested scenes in
an ``if``, blank-line gaps and the label's closing ``return``.
"""

from __future__ import annotations

import copyreg
import hashlib
import pickle
import struct
import sys
import types
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent / "credits.rpyc"
FILENAME = "game/credits.rpy"
STAMP = 1700000000  # the fixed compile stamp in every node's name tuple
SPEAKER = "nr"

SOURCE = """\
label credits:
    play music harbour_theme
    scene credits_1 with slow_fade
    nr "Thank you for playing." with quick_fade
    scene credits_2 with quick_fade
    if extended:
        nr "You lit every lantern along the shore."
    else:
        nr "A few lanterns still wait along the shore."
    scene credits_3 with quick_fade
    nr "Story, art and code: the Tidewick & Pell studio."

    scene credits_4 with quick_fade
    nr "Music: the Low Tide Harbour Band, recorded in a boathouse."
    if extended:
        scene credits_5 with quick_fade
        nr "The extended edition adds three evenings at the lighthouse."

    scene credits_6 with quick_fade
    show screen thanks with quick_fade
    if extended:
        nr "Thank you for keeping the lanterns burning."
    else:
        nr "Read about the extended edition at https://example.com/lantern."
    hide screen thanks with quick_fade
    if extended:
        scene credits_7 with quick_fade
        nr "Every keeper's log is now in your hands."
        scene credits_8 with quick_fade
        show screen links with quick_fade
        nr "News and notes: https://example.org/tidewick-pell."
        hide screen links with quick_fade
    else:
        scene credits_7 with quick_fade
        nr "The keeper's logs are waiting in the extended edition."
    scene credits_9 with quick_fade
    nr "See you at the next low tide."

    return
"""


# --- stand-in Ren'Py modules and classes (pickle time only) ---------------

def _module(name: str) -> types.ModuleType:
    mod = types.ModuleType(name)
    sys.modules[name] = mod
    return mod


_renpy = _module("renpy")
_ast = _module("renpy.ast")
_revertable = _module("renpy.revertable")
_renpy.ast = _ast  # type: ignore[attr-defined]
_renpy.revertable = _revertable  # type: ignore[attr-defined]


class _Node:
    """A Ren'Py AST node: NEWOBJ with no args, then slot state."""

    def __init__(self, **state: object) -> None:
        self.state = state

    def __reduce_ex__(self, protocol: int):
        return (copyreg.__newobj__, (type(self),), (None, self.state))


def _node_class(name: str) -> type:
    cls = type(name, (_Node,), {"__module__": "renpy.ast"})
    cls.__qualname__ = name
    setattr(_ast, name, cls)
    return cls


Label = _node_class("Label")
Say = _node_class("Say")
Scene = _node_class("Scene")
With = _node_class("With")
If = _node_class("If")
UserStatement = _node_class("UserStatement")
Return = _node_class("Return")


class PyExpr(str):
    """``renpy.ast.PyExpr``: NEWOBJ (text, filename, line, py), then state."""

    filename: str
    linenumber: int

    def __new__(cls, text: str, linenumber: int) -> PyExpr:
        obj = super().__new__(cls, text)
        obj.filename = FILENAME
        obj.linenumber = linenumber
        return obj

    def __reduce_ex__(self, protocol: int):
        args = (type(self), str(self), self.filename, self.linenumber, 3)
        state = {"filename": self.filename, "linenumber": self.linenumber,
                 "py": 3}
        return (copyreg.__newobj__, args, (None, state))


PyExpr.__module__ = "renpy.ast"
PyExpr.__qualname__ = "PyExpr"
_ast.PyExpr = PyExpr  # type: ignore[attr-defined]


class RevertableDict(dict):
    """``renpy.revertable.RevertableDict``: NEWOBJ, then SETITEMS."""

    def __reduce_ex__(self, protocol: int):
        return (copyreg.__newobj__, (type(self),), None, None,
                iter(self.items()))


RevertableDict.__module__ = "renpy.revertable"
RevertableDict.__qualname__ = "RevertableDict"
_revertable.RevertableDict = RevertableDict  # type: ignore[attr-defined]


# --- statement builders ----------------------------------------------------

class _Script:
    """Builds nodes in source order, numbering their name tuples."""

    def __init__(self) -> None:
        self.serial = 0

    def common(self, line: int) -> dict[str, object]:
        name = (FILENAME, STAMP, self.serial)
        self.serial += 1
        return {"filename": FILENAME, "linenumber": line, "name": name,
                "next": None}

    def label(self, line: int, name: str, block: list) -> _Node:
        state = self.common(line)
        state.update(parameters=None, block=block, hide=False)
        state["name"] = name
        return Label(**state)

    def user(self, line: int, text: str, parsed: tuple) -> _Node:
        state = self.common(line)
        state.update(line=text, parsed=parsed, block=[], subparses=[],
                     translatable=False, code_block=None,
                     translation_relevant=False, rollback="normal",
                     init_priority=0, atl=None)
        return UserStatement(**state)

    def play_music(self, line: int, file: str) -> _Node:
        parsed = (("play", "music"), RevertableDict(
            file=PyExpr(file, line), fadeout="None", fadein="0",
            channel=None, loop=None, if_changed=False, volume="1.0"))
        return self.user(line, f"play music {file}", parsed)

    def show_screen(self, line: int, screen: str, trans: str) -> _Node:
        parsed = (("show", "screen"), RevertableDict(
            name=screen, arguments=None, predict=True,
            transition_expr=PyExpr(trans, line), layer=None, zorder=None,
            tag=None, expression=False))
        return self.user(line, f"show screen {screen} with {trans}", parsed)

    def hide_screen(self, line: int, screen: str, trans: str) -> _Node:
        parsed = (("hide", "screen"), RevertableDict(
            name=screen, transition_expr=PyExpr(trans, line), layer=None,
            expression=False))
        return self.user(line, f"hide screen {screen} with {trans}", parsed)

    def scene(self, line: int, image: str, trans: str) -> list[_Node]:
        """``scene IMAGE with TRANS``: paired With, Scene, closing With."""
        before = self.common(line)
        before.update(expr="None", paired=PyExpr(trans, line))
        scene = self.common(line)
        scene.update(imspec=((image,), None, None, [], None, None, []),
                     atl=None, layer=None)
        after = self.common(line)
        after.update(expr=PyExpr(trans, line), paired=None)
        return [With(**before), Scene(**scene), With(**after)]

    def say(self, line: int, what: str, with_: str | None = None) -> _Node:
        state = self.common(line)
        state.update(who=SPEAKER, who_fast=True, what=what,
                     with_=PyExpr(with_, line) if with_ else None,
                     interact=True, attributes=None, arguments=None,
                     temporary_attributes=None, explicit_identifier=False,
                     rollback="normal")
        return Say(**state)

    def if_(self, line: int, cond: str, then: list,
            else_: list | None = None) -> _Node:
        entries = [(PyExpr(cond, line), then)]
        if else_ is not None:
            entries.append(("True", else_))
        state = self.common(line)
        state.update(entries=entries)
        return If(**state)

    def return_(self, line: int) -> _Node:
        state = self.common(line)
        state.update(expression=None)
        return Return(**state)


def build_stmts() -> list:
    s = _Script()
    t = "quick_fade"
    lines = SOURCE.splitlines()

    def text(n: int) -> str:
        """The quoted dialogue on source line n (1-based)."""
        return lines[n - 1].split('"')[1]

    block: list = [
        s.play_music(2, "harbour_theme"),
        *s.scene(3, "credits_1", "slow_fade"),
        s.say(4, text(4), with_=t),
        *s.scene(5, "credits_2", t),
        s.if_(6, "extended", [s.say(7, text(7))], [s.say(9, text(9))]),
        *s.scene(10, "credits_3", t),
        s.say(11, text(11)),
        *s.scene(13, "credits_4", t),
        s.say(14, text(14)),
        s.if_(15, "extended", [*s.scene(16, "credits_5", t),
                               s.say(17, text(17))]),
        *s.scene(19, "credits_6", t),
        s.show_screen(20, "thanks", t),
        s.if_(21, "extended", [s.say(22, text(22))], [s.say(24, text(24))]),
        s.hide_screen(25, "thanks", t),
        s.if_(26, "extended", [
            *s.scene(27, "credits_7", t),
            s.say(28, text(28)),
            *s.scene(29, "credits_8", t),
            s.show_screen(30, "links", t),
            s.say(31, text(31)),
            s.hide_screen(32, "links", t),
        ], [
            *s.scene(34, "credits_7", t),
            s.say(35, text(35)),
        ]),
        *s.scene(36, "credits_9", t),
        s.say(37, text(37)),
        s.return_(39),
    ]
    label = s.label(1, "credits", block)
    return [label, s.return_(1)]


def build_bytes() -> bytes:
    from collections import defaultdict

    stmts = build_stmts()
    data = {"version": 5003000, "key": "unlocked",
            "deferred_parse_errors": defaultdict(list)}
    blob = zlib.compress(pickle.dumps((data, stmts), protocol=2), 3)
    slots = [blob, blob]  # slot 2 (before static transforms) is the same
    header_len = 10 + 12 * (len(slots) + 1)
    table = b""
    offset = header_len
    for number, chunk in enumerate(slots, start=1):
        table += struct.pack("III", number, offset, len(chunk))
        offset += len(chunk)
    table += struct.pack("III", 0, 0, 0)
    md5 = hashlib.md5(SOURCE.encode("utf-8")).digest()
    return b"RENPY RPC2" + table + b"".join(slots) + md5


def check_decompiles_to_source(path: Path) -> None:
    """Decompile `path` with the vendored unrpyc; it must give SOURCE."""
    import tempfile

    for name in ("renpy.revertable", "renpy.ast", "renpy"):
        sys.modules.pop(name, None)  # unrpyc fakes its own renpy package
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from kinetic_extract import rpyc

    with tempfile.TemporaryDirectory() as cache:
        text = rpyc.decompile_text(path, cache_dir=Path(cache))
    body = text.split("# Decompiled by unrpyc")[0].rstrip("\n") + "\n"
    if body != SOURCE:
        raise SystemExit(f"{path} decompiles to:\n{text}")


def main() -> None:
    OUT.write_bytes(build_bytes())
    check_decompiles_to_source(OUT)
    print(f"wrote {OUT} ({OUT.stat().st_size} B), decompiles to SOURCE")


if __name__ == "__main__":
    main()
