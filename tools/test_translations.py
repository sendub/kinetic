"""Tests for tools/translations.py (docs/plan.md Phase 56, item 8). Run with:

    .venv/bin/pytest tools/test_translations.py -q -n auto

The language demo (fixtures/build_lang_demo.py: German, Japanese and
Arabic; German missing `floor-2` and stale on `text-thought`) is built
once per worker into a temporary folder; each test works on a copy.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import translations  # noqa: E402
import validate_content  # noqa: E402
from kinetic_extract import language_file, po  # noqa: E402
from kinetic_extract.schema_copy import (  # noqa: E402
    LANG_COPY_NAME, LANG_SCHEMA_FILE, LANG_SCHEMA_REF, SCHEMA_REF)
from kinetic_extract.version import kinetic_version  # noqa: E402

STORY = "kinetic-lang-demo"
STALE_ID = "text-thought"
MISSING_ID = "floor-2"


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("built") / "lang-demo"
    proc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "fixtures" / "build_lang_demo.py"),
         "--out", str(out)], cwd=REPO_ROOT, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return out


@pytest.fixture
def game(built: Path, tmp_path: Path) -> Path:
    copy = tmp_path / "game"
    shutil.copytree(built, copy)
    return copy


def run(*args: object) -> int:
    return translations.main([str(a) for a in args])


def manifest_of(folder: Path) -> dict:
    return json.loads((folder / "manifest.json").read_text("utf-8"))


def lang_of(folder: Path, tag: str) -> dict:
    return json.loads((folder / "lang" / f"{tag}.json").read_text("utf-8"))


def export(folder: Path, tag: str, tmp_path: Path) -> po.Catalog:
    out = tmp_path / f"{tag}.po"
    assert run("export", folder, tag, "--out", out, "--force") == 0
    return po.read(out)


def by_context(catalog: po.Catalog) -> dict[str, po.Entry]:
    return {e.msgctxt: e for e in catalog.entries if not e.obsolete}


def write_po(catalog: po.Catalog, path: Path) -> Path:
    path.write_text(po.dumps(catalog), encoding="utf-8")
    return path


def save_manifest(folder: Path, manifest: dict) -> None:
    text = json.dumps(manifest, indent=2) + "\n"
    translations.write_manifest(folder, text)


def snapshot(folder: Path) -> dict[str, bytes]:
    return {p.relative_to(folder).as_posix(): p.read_bytes()
            for p in sorted(folder.rglob("*")) if p.is_file()}


# --- export ------------------------------------------------------------------

def expected_contexts(manifest: dict) -> list[str]:
    """Story order, written out from the demo: title, version, items in
    order with a speaker before their first line, decisions after the
    item they open on."""
    out = ["title", "version"]
    speakers: set[str] = set()
    opens = {b["after"]: b for b in manifest["branches"]}
    for item in manifest["items"]:
        if item.get("text", "").strip():
            speaker = item.get("speaker")
            if speaker and speaker not in speakers:
                speakers.add(speaker)
                out.append(f"speaker:{speaker}")
            out.append(f"item:{item['id']}")
        branch = opens.get(item["id"])
        if branch:
            out.append(f"prompt:{branch['id']}")
            out += [f"label:{branch['id']}/{r['id']}"
                    for r in branch["routes"]]
    return out


def test_export_has_every_string_in_story_order(
        game: Path, tmp_path: Path) -> None:
    catalog = export(game, "de", tmp_path)
    manifest = manifest_of(game)
    contexts = [e.msgctxt for e in catalog.entries]
    assert contexts == expected_contexts(manifest)
    assert contexts.count("speaker:Mei") == 1
    assert contexts.count("speaker:Theo") == 1
    # The same strings the validator counts.
    _unlisted, reports = validate_content.language_reports(manifest, game)
    assert len(contexts) == reports[0].total
    # The outer decision opens before the nested one in story order.
    assert contexts.index("prompt:outer") < contexts.index("prompt:nested")


def test_export_header(game: Path, tmp_path: Path) -> None:
    catalog = export(game, "de", tmp_path)
    assert catalog.header == {
        "Project-Id-Version": "Kinetic language demo",
        "Language": "de",
        "MIME-Version": "1.0",
        "Content-Type": "text/plain; charset=UTF-8",
        "Content-Transfer-Encoding": "8bit",
        "X-Kinetic-Story": STORY,
        "X-Kinetic-Base": "en",
        "X-Generator": f"Kinetic {kinetic_version()}",
    }


def test_export_msgids_msgstrs_and_flags(game: Path, tmp_path: Path) -> None:
    entries = by_context(export(game, "de", tmp_path))
    manifest = manifest_of(game)
    german = lang_of(game, "de")
    texts = {i["id"]: i["text"] for i in manifest["items"] if i.get("text")}
    for item_id, text in texts.items():
        entry = entries[f"item:{item_id}"]
        assert entry.msgid == text
        expected = german["items"].get(item_id, {}).get("text", "")
        assert entry.msgstr == expected
    assert entries[f"item:{MISSING_ID}"].msgstr == ""
    assert [c for c, e in entries.items() if e.fuzzy] == [f"item:{STALE_ID}"]
    assert entries["speaker:Mei"].msgstr == "Mei"
    assert entries["prompt:outer"].msgid == "Demo decision: which route?"
    assert entries["prompt:outer"].msgstr == german["decisions"]["outer"][
        "prompt"]["text"]
    assert entries["label:nested/nest-b"].msgstr == german["decisions"][
        "nested"]["routes"]["nest-b"]["text"]
    assert entries["title"].msgstr == german["title"]["text"]
    assert entries["version"].msgstr == german["version"]["text"]


def test_export_comments_give_context(game: Path, tmp_path: Path) -> None:
    entries = by_context(export(game, "de", tmp_path))
    thought = entries["item:text-thought"].extracted_comments
    assert thought[0] == "Speaker: Mei"
    assert thought[1] == ("Item: text-thought, a text item; a thought, not "
                          "said aloud")
    assert [c.split(":")[0] for c in thought[2:6]] == [
        "Before", "Before", "After", "After"]
    assert thought[3].startswith("Before: text-speech: Spoken dialogue")
    assert thought[4].startswith("After: text-narration: ")
    assert all(len(c) < 100 for c in thought)
    assert thought[-1] == "Base length: 60 characters."
    first = entries["item:intro-title"].extracted_comments
    assert first[0] == "Speaker: none (narration)"
    assert first[1] == "Item: intro-title, an image item"
    assert first[2].startswith("After: ")  # nothing before the first line
    # The innermost route: nest-continue sits in route1 and in nest-a.
    nested = entries["item:nest-continue"].extracted_comments
    assert 'In route nest-a of decision nested: "1a: carries on with ' \
        'Route 1"' in nested
    assert not any("route1" in c and c.startswith("In route")
                   for c in nested)
    assert any(c.startswith("In route route1 of decision outer")
               for c in entries["item:route1-start"].extracted_comments)
    assert "Decision nested opens after this line." in \
        entries["item:route1-nest"].extracted_comments
    prompt = entries["prompt:outer"].extracted_comments
    assert prompt[-1] == ("Base length: 27 characters; a translation must "
                          "be shorter than 200.")
    label = entries["label:outer/route1"].extracted_comments
    assert label[0].startswith("Route route1 of decision outer, items "
                               "route1-start to route1-end")
    assert label[-1].endswith("must be shorter than 120.")
    assert entries["speaker:Theo"].extracted_comments[0].startswith(
        "A speaker's name")
    assert entries["title"].extracted_comments[-1].endswith(
        "may have at most 200.")


def test_export_of_a_new_language_is_all_empty(
        game: Path, tmp_path: Path) -> None:
    catalog = export(game, "fr", tmp_path)
    assert catalog.header["Language"] == "fr"
    assert all(e.msgstr == "" and not e.fuzzy and not e.obsolete
               for e in catalog.entries)


def test_export_default_path_and_overwrite(
        game: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str]) -> None:
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)
    assert run("export", game, "ja") == 0
    target = work / f"{STORY}.ja.po"
    assert target.is_file()
    assert capsys.readouterr().out == (
        f"wrote {target}: 44 strings, 44 translated, 0 fuzzy, 0 obsolete\n")
    target.write_text("translator's unimported work")
    assert run("export", game, "ja") == 1
    assert target.read_text() == "translator's unimported work"
    assert "--force" in capsys.readouterr().err
    assert run("export", game, "ja", "--force") == 0
    assert po.read(target).header["Language"] == "ja"
    # Standard output.
    capsys.readouterr()
    assert run("export", game, "ja", "--out", "-") == 0
    out = capsys.readouterr()
    assert po.parse(out.out).header["Language"] == "ja"
    assert "44 strings" in out.err


def test_export_without_story_id_names_the_folder(
        game: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manifest = manifest_of(game)
    del manifest["storyId"]
    save_manifest(game, manifest)
    monkeypatch.chdir(tmp_path)
    assert run("export", game, "de") == 0
    catalog = po.read(tmp_path / "game.de.po")
    assert catalog.header["X-Kinetic-Story"] == "Kinetic language demo"


@pytest.mark.parametrize("tag, status, why", [
    ("english", 2, "not a language tag"),
    ("pt-br", 2, "'pt-BR'"),
    ("de_DE", 2, "not a language tag"),
    ("en", 1, "the game's own language"),
])
def test_export_refuses_a_bad_tag(game: Path, tmp_path: Path, tag: str,
                                  status: int, why: str,
                                  capsys: pytest.CaptureFixture[str]) -> None:
    assert run("export", game, tag, "--out", tmp_path / "x.po") == status
    assert why in capsys.readouterr().err
    assert not (tmp_path / "x.po").exists()


def test_export_refuses_a_folder_without_a_manifest(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert run("export", tmp_path, "de") == 1
    assert "not a game folder" in capsys.readouterr().err


# --- import ------------------------------------------------------------------

def test_an_unchanged_round_trip_reproduces_the_files(
        game: Path, tmp_path: Path) -> None:
    before = snapshot(game)
    for tag in ("de", "ja", "ar"):
        path = tmp_path / f"{tag}.po"
        assert run("export", game, tag, "--out", path) == 0
        assert run("import", game, path) == 0
    assert snapshot(game) == before


def test_a_translated_file_imports_and_validates(
        game: Path, tmp_path: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    catalog = export(game, "fr", tmp_path)
    for entry in catalog.entries:
        entry.msgstr = f"FR {entry.msgid}"[:110]
    by_context(catalog)["speaker:Mei"].msgstr = "Mei"  # kept as is: allowed
    capsys.readouterr()
    assert run("import", game, write_po(catalog, tmp_path / "fr.po")) == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0] == ("wrote lang/fr.json and lang/fr.js: 44 translations "
                      "from fr.po")
    assert out[1] == ("added fr to manifest.json languages and rewrote "
                      "manifest.js")
    assert out[-1] == (f"{game}: fr: 44 of 44 strings (100%), 0 stale, "
                       "0 unchecked")
    assert validate_content.validate_folder(game) == []
    manifest = manifest_of(game)
    # The demo's list is not sorted, so the new tag goes last.
    assert manifest["languages"] == ["de", "ja", "ar", "fr"]
    shim = (game / "manifest.js").read_text("utf-8")
    text = (game / "manifest.json").read_text("utf-8")
    assert shim == f"{validate_content.SHIM_PREFIX}{text.strip()};\n"
    french = lang_of(game, "fr")
    assert list(french) == ["language", "title", "version", "speakers",
                            "items", "decisions"]
    assert french["speakers"] == {"Mei": "Mei", "Theo": "FR Theo",
                                  "Ines": "FR Ines"}
    texts = {i["id"]: i["text"] for i in manifest["items"] if i.get("text")}
    for item_id, entry in french["items"].items():
        assert entry == {"text": f"FR {texts[item_id]}"[:110],
                         "from": language_file.base_hash(texts[item_id])}
    assert list(french["items"]) == list(texts)
    assert list(french["decisions"]) == ["nested", "outer"]


def test_a_new_tag_keeps_a_sorted_list_sorted(
        game: Path, tmp_path: Path) -> None:
    manifest = manifest_of(game)
    manifest["languages"] = ["ar", "de", "ja"]
    save_manifest(game, manifest)
    catalog = export(game, "fr", tmp_path)
    assert run("import", game, write_po(catalog, tmp_path / "fr.po")) == 0
    assert manifest_of(game)["languages"] == ["ar", "de", "fr", "ja"]


def test_the_manifest_is_untouched_when_the_tag_is_listed(
        game: Path, tmp_path: Path) -> None:
    before = (game / "manifest.json").read_bytes()
    catalog = export(game, "de", tmp_path)
    by_context(catalog)[f"item:{MISSING_ID}"].msgstr = "Kurze Zeile zwei."
    assert run("import", game, write_po(catalog, tmp_path / "de.po")) == 0
    assert (game / "manifest.json").read_bytes() == before
    assert lang_of(game, "de")["items"][MISSING_ID]["text"] == \
        "Kurze Zeile zwei."


def stale_count(folder: Path, tag: str) -> int:
    _unlisted, reports = validate_content.language_reports(
        manifest_of(folder), folder)
    return next(r.stale for r in reports if r.tag == tag)


def test_a_base_change_marks_fuzzy_and_imports_as_stale(
        game: Path, tmp_path: Path) -> None:
    manifest = manifest_of(game)
    item = next(i for i in manifest["items"] if i["id"] == "text-speech")
    old_from = lang_of(game, "de")["items"]["text-speech"]["from"]
    item["text"] = "Spoken dialogue, reworded: the name sits above it."
    save_manifest(game, manifest)
    assert stale_count(game, "de") == 2
    catalog = export(game, "de", tmp_path)
    entries = by_context(catalog)
    assert entries["item:text-speech"].fuzzy
    assert entries["item:text-speech"].msgid == item["text"]
    # Re-imported as exported: still stale, the old `from` kept.
    assert run("import", game, write_po(catalog, tmp_path / "de.po")) == 0
    assert lang_of(game, "de")["items"]["text-speech"]["from"] == old_from
    assert stale_count(game, "de") == 2
    # A translator reviews it and clears the flag: no longer stale.
    entries["item:text-speech"].flags.remove("fuzzy")
    entries["item:text-speech"].msgstr = "Gesprochener Dialog, neu."
    assert run("import", game, write_po(catalog, tmp_path / "de.po")) == 0
    assert lang_of(game, "de")["items"]["text-speech"] == {
        "text": "Gesprochener Dialog, neu.",
        "from": language_file.base_hash(item["text"])}
    assert stale_count(game, "de") == 1


def test_a_fuzzy_flag_on_a_current_translation_makes_it_stale(
        game: Path, tmp_path: Path) -> None:
    catalog = export(game, "ja", tmp_path)
    by_context(catalog)["item:floor-3"].flags.append("fuzzy")
    assert run("import", game, write_po(catalog, tmp_path / "ja.po")) == 0
    assert lang_of(game, "ja")["items"]["floor-3"]["from"] == \
        translations.NEVER_MATCHES
    assert stale_count(game, "ja") == 1


def test_a_po_from_before_a_base_change_imports_as_stale(
        game: Path, tmp_path: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    """A non-fuzzy entry records the hash of its msgid, the text it was
    translated from, so a PO file older than the game's text is stale."""
    catalog = export(game, "ja", tmp_path)
    manifest = manifest_of(game)
    item = next(i for i in manifest["items"] if i["id"] == "floor-3")
    old = item["text"]
    item["text"] = "Line three waits, reworded."
    save_manifest(game, manifest)
    capsys.readouterr()
    assert run("import", game, write_po(catalog, tmp_path / "ja.po")) == 0
    assert "has changed since this PO file was exported" in \
        capsys.readouterr().err
    assert lang_of(game, "ja")["items"]["floor-3"]["from"] == \
        language_file.base_hash(old)
    assert stale_count(game, "ja") == 1


def rewrapped(text: str) -> str:
    """`text` with every string written on one line (as some editors
    save it), and long ones then split into quoted pieces of 30
    characters: wrapping unlike the export's."""
    out: list[str] = []
    for line in text.split("\n"):
        if line.startswith('"') and out and not out[-1].startswith("#"):
            prev = out.pop()
            keyword, _, literal = prev.partition(" ")
            joined = po.unquote(literal) + po.unquote(line)
            out.append(f"{keyword} {po.quote(joined)}")
        else:
            out.append(line)
    final: list[str] = []
    for line in out:
        keyword, _, literal = line.partition(" ")
        if keyword in ("msgid", "msgstr") and len(line) > 79:
            value = po.unquote(literal)
            pieces = [value[i:i + 30] for i in range(0, len(value), 30)]
            final.append(f"{keyword} {po.quote(pieces[0])}")
            final += [po.quote(p) for p in pieces[1:]]
        else:
            final.append(line)
    return "\n".join(final).replace("\n", "\r\n")


def test_a_rewrapped_po_imports_the_same(game: Path, tmp_path: Path) -> None:
    path = tmp_path / "de.po"
    assert run("export", game, "de", "--out", path) == 0
    text = path.read_text("utf-8")
    other = rewrapped(text)
    assert other.replace("\r\n", "\n") != text
    plain, odd = po.parse(text), po.parse(other)
    assert [(e.msgctxt, e.msgid, e.msgstr, e.flags) for e in odd.entries] == \
        [(e.msgctxt, e.msgid, e.msgstr, e.flags) for e in plain.entries]
    before = snapshot(game)
    path.write_bytes(("﻿" + other).encode("utf-8"))
    assert run("import", game, path) == 0
    assert snapshot(game) == before


def test_obsolete_entries_kept_on_export_ignored_on_import(
        game: Path, tmp_path: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    german = lang_of(game, "de")
    german["items"]["gone-item"] = {"text": "Eine gestrichene Zeile.",
                                    "from": "12345678"}
    german["speakers"]["Ghost"] = "Geist"
    german["decisions"]["outer"]["routes"]["route9"] = {"text": "Weg 9"}
    language_file.write_language_file(game, german)
    catalog = export(game, "de", tmp_path)
    gone = [e for e in catalog.entries if e.obsolete]
    assert [(e.msgctxt, e.msgstr) for e in gone] == [
        ("speaker:Ghost", "Geist"),
        ("item:gone-item", "Eine gestrichene Zeile."),
        ("label:outer/route9", "Weg 9")]
    text = (tmp_path / "de.po").read_text("utf-8")
    assert '#~ msgctxt "item:gone-item"' in text
    capsys.readouterr()
    assert run("import", game, tmp_path / "de.po") == 0
    assert "gone-item" not in capsys.readouterr().err
    german = lang_of(game, "de")
    assert "gone-item" not in german["items"]
    assert "Ghost" not in german["speakers"]
    assert "route9" not in german["decisions"]["outer"]["routes"]
    assert validate_content.validate_folder(game) == []


def test_unknown_contexts_warn_and_are_skipped(
        game: Path, tmp_path: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    catalog = export(game, "de", tmp_path)
    catalog.entries += [
        po.Entry(msgctxt="item:no-such", msgid="x", msgstr="y"),
        po.Entry(msgid="no context", msgstr="kein Kontext")]
    capsys.readouterr()
    assert run("import", game, write_po(catalog, tmp_path / "de.po")) == 0
    err = capsys.readouterr().err
    assert 'the game has no string "item:no-such"; skipped' in err
    assert "an entry with no msgctxt" in err
    assert "no-such" not in json.dumps(lang_of(game, "de"))


def test_an_emptied_msgstr_removes_the_translation_others_are_kept(
        game: Path, tmp_path: Path) -> None:
    catalog = export(game, "de", tmp_path)
    by_context(catalog)["item:floor-3"].msgstr = ""
    # Strings the PO file does not mention keep the file's translation.
    catalog.entries = [e for e in catalog.entries
                       if e.msgctxt != "item:floor-clip"]
    assert run("import", game, write_po(catalog, tmp_path / "de.po")) == 0
    items = lang_of(game, "de")["items"]
    assert "floor-3" not in items
    assert items["floor-clip"]["text"] == "Kurze Zeile eins."


def test_name_voice_settings_and_schema_are_kept(
        game: Path, tmp_path: Path) -> None:
    german = lang_of(game, "de")
    german["keepOriginalVoice"] = True
    german["name"] = "Deutsch (Test)"
    language_file.write_language_file(game, german)
    catalog = export(game, "de", tmp_path)
    by_context(catalog)[f"item:{MISSING_ID}"].msgstr = "Kurze Zeile zwei."
    assert run("import", game, write_po(catalog, tmp_path / "de.po")) == 0
    after = lang_of(game, "de")
    assert after["keepOriginalVoice"] is True
    assert after["name"] == "Deutsch (Test)"
    assert list(after) == ["language", "name", "title", "version",
                           "speakers", "items", "decisions",
                           "keepOriginalVoice"]


def test_a_manifest_naming_its_schema_copy_gets_the_language_copy(
        game: Path, tmp_path: Path) -> None:
    manifest = {"$schema": SCHEMA_REF, **manifest_of(game)}
    save_manifest(game, manifest)
    catalog = export(game, "fr", tmp_path)
    by_context(catalog)["title"].msgstr = "Démo des langues"
    assert run("import", game, write_po(catalog, tmp_path / "fr.po")) == 0
    french = lang_of(game, "fr")
    assert list(french)[:2] == ["$schema", "language"]
    assert french["$schema"] == LANG_SCHEMA_REF
    assert (game / LANG_COPY_NAME).read_bytes() == \
        LANG_SCHEMA_FILE.read_bytes()
    assert validate_content.validate_folder(game) == []
    # A language file already without one is left so.
    assert "$schema" not in lang_of(game, "de")


def test_a_po_for_another_game_is_refused(
        game: Path, tmp_path: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    catalog = export(game, "fr", tmp_path)
    catalog.header["X-Kinetic-Story"] = "some-other-game"
    by_context(catalog)["title"].msgstr = "Autre"
    path = write_po(catalog, tmp_path / "fr.po")
    before = snapshot(game)
    assert run("import", game, path) == 1
    assert "'some-other-game'" in capsys.readouterr().err
    assert snapshot(game) == before
    assert run("import", game, path, "--force") == 0
    assert lang_of(game, "fr")["title"]["text"] == "Autre"


@pytest.mark.parametrize("language, why", [
    ("en", "the game's own language"),
    ("", "no Language header"),
    ("sr@latin", "not a language tag"),
])
def test_a_po_in_no_usable_language_is_refused(
        game: Path, tmp_path: Path, language: str, why: str,
        capsys: pytest.CaptureFixture[str]) -> None:
    catalog = export(game, "fr", tmp_path)
    if language:
        catalog.header["Language"] = language
    else:
        del catalog.header["Language"]
    before = snapshot(game)
    assert run("import", game, write_po(catalog, tmp_path / "x.po")) == 1
    assert why in capsys.readouterr().err
    assert snapshot(game) == before


def test_a_gettext_style_language_is_read_as_a_tag(
        game: Path, tmp_path: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    catalog = export(game, "pt-BR", tmp_path)
    catalog.header["Language"] = "pt_BR"
    by_context(catalog)["title"].msgstr = "Demonstração"
    assert run("import", game, write_po(catalog, tmp_path / "pt.po")) == 0
    assert "'pt_BR' read as 'pt-BR'" in capsys.readouterr().err
    assert lang_of(game, "pt-BR")["language"] == "pt-BR"


@pytest.mark.parametrize("context, length, ok", [
    ("prompt:outer", 199, True), ("prompt:outer", 200, False),
    ("label:outer/route2", 119, True), ("label:outer/route2", 120, False),
    ("version", 40, True), ("version", 41, False),
])
def test_prompt_and_label_limits(game: Path, tmp_path: Path, context: str,
                                 length: int, ok: bool,
                                 capsys: pytest.CaptureFixture[str]) -> None:
    catalog = export(game, "de", tmp_path)
    by_context(catalog)[context].msgstr = "x" * length
    before = snapshot(game)
    capsys.readouterr()
    status = run("import", game, write_po(catalog, tmp_path / "de.po"))
    if ok:
        assert status == 0
        assert validate_content.validate_folder(game) == []
    else:
        assert status == 1
        err = capsys.readouterr().err
        assert f"(found {length})" in err and "nothing written" in err
        assert snapshot(game) == before


def test_a_twice_given_context_is_an_error(
        game: Path, tmp_path: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    catalog = export(game, "de", tmp_path)
    catalog.entries.append(po.Entry(msgctxt="title", msgid="x", msgstr="y"))
    before = snapshot(game)
    assert run("import", game, write_po(catalog, tmp_path / "de.po")) == 1
    assert 'msgctxt "title" appears twice' in capsys.readouterr().err
    assert snapshot(game) == before


def test_a_malformed_po_is_refused(game: Path, tmp_path: Path,
                                   capsys: pytest.CaptureFixture[str]) -> None:
    path = tmp_path / "bad.po"
    path.write_text('msgid "a"\n', encoding="utf-8")
    assert run("import", game, path) == 1
    assert "msgid with no msgstr" in capsys.readouterr().err


# --- status, help, version ---------------------------------------------------

def test_status_prints_each_language(
        game: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert run("status", game) == 0
    assert capsys.readouterr().out.splitlines() == [
        f"{game}: base language en, 44 strings to translate",
        "de: 43 of 44 strings (97.7%), 1 stale, 0 unchecked, 1 missing",
        "ja: 44 of 44 strings (100%), 0 stale, 0 unchecked, 0 missing",
        "ar: 44 of 44 strings (100%), 0 stale, 0 unchecked, 0 missing",
    ]


def test_status_counts_unchecked_and_reports_problems(
        game: Path, capsys: pytest.CaptureFixture[str]) -> None:
    arabic = lang_of(game, "ar")
    del arabic["items"]["floor-3"]["from"]
    arabic["items"]["no-such-item"] = {"text": "x"}
    language_file.write_language_file(game, arabic)
    assert run("status", game) == 1
    out = capsys.readouterr()
    assert "ar: 44 of 44 strings (100%), 0 stale, 1 unchecked, 0 missing" \
        in out.out.splitlines()
    assert "1 translation problem" in out.err


def test_status_of_a_game_with_no_translations(
        game: Path, capsys: pytest.CaptureFixture[str]) -> None:
    manifest = manifest_of(game)
    del manifest["languages"]
    save_manifest(game, manifest)
    shutil.rmtree(game / "lang")
    assert run("status", game) == 0
    assert "no translations yet" in capsys.readouterr().out


def test_version_and_help(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as done:
        run("--version")
    assert done.value.code == 0
    assert capsys.readouterr().out == f"Kinetic {kinetic_version()}\n"
    for command in ("export", "import", "status"):
        with pytest.raises(SystemExit) as done:
            run(command, "--help")
        assert done.value.code == 0
        assert "GAME_FOLDER" in capsys.readouterr().out
    with pytest.raises(SystemExit) as done:
        run()
    assert done.value.code == 2
