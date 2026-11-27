"""kinetic-extract reads Ren'Py translations (docs/plan.md Phase 56 item
9; docs/extracting.md, "Translations").

Expected identifiers are computed here from Ren'Py's rule written out by
hand: the label, ``_`` and the first 8 hex digits of the MD5 of each
statement's canonical code followed by ``\\r\\n``, the code typed as
Ren'Py's ``Say.get_code()`` prints it, never produced by the module
under test. The demo's game/tl/ files carry identifiers computed the same
way.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

import pytest
from PIL import Image
from kinetic_extract import rpa as rpa_mod
from kinetic_extract import translations as tl
from kinetic_extract.cli import main as cli_main
from kinetic_extract.images import ImplicitImages
from kinetic_extract.parser import character_name, parse_project
from kinetic_extract.timeline import build_timeline

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "fixtures" / "renpy_demo"
GAME = FIXTURE / "game"
GOLDEN = Path(__file__).parent / "data" / "renpy_demo.manifest.json"


def ident(label: str | None, *codes: str) -> str:
    md5 = hashlib.md5()
    for code in codes:
        md5.update((code + "\r\n").encode("utf-8"))
    digest = md5.hexdigest()[:8]
    return digest if label is None else f"{label}_{digest}"


def groups_of(*files: tuple[str, str]) -> list[tl.Group]:
    return tl.source_groups(list(files))


def ids_of(text: str) -> list[str]:
    return [g.identifier for g in groups_of(("game/script.rpy", text))]


# --- identifiers -----------------------------------------------------------

def test_character_and_narrator_lines() -> None:
    text = ('label start:\n'
            '    e "Hello."\n'
            '    "The wind rises."\n')
    assert ids_of(text) == [ident("start", 'e "Hello."'),
                            ident("start", '"The wind rises."')]


def test_code_is_normalised_as_ren_py_prints_it() -> None:
    """Runs of spaces collapse, escapes are written back canonically,
    attributes, `@`, arguments and `with` come in Ren'Py's order."""
    text = ('label start:\n'
            '    e   happy   "Two   spaces,  \\"quoted\\"\\nand a break."\n'
            '    e happy @ sad "Hm." with dissolve\n'
            '    e "Slow." (what_slow_cps = 20,  interact=True)\n'
            '    e "One \\{tag\\} [[name]] 100\\%"\n')
    assert ids_of(text) == [
        ident("start", 'e happy "Two spaces, \\"quoted\\"\\nand a break."'),
        ident("start", 'e happy @ sad "Hm." with dissolve'),
        ident("start", 'e "Slow." (what_slow_cps=20, interact=True)'),
        # \{ doubles the brace, \} is a plain one (Ren'Py's dequote).
        ident("start", 'e "One {{tag} [[name]] 100%%"'),
    ]


def test_voice_and_nvl_clear_join_the_next_line() -> None:
    text = ('label start:\n'
            '    voice "v/line1.ogg"\n'
            '    e "With a voice."\n'
            '    nvl clear\n'
            '    n "On a fresh page."\n'
            '    voice "v/orphan.ogg"\n'
            '    show e\n'
            '    e "After a show."\n')
    groups = groups_of(("game/script.rpy", text))
    assert [g.identifier for g in groups] == [
        ident("start", 'voice "v/line1.ogg"', 'e "With a voice."'),
        ident("start", "nvl clear", 'n "On a fresh page."'),
        ident("start", 'voice "v/orphan.ogg"'),
        ident("start", 'e "After a show."'),
    ]
    assert (groups[0].line, groups[0].say_line) == (2, 3)
    assert groups[2].say_line is None


def test_extend_character_objects_and_string_speakers() -> None:
    text = ('label start:\n'
            '    e "Wait"\n'
            '    extend ", there is more."\n'
            '    Character("Bob") "Hi."\n'
            '    "Mysterious voice" "Who goes there?"\n'
            '    narrator "Plainly."\n')
    assert ids_of(text) == [
        ident("start", 'e "Wait"'),
        ident("start", 'extend ", there is more."'),
        ident("start", 'Character("Bob") "Hi."'),
        ident("start", '"Mysterious voice" "Who goes there?"'),
        ident("start", 'narrator "Plainly."'),
    ]


def test_repeated_lines_get_suffixes_within_the_label() -> None:
    text = ('label start:\n'
            '    e "Again."\n'
            '    if flag:\n'
            '        e "Again."\n'
            '    e "Again."\n'
            'label other:\n'
            '    e "Again."\n')
    base = ident("start", 'e "Again."')
    assert ids_of(text) == [base, base + "_1", base + "_2",
                            ident("other", 'e "Again."')]


def test_blocks_ren_py_restructures_and_those_it_does_not() -> None:
    """Say statements in if/while/menu/init blocks have identifiers;
    python, screen and the statement keywords do not."""
    text = ('init python:\n'
            '    e = "not a say"\n'
            'screen s():\n'
            '    text "nor this"\n'
            'label start:\n'
            '    $ name = "nor this"\n'
            '    show eileen happy\n'
            '    play music "theme.ogg"\n'
            '    while False:\n'
            '        e "In a loop."\n'
            '    menu:\n'
            '        "Choice one":\n'
            '            e "In a choice."\n'
            '        "Choice two" if x:\n'
            '            pass\n')
    assert ids_of(text) == [ident("start", 'e "In a loop."'),
                            ident("start", 'e "In a choice."')]


def test_menu_say_item_is_nointeract() -> None:
    text = ('label start:\n'
            '    menu:\n'
            '        e "Where to?"\n'
            '        "Left":\n'
            '            e "Left it is."\n')
    assert ids_of(text) == [ident("start", 'e "Where to?" nointeract'),
                            ident("start", 'e "Left it is."')]


def test_labels_local_hidden_underscore_and_menu_names() -> None:
    text = ('"Before any label."\n'
            'label chapter:\n'
            '    e "One."\n'
            'label .part:\n'
            '    e "Two."\n'
            'label hidden hide:\n'
            '    e "Three."\n'
            'label _aside:\n'
            '    e "Four."\n'
            'label next:\n'
            '    menu pick:\n'
            '        "A":\n'
            '            e "Five."\n')
    groups = groups_of(("game/script.rpy", text))
    assert [g.identifier for g in groups] == [
        ident(None, '"Before any label."'),
        ident("chapter", 'e "One."'),
        ident("chapter_part", 'e "Two."'),
        ident("chapter_part", 'e "Three."'),   # a hidden label is no label
        ident("chapter_part", 'e "Four."'),    # an _label is the alternate
        ident("pick", 'e "Five."'),            # a named menu is a label
    ]
    assert groups[4].alternate == ident("_aside", 'e "Four."')


def test_explicit_id_wins() -> None:
    groups = groups_of(("game/script.rpy",
                        'label start:\n    e "Named." id greeting_1\n'))
    assert groups[0].identifier == "greeting_1"
    assert groups[0].alternate == ident(
        "start", 'e "Named." id greeting_1')


def test_suffixes_carry_across_files_in_load_order() -> None:
    first = ("game/a.rpy", '"Shared line."\n')
    second = ("game/b.rpy", '"Shared line."\n')
    groups = groups_of(first, second)
    base = ident(None, '"Shared line."')
    assert [(g.file, g.identifier) for g in groups] == [
        ("game/a.rpy", base), ("game/b.rpy", base + "_1")]


def test_string_over_several_lines_and_comments() -> None:
    text = ('label start:  # opening\n'
            '    e "A line that runs\n'
            '       onto the next."  # trailing comment\n'
            '    e "A # inside a string."\n')
    groups = groups_of(("game/script.rpy", text))
    assert [g.identifier for g in groups] == [
        ident("start", 'e "A line that runs onto the next."'),
        ident("start", 'e "A # inside a string."')]
    assert [g.say_line for g in groups] == [2, 4]


def test_monologue_is_one_line_per_paragraph() -> None:
    text = ('label start:\n'
            '    e """\n'
            '    First   paragraph.\n'
            '\n'
            '    Second one.\n'
            '    """\n')
    assert ids_of(text) == [ident("start", 'e "First paragraph."'),
                            ident("start", 'e "Second one."')]


def test_demo_identifiers_match_its_tl_files() -> None:
    texts = [(source.rel, source.text()) for source in tl.source_files(GAME)]
    assert [name for name, _text in texts] == ["game/script.rpy"]
    by_say = {g.say_line: g.identifier for g in tl.source_groups(texts)}
    assert by_say[27] == ident("start", 'a "Welcome to the house."')
    assert by_say[29] == ident("start", 'voice "voice/viktor-01.mp3"',
                               'Viktor "The lights are dim. [greeting]?"')
    assert by_say[43] == ident("start", '"Тишина в саду. [wind]"')
    good_night = ident("inside", 'd "Good night."')
    assert (by_say[76], by_say[78]) == (good_night, good_night + "_1")
    # A later label's lines take its name (Phase 60 item 9's nightcap).
    assert by_say[97] == ident("ask_drink", 'a "Something warm before bed?"')
    assert by_say[126] == ident("nightcap", '"The house sleeps."')


# --- language names ----------------------------------------------------------

@pytest.mark.parametrize("name, tag", [
    ("de", "de"), ("fr", "fr"), ("ja", "ja"), ("ko", "ko"), ("ru", "ru"),
    ("pl", "pl"), ("tr", "tr"), ("it", "it"), ("es", "es"),
    ("zhCN", "zh-Hans"), ("zhTW", "zh-Hant"), ("ptBR", "pt-BR"),
    ("ptPT", "pt-PT"), ("esLT", "es-419"), ("pt_BR", "pt-BR"),
    ("zh-TW", "zh-Hant"), ("english", "en"), ("French", "fr"),
    ("german", "de"), ("spanish", "es"), ("russian", "ru"),
    ("japanese", "ja"), ("korean", "ko"), ("italian", "it"),
    ("polish", "pl"), ("turkish", "tr"), ("portuguese", "pt"),
    ("brazilian", "pt-BR"), ("chinese", "zh-Hans"),
    ("schinese", "zh-Hans"), ("tchinese", "zh-Hant"),
    ("ukrainian", "uk"), ("czech", "cs"), ("dutch", "nl"),
    ("indonesian", "id"), ("vietnamese", "vi"), ("thai", "th"),
    ("arabic", "ar"), ("hebrew", "he"), ("greek", "el"),
    ("hungarian", "hu"), ("PortugueseBrazil", "pt-BR"),
    ("SimplifiedChinese", "zh-Hans"), ("SpanishLatinAmerican", "es-419"),
    ("SpanishSpain", "es-ES"), ("klingon", None), ("xx", None),
    ("None", None),
])
def test_language_table(name: str, tag: str | None) -> None:
    assert tl.language_tag(name) == tag


def test_language_map_names_and_overrides() -> None:
    overrides = dict([tl.language_map_option("klingon=tlh"),
                      tl.language_map_option("german=DE-at")])
    assert overrides == {"klingon": "tlh", "german": "de-AT"}
    assert tl.language_tag("klingon", overrides) == "tlh"
    assert tl.language_tag("german", overrides) == "de-AT"
    for bad in ("klingon", "=de", "klingon=", "klingon=not a tag"):
        with pytest.raises(ValueError):
            tl.language_map_option(bad)


def test_cli_refuses_a_malformed_language_map(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        cli_main([str(FIXTURE), str(tmp_path / "out"),
                  "--language-map", "klingon"])
    assert exc.value.code == 2
    assert "NAME=TAG" in capsys.readouterr().err


def _read(name: str, blocks: int = 0, folder: bool = True) -> tl.LanguageRead:
    read = tl.LanguageRead(name)
    read.blocks = [tl.Block(f"x_{k}", "s", None, ["t"], [None])
                   for k in range(blocks)]
    if folder:
        read.folders.add(name)
    return read


def test_resolving_names_skips_unknown_base_and_duplicates() -> None:
    warnings: list[str] = []
    skipped: list[str] = []
    read = {"de": _read("de", 3), "German": _read("German", 9, False),
            "english": _read("english"), "klingon": _read("klingon"),
            "zhCN": _read("zhCN")}
    out = tl.resolve_languages(read, {}, "en", warnings, skipped)
    assert {tag: lang.name for tag, lang in out.items()} == {
        "de": "de", "zh-Hans": "zhCN"}
    assert sorted(skipped) == ["German (also de)",
                               "english (the base language)",
                               "klingon (unknown name)"]
    assert any("--language-map klingon=TAG" in w for w in warnings)
    assert any("'english' is en, the manifest's base language" in w
               for w in warnings)


# --- reading tl/ -----------------------------------------------------------

def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_read_tl_blocks_strings_and_ignored(tmp_path: Path) -> None:
    game = tmp_path / "game"
    write(game / "tl" / "fr" / "script.rpy",
          '# game/script.rpy:3\n'
          'translate fr start_aaaa1111:\n'
          '\n'
          '    # e "Hello."\n'
          '    e "Bonjour."\n'
          '\n'
          'translate fr start_bbbb2222:\n'
          '    pass\n'
          '\n'
          'translate fr strings:\n'
          '    # game/script.rpy:9\n'
          '    old "Go   left"\n'
          '    new "À gauche"\n'
          '    old "Untranslated"\n'
          '    new ""\n'
          '\n'
          'translate fr style default:\n'
          '    font "f.ttf"\n'
          'translate fr python:\n'
          '    x = 1\n'
          'translate None strings:\n'
          '    old "a"\n'
          '    new "b"\n')
    write(game / "tl" / "fr" / "options.rpyc", "compiled twin")
    write(game / "tl" / "fr" / "screens.rpyc", "compiled only")
    write(game / "tl" / "fr" / "images" / "sign.png", "replacement")
    write(game / "tl" / "None" / "common.rpymc", "ignored")
    write(game / "tl" / "fr" / "options.rpy", "")
    read = tl.read_tl(game)
    assert list(read) == ["fr"]
    fr = read["fr"]
    assert [(b.identifier, b.comment, b.texts, b.original)
            for b in fr.blocks] == [
        ("start_aaaa1111", ("game/script.rpy", 3), ["Bonjour."],
         ['e "Hello."']),
        ("start_bbbb2222", None, [], []),
    ]
    assert fr.strings == {"Go left": "À gauche", "Untranslated": ""}
    assert (fr.string_pairs, fr.style_blocks, fr.python_blocks,
            fr.replacement_files, fr.compiled_only) == (2, 1, 1, 1, 1)


NBSP = " "


def test_read_tl_indentation_with_non_breaking_spaces(tmp_path: Path) -> None:
    # Ren'Py's lexer counts only the leading spaces as a line's indent
    # and skips the rest of its whitespace (U+00A0 too) as it reads the
    # statement, so these lines are read as if their indentation were
    # plain: the `new` line is the `old` line's sibling, not its block.
    game = tmp_path / "game"
    path = game / "tl" / "english" / "script.rpy"
    path.parent.mkdir(parents=True)
    path.write_bytes((
        '# game/script.rpy:3\r\n'
        'translate english start_aaaa1111:\r\n'
        '\r\n'
        '    # a "*{i}Zehn Euro?!{i}*"\r\n'
        f'  {NBSP}  a "*{{i}}Ten whole euros?!{{i}}*"\r\n'
        '\r\n'
        'translate english start_bbbb2222:\r\n'
        '\r\n'
        '    # "Es regnet."\r\n'
        f'{"  "}{NBSP}{NBSP} "It rains."{NBSP}\r\n'
        '\r\n'
        'translate english strings:\r\n'
        '\r\n'
        '    old "Links"\r\n'
        f'    {NBSP}new "Left"\r\n').encode("utf-8"))
    english = tl.read_tl(game)["english"]
    assert [(b.identifier, b.texts) for b in english.blocks] == [
        ("start_aaaa1111", ["*{i}Ten whole euros?!{i}*"]),
        ("start_bbbb2222", ["It rains."]),
    ]
    assert english.strings == {"Links": "Left"}


def test_identifiers_ignore_non_breaking_spaces_in_indentation() -> None:
    plain = ('label start:\n'
             '    e "Hello."\n'
             '    menu:\n'
             '        "Go":\n'
             '            "The wind rises."\n')
    mixed = ('label start:\n'
             f'  {NBSP} e "Hello."\n'
             f'  {NBSP}{NBSP}menu:\n'
             f'    {NBSP}   "Go":\n'
             f'      {NBSP}{NBSP}    "The wind rises."\n')
    assert ids_of(mixed) == ids_of(plain)


def test_join_texts() -> None:
    assert tl.join_texts(["Der Bildschirm", " erwacht."],
                         ["a", "extend"]) == "Der Bildschirm erwacht."
    assert tl.join_texts(["Eins.", "Zwei."], ["a", "a"]) == "Eins. Zwei."


# --- matching one project --------------------------------------------------

SCRIPT = ('label start:\n'                       # 1
          '    scene black\n'                    # 2
          '    e "Hello."\n'                     # 3
          '    e "Bye."\n'                       # 4
          '    if x:\n'                          # 5
          '        e "Hidden."\n'                # 6
          '    e "Moved here."\n'                # 7
          '    e "Split in two."\n')             # 8


def walk(game: Path) -> list:
    parses, defs, chars, _sources = parse_project(game)
    return build_timeline(parses, defs, chars, game).items


def test_read_project_matches_items(tmp_path: Path) -> None:
    game = tmp_path / "game"
    write(game / "script.rpy", SCRIPT)
    hello = ident("start", 'e "Hello."')
    hidden = ident("start", 'e "Hidden."')
    split = ident("start", 'e "Split in two."')
    write(game / "tl" / "de" / "script.rpy",
          f'# game/script.rpy:3\ntranslate de {hello}:\n'
          '    # e "Hello."\n    e "Hallo."\n\n'
          # Identifier from an older script; the comment still finds it.
          '# game/script.rpy:4\ntranslate de start_00000000:\n'
          '    # e "Bye."\n    e "Tschüss."\n\n'
          # A stale comment pointing at another statement: no fallback.
          '# game/script.rpy:7\ntranslate de start_11111111:\n'
          '    # e "Moved from elsewhere."\n    e "Verschoben."\n\n'
          # A line the walk made no item of.
          f'# game/script.rpy:6\ntranslate de {hidden}:\n'
          '    e "Versteckt."\n\n'
          # A comment lagging behind the identifier (the script grew).
          f'# game/script.rpy:7\ntranslate de {split}:\n'
          '    e "In zwei"\n    e "geteilt."\n')
    records = walk(game)
    project = tl.read_project(game, records)
    texts = {r.item["text"]: r.translations.get("de") for r in records}
    assert texts == {"Hello.": "Hallo.", "Bye.": "Tschüss.",
                     "Moved here.": None, "Split in two.": "In zwei geteilt."}
    s = project.stats["de"]
    assert (s.blocks, s.matched, s.by_comment, s.not_converted,
            s.unmatched, s.joined) == (5, 3, 1, 1, 1, 1)
    assert (s.agree, s.disagree) == (2, 1)
    assert s.unmatched_examples == [
        "game/tl/de/script.rpy:12 (start_11111111)"]


# The characters str.splitlines breaks at that Ren'Py's lexer does not.
NOT_LINE_BREAKS = ["\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x85",
                   " ", " "]


@pytest.mark.parametrize("char", NOT_LINE_BREAKS,
                         ids=lambda c: f"U+{ord(c):04X}")
def test_only_ren_py_line_breaks_split_a_script_for_tl(
        tmp_path: Path, char: str) -> None:
    script = ('label start:\n'                   # 1
              f'    e "Before{char}after."\n'    # 2
              '    e "Next."\n')                 # 3
    before = ident("start", f'e "Before{char}after."')
    after = ident("start", 'e "Next."')
    groups = groups_of(("game/script.rpy", script))
    assert [(g.identifier, g.line) for g in groups] == [(before, 2),
                                                        (after, 3)]
    game = tmp_path / "game"
    write(game / "script.rpy", script)
    write(game / "tl" / "de" / "script.rpy",
          f'# game/script.rpy:2\ntranslate de {before}:\n'
          '    e "Vorher, nachher."\n\n'
          f'# game/script.rpy:3\ntranslate de {after}:\n'
          '    e "Weiter."\n')
    records = walk(game)
    project = tl.read_project(game, records)
    texts = {r.item["text"]: r.translations.get("de") for r in records}
    assert texts == {f"Before{char}after.": "Vorher, nachher.",
                     "Next.": "Weiter."}
    s = project.stats["de"]
    assert (s.blocks, s.matched, s.unmatched, s.agree) == (2, 2, 0, 2)


def test_read_project_without_tl_or_turned_off(tmp_path: Path) -> None:
    game = tmp_path / "game"
    write(game / "script.rpy", SCRIPT)
    project = tl.read_project(game, walk(game))
    assert project.stats == {} and project.warnings == []


def test_tl_is_never_story_flow_or_an_image_name() -> None:
    parses, *_rest = parse_project(GAME, "**/*.rpy")
    assert [rel for rel, _p in parses] == ["game/script.rpy"]
    hit = ImplicitImages(GAME).lookup("bg-room", "image")
    assert hit is not None and hit[0] == "game/data/bg-room.png"
    assert hit[3] == 1     # the tl/de replacement is no candidate


# --- the demo, end to end ----------------------------------------------------

@pytest.fixture(scope="module")
def demo(tmp_path_factory: pytest.TempPathFactory) -> dict:
    out = tmp_path_factory.mktemp("translations") / "out"
    printed = StringIO()
    with redirect_stdout(printed):
        assert cli_main([str(FIXTURE), str(out)]) == 0
    def read(name: str) -> dict:
        return json.loads((out / name).read_text("utf-8"))

    return {"out": out, "printed": printed.getvalue(),
            "manifest": read("manifest.json"),
            "ledger": read("build-ledger.json")}


def lang_file(out: Path, tag: str) -> dict:
    data = json.loads((out / "lang" / f"{tag}.json").read_text("utf-8"))
    script = (out / "lang" / f"{tag}.js").read_text("utf-8")
    prefix = f'window.KINETIC_LANGUAGES["{tag}"] = '
    assert script.startswith(prefix) and script.endswith(";\n")
    assert json.loads(script[len(prefix):-2]) == data
    return data


def sha8(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]


def test_demo_german_language_file(demo: dict) -> None:
    manifest = demo["manifest"]
    assert manifest["languages"] == ["de", "zh-Hans"]
    assert "language" not in manifest
    base = {i["id"]: i.get("text") for i in manifest["items"]}
    de = lang_file(demo["out"], "de")
    assert list(de) == ["$schema", "language", "speakers", "items",
                        "decisions", "keepOriginalVoice"]
    assert de["$schema"] == "../lang.schema.json"
    assert de["language"] == "de"
    assert de["speakers"] == {"Ana": "Anna"}
    assert de["keepOriginalVoice"] is True    # line-002 has a voice line
    items = {k: v["text"] for k, v in de["items"].items()}
    assert items == {
        "bg-room-001": "Willkommen im Haus.",
        "line-002": "Das Licht ist gedämpft. [greeting]?",
        "clip-004": "Der Bildschirm erwacht flackernd.",    # extend joined
        "bg-yard-006": "Stille im Garten. [wind]",          # narrator
        "bg-room-008": "Das Feuer knistert, und das Zimmer wird warm.",
        "line-012": "Die Nacht legt sich über das Haus.",
        # A choice that jumps straight on is its text, from `strings`;
        # the other choice's line is walked since Phase 60 item 4.
        "line-013": "Wieder hineingehen",
        "line-014": "Der Himmel ist unglaublich weit.",
        "line-016": "Gute Nacht.",                          # suffix _1
        # By comment only, and its extend line's block joined to it.
        "talk-022": "Der Fernseher summt mit. Dann verstummt er.",
        # The nightcap (Phase 60 item 9): the empty choice's text from
        # `strings`, the lines of the menu's routes and both chains' arms,
        # and the line said over the candle's animation.
        "bg-room-023": "Etwas Warmes vor dem Schlafengehen?",
        "line-024": "Tee, bitte",
        "line-025": "Ich lasse die Schokolade langsam schmelzen.",
        "line-026": "Lass dir Zeit.",
        "line-027": "Du setzt dich mit deiner Tasse ans Fenster.",
        "line-028": "Der Tee ist stark und dunkel.",
        "line-029": "Der Kakao ist süß und sämig.",
        "line-030": "Der Regen hat aufgehört.",
        "line-031": "Jetzt ist das ganze Haus warm.",
        "line-032": "Eine warme Ecke genügt.",
        "line-033": "Die Kälte kriecht zurück.",
        "candle-034": "Eine Kerze flackert auf dem Sims und steht dann "
                      "still.",
        "line-035": "Das Haus schläft.",
    }
    assert "line-003" not in items                          # `pass`
    for item_id, entry in de["items"].items():
        assert entry["from"] == sha8(base[item_id])
    decision = de["decisions"]["menu-start-47"]
    assert decision["prompt"] == {"text": "Der Abend gehört dir.",
                                  "from": sha8("The evening is yours to "
                                               "spend.")}
    assert {k: v["text"] for k, v in decision["routes"].items()} == {
        "Warm-the-room-again-1": "Das Zimmer wieder wärmen",
        "Walk-the-garden-path-2": "Den Gartenweg entlang"}
    assert {k: v["text"] for k, v in
            de["decisions"]["menu-start-63"]["routes"].items()} == {
        "Go-back-inside-1": "Wieder hineingehen"}
    assert {k: v["text"] for k, v in
            de["decisions"]["menu-ask_drink-98"]["routes"].items()} == {
        "Tea-please-1": "Tee, bitte", "Cocoa-2": "Kakao",
        "Not-yet-3": "Noch nicht"}
    # The chains' prompt and labels in the catalogue's German, a choice's
    # text inside a label from `strings` (Phase 60 items 6 and 6b).
    chain = de["decisions"]["if-nightcap-113"]
    assert chain["prompt"]["text"] == \
        "Was passt zu deiner bisherigen Geschichte?"
    assert {k: v["text"] for k, v in chain["routes"].items()} == {
        "If-you-chose-Tea-please-1": "Wenn du gewählt hast: Tee, bitte",
        "If-you-chose-Cocoa-2": "Wenn du gewählt hast: Kakao"}
    assert {k: v["text"] for k, v in
            de["decisions"]["if-nightcap-118"]["routes"].items()} == {
        "warmth-2-or-more-1": "warmth 2 oder mehr",
        "warmth-exactly-1-2": "warmth genau 1",
        "warmth-under-1-3": "warmth unter 1"}
    zh = lang_file(demo["out"], "zh-Hans")
    assert {k: v["text"] for k, v in zh["items"].items()} == {
        "bg-room-001": "欢迎来到这所房子。"}
    assert not (demo["out"] / "lang" / "klingon.json").exists()
    assert (demo["out"] / "lang.schema.json").read_bytes() == \
        (REPO_ROOT / "docs" / "lang.schema.json").read_bytes()


def validator_coverage(out: Path) -> dict[str, tuple[int, int, int, int]]:
    """Each language's (translated, strings, stale, unchecked) from
    `validate --json`, which exits 0."""
    proc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "validate_content.py"),
         str(out), "--json"], capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    report = json.loads(proc.stdout)
    assert report["problems"] == []
    return {tag: (c["translated"], c["strings"], c["stale"], c["unchecked"])
            for tag, c in report["coverage"].items()}


def test_demo_output_validates_with_coverage(demo: dict) -> None:
    assert validator_coverage(demo["out"]) == {
        "de": (38, 57, 0, 0), "zh-Hans": (8, 57, 0, 0)}


def test_demo_report(demo: dict) -> None:
    printed = demo["printed"]
    assert ("warning: translations: game/tl language 'klingon' is not a "
            "known language name: skipped; --language-map klingon=TAG") \
        in printed
    assert ("translations: 2 language file(s) written (de, zh-Hans); "
            "skipped: klingon (unknown name)") in printed
    assert ("  de (tl/de): dialogue blocks 25: matched to items 22 (by "
            "comment only 1), kept as stale 0, lines not in the story 1, "
            "pass or empty 1, unmatched 1; identifier and comment: agree "
            "23, disagree 0, no comment 0") in printed
    assert ("    strings used 8 of 8; several lines joined 1, duplicates 0, "
            "same as the base text 0; coverage de: 38 of 57 strings "
            "(66.6%), 0 stale, 0 unchecked; ignored: style blocks 1, "
            "python blocks 1, replacement files 1") in printed
    assert ("    unmatched: game/tl/de/script.rpy:77 (inside_deadbeef)"
            in printed)
    ledger = demo["ledger"]["translations"]
    assert ledger["skipped"] == ["klingon (unknown name)"]
    de = ledger["languages"]["de"]
    assert (de["name"], de["blocks"], de["matched"], de["done"],
            de["total"]) == ("de", 25, 22, 38, 57)


def test_demo_without_translations_is_the_english_golden(
        tmp_path: Path) -> None:
    out = tmp_path / "out"
    assert cli_main([str(FIXTURE), str(out), "--no-translations"]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    assert "languages" not in manifest
    assert not (out / "lang").exists()
    assert not (out / "lang.schema.json").exists()
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    assert "translations" not in ledger
    golden = json.loads(GOLDEN.read_text("utf-8"))
    del golden["languages"]
    ids = [i["id"] for i in manifest["items"]]
    assert ids == [i["id"] for i in golden["items"]]
    assert [i.get("text") for i in manifest["items"]] == \
        [i.get("text") for i in golden["items"]]


def test_demo_language_map_names_klingon() -> None:
    records = walk(GAME)
    project = tl.read_project(GAME, records, {"klingon": "tlh",
                                              "zhCN": "zh-Hant"})
    assert sorted(project.stats) == ["de", "tlh", "zh-Hant"]
    assert project.skipped == []
    first = next(r for r in records if r.item["id"] == "bg-room-001")
    assert first.translations == {"de": "Willkommen im Haus.",
                                  "tlh": "juHlIj DaH yIjaH.",
                                  "zh-Hant": "欢迎来到这所房子。"}


def test_over_limit_strings_are_skipped(demo: dict) -> None:
    manifest = demo["manifest"]
    records = walk(GAME)     # the same item ids as the demo's manifest
    assert [r.item["id"] for r in records] == \
        [i["id"] for i in manifest["items"]]
    project = tl.ProjectTranslations()
    project.stats["fr"] = tl.LanguageStats("fr", "fr", ["fr"])
    project.strings["fr"] = {"Warm the room again": "x" * 120,
                             "Walk the garden path": "Le jardin"}
    candidates = [{"record": type("R", (), {"prompt_defaulted": False})(),
                   "branch": manifest["branches"][0]}]
    files, stats, warnings = tl.language_files(
        manifest, records, candidates, [project], None)
    assert files == [{"language": "fr", "decisions": {"menu-start-47": {
        "routes": {"Walk-the-garden-path-2": {
            "text": "Le jardin", "from": sha8("Walk the garden path")}}}},
        "keepOriginalVoice": True}]
    assert stats["fr"].over_limit == 1
    assert any("120 characters, over the limit of 119" in w
               for w in warnings)


# --- item 9b (a): extend lines ------------------------------------------------

def test_extend_continues_the_line_before_in_one_item(tmp_path: Path) -> None:
    """Ren'Py shows the previous line with the extension added as
    written, in one box, with the previous speaker; the walk makes one
    item of them."""
    game = tmp_path / "game"
    write(game / "script.rpy",
          'define e = Character("Eileen")\n'      # 1
          'label start:\n'                        # 2
          '    scene black\n'                     # 3
          '    e "Wait"\n'                        # 4
          '    extend ", there is more."\n'       # 5
          '    extend " And [more]."\n'           # 6
          '    "Narration."\n')                   # 7
    records = walk(game)
    assert [(r.item.get("speaker"), r.item["text"]) for r in records] == [
        ("Eileen", "Wait, there is more. And [more]."), (None, "Narration.")]
    first = records[0]
    assert first.text_parts == [("game/script.rpy:4", "Wait"),
                                ("game/script.rpy:5", ", there is more."),
                                ("game/script.rpy:6", " And [more].")]
    assert "kept 1 interpolation(s) literal in text" in first.notes


def test_extend_with_no_line_before_it_is_narration(tmp_path: Path) -> None:
    """At the start of the walk, and after a menu's boundary (a route's
    line never continues the lead-in's), `extend` has no line of its own
    to continue: Ren'Py's narrator says it."""
    game = tmp_path / "game"
    write(game / "script.rpy",
          'label start:\n'
          '    scene black\n'
          '    extend "First."\n'
          '    e "Choose."\n'
          '    menu:\n'
          '        "Left":\n'
          '            extend "Gone left."\n'
          '        "Right":\n'
          '            e "Gone right."\n')
    records = walk(game)
    assert [(r.item.get("speaker"), r.item["text"]) for r in records] == [
        (None, "First."), ("e", "Choose."), (None, "Gone left."),
        ("e", "Gone right.")]


def test_a_game_defined_extend_character_is_a_speaker(tmp_path: Path) -> None:
    game = tmp_path / "game"
    write(game / "script.rpy",
          'define extend = Character("Ext")\n'
          'label start:\n'
          '    scene black\n'
          '    e "One."\n'
          '    extend "Two."\n')
    assert [r.item.get("speaker") for r in walk(game)] == ["e", "Ext"]


def test_extend_translations_join_as_the_lines_do(tmp_path: Path) -> None:
    """Each say statement has its own identifier and block; the item's
    translation joins the parts' translations as written. An item with a
    part untranslated keeps none, counted."""
    game = tmp_path / "game"
    write(game / "script.rpy",
          'label start:\n'                        # 1
          '    scene black\n'                     # 2
          '    e "Wait"\n'                        # 3
          '    extend ", more."\n'                # 4
          '    e "Half"\n'                        # 5
          '    extend " done."\n')                # 6
    blocks = [(3, 'e "Wait"', 'e "Warte"'),
              (4, 'extend ", more."', 'extend ", noch mehr."'),
              (5, 'e "Half"', 'e "Halb"')]
    write(game / "tl" / "de" / "script.rpy", "".join(
        f'# game/script.rpy:{line}\ntranslate de {ident("start", code)}:\n'
        f'    # {code}\n    {new}\n\n' for line, code, new in blocks))
    records = walk(game)
    project = tl.read_project(game, records)
    assert [r.translations.get("de") for r in records] == [
        "Warte, noch mehr.", None]
    s = project.stats["de"]
    assert (s.blocks, s.matched, s.incomplete) == (3, 3, 1)
    lines = tl.summary_lines(project.stats, ["de"], [])
    assert "extended lines missing a part 1" in lines[2]


def test_a_voice_before_an_extend_line_is_reported(tmp_path: Path) -> None:
    game = tmp_path / "game"
    write(game / "audio" / "v1.ogg", "x")
    write(game / "audio" / "v2.ogg", "x")
    write(game / "script.rpy",
          'label start:\n'
          '    scene black\n'
          '    voice "audio/v1.ogg"\n'
          '    e "Wait"\n'
          '    voice "audio/v2.ogg"\n'
          '    extend ", more."\n')
    parses, defs, chars, _sources = parse_project(game)
    result = build_timeline(parses, defs, chars, game)
    [record] = result.items
    voice = record.audio["voice"]
    assert Path(result.audio_tracks[voice].source.path).name == "v1.ogg"
    reasons = [r.reason for _rel, p in parses for r in p.reports]
    assert any(r.startswith("voice before an extend line") for r in reasons)


# --- item 9b (b): Character names ---------------------------------------------

@pytest.mark.parametrize("line, named", [
    ('define a = Character("Ana")', ("a", "Ana")),
    ('define a = Character( "Ana", color="#fff")', ("a", "Ana")),
    ("define a = Character('Ana')", ("a", "Ana")),
    ('define c = Character(_("Crowd"), color="#fff")', ("c", "Crowd")),
    ('define c = Character(__("Crowd"))', ("c", "Crowd")),
    ('define c = Character(color="#fff", name=_("Mo"))', ("c", "Mo")),
    ('define c = Character(name="Mo")', ("c", "Mo")),
    ('define b = Character("[b_name]", color="#111")', ("b", "[b_name]")),
    ('define p = DynamicCharacter("povname", color="#f00")',
     ("p", "[povname]")),
    ('define p = Character("store.pn", dynamic=True)', ("p", "[store.pn]")),
    ('define x = Character(name_var)', None),
    ('define x = Character(None)', None),
    # An expression starting with a literal gives the literal, as
    # before item 9b (item 9c).
    ('define x = Character(_("A") + suffix)', ("x", "A")),
    ('define a = Character("Ana" + x)', ("a", "Ana")),
    ('define a = Character("Ana " + str(n), color="#fff")', ("a", "Ana ")),
    ("define a = Character('Ana' + x)", ("a", "Ana")),
    ('define a = Character(name="Ana" + x)', ("a", "Ana")),
    ('define x = Character(prefix + "Ana")', None),
    ('define x = Character(_("A" + suffix))', None),
    ('define p = Character("pn" + x, dynamic=True)', None),
    ('define p = DynamicCharacter(_("povname"))', None),
    ('define x = Character("Unclosed"', None),
    ('define x = 3', None),
])
def test_character_names(line: str, named: tuple[str, str] | None) -> None:
    assert character_name(line) == named


def test_wrapped_names_are_speakers_strings_blocks_translate(
        tmp_path: Path) -> None:
    game = tmp_path / "game"
    write(game / "script.rpy",
          'define c = Character(_("Crowd"), color="#fff")\n'
          'define m = Character(\n'
          '    name=__("Megan"),\n'
          '    color="#f0f")\n'
          'define b = Character("[b_name]")\n'
          'label start:\n'
          '    scene black\n'
          '    c "Cheers."\n'
          '    m "Hello."\n'
          '    b "Hi."\n')
    write(game / "tl" / "de" / "names.rpy",
          'translate de strings:\n'
          '    old "Crowd"\n    new "Menge"\n'
          '    old "Megan"\n    new "Megan"\n')
    records = walk(game)
    # The Character call over several lines is no narration of its own.
    assert [(r.item.get("speaker"), r.item["text"]) for r in records] == [
        ("Crowd", "Cheers."), ("Megan", "Hello."), ("[b_name]", "Hi.")]
    project = tl.read_project(game, records)
    manifest = {"items": [r.item for r in records]}
    files, stats, _warnings = tl.language_files(manifest, records, [],
                                                [project], None)
    assert files == [{"language": "de",
                      "speakers": {"Crowd": "Menge", "Megan": "Megan"}}]
    assert stats["de"].strings_used == 2


def test_names_starting_with_a_literal_are_speakers(tmp_path: Path) -> None:
    """A name expression starting with a literal speaks as that literal
    (item 9c), as before item 9b."""
    game = tmp_path / "game"
    write(game / "script.rpy",
          'define a = Character("Ana" + suffix)\n'
          'define c = Character(_("Crowd") + suffix)\n'
          'label start:\n'
          '    scene black\n'
          '    a "Hi."\n'
          '    c "Cheers."\n')
    assert [(r.item.get("speaker"), r.item["text"]) for r in walk(game)] == [
        ("Ana", "Hi."), ("Crowd", "Cheers.")]


# --- item 9b (c): --base-language ---------------------------------------------

def text_project(tmp_path: Path, script: str,
                 tl_files: dict[str, str]) -> Path:
    game = tmp_path / "proj" / "game"
    write(game / "script.rpy", script)
    game.joinpath("images").mkdir()
    Image.new("RGB", (32, 18), (40, 60, 80)).save(game / "images" / "bg.png")
    for rel, text in tl_files.items():
        write(game / "tl" / rel, text)
    return game.parent


JA_SCRIPT = ('define k = Character("Kenji")\n'      # 1
             'label start:\n'                       # 2
             '    scene bg\n'                       # 3
             '    k "Konnichiwa."\n'                # 4
             '    "Ame ga furu."\n')                # 5


def test_base_language_names_the_games_own_language(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    hello = ident("start", 'k "Konnichiwa."')
    project = text_project(tmp_path, JA_SCRIPT, {
        "english/script.rpy":
            f'# game/script.rpy:4\ntranslate english {hello}:\n'
            '    # k "Konnichiwa."\n    k "Hello."\n\n'
            'translate english strings:\n'
            '    old "Kenji"\n    new "Kenji"\n',
        "japanese/script.rpy":
            f'translate japanese {hello}:\n    k "Konnichiwa!"\n'})
    out = tmp_path / "out"
    assert cli_main([str(project), str(out), "--base-language", "JA"]) == 0
    printed = capsys.readouterr().out
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    assert manifest["language"] == "ja"
    assert manifest["languages"] == ["en"]
    en = lang_file(out, "en")
    assert en["items"] == {"bg-001": {"text": "Hello.",
                                        "from": sha8("Konnichiwa.")}}
    assert en["speakers"] == {"Kenji": "Kenji"}
    assert ("warning: translations: game/tl language 'japanese' is ja, the "
            "manifest's base language: skipped") in printed
    # Of the title, the speaker and the two lines.
    assert validator_coverage(out) == {"en": (2, 4, 0, 0)}


def test_without_base_language_english_is_skipped(tmp_path: Path) -> None:
    hello = ident("start", 'k "Konnichiwa."')
    project = text_project(tmp_path, JA_SCRIPT, {
        "english/script.rpy":
            f'translate english {hello}:\n    k "Hello."\n'})
    out = tmp_path / "out"
    with redirect_stdout(StringIO()):
        assert cli_main([str(project), str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    assert "language" not in manifest and "languages" not in manifest


def test_cli_refuses_a_malformed_base_language(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        cli_main([str(FIXTURE), str(tmp_path / "out"),
                  "--base-language", "japanese"])
    assert exc.value.code == 2
    assert "BCP 47 language tag" in capsys.readouterr().err


# --- item 9b (d): blocks of changed English kept as stale ---------------------

STALE_SCRIPT = ('label start:\n'                         # 1
                '    scene black\n'                      # 2
                '    e "Hello there."\n'                 # 3
                '    e "The new second line."\n'         # 4
                'label other:\n'                         # 5
                '    e "Third, rewritten."\n'            # 6
                '    f "Fourth, rewritten."\n')          # 7


def stale_block(line: int, label: str, code: str, new: str,
                identifier: str | None = None) -> str:
    identifier = identifier or ident(label, code)
    return (f'# game/script.rpy:{line}\ntranslate de {identifier}:\n'
            f'    # {code}\n    {new}\n\n')


def test_changed_english_is_kept_as_stale(tmp_path: Path) -> None:
    """The identifier names no statement (the English changed), the
    comment's line has the same speaker in the same label, and the code
    Ren'Py commented in the block hashes to the identifier: the
    translation is kept, made from the old English."""
    game = tmp_path / "game"
    write(game / "script.rpy", STALE_SCRIPT)
    write(game / "tl" / "de" / "script.rpy",
          stale_block(3, "start", 'e "Hello."', 'e "Hallo."')
          # Another speaker at the comment's line: not the same line.
          + stale_block(7, "other", 'e "Fourth."', 'e "Vierter."')
          # The identifier's label is not the label there now.
          + stale_block(6, "start", 'e "Third."', 'e "Dritter."')
          # The commented code does not hash to the identifier.
          + stale_block(4, "start", 'e "The second line."', 'e "Zweite."',
                        identifier="start_0badc0de"))
    records = walk(game)
    project = tl.read_project(game, records)
    hello = records[0]
    assert hello.translations == {"de": "Hallo."}
    assert hello.translation_bases == {"de": "Hello."}
    assert [r.translations for r in records[1:]] == [{}, {}, {}]
    s = project.stats["de"]
    assert (s.blocks, s.matched, s.kept_stale, s.unmatched) == (4, 0, 1, 3)
    manifest = {"items": [r.item for r in records if not r.skipped]}
    files, stats, _w = tl.language_files(manifest, records, [], [project],
                                         None)
    assert files[0]["items"] == {
        hello.item["id"]: {"text": "Hallo.", "from": sha8("Hello.")}}
    assert stats["de"].stale == 1
    lines = tl.summary_lines(stats, ["de"], [])
    assert "kept as stale 1" in lines[1]
    assert "1 of 6 strings (16.6%), 1 stale, 0 unchecked" in lines[2]


def test_a_current_block_wins_over_a_stale_one(tmp_path: Path) -> None:
    """Ren'Py's generator adds a block for the new English and leaves the
    old one: the current translation is the one kept, whatever the
    order."""
    game = tmp_path / "game"
    write(game / "script.rpy", STALE_SCRIPT)
    write(game / "tl" / "de" / "script.rpy",
          stale_block(3, "start", 'e "Hello."', 'e "Hallo."')
          + stale_block(3, "start", 'e "Hello there."', 'e "Hallo du."'))
    records = walk(game)
    project = tl.read_project(game, records)
    assert records[0].translations == {"de": "Hallo du."}
    assert records[0].translation_bases == {}
    s = project.stats["de"]
    assert (s.matched, s.kept_stale, s.duplicates) == (1, 0, 1)


# --- item 9b (e): tl/ inside .rpa archives ------------------------------------

def test_tl_inside_archives_is_read_like_loose_files(tmp_path: Path) -> None:
    """tl/ scripts inside an archive are read; a loose file wins over an
    archived one with the same path; a compiled-only script is counted,
    not read; other members are replacement files. Scripts inside an
    archive give identifiers for the lines the walk read from it."""
    from test_rpa import write_rpa
    rpa_mod.reset_cache()
    game = tmp_path / "game"
    # The walk follows labels (Phase 57 item 4e): start jumps to the
    # archived chapter, which file order used to append unreached.
    write(game / "script.rpy", 'label start:\n    scene black\n'
                               '    e "Loose line."\n    jump chapter\n')
    loose = ident("start", 'e "Loose line."')
    archived = ident("chapter", 'e "Archived line."')
    write(game / "tl" / "de" / "script.rpy",
          f'translate de {loose}:\n    e "Lose Zeile."\n')
    write_rpa(game / "scripts.rpa", {
        "chapter.rpy": b'label chapter:\n    e "Archived line."\n',
        "tl/de/script.rpy": f'translate de {loose}:\n'
                            '    e "Shadowed."\n'.encode(),
        "tl/de/chapter.rpy": f'# game/chapter.rpy:2\n'
                             f'translate de {archived}:\n'
                             '    e "Archivierte Zeile."\n'
                             'translate de strings:\n'
                             '    old "Go"\n    new "Los"\n'.encode(),
        "tl/de/screens.rpyc": b"compiled only",
        "tl/de/images/sign.png": b"replacement",
        "tl/__pycache__/x.rpyb": b"cache",
    })
    read = tl.read_tl(game)
    assert list(read) == ["de"]
    de = read["de"]
    assert [(b.identifier, b.source, b.texts) for b in de.blocks] == [
        (archived, "game/scripts.rpa!tl/de/chapter.rpy:2",
         ["Archivierte Zeile."]),
        (loose, "game/tl/de/script.rpy:1", ["Lose Zeile."])]
    assert de.strings == {"Go": "Los"}
    assert (de.compiled_only, de.replacement_files) == (1, 1)
    parses, defs, chars, _sources = parse_project(game)
    records = build_timeline(parses, defs, chars, game).items
    assert [r.text_source for r in records] == [
        "game/script.rpy:3", "game/scripts.rpa!chapter.rpy:2"]
    project = tl.read_project(game, records)
    assert [r.translations.get("de") for r in records] == [
        "Lose Zeile.", "Archivierte Zeile."]
    assert project.stats["de"].matched == 2


# --- item 9c: an archived .rpy/.rpyc pair -------------------------------------

def test_archived_pair_gives_one_item_per_line_translated_once(
        tmp_path: Path) -> None:
    """An archive holding a script's .rpy and its .rpyc walks the .rpy
    only, so each line is one item, and its translation matches it once."""
    from test_rpa import FIXTURE_RPYC, write_rpa
    rpa_mod.reset_cache()
    game = tmp_path / "game"
    game.mkdir()
    # The .rpyc twin (the credits fixture) opens on `scene credits_1`:
    # defined here, so a walked twin would make items of its lines.
    Image.new("RGB", (32, 18), (40, 60, 80)).save(game / "bg.png")
    line = ident("credits", 'nr "From the source."')
    write_rpa(game / "scripts.rpa", {
        "credits.rpy": b'define nr = Character(None)\n'
                       b'image credits_1 = "bg.png"\n'
                       b'label credits:\n    scene credits_1\n'
                       b'    nr "From the source."\n',
        "credits.rpyc": FIXTURE_RPYC.read_bytes(),
        "tl/de/credits.rpy": f'translate de {line}:\n'
                             '    nr "Aus der Quelle."\n'.encode(),
    })
    records = walk(game)
    assert [(r.text_source, r.item["text"]) for r in records] == [
        ("game/scripts.rpa!credits.rpy:5", "From the source.")]
    project = tl.read_project(game, records)
    assert records[0].translations == {"de": "Aus der Quelle."}
    s = project.stats["de"]
    assert (s.blocks, s.matched, s.duplicates) == (1, 1, 0)


# --- item 9d: only walked scripts feed identifiers ---------------------------

def test_unwalked_loose_script_feeds_no_identifiers(tmp_path: Path) -> None:
    """A loose script Ren'Py does not load (in a folder whose name starts
    with `.`) is not walked, so its lines take no identifiers: here its
    copy of the opening line would have taken the identifier first
    (loaded before script.rpy) and left the walked line with `_1`,
    untranslated."""
    rpa_mod.reset_cache()
    game = tmp_path / "game"
    write(game / "script.rpy", 'label start:\n    e "Hello."\n')
    write(game / ".extra" / "old.rpy", 'label start:\n    e "Hello."\n')
    hello = ident("start", 'e "Hello."')
    write(game / "tl" / "de" / "script.rpy",
          f'translate de {hello}:\n    e "Hallo."\n')
    assert [s.rel for s in tl.source_files(game)] == ["game/script.rpy"]
    records = walk(game)
    project = tl.read_project(game, records)
    assert [r.translations.get("de") for r in records] == ["Hallo."]
    assert project.stats["de"].matched == 1


def test_loose_subfolder_script_shadows_archived_identifiers(
        tmp_path: Path) -> None:
    """A loose script in a subfolder is walked (Phase 57 item 4b) and
    beats the archived script with its key: its lines take the
    identifiers and their translations."""
    from test_rpa import write_rpa
    rpa_mod.reset_cache()
    game = tmp_path / "game"
    write(game / "chapters" / "one.rpy",
          'label start:\n    jump one\nlabel one:\n    e "Loose line."\n')
    line = ident("one", 'e "Loose line."')
    write_rpa(game / "scripts.rpa", {
        "chapters/one.rpy": b'label start:\n    jump one\n'
                            b'label one:\n    e "Archived line."\n',
        "tl/de/one.rpy": f'translate de {line}:\n'
                         '    e "Lose Zeile."\n'.encode(),
    })
    assert [s.rel for s in tl.source_files(game)] == [
        "game/chapters/one.rpy"]
    records = walk(game)
    assert [r.text_source for r in records] == ["game/chapters/one.rpy:4"]
    tl.read_project(game, records)
    assert records[0].translations == {"de": "Lose Zeile."}


def test_files_decides_the_scripts_feeding_identifiers(
        tmp_path: Path) -> None:
    """--files that reaches a subfolder walks its scripts, and they feed
    identifiers; one that leaves a script out leaves its lines out."""
    rpa_mod.reset_cache()
    game = tmp_path / "game"
    write(game / "script.rpy", 'label start:\n    jump side\n')
    write(game / "extra" / "side.rpy", 'label side:\n    e "Aside."\n')
    aside = ident("side", 'e "Aside."')
    write(game / "tl" / "de" / "side.rpy",
          f'translate de {aside}:\n    e "Beiseite."\n')
    assert [s.rel for s in tl.source_files(game, "**/*.rpy")] == [
        "game/extra/side.rpy", "game/script.rpy"]
    assert [s.rel for s in tl.source_files(game, "script.rpy")] == [
        "game/script.rpy"]
    parses, defs, chars, _sources = parse_project(game, "**/*.rpy")
    records = build_timeline(parses, defs, chars, game).items
    tl.read_project(game, records, files_glob="**/*.rpy")
    assert [r.translations.get("de") for r in records] == ["Beiseite."]
