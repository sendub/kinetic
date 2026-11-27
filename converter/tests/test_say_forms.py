"""Say statements as Ren'Py reads them (docs/plan.md Phase 60 item 9m;
docs/extracting.md, "Say statements").

Ren'Py's say statement is a lone string, or a speaker, image attributes,
`@` and temporary attributes, then a string. The speaker is a Python
name, a dotted name or a string. A string may run over several physical
lines: inside it a line break and the spaces around it are one space, and
a triple-quoted string is one line per paragraph (monologue mode). A
newline inside brackets continues the line too, so a test may run on.

- `e happy "..."` is e's line. When e's Character names an image tag
  (`image="e"`) and the picture on screen has that tag, the attributes
  change it as `show e happy` would; `@` attributes last for the one line.
  Otherwise the line is kept, its attributes noted as ignored.
- `c.name "..."` resolves `define c.name = Character(...)` or a Character
  made in `init python in c:`; another dotted speaker is kept as written,
  noted.
- `"Name" "text"` is a line said by Name.
- `call x()` with its `from` clause on the next line is one call.
- `if(x == 1):` and a test over several lines are `if` statements.

Phase 60 item 9m2:

- A line by a nameless Character (`Character(None, ...)`, `name=None`,
  one whose `kind=` is nameless, Ren'Py's own `narrator` and `centered`)
  is narration, as Ren'Py shows it; its `what_color` is noted as not
  carried, since narration is never coloured.
- Each paragraph of a triple-quoted string has its own say statement,
  so its own `translate` block, and its item takes that block's text.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

from kinetic_extract.parser import parse_file

from test_jump_menus import (REPO_ROOT, check_folder, extract, run_kinetic,
                             texts)
from test_renpy_translations import ident, lang_file


def dialogue(script: str) -> list[tuple[str | None, str]]:
    """(speaker, text) of each dialogue event parse_file reads, in order,
    choice blocks included."""
    parsed = parse_file(script, "game/script.rpy")
    out: list[tuple[str | None, str]] = []

    def walk(events) -> None:
        for e in events:
            if e.kind == "dialogue":
                out.append((e.speaker, e.text))
            if e.flow is not None:
                for body in e.flow.bodies:
                    walk(body)
    walk(parsed.events)
    return out


def reasons(script: str) -> list[str]:
    return [r.reason for r in parse_file(script, "game/script.rpy").reports]


def events_of(script: str) -> list:
    return parse_file(script, "game/script.rpy").events


# --------------------------------------------------------------------------
# The parser
# --------------------------------------------------------------------------

@pytest.mark.parametrize(("line", "attributes", "temporary"), [
    ('e happy "Hello."', ("happy",), ()),
    ('e happy smile "Hello."', ("happy", "smile"), ()),
    ('e -happy "Hello."', ("-happy",), ()),
    ('e @ sad "Hello."', (), ("sad",)),
    ('e happy @ sad "Hello."', ("happy",), ("sad",)),
    ('e happy "Hello." with dissolve', ("happy",), ()),
])
def test_a_speaker_with_image_attributes_is_the_speakers_line(
        line: str, attributes: tuple, temporary: tuple) -> None:
    script = f'label start:\n    {line}\n    return\n'
    (event,) = [e for e in events_of(script) if e.kind == "dialogue"]
    assert (event.speaker, event.text) == ("e", "Hello.")
    assert event.attributes == attributes
    assert event.temporary == temporary
    assert reasons(script) == []


def test_a_dotted_speaker_is_the_speakers_line() -> None:
    script = 'label start:\n    c.name "Hello."\n    return\n'
    assert dialogue(script) == [("c.name", "Hello.")]
    assert reasons(script) == []


def test_two_strings_are_a_line_said_by_the_first() -> None:
    script = 'label start:\n    "Ann" "Hello there."\n    return\n'
    (event,) = [e for e in events_of(script) if e.kind == "dialogue"]
    assert (event.speaker, event.text) == ("Ann", "Hello there.")
    assert event.speaker_named
    assert reasons(script) == []


def test_single_quoted_and_backquoted_lines() -> None:
    script = ("label start:\n    e 'It is fine.'\n    'A quiet room.'\n"
              "    e `Back again.`\n    return\n")
    assert dialogue(script) == [("e", "It is fine."), (None, "A quiet room."),
                                ("e", "Back again.")]


def test_keyword_statements_are_never_says() -> None:
    """A statement keyword before a string is that statement, not a
    speaker with attributes."""
    script = ('style say_label color "#fff"\n'
              'label start:\n    "Line."\n    return\n')
    assert dialogue(script) == [(None, "Line.")]


SPREAD = ('label start:\n'
          '    e "The road is long and\n'
          '    return soon, they said, or\n'
          '       jump the fence."\n'
          '    "After."\n'
          '    return\n')


def test_a_line_over_several_physical_lines_is_one_line() -> None:
    """A continuation line starting `return` or `jump` is text, not a
    statement: the label goes on."""
    assert dialogue(SPREAD) == [
        ("e", "The road is long and return soon, they said, or jump the "
              "fence."),
        (None, "After.")]
    events = events_of(SPREAD)
    assert [e.kind for e in events if e.kind in ("return", "jump")] == [
        "return"]
    assert reasons(SPREAD) == []
    # The line is named by its first physical line, as Ren'Py names it.
    (said, _after) = [e for e in events if e.kind == "dialogue"]
    assert said.source == "game/script.rpy:2"


def test_narration_spread_over_lines_and_blank_lines() -> None:
    script = ('label start:\n'
              '    "One part,\n'
              '\n'
              '      and the other."\n'
              '    "Next."\n')
    assert dialogue(script) == [(None, "One part, and the other."),
                                (None, "Next.")]


def test_a_menu_caption_and_choices_over_several_lines() -> None:
    script = ('label start:\n'
              '    scene bg\n'
              '    "Lead."\n'
              '    menu:\n'
              '        "Which way\n'
              '         now?"\n'
              '        "The left\n'
              '         road":\n'
              '            "Left."\n'
              '        "The right road":\n'
              '            "Right."\n'
              '    return\n')
    parsed = parse_file(script, "game/script.rpy")
    (menu,) = parsed.menus
    assert menu.skip_reason is None
    assert menu.prompt == "Which way now?"
    assert menu.choices == ["The left road", "The right road"]


def test_a_triple_quoted_string_is_one_line_per_paragraph() -> None:
    script = ('label start:\n'
              '    e """\n'
              '    The first paragraph\n'
              '    runs on.\n'
              '\n'
              '    The second one.\n'
              '    """\n'
              '    "After."\n')
    assert dialogue(script) == [("e", "The first paragraph runs on."),
                                ("e", "The second one."),
                                (None, "After.")]


def test_a_call_with_its_from_clause_on_the_next_line() -> None:
    script = ('label start:\n'
              '    call scene_a()\n'
              ' from _call_scene_a\n'
              '    "Back."\n'
              '    return\n'
              'label scene_a:\n    "In the scene."\n    return\n')
    calls = [e for e in events_of(script) if e.kind == "call"]
    assert [c.flow.target for c in calls] == ["scene_a"]
    assert reasons(script) == []


SETS = ('label start:\n'
        '    scene bg\n'
        '    "Lead."\n'
        '    menu:\n'
        '        "One":\n'
        '            $ x = 1\n'
        '            "You pick one."\n'
        '        "Two":\n'
        '            $ x = 2\n'
        '            "You pick two."\n')


@pytest.mark.parametrize("head", [
    "    if(x == 1):\n",
    "    if (x ==\n            1):\n",
])
def test_a_parenthesised_test(head: str) -> None:
    script = SETS + head + ('        "Was one."\n    else:\n'
                            '        "Was not."\n    return\n')
    parsed = parse_file(script, "game/script.rpy")
    assert not [r for r in parsed.reports
                if r.reason.startswith("unrecognized statement")]
    assert any(r.condition is not None for r in parsed.menus)


# --------------------------------------------------------------------------
# End to end
# --------------------------------------------------------------------------

def picture(game: Path, name: str, rgb: tuple[int, int, int]) -> None:
    (game / "images").mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 18), rgb).save(game / "images" / f"{name}.png")


def run(tmp_path: Path, script: str) -> tuple[Path, dict, dict]:
    game = tmp_path / "proj" / "game"
    picture(game, "eve calm", (10, 20, 30))
    picture(game, "eve happy", (200, 20, 30))
    picture(game, "eve sad", (10, 200, 30))
    return extract(tmp_path, script)


def assets(manifest: dict, ledger: dict) -> list[str | None]:
    """The picture each item shows: its own asset, or for a text item the
    nearest earlier media item's (array order)."""
    out, last = [], None
    for item in manifest["items"]:
        entry = ledger["items"][item["id"]]
        if item["type"] != "text":
            last = Path(entry["asset"]).stem
        out.append(last)
    return out


def notes_of(manifest: dict, ledger: dict, text: str) -> list[str]:
    """The ledger notes of the item showing ``text``."""
    (item,) = [i for i in manifest["items"] if i.get("text") == text]
    return ledger["items"][item["id"]]["notes"]


ATTRS = ('define e = Character("Eve", image="eve")\n'
         'label start:\n'
         '    scene bg\n'
         '    "Lead."\n'
         '    show eve calm\n'
         '    e "Calm first."\n'
         '    e happy "Now happy."\n'
         '    e "Still happy."\n'
         '    e @ sad "Sad for a moment."\n'
         '    e "Happy again."\n'
         '    "The end."\n'
         '    return\n')


def test_image_attributes_change_the_speakers_picture(tmp_path: Path
                                                      ) -> None:
    out, manifest, ledger = run(tmp_path, ATTRS)
    assert texts(manifest) == ["Lead.", "Calm first.", "Now happy.",
                               "Still happy.", "Sad for a moment.",
                               "Happy again.", "The end."]
    assert [i.get("speaker") for i in manifest["items"]] == [
        None, "Eve", "Eve", "Eve", "Eve", "Eve", None]
    assert assets(manifest, ledger) == ["bg", "eve calm", "eve happy",
                                        "eve happy", "eve sad", "eve happy",
                                        "eve happy"]
    check_folder(tmp_path, out, manifest)


def test_attributes_pick_among_image_definitions(tmp_path: Path) -> None:
    """With `image` definitions, the attributes kept from the shown
    picture count, as Ren'Py's choose_image picks: `casual` stays."""
    out, manifest, ledger = run(tmp_path, (
        'define base = Character("Eve", image="eve")\n'
        'define e = Character(kind=base)\n'
        'image eve casual calm = "eve calm.png"\n'
        'image eve casual happy = "eve happy.png"\n'
        'image eve formal happy = "eve sad.png"\n'
        'label start:\n    show eve casual calm\n    e "Calm."\n'
        '    e happy "Happy."\n    return\n'))
    assert texts(manifest) == ["Calm.", "Happy."]
    assert [i.get("speaker") for i in manifest["items"]] == ["Eve", "Eve"]
    assert assets(manifest, ledger) == ["eve calm", "eve happy"]


def test_attributes_on_a_picture_without_the_tag_change_nothing(
        tmp_path: Path) -> None:
    """Ren'Py shows the attributes only when an image with the tag is on
    screen."""
    out, manifest, ledger = run(tmp_path, (
        'define e = Character("Eve", image="eve")\n'
        'label start:\n    scene bg\n    e happy "Hello."\n    return\n'))
    assert texts(manifest) == ["Hello."]
    assert assets(manifest, ledger) == ["bg"]


def test_attributes_of_a_speaker_with_no_image_are_ignored_and_noted(
        tmp_path: Path) -> None:
    script = ('define e = Character("Eve")\n'
              'label start:\n    show eve calm\n    e happy "Hello."\n'
              '    p sad "Hi."\n    return\n')
    out, manifest, ledger = run(tmp_path, script)
    assert texts(manifest) == ["Hello.", "Hi."]
    assert [i.get("speaker") for i in manifest["items"]] == ["Eve", "p"]
    assert assets(manifest, ledger) == ["eve calm", "eve calm"]
    for text in ("Hello.", "Hi."):
        assert any("image attributes" in n and "ignored" in n
                   for n in notes_of(manifest, ledger, text)), text


def test_dotted_speakers(tmp_path: Path) -> None:
    script = ('define c.ann = Character("Ann")\n'
              'define character.cy = Character("Cy")\n'
              'init python in cast:\n'
              '    bo = Character("Bo")\n'
              'label start:\n    scene bg\n'
              '    c.ann "From Ann."\n'
              '    cast.bo "From Bo."\n'
              '    cy "From Cy."\n'
              '    p.t "From someone."\n'
              '    return\n')
    out, manifest, ledger = run(tmp_path, script)
    assert [(i.get("speaker"), i.get("text")) for i in manifest["items"]] \
        == [("Ann", "From Ann."), ("Bo", "From Bo."), ("Cy", "From Cy."),
            ("p.t", "From someone.")]
    assert any("dotted speaker" in n
               for n in notes_of(manifest, ledger, "From someone."))


def test_two_strings_end_to_end(tmp_path: Path) -> None:
    out, manifest, _ledger = run(tmp_path, (
        'define e = Character("Eve")\n'
        'label start:\n    scene bg\n    "e" "A stranger called e."\n'
        '    "Ann" "Hello there."\n    return\n'))
    assert [(i.get("speaker"), i.get("text")) for i in manifest["items"]] \
        == [("e", "A stranger called e."), ("Ann", "Hello there.")]


def test_a_spread_line_keeps_the_label_going(tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'label start:\n    scene bg\n' + SPREAD.split("\n", 1)[1]
        .replace("    return\n", "    call more()\n from _call_more\n"
                 "    return\n", 1)
        + 'label more:\n    "More."\n    return\n'))
    assert texts(manifest)[:2] == [
        "The road is long and return soon, they said, or jump the fence.",
        "After."]
    assert not [r for r in ledger["report"]
                if r["reason"].startswith("unrecognized statement")]
    check_folder(tmp_path, out, manifest)


# --------------------------------------------------------------------------
# Nameless speakers (item 9m2)
# --------------------------------------------------------------------------

def said(manifest: dict) -> list[tuple[str | None, str | None]]:
    return [(i.get("speaker"), i.get("text")) for i in manifest["items"]]


@pytest.mark.parametrize("define", [
    'define n = Character(None)',
    'define n = Character(None, what_color="#ccddee")',
    'define n = Character(name=None, what_italic=True)',
    'define n = NVLCharacter(None, kind=nvl)',
    'define base = Character(None)\ndefine n = Character(kind=base)',
    'define base = Character(None)\n'
    'define mid = Character(kind=base, what_color="#ccddee")\n'
    'define n = Character(kind=mid)',
    'define n = Character(kind=nvl)',
    'define n = Character(what_color="#ccddee")',
    'define character.n = Character(None)',
    'init python:\n    n = Character(None)',
    'define n = Character("Nell")\ndefine n = Character(None)',
])
def test_a_nameless_characters_line_is_narration(tmp_path: Path,
                                                 define: str) -> None:
    out, manifest, ledger = run(tmp_path, (
        define + '\n'
        'define e = Character("Eve")\n'
        'label start:\n    scene bg\n'
        '    n "A thought in the dark."\n'
        '    e "Eve speaks."\n'
        '    return\n'))
    assert said(manifest) == [(None, "A thought in the dark."),
                              ("Eve", "Eve speaks.")]
    assert any("nameless" in n for n in
               notes_of(manifest, ledger, "A thought in the dark."))
    check_folder(tmp_path, out, manifest)


def test_a_dotted_nameless_speaker_is_narration(tmp_path: Path) -> None:
    out, manifest, _ledger = run(tmp_path, (
        'define c.n = Character(None)\n'
        'init python in cast:\n    t = Character(None)\n'
        'label start:\n    scene bg\n'
        '    c.n "One thought."\n    cast.t "Another."\n    return\n'))
    assert said(manifest) == [(None, "One thought."), (None, "Another.")]


def test_ren_pys_own_nameless_characters_are_narration(tmp_path: Path
                                                       ) -> None:
    out, manifest, _ledger = run(tmp_path, (
        'label start:\n    scene bg\n'
        '    narrator "Said by the narrator."\n'
        '    centered "In the middle."\n'
        '    return\n'))
    assert said(manifest) == [(None, "Said by the narrator."),
                              (None, "In the middle.")]


def test_a_games_own_named_narrator_keeps_its_name(tmp_path: Path) -> None:
    out, manifest, _ledger = run(tmp_path, (
        'define narrator = Character("The Voice")\n'
        'define n = Character(None)\n'
        'define t = Character("Tess", kind=n)\n'
        'label start:\n    scene bg\n'
        '    narrator "Heard."\n    t "Tess here."\n    return\n'))
    assert said(manifest) == [("The Voice", "Heard."), ("Tess", "Tess here.")]


@pytest.mark.parametrize("define", [
    'define n = Character(kind=pick_kind())',
    'define n = Character(*cast_args)',
    'define n = Character(name_of("n"))',
])
def test_a_character_whose_name_is_not_read_is_not_nameless(
        tmp_path: Path, define: str) -> None:
    """A name or kind the converter cannot read may be a name: the line
    keeps its speaker as before."""
    out, manifest, _ledger = run(tmp_path, (
        define + '\nlabel start:\n    scene bg\n    n "Hello."\n'
        '    return\n'))
    assert said(manifest) == [("n", "Hello.")]


def test_a_nameless_speakers_text_colour_is_noted_not_carried(
        tmp_path: Path) -> None:
    out, manifest, ledger = run(tmp_path, (
        'define n = Character(None, what_color="#ccddee")\n'
        'label start:\n    scene bg\n    n "Quiet."\n    return\n'))
    assert said(manifest) == [(None, "Quiet.")]
    assert "characters" not in manifest
    assert any("#ccddee" in n and "not carried" in n
               for n in notes_of(manifest, ledger, "Quiet."))


# --------------------------------------------------------------------------
# Monologue translations (item 9m2)
# --------------------------------------------------------------------------

MONOLOGUE = ('define e = Character("Eve")\n'
             'label start:\n'                  # 2
             '    scene bg\n'                   # 3
             '    e """\n'                      # 4
             '    The first paragraph\n'
             '    runs on.\n'
             '\n'
             '    The second one.\n'
             '\n'
             '    And a third.\n'
             '    """\n'
             '    """\n'                        # 12
             '    Narrated once.\n'
             '\n'
             '    Narrated twice.\n'
             '    """\n'
             '    "After."\n'                   # 17
             '    return\n')

MONOLOGUE_DE = [
    (4, 'e "The first paragraph runs on."', 'e "Der erste Absatz läuft."'),
    (4, 'e "The second one."', 'e "Der zweite."'),
    (4, 'e "And a third."', 'e "Und ein dritter."'),
    (12, '"Narrated once."', '"Einmal erzählt."'),
    (12, '"Narrated twice."', '"Zweimal erzählt."'),
    (17, '"After."', '"Danach."'),
]


def tl_file(blocks: list[tuple[int, str, str]],
            ids: list[str] | None = None) -> str:
    return "".join(
        f'# game/script.rpy:{line}\n'
        f'translate de {ids[k] if ids else ident("start", code)}:\n\n'
        f'    # {code}\n    {new}\n\n'
        for k, (line, code, new) in enumerate(blocks))


def test_each_monologue_paragraph_takes_its_own_translation(
        tmp_path: Path) -> None:
    out, manifest, ledger = extract(tmp_path, MONOLOGUE, tl={"de": (
        tl_file(MONOLOGUE_DE) + 'translate de strings:\n'
        '    old "Eve"\n    new "Eva"\n    old "proj"\n    new "Projekt"\n')})
    by_text = {i["text"]: i["id"] for i in manifest["items"]}
    de = {k: v["text"] for k, v in lang_file(out, "de")["items"].items()}
    assert {text: de.get(item_id) for text, item_id in by_text.items()} == {
        "The first paragraph runs on.": "Der erste Absatz läuft.",
        "The second one.": "Der zweite.",
        "And a third.": "Und ein dritter.",
        "Narrated once.": "Einmal erzählt.",
        "Narrated twice.": "Zweimal erzählt.",
        "After.": "Danach.",
    }
    stats = ledger["translations"]["languages"]["de"]
    assert (stats["matched"], stats["duplicates"]) == (6, 0)
    # The validator and tools/translations.py count every paragraph, with
    # the speaker's name and the title.
    proc = run_kinetic("validate", str(out), "--json")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    coverage = json.loads(proc.stdout)["coverage"]["de"]
    assert (coverage["translated"], coverage["strings"]) == (8, 8)
    proc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "translations.py"),
         "status", str(out)], capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "de: 8 of 8 strings (100%), 0 stale, 0 unchecked, 0 missing" \
        in proc.stdout
    check_folder(tmp_path, out, manifest)


def test_a_monologue_paragraph_matches_by_its_location_comment(
        tmp_path: Path) -> None:
    """With identifiers that name no statement (the label renamed since),
    the location comment names the monologue's line, and the paragraph
    is the one whose code Ren'Py commented in the block."""
    ids = [ident("old_start", code) for _l, code, _n in MONOLOGUE_DE]
    out, manifest, _ledger = extract(tmp_path, MONOLOGUE,
                                     tl={"de": tl_file(MONOLOGUE_DE, ids)})
    by_text = {i["text"]: i["id"] for i in manifest["items"]}
    de = {k: v["text"] for k, v in lang_file(out, "de")["items"].items()}
    assert de.get(by_text["The second one."]) == "Der zweite."
    assert de.get(by_text["Narrated twice."]) == "Zweimal erzählt."
    assert len(de) == 6
