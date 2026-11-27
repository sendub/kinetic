"""A menu with one plain choice is no decision (docs/plan.md Phase 60
item 3): its choice text is a narration line where the menu stood, and
its block's statements follow in place as label flow, their jump, call
or return followed by the walk. The line's translation comes from the
language's `strings` block, as route labels' do.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from PIL import Image
from kinetic_extract.cli import main as cli_main
from kinetic_extract.parser import parse_file, parse_project
from kinetic_extract.timeline import build_timeline

REPO_ROOT = Path(__file__).resolve().parents[2]


def story(parsed) -> list[tuple]:
    """The parse's events as (kind, speaker or flow target, text); the
    `set` events the walk passes over (Phase 60 item 6c) left out."""
    out = []
    for e in parsed.events:
        if e.kind == "set":
            continue
        if e.kind == "dialogue":
            out.append(("dialogue", e.speaker, e.text))
        elif e.flow is not None:
            out.append((e.kind, e.flow.target))
        elif e.kind == "audio":
            out.append(("audio",))
        else:
            out.append((e.kind, e.name))
    return out


# --- parser ------------------------------------------------------------------

def test_the_choice_is_a_line_and_its_block_follows_in_place() -> None:
    text = ('label start:\n'                                  # 1
            '    scene bg\n'                                  # 2
            '    a "Leave it, then..."\n'                     # 3
            '    menu:\n'                                     # 4
            '        "Wait, Robin, hear me out!":\n'     # 5
            '            play sound "door.ogg"\n'             # 6
            '            show bg2\n'                          # 7
            '            a "What?"\n'                         # 8
            '            jump talk\n'                         # 9
            'label talk:\n'                                   # 10
            '    "Talk."\n')                                  # 11
    parsed = parse_file(text, "game/x.rpy")
    assert story(parsed) == [
        ("label", "start"), ("visual", "bg"),
        ("dialogue", "a", "Leave it, then..."),
        ("dialogue", None, "Wait, Robin, hear me out!"),
        ("audio",), ("visual", "bg2"), ("dialogue", "a", "What?"),
        ("jump", "talk"), ("label", "talk"), ("dialogue", None, "Talk.")]
    line = parsed.events[3]
    assert line.source == "game/x.rpy:5"
    assert line.from_strings
    assert not parsed.events[6].from_strings
    assert parsed.menus == []
    assert parsed.reports == []


def test_dollar_lines_in_the_block_read_as_label_flow() -> None:
    text = ('label start:\n'
            '    "Lead."\n'
            '    menu:\n'
            '        "Only":\n'
            '            $ met = True\n'
            '            $ renpy.jump("later")\n'
            'label later:\n'
            '    "Later."\n')
    parsed = parse_file(text, "game/x.rpy")
    assert story(parsed) == [
        ("label", "start"), ("dialogue", None, "Lead."),
        ("dialogue", None, "Only"), ("jump", "later"),
        ("label", "later"), ("dialogue", None, "Later.")]
    assert parsed.reports == []
    assert ("met", "start", "True") in parsed.assignments


def test_a_caption_is_said_before_the_choice() -> None:
    text = ('label start:\n'
            '    "Lead."\n'
            '    menu:\n'
            '        "She waits for an answer."\n'
            '        "Tell her":\n'
            '            "You tell her."\n'
            '    "After."\n')
    parsed = parse_file(text, "game/x.rpy")
    assert [(e.text, e.from_strings) for e in parsed.events
            if e.kind == "dialogue"] == [
        ("Lead.", False), ("She waits for an answer.", True),
        ("Tell her", True), ("You tell her.", False), ("After.", False)]
    assert parsed.menus == []


def test_a_named_one_choice_menu_still_makes_its_label() -> None:
    parsed = parse_file('label start:\n'
                        '    "Lead."\n'
                        '    menu ask:\n'
                        '        "Only":\n'
                        '            "Body."\n', "game/x.rpy")
    assert story(parsed)[2:] == [("label", "ask"),
                                 ("dialogue", None, "Only"),
                                 ("dialogue", None, "Body.")]


def test_a_conditional_one_choice_menu_stays_linear() -> None:
    """No line of its choice text; its block is walked as a choice's is,
    its lines kept in a row (Phase 60 item 9o, test_menu_shapes.py), and
    the timeline reports it."""
    parsed = parse_file('label start:\n'
                        '    "Lead."\n'
                        '    menu:\n'
                        '        "Only" if met:\n'
                        '            "Body."\n'
                        '    "After."\n', "game/x.rpy")
    assert parsed.menus[0].parse_reason == "fewer than two choices"
    assert [e.text for e in parsed.events if e.kind == "dialogue"] == [
        "Lead.", "After."]
    (fork,) = [e for e in parsed.events if e.kind == "fork"]
    assert [[e.text for e in body] for body in fork.flow.bodies] == [
        ["Body."]]


def test_the_walk_follows_the_blocks_jump(tmp_path: Path) -> None:
    game = tmp_path / "game"
    game.mkdir()
    (game / "script.rpy").write_text(
        'label start:\n'
        '    "Forget it."\n'
        '    menu:\n'
        '        "Wait!":\n'
        '            jump talk\n'
        '    "Never reached."\n'
        'label talk:\n'
        '    "Talk."\n', encoding="utf-8")
    parses, defs, chars, _sources = parse_project(game)
    items = build_timeline(parses, defs, chars, game).items
    assert [r.item.get("text") for r in items] == [
        "Forget it.", "Wait!", "Talk."]


# --- extract -----------------------------------------------------------------

def ident(label: str, code: str) -> str:
    """Ren'Py's identifier of a say statement: the label, `_` and the
    first 8 hex digits of the MD5 of its code and CRLF."""
    digest = hashlib.md5((code + "\r\n").encode("utf-8")).hexdigest()
    return f"{label}_{digest[:8]}"


def sha8(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]


SCRIPT = ('define config.name = "Choices"\n'               # 1
          'define a = Character("Robin")\n'           # 2
          'label start:\n'                                # 3
          '    scene bg\n'                                # 4
          '    a "Leave it, then..."\n'                   # 5
          '    menu:\n'                                   # 6
          '        "Wait, Robin, hear me out!":\n'   # 7
          '            jump talk\n'                       # 8
          'label talk:\n'                                 # 9
          '    a "Fine. Talk."\n'                         # 10
          '    menu:\n'                                   # 11
          '        "She waits."\n'                        # 12
          '        "Tell her everything":\n'              # 13
          '            "You tell her."\n'                 # 14
          '    return\n')                                 # 15

FORGET = ident("start", 'a "Leave it, then..."')
FINE = ident("talk", 'a "Fine. Talk."')
TELL = ident("talk", '"You tell her."')
TL_DE = (f'translate de {FORGET}:\n'
         '    a "Dann lass es eben..."\n\n'
         f'translate de {FINE}:\n'
         '    a "Gut. Rede."\n\n'
         f'translate de {TELL}:\n'
         '    "Du erzählst."\n\n'
         'translate de strings:\n'
         '    old "Choices"\n    new "Entscheidungen"\n'
         '    old "Robin"\n    new "Robin"\n'
         '    old "Wait, Robin, hear me out!"\n'
         '    new "Warte, Robin, hör zu!"\n'
         '    old "She waits."\n    new "Sie wartet."\n'
         '    old "Tell her everything"\n    new "Erzähl ihr alles"\n')


def test_extract_keeps_the_line_and_its_translation(tmp_path: Path) -> None:
    game = tmp_path / "proj" / "game"
    (game / "images").mkdir(parents=True)
    Image.new("RGB", (32, 18), (40, 60, 80)).save(game / "images" / "bg.png")
    (game / "script.rpy").write_text(SCRIPT, encoding="utf-8")
    (game / "tl" / "de").mkdir(parents=True)
    (game / "tl" / "de" / "script.rpy").write_text(TL_DE, encoding="utf-8")
    out = tmp_path / "out"
    with redirect_stdout(StringIO()):
        assert cli_main([str(game.parent), str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    items = [(i["id"], i.get("speaker"), i.get("text"))
             for i in manifest["items"]]
    assert items == [
        ("bg-001", "Robin", "Leave it, then..."),
        ("line-002", None, "Wait, Robin, hear me out!"),
        ("line-003", "Robin", "Fine. Talk."),
        ("line-004", None, "She waits."),
        ("line-005", None, "Tell her everything"),
        ("line-006", None, "You tell her.")]
    assert "branches" not in manifest or manifest["branches"] == []
    de = json.loads((out / "lang" / "de.json").read_text("utf-8"))
    assert {k: v["text"] for k, v in de["items"].items()} == {
        "bg-001": "Dann lass es eben...",
        "line-002": "Warte, Robin, hör zu!",
        "line-003": "Gut. Rede.",
        "line-004": "Sie wartet.",
        "line-005": "Erzähl ihr alles",
        "line-006": "Du erzählst."}
    assert de["items"]["line-002"]["from"] == sha8(
        "Wait, Robin, hear me out!")
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    assert not any("menu unsupported" in r["reason"]
                   for r in ledger["report"])
    stats = ledger["translations"]["languages"]["de"]
    # Every pair: the title, the speaker and the three menu texts; the
    # title, the speaker and the six lines translated of eight strings.
    assert (stats["strings_used"], stats["string_pairs"]) == (5, 5)
    assert (stats["done"], stats["total"]) == (8, 8)
    proc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "validate_content.py"),
         str(out), "--strict"], capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout == "" and proc.stderr == ""
