"""Tests for fixtures/build_lang_demo.py. Run with:

    .venv/bin/pytest tools/test_build_lang_demo.py -q

fixtures/lang-demo is gitignored, so these tests always build from
scratch into temporary folders (ffmpeg on PATH, as for the demo).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
BUILD_LANG_DEMO = REPO_ROOT / "fixtures" / "build_lang_demo.py"

if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import validate_content  # noqa: E402
from kinetic_extract import language_file  # noqa: E402

TAGS = ["de", "ja", "ar"]


def build(out: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(BUILD_LANG_DEMO), "--out", str(out)],
        cwd=REPO_ROOT, capture_output=True, text=True)


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("first") / "lang-demo"
    proc = build(out)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return out


@pytest.fixture(scope="module")
def manifest(built: Path) -> dict:
    return json.loads((built / "manifest.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def files(built: Path) -> dict[str, dict]:
    return {tag: json.loads((built / "lang" / f"{tag}.json").read_text(
        encoding="utf-8")) for tag in TAGS}


def all_files(folder: Path) -> dict[str, bytes]:
    return {p.relative_to(folder).as_posix(): p.read_bytes()
            for p in sorted(folder.rglob("*")) if p.is_file()}


def test_validator_reports_only_the_two_deliberate_warnings(
        built: Path) -> None:
    proc = subprocess.run(
        [sys.executable, str(TOOLS_DIR / "validate_content.py"), str(built)],
        cwd=REPO_ROOT, capture_output=True, text=True)
    assert (proc.returncode, proc.stdout) == (0, "")
    lines = proc.stderr.splitlines()
    warnings = [line for line in lines if line.startswith("warning: ")]
    assert [w.split(": ")[1:3] for w in warnings] == [
        ["lang/de.json", "items.floor-2"],
        ["lang/de.json", "items.text-thought.from"]]
    assert "stale" in warnings[1]
    assert lines[2:] == [f"{built}: 2 translation warnings"]
    strict = subprocess.run(
        [sys.executable, str(TOOLS_DIR / "validate_content.py"), str(built),
         "--strict", "--json"], cwd=REPO_ROOT, capture_output=True, text=True)
    assert (strict.returncode, strict.stderr) == (3, "")
    report = json.loads(strict.stdout)
    assert report["warnings"]["translation"] == warnings
    assert {tag: (c["translated"], c["strings"], c["missing"], c["stale"])
            for tag, c in report["coverage"].items()} == {
        "de": (43, 44, 1, 1), "ja": (44, 44, 0, 0), "ar": (44, 44, 0, 0)}


def test_story_id_title_version_and_languages(manifest: dict) -> None:
    assert manifest["storyId"] == "kinetic-lang-demo"
    assert manifest["title"] == "Kinetic language demo"
    assert manifest["version"] == "Episode 1"
    assert manifest["language"] == "en"
    assert manifest["languages"] == TAGS


def test_the_demo_story_unchanged(manifest: dict, tmp_path: Path) -> None:
    """Items and branches are the demo's, as build_demo writes them."""
    demo = tmp_path / "demo"
    proc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "fixtures" / "build_demo.py"),
         "--out", str(demo)], cwd=REPO_ROOT, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    base = json.loads((demo / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["items"] == base["items"]
    assert manifest["branches"] == base["branches"]


def test_each_language_has_its_file_and_script(built: Path) -> None:
    for tag in TAGS:
        text = (built / "lang" / f"{tag}.json").read_text(encoding="utf-8")
        script = (built / "lang" / f"{tag}.js").read_text(encoding="utf-8")
        assert script == language_file.script_text(tag, text)
    assert sorted(p.name for p in (built / "lang").iterdir()) == sorted(
        f"{tag}.{ext}" for tag in TAGS for ext in ("json", "js"))


def test_every_string_translated_but_the_missing_line(
        manifest: dict, files: dict[str, dict]) -> None:
    texts = {item["id"] for item in manifest["items"] if item.get("text")}
    speakers = {item["speaker"] for item in manifest["items"]
                if item.get("text") and item.get("speaker")}
    for tag, data in files.items():
        assert data["language"] == tag
        expected = texts - {"floor-2"} if tag == "de" else texts
        assert set(data["items"]) == expected, tag
        assert set(data["speakers"]) == speakers == {"Mei", "Theo", "Ines"}
        assert {"title", "version", "name"} <= set(data)
        for branch in manifest["branches"]:
            entry = data["decisions"][branch["id"]]
            assert entry["prompt"]["text"] != branch["prompt"]
            assert set(entry["routes"]) == {r["id"] for r in branch["routes"]}
    assert files["ja"]["speakers"] == {"Mei": "メイ", "Theo": "テオ",
                                       "Ines": "イネス"}


def test_every_hash_matches_the_base_but_the_stale_line(
        manifest: dict, files: dict[str, dict]) -> None:
    bases = {item["id"]: item["text"] for item in manifest["items"]
             if item.get("text")}
    for tag, data in files.items():
        for item_id, entry in data["items"].items():
            fresh = entry["from"] == language_file.base_hash(bases[item_id])
            assert fresh != ((tag, item_id) == ("de", "text-thought")), \
                (tag, item_id)
        assert data["title"]["from"] == language_file.base_hash(
            manifest["title"])


def test_texts_are_in_their_own_scripts(files: dict[str, dict]) -> None:
    """A rough check that each file holds its language's writing: kana
    in Japanese, Arabic letters in Arabic, German umlauts somewhere."""
    def joined(data: dict) -> str:
        return " ".join(entry["text"] for entry in data["items"].values())
    assert any("぀" <= ch <= "ヿ" for ch in joined(files["ja"]))
    assert any("؀" <= ch <= "ۿ" for ch in joined(files["ar"]))
    assert any(ch in "äöüß" for ch in joined(files["de"]))


def test_two_builds_are_byte_identical(built: Path, tmp_path: Path) -> None:
    again = tmp_path / "lang-demo"
    proc = build(again)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    first, second = all_files(built), all_files(again)
    assert sorted(first) == sorted(second)
    assert [name for name in first if first[name] != second[name]] == []


def test_a_rebuild_over_its_own_output_works(tmp_path: Path) -> None:
    out = tmp_path / "lang-demo"
    assert build(out).returncode == 0
    proc = build(out)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert validate_content.validate_folder(out) == []


def test_a_folder_with_other_subfolders_is_refused(tmp_path: Path) -> None:
    out = tmp_path / "lang-demo"
    (out / "keep").mkdir(parents=True)
    (out / "keep" / "precious.txt").write_text("mine")
    proc = build(out)
    assert proc.returncode != 0
    assert "not deleting it" in proc.stderr
    assert (out / "keep" / "precious.txt").read_text() == "mine"
