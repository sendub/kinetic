"""Converted folders the schema refused (docs/plan.md Phase 60 item 9o2e).

- An id the converter builds from a name starts with that name's slug
  for a route (its choice caption or chain arm) and an item (its
  picture's name); a name starting with `_`, such as a chain on
  `_return`, gave an id starting with `_`, which the id pattern
  refuses. Those ids drop the leading `_`; an id that already fits is
  unchanged, so saved places keep working.
- A Character whose name is the empty string gave its lines `speaker:
  ""`, and with a colour a `characters` key `""`, which the schema
  refuses. An empty name is no speaker name: the line is narration, as
  a say screen showing `who` only when it is set shows it.

Each case is a synthetic project extracted end to end, validated
`--strict` with nothing printed and walked to the story's end.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from PIL import Image

from kinetic_extract.parser import slug

from test_jump_menus import (LEAD, check_folder, extract, run_kinetic,
                             shape, texts)

ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")


def every_id(manifest: dict) -> list[str]:
    ids = [i["id"] for i in manifest["items"]]
    for b in manifest.get("branches", []):
        ids += [b["id"], *(r["id"] for r in b["routes"])]
        ids += [s["id"] for s in b.get("shared", [])]
    return ids


# --------------------------------------------------------------------------
# Ids from names starting with `_`
# --------------------------------------------------------------------------

RETURN_CHAIN = (LEAD
                + '    call ask\n'
                '    if _return == 0:\n        call no\n'
                '    if _return == 1:\n        call yes\n'
                '    "After."\n    return\n'
                'label ask:\n'
                '    menu:\n'
                '        "Yes":\n            return 1\n'
                '        "No":\n            return 0\n'
                'label no:\n    "No line."\n    return\n'
                'label yes:\n    "Yes line."\n    return\n')


def test_a_chain_on_return_gives_route_ids_the_pattern_takes(
        tmp_path: Path) -> None:
    """A chain on `_return` after a called menu: its arms' labels start
    with `_return`, and their route ids now start with `return`."""
    out, manifest, _ledger = extract(tmp_path, RETURN_CHAIN)
    chains = [b for b in manifest["branches"] if b["id"].startswith("if-")]
    assert chains, manifest["branches"]
    for chain in chains:
        for route in chain["routes"]:
            assert route["label"].startswith("_return")
            assert route["id"].startswith("return-"), route["id"]
            if chain.get("continuingRoute"):
                assert ID_RE.fullmatch(chain["continuingRoute"])
    assert all(ID_RE.fullmatch(i) for i in every_id(manifest))
    check_folder(tmp_path, out, manifest)


def test_a_picture_named_with_a_leading_underscore_gives_an_item_id_the_pattern_takes(
        tmp_path: Path) -> None:
    game = tmp_path / "proj" / "game"
    (game / "images").mkdir(parents=True)
    Image.new("RGB", (32, 18), (90, 10, 10)).save(game / "images" / "_red.png")
    out, manifest, _ledger = extract(tmp_path, (
        'label start:\n    scene bg\n    "Lead."\n'
        '    scene _red\n    "Red."\n    return\n'))
    assert texts(manifest) == ["Lead.", "Red."]
    assert manifest["items"][1]["id"] == "red-002"
    assert all(ID_RE.fullmatch(i) for i in every_id(manifest))
    check_folder(tmp_path, out, manifest)


def test_only_ids_that_failed_the_pattern_change(tmp_path: Path) -> None:
    """A route whose caption fits the pattern keeps the id it had (saved
    places name them); the one starting with `_` loses the `_`."""
    out, manifest, _ledger = extract(tmp_path, LEAD + (
        '    menu:\n'
        '        "Left way":\n            "Left."\n'
        '        "_Right":\n            "Right."\n'
        '    "After."\n    return\n'))
    (decision,) = manifest["branches"]
    assert decision["id"] == "menu-start-4"
    assert [r["id"] for r in decision["routes"]] == ["Left-way-1", "Right-2"]
    assert [i["id"] for i in manifest["items"]] == [
        "bg-001", "line-002", "line-003", "line-004"]
    check_folder(tmp_path, out, manifest)


def test_a_long_picture_name_past_item_9999_gives_an_id_of_64_at_most(
        tmp_path: Path) -> None:
    """A picture's name slugs to at most 60 characters, and from item
    10,000 on its place takes five digits: the id was 66 characters,
    past the pattern's 64. The name is cut to leave room for the place;
    an id that fitted is unchanged."""
    name = "a" * 60
    game = tmp_path / "proj" / "game"
    (game / "images").mkdir(parents=True)
    Image.new("RGB", (32, 18), (90, 10, 10)).save(
        game / "images" / f"{name}.png")
    lines = "".join(f'    "Line {n}."\n' for n in range(9998))
    out, manifest, _ledger = extract(tmp_path, (
        f'label start:\n    scene {name}\n    "First."\n' + lines
        + f'    scene {name}\n    "Last."\n    return\n'))
    first, last = manifest["items"][0], manifest["items"][-1]
    assert first["id"] == f"{name}-001"
    assert last["id"] == f"{name[:58]}-10000"
    assert all(ID_RE.fullmatch(i) for i in every_id(manifest))
    proc = run_kinetic("validate", str(out), "--strict")
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_route_ids_past_the_999th_on_a_long_caption_keep_their_number(
        tmp_path: Path) -> None:
    """A route id is its caption's slug (at most 60 characters) then
    `-k`; from route 1,000 on that ran past 64 characters and was cut
    from the end, so route 1,000's `-100` matched route 100's and the
    decision's route ids collided. The slug is cut instead, as for a
    decision id; every id of 64 characters or fewer is unchanged."""
    caption = "c" * 60
    choices = "".join(f'        "{caption} {n}":\n            "Took {n}."\n'
                      for n in range(1, 1002))
    out, manifest, _ledger = extract(tmp_path, LEAD + '    menu:\n'
                                     + choices + '    "After."\n'
                                     '    return\n')
    (decision,) = manifest["branches"]
    ids = [r["id"] for r in decision["routes"]]
    assert len(ids) == 1001 and len(set(ids)) == 1001
    assert ids[99] == f"{caption}-100"
    assert ids[998] == f"{caption}-999"
    assert ids[999] == f"{caption[:59]}-1000"
    assert all(ID_RE.fullmatch(i) for i in every_id(manifest))
    proc = run_kinetic("validate", str(out), "--strict")
    assert proc.returncode == 0, proc.stdout + proc.stderr


@pytest.mark.parametrize("name, expected", [
    ("_return is 1", "return-is-1"),
    ("__init", "init"),
    ("_-x", "x"),
    ("_", "route"),
    ("plain_name", "plain_name"),
    ("a_b", "a_b"),
    ("-lead", "lead"),
])
def test_an_id_slug_starts_with_a_letter_or_digit(name: str,
                                                  expected: str) -> None:
    assert slug(name, "route", lead=True) == expected


def test_a_slug_inside_an_id_keeps_its_underscore() -> None:
    """A slug after a prefix (`if-`, `menu-`, `shared-`) was never
    refused, so it is unchanged."""
    assert slug("_return", "x") == "_return"


# --------------------------------------------------------------------------
# Characters with an empty name
# --------------------------------------------------------------------------

def said(manifest: dict) -> list[tuple[str | None, str | None]]:
    return [(i.get("speaker"), i.get("text")) for i in manifest["items"]]


@pytest.mark.parametrize("define", [
    'define e = Character("")',
    'define e = Character("", color="#ff8800")',
    "define e = Character('', what_color=\"#ccddee\")",
    'define e = Character(name="", color="#ff8800")',
    'define e = Character(_(""), color="#ff8800")',
    'define base = Character("", color="#ff8800")\n'
    'define e = Character(kind=base)',
])
def test_an_empty_named_characters_line_is_narration(tmp_path: Path,
                                                     define: str) -> None:
    out, manifest, ledger = extract(tmp_path, (
        define + '\n'
        'define a = Character("Ann", color="#88ff00")\n'
        'label start:\n    scene bg\n'
        '    e "Said with no name."\n'
        '    a "Ann speaks."\n'
        '    return\n'))
    assert said(manifest) == [(None, "Said with no name."),
                              ("Ann", "Ann speaks.")]
    assert manifest["characters"] == {"Ann": {"nameColor": "#88ff00"}}
    (line,) = [i for i in manifest["items"]
               if i.get("text") == "Said with no name."]
    assert any("empty name" in n for n in ledger["items"][line["id"]]["notes"])
    check_folder(tmp_path, out, manifest)


def test_an_empty_literal_speaker_is_narration(tmp_path: Path) -> None:
    out, manifest, _ledger = extract(tmp_path, (
        'label start:\n    scene bg\n'
        '    "" "Said by no one."\n'
        '    "Ann" "Said by Ann."\n'
        '    return\n'))
    assert said(manifest) == [(None, "Said by no one."),
                              ("Ann", "Said by Ann.")]
    check_folder(tmp_path, out, manifest)


def test_the_chain_on_return_shape_is_kept(tmp_path: Path) -> None:
    """Dropping the `_` changes ids only: the decisions are as before."""
    _out, manifest, _ledger = extract(tmp_path, RETURN_CHAIN)
    labels = [[r[0] for r in d["routes"]] for d in shape(manifest)]
    assert ["Yes", "No"] in labels
