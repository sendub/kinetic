"""kinetic-extract reads Ren'Py translations (docs/plan.md Phase 54 item
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
from kinetic_extract import translations as tl
from kinetic_extract.cli import main as cli_main
from kinetic_extract.images import ImplicitImages
from kinetic_extract.parser import parse_project
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
    texts = [(name, path.read_text("utf-8"))
             for name, path in tl.source_files(GAME)]
    assert [name for name, _text in texts] == ["game/script.rpy"]
    by_say = {g.say_line: g.identifier for g in tl.source_groups(texts)}
    assert by_say[27] == ident("start", 'a "Welcome to the house."')
    assert by_say[29] == ident("start", 'voice "voice/viktor-01.mp3"',
                               'Viktor "The lights are dim. [greeting]?"')
    assert by_say[43] == ident("start", '"Тишина в саду. [wind]"')
    good_night = ident("inside", 'd "Good night."')
    assert (by_say[75], by_say[77]) == (good_night, good_night + "_1")


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
        "line-014": "Gute Nacht.",                          # suffix _1
        "talk-020": "Der Fernseher summt mit.",             # comment only
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
    zh = lang_file(demo["out"], "zh-Hans")
    assert {k: v["text"] for k, v in zh["items"].items()} == {
        "bg-room-001": "欢迎来到这所房子。"}
    assert not (demo["out"] / "lang" / "klingon.json").exists()
    assert (demo["out"] / "lang.schema.json").read_bytes() == \
        (REPO_ROOT / "docs" / "lang.schema.json").read_bytes()


def test_demo_output_validates_with_coverage(demo: dict) -> None:
    proc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "validate_content.py"),
         str(demo["out"])], capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout.strip() == ""
    assert "de: 12 of 28 strings (42.8%), 0 stale, 0 unchecked" in \
        proc.stderr
    assert "zh-Hans: 1 of 28 strings (3.5%), 0 stale, 0 unchecked" in \
        proc.stderr


def test_demo_report(demo: dict) -> None:
    printed = demo["printed"]
    assert ("warning: translations: game/tl language 'klingon' is not a "
            "known language name: skipped; --language-map klingon=TAG") \
        in printed
    assert ("translations: 2 language file(s) written (de, zh-Hans); "
            "skipped: klingon (unknown name)") in printed
    assert ("  de (tl/de): dialogue blocks 12: matched to items 8 (by "
            "comment only 1), lines not in the story 2, pass or empty 1, "
            "unmatched 1; identifier and comment: agree 10, disagree 0, "
            "no comment 0") in printed
    assert ("    strings used 4 of 5; several lines joined 1, duplicates 0, "
            "same as the base text 0; coverage de: 12 of 28 strings "
            "(42.8%), 0 stale, 0 unchecked; ignored: style blocks 1, "
            "python blocks 1, replacement files 1") in printed
    assert ("    unmatched: game/tl/de/script.rpy:77 (inside_deadbeef)"
            in printed)
    ledger = demo["ledger"]["translations"]
    assert ledger["skipped"] == ["klingon (unknown name)"]
    de = ledger["languages"]["de"]
    assert (de["name"], de["blocks"], de["matched"], de["done"],
            de["total"]) == ("de", 12, 8, 12, 28)


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
