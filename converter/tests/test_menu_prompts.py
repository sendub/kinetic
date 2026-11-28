"""Menu prompts in the game's languages, and the line before a decision
(docs/plan.md Phase 60 item 9o3).

A say menuitem (`e "Which one?"` as a menu's first statement) is a say
statement of its own in Ren'Py, with a translate identifier as any say
statement's (its code ends `nointeract`): its translation is in the
language's dialogue blocks, not in `translate <lang> strings`, so a
decision's prompt made from one is translated from those blocks. A menu
with no caption gets the converter's words for its prompt, "What happens
next?", in the base language and in each language file in that
language's words. The line item 9o2 puts before a chain met straight
after another decision's join says "Another choice follows." only where
the player shows a choice: a chain following an earlier decision, whose
route the player takes by the pick there, gets its own words, and a
menu with no caption that stays linear straight after a join gets no
line (the decision goes on into its first line).

Each case is a synthetic project with a German language file that
translates every line, name and choice (`translated`, so that `kinetic
validate --strict` has nothing to warn of), extracted end to end:
`kinetic validate --strict` prints nothing, `kinetic check --steps all`
walks to the story's end, and so does `kinetic check --lang de`.
"""

from __future__ import annotations

import hashlib
import json
import re
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

import pytest
from PIL import Image

from kinetic_extract import conditions, translations
from kinetic_extract.cli import main as cli_main

from test_jump_menus import (LEAD, check_folder, detection, run_kinetic,
                             shape, texts)

NEXT = conditions.Words("en").say("menu.next")
FOLLOWS = conditions.Words("en").say("menu.follows")
PROMPT = conditions.Words("en").say("menu.prompt")
DE = conditions.Words("de")
DRINKS = [("Tea", "You drink tea.", "You drink tea.", "continue"),
          ("Coffee", "You drink coffee.", "You drink coffee.", "continue")]
MENU = ('    menu:\n'
        '        "Tea":\n            "You drink tea."\n'
        '        "Coffee":\n            "You drink coffee."\n')


def ident(label: str, code: str) -> str:
    """Ren'Py's identifier of a say statement (as test_jump_menus)."""
    digest = hashlib.md5((code + "\r\n").encode("utf-8")).hexdigest()
    return f"{label}_{digest[:8]}"


# A choice line, `"Tea":` or `"North" if seen:`, and a menu's caption.
_CHOICE_RE = re.compile(r'^\s+"([^"]+)"(?: if [^:]+)?:\s*$')
_CAPTION_RE = re.compile(r'^\s+menu "([^"]+)":\s*$')


def translated(script: str, tag: str = "de", own: str = "") -> str:
    """A `tl/` file for ``script`` translating every say statement but a
    say menuitem (its block is the test's own, in ``own``), every choice,
    caption and speaker's name and the title (the project's folder name,
    `proj`), each as its text in capitals (the same length, so the
    validator's length warnings stay quiet). The say statements'
    identifiers are the converter's own (translations.source_groups):
    they are not what the tests check."""
    lines = script.split("\n")
    out = own
    for group in translations.source_groups([("game/script.rpy", script)]):
        code = group.codes[-1]
        if group.say_line is None or code.endswith(" nointeract"):
            continue
        start = code.index('"')
        out += (f"translate {tag} {group.identifier}:\n"
                f"    {code[:start]}{code[start:].upper()}\n\n")
    names = ["proj"] + re.findall(r'Character\("([^"]+)"\)', script)
    for line in lines:
        m = _CHOICE_RE.match(line) or _CAPTION_RE.match(line)
        if m is not None:
            names.append(m[1])
    out += f"translate {tag} strings:\n"
    for name in dict.fromkeys(names):
        out += f'    old "{name}"\n    new "{name.upper()}"\n'
    return out


def extract(tmp_path: Path, script: str, *args: str, tag: str = "de",
            own: str = "") -> tuple[Path, dict, dict]:
    """Extract ``script`` with its `tl/<tag>/` file (translated) and the
    command-line ``args``."""
    game = tmp_path / "proj" / "game"
    (game / "images").mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 18), (40, 60, 80)).save(game / "images" / "bg.png")
    (game / "script.rpy").write_text(script, encoding="utf-8")
    (game / "tl" / tag).mkdir(parents=True)
    (game / "tl" / tag / "script.rpy").write_text(
        translated(script, tag, own), encoding="utf-8")
    out = tmp_path / "out"
    with redirect_stdout(StringIO()):
        assert cli_main([str(game.parent), str(out), *args]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    return out, manifest, ledger


def lang(out: Path, tag: str) -> dict:
    return json.loads((out / "lang" / f"{tag}.json").read_text("utf-8"))


def check(tmp_path: Path, out: Path, manifest: dict, tag: str = "de"
          ) -> None:
    """check_folder's checks, then the walk again in language ``tag``."""
    check_folder(tmp_path, out, manifest)
    proc = run_kinetic("check", str(tmp_path / "play"), "--steps", "all",
                       "--no-media-check", "--lang", tag)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "story ended" in proc.stdout


def prompts(out: Path, manifest: dict, tag: str) -> list[str | None]:
    """Each decision's prompt in language ``tag``'s file, None for none."""
    decisions = lang(out, tag).get("decisions", {})
    return [decisions.get(b["id"], {}).get("prompt", {}).get("text")
            for b in manifest["branches"]]


def line_text(out: Path, manifest: dict, tag: str, text: str) -> str:
    """Language ``tag``'s text of the base line ``text``."""
    item = next(i for i in manifest["items"] if i.get("text") == text)
    return lang(out, tag)["items"][item["id"]]["text"]


# --- 1. a say menuitem's prompt ----------------------------------------------

WHO = 'define e = Character("Eve")\n'
SAY_MENU = ('    menu:\n'
            '        e "Which one?"\n'
            '        "Tea":\n            "You drink tea."\n'
            '        "Coffee":\n            "You drink coffee."\n')
# Ren'Py's dialogue block for the say menuitem: its code ends
# `nointeract`, as Say.get_code writes a say statement that does not
# interact. The `strings` entry of the same text is not Ren'Py's
# translation of it (a say menuitem is no menu string), so it is not
# taken.
SAY_OWN = (f'translate de {ident("start", 'e "Which one?" nointeract')}:\n'
           '    e "Welches?" nointeract\n\n'
           'translate de strings:\n'
           '    old "Which one?"\n    new "Falsch?"\n\n')


def test_a_say_menuitem_prompt_is_translated_as_its_say_statement(
        tmp_path: Path) -> None:
    out, manifest, _ledger = extract(
        tmp_path, WHO + LEAD + SAY_MENU + '    "After."\n    return\n',
        own=SAY_OWN)
    assert shape(manifest) == [{"after": "Lead.", "routes": DRINKS,
                                "continuing": "Coffee",
                                "continueAt": "After."}]
    assert manifest["branches"][0]["prompt"] == "Which one?"
    assert prompts(out, manifest, "de") == ["Welches?"]
    route = manifest["branches"][0]["routes"][0]["id"]
    assert lang(out, "de")["decisions"][manifest["branches"][0]["id"]][
        "routes"][route]["text"] == "TEA"
    check(tmp_path, out, manifest)


def test_a_say_menuitem_line_after_a_join_and_its_prompt(tmp_path: Path
                                                         ) -> None:
    """Straight after another decision's join the say menuitem is also
    the line both decisions hang off (item 9o): the line and the prompt
    are translated from the same dialogue block."""
    script = (WHO + LEAD + '    call drinks\n' +
              SAY_MENU.replace('"Tea"', '"Tea again"')
              .replace('"Coffee"', '"Coffee again"')
              + '    "After."\n    return\n'
              'label drinks:\n'
              '    menu:\n'
              '        "Rest":\n            "You rest."\n'
              '        "Wait":\n            "You wait."\n'
              '    return\n')
    out, manifest, _ledger = extract(tmp_path, script, own=SAY_OWN)
    assert texts(manifest)[3] == "Which one?"
    decisions = shape(manifest)
    assert decisions[0]["continueAt"] == "Which one?"
    assert decisions[1]["after"] == "Which one?"
    assert line_text(out, manifest, "de", "Which one?") == "Welches?"
    assert prompts(out, manifest, "de") == [DE.say("menu.prompt"),
                                            "Welches?"]
    check(tmp_path, out, manifest)


# --- 2. the default prompt -----------------------------------------------------

def test_a_default_prompt_is_in_each_language(tmp_path: Path) -> None:
    out, manifest, ledger = extract(
        tmp_path, LEAD + MENU + '    "After."\n    return\n')
    assert manifest["branches"][0]["prompt"] == PROMPT == "What happens next?"
    assert prompts(out, manifest, "de") == [DE.say("menu.prompt")]
    assert DE.say("menu.prompt") not in ("", PROMPT)
    assert "prompt defaulted (menu has no caption)" in detection(ledger)[0][
        "note"]
    check(tmp_path, out, manifest)


def test_a_default_prompt_in_a_german_game(tmp_path: Path) -> None:
    """A game whose base language is German: its default prompt is the
    German words, its English file's the English."""
    out, manifest, _ledger = extract(
        tmp_path, LEAD + MENU + '    "After."\n    return\n',
        "--base-language", "de", tag="english")
    assert manifest["branches"][0]["prompt"] == DE.say("menu.prompt")
    assert prompts(out, manifest, "en") == [PROMPT]
    check(tmp_path, out, manifest, "en")


# --- 3. the line before a following chain -------------------------------------

CHOOSE = ('label drinks:\n'
          '    menu:\n'
          '        "Tea":\n'
          '            $ drink = "tea"\n            "You drink tea."\n'
          '        "Coffee":\n'
          '            $ drink = "coffee"\n            "You drink coffee."\n'
          '    return\n')
FOLLOWING = ('    if drink == "tea":\n        "Tea was nice."\n'
             '    else:\n        "Coffee was strong."\n')
# The story's last line, longer than a language's words for the line
# before a decision, so that the validator does not warn that line runs
# past the game's longest.
LONG = "The story ends here, on a line longer than any the converter adds."
END = '    "After."\n    "' + LONG + '"\n    return\n'


def test_a_following_chain_past_a_return_gets_its_own_line(tmp_path: Path
                                                           ) -> None:
    """The chain on what the called menu's choices set follows that
    decision: the player takes its route by the pick there and shows no
    choice, so its line says the earlier choice decides what follows."""
    out, manifest, ledger = extract(
        tmp_path, 'default drink = ""\n' + LEAD + '    call drinks\n'
        + FOLLOWING + END + CHOOSE)
    assert texts(manifest) == ["Lead.", "You drink tea.",
                               "You drink coffee.", FOLLOWS,
                               "Tea was nice.", "Coffee was strong.",
                               "After.", LONG]
    assert NEXT not in texts(manifest)
    first, chain = manifest["branches"]
    assert chain["follows"] == first["id"]
    decisions = shape(manifest)
    assert decisions[0]["continueAt"] == FOLLOWS
    assert decisions[1]["after"] == FOLLOWS
    assert line_text(out, manifest, "de", FOLLOWS) == DE.say("menu.follows")
    assert ("follows another decision's join, past a return or an if that "
            "shows nothing, with no line between: a line before it, the "
            "converter's words" in next(
                n["note"] for n in detection(ledger)
                if n["note"].startswith(f"decision {chain['id']}")))
    check(tmp_path, out, manifest)


def test_a_following_chain_past_an_if_that_shows_nothing(tmp_path: Path
                                                         ) -> None:
    out, manifest, _ledger = extract(
        tmp_path, 'default drink = ""\ndefault calm = 0\n' + LEAD
        + CHOOSE.split("\n", 1)[1].replace("    return\n", "")
        + '    if calm:\n        $ calm = 2\n' + FOLLOWING + END)
    assert texts(manifest)[3] == FOLLOWS
    first, chain = manifest["branches"]
    assert chain["follows"] == first["id"]
    assert shape(manifest)[0]["continueAt"] == FOLLOWS
    check(tmp_path, out, manifest)


def test_an_ordinary_chain_past_a_return_keeps_its_line(tmp_path: Path
                                                        ) -> None:
    """A chain on a counter is an ordinary decision, which the player
    shows as a choice: "Another choice follows." stays."""
    out, manifest, _ledger = extract(
        tmp_path, 'default points = 0\n' + LEAD + '    call drinks\n'
        '    if points > 1:\n        "Strong."\n'
        '    else:\n        "Weak."\n'
        + END + CHOOSE.replace('$ drink = "tea"', '$ points += 2')
        .replace('$ drink = "coffee"', '$ points += 1'))
    assert texts(manifest)[3] == NEXT
    assert "follows" not in manifest["branches"][1]
    assert line_text(out, manifest, "de", NEXT) == DE.say("menu.next")
    check(tmp_path, out, manifest)


# --- 3. a menu kept linear straight after a join -------------------------------

LINEAR = {
    # One conditional choice: `fewer than two choices`.
    "lone": ('default seen = False\n', '    menu:\n'
             '        "North" if seen:\n            "North."\n'
             '    "After."\n    return\n', "North."),
    # A statement the menu reader does not take between its choices.
    "unsupported": ('', '    menu:\n'
                    '        "Up":\n            "You go up."\n'
                    '        show bg\n'
                    '        "Down":\n            "You go down."\n'
                    '    "After."\n    return\n', "You go up."),
    # A choice rejoining content another choice reads (`lost` is set
    # nowhere, so its `if` is read as either way).
    "rejoin": ('', '    menu:\n'
               '        "Hall":\n            jump hall\n'
               '        "Stairs":\n            "Up the stairs."\n'
               '            if lost:\n                jump hall_end\n'
               '            jump end\n'
               'label hall:\n    "The hall."\n'
               'label hall_end:\n    "The end of the hall."\n'
               '    jump end\n'
               'label end:\n    "The end."\n    return\n', "The hall."),
}


@pytest.mark.parametrize("name", sorted(LINEAR))
def test_a_linear_menu_after_a_join_gets_no_line(tmp_path: Path,
                                                 name: str) -> None:
    """The menu offers no choice, so no line says one follows: the
    decision before it goes on at its first line, as its lines are read
    in a row (held, as a linear menu past a `return` holds one)."""
    defaults, linear, first = LINEAR[name]
    out, manifest, ledger = extract(tmp_path, defaults + LEAD + MENU + linear)
    assert NEXT not in texts(manifest)
    assert texts(manifest)[:4] == ["Lead.", "You drink tea.",
                                   "You drink coffee.", first]
    assert shape(manifest) == [{"after": "Lead.", "routes": DRINKS,
                                "continuing": "Coffee", "continueAt": first}]
    note = detection(ledger)[0]["note"]
    assert "which stays linear, so it continues at" in note
    assert [n["result"] for n in detection(ledger)] == ["detected",
                                                        "skipped"]
    check(tmp_path, out, manifest)


def test_a_linear_menu_with_a_caption_after_a_join_keeps_it(tmp_path: Path
                                                            ) -> None:
    """A caption is the game's own line, which Ren'Py shows: it stays the
    line the decision goes on at."""
    _defaults, linear, _first = LINEAR["lone"]
    out, manifest, _ledger = extract(
        tmp_path, 'default seen = False\n' + LEAD + MENU
        + linear.replace("menu:", 'menu "Where now?":'))
    assert texts(manifest)[3:5] == ["Where now?", "North."]
    assert shape(manifest)[0]["continueAt"] == "Where now?"
    check(tmp_path, out, manifest)


def test_a_linear_menu_that_shows_nothing_keeps_the_line(tmp_path: Path
                                                         ) -> None:
    """Guard: a linear menu whose choices go to content read elsewhere
    lays out no line of its own, so the decision before it would have
    nothing to go on at: it keeps the converter's line there, as before,
    rather than becoming a pure choice."""
    out, manifest, ledger = extract(tmp_path, (
        'default seen = False\n' + LEAD + '    call fin_text\n'
        'label hub:\n    "' + LONG + '"\n' + MENU +
        '    menu:\n'
        '        "Hear it again" if seen:\n            jump fin_text\n'
        '        "Go back":\n            jump hub\n'
        'label fin_text:\n    "Fin."\n    return\n'))
    assert texts(manifest) == ["Lead.", "Fin.", LONG, "You drink tea.",
                               "You drink coffee.", NEXT]
    assert shape(manifest) == [{"after": LONG, "routes": DRINKS,
                                "continuing": "Coffee", "continueAt": NEXT}]
    assert detection(ledger)[1]["result"] == "skipped"
    check(tmp_path, out, manifest)
